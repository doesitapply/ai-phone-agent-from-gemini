#!/usr/bin/env tsx
import assert from "node:assert/strict";
import Stripe from "stripe";
import { classifySmirkCheckoutForFulfillment, shouldProvisionPublicRequest } from "../src/checkout-safety.js";
import {
  CHECKOUT_FULFILLMENT_LEASE_MS,
  checkoutFulfillmentLeaseCutoff,
  hasWorkspaceBillingEntitlement,
  isPaymentSuspensionStatus,
  isCheckoutFulfillmentClaimReclaimable,
  matchesExactStripeWorkspaceBinding,
  normalizeStripeSubscriptionStatus,
  isRestrictiveWorkspaceBillingStatus,
  stripeBillingEventCreatedSeconds,
  shouldReplaceStripeSubscriptionFact,
} from "../src/billing-safety.js";
import {
  isNativeStripeCheckoutKeyReady,
  registerBuyerRoutes,
  verifyCheckoutPaymentLinkBeforeFulfillment,
} from "../src/routes/buyer-routes.js";

const approvedCustomerPolicyVersion = "2026-07-18-fixture";
const event = (session: Record<string, unknown>, type = "checkout.session.completed", livemode = true) => ({
  id: "evt_live_real_1",
  livemode,
  type,
  data: { object: session },
});

assert.equal(isNativeStripeCheckoutKeyReady("sk_live_fixture_native_123456789", true, false), false, "native Checkout must default off even with a live key");
assert.equal(isNativeStripeCheckoutKeyReady("sk_live_replace_me", true, true), false, "placeholder live keys must never enable native Checkout");
assert.equal(isNativeStripeCheckoutKeyReady("sk_live_a", true, true), false, "implausibly short shape-only keys must never enable native Checkout");
assert.equal(isNativeStripeCheckoutKeyReady("sk_live_fixture_native_123456789", true, true), true, "an explicit flag and non-placeholder live key may enable native Checkout");

const nativePreFulfillment = await verifyCheckoutPaymentLinkBeforeFulfillment(event({ payment_link: null }));
assert.deepEqual(nativePreFulfillment, { ok: true, source: "native" }, "immutable native Checkout markers remain on the native fulfillment path");
let providerVerificationCalls = 0;
const configuredIdOnly = await verifyCheckoutPaymentLinkBeforeFulfillment(event({ payment_link: "plink_live_smirk_starter" }), {
  env: { STRIPE_PAYMENT_LINK_STARTER_ID: "plink_live_smirk_starter" },
  verify: async () => {
    providerVerificationCalls += 1;
    throw new Error("must-not-run");
  },
});
assert.equal(configuredIdOnly.ok, false, "a configured Payment Link ID alone must not authorize fulfillment");
assert.equal(providerVerificationCalls, 0, "missing exact URL binding must fail before provider access");
const exactPaymentLinkEnv = {
  STRIPE_PAYMENT_LINK_STARTER_ID: "plink_live_smirk_starter",
  STRIPE_PAYMENT_LINK_STARTER: "https://buy.stripe.com/starter_live",
  SMIRK_CUSTOMER_POLICY_APPROVED_VERSION: approvedCustomerPolicyVersion,
};
const refreshedProviderProof = await verifyCheckoutPaymentLinkBeforeFulfillment(event({ payment_link: "plink_live_smirk_starter" }), {
  env: exactPaymentLinkEnv,
  verify: async (input, forceRefresh) => {
    providerVerificationCalls += 1;
    assert.equal(forceRefresh, true, "fulfillment must bypass cached readiness and force a provider refresh");
    return {
      ready: true,
      blockers: [],
      binding: {
        plan: input.plan,
        paymentLinkId: input.paymentLinkId,
        paymentLinkUrl: input.paymentLinkUrl,
        verifiedAt: new Date().toISOString(),
      },
    };
  },
});
assert.equal(refreshedProviderProof.ok, true, "exact refreshed provider binding may reach fulfillment");
const providerDrift = await verifyCheckoutPaymentLinkBeforeFulfillment(event({ payment_link: "plink_live_smirk_starter" }), {
  env: exactPaymentLinkEnv,
  verify: async () => ({ ready: false, blockers: ["payment-link-tax-mode-mismatch"], binding: null }),
});
assert.equal(providerDrift.ok, false, "provider drift must defer fulfillment for webhook retry");
const classifyCheckout = (
  checkoutEvent: any,
  paymentLinkIds: Parameters<typeof classifySmirkCheckoutForFulfillment>[1] = {},
) => classifySmirkCheckoutForFulfillment(checkoutEvent, paymentLinkIds, approvedCustomerPolicyVersion);

