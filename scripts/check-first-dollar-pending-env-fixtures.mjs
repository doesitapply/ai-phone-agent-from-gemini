#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  FIRST_DOLLAR_ACTIVATED_ENV_RECEIPT,
  FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS,
  FIRST_DOLLAR_PENDING_ENV_SENTINELS,
  SMIRK_RAILWAY_PRODUCTION_TARGET,
  computeFirstDollarPendingEnvManifest,
  evaluateFirstDollarPendingEnvActivation,
  exactRailwayProductionTargetMatches,
} from "./lib/first-dollar-pending-env.mjs";
import {
  deploymentMatchesPendingActivation,
  pendingActivationUploadMessage,
} from "./lib/pending-env-deployment-binding.mjs";

const commit = "1".repeat(40);
const otherCommit = "2".repeat(40);
const assignments = [
  ["APP_URL", "https://ai-phone-agent-production-6811.up.railway.app"],
  ["STRIPE_REVENUE_READ_KEY", "rk_live_fixture_revenue_secret"],
  ["STRIPE_BILLING_PORTAL_KEY", "rk_live_fixture_portal_secret"],
  ["STRIPE_BILLING_PORTAL_CONFIGURATION_ID", "bpc_fixture"],
  ["SMIRK_NATIVE_CHECKOUT_ENABLED", "false"],
  ["PHONE_AGENT_PROVISIONING_SECRET", "fixture-provisioning-secret-that-is-private"],
  ["AUTO_FULFILL_PROVISIONING_REQUESTS", "true"],
  ["SMIRK_CUSTOMER_POLICY_APPROVED_VERSION", "fixture-policy-v1"],
  ["RESEND_API_KEY", "re_fixture_private"],
  ["FROM_EMAIL", "SMIRK <alerts@smirkcalls.com>"],
  ["NOTIFICATION_EMAIL", "operator@smirkcalls.com"],
  ["OWNER_ALERT_EMAIL", "operator@smirkcalls.com"],
  ["OWNER_EMAIL", "operator@smirkcalls.com"],
  ["OPERATOR_EMAIL", "operator@smirkcalls.com"],
  ["BOOKING_LINK", "https://calendly.com/smirkcalls/setup"],
  ["GOOGLE_OAUTH_CLIENT_ID", "fixture.apps.googleusercontent.com"],
  ["TWILIO_ACCOUNT_SID", "ACfixture"],
  ["TWILIO_AUTH_TOKEN", "fixture-twilio-private"],
  ["WORKSPACE_SECRET_ENCRYPTION_KEY", "fixture-encryption-private"],
  ["OPENROUTER_API_KEY", "sk-or-v1-fixture-private"],
  ["OPENROUTER_ENABLED", "true"],
  ["FAST_LIVE_CALLS", "false"],
  ["CARTESIA_API_KEY", "fixture-cartesia-private"],
  ["STRIPE_PAYMENT_LINK_STARTER", "https://buy.stripe.com/starter_fixture"],
  ["STRIPE_PAYMENT_LINK_STARTER_ID", "plink_starter_fixture"],
  ["STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS", "plink_starter_fixture"],
  ["STRIPE_PAYMENT_LINK_PRO", ""],
  ["STRIPE_PAYMENT_LINK_PRO_ID", ""],
  ["STRIPE_PAYMENT_LINK_ENTERPRISE", ""],
  ["STRIPE_PAYMENT_LINK_ENTERPRISE_ID", ""],
  ["LANDING_APP_URL", "https://smirkcalls.com"],
].map(([key, value]) => ({ key, value }));

const manifest = computeFirstDollarPendingEnvManifest({
  target: SMIRK_RAILWAY_PRODUCTION_TARGET,
  commit,
  assignments,
});
assert.match(manifest.digest, /^[a-f0-9]{64}$/, "manifest must use SHA-256");
assert.equal(manifest.commit, commit, "manifest must bind exact HEAD");
assert.equal(manifest.assignmentCount, assignments.length, "manifest must bind every assignment");
assert.equal(manifest.keyList, assignments.map(({ key }) => key).join(","), "manifest must preserve exact assignment order");
assert.deepEqual(
  computeFirstDollarPendingEnvManifest({ target: SMIRK_RAILWAY_PRODUCTION_TARGET, commit, assignments }),
  manifest,
  "identical target, commit, order, keys, and unmasked values must produce an identical manifest",
);

