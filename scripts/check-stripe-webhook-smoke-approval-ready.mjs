#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { evaluateStripeWebhookSmokeApprovalIntegrity } from "./lib/stripe-webhook-smoke-approval-integrity.mjs";

const expectedCommand = "ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live";
const expectedCleanupDryRun = "APP_URL=https://www.smirkcalls.com npm run cleanup:smoke-workspaces";
const expectedCleanupApply = "APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply";
const expectedApprovalToken = "APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE";
const expectedCleanupApprovalToken = "APPROVE_SMIRK_SMOKE_CLEANUP_APPLY";

function fail(message, detail = {}) {
  console.error(JSON.stringify({ ok: false, message, detail }, null, 2));
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail("approval artifact is missing or invalid JSON", { file, error: error?.message || String(error) });
  }
}

function runJson(cmd, args, options = {}) {
  try {
    const output = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }).trim();
    return JSON.parse(output);
  } catch (error) {
    const output = String(error?.stdout || error?.stderr || "").trim();
    try {
      return output ? JSON.parse(output) : { ok: false, error: "empty-output" };
    } catch {
      return { ok: false, error: "invalid-json-output", sample: output.slice(0, 500) };
    }
  }
}

if (process.env.ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE === "1") {
  fail("approval-ready check must be non-mutating; unset ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE");
}

const repoRoot = process.cwd();
const approvalJsonPath = path.join(repoRoot, "output", "stripe-webhook-smoke-approval.json");
const approvalNotePath = path.join(repoRoot, "output", "stripe-webhook-smoke-approval.md");

if (!existsSync(approvalJsonPath) || !existsSync(approvalNotePath)) {
  fail("missing Stripe webhook smoke approval artifacts", {
    approvalJsonPath,
    approvalNotePath,
    nextAction: "Run npm run write:stripe-webhook-smoke-approval",
  });
}

const approval = readJson(approvalJsonPath);
const note = readFileSync(approvalNotePath, "utf8");
const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const currentBranch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim() || "main";
const currentLive = runJson("npm", ["run", "-s", "check:live-is-current"]);
const preflight = runJson("npm", ["run", "-s", "check:stripe-webhook-handoff-live:preflight"]);

const failures = [];
const requireTrue = (condition, message) => {
  if (!condition) failures.push(message);
};
const noteIncludes = (needle, message) => {
  requireTrue(note.includes(needle), message);
};

const identity = evaluateStripeWebhookSmokeApprovalIntegrity({
  approval,
  note,
  currentCommit,
  currentBranch,
  currentLive,
});
for (const failure of identity.failures) failures.push(failure);

requireTrue(approval.ok === true, "approval JSON ok must be true");
requireTrue(approval.approvalRequired === true, "approval JSON must require explicit approval");
requireTrue(approval.approvalToken === expectedApprovalToken, "approval JSON approvalToken drifted");
requireTrue(approval.commandToApprove === expectedCommand, "approval JSON commandToApprove drifted");
requireTrue(approval.cleanupApprovalToken === expectedCleanupApprovalToken, "approval JSON cleanupApprovalToken drifted");
requireTrue(approval.readiness?.liveCurrent?.ok === true, "approval JSON liveCurrent must be true");
requireTrue(approval.readiness?.preflight?.ok === true, "approval JSON preflight must be ok");
requireTrue(approval.cleanup?.currentDryRun?.ok === true, "approval JSON cleanup dry-run must be ok");
requireTrue((approval.cleanup?.currentDryRun?.result?.matched_workspaces ?? null) === 0, "approval JSON must start with zero smoke workspaces");
requireTrue((approval.cleanup?.currentDryRun?.result?.matched_provisioning_requests ?? null) === 0, "approval JSON must start with zero smoke provisioning rows");
requireTrue(approval.cleanup?.dryRunCommand === expectedCleanupDryRun, "approval JSON cleanup dry-run command drifted");
requireTrue(approval.cleanup?.applyCommand === expectedCleanupApply, "approval JSON cleanup apply command drifted");

requireTrue(preflight.ok === true, "live preflight must be ok");
requireTrue(preflight.approvalRequired === true, "live preflight must require approval");
requireTrue(preflight.autoFulfillEnabled === true, "live preflight must show auto-fulfillment enabled");
requireTrue(preflight.autoFulfillSmokeAllowed === false, "live preflight must remain non-mutating without approval env");
requireTrue(preflight.canRunSignedSmoke === false, "live preflight must block signed smoke without approval env");
requireTrue(preflight.requiredApprovalEnv === "ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1", "live preflight approval env drifted");

noteIncludes(expectedCommand, "approval note must include exact approval command");
noteIncludes(`${expectedApprovalToken}: ${expectedCommand}`, "approval note must include exact approval phrase");
noteIncludes(expectedCleanupDryRun, "approval note must include cleanup dry-run command");
noteIncludes(expectedCleanupApply, "approval note must include confirmed cleanup apply command");
noteIncludes(`${expectedCleanupApprovalToken}: ${expectedCleanupApply}`, "approval note must include separate cleanup approval phrase");
noteIncludes("## Post-Smoke Verification", "approval note must include Post-Smoke Verification section");
noteIncludes("## Stop Conditions", "approval note must include Stop Conditions section");
noteIncludes("Webhook response must return `received=true`.", "approval note must require webhook received=true");
noteIncludes("Checkout-status must return public activation labels: `request_summary.status_label` and `next_step_label`.", "approval note must require public activation labels after smoke");
noteIncludes("Checkout-status must acknowledge the checkout reference without exposing the raw Stripe checkout session ID.", "approval note must require sanitized checkout reference proof after smoke");
noteIncludes("The smoke checker must run cleanup dry-run and confirm the created provisioning row is visible before reporting success.", "approval note must document cleanup visibility enforcement");
noteIncludes("Do not run confirmed cleanup apply without separate explicit cleanup approval after reviewing the dry-run.", "approval note must separate cleanup apply approval from smoke approval");
noteIncludes("Stop before confirmed cleanup apply unless Cameron separately approves cleanup.", "approval note stop conditions must require separate cleanup approval");

if (failures.length > 0) {
  fail("Stripe webhook smoke approval handoff is not ready", {
    failures,
    approvalJsonPath,
    approvalNotePath,
  });
}

console.log(JSON.stringify({
  ok: true,
  approvalRequired: true,
  commandToApprove: expectedCommand,
  artifacts: {
    approvalJsonPath,
    approvalNotePath,
  },
  preflight: {
    webhookSecretConfigured: preflight.webhookSecretConfigured === true,
    autoFulfillEnabled: preflight.autoFulfillEnabled === true,
    canRunSignedSmokeWithoutApproval: preflight.canRunSignedSmoke === true,
  },
  identity,
  cleanupBaseline: {
    matched_workspaces: approval.cleanup.currentDryRun.result.matched_workspaces,
    matched_provisioning_requests: approval.cleanup.currentDryRun.result.matched_provisioning_requests,
  },
}, null, 2));
