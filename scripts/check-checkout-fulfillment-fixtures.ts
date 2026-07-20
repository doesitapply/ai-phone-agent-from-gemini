#!/usr/bin/env tsx
import assert from "node:assert/strict";
import fs from "node:fs";
import Stripe from "stripe";
import { classifySmirkCheckoutForFulfillment, paymentLinkFulfillmentBindingsFromEnv, shouldProvisionPublicRequest } from "../src/checkout-safety.js";
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
import { evaluateCompletedPaymentLinkSession } from "../src/stripe-payment-link-readiness.js";

const saasSource = fs.readFileSync("src/saas.ts", "utf8");
const buyerRoutesSource = fs.readFileSync("src/routes/buyer-routes.ts", "utf8");
assert.ok(
  buyerRoutesSource.includes('adaptive_pricing: { enabled: false }'),
  "native Checkout must explicitly disable adaptive pricing so its USD subtotal remains deterministic",
);
const checkoutHandlerStart = saasSource.indexOf("async function handleCheckoutCompleted");
const buyerIdentityStart = saasSource.indexOf("const ownerEmail = String(", checkoutHandlerStart);
const buyerIdentityEnd = saasSource.indexOf("const verifiedPlan", buyerIdentityStart);
assert.ok(checkoutHandlerStart >= 0 && buyerIdentityStart >= 0 && buyerIdentityEnd > buyerIdentityStart, "checkout fulfillment buyer identity block must remain present");
const buyerIdentityBlock = saasSource.slice(buyerIdentityStart, buyerIdentityEnd);
assert.ok(
  buyerIdentityBlock.indexOf("session.customer_details?.business_name") < buyerIdentityBlock.indexOf("metadata.business_name"),
  "Stripe-collected business name must override stale public-form metadata",
);
assert.ok(
  buyerIdentityBlock.indexOf("session.customer_details?.phone") < buyerIdentityBlock.indexOf("metadata.owner_phone"),
  "Stripe-collected phone must override stale public-form metadata",
);

const approvedCustomerPolicyVersion = "2026-07-18-fixture";
const approvedTaxMode = "stripe_automatic_tax";
const approvedPolicy = () => ({
  coreReady: true,
  billingPolicy: { taxMode: approvedTaxMode },
  coreBlockers: [],
});
const event = (session: Record<string, unknown>, type = "checkout.session.completed", livemode = true) => ({
  id: "evt_live_real_1",
  livemode,
  type,
  data: { object: session },
});

const completedPaymentLinkSession = {
  id: "cs_live_payment_link_fixture_12345678",
  livemode: true,
  mode: "subscription",
  status: "complete",
  payment_status: "paid",
  currency: "usd",
  amount_subtotal: 19700,
  amount_total: 19700,
  total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
  customer: "cus_payment_link_fixture",
  subscription: "sub_payment_link_fixture",
  payment_link: "plink_live_smirk_starter",
  customer_details: {
    business_name: "Real Plumber LLC",
    email: "owner@realplumber.com",
    phone: "+14155550123",
  },
  consent: { terms_of_service: "accepted" },
  automatic_tax: { enabled: true },
  metadata: { smirk_customer_policy_version: approvedCustomerPolicyVersion },
  line_items: {
    has_more: false,
    data: [{
      description: "SMIRK AI Starter",
      quantity: 1,
      amount_subtotal: 19700,
      amount_total: 19700,
      amount_discount: 0,
      price: {
        id: "price_starter_fixture",
        livemode: true,
        active: true,
        billing_scheme: "per_unit",
        custom_unit_amount: null,
        transform_quantity: null,
        type: "recurring",
        currency: "usd",
        unit_amount: 19700,
        recurring: {
          interval: "month",
          interval_count: 1,
          usage_type: "licensed",
          meter: null,
          trial_period_days: null,
        },
        product: {
          id: "prod_starter_fixture",
          livemode: true,
          active: true,
          name: "SMIRK AI Starter",
        },
      },
    }],
  },
};

assert.equal(isNativeStripeCheckoutKeyReady("sk_live_fixture_native_123456789", true, false), false, "native Checkout must default off even with a live key");
assert.equal(isNativeStripeCheckoutKeyReady("sk_live_replace_me", true, true), false, "placeholder live keys must never enable native Checkout");
assert.equal(isNativeStripeCheckoutKeyReady("sk_live_a", true, true), false, "implausibly short shape-only keys must never enable native Checkout");
assert.equal(isNativeStripeCheckoutKeyReady("sk_live_fixture_native_123456789", true, true), true, "an explicit flag and non-placeholder live key may enable native Checkout");