const changedValueManifest = computeFirstDollarPendingEnvManifest({
  target: SMIRK_RAILWAY_PRODUCTION_TARGET,
  commit,
  assignments: assignments.map((entry) => entry.key === "RESEND_API_KEY" ? { ...entry, value: `${entry.value}-drift` } : entry),
});
assert.notEqual(changedValueManifest.digest, manifest.digest, "a secret-value drift must change the digest");
const changedCommitManifest = computeFirstDollarPendingEnvManifest({
  target: SMIRK_RAILWAY_PRODUCTION_TARGET,
  commit: otherCommit,
  assignments,
});
assert.notEqual(changedCommitManifest.digest, manifest.digest, "a commit drift must change the digest");
assert.throws(
  () => computeFirstDollarPendingEnvManifest({
    target: { ...SMIRK_RAILWAY_PRODUCTION_TARGET, environmentId: "wrong-environment" },
    commit,
    assignments,
  }),
  /exact SMIRK Railway production target/,
  "a target drift must fail instead of producing an approved digest",
);
assert.throws(
  () => computeFirstDollarPendingEnvManifest({
    target: SMIRK_RAILWAY_PRODUCTION_TARGET,
    commit,
    assignments: [assignments[1], assignments[0], ...assignments.slice(2)],
  }),
  /assignment keys invalid/,
  "an assignment-order drift must fail closed",
);

const cliInput = Buffer.from(`${assignments.map(({ key, value }) => `${key}=${value}`).join("\0")}\0`, "utf8");
const cli = spawnSync(process.execPath, ["scripts/compute-first-dollar-pending-env-manifest.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SMIRK_PENDING_TARGET_PROJECT_ID: SMIRK_RAILWAY_PRODUCTION_TARGET.projectId,
    SMIRK_PENDING_TARGET_SERVICE_ID: SMIRK_RAILWAY_PRODUCTION_TARGET.serviceId,
    SMIRK_PENDING_TARGET_ENVIRONMENT_ID: SMIRK_RAILWAY_PRODUCTION_TARGET.environmentId,
    SMIRK_PENDING_TARGET_COMMIT: commit,
  },
  input: cliInput,
  encoding: "utf8",
});
assert.equal(cli.status, 0, `manifest CLI must accept the exact NUL-delimited assignment set: ${cli.stderr}`);
assert.match(cli.stdout, new RegExp(`digest=${manifest.digest}`), "manifest CLI must print the exact digest");
for (const privateValue of [
  "rk_live_fixture_revenue_secret",
  "rk_live_fixture_portal_secret",
  "fixture-provisioning-secret-that-is-private",
  "re_fixture_private",
  "fixture-twilio-private",
  "fixture-encryption-private",
  "sk-or-v1-fixture-private",
  "fixture-cartesia-private",
]) {
  assert.doesNotMatch(cli.stdout, new RegExp(privateValue), "manifest CLI must not print secret values");
}

const vars = {
  ...Object.fromEntries(assignments.map(({ key, value }) => [key, value])),
  [FIRST_DOLLAR_PENDING_ENV_SENTINELS.digest]: manifest.digest,
  [FIRST_DOLLAR_PENDING_ENV_SENTINELS.keyList]: manifest.keyList,
  [FIRST_DOLLAR_PENDING_ENV_SENTINELS.commit]: manifest.commit,
  [FIRST_DOLLAR_PENDING_ENV_SENTINELS.schema]: String(manifest.schemaVersion),
};
const confirmations = {
  deploy: FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.deploy.value,
  deployCommit: commit,
  pendingDigest: manifest.digest,
  activationDeploy: FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.activationDeploy.value,
  realStarterCheckout: FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.realStarterCheckout.value,
};

