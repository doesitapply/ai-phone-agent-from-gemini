#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const appUrl = String(process.env.APP_URL || "https://smirkcalls.com").replace(/\/$/, "");
const writeConfirmation = String(process.env.CONFIRM_SMIRK_PAID_HANDOFF_LIVE_WRITE || "").trim();
const requiredWriteConfirmation = "create-live-smirk-paid-handoff-smoke";
const fetchTimeoutMs = Number(process.env.SMIRK_PAID_HANDOFF_FETCH_TIMEOUT_MS || 15000);
const fetchAttempts = Number(process.env.SMIRK_PAID_HANDOFF_FETCH_ATTEMPTS || 2);
const fetchRetryDelayMs = Number(process.env.SMIRK_PAID_HANDOFF_FETCH_RETRY_DELAY_MS || 750);
const outputDir = path.resolve("output");

if (writeConfirmation !== requiredWriteConfirmation) {
  console.error(JSON.stringify({
    ok: false,
    error: "missing-live-write-confirmation",
    message: "This check creates a live SMIRK Smoke Test provisioning request to prove paid signup reaches a tracked manual fallback.",
    requiredEnv: "CONFIRM_SMIRK_PAID_HANDOFF_LIVE_WRITE",
    requiredValue: requiredWriteConfirmation,
    nextAction: `Run only after explicit approval: CONFIRM_SMIRK_PAID_HANDOFF_LIVE_WRITE=${requiredWriteConfirmation} npm run check:paid-handoff-live`,
    cleanupDryRunCommand: "npm run cleanup:smoke-workspaces",
    cleanupApplyCommand: "CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply",
    cleanupApprovalRequired: "Do not apply confirmed smoke cleanup without separate explicit cleanup approval after reviewing the dry-run.",
  }, null, 2));
  process.exit(1);
}

function fail(message, detail) {
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

async function fetchText(path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const res = await fetch(`${appUrl}${path}`, {
      ...init,
      signal: controller.signal,
    });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithRetry(path, init = {}) {
  const attempts = Math.max(1, fetchAttempts);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchText(path, init);
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
    path,
    attempts,
    timeoutMs: fetchTimeoutMs,
    retryDelayMs: fetchRetryDelayMs,
    lastError: normalizeFetchError(lastError),
  };
  throw error;
}

async function request(path, init = {}) {
  let res;
  let text;
  try {
    ({ res, text } = await fetchTextWithRetry(path, init));
  } catch (error) {
    fail("paid-handoff-fetch-failed", {
      message: "Paid activation handoff smoke could not reach a required live route.",
      detail: error?.detail || normalizeFetchError(error),
    });
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { res, body };
}

function assert(condition, message, detail) {
  if (!condition) fail(message, detail);
}

function cacheProtected(response) {
  return String(response.headers.get("cache-control") || "").toLowerCase().includes("no-store");
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

const liveDeploy = readLiveDeploy();
if (liveDeploy?.ok !== true) {
  fail("live deploy fingerprint is not current before paid handoff smoke", {
    liveDeploy,
  });
}

const pricing = await request("/api/pricing");
assert(pricing.res.status === 200, "pricing route did not return 200", {
  status: pricing.res.status,
  body: pricing.body,
});

const plans = Array.isArray(pricing.body?.plans) ? pricing.body.plans : [];
const CORE_SMOKE_PLANS = Object.freeze([
  { id: "starter", price: 197 },
  { id: "pro", price: 397 },
]);
const selectedSmokePlan = CORE_SMOKE_PLANS
  .map((expected) => ({ expected, plan: plans.find((plan) => plan?.id === expected.id) }))
  .find(({ expected, plan }) => (
    plan?.price === expected.price &&
    plan?.checkout_available === true &&
    !Object.prototype.hasOwnProperty.call(plan, "checkout_url")
  ));
assert(
  Boolean(selectedSmokePlan),
  "neither canonical Starter nor Pro is available for the paid handoff smoke",
  { plans }
);
const smokeBuyer = {
  business_name: "SMIRK Smoke Test",
  owner_email: "smoke+buyer@example.com",
  phone: "+15555550123",
  plan: selectedSmokePlan.expected.id,
};

const checkout = await request("/api/checkout/create", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ...smokeBuyer,
    source: "gate3-paid-handoff-smoke",
  }),
});
assert(checkout.res.status === 200, "checkout create did not return 200", {
  status: checkout.res.status,
  body: checkout.body,
});
assert(cacheProtected(checkout.res), "checkout create response is missing Cache-Control: no-store", {
  cache_control: checkout.res.headers.get("cache-control") || null,
});
assert(checkout.body?.ok === true, "checkout create did not return ok=true", checkout.body);
assert(
  /^https:\/\/(checkout|buy)\.stripe\.com\//.test(String(checkout.body?.checkout_url || "")),
  "checkout create did not return a Stripe checkout URL",
  checkout.body
);
const smokeCheckoutSessionId = /^cs_(test|live)_[A-Za-z0-9_]{8,240}$/.test(String(checkout.body?.id || ""))
  ? String(checkout.body.id)
  : "cs_test_smirkPaidHandoffSmoke12345678";