const nativePreFulfillment = await verifyCheckoutPaymentLinkBeforeFulfillment(event({ payment_link: null }));
assert.deepEqual(nativePreFulfillment, {
  ok: true,
  source: "native",
  ignored: true,
}, "an unrelated native Checkout Session must be acknowledged without entering SMIRK fulfillment or rescue");
const smirkNativePreFulfillment = await verifyCheckoutPaymentLinkBeforeFulfillment(event({
  payment_link: null,
  metadata: {
    smirk_product: "missed_call_recovery",
    smirk_checkout_version: "1",
    smirk_customer_policy_version: approvedCustomerPolicyVersion,
    plan: "starter",
  },
}));
assert.deepEqual(smirkNativePreFulfillment, {
  ok: false,
  source: "native",
  reason: "native-checkout-disabled-first-dollar-launch",
}, "an identified SMIRK native Checkout Session must enter rescue rather than fulfillment during the hosted-only launch");
const paymentLinkVerifierStart = buyerRoutesSource.indexOf("export async function verifyCheckoutPaymentLinkBeforeFulfillment");
const paymentLinkVerifierEnd = buyerRoutesSource.indexOf("const getPublicBuyerReadiness", paymentLinkVerifierStart);
const paymentLinkVerifierSource = buyerRoutesSource.slice(paymentLinkVerifierStart, paymentLinkVerifierEnd);
assert.ok(paymentLinkVerifierStart >= 0 && paymentLinkVerifierEnd > paymentLinkVerifierStart, "Payment Link fulfillment verifier must remain present");
assert.equal(
  paymentLinkVerifierSource.includes("getPaymentLinkProviderProof"),
  false,
  "paid fulfillment must not depend on the mutable current Payment Link object",
);

