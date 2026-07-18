import { createHash } from "node:crypto";

export const FIRST_DOLLAR_PENDING_ENV_SCHEMA_VERSION = 1;

export const SMIRK_RAILWAY_PRODUCTION_TARGET = Object.freeze({
  projectId: "90599f03-6d6f-4044-8933-e0301be67a82",
  projectName: "ai-phone-agent",
  serviceId: "96bcd6e7-9487-4197-bcd1-a6bd0546e6b2",
  serviceName: "ai-phone-agent",
  environmentId: "22e0a5a3-43bf-4b6c-8fa6-635e7c94b84a",
  environmentName: "production",
});

export const FIRST_DOLLAR_PENDING_ENV_SENTINELS = Object.freeze({
  digest: "SMIRK_PENDING_FIRST_DOLLAR_ENV_DIGEST",
  keyList: "SMIRK_PENDING_FIRST_DOLLAR_ENV_KEYS",
  commit: "SMIRK_PENDING_FIRST_DOLLAR_ENV_COMMIT",
  schema: "SMIRK_PENDING_FIRST_DOLLAR_ENV_SCHEMA",
});

export const FIRST_DOLLAR_ACTIVATED_ENV_RECEIPT = "SMIRK_ACTIVATED_FIRST_DOLLAR_ENV_DIGEST";

export const FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS = Object.freeze({
  deploy: Object.freeze({
    env: "CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY",
    value: "deploy-post-call-fix",
  }),
  deployCommit: Object.freeze({
    env: "CONFIRM_SMIRK_DEPLOY_COMMIT",
  }),
  pendingDigest: Object.freeze({
    env: "CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST",
  }),
  activationDeploy: Object.freeze({
    env: "CONFIRM_SMIRK_FIRST_DOLLAR_ACTIVATION_DEPLOY",
    value: "activate-reviewed-first-dollar-pending-env",
  }),
  realStarterCheckout: Object.freeze({
    env: "CONFIRM_SMIRK_REAL_STARTER_CHECKOUT",
    value: "accept-buyer-initiated-starter-197-monthly",
  }),
});

const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/;

const FIXED_KEYS_BEFORE_TTS = Object.freeze([
  "APP_URL",
  "STRIPE_REVENUE_READ_KEY",
  "STRIPE_BILLING_PORTAL_KEY",
  "STRIPE_BILLING_PORTAL_CONFIGURATION_ID",
  "SMIRK_NATIVE_CHECKOUT_ENABLED",
  "PHONE_AGENT_PROVISIONING_SECRET",
  "AUTO_FULFILL_PROVISIONING_REQUESTS",
  "SMIRK_CUSTOMER_POLICY_APPROVED_VERSION",
  "RESEND_API_KEY",
  "FROM_EMAIL",
  "NOTIFICATION_EMAIL",
  "OWNER_ALERT_EMAIL",
  "OWNER_EMAIL",
  "OPERATOR_EMAIL",
  "BOOKING_LINK",
  "GOOGLE_OAUTH_CLIENT_ID",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "WORKSPACE_SECRET_ENCRYPTION_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_ENABLED",
  "FAST_LIVE_CALLS",
]);

const STREAMING_TTS_KEYS = new Set([
  "CARTESIA_API_KEY",
  "ELEVENLABS_API_KEY",
  "GOOGLE_TTS_API_KEY",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "OPENAI_API_KEY",
]);

const FIXED_KEYS_AFTER_TTS = Object.freeze([
  "STRIPE_PAYMENT_LINK_STARTER",
  "STRIPE_PAYMENT_LINK_STARTER_ID",
  "STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS",
  "STRIPE_PAYMENT_LINK_PRO",
  "STRIPE_PAYMENT_LINK_PRO_ID",
  "STRIPE_PAYMENT_LINK_ENTERPRISE",
  "STRIPE_PAYMENT_LINK_ENTERPRISE_ID",
]);

function expectedAssignmentKeysForTts(ttsKey, includeLandingAppUrl) {
  const keys = [...FIXED_KEYS_BEFORE_TTS, ttsKey, ...FIXED_KEYS_AFTER_TTS];
  if (ttsKey === "ELEVENLABS_API_KEY") keys.push("ELEVENLABS_ENABLED");
  if (ttsKey === "GOOGLE_TTS_API_KEY" || ttsKey === "GOOGLE_SERVICE_ACCOUNT_JSON") keys.push("GOOGLE_TTS_ENABLED");
  if (includeLandingAppUrl) keys.push("LANDING_APP_URL");
  return keys;
}

