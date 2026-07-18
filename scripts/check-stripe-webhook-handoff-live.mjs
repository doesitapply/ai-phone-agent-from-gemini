#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Stripe from "stripe";
import { railwayVariables } from "./railway-json.mjs";

const appUrl = String(process.env.APP_URL || "https://smirkcalls.com").replace(/\/$/, "");
const preflightOnly = process.argv.includes("--preflight");
const signatureOnly = process.argv.includes("--signature-only");
const fetchTimeoutMs = Number(process.env.SMIRK_STRIPE_WEBHOOK_FETCH_TIMEOUT_MS || 15000);
const fetchAttempts = Number(process.env.SMIRK_STRIPE_WEBHOOK_FETCH_ATTEMPTS || 2);
const fetchRetryDelayMs = Number(process.env.SMIRK_STRIPE_WEBHOOK_FETCH_RETRY_DELAY_MS || 750);
const outputDir = path.resolve("output");

function readLocalEnvValue(key) {
  const files = [
    ".env.local",
    ".env",
    path.join(process.env.HOME || "", ".openclaw", "workspace", ".env.operator"),
    path.join(process.env.HOME || "", ".openclaw", "workspace", ".env.smirk"),
    path.join(process.env.HOME || "", ".openclaw", "workspace", ".env"),
  ];
  for (const file of files) {
    const p = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith(`${key}=`)) continue;
      return line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, "");
    }
  }
  return "";
}

function writeOutputArtifact(filename, data) {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, filename), JSON.stringify(data, null, 2) + "\n");
}

function readLiveDeploy() {
  try {
    const raw = execFileSync("npm", ["run", "-s", "check:live-is-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: "live-deploy-fingerprint-unavailable",
      detail: String(error?.stdout || error?.stderr || error?.message || "").slice(0, 1000),
    };
  }
}

function readRailwayVariablesResult() {
  try {
    return { vars: railwayVariables({ quiet: true }), error: null };
  } catch (error) {
    return {
      vars: {},
      error: error?.detail || {
        message: String(error?.message || error),
      },
    };
  }
}

function includesRetryableRailwayError(value) {
  return /rate\s*limit|ratelimit|ratelimited|too many requests|econnreset|etimedout|timeout/i.test(String(value || ""));
}

function readCachedApprovalPreflight() {
  const cachePath = path.join(outputDir, "stripe-webhook-smoke-approval.json");
  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    const generatedAtMs = Date.parse(cached.generatedAt || "");
    const ageMs = Number.isFinite(generatedAtMs) ? Date.now() - generatedAtMs : Infinity;
    const maxAgeMinutes = Number(process.env.SMIRK_STRIPE_PREFLIGHT_CACHE_MAX_AGE_MINUTES || 60);
    const maxAgeMs = Math.max(1, maxAgeMinutes) * 60 * 1000;
    return {
      ok: cached?.readiness?.preflight?.ok === true && ageMs >= 0 && ageMs <= maxAgeMs,
      path: cachePath,
      generatedAt: cached.generatedAt || null,
      sourceCommit: cached.sourceCommit || null,
      ageMs: Number.isFinite(ageMs) ? ageMs : null,
      maxAgeMs,
      preflight: cached?.readiness?.preflight || null,
    };
  } catch (error) {
    return {
      ok: false,
      path: cachePath,
      error: String(error?.message || error),
    };
  }
}

function fail(message, detail = {}) {
  console.error(JSON.stringify({ ok: false, message, detail }, null, 2));
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeFetchError(error) {
  return {
    name: error?.name || null,
    message: String(error?.message || error || ""),
    code: error?.cause?.code || error?.code || null,
    cause: error?.cause?.constructor?.name || null,
  };
}

async function fetchText(pathname, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const url = String(pathname).startsWith("http") ? String(pathname) : `${appUrl}${pathname}`;
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithRetry(pathname, init = {}) {
  const attempts = Math.max(1, fetchAttempts);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchText(pathname, init);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(fetchRetryDelayMs);
      }
    }
  }
  const error = new Error("fetch-failed");
  error.detail = {
    appUrl,
    pathname,
    attempts,
    timeoutMs: fetchTimeoutMs,
    retryDelayMs: fetchRetryDelayMs,
    lastError: normalizeFetchError(lastError),
  };
  throw error;
}

function runCleanupDryRun() {
  try {
    const out = execFileSync("npm", ["run", "-s", "cleanup:smoke-workspaces"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, APP_URL: appUrl },
    }).trim();
    return JSON.parse(out);
  } catch (error) {
    const out = String(error?.stdout || error?.stderr || "").trim();
    try {
      return out ? JSON.parse(out) : { ok: false, error: "empty-cleanup-output" };
    } catch {
      return { ok: false, error: "invalid-cleanup-output", sample: out.slice(0, 500) };
    }
  }
}