const exactPaymentLinkEnv = {
  STRIPE_PAYMENT_LINK_STARTER_ID: "plink_live_smirk_starter",
  STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS: "plink_live_smirk_starter",
  SMIRK_CUSTOMER_POLICY_APPROVED_VERSION: approvedCustomerPolicyVersion,
};
let completedSessionReads = 0;
const configuredIdOnly = await verifyCheckoutPaymentLinkBeforeFulfillment(event({
  id: completedPaymentLinkSession.id,
  payment_link: "plink_live_smirk_starter",
}), {
  env: exactPaymentLinkEnv,
  evaluatePolicy: approvedPolicy,
  retrieveCheckoutSession: async (checkoutSessionId) => {
    completedSessionReads += 1;
    assert.equal(checkoutSessionId, completedPaymentLinkSession.id);
    return structuredClone(completedPaymentLinkSession);
  },
});
assert.equal(configuredIdOnly.ok, true, "an already-paid canonical Session must fulfill from its immutable configured Payment Link ID even when no current URL remains");
assert.equal(completedSessionReads, 1, "fulfillment must retrieve the exact completed Session once");
assert.equal(configuredIdOnly.checkoutSession?.id, completedPaymentLinkSession.id, "fulfillment must replace the webhook object with the retrieved completed Session");
for (const plan of ["pro", "enterprise"] as const) {
  const planUpper = plan.toUpperCase();
  const blocked = await verifyCheckoutPaymentLinkBeforeFulfillment(event({
    id: `cs_live_${plan}_fixture_12345678`,
    payment_link: `plink_live_smirk_${plan}`,
  }), {
    env: {
      STRIPE_PAYMENT_LINK_STARTER_ID: "plink_live_smirk_starter",
      STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS: "plink_live_smirk_starter",
      [`STRIPE_PAYMENT_LINK_${planUpper}_ID`]: `plink_live_smirk_${plan}`,
      [`STRIPE_PAYMENT_LINK_${planUpper}`]: `https://buy.stripe.com/${plan}_live`,
    },
    evaluatePolicy: approvedPolicy,
    retrieveCheckoutSession: async () => { throw new Error("non-Starter Session retrieval must not run"); },
  });
  assert.equal(blocked.ok, false, `previously shared ${plan} Payment Links must not fulfill during the Starter-only launch`);
  assert.equal(blocked.reason, "first-dollar-launch-starter-only");
}
const rotatedPaymentLinkId = await verifyCheckoutPaymentLinkBeforeFulfillment(event({
  id: completedPaymentLinkSession.id,
  payment_link: "plink_live_smirk_starter",
}), {
  env: {
    STRIPE_PAYMENT_LINK_STARTER_ID: "plink_live_new_smirk_starter",
    STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS: "plink_live_smirk_starter,plink_live_new_smirk_starter",
    SMIRK_CUSTOMER_POLICY_APPROVED_VERSION: approvedCustomerPolicyVersion,
  },
  evaluatePolicy: approvedPolicy,
  retrievePaymentLink: async (paymentLinkId) => ({ id: paymentLinkId, livemode: true, active: false }),
  retrieveCheckoutSession: async () => structuredClone(completedPaymentLinkSession),
});
assert.equal(rotatedPaymentLinkId.ok, true, "an old Session remains fulfillable after a real current-ID rotation when its exact historical link is provider-inactive");
const reactivatedHistoricalPaymentLinkId = await verifyCheckoutPaymentLinkBeforeFulfillment(event({
  id: completedPaymentLinkSession.id,
  payment_link: "plink_live_smirk_starter",
}), {
  env: {
    STRIPE_PAYMENT_LINK_STARTER_ID: "plink_live_new_smirk_starter",
    STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS: "plink_live_smirk_starter,plink_live_new_smirk_starter",
    SMIRK_CUSTOMER_POLICY_APPROVED_VERSION: approvedCustomerPolicyVersion,
  },
  evaluatePolicy: approvedPolicy,
  retrievePaymentLink: async (paymentLinkId) => ({ id: paymentLinkId, livemode: true, active: true }),
  retrieveCheckoutSession: async () => { throw new Error("reactivated historical link must fail before Session retrieval"); },
});
assert.equal(reactivatedHistoricalPaymentLinkId.ok, false, "a later reactivation of an allowlisted historical link must block new automatic fulfillment");
assert.equal(reactivatedHistoricalPaymentLinkId.reason, "historical-payment-link-reactivated");
const unallowlistedRotatedPaymentLinkId = await verifyCheckoutPaymentLinkBeforeFulfillment(event({
  id: completedPaymentLinkSession.id,
  payment_link: "plink_live_smirk_starter",
}), {
  env: {
    STRIPE_PAYMENT_LINK_STARTER_ID: "plink_live_new_smirk_starter",
    STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS: "plink_live_new_smirk_starter",
    SMIRK_CUSTOMER_POLICY_APPROVED_VERSION: approvedCustomerPolicyVersion,
  },
  evaluatePolicy: approvedPolicy,
  retrieveCheckoutSession: async () => { throw new Error("unallowlisted historical ID must fail before Session retrieval"); },
});
assert.deepEqual(unallowlistedRotatedPaymentLinkId, {
  ok: true,
  source: "payment_link",
  ignored: true,
}, "an unallowlisted old Payment Link without strong SMIRK identity must be acknowledged outside SMIRK fulfillment and rescue");
const archivedCatalogSession = structuredClone(completedPaymentLinkSession);
archivedCatalogSession.line_items.data[0].price.active = false;
archivedCatalogSession.line_items.data[0].price.product.active = false;
archivedCatalogSession.line_items.data[0].price.product.name = "Renamed after purchase";
const archivedCatalogProof = await verifyCheckoutPaymentLinkBeforeFulfillment(event({
  id: archivedCatalogSession.id,
  payment_link: "plink_live_smirk_starter",
}), {
  env: exactPaymentLinkEnv,
  evaluatePolicy: approvedPolicy,
  retrieveCheckoutSession: async () => archivedCatalogSession,
});
assert.equal(
  archivedCatalogProof.ok,
  true,
  "an already-paid Session must use its immutable line description and terms after its Price or Product is archived or renamed",
);
const taxedPaymentLinkSession = structuredClone(completedPaymentLinkSession);
taxedPaymentLinkSession.amount_total = 21325;
taxedPaymentLinkSession.total_details.amount_tax = 1625;
taxedPaymentLinkSession.line_items.data[0].amount_total = 21325;
const taxedPaymentLinkProof = evaluateCompletedPaymentLinkSession({
  plan: "starter",
  paymentLinkId: "plink_live_smirk_starter",
  policyVersion: approvedCustomerPolicyVersion,
  taxMode: approvedTaxMode,
  session: taxedPaymentLinkSession,
});
assert.equal(taxedPaymentLinkProof.ready, true, "Payment Link fulfillment accepts tax above the exact $197 pre-tax line-item subtotal");
for (const [label, mutate, expectedReason] of [
  ["wrong actual Price ID", (session: any) => { session.line_items.data[0].price.id = "pi_wrong"; }, "checkout-session-recurring-price-invalid"],
  ["wrong actual Price amount", (session: any) => { session.line_items.data[0].price.unit_amount = 1; }, "checkout-session-recurring-price-invalid"],
  ["wrong actual Product ID", (session: any) => { session.line_items.data[0].price.product.id = "item_wrong"; }, "checkout-session-product-invalid"],
  ["wrong immutable product description", (session: any) => { session.line_items.data[0].description = "Unrelated"; }, "checkout-session-description-mismatch"],
  ["wrong Session subtotal", (session: any) => { session.amount_subtotal = 1; }, "checkout-session-subtotal-mismatch"],
  ["missing provider identity", (session: any) => { session.customer_details.email = null; }, "checkout-session-email-invalid"],
  ["stale policy metadata", (session: any) => { session.metadata.smirk_customer_policy_version = "stale"; }, "checkout-session-policy-version-mismatch"],
  ["discounted line item", (session: any) => { session.line_items.data[0].amount_discount = 1; }, "checkout-session-line-amount-mismatch"],
  ["wrong immutable Payment Link", (session: any) => { session.payment_link = "plink_live_other"; }, "checkout-session-payment-link-mismatch"],
] as const) {
  const invalidSession = structuredClone(completedPaymentLinkSession);
  mutate(invalidSession);
  const proof = await verifyCheckoutPaymentLinkBeforeFulfillment(event({
    id: invalidSession.id,
    payment_link: "plink_live_smirk_starter",
  }), {
    env: exactPaymentLinkEnv,
    evaluatePolicy: approvedPolicy,
    retrieveCheckoutSession: async () => invalidSession,
  });
  assert.equal(proof.ok, false, `${label} must reject paid fulfillment`);
  assert.equal(proof.reason, expectedReason, `${label} must report its immutable Session failure`);
}
const unapprovedPolicy = await verifyCheckoutPaymentLinkBeforeFulfillment(event({
  id: completedPaymentLinkSession.id,
  payment_link: "plink_live_smirk_starter",
}), {
  env: exactPaymentLinkEnv,
  evaluatePolicy: () => ({
    coreReady: false,
    billingPolicy: { taxMode: approvedTaxMode },
    coreBlockers: [{ code: "fixture-owner-approval-missing" }],
  }),
  retrieveCheckoutSession: async () => { throw new Error("unapproved policy must fail before Session retrieval"); },
});
assert.equal(unapprovedPolicy.reason, "fixture-owner-approval-missing", "fulfillment must remain bound to checked-in owner policy approval");