const baseSession = {
  id: "cs_live_real_12345678",
  livemode: true,
  mode: "subscription",
  status: "complete",
  payment_status: "paid",
  currency: "usd",
  amount_total: 19700,
  customer: "cus_real_1",
  subscription: "sub_real_1",
  metadata: {
    smirk_product: "missed_call_recovery",
    smirk_checkout_version: "1",
    smirk_customer_policy_version: approvedCustomerPolicyVersion,
    plan: "starter",
    owner_email: "owner@realplumber.com",
  },
};
for (const type of ["checkout.session.completed", "checkout.session.async_payment_succeeded"]) {
  const result = classifyCheckout(event({ ...baseSession }, type));
  assert.equal(result.approved, true, `${type} exact native SMIRK payment should be approved`);
  assert.equal(result.plan, "starter");
}

for (const [label, mutation] of [
  ["ordinary test event", { livemode: false }],
  ["missing session livemode", { livemode: undefined }],
  ["wrong product", { metadata: { ...baseSession.metadata, smirk_product: "unrelated_product" } }],
  ["wrong currency", { currency: "eur" }],
  ["underpriced plan", { amount_total: 1 }],
  ["one-time payment mode", { mode: "payment" }],
  ["missing Stripe customer", { customer: null }],
  ["missing Stripe subscription", { subscription: null }],
] as const) {
  const result = classifyCheckout(event({ ...baseSession, ...mutation }, "checkout.session.completed", "livemode" in mutation && mutation.livemode === false ? false : true));
  assert.equal(result.approved, false, `${label} must fail closed`);
}

const paymentLink = classifyCheckout(event({
  ...baseSession,
  metadata: { smirk_customer_policy_version: approvedCustomerPolicyVersion },
  payment_link: "plink_live_smirk_starter",
}), { starter: "plink_live_smirk_starter" });
assert.equal(paymentLink.approved, true, "exact configured Payment Link should qualify");
assert.equal(classifyCheckout(event({
  ...baseSession,
  payment_link: "plink_live_unrelated",
}), { starter: "plink_live_smirk_starter" }).approved, false, "unconfigured Payment Link must fail");

assert.equal(classifyCheckout(event({
  ...baseSession,
  metadata: { ...baseSession.metadata, smirk_customer_policy_version: "stale-policy" },
})).approved, false, "stale customer policy version must fail");
assert.equal(classifyCheckout(event({
  ...baseSession,
  metadata: { ...baseSession.metadata, smirk_customer_policy_version: undefined },
})).approved, false, "missing customer policy version must fail");

const syntheticSmoke = classifyCheckout({
  id: "evt_smirk_paid_handoff_123",
  livemode: false,
  type: "checkout.session.completed",
  data: { object: {
    id: "cs_test_smirk_paid_handoff_123",
    livemode: false,
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    metadata: {
      source: "gate3-stripe-webhook-smoke",
      plan: "starter",
      owner_email: "smoke+stripe-123@example.com",
    },
  } },
});
assert.equal(syntheticSmoke.approvedSyntheticSmoke, true, "only the exact labeled signed smoke bypass should remain");
assert.equal(classifyCheckout({
  ...event({ ...baseSession, livemode: false }, "checkout.session.completed", false),
  id: "evt_test_ordinary",
}).approved, false, "ordinary test checkout must never use the smoke bypass");

assert.equal(shouldProvisionPublicRequest({ promoApplied: false, isSmokeTestProvisioning: false }), false, "public paid-plan intake must never provision immediately");
assert.equal(shouldProvisionPublicRequest({ promoApplied: true, isSmokeTestProvisioning: false }), true, "explicit free promo may provision");
assert.equal(shouldProvisionPublicRequest({ promoApplied: true, isSmokeTestProvisioning: true }), false, "smoke request must never provision");