const activation = await request("/api/provisioning/request", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ...smokeBuyer,
    source: "buyer-auth-smoke",
  }),
});
assert(activation.res.status === 202, "activation request did not return 202", {
  status: activation.res.status,
  body: activation.body,
});
assert(cacheProtected(activation.res), "activation request response is missing Cache-Control: no-store", {
  cache_control: activation.res.headers.get("cache-control") || null,
});
assert(activation.body?.ok === true, "activation request did not return ok=true", activation.body);
assert(
  activation.body?.status === "manual_fallback_required" &&
    activation.body?.fallback_status === "manual_fallback_required" &&
    activation.body?.provisioning_request_id,
  "activation request did not create a tracked manual fallback",
  activation.body
);

const wrongCheckoutStatus = await request("/api/provisioning/checkout-status", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: smokeBuyer.owner_email, checkout_session_id: smokeCheckoutSessionId }),
});
assert(wrongCheckoutStatus.res.status === 200, "wrong checkout reference status did not return 200", wrongCheckoutStatus.body);
assert(
  wrongCheckoutStatus.body?.found === false &&
    wrongCheckoutStatus.body?.checkout_reference_received === true &&
    wrongCheckoutStatus.body?.checkout_verified === false &&
    wrongCheckoutStatus.body?.payment_verified === false,
  "checkout status must not fall back to an unrelated email-only request when a session reference is supplied",
  wrongCheckoutStatus.body
);

const status = await request("/api/provisioning/checkout-status", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: smokeBuyer.owner_email }),
});
assert(status.res.status === 200, "checkout status did not return 200", {
  status: status.res.status,
  body: status.body,
});
assert(cacheProtected(status.res), "checkout status response is missing Cache-Control: no-store", {
  cache_control: status.res.headers.get("cache-control") || null,
});
assert(status.body?.ok === true && status.body?.found === false, "email-only checkout status must stay non-enumerating", status.body);
assert(
  !status.body?.request &&
    !status.body?.request_summary &&
    !status.body?.activation_status &&
    status.body?.status === "secure_reference_required" &&
    status.body?.status_label === "Secure checkout reference required",
  "email-only checkout status exposed buyer activation detail",
  {
    activation: activation.body,
    checkoutStatus: status.body,
  }
);
assert(
  status.body?.checkout_reference_received === false &&
    status.body?.checkout_verified === false &&
    status.body?.payment_received === false &&
    status.body?.payment_verified === false &&
    status.body?.access_active === false,
  "email-only activation lookup must not claim checkout or payment verification",
  status.body
);

const publicLeakChecks = {
  raw_request_exposed: Boolean(status.body?.request),
  request_id_exposed: Boolean(status.body?.request_summary?.id),
  stripe_event_id_exposed: Boolean(status.body?.request_summary?.request_id),
  checkout_session_id_exposed: JSON.stringify(status.body).includes(smokeCheckoutSessionId),
  workspace_id_exposed: Boolean(
    status.body?.request_summary?.workspace_id ||
      status.body?.activation_status?.workspaceId
  ),
  invite_link_exposed: Boolean(
    status.body?.request_summary?.invite_link ||
      status.body?.activation_status?.inviteLink
  ),
  exception_reason_exposed: Boolean(status.body?.activation_status?.exceptionReason),
};

assert(
  Object.values(publicLeakChecks).every((leaked) => leaked === false),
  "checkout status leaked internal activation data on the public buyer lookup",
  publicLeakChecks
);

const output = {
  ok: true,
  appUrl,
  checkedAt: new Date().toISOString(),
  liveDeploy,
  checkout: {
    source: checkout.body.source || null,
    id: checkout.body.id || null,
    hasCheckoutUrl: true,
    cache_protected: cacheProtected(checkout.res),
  },
  activation: {
    provisioning_request_id: activation.body.provisioning_request_id,
    status: activation.body.status,
    fallback_status: activation.body.fallback_status,
  },
  checkoutStatus: {
    found: status.body.found,
    status: status.body.status,
    detailed_status_withheld_without_checkout_reference: !status.body.request_summary && !status.body.activation_status,
    checkout_reference_received: status.body.checkout_reference_received,
    cache_protected: cacheProtected(status.res),
    public_leak_checks: publicLeakChecks,
  },
};
writeOutputArtifact("paid-handoff-live.json", output);
console.log(JSON.stringify(output, null, 2));