// ── Founders $99 lane: exact-ID invite-only Starter promo ─────────────────────
const foundersSession = structuredClone(completedPaymentLinkSession);
foundersSession.id = "cs_live_founders_fixture_12345678";
foundersSession.payment_link = "plink_live_smirk_founders";
foundersSession.amount_subtotal = 9900;
foundersSession.amount_total = 9900;
foundersSession.line_items.data[0].amount_subtotal = 9900;
foundersSession.line_items.data[0].amount_total = 9900;
foundersSession.line_items.data[0].price.id = "price_founders_fixture";
foundersSession.line_items.data[0].price.unit_amount = 9900;
const foundersPaymentLinkEnv = {
  ...exactPaymentLinkEnv,
  STRIPE_PAYMENT_LINK_FOUNDERS_ID: "plink_live_smirk_founders",
};
const foundersProof = await verifyCheckoutPaymentLinkBeforeFulfillment(event({
  id: foundersSession.id,
  payment_link: "plink_live_smirk_founders",
}), {
  env: foundersPaymentLinkEnv,
  evaluatePolicy: approvedPolicy,
  retrievePaymentLink: async (paymentLinkId) => ({ id: paymentLinkId, livemode: true, active: true }),
  retrieveCheckoutSession: async () => structuredClone(foundersSession),
});
assert.equal(foundersProof.ok, true, "a paid $99 founders Session on the exact configured founders link must fulfill as Starter");
assert.equal(foundersProof.plan, "starter", "founders fulfillment must resolve to the starter plan");
const foundersLaneOff = await verifyCheckoutPaymentLinkBeforeFulfillment(event({
  id: foundersSession.id,
  payment_link: "plink_live_smirk_founders",
}), {
  env: exactPaymentLinkEnv,
  evaluatePolicy: approvedPolicy,
  retrieveCheckoutSession: async () => { throw new Error("unconfigured founders link must not retrieve Sessions"); },
});
assert.deepEqual(foundersLaneOff, {
  ok: true,
  source: "payment_link",
  ignored: true,
}, "without STRIPE_PAYMENT_LINK_FOUNDERS_ID the founders link is not a SMIRK lane and must be ignored");
const foundersWrongAmount = structuredClone(foundersSession);
foundersWrongAmount.amount_subtotal = 19700;
foundersWrongAmount.amount_total = 19700;
const foundersWrongAmountProof = await verifyCheckoutPaymentLinkBeforeFulfillment(event({
  id: foundersWrongAmount.id,
  payment_link: "plink_live_smirk_founders",
}), {
  env: foundersPaymentLinkEnv,
  evaluatePolicy: approvedPolicy,
  retrievePaymentLink: async (paymentLinkId) => ({ id: paymentLinkId, livemode: true, active: true }),
  retrieveCheckoutSession: async () => foundersWrongAmount,
});
assert.equal(foundersWrongAmountProof.ok, false, "a founders-link Session must pay exactly $99, not the public Starter amount");
assert.equal(foundersWrongAmountProof.reason, "checkout-session-subtotal-mismatch");
const starterAtFoundersPrice = structuredClone(completedPaymentLinkSession);
starterAtFoundersPrice.amount_subtotal = 9900;
starterAtFoundersPrice.amount_total = 9900;
const starterAtFoundersPriceProof = await verifyCheckoutPaymentLinkBeforeFulfillment(event({
  id: starterAtFoundersPrice.id,
  payment_link: "plink_live_smirk_starter",
}), {
  env: foundersPaymentLinkEnv,
  evaluatePolicy: approvedPolicy,
  retrieveCheckoutSession: async () => starterAtFoundersPrice,
});
assert.equal(starterAtFoundersPriceProof.ok, false, "the public Starter link must still require exactly $197 even when the founders lane is configured");
assert.equal(starterAtFoundersPriceProof.reason, "checkout-session-subtotal-mismatch");
const foundersInactiveLink = await verifyCheckoutPaymentLinkBeforeFulfillment(event({
  id: foundersSession.id,
  payment_link: "plink_live_smirk_founders",
}), {
  env: foundersPaymentLinkEnv,
  evaluatePolicy: approvedPolicy,
  retrievePaymentLink: async (paymentLinkId) => ({ id: paymentLinkId, livemode: true, active: false }),
  retrieveCheckoutSession: async () => { throw new Error("deactivated founders link must fail before Session retrieval"); },
});
assert.equal(foundersInactiveLink.ok, false, "a deactivated founders link must stop fulfilling new sessions");
assert.equal(foundersInactiveLink.reason, "founders-payment-link-inactive");
const foundersCollisionEnv = {
  ...foundersPaymentLinkEnv,
  STRIPE_PAYMENT_LINK_FOUNDERS_ID: "plink_live_smirk_starter",
};
const foundersCollision = await verifyCheckoutPaymentLinkBeforeFulfillment(event({
  id: completedPaymentLinkSession.id,
  payment_link: "plink_live_smirk_starter",
}), {
  env: foundersCollisionEnv,
  evaluatePolicy: approvedPolicy,
  retrieveCheckoutSession: async () => structuredClone(completedPaymentLinkSession),
});
assert.equal(foundersCollision.ok, true, "a founders ID colliding with the Starter allowlist must leave the Starter lane authoritative at $197");
const foundersNoTerms = structuredClone(foundersSession);
foundersNoTerms.consent = { terms_of_service: null };
const foundersNoTermsProof = await verifyCheckoutPaymentLinkBeforeFulfillment(event({
  id: foundersNoTerms.id,
  payment_link: "plink_live_smirk_founders",
}), {
  env: foundersPaymentLinkEnv,
  evaluatePolicy: approvedPolicy,
  retrievePaymentLink: async (paymentLinkId) => ({ id: paymentLinkId, livemode: true, active: true }),
  retrieveCheckoutSession: async () => foundersNoTerms,
});
assert.equal(foundersNoTermsProof.ok, false, "founders sessions must still collect provider terms consent");
assert.equal(foundersNoTermsProof.reason, "checkout-session-terms-not-accepted");
const classifyCheckout = (
  checkoutEvent: any,
  paymentLinkIds: Parameters<typeof classifySmirkCheckoutForFulfillment>[1] = {},
) => classifySmirkCheckoutForFulfillment(checkoutEvent, paymentLinkIds, approvedCustomerPolicyVersion, { allowNativeCheckout: true });