assert.deepEqual(
  evaluateFirstDollarPendingEnvActivation({ vars: {}, currentCommit: otherCommit }),
  { ok: true, pending: false, activated: false, activationAuthorized: false, failures: [], manifest: null },
  "ordinary deploys must remain possible when no pending first-dollar manifest exists",
);
const inspectEvaluation = evaluateFirstDollarPendingEnvActivation({
  vars,
  currentCommit: commit,
  requireConfirmations: false,
});
assert.equal(inspectEvaluation.ok, true, "inspection must recompute a structurally valid pending manifest without activating it");
assert.equal(inspectEvaluation.activationAuthorized, false, "structural inspection must never claim activation authority");
const authorized = evaluateFirstDollarPendingEnvActivation({ vars, currentCommit: commit, confirmations });
assert.equal(authorized.ok, true, `all five activation boundaries must authorize the exact manifest: ${authorized.failures.join(",")}`);

const activatedVars = { ...vars, [FIRST_DOLLAR_ACTIVATED_ENV_RECEIPT]: manifest.digest };
const alreadyActivated = evaluateFirstDollarPendingEnvActivation({
  vars: activatedVars,
  currentCommit: otherCommit,
});
assert.equal(alreadyActivated.ok, true, "an exact activation receipt must permit later ordinary commits");
assert.equal(alreadyActivated.pending, false, "an exact receipt must mark only the identical recomputed manifest activated");
assert.equal(alreadyActivated.activated, true, "an exact receipt must disclose activated state");
const activatedValueDrift = evaluateFirstDollarPendingEnvActivation({
  vars: { ...activatedVars, RESEND_API_KEY: "re_drifted_after_activation" },
  currentCommit: otherCommit,
  requireConfirmations: false,
});
assert.equal(activatedValueDrift.ok, false, "a receipt must not hide assignment drift after activation");
assert.equal(activatedValueDrift.pending, true, "drifted values must become pending again");

for (const [field, failure] of [
  ["deploy", "pending-env-existing-deploy-authority-missing"],
  ["deployCommit", "pending-env-exact-deploy-commit-confirmation-missing"],
  ["pendingDigest", "pending-env-exact-digest-confirmation-missing"],
  ["activationDeploy", "pending-env-activation-deploy-confirmation-missing"],
  ["realStarterCheckout", "pending-env-real-starter-checkout-confirmation-missing"],
]) {
  const evaluation = evaluateFirstDollarPendingEnvActivation({
    vars,
    currentCommit: commit,
    confirmations: { ...confirmations, [field]: "wrong" },
  });
  assert.equal(evaluation.ok, false, `${field} drift must fail closed`);
  assert.ok(evaluation.failures.includes(failure), `${field} drift must report ${failure}`);
}

const valueDrift = evaluateFirstDollarPendingEnvActivation({
  vars: { ...vars, RESEND_API_KEY: "re_drifted_after_stage" },
  currentCommit: commit,
  confirmations,
});
assert.equal(valueDrift.ok, false, "staged assignment drift must fail closed");
assert.ok(valueDrift.failures.includes("pending-env-digest-mismatch"), "staged assignment drift must report digest mismatch");
const commitDrift = evaluateFirstDollarPendingEnvActivation({ vars, currentCommit: otherCommit, confirmations });
assert.equal(commitDrift.ok, false, "current HEAD drift must fail closed");
assert.ok(commitDrift.failures.includes("pending-env-current-commit-mismatch"), "current HEAD drift must report exact commit mismatch");
const partialSentinels = evaluateFirstDollarPendingEnvActivation({
  vars: { [FIRST_DOLLAR_PENDING_ENV_SENTINELS.digest]: manifest.digest },
  currentCommit: commit,
  confirmations,
});
assert.equal(partialSentinels.ok, false, "partial sentinels must fail closed");
assert.ok(partialSentinels.failures.includes("pending-env-sentinels-incomplete"), "partial sentinels must be explicit");

const exactContext = {
  project: { id: SMIRK_RAILWAY_PRODUCTION_TARGET.projectId, name: SMIRK_RAILWAY_PRODUCTION_TARGET.projectName },
  service: { id: SMIRK_RAILWAY_PRODUCTION_TARGET.serviceId, name: SMIRK_RAILWAY_PRODUCTION_TARGET.serviceName },
  environment: { id: SMIRK_RAILWAY_PRODUCTION_TARGET.environmentId, name: SMIRK_RAILWAY_PRODUCTION_TARGET.environmentName },
};
assert.equal(exactRailwayProductionTargetMatches(exactContext).ok, true, "exact pinned target must pass");
assert.equal(
  exactRailwayProductionTargetMatches({ ...exactContext, environment: { ...exactContext.environment, id: "wrong" } }).ok,
  false,
  "a stale or different Railway environment must fail",
);

