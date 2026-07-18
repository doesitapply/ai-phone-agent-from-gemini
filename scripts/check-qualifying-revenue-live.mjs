#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import Stripe from "stripe";
import { railwayVariables } from "./railway-json.mjs";
import {
  customerPolicyReadyForPlan,
  evaluateCustomerPolicyApproval,
  verifyPublishedCustomerPolicyDocumentsForPlan,
} from "../src/customer-policy-approval.js";
import {
  identifySmirkCheckout,
  isClearlyNonCustomer,
  objectId,
  resolveExactCheckoutPayment,
  selectExactWorkspace,
  validateCheckoutActivationEvidence,
  validateRevenueAppOrigin,
  verifyProviderCheckoutFulfillmentEvent,
  verifyCanonicalRevenuePaymentLinks,
} from "./lib/qualifying-revenue-evidence.mjs";

const defaultAppUrl = "https://ai-phone-agent-production-6811.up.railway.app";
const windowDays = Math.min(Math.max(Number.parseInt(String(process.env.SMIRK_REVENUE_WINDOW_DAYS || "120"), 10) || 120, 1), 365);
const goalStartedAt = "2026-07-18T09:06:54.000Z";
const goalStartedEpoch = Math.floor(Date.parse(goalStartedAt) / 1000);
const maxSessions = Math.min(Math.max(Number.parseInt(String(process.env.SMIRK_REVENUE_MAX_SESSIONS || "1000"), 10) || 1000, 1), 10000);
const fetchTimeoutMs = Number(process.env.SMIRK_REVENUE_FETCH_TIMEOUT_MS || 15000);
const attestationPhrase = "confirmed-real-customer-unrelated-to-owner-team";
const outputPath = path.resolve("output", "qualifying-revenue-live.json");
const shouldWrite = !process.argv.includes("--no-write");