export function validateFirstDollarPendingAssignmentKeys(keys) {
  const normalized = Array.isArray(keys) ? keys.map((key) => String(key || "").trim()) : [];
  const failures = [];
  if (normalized.length === 0) failures.push("pending-env-assignment-keys-missing");
  if (normalized.some((key) => !ENV_KEY_PATTERN.test(key))) failures.push("pending-env-assignment-key-invalid");
  if (new Set(normalized).size !== normalized.length) failures.push("pending-env-assignment-key-duplicate");
  const ttsKey = normalized[FIXED_KEYS_BEFORE_TTS.length] || "";
  if (!STREAMING_TTS_KEYS.has(ttsKey)) failures.push("pending-env-streaming-tts-key-invalid");
  const includeLandingAppUrl = normalized.at(-1) === "LANDING_APP_URL";
  const expected = STREAMING_TTS_KEYS.has(ttsKey)
    ? expectedAssignmentKeysForTts(ttsKey, includeLandingAppUrl)
    : [];
  if (expected.length !== normalized.length || expected.some((key, index) => normalized[index] !== key)) {
    failures.push("pending-env-assignment-key-order-mismatch");
  }
  for (const sentinelKey of Object.values(FIRST_DOLLAR_PENDING_ENV_SENTINELS)) {
    if (normalized.includes(sentinelKey)) failures.push("pending-env-sentinel-recursion-forbidden");
  }
  if (normalized.includes(FIRST_DOLLAR_ACTIVATED_ENV_RECEIPT)) failures.push("pending-env-activation-receipt-recursion-forbidden");
  return { ok: failures.length === 0, keys: normalized, ttsKey: ttsKey || null, failures };
}

function normalizeAssignments(assignments) {
  if (!Array.isArray(assignments)) throw new Error("pending env assignments must be an array");
  return assignments.map((assignment) => {
    const key = String(assignment?.key || "").trim();
    const value = typeof assignment?.value === "string" ? assignment.value : String(assignment?.value ?? "");
    return { key, value };
  });
}

function validateTarget(target) {
  return Object.entries(SMIRK_RAILWAY_PRODUCTION_TARGET).every(([key, value]) => String(target?.[key] || "") === value);
}

export function computeFirstDollarPendingEnvManifest({ target, commit, assignments }) {
  const normalizedCommit = String(commit || "").trim();
  if (!validateTarget(target)) throw new Error("pending env target must be the exact SMIRK Railway production target");
  if (!COMMIT_PATTERN.test(normalizedCommit)) throw new Error("pending env commit must be an exact 40-character Git commit");
  const normalizedAssignments = normalizeAssignments(assignments);
  const keyEvaluation = validateFirstDollarPendingAssignmentKeys(normalizedAssignments.map(({ key }) => key));
  if (!keyEvaluation.ok) throw new Error(`pending env assignment keys invalid: ${keyEvaluation.failures.join(",")}`);
  const canonical = JSON.stringify({
    schemaVersion: FIRST_DOLLAR_PENDING_ENV_SCHEMA_VERSION,
    target: {
      projectId: target.projectId,
      serviceId: target.serviceId,
      environmentId: target.environmentId,
    },
    commit: normalizedCommit.toLowerCase(),
    assignments: normalizedAssignments,
  });
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return {
    schemaVersion: FIRST_DOLLAR_PENDING_ENV_SCHEMA_VERSION,
    digest,
    commit: normalizedCommit.toLowerCase(),
    keyList: keyEvaluation.keys.join(","),
    keys: keyEvaluation.keys,
    assignmentCount: normalizedAssignments.length,
    target: SMIRK_RAILWAY_PRODUCTION_TARGET,
  };
}

export function assignmentsFromNullDelimitedBuffer(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  const tokens = bytes.toString("utf8").split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  return tokens.map((token) => {
    const separator = token.indexOf("=");
    if (separator <= 0) throw new Error("pending env assignment must use KEY=value format");
    return { key: token.slice(0, separator), value: token.slice(separator + 1) };
  });
}

export function pendingEnvSentinelState(vars = {}) {
  const values = Object.fromEntries(Object.entries(FIRST_DOLLAR_PENDING_ENV_SENTINELS).map(([name, key]) => (
    [name, String(vars?.[key] ?? "").trim()]
  )));
  const presentCount = Object.values(values).filter(Boolean).length;
  return {
    pending: presentCount > 0,
    complete: presentCount === Object.keys(FIRST_DOLLAR_PENDING_ENV_SENTINELS).length,
    values,
    activatedDigest: String(vars?.[FIRST_DOLLAR_ACTIVATED_ENV_RECEIPT] ?? "").trim(),
  };
}

