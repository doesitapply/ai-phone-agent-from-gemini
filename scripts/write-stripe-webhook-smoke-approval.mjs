#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function runJson(cmd, args, options = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
    return JSON.parse(out);
  } catch (error) {
    const out = String(error?.stdout || error?.stderr || "").trim();
    try {
      return out ? JSON.parse(out) : { ok: false, error: "empty-output" };
    } catch {
      return { ok: false, error: "invalid-json", sample: out.slice(0, 500) };
    }
  }
}

function runText(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

const repoRoot = process.cwd();
const outDir = path.resolve(repoRoot, "output");
fs.mkdirSync(outDir, { recursive: true });

const generatedAt = new Date().toISOString();
const sourceCommit = runText("git", ["rev-parse", "HEAD"]);
const sourceBranch = runText("git", ["branch", "--show-current"]) || "main";
const liveCurrent = runJson("npm", ["run", "-s", "check:live-is-current"]);
const liveVersion = String(liveCurrent?.version || liveCurrent?.versionHeader || "").trim();
const liveBranch = String(liveCurrent?.branch || liveCurrent?.branchHeader || "").trim();
const preflight = runJson("npm", ["run", "-s", "check:stripe-webhook-handoff-live:preflight"]);
const cleanupDryRun = runJson("npm", ["run", "-s", "cleanup:smoke-workspaces"], {
  env: { ...process.env, APP_URL: "https://www.smirkcalls.com" },
});

const approval = {
  ok: liveCurrent?.ok === true
    && liveVersion === sourceCommit
    && liveBranch === sourceBranch
    && preflight?.ok === true
    && cleanupDryRun?.ok === true,
  generatedAt,
  sourceBranch,
  sourceCommit,
  liveVersion,
  liveBranch,
  currentGate: "Gate 3 - Take Money and Create a Workspace",
  purpose: "Verify signed Stripe checkout.session.completed webhook handoff in production.",
  approvalRequired: preflight?.approvalRequired === true,
  approvalReason: "AUTO_FULFILL_PROVISIONING_REQUESTS is enabled, so the signed webhook smoke may create production smoke workspace state.",
  approvalToken: "APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE",
  commandToApprove: "ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live",
  cleanupApprovalToken: "APPROVE_SMIRK_SMOKE_CLEANUP_APPLY",
  expectedStateCreated: {
    provisioningRequest: true,
    workspace: preflight?.autoFulfillEnabled === true,
    workspaceType: "SMIRK Stripe Webhook Smoke",
    customerEmailPattern: "smoke+stripe-<timestamp>@example.com",
  },
  cleanup: {
    dryRunCommand: "APP_URL=https://www.smirkcalls.com npm run cleanup:smoke-workspaces",
    applyCommand: "APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply",
    applyRequiresConfirmation: true,
    currentDryRun: cleanupDryRun,
  },
  readiness: {
    liveCurrent,
    preflight,
  },
  resultHandling: [
    "Confirm webhook returns received=true.",
    "Confirm checkout-status finds the synthetic paid provisioning row.",
    "Confirm request status is workspace_created, workspace_and_line_created, or manual_fallback_required.",
    "Confirm checkout-status returns public activation labels for the request status and next step.",
    "If smoke workspace or provisioning rows are created, run cleanup dry-run before any confirmed cleanup apply.",
  ],
};

const jsonPath = path.join(outDir, "stripe-webhook-smoke-approval.json");
const notePath = path.join(outDir, "stripe-webhook-smoke-approval.md");

fs.writeFileSync(jsonPath, JSON.stringify(approval, null, 2) + "\n");

const md = [
  "# Stripe Webhook Smoke Approval",
  "",
  `Generated: ${generatedAt}`,
  `Commit: ${sourceCommit}`,
  `Branch: ${sourceBranch}`,
  `Live version: ${liveVersion || "NOT_CURRENT"}`,
  `Live branch: ${liveBranch || "NOT_CURRENT"}`,
  `Gate: ${approval.currentGate}`,
  "",
  "## Approval Needed",
  "",
  approval.approvalRequired
    ? "Yes. Auto-fulfillment is enabled, so this smoke may create production smoke workspace state."
    : "No explicit auto-fulfillment approval is required by preflight.",
  "",
  "## Command",
  "",
  "```bash",
  approval.commandToApprove,
  "```",
  "",
  "## Approval Phrase",
  "",
  "```text",
  `${approval.approvalToken}: ${approval.commandToApprove}`,
  "```",
  "",
  "## Expected State",
  "",
  `- Synthetic customer email: ${approval.expectedStateCreated.customerEmailPattern}`,
  `- Provisioning request: ${approval.expectedStateCreated.provisioningRequest ? "yes" : "no"}`,
  `- Workspace may be created: ${approval.expectedStateCreated.workspace ? "yes" : "no"}`,
  "",
  "## Cleanup",
  "",
  "Dry-run first:",
  "",
  "```bash",
  approval.cleanup.dryRunCommand,
  "```",
  "",
  "Confirmed apply:",
  "",
  "```bash",
  approval.cleanup.applyCommand,
  "```",
  "",
  "Cleanup approval phrase, only after reviewing dry-run output:",
  "",
  "```text",
  `${approval.cleanupApprovalToken}: ${approval.cleanup.applyCommand}`,
  "```",
  "",
  "Do not run confirmed cleanup apply without separate explicit cleanup approval after reviewing the dry-run.",
  "",
  "## Current Readiness",
  "",
  `- Live current: ${liveCurrent?.ok === true ? "yes" : "no"}`,
  `- Webhook secret configured: ${preflight?.webhookSecretConfigured === true ? "yes" : "no"}`,
  `- Auto-fulfillment enabled: ${preflight?.autoFulfillEnabled === true ? "yes" : "no"}`,
  `- Approval required: ${preflight?.approvalRequired === true ? "yes" : "no"}`,
  `- Existing smoke provisioning rows: ${cleanupDryRun?.result?.matched_provisioning_requests ?? "unknown"}`,
  `- Existing smoke workspaces: ${cleanupDryRun?.result?.matched_workspaces ?? "unknown"}`,
  "",
  "## Post-Smoke Verification",
  "",
  "- Webhook response must return `received=true`.",
  "- Checkout-status must find the synthetic paid provisioning row.",
  "- Provisioning status must be `workspace_created`, `workspace_and_line_created`, or `manual_fallback_required`.",
  "- Checkout-status must return public activation labels: `request_summary.status_label` and `next_step_label`.",
  "- Checkout-status must acknowledge the checkout reference without exposing the raw Stripe checkout session ID.",
  "- The smoke checker must run cleanup dry-run and confirm the created provisioning row is visible before reporting success.",
  "- Any created smoke workspace or provisioning row must remain visible in cleanup dry-run before confirmed cleanup apply.",
  "",
  "## Stop Conditions",
  "",
  "- Stop if live version is not current.",
  "- Stop if the webhook secret is missing.",
  "- Stop if auto-fulfillment is unexpectedly disabled.",
  "- Stop if cleanup dry-run cannot enumerate smoke rows.",
  "- Stop before confirmed cleanup apply unless Cameron separately approves cleanup.",
  "",
].join("\n");

fs.writeFileSync(notePath, md);

console.log(JSON.stringify({
  ok: approval.ok,
  jsonPath,
  notePath,
  approvalRequired: approval.approvalRequired,
  commandToApprove: approval.commandToApprove,
  liveCurrent: liveCurrent?.ok === true,
  cleanupMatches: {
    workspaces: cleanupDryRun?.result?.matched_workspaces ?? null,
    provisioningRequests: cleanupDryRun?.result?.matched_provisioning_requests ?? null,
  },
}, null, 2));

if (!approval.ok) process.exit(1);