const leaseNow = Date.parse("2026-07-18T10:00:00.000Z");
assert.equal(
  checkoutFulfillmentLeaseCutoff(leaseNow),
  new Date(leaseNow - CHECKOUT_FULFILLMENT_LEASE_MS).toISOString(),
  "crashed Checkout claims must have a deterministic bounded stale-lease cutoff",
);
assert.equal(isCheckoutFulfillmentClaimReclaimable("processing", leaseNow - CHECKOUT_FULFILLMENT_LEASE_MS - 1, leaseNow), true, "stale processing claim must be recoverable after a crash");
assert.equal(isCheckoutFulfillmentClaimReclaimable("processing", leaseNow - 1_000, leaseNow), false, "fresh processing claim must keep concurrent delivery fenced out");
assert.equal(isCheckoutFulfillmentClaimReclaimable("failed", leaseNow, leaseNow), true, "failed claim must be retryable immediately");
assert.equal(isCheckoutFulfillmentClaimReclaimable("complete", 0, leaseNow), false, "completed claim must never be reclaimed");
assert.equal(isPaymentSuspensionStatus("refunded"), true);
assert.equal(isPaymentSuspensionStatus("disputed"), true);
assert.equal(normalizeStripeSubscriptionStatus("unpaid"), "unpaid");
assert.equal(normalizeStripeSubscriptionStatus("unexpected_provider_state"), "none", "unknown billing states must fail closed");
assert.equal(stripeBillingEventCreatedSeconds(1_784_365_200), 1_784_365_200);
assert.equal(stripeBillingEventCreatedSeconds(undefined), null, "billing mutation without provider event time must fail closed");
assert.equal(isRestrictiveWorkspaceBillingStatus("active"), false);
assert.equal(isRestrictiveWorkspaceBillingStatus("past_due"), true, "same-second restrictive billing state must beat an enabling state");
assert.equal(shouldReplaceStripeSubscriptionFact({ currentEventCreated: null, incomingEventCreated: 10, incomingEventId: "evt_active", incomingStatus: "active" }), true);
assert.equal(shouldReplaceStripeSubscriptionFact({ currentEventCreated: 20, currentEventId: "evt_new", incomingEventCreated: 10, incomingEventId: "evt_old", incomingStatus: "active" }), false, "older enabling event must not undo newer billing state");
assert.equal(shouldReplaceStripeSubscriptionFact({ currentEventCreated: 20, currentEventId: "evt_active", incomingEventCreated: 20, incomingEventId: "evt_canceled", incomingStatus: "canceled" }), true, "same-second restrictive event must win before or after provisioning");
assert.equal(shouldReplaceStripeSubscriptionFact({ currentEventCreated: 20, currentEventId: "evt_canceled", incomingEventCreated: 20, incomingEventId: "evt_active", incomingStatus: "active" }), false, "same-second enabling event must not reopen canceled access");
assert.equal(shouldReplaceStripeSubscriptionFact({ currentEventCreated: 20, currentEventId: "evt_canceled", incomingEventCreated: 20, incomingEventId: "evt_canceled", incomingStatus: "canceled" }), false, "duplicate restrictive event must be idempotent");
assert.equal(hasWorkspaceBillingEntitlement("starter", "active"), true);
for (const status of ["trialing", "past_due", "unpaid", "incomplete", "incomplete_expired", "paused", "canceled", "refunded", "disputed", "none"]) {
  assert.equal(hasWorkspaceBillingEntitlement("starter", status), false, `paid workspace must not retain access in ${status}`);
}
const exactWorkspace = { id: 7, stripe_customer_id: "cus_smirk", stripe_subscription_id: "sub_smirk" };
assert.equal(matchesExactStripeWorkspaceBinding(exactWorkspace, { workspace_id: 7, customer_id: "cus_smirk", subscription_id: "sub_smirk" }), true);
assert.equal(matchesExactStripeWorkspaceBinding(exactWorkspace, { workspace_id: 7, customer_id: "cus_smirk", subscription_id: "sub_other" }), false, "unrelated subscription under the same customer must never match");