const baseSession = {
  id: "cs_live_real_12345678",
  livemode: true,
  mode: "subscription",
  status: "complete",
  payment_status: "paid",
  currency: "usd",
  amount_subtotal: 19700,
  amount_total: 19700,
  total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
  customer: "cus_real_1",
  subscription: "sub_real_1",
  customer_details: {
    business_name: "Real Plumber LLC",
    email: "owner@realplumber.com",
    phone: "+14155550123",
  },
  consent: { terms_of_service: "accepted" },
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
  ["underpriced plan", { amount_subtotal: 1, amount_total: 1 }],
  ["wrong pre-tax subtotal", { amount_subtotal: 19701, amount_total: 19701 }],
  ["one-time payment mode", { mode: "payment" }],
  ["missing Stripe customer", { customer: null }],
  ["missing Stripe subscription", { subscription: null }],
  ["missing provider business name", { customer_details: { ...baseSession.customer_details, business_name: null } }],
  ["missing provider email", { customer_details: { ...baseSession.customer_details, email: null } }],
  ["missing provider phone", { customer_details: { ...baseSession.customer_details, phone: null } }],
  ["terms not accepted", { consent: { terms_of_service: null } }],
] as const) {
  const result = classifyCheckout(event({ ...baseSession, ...mutation }, "checkout.session.completed", "livemode" in mutation && mutation.livemode === false ? false : true));
  assert.equal(result.approved, false, `${label} must fail closed`);
}