function readEnvFiles() {
  const values = {};
  for (const file of [".env.local", ".env"]) {
    const absolute = path.resolve(file);
    if (!fs.existsSync(absolute)) continue;
    for (const line of fs.readFileSync(absolute, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (!match || values[match[1]]) continue;
      values[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
  return values;
}

const localEnv = readEnvFiles();
let railwayEnv = {};
let railwayEnvError = null;
try {
  railwayEnv = railwayVariables({ quiet: true, attempts: 2, delayMs: 1000 });
} catch (error) {
  railwayEnvError = error?.detail || String(error?.message || error);
}

function value(keys) {
  for (const key of keys) {
    const candidate = String(process.env[key] || localEnv[key] || railwayEnv[key] || "").trim();
    if (candidate) return candidate;
  }
  return "";
}

function splitCsv(raw, lower = true) {
  return String(raw || "").split(",").map((entry) => {
    const clean = entry.trim();
    return lower ? clean.toLowerCase() : clean;
  }).filter(Boolean);
}

function extractEmail(raw) {
  const match = String(raw || "").toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match?.[0] || "";
}

function maskId(raw) {
  const id = String(raw || "");
  if (!id) return null;
  return `${id.slice(0, Math.min(5, id.length))}...${id.slice(-6)}`;
}

function writeAndExit(output, code) {
  if (shouldWrite) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  }
  (code === 0 ? process.stdout : process.stderr).write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(code);
}

const validatedOrigin = validateRevenueAppOrigin(value(["SMIRK_REVENUE_APP_URL"]) || defaultAppUrl);
if (!validatedOrigin.ok) {
  writeAndExit({
    ok: false,
    checkedAt: new Date().toISOString(),
    error: validatedOrigin.reason,
    message: "Refusing to send operator or workspace credentials to a non-allowlisted origin.",
  }, 1);
}
const appUrl = validatedOrigin.origin;

const stripeKey = value(["STRIPE_REVENUE_READ_KEY"]);
if (!/^rk_live_/.test(stripeKey)) {
  writeAndExit({
    ok: false,
    checkedAt: new Date().toISOString(),
    error: "stripe-live-restricted-read-key-unavailable",
    configuredMode: stripeKey.startsWith("rk_test_") ? "test" : "missing-or-unknown",
    railwayEnvReadable: !railwayEnvError,
    message: "A dedicated live restricted Stripe key is required; broad secret keys and operator-edited app state cannot prove revenue.",
    requiredStripeReadResources: ["Payment Links", "Prices", "Products", "Webhook Endpoints", "Events", "Checkout Sessions", "Invoices", "Invoice Payments", "PaymentIntents", "Charges", "Balance Transactions", "Invoice line items"],
    nextAction: "Provide STRIPE_REVENUE_READ_KEY as an rk_live_ key with read access to the listed resources, then rerun npm run check:qualifying-revenue-live.",
  }, 1);
}

const operatorKey = value(["DASHBOARD_API_KEY"]);
if (!operatorKey) {
  writeAndExit({
    ok: false,
    checkedAt: new Date().toISOString(),
    error: "operator-key-unavailable",
    message: "DASHBOARD_API_KEY is required to correlate provider funds with production activation.",
  }, 1);
}

const customerPolicyVersion = value(["SMIRK_CUSTOMER_POLICY_APPROVED_VERSION"]);
const customerPolicyApproval = evaluateCustomerPolicyApproval(customerPolicyVersion);
if (!customerPolicyApproval.coreReady) {
  writeAndExit({
    ok: false,
    checkedAt: new Date().toISOString(),
    error: "customer-policy-owner-approval-not-ready",
    blockers: customerPolicyApproval.coreBlockers,
    message: "Revenue cannot qualify until the checked-in core owner approval and customer policies are complete. Enterprise policy is required only for an Enterprise payment.",
  }, 1);
}
const publishedCorePolicyProof = await verifyPublishedCustomerPolicyDocumentsForPlan(customerPolicyVersion, "starter");
if (!publishedCorePolicyProof.ok) {
  writeAndExit({
    ok: false,
    checkedAt: new Date().toISOString(),
    error: "customer-policy-publication-proof-failed",
    failures: publishedCorePolicyProof.failures,
    message: "Revenue cannot qualify while an approved public customer-policy document is unreachable or redirects.",
  }, 1);
}
const canonicalPaymentLinkConfigs = [
  { plan: "starter", id: value(["STRIPE_PAYMENT_LINK_STARTER_ID"]), url: value(["STRIPE_PAYMENT_LINK_STARTER"]) },
  { plan: "pro", id: value(["STRIPE_PAYMENT_LINK_PRO_ID"]), url: value(["STRIPE_PAYMENT_LINK_PRO"]) },
  { plan: "enterprise", id: value(["STRIPE_PAYMENT_LINK_ENTERPRISE_ID"]), url: value(["STRIPE_PAYMENT_LINK_ENTERPRISE"]) },
];
const excludedEmails = new Set([
  ...splitCsv(value(["SMIRK_REVENUE_EXCLUDED_EMAILS"])),
  ...splitCsv(value(["GOOGLE_ADMIN_EMAILS"])),
  ...splitCsv(value(["DEMO_OPERATOR_EMAILS"])),
  extractEmail(value(["OWNER_EMAIL"])),
  extractEmail(value(["OWNER_ALERT_EMAIL"])),
  extractEmail(value(["OPERATOR_EMAIL"])),
  extractEmail(value(["FROM_EMAIL"])),
].filter(Boolean));
const independenceAttested = value(["SMIRK_REVENUE_CUSTOMER_ATTESTATION"]) === attestationPhrase;
const verifiedCustomerIds = new Set(splitCsv(value(["SMIRK_REVENUE_VERIFIED_CUSTOMER_IDS"]), false));

async function request(pathname, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const response = await fetch(`${appUrl}${pathname}`, { headers, signal: controller.signal, redirect: "error" });
    if (new URL(response.url).origin !== appUrl) throw new Error("production response origin changed unexpectedly");
    const bodyText = await response.text();
    let body = null;
    try { body = bodyText ? JSON.parse(bodyText) : null; } catch { body = null; }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: {
        name: error?.name || null,
        code: error?.cause?.code || error?.code || null,
        message: String(error?.message || error || "request failed").slice(0, 240),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

const [operatorSession, workspaceResponse] = await Promise.all([
  request("/api/operator/session", { "x-api-key": operatorKey }),
  request("/api/workspaces", { "x-api-key": operatorKey }),
]);
if (!operatorSession.ok || operatorSession.body?.role !== "operator" || !workspaceResponse.ok || !Array.isArray(workspaceResponse.body?.workspaces)) {
  writeAndExit({
    ok: false,
    checkedAt: new Date().toISOString(),
    error: "production-operator-evidence-unavailable",
    operatorStatus: operatorSession.status,
    workspaceStatus: workspaceResponse.status,
    message: "Could not read the production workspace inventory needed to prove activation.",
  }, 1);
}

const stripe = new Stripe(stripeKey, { apiVersion: "2026-02-25.clover" });
const nowEpoch = Math.floor(Date.now() / 1000);
const rollingSinceEpoch = nowEpoch - windowDays * 86400;
const sinceEpoch = Math.max(goalStartedEpoch, rollingSinceEpoch);

const enabledPaymentLinkConfigs = canonicalPaymentLinkConfigs.filter((config) => (
  (config.plan !== "enterprise" || customerPolicyApproval.enterpriseUsageReady)
  && (config.id || config.url)
));
const configuredPaymentLinkIds = new Set(enabledPaymentLinkConfigs
  .map((config) => config.id)
  .filter((id) => /^plink_[A-Za-z0-9_]+$/.test(id)));
const allowedPaymentLinks = new Map();
const paymentLinkVerificationFailures = [];
const paymentLinkFailureById = new Map();
for (const config of enabledPaymentLinkConfigs) {
  const verification = await verifyCanonicalRevenuePaymentLinks({
    stripe,
    configs: [config],
    policyVersion: customerPolicyVersion,
  });
  if (verification.ok) {
    for (const [id, binding] of verification.allowedPaymentLinks) allowedPaymentLinks.set(id, binding);
    continue;
  }
  const failure = {
    plan: config.plan,
    reason: verification.reason,
    failedChecks: verification.failedChecks || undefined,
    stripeError: verification.stripeError || undefined,
  };
  paymentLinkVerificationFailures.push(failure);
  if (/^plink_[A-Za-z0-9_]+$/.test(config.id)) paymentLinkFailureById.set(config.id, failure);
}

async function listCheckoutSessions() {
  const sessions = [];
  let startingAfter;
  let truncated = false;
  while (sessions.length < maxSessions) {
    const limit = Math.min(100, maxSessions - sessions.length);
    const page = await stripe.checkout.sessions.list({
      limit,
      created: { gte: sinceEpoch },
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    sessions.push(...page.data);
    if (!page.has_more) return { sessions, truncated: false };
    if (sessions.length >= maxSessions) {
      truncated = true;
      break;
    }
    startingAfter = page.data.at(-1)?.id;
    if (!startingAfter) throw new Error("Stripe Checkout pagination returned has_more without a cursor");
  }
  return { sessions, truncated };
}

let scan;
try {
  scan = await listCheckoutSessions();
} catch (error) {
  writeAndExit({
    ok: false,
    checkedAt: new Date().toISOString(),
    error: "stripe-provider-read-failed",
    stripeError: { type: error?.type || null, code: error?.code || null, statusCode: error?.statusCode || null },
    message: "The restricted key could not read live Checkout Sessions. Verify every required read permission in Stripe request logs.",
  }, 1);
}

async function activationForPayment(payment) {
  const selected = selectExactWorkspace(workspaceResponse.body.workspaces, payment);
  if (!selected.ok) return selected;
  const workspace = selected.workspace;
  if (String(workspace.owner_email || "").trim().toLowerCase() !== payment.buyerEmail) return { ok: false, reason: "workspace-owner-does-not-match-buyer" };
  if (String(workspace.plan || "").toLowerCase() !== payment.plan) return { ok: false, reason: "workspace-plan-does-not-match-checkout", workspaceId: workspace.id };
  if (workspace.subscription_status !== "active") return { ok: false, reason: "workspace-subscription-not-active", workspaceId: workspace.id };

  const checkoutActivationResponse = await request(
    `/api/provisioning/checkout-activation-evidence/${encodeURIComponent(payment.session.id)}`,
    { "x-api-key": operatorKey },
  );
  const automaticActivation = checkoutActivationResponse.ok
    ? validateCheckoutActivationEvidence(checkoutActivationResponse.body, payment, workspace)
    : { ok: false, reason: "checkout-activation-evidence-unavailable" };
  if (!automaticActivation.ok) {
    return {
      ok: false,
      reason: automaticActivation.reason,
      workspaceId: workspace.id,
      checkoutActivationStatus: checkoutActivationResponse.status,
    };
  }
  const providerFulfillment = await verifyProviderCheckoutFulfillmentEvent({
    stripe,
    eventId: automaticActivation.fulfillmentEventId,
    payment,
    policyVersion: customerPolicyVersion,
    webhookUrl: `${appUrl}/api/stripe/webhook`,
  });
  if (!providerFulfillment.ok) {
    return {
      ok: false,
      reason: providerFulfillment.reason,
      stripeError: providerFulfillment.stripeError,
      workspaceId: workspace.id,
    };
  }
  return {
    ok: true,
    workspaceId: workspace.id,
    plan: workspace.plan,
    subscriptionStatus: workspace.subscription_status,
    buyerInviteAccepted: automaticActivation.ownerInviteAccepted,
    buyerInviteAcceptanceEvent: automaticActivation.buyerInviteAcceptanceEvent,
    customerSetupEvent: automaticActivation.customerSetupEvent,
    customerProofEvent: automaticActivation.customerProofEvent,
    operatorRescueEvent: automaticActivation.operatorRescueEvent,
    activationStage: automaticActivation.activationStage,
    setupReady: automaticActivation.setupReady,
    proofFresh: automaticActivation.proofFresh,
    completeProofCalls: automaticActivation.completeProofCalls,
    setupCompletedAt: automaticActivation.setupCompletedAt,
    latestCompleteProofAt: automaticActivation.latestCompleteProofAt,
    automaticCheckoutFulfillment: true,
    checkoutCreatedWorkspace: true,
    buyerActivationEmailSent: true,
    exactStripeFulfillmentEventDelivered: true,
  };
}

let enterprisePublishedPolicyProof = null;
async function policyForPayment(payment) {
  if (!customerPolicyReadyForPlan(customerPolicyApproval, payment?.plan)) {
    return {
      ok: false,
      reason: "customer-policy-not-approved-for-plan",
      blockers: payment?.plan === "enterprise"
        ? customerPolicyApproval.enterpriseBlockers
        : customerPolicyApproval.coreBlockers,
    };
  }
  if (payment?.plan !== "enterprise") return { ok: true, scope: "core" };
  enterprisePublishedPolicyProof ||= await verifyPublishedCustomerPolicyDocumentsForPlan(
    customerPolicyVersion,
    "enterprise",
  );
  return enterprisePublishedPolicyProof.ok
    ? { ok: true, scope: "enterprise" }
    : {
        ok: false,
        reason: "enterprise-policy-publication-proof-failed",
        failures: enterprisePublishedPolicyProof.failures,
      };
}

const candidateSessions = scan.sessions.filter((session) => {
  const paymentLinkId = objectId(session?.payment_link);
  return paymentLinkId
    ? configuredPaymentLinkIds.has(paymentLinkId)
    : identifySmirkCheckout(session, allowedPaymentLinks, customerPolicyVersion).ok;
});
const reviewed = [];
for (const listedSession of candidateSessions) {
  const paymentLinkId = objectId(listedSession?.payment_link);
  const linkFailure = paymentLinkId ? paymentLinkFailureById.get(paymentLinkId) : null;
  const payment = linkFailure
    ? { ok: false, reason: linkFailure.reason, stripeError: linkFailure.stripeError }
    : await resolveExactCheckoutPayment({ stripe, listedSession, allowedPaymentLinks, nowEpoch, policyVersion: customerPolicyVersion });
  const buyerEmail = payment.ok ? payment.buyerEmail : "";
  const clearlyExcluded = payment.ok ? isClearlyNonCustomer(buyerEmail, excludedEmails) : false;
  const customerAttested = payment.ok && independenceAttested && verifiedCustomerIds.has(payment.customerId);
  const planPolicy = payment.ok ? await policyForPayment(payment) : { ok: false, reason: "payment-not-qualified" };
  const activation = payment.ok && planPolicy.ok && !clearlyExcluded
    ? await activationForPayment(payment)
    : {
        ok: false,
        reason: clearlyExcluded
          ? "test-team-or-unverifiable-buyer"
          : (!planPolicy.ok ? planPolicy.reason : "payment-not-qualified"),
      };
  const qualified = Boolean(payment.ok && planPolicy.ok && activation.ok && !clearlyExcluded && customerAttested);
  reviewed.push({
    qualified,
    customerReference: payment.ok ? maskId(payment.customerId) : null,
    checkoutSession: maskId(listedSession.id),
    invoice: payment.ok ? maskId(payment.invoice.id) : null,
    paymentIntent: payment.ok ? maskId(payment.paymentIntent.id) : null,
    amount: Number(listedSession.amount_total || 0),
    currency: listedSession.currency || null,
    checkoutCreatedAt: listedSession.created ? new Date(listedSession.created * 1000).toISOString() : null,
    productBinding: payment.ok ? payment.productBinding : null,
    providerEvidence: payment.ok ? {
      exactCheckoutInvoicePaymentIntentChain: true,
      liveMode: true,
      paymentSucceeded: true,
      chargeCaptured: true,
      refundAmount: 0,
      disputed: false,
      balanceAvailable: true,
      availableOn: new Date(payment.balanceTransaction.available_on * 1000).toISOString(),
    } : { ok: false, reason: payment.reason, stripeError: payment.stripeError || undefined },
    policyEvidence: planPolicy,
    buyerEvidence: { clearlyExcluded, independenceAttested: customerAttested },
    activationEvidence: activation.ok ? activation : { ok: false, reason: activation.reason, stripeError: activation.stripeError || undefined },
  });
}

const qualifying = reviewed.filter((entry) => entry.qualified);
const incompleteEvidenceReasons = new Set([
  "stripe-exact-payment-evidence-read-failed",
  "initial-invoice-scan-truncated",
  "invoice-line-items-truncated",
  "invoice-payments-truncated",
  "checkout-fulfillment-provider-event-read-failed",
  "checkout-fulfillment-delivery-scan-truncated",
]);
const evidenceReadsComplete = !paymentLinkVerificationFailures.some((failure) => failure.stripeError)
  && !reviewed.some((entry) => (
    entry.providerEvidence?.stripeError
    || entry.activationEvidence?.stripeError
    || incompleteEvidenceReasons.has(entry.providerEvidence?.reason)
    || incompleteEvidenceReasons.has(entry.activationEvidence?.reason)
  ));
const output = {
  ok: qualifying.length > 0,
  checkedAt: new Date().toISOString(),
  appUrl,
  windowDays,
  goalStartedAt,
  evidenceSince: new Date(sinceEpoch * 1000).toISOString(),
  scanComplete: !scan.truncated && evidenceReadsComplete,
  evidenceReadsComplete,
  evidenceStandard: {
    allowlistedSmirkSubscriptionCheckout: true,
    exactConfiguredPaymentLinkVerifiedBeforeUse: true,
    nativeServerCheckoutBoundWithoutPaymentLinkDependency: true,
    exactApprovedCustomerPolicyVersion: true,
    planSpecificCheckedInOwnerPolicyApproval: true,
    planSpecificPublicPolicyDocumentsVerified: true,
    exactCheckoutInvoicePaymentIntentChain: true,
    capturedUnrefundedUndisputedCharge: true,
    availableBalanceTransaction: true,
    exactSubscriptionWorkspace: true,
    explicitlyAttestedNonTeamBuyer: true,
    buyerInviteAcceptanceProvenance: true,
    customerAuthenticatedSetupAndProofProvenance: true,
    noOperatorWorkspaceSecretRevealOrImpersonation: true,
    automaticCheckoutFulfillmentChain: true,
    exactProviderDeliveredCheckoutEvent: true,
    buyerActivationEmailDelivery: true,
    completedSetupAndFreshProofLoop: true,
  },
  counts: {
    checkoutSessionsReviewed: scan.sessions.length,
    smirkCheckoutCandidates: candidateSessions.length,
    configuredPaymentLinksVerified: allowedPaymentLinks.size,
    configuredPaymentLinkFailures: paymentLinkVerificationFailures.length,
    qualifyingRevenuePayments: qualifying.length,
  },
  paymentLinkVerificationFailures,
  qualifyingPayments: qualifying,
  reviewedCandidates: reviewed,
  nextAction: qualifying.length > 0
    ? "Qualifying real revenue and customer activation are proven."
    : !evidenceReadsComplete
      ? "One or more exact Stripe evidence reads failed. Fix the restricted-key resource permissions shown in the candidate error and rerun; do not conclude that revenue is absent."
      : scan.truncated
      ? `Checkout scan is incomplete at ${maxSessions} sessions; raise SMIRK_REVENUE_MAX_SESSIONS and rerun before concluding there is no revenue.`
      : reviewed.length > 0 && !independenceAttested
          ? `Review any exact live candidate in Stripe, then set SMIRK_REVENUE_CUSTOMER_ATTESTATION=${attestationPhrase} and add only that exact customer to SMIRK_REVENUE_VERIFIED_CUSTOMER_IDS after confirming the buyer is unrelated to the owner/team.`
        : reviewed.length > 0 && verifiedCustomerIds.size === 0
            ? "Add the reviewed unrelated buyer's exact cus_ ID to SMIRK_REVENUE_VERIFIED_CUSTOMER_IDS; the global attestation phrase alone never qualifies a payment."
          : allowedPaymentLinks.size === 0 && candidateSessions.some((session) => objectId(session?.payment_link))
            ? "Configure and verify the exact live Payment Link ID and URL for the purchased enabled plan. Native server-created checkout does not depend on unrelated Payment Links."
            : "No exact live settled unrefunded SMIRK checkout with completed customer activation currently qualifies.",
};

writeAndExit(output, output.ok ? 0 : 1);