const signaturePayload = JSON.stringify({ id: "evt_test_signature_fixture", object: "event" });
const signatureSecret = "whsec_checkout_fulfillment_fixture";
const signatureSdk = new Stripe("sk_test_webhook_signature_only");
const signature = signatureSdk.webhooks.generateTestHeaderString({ payload: signaturePayload, secret: signatureSecret });
assert.equal(signatureSdk.webhooks.constructEvent(signaturePayload, signature, signatureSecret).id, "evt_test_signature_fixture", "webhook signature verification must work without a configured API key");

let webhookHandler: ((req: any, res: any) => Promise<void>) | null = null;
let invitePreviewHandler: ((req: any, res: any) => Promise<void>) | null = null;
let inviteAcceptHandler: ((req: any, res: any) => Promise<void>) | null = null;
let inviteAcceptCount = 0;
let inviteInspectCount = 0;
let fixtureSubscriptionStatus = "active";
const fixtureInviteToken = "a".repeat(64);
const fixtureExpiredInviteToken = "b".repeat(64);
const fakeApp = {
  get: (route: string, ...handlers: any[]) => {
    if (route === "/api/invite/:token") invitePreviewHandler = handlers.at(-1);
  },
  post: (route: string, ...handlers: any[]) => {
    if (route === "/api/stripe/webhook") webhookHandler = handlers.at(-1);
    if (route === "/api/invite/:token/accept") inviteAcceptHandler = handlers.at(-1);
  },
};
registerBuyerRoutes(fakeApp as any, {
  publicCheckoutRateLimit: (_req: any, _res: any, next: () => void) => next(),
  publicInviteRateLimit: (_req: any, _res: any, next: () => void) => next(),
  workspaceBillingPortalAuth: (_req: any, _res: any, next: () => void) => next(),
  env: {},
  isProd: false,
  deployVersion: "fixture",
  deployBranch: "fixture",
  getAppUrl: () => "http://localhost:3000",
  log: () => undefined,
  inspectInvite: async (token) => {
    inviteInspectCount += 1;
    return token === fixtureInviteToken
      ? { workspace_id: 7, role: "owner", accepted_at: null, invite_expires_at: new Date(Date.now() + 60_000).toISOString() }
      : null;
  },
  inspectInviteRecovery: async (token) => token === fixtureExpiredInviteToken
    ? { checkout_session_id: "cs_live_fixture_recovery_12345678" }
    : null,
  acceptInvite: async (token) => {
    if (token !== fixtureInviteToken) return null;
    inviteAcceptCount += 1;
    return { workspace_id: 7, role: "owner", accepted_at: new Date().toISOString() };
  },
  getWorkspaceById: async () => ({
    id: 7,
    slug: "fixture",
    name: "Fixture Workspace",
    owner_email: "buyer@example.net",
    plan: "starter",
    subscription_status: fixtureSubscriptionStatus,
    monthly_call_limit: 500,
    monthly_minute_limit: 1000,
    calls_this_month: 0,
    minutes_this_month: 0,
    api_key: "workspace_fixture_key",
    timezone: "America/Los_Angeles",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as any),
  handleStripeWebhook: async () => undefined,
});
assert.ok(webhookHandler, "Stripe webhook handler must register");
assert.ok(invitePreviewHandler, "invite preview handler must register");
assert.ok(inviteAcceptHandler, "invite acceptance handler must register");
const invokeInvite = async (handler: (req: any, res: any) => Promise<void>, token: string) => {
  const result: { status: number; body: any; headers: Record<string, string> } = { status: 200, body: null, headers: {} };
  const response = {
    setHeader(name: string, value: string) { result.headers[name.toLowerCase()] = value; return response; },
    status(code: number) { result.status = code; return response; },
    json(payload: any) { result.body = payload; return response; },
  };
  await handler({ params: { token } }, response);
  return result;
};
const preview = await invokeInvite(invitePreviewHandler!, fixtureInviteToken);
assert.equal(preview.status, 200);
assert.equal(preview.body.workspace.name, "Fixture Workspace");
assert.equal(JSON.stringify(preview.body).includes("workspace_fixture_key"), false, "GET preview must never issue workspace credentials");
assert.equal(inviteAcceptCount, 0, "GET preview must not mutate invite acceptance");
const accepted = await invokeInvite(inviteAcceptHandler!, fixtureInviteToken);
assert.equal(accepted.status, 200);
assert.equal(accepted.body.workspace.api_key, "workspace_fixture_key");
assert.equal(inviteAcceptCount, 1);
const retried = await invokeInvite(inviteAcceptHandler!, fixtureInviteToken);
assert.equal(retried.status, 200, "acceptance must be retriable during the invite expiry window");
assert.equal(inviteAcceptCount, 2);
const expiredPreview = await invokeInvite(invitePreviewHandler!, fixtureExpiredInviteToken);
assert.equal(expiredPreview.status, 410);
assert.equal(expiredPreview.body.code, "INVITE_EXPIRED");
assert.equal(
  expiredPreview.body.recovery_url,
  "https://ai-phone-agent-production-6811.up.railway.app/success?session_id=cs_live_fixture_recovery_12345678",
  "expired invite recovery must fall back to a trusted production origin instead of a caller-provided local origin",
);
fixtureSubscriptionStatus = "refunded";
const suspendedPreview = await invokeInvite(invitePreviewHandler!, fixtureInviteToken);
const acceptsBeforeSuspendedAttempt = inviteAcceptCount;
const suspendedAcceptance = await invokeInvite(inviteAcceptHandler!, fixtureInviteToken);
assert.equal(suspendedPreview.status, 402);
assert.equal(suspendedAcceptance.status, 402);
assert.equal(inviteAcceptCount, acceptsBeforeSuspendedAttempt, "inactive billing must block credential exchange before acceptance");
const inspectionsBeforeMalformed = inviteInspectCount;
assert.equal((await invokeInvite(invitePreviewHandler!, "bad-token")).status, 404);
assert.equal(inviteInspectCount, inspectionsBeforeMalformed, "malformed invite must fail before database lookup");
fixtureSubscriptionStatus = "active";
const invokeWebhook = async (headers: Record<string, string>, body: string) => {
  const result: { status: number; body: any } = { status: 200, body: null };
  const response = {
    status(code: number) { result.status = code; return response; },
    json(payload: any) { result.body = payload; return response; },
  };
  await webhookHandler!({ headers, body: Buffer.from(body), path: "/api/stripe/webhook" }, response);
  return result;
};
const oldWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const oldUnsignedOverride = process.env.ALLOW_UNSIGNED_STRIPE_WEBHOOK_DEV;
const oldStripeKey = process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.ALLOW_UNSIGNED_STRIPE_WEBHOOK_DEV;
delete process.env.STRIPE_SECRET_KEY;
assert.equal((await invokeWebhook({}, signaturePayload)).status, 400, "unsigned webhook must fail closed even when isProd is false");
process.env.ALLOW_UNSIGNED_STRIPE_WEBHOOK_DEV = "true";
assert.deepEqual((await invokeWebhook({}, signaturePayload)).body, { verified: true }, "explicit local unsigned override remains available");
delete process.env.ALLOW_UNSIGNED_STRIPE_WEBHOOK_DEV;
process.env.STRIPE_WEBHOOK_SECRET = signatureSecret;
assert.deepEqual((await invokeWebhook({ "stripe-signature": signature }, signaturePayload)).body, { verified: true }, "signed webhook verification works without STRIPE_SECRET_KEY");
if (oldWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = oldWebhookSecret;
if (oldUnsignedOverride === undefined) delete process.env.ALLOW_UNSIGNED_STRIPE_WEBHOOK_DEV; else process.env.ALLOW_UNSIGNED_STRIPE_WEBHOOK_DEV = oldUnsignedOverride;
if (oldStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = oldStripeKey;

console.log("OK checkout fulfillment fixtures enforce product, mode, price, live mode, Payment Link, smoke, and public-intake boundaries");