const uploadMessage = pendingActivationUploadMessage({
  commit,
  digest: manifest.digest,
  nonce: "a".repeat(24),
});
const deploymentBaseline = {
  capturedAt: "2026-07-18T12:00:00.000Z",
  uploadMessage,
  baselineDeploymentIds: ["baseline-deploy"],
};
const matchingDeployment = {
  id: "reviewed-upload",
  createdAt: "2026-07-18T12:00:01.000Z",
  serviceId: SMIRK_RAILWAY_PRODUCTION_TARGET.serviceId,
  environmentId: SMIRK_RAILWAY_PRODUCTION_TARGET.environmentId,
  meta: { commitMessage: uploadMessage },
};
assert.equal(deploymentMatchesPendingActivation({
  deployment: matchingDeployment,
  baseline: deploymentBaseline,
  target: SMIRK_RAILWAY_PRODUCTION_TARGET,
}), true, "the exact nonce-bound reviewed upload must match");
assert.equal(deploymentMatchesPendingActivation({
  deployment: { ...matchingDeployment, id: "unrelated", meta: { commitMessage: "concurrent-deploy" } },
  baseline: deploymentBaseline,
  target: SMIRK_RAILWAY_PRODUCTION_TARGET,
}), false, "an unrelated concurrent deployment must not satisfy activation rollout proof");
assert.equal(deploymentMatchesPendingActivation({
  deployment: { ...matchingDeployment, id: "baseline-deploy" },
  baseline: deploymentBaseline,
  target: SMIRK_RAILWAY_PRODUCTION_TARGET,
}), false, "a pre-upload deployment ID must not satisfy activation rollout proof");

const deploySource = readFileSync("deploy.sh", "utf8");
const receiptSource = readFileSync("scripts/record-first-dollar-activation-receipt.mjs", "utf8");
const deploymentBaselineSource = readFileSync("scripts/capture-first-dollar-pending-env-deployment-baseline.mjs", "utf8");
const deploymentWaitSource = readFileSync("scripts/wait-first-dollar-pending-env-deployment.mjs", "utf8");
const setterSource = readFileSync("scripts/set-first-dollar-live-env.sh", "utf8");
const packageSource = readFileSync("package.json", "utf8");
const packetWriterSource = readFileSync("scripts/write-first-dollar-approval-packet.mjs", "utf8");
const packetPrinterSource = readFileSync("scripts/print-first-dollar-approval-packet.mjs", "utf8");
const setupSource = readFileSync("STRIPE_PAYMENT_LINK_SETUP.md", "utf8");