const automaticTaxCheckout = classifyCheckout(event({
  ...baseSession,
  amount_subtotal: 19700,
  amount_total: 21325,
  total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 1625 },
}));
assert.equal(automaticTaxCheckout.approved, true, "automatic tax may increase the paid total above the exact $197 pre-tax Starter subtotal");

const paymentLink = classifyCheckout(event({
  ...baseSession,
  metadata: { smirk_customer_policy_version: approvedCustomerPolicyVersion },
  payment_link: "plink_live_smirk_starter",
}), { starter: "plink_live_smirk_starter" });
assert.equal(paymentLink.approved, true, "exact configured Payment Link should qualify");
const rotatedPaymentLinkBindings = paymentLinkFulfillmentBindingsFromEnv({
  STRIPE_PAYMENT_LINK_STARTER_ID: "plink_live_new_smirk_starter",
  STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS: "plink_live_new_smirk_starter,plink_live_smirk_starter",
});
const rotatedPaymentLink = classifyCheckout(event({
  ...baseSession,
  metadata: { smirk_customer_policy_version: approvedCustomerPolicyVersion },
  payment_link: "plink_live_smirk_starter",
}), rotatedPaymentLinkBindings);
assert.equal(rotatedPaymentLink.approved, true, "the downstream webhook classifier must fulfill an old paid Session after a real current-ID rotation when the old exact ID remains allowlisted");
assert.equal(classifyCheckout(event({
  ...baseSession,
  metadata: { smirk_customer_policy_version: approvedCustomerPolicyVersion },
  payment_link: "plink_live_arbitrary_old_starter",
}), rotatedPaymentLinkBindings).approved, false, "the downstream webhook classifier must reject an arbitrary historical Payment Link ID");
assert.equal(classifyCheckout(event({
  ...baseSession,
  metadata: { smirk_customer_policy_version: approvedCustomerPolicyVersion },
  payment_link: "plink_live_smirk_starter",
}), {
  starter: ["plink_live_smirk_starter"],
  pro: ["plink_live_smirk_starter"],
}).approved, false, "a Payment Link ID mapped to more than one plan must fail closed");
assert.equal(classifyCheckout(event({
  ...baseSession,
  amount_subtotal: 39700,
  amount_total: 39700,
  metadata: { ...baseSession.metadata, plan: "pro" },
})).approved, false, "an old native Pro Session must not fulfill during the Starter-only launch");
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
    object: "checkout.session",
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
for (const [label, mutate] of [
  ["wrong event type", (value: any) => { value.type = "invoice.paid"; }],
  ["live Session", (value: any) => { value.data.object.livemode = true; }],
  ["one-time Session", (value: any) => { value.data.object.mode = "payment"; }],
  ["open Session", (value: any) => { value.data.object.status = "open"; }],
  ["unpaid Session", (value: any) => { value.data.object.payment_status = "unpaid"; }],
  ["wrong smoke plan", (value: any) => { value.data.object.metadata.plan = "pro"; }],
] as const) {
  const changed = structuredClone({
    id: "evt_smirk_paid_handoff_123",
    livemode: false,
    type: "checkout.session.completed",
    data: { object: {
      id: "cs_test_smirk_paid_handoff_123",
      object: "checkout.session",
      livemode: false,
      mode: "subscription",
      status: "complete",
      payment_status: "paid",
      metadata: { source: "gate3-stripe-webhook-smoke", plan: "starter", owner_email: "smoke+stripe-123@example.com" },
    } },
  });
  mutate(changed);
  assert.equal(classifyCheckout(changed).approvedSyntheticSmoke, false, `${label} must not use the synthetic smoke bypass`);
}
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
let checkoutHandler: ((req: any, res: any) => Promise<void>) | null = null;
let invitePreviewHandler: ((req: any, res: any) => Promise<void>) | null = null;
let inviteAcceptHandler: ((req: any, res: any) => Promise<void>) | null = null;
let inviteAcceptCount = 0;
let inviteInspectCount = 0;
let fixtureSubscriptionStatus = "active";
let paidExceptionInput: { event: any; input: any } | null = null;
const fixtureInviteToken = "a".repeat(64);
const fixtureExpiredInviteToken = "b".repeat(64);
const fakeApp = {
  get: (route: string, ...handlers: any[]) => {
    if (route === "/api/invite/:token") invitePreviewHandler = handlers.at(-1);
  },
  post: (route: string, ...handlers: any[]) => {
    if (route === "/api/checkout/create") checkoutHandler = handlers.at(-1);
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
  recordPaidCheckoutException: async (exceptionEvent, input) => {
    paidExceptionInput = { event: exceptionEvent, input };
    return {
      recorded: true,
      checkoutSessionId: String((exceptionEvent as any)?.data?.object?.id || ""),
      alertSent: true,
    };
  },
});
assert.ok(webhookHandler, "Stripe webhook handler must register");
assert.ok(checkoutHandler, "public checkout handler must register");
assert.ok(invitePreviewHandler, "invite preview handler must register");
assert.ok(inviteAcceptHandler, "invite acceptance handler must register");
const invokeCheckout = async (body: Record<string, unknown>) => {
  const result: { status: number; body: any; headers: Record<string, string> } = { status: 200, body: null, headers: {} };
  const response = {
    setHeader(name: string, value: string) { result.headers[name.toLowerCase()] = value; return response; },
    status(code: number) { result.status = code; return response; },
    json(payload: any) { result.body = payload; return response; },
  };
  await checkoutHandler!({ body }, response);
  return result;
};
for (const plan of ["pro", "enterprise"]) {
  const blocked = await invokeCheckout({
    plan,
    business_name: "Real Plumber LLC",
    owner_email: "owner@realplumber.com",
    owner_phone: "+14155550123",
  });
  assert.equal(blocked.status, 409, `${plan} checkout must remain disabled during the Starter-only first-dollar launch`);
  assert.equal(blocked.body.code, "FIRST_DOLLAR_STARTER_ONLY");
  assert.equal(blocked.headers["cache-control"], "no-store");
}
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
const oldStarterPaymentLinkId = process.env.STRIPE_PAYMENT_LINK_STARTER_ID;
const oldStarterFulfillmentIds = process.env.STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.ALLOW_UNSIGNED_STRIPE_WEBHOOK_DEV;
delete process.env.STRIPE_SECRET_KEY;
process.env.STRIPE_PAYMENT_LINK_STARTER_ID = "plink_live_smirk_starter";
process.env.STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS = "plink_live_smirk_starter";
assert.equal((await invokeWebhook({}, signaturePayload)).status, 400, "unsigned webhook must fail closed even when isProd is false");
process.env.ALLOW_UNSIGNED_STRIPE_WEBHOOK_DEV = "true";
assert.deepEqual((await invokeWebhook({}, signaturePayload)).body, { verified: true }, "explicit local unsigned override remains available");
const exactSyntheticSmokeEvent = {
  id: "evt_smirk_paid_handoff_route_fixture",
  type: "checkout.session.completed",
  livemode: false,
  data: {
    object: {
      id: "cs_test_smirk_paid_handoff_route_fixture",
      object: "checkout.session",
      livemode: false,
      mode: "subscription",
      status: "complete",
      payment_status: "paid",
      metadata: {
        source: "gate3-stripe-webhook-smoke",
        plan: "starter",
        owner_email: "smoke+stripe-route-fixture@example.com",
      },
    },
  },
};
const exactSyntheticSmokeResponse = await invokeWebhook({}, JSON.stringify(exactSyntheticSmokeEvent));
assert.equal(exactSyntheticSmokeResponse.status, 200, "the exact approved synthetic paid-handoff smoke remains the only no-link exception");
assert.deepEqual(exactSyntheticSmokeResponse.body, { received: true });
const rejectedNativePaidEvent = {
  id: "evt_live_native_paid_fixture",
  type: "checkout.session.completed",
  livemode: true,
  data: {
    object: {
      ...baseSession,
      id: "cs_live_native_paid_fixture_12345678",
      payment_link: null,
    },
  },
};
const rejectedNativePaidResponse = await invokeWebhook({}, JSON.stringify(rejectedNativePaidEvent));
assert.equal(rejectedNativePaidResponse.status, 503, "a paid native Session must be deferred during the hosted-only launch");
assert.equal(rejectedNativePaidResponse.body.code, "PAYMENT_LINK_FULFILLMENT_VERIFICATION_REQUIRED");
assert.equal((paidExceptionInput as any)?.event?.id, rejectedNativePaidEvent.id, "the paid native Session must enter durable rescue before webhook retry");
assert.equal((paidExceptionInput as any)?.input?.reason, "native-checkout-disabled-first-dollar-launch");
const unrelatedNativePaidEvent = {
  ...rejectedNativePaidEvent,
  id: "evt_live_unrelated_native_paid_fixture",
  data: {
    object: {
      ...rejectedNativePaidEvent.data.object,
      id: "cs_live_unrelated_native_paid_fixture_12345678",
      metadata: {},
    },
  },
};
const unrelatedNativePaidResponse = await invokeWebhook({}, JSON.stringify(unrelatedNativePaidEvent));
assert.equal(unrelatedNativePaidResponse.status, 200, "an unrelated native Stripe purchase must be acknowledged without SMIRK rescue retries");
assert.deepEqual(unrelatedNativePaidResponse.body, { received: true });
assert.equal((paidExceptionInput as any)?.event?.id, rejectedNativePaidEvent.id, "unrelated native revenue must not overwrite the SMIRK rescue fact");
const rejectedPaidLinkEvent = {
  id: "evt_live_unconfigured_paid_link_fixture",
  type: "checkout.session.completed",
  livemode: true,
  data: {
    object: {
      id: "cs_live_unconfigured_paid_link_fixture",
      livemode: true,
      mode: "subscription",
      status: "complete",
      payment_status: "paid",
      payment_link: "plink_live_unconfigured_exception_fixture",
      customer: "cus_unconfigured_exception_fixture",
      subscription: "sub_unconfigured_exception_fixture",
      amount_subtotal: 39700,
      amount_total: 39700,
      currency: "usd",
      customer_details: {
        business_name: "Legacy Link Buyer",
        email: "legacy@example.net",
        phone: "+14155550123",
      },
    },
  },
};
const rejectedPaidLinkResponse = await invokeWebhook({}, JSON.stringify(rejectedPaidLinkEvent));
assert.equal(rejectedPaidLinkResponse.status, 200, "an unrelated paid hosted link must be acknowledged without SMIRK rescue retries");
assert.deepEqual(rejectedPaidLinkResponse.body, { received: true });
assert.equal((paidExceptionInput as any)?.event?.id, rejectedNativePaidEvent.id, "unrelated Payment Link revenue must not overwrite the SMIRK rescue fact");
const stronglyIdentifiedRejectedPaidLinkEvent: any = structuredClone(rejectedPaidLinkEvent);
stronglyIdentifiedRejectedPaidLinkEvent.id = "evt_live_unconfigured_smirk_paid_link_fixture";
stronglyIdentifiedRejectedPaidLinkEvent.data.object.id = "cs_live_unconfigured_smirk_paid_link_fixture";
stronglyIdentifiedRejectedPaidLinkEvent.data.object.metadata = {
  smirk_product: "missed_call_recovery",
  smirk_checkout_version: "1",
  smirk_customer_policy_version: approvedCustomerPolicyVersion,
  plan: "pro",
};
const stronglyIdentifiedRejectedPaidLinkResponse = await invokeWebhook({}, JSON.stringify(stronglyIdentifiedRejectedPaidLinkEvent));
assert.equal(stronglyIdentifiedRejectedPaidLinkResponse.status, 503, "strong SMIRK metadata must preserve rescue for an unconfigured hosted link");
assert.equal(stronglyIdentifiedRejectedPaidLinkResponse.body.code, "PAYMENT_LINK_FULFILLMENT_VERIFICATION_REQUIRED");
assert.equal((paidExceptionInput as any)?.event?.id, stronglyIdentifiedRejectedPaidLinkEvent.id, "the identified SMIRK event must enter durable rescue before 503");
assert.equal((paidExceptionInput as any)?.input?.reason, "payment-link-fulfillment-id-not-uniquely-configured");
delete process.env.ALLOW_UNSIGNED_STRIPE_WEBHOOK_DEV;
process.env.STRIPE_WEBHOOK_SECRET = signatureSecret;
assert.deepEqual((await invokeWebhook({ "stripe-signature": signature }, signaturePayload)).body, { verified: true }, "signed webhook verification works without STRIPE_SECRET_KEY");
if (oldWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = oldWebhookSecret;
if (oldUnsignedOverride === undefined) delete process.env.ALLOW_UNSIGNED_STRIPE_WEBHOOK_DEV; else process.env.ALLOW_UNSIGNED_STRIPE_WEBHOOK_DEV = oldUnsignedOverride;
if (oldStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = oldStripeKey;
if (oldStarterPaymentLinkId === undefined) delete process.env.STRIPE_PAYMENT_LINK_STARTER_ID; else process.env.STRIPE_PAYMENT_LINK_STARTER_ID = oldStarterPaymentLinkId;
if (oldStarterFulfillmentIds === undefined) delete process.env.STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS; else process.env.STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS = oldStarterFulfillmentIds;

console.log("OK checkout fulfillment fixtures enforce exact Session binding, provider identity, Starter-only scope, live mode, smoke, and public-intake boundaries");