const railwayResult = readRailwayVariablesResult();
const railwayVars = railwayResult.vars;
const cachedApprovalPreflight = readCachedApprovalPreflight();
const railwayErrorText = railwayResult.error ? JSON.stringify(railwayResult.error) : "";
const railwayErrorRetryable = includesRetryableRailwayError(railwayErrorText);
const localWebhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || readLocalEnvValue("STRIPE_WEBHOOK_SECRET") || "").trim();
const railwayWebhookSecret = String(railwayVars.STRIPE_WEBHOOK_SECRET || "").trim();
const webhookSecret = localWebhookSecret || railwayWebhookSecret;
const useCachedPreflight = preflightOnly
  && !webhookSecret
  && railwayResult.error != null
  && railwayErrorRetryable
  && cachedApprovalPreflight.ok === true
  && cachedApprovalPreflight.preflight?.webhookSecretConfigured === true;
const webhookSecretConfigured = Boolean(webhookSecret) || useCachedPreflight;
const autoFulfillRaw = String(process.env.AUTO_FULFILL_PROVISIONING_REQUESTS || readLocalEnvValue("AUTO_FULFILL_PROVISIONING_REQUESTS") || railwayVars.AUTO_FULFILL_PROVISIONING_REQUESTS || "").trim().toLowerCase();
const autoFulfill = autoFulfillRaw
  ? autoFulfillRaw === "true"
  : (useCachedPreflight ? cachedApprovalPreflight.preflight?.autoFulfillEnabled === true : false);
const autoFulfillSmokeAllowed = process.env.ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE === "1";

if (preflightOnly) {
  const output = {
    ok: webhookSecretConfigured,
    appUrl,
    preflight: true,
    railwayEnvReadable: railwayResult.error == null,
    railwayEnvError: railwayResult.error,
    railwayEnvRetryableError: railwayErrorRetryable,
    cachedApprovalPreflightUsed: useCachedPreflight,
    cachedApprovalPreflight: useCachedPreflight
      ? {
          path: cachedApprovalPreflight.path,
          generatedAt: cachedApprovalPreflight.generatedAt,
          sourceCommit: cachedApprovalPreflight.sourceCommit,
          ageMs: cachedApprovalPreflight.ageMs,
          maxAgeMs: cachedApprovalPreflight.maxAgeMs,
        }
      : null,
    webhookSecretConfigured,
    webhookSecretSource: webhookSecret ? (localWebhookSecret ? "local-env" : "railway-env") : (useCachedPreflight ? "cached-approval-preflight" : "missing"),
    autoFulfillEnabled: autoFulfill,
    autoFulfillSmokeAllowed,
    canRunSignatureOnly: Boolean(webhookSecret),
    canRunSignedSmoke: Boolean(webhookSecret) && (!autoFulfill || autoFulfillSmokeAllowed),
    wouldPostSignedWebhook: false,
    wouldCreateProductionSmokeWorkspace: autoFulfill && autoFulfillSmokeAllowed,
    approvalRequired: autoFulfill && !autoFulfillSmokeAllowed,
    requiredApprovalEnv: autoFulfill ? "ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1" : null,
  };
  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) process.exit(1);
  process.exit(0);
}

if (!webhookSecret) {
  fail("missing STRIPE_WEBHOOK_SECRET", {
    message: "Set STRIPE_WEBHOOK_SECRET in env or Railway variables before verifying signed Stripe webhooks.",
  });
}