const activationCheckIndex = deploySource.indexOf("npm run -s check:first-dollar-pending-env-activation");
const railwayUpIndex = deploySource.indexOf("railway up --detach");
const shipCheckIndex = deploySource.indexOf("npm run check:ship-live");
const receiptIndex = deploySource.indexOf("npm run -s record:first-dollar-activation-receipt");
const deploymentBaselineIndex = deploySource.indexOf("npm run -s capture:first-dollar-pending-env-deployment-baseline");
const railwayDeploymentWaitIndex = deploySource.indexOf("npm run -s wait:first-dollar-pending-env-deployment");
assert.ok(activationCheckIndex >= 0 && activationCheckIndex < railwayUpIndex, "every Railway upload must first verify pending activation authority");
assert.ok(deploymentBaselineIndex >= 0 && deploymentBaselineIndex < railwayUpIndex, "activation deploy must snapshot existing exact-target deployment IDs immediately before upload");
assert.ok(railwayDeploymentWaitIndex > railwayUpIndex && railwayDeploymentWaitIndex < shipCheckIndex, "activation deploy must prove a new exact-target Railway deployment completed before ship checks");
assert.ok(receiptIndex > shipCheckIndex, "activation receipt may record only after the full live ship check succeeds");
assert.doesNotMatch(deploySource, /git push/, "production deploy authority must not imply Git-push authority");
assert.match(receiptSource, /FIRST_DOLLAR_ACTIVATED_ENV_RECEIPT/, "activation completion must use a digest receipt instead of deleting evidence");
assert.match(receiptSource, /skipDeploys: true/, "activation receipt must suppress implicit deploys");
assert.doesNotMatch(receiptSource, /FIRST_DOLLAR_PENDING_ENV_SENTINELS/, "activation receipt must never erase pending-manifest evidence");
assert.match(receiptSource, /SMIRK_PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON/, "activation receipt must require the exact pre-upload baseline");
assert.match(receiptSource, /deploymentMatchesPendingActivation/, "activation receipt must independently verify the exact nonce-bound deployment");
assert.match(receiptSource, /=== "SUCCESS"/, "activation receipt must require provider-confirmed deployment success");
assert.match(receiptSource, /\["run", "-s", "check:ship-live"\]/, "activation receipt must independently rerun the full live ship gate");
assert.match(deploySource, /SMIRK_PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON="\$PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON" npm run -s record:first-dollar-activation-receipt/, "deploy must pass the exact pre-upload baseline into receipt verification");
assert.match(deploymentBaselineSource, /baselineDeploymentIds/, "deployment baseline must bind the pre-upload exact-target deployment IDs");
assert.match(deploymentBaselineSource, /pendingActivationUploadMessage/, "deployment baseline must generate a nonce-bound upload message");
assert.match(deploymentWaitSource, /deploymentMatchesPendingActivation/, "deployment wait must require the exact nonce-bound upload rather than any concurrent deployment");
assert.match(deploySource, /--message "\$PENDING_ACTIVATION_UPLOAD_MESSAGE"/, "Railway upload must carry the exact nonce-bound activation message");
assert.match(deploymentWaitSource, /=== "SUCCESS"/, "deployment wait must require provider success before ship checks");
assert.match(setterSource, /--skip-deploys/, "staging must suppress implicit deploys");
assert.doesNotMatch(setterSource, /if \[ "\$\{CONFIRM_SMIRK_REAL_STARTER_CHECKOUT/, "staging must not require real-checkout authority");
for (const scriptName of [
  "check:first-dollar-pending-env-activation",
  "print:first-dollar-pending-env-activation",
  "record:first-dollar-activation-receipt",
  "capture:first-dollar-pending-env-deployment-baseline",
  "wait:first-dollar-pending-env-deployment",
]) {
  assert.ok(packageSource.includes(`"${scriptName}"`), `package scripts must expose ${scriptName}`);
}

const ordinaryDeployWait = spawnSync(process.execPath, ["scripts/wait-first-dollar-pending-env-deployment.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SMIRK_PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON: JSON.stringify({ ok: true, pending: false }),
  },
  encoding: "utf8",
});
assert.equal(ordinaryDeployWait.status, 0, `ordinary deploys must not wait for a pending activation rollout: ${ordinaryDeployWait.stderr}`);
assert.match(ordinaryDeployWait.stdout, /"waited": false/, "ordinary deploy rollout guard must disclose that no activation wait was needed");

const oldWording = [
  "If the write would make Starter checkout available",
  "setter enforces both Approval 4 and Approval 5",
  "live environment write that would open Starter checkout",
  "one Starter-only Railway write",
];
for (const [label, source] of [
  ["approval packet writer", packetWriterSource],
  ["approval packet printer", packetPrinterSource],
  ["Stripe setup runbook", setupSource],
]) {
  for (const stale of oldWording) assert.ok(!source.includes(stale), `${label} must reject stale activation-on-write wording: ${stale}`);
  assert.match(source, /SMIRK_PENDING_FIRST_DOLLAR_ENV_DIGEST/, `${label} must name the pending digest sentinel`);
  assert.match(source, /print:first-dollar-pending-env-activation/, `${label} must route activation through exact manifest inspection`);
  assert.match(source, /CONFIRM_SMIRK_FIRST_DOLLAR_ACTIVATION_DEPLOY/, `${label} must name distinct activation-deploy authority`);
}

console.log("OK pending first-dollar env fixtures bind exact target, commit, ordered unmasked assignments, and every separate activation authority without exposing secrets");