export function evaluateFirstDollarPendingEnvActivation({ vars, currentCommit, confirmations = {}, requireConfirmations = true }) {
  const sentinelState = pendingEnvSentinelState(vars);
  if (!sentinelState.pending) {
    return { ok: true, pending: false, activated: false, activationAuthorized: false, failures: [], manifest: null };
  }

  const failures = [];
  if (!sentinelState.complete) failures.push("pending-env-sentinels-incomplete");
  const digest = sentinelState.values.digest;
  const commit = sentinelState.values.commit.toLowerCase();
  const schema = sentinelState.values.schema;
  const keys = sentinelState.values.keyList.split(",").map((key) => key.trim()).filter(Boolean);
  if (!DIGEST_PATTERN.test(digest)) failures.push("pending-env-digest-invalid");
  if (!COMMIT_PATTERN.test(commit)) failures.push("pending-env-commit-invalid");
  if (schema !== String(FIRST_DOLLAR_PENDING_ENV_SCHEMA_VERSION)) failures.push("pending-env-schema-invalid");
  if (sentinelState.activatedDigest && !DIGEST_PATTERN.test(sentinelState.activatedDigest)) {
    failures.push("pending-env-activation-receipt-invalid");
  }

  const keyEvaluation = validateFirstDollarPendingAssignmentKeys(keys);
  if (!keyEvaluation.ok) failures.push(...keyEvaluation.failures);

  let manifest = null;
  if (failures.length === 0) {
    try {
      manifest = computeFirstDollarPendingEnvManifest({
        target: SMIRK_RAILWAY_PRODUCTION_TARGET,
        commit,
        assignments: keys.map((key) => ({ key, value: String(vars?.[key] ?? "") })),
      });
      if (manifest.digest !== digest) failures.push("pending-env-digest-mismatch");
      if (manifest.keyList !== sentinelState.values.keyList) failures.push("pending-env-key-list-mismatch");
    } catch {
      failures.push("pending-env-manifest-recompute-failed");
    }
  }

  const activated = failures.length === 0
    && Boolean(sentinelState.activatedDigest)
    && sentinelState.activatedDigest === digest;
  if (activated) {
    return {
      ok: true,
      pending: false,
      activated: true,
      activationAuthorized: false,
      failures: [],
      manifest: manifest ? {
        digest: manifest.digest,
        commit: manifest.commit,
        keyList: manifest.keyList,
        assignmentCount: manifest.assignmentCount,
        target: manifest.target,
      } : null,
    };
  }

  const normalizedCurrentCommit = String(currentCommit || "").trim().toLowerCase();
  if (normalizedCurrentCommit !== commit) failures.push("pending-env-current-commit-mismatch");
  if (requireConfirmations) {
    if (String(confirmations.deploy || "").trim() !== FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.deploy.value) {
      failures.push("pending-env-existing-deploy-authority-missing");
    }
    if (String(confirmations.deployCommit || "").trim().toLowerCase() !== commit) {
      failures.push("pending-env-exact-deploy-commit-confirmation-missing");
    }
    if (String(confirmations.pendingDigest || "").trim() !== digest) {
      failures.push("pending-env-exact-digest-confirmation-missing");
    }
    if (String(confirmations.activationDeploy || "").trim() !== FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.activationDeploy.value) {
      failures.push("pending-env-activation-deploy-confirmation-missing");
    }
    if (String(confirmations.realStarterCheckout || "").trim() !== FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.realStarterCheckout.value) {
      failures.push("pending-env-real-starter-checkout-confirmation-missing");
    }
  }

  return {
    ok: failures.length === 0,
    pending: true,
    activated: false,
    activationAuthorized: failures.length === 0 && requireConfirmations,
    failures: [...new Set(failures)],
    manifest: manifest ? {
      digest: manifest.digest,
      commit: manifest.commit,
      keyList: manifest.keyList,
      assignmentCount: manifest.assignmentCount,
      target: manifest.target,
    } : null,
  };
}

export function exactRailwayProductionTargetMatches(context) {
  const expected = SMIRK_RAILWAY_PRODUCTION_TARGET;
  const actual = {
    projectId: String(context?.project?.id || ""),
    projectName: String(context?.project?.name || ""),
    serviceId: String(context?.service?.id || ""),
    serviceName: String(context?.service?.name || ""),
    environmentId: String(context?.environment?.id || ""),
    environmentName: String(context?.environment?.name || ""),
  };
  return {
    ok: Object.entries(expected).every(([key, value]) => actual[key] === value),
    expected,
    actual,
  };
}
