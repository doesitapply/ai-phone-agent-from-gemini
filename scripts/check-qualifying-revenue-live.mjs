#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import Stripe from "stripe";
import { railwayVariables } from "./railway-json.mjs";
import {
  identifySmirkCheckout,
  isClearlyNonCustomer,
  paymentLinkPlanMap,
  resolveExactCheckoutPayment,
  selectExactWorkspace,
  validateRevenueAppOrigin,
} from "./lib/qualifying-revenue-evidence.mjs";

const defaultAppUrl = "https://ai-phone-agent-production-6811.up.railway.app";
const windowDays = Math.min(Math.max(Number.parseInt(String(process.env.SMIRK_REVENUE_WINDOW_DAYS || "120"), 10) || 120, 1), 365);
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
    requiredStripeReadResources: ["Checkout Sessions", "Invoices", "Invoice Payments", "PaymentIntents", "Charges", "Balance Transactions", "Invoice line items"],
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

const allowedPaymentLinks = paymentLinkPlanMap({
  starter: value(["STRIPE_PAYMENT_LINK_STARTER_ID"]),
  pro: value(["STRIPE_PAYMENT_LINK_PRO_ID"]),
  enterprise: value(["STRIPE_PAYMENT_LINK_ENTERPRISE_ID"]),
});
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
const sinceEpoch = Math.floor(Date.now() / 1000) - windowDays * 86400;
const nowEpoch = Math.floor(Date.now() / 1000);

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

  const [membersResponse, tokenResponse] = await Promise.all([
    request(`/api/workspaces/${encodeURIComponent(workspace.id)}/members`, { "x-api-key": operatorKey }),
    request(`/api/workspaces/${encodeURIComponent(workspace.id)}/apikey`, { "x-api-key": operatorKey }),
  ]);
  const members = Array.isArray(membersResponse.body?.members) ? membersResponse.body.members : [];
  const membershipAccepted = members.some((member) => String(member.email || "").trim().toLowerCase() === payment.buyerEmail && Boolean(member.accepted_at));
  const workspaceToken = String(tokenResponse.body?.api_key || "").trim();
  if (!membersResponse.ok || !membershipAccepted) return { ok: false, reason: "buyer-membership-not-accepted", workspaceId: workspace.id };
  if (!tokenResponse.ok
    || !workspaceToken
    || Number(tokenResponse.body?.id) !== Number(workspace.id)
    || String(tokenResponse.body?.owner_email || "").trim().toLowerCase() !== payment.buyerEmail) {
    return { ok: false, reason: "workspace-token-identity-mismatch", workspaceId: workspace.id };
  }

  const profileResponse = await request("/api/workspace/profile", {
    authorization: `Bearer ${workspaceToken}`,
    "x-workspace-id": String(workspace.id),
  });
  const profile = profileResponse.body;
  const activationStage = String(profile?.activation_status?.stage || "");
  const profileIdentityMatches = Number(profile?.id) === Number(workspace.id)
    && String(profile?.owner_email || "").trim().toLowerCase() === payment.buyerEmail;
  if (!profileResponse.ok || !profileIdentityMatches || activationStage !== "proof_complete" || profile?.setup_readiness?.ready !== true || profile?.proof_freshness?.fresh !== true) {
    return {
      ok: false,
      reason: "customer-activation-or-proof-incomplete",
      workspaceId: workspace.id,
      activationStage,
      setupReady: profile?.setup_readiness?.ready === true,
      proofFresh: profile?.proof_freshness?.fresh === true,
    };
  }
  return {
    ok: true,
    workspaceId: workspace.id,
    plan: workspace.plan,
    subscriptionStatus: workspace.subscription_status,
    membershipAccepted: true,
    activationStage,
    setupReady: true,
    proofFresh: true,
  };
}

const candidateSessions = scan.sessions.filter((session) => identifySmirkCheckout(session, allowedPaymentLinks).ok);
const reviewed = [];
for (const listedSession of candidateSessions) {
  const payment = await resolveExactCheckoutPayment({ stripe, listedSession, allowedPaymentLinks, nowEpoch });
  const buyerEmail = payment.ok ? payment.buyerEmail : "";
  const clearlyExcluded = payment.ok ? isClearlyNonCustomer(buyerEmail, excludedEmails) : false;
  const customerAttested = payment.ok && independenceAttested && verifiedCustomerIds.has(payment.customerId);
  const activation = payment.ok && !clearlyExcluded
    ? await activationForPayment(payment)
    : { ok: false, reason: clearlyExcluded ? "test-team-or-unverifiable-buyer" : "payment-not-qualified" };
  const qualified = Boolean(payment.ok && activation.ok && !clearlyExcluded && customerAttested);
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
    buyerEvidence: { clearlyExcluded, independenceAttested: customerAttested },
    activationEvidence: activation.ok ? activation : { ok: false, reason: activation.reason },
  });
}

const qualifying = reviewed.filter((entry) => entry.qualified);
const incompleteEvidenceReasons = new Set([
  "stripe-exact-payment-evidence-read-failed",
  "initial-invoice-scan-truncated",
  "invoice-line-items-truncated",
  "invoice-payments-truncated",
]);
const evidenceReadsComplete = !reviewed.some((entry) => (
  entry.providerEvidence?.stripeError || incompleteEvidenceReasons.has(entry.providerEvidence?.reason)
));
const output = {
  ok: qualifying.length > 0,
  checkedAt: new Date().toISOString(),
  appUrl,
  windowDays,
  scanComplete: !scan.truncated && evidenceReadsComplete,
  evidenceReadsComplete,
  evidenceStandard: {
    allowlistedSmirkSubscriptionCheckout: true,
    exactCheckoutInvoicePaymentIntentChain: true,
    capturedUnrefundedUndisputedCharge: true,
    availableBalanceTransaction: true,
    exactSubscriptionWorkspace: true,
    explicitlyAttestedNonTeamBuyer: true,
    acceptedWorkspaceMembership: true,
    completedSetupAndFreshProofLoop: true,
  },
  counts: {
    checkoutSessionsReviewed: scan.sessions.length,
    smirkCheckoutCandidates: candidateSessions.length,
    qualifyingRevenuePayments: qualifying.length,
  },
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
          : allowedPaymentLinks.size === 0
            ? "Configure the exact live plink_ IDs in STRIPE_PAYMENT_LINK_STARTER_ID, STRIPE_PAYMENT_LINK_PRO_ID, and STRIPE_PAYMENT_LINK_ENTERPRISE_ID so Payment Link purchases can be identified safely."
            : "No exact live settled unrefunded SMIRK checkout with completed customer activation currently qualifies.",
};

writeAndExit(output, output.ok ? 0 : 1);