if (signatureOnly) {
  const liveDeploy = readLiveDeploy();
  if (liveDeploy?.ok !== true) {
    fail("live deploy fingerprint is not current before signed webhook verification", {
      liveDeploy,
    });
  }

  const timestamp = Date.now();
  const eventId = `evt_test_signature_${timestamp}`;
  const payload = JSON.stringify({
    id: eventId,
    object: "event",
    api_version: "2025-10-29.clover",
    created: Math.floor(timestamp / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_test_signature_${timestamp}`,
        object: "checkout.session",
        mode: "subscription",
        status: "complete",
        payment_status: "paid",
        customer_email: "signature-smoke@example.com",
        metadata: {
          plan: "starter",
          source: "stripe-signature-only-smoke",
        },
      },
    },
  });
  const stripe = new Stripe("sk_test_unused_for_signature_generation");
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: webhookSecret,
  });

  let webhookRes;
  let webhookText;
  try {
    ({ res: webhookRes, text: webhookText } = await fetchTextWithRetry("/api/stripe/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      body: payload,
    }));
  } catch (error) {
    fail("stripe-webhook-fetch-failed", {
      message: "Signed Stripe webhook signature-only smoke could not reach the live webhook route.",
      detail: error?.detail || normalizeFetchError(error),
    });
  }
  let webhookBody;
  try {
    webhookBody = JSON.parse(webhookText);
  } catch {
    webhookBody = { raw: webhookText.slice(0, 500) };
  }

  if (webhookRes.status !== 200 || webhookBody?.verified !== true) {
    fail("signed Stripe webhook signature-only smoke did not return verified=true", {
      status: webhookRes.status,
      body: webhookBody,
    });
  }

  const output = {
    ok: true,
    appUrl,
    checkedAt: new Date().toISOString(),
    liveDeploy,
    signatureOnly: true,
    webhook: {
      event_id: eventId,
      verified: true,
    },
    mutationRisk: "none: evt_test_* is verified and returned before provisioning logic",
  };
  writeOutputArtifact("stripe-webhook-signature-live.json", output);
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

if (autoFulfill && !autoFulfillSmokeAllowed) {
  fail("refusing to run signed webhook smoke while auto-fulfillment is enabled", {
    message: "Set ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 only if creating a real smoke workspace is intended.",
  });
}

const liveDeploy = readLiveDeploy();
if (liveDeploy?.ok !== true) {
  fail("live deploy fingerprint is not current before signed webhook smoke", {
    liveDeploy,
  });
}

const timestamp = Date.now();
const eventId = `evt_smirk_paid_handoff_${timestamp}`;
const sessionId = `cs_test_smirk_paid_handoff_${timestamp}`;
const ownerEmail = `smoke+stripe-${timestamp}@example.com`;
const businessName = "SMIRK Stripe Webhook Smoke";

const payload = JSON.stringify({
  id: eventId,
  object: "event",
  api_version: "2025-10-29.clover",
  created: Math.floor(timestamp / 1000),
  livemode: false,
  pending_webhooks: 1,
  request: { id: null, idempotency_key: null },
  type: "checkout.session.completed",
  data: {
    object: {
      id: sessionId,
      object: "checkout.session",
      livemode: false,
      mode: "subscription",
      status: "complete",
      payment_status: "paid",
      customer: `cus_smirk_${timestamp}`,
      subscription: `sub_smirk_${timestamp}`,
      customer_email: ownerEmail,
      customer_details: {
        email: ownerEmail,
        name: businessName,
        phone: "+15555550123",
      },
      metadata: {
        plan: "starter",
        business_name: businessName,
        owner_email: ownerEmail,
        owner_phone: "+15555550123",
        source: "gate3-stripe-webhook-smoke",
      },
    },
  },
});

const stripe = new Stripe("sk_test_unused_for_signature_generation");
const signature = stripe.webhooks.generateTestHeaderString({
  payload,
  secret: webhookSecret,
});

let webhookRes;
let webhookText;
try {
  ({ res: webhookRes, text: webhookText } = await fetchTextWithRetry("/api/stripe/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signature,
    },
    body: payload,
  }));
} catch (error) {
  fail("stripe-webhook-fetch-failed", {
    message: "Signed Stripe webhook smoke could not reach the live webhook route.",
    detail: error?.detail || normalizeFetchError(error),
  });
}
let webhookBody;
try {
  webhookBody = JSON.parse(webhookText);
} catch {
  webhookBody = { raw: webhookText.slice(0, 500) };
}

if (webhookRes.status !== 200 || webhookBody?.received !== true) {
  fail("signed Stripe webhook did not return received=true", {
    status: webhookRes.status,
    body: webhookBody,
  });
}

let statusRes;
let statusText;
try {
  ({ res: statusRes, text: statusText } = await fetchTextWithRetry("/api/provisioning/checkout-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ownerEmail, checkout_session_id: sessionId }),
  }));
} catch (error) {
  fail("stripe-webhook-fetch-failed", {
    message: "Signed Stripe webhook smoke could not reach checkout-status after webhook receipt.",
    detail: error?.detail || normalizeFetchError(error),
  });
}
let statusBody;
try {
  statusBody = JSON.parse(statusText);
} catch {
  statusBody = { raw: statusText.slice(0, 500) };
}

if (statusRes.status !== 200 || statusBody?.ok !== true || statusBody?.found !== true) {
  fail("checkout-status did not find the signed webhook provisioning row", {
    status: statusRes.status,
    body: statusBody,
  });
}
if (statusBody.checkout_verified !== true) {
  fail("checkout-status did not bind the exact signed webhook Checkout Session", {
    checkout_verified: statusBody.checkout_verified,
  });
}
if (statusBody.payment_verified !== false) {
  fail("synthetic signed webhook smoke must never report verified live payment", {
    payment_verified: statusBody.payment_verified,
  });
}

const negativeLookups = [
  { label: "wrong-session", email: ownerEmail, checkout_session_id: `${sessionId}_wrong` },
  { label: "wrong-email", email: `wrong-${ownerEmail}`, checkout_session_id: sessionId },
];
for (const negative of negativeLookups) {
  const negativeResult = await fetchTextWithRetry("/api/provisioning/checkout-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: negative.email, checkout_session_id: negative.checkout_session_id }),
  });
  const negativeBody = JSON.parse(negativeResult.text);
  if (
    negativeResult.res.status !== 200
    || negativeBody?.found !== false
    || negativeBody?.checkout_verified !== false
    || negativeBody?.payment_verified !== false
  ) {
    fail(`checkout-status ${negative.label} lookup did not fail closed`, { body: negativeBody });
  }
}

const request = statusBody.request_summary || {};
const expectedStatus = autoFulfill ? ["workspace_created", "workspace_and_line_created", "manual_fallback_required"] : ["manual_fallback_required"];
if (!expectedStatus.includes(request.status)) {
  fail("signed webhook provisioning row did not match expected status", {
    expectedOwnerEmail: ownerEmail,
    expectedStatus,
    request,
  });
}
if (typeof request.status_label !== "string" || request.status_label.trim().length === 0) {
  fail("checkout-status did not return a public status label for signed webhook smoke", {
    request,
  });
}
if (typeof statusBody.next_step_label !== "string" || statusBody.next_step_label.trim().length === 0) {
  fail("checkout-status did not return a public next-step label for signed webhook smoke", {
    next_step: statusBody.next_step,
    next_step_label: statusBody.next_step_label,
  });
}
if (statusBody.checkout_reference_received !== true) {
  fail("checkout-status did not acknowledge the signed webhook checkout reference", {
    checkout_reference_received: statusBody.checkout_reference_received,
    body: statusBody,
  });
}
const checkoutSessionIdExposed = JSON.stringify(statusBody).includes(sessionId);
if (
  statusBody.request ||
  request.id ||
  request.request_id ||
  checkoutSessionIdExposed ||
  request.workspace_id ||
  request.invite_link ||
  statusBody.activation_status?.inviteLink ||
  statusBody.activation_status?.workspaceId ||
  statusBody.activation_status?.exceptionReason
) {
  fail("public checkout-status leaked raw provisioning or invite data", {
    hasRawRequest: Boolean(statusBody.request),
    request,
    activationStatus: statusBody.activation_status,
    checkout_session_id_exposed: checkoutSessionIdExposed,
  });
}
const activationStatus = statusBody.activation_status || null;
if (!activationStatus || typeof activationStatus !== "object") {
  fail("checkout-status did not return activation_status for signed webhook smoke", {
    body: statusBody,
  });
}
const expectedStages = autoFulfill
  ? ["setup_required", "operator_exception", "proof_ready"]
  : ["operator_exception"];
if (!expectedStages.includes(activationStatus.stage)) {
  fail("activation_status stage did not match the signed webhook fulfillment state", {
    expectedStages,
    activationStatus,
    request,
  });
}
const cleanupDryRun = runCleanupDryRun();
if (cleanupDryRun?.ok !== true) {
  fail("smoke cleanup dry-run failed after signed webhook smoke", {
    cleanupDryRun,
  });
}
const cleanupResult = cleanupDryRun.result || {};
const cleanupProvisioningIds = Array.isArray(cleanupResult.provisioning_request_ids)
  ? cleanupResult.provisioning_request_ids.map(String)
  : [];
const matchedProvisioningRequests = Number(cleanupResult.matched_provisioning_requests || 0);
if (matchedProvisioningRequests < 1) {
  fail("smoke cleanup dry-run did not see the signed webhook provisioning row", {
    matchedProvisioningRequests,
    cleanupProvisioningIds,
    cleanupDryRun,
  });
}

const output = {
  ok: true,
  appUrl,
  checkedAt: new Date().toISOString(),
  liveDeploy,
  webhook: {
    event_id: eventId,
    session_id: sessionId,
    owner_email: ownerEmail,
    received: true,
  },
  checkoutStatus: {
    found: statusBody.found,
    next_step: statusBody.next_step,
    next_step_label: statusBody.next_step_label,
    request_id_exposed: Boolean(request.id),
    stripe_event_id_exposed: Boolean(request.request_id),
    checkout_reference_received: statusBody.checkout_reference_received,
    checkout_session_id_exposed: checkoutSessionIdExposed,
    request_status: request.status,
    request_status_label: request.status_label,
    workspace_id_exposed: Boolean(request.workspace_id || activationStatus.workspaceId),
    activation_stage: activationStatus.stage,
    activation_ready_for_proof_call: Boolean(activationStatus.readyForProofCall),
  },
  cleanupDryRun: {
    matched_workspaces: Number(cleanupResult.matched_workspaces || 0),
    matched_provisioning_requests: matchedProvisioningRequests,
    provisioning_request_visible: matchedProvisioningRequests > 0,
  },
};
writeOutputArtifact("stripe-webhook-handoff-live.json", output);
console.log(JSON.stringify(output, null, 2));
