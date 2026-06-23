#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const notePath = path.join(repoRoot, "output", "stripe-webhook-smoke-approval.md");
const jsonPath = path.join(repoRoot, "output", "stripe-webhook-smoke-approval.json");

if (!existsSync(notePath) || !existsSync(jsonPath)) {
  console.error(JSON.stringify({
    ok: false,
    error: "missing-stripe-webhook-smoke-approval-artifacts",
    notePath,
    jsonPath,
    nextAction: "Run npm run write:stripe-webhook-smoke-approval, then rerun npm run print:stripe-webhook-smoke-approval.",
  }, null, 2));
  process.exit(1);
}

const note = readFileSync(notePath, "utf8");
const approval = JSON.parse(readFileSync(jsonPath, "utf8"));
const commandToApprove = "ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live";
const approvalPhrase = `APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE: ${commandToApprove}`;
const cleanupCommand = "APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply";
const cleanupApprovalPhrase = `APPROVE_SMIRK_SMOKE_CLEANUP_APPLY: ${cleanupCommand}`;

if (approval.commandToApprove !== commandToApprove) {
  console.error(JSON.stringify({
    ok: false,
    error: "stripe-webhook-smoke-approval-command-drift",
    commandToApprove: approval.commandToApprove || null,
    nextAction: "Run npm run write:stripe-webhook-smoke-approval, then verify with npm run check:stripe-webhook-smoke-approval-ready.",
  }, null, 2));
  process.exit(1);
}

if (
  approval.approvalToken !== "APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE" ||
  approval.cleanupApprovalToken !== "APPROVE_SMIRK_SMOKE_CLEANUP_APPLY" ||
  !note.includes(approvalPhrase) ||
  !note.includes(cleanupApprovalPhrase)
) {
  console.error(JSON.stringify({
    ok: false,
    error: "stripe-webhook-smoke-approval-phrase-drift",
    approvalToken: approval.approvalToken || null,
    cleanupApprovalToken: approval.cleanupApprovalToken || null,
    nextAction: "Run npm run write:stripe-webhook-smoke-approval, then verify with npm run check:stripe-webhook-smoke-approval-ready.",
  }, null, 2));
  process.exit(1);
}

process.stdout.write(note.endsWith("\n") ? note : `${note}\n`);
