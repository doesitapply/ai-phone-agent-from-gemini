#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const repoRoot = process.cwd();
const outputDir = path.join(repoRoot, "output");
const stripeNotePath = path.join(outputDir, "stripe-webhook-smoke-approval.md");
const stripeJsonPath = path.join(outputDir, "stripe-webhook-smoke-approval.json");
const deployNotePath = path.join(outputDir, "post-call-fix-approval-note.md");
const deployBundlePath = path.join(outputDir, "deploy-approval-bundle.json");
const targetPath = path.join(outputDir, "first-dollar-approval-packet.md");

const required = [
  ["Stripe smoke approval note", stripeNotePath],
  ["Stripe smoke approval JSON", stripeJsonPath],
  ["Deploy approval note", deployNotePath],
  ["Deploy approval bundle", deployBundlePath],
];

const missing = required.filter(([, file]) => !existsSync(file));
if (missing.length > 0) {
  console.error(JSON.stringify({
    ok: false,
    error: "missing-first-dollar-approval-artifacts",
    missing: missing.map(([label, file]) => ({ label, file })),
    nextAction: "Run npm run write:stripe-webhook-smoke-approval && npm run write:deploy-approval-bundle, then rerun npm run write:first-dollar-approval-packet.",
  }, null, 2));
  process.exit(1);
}

const stripeApproval = JSON.parse(readFileSync(stripeJsonPath, "utf8"));
const deployBundle = JSON.parse(readFileSync(deployBundlePath, "utf8"));
const stripeNote = readFileSync(stripeNotePath, "utf8").trim();
const deployNote = readFileSync(deployNotePath, "utf8").trim();

const stripeCommand = stripeApproval.commandToApprove || "ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live";
const stripeApprovalToken = stripeApproval.approvalToken || "APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE";
const stripeApprovalPhrase = `${stripeApprovalToken}: ${stripeCommand}`;
const cleanupApplyCommand = stripeApproval.cleanup?.applyCommand || "APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply";
const cleanupApprovalToken = stripeApproval.cleanupApprovalToken || "APPROVE_SMIRK_SMOKE_CLEANUP_APPLY";
const cleanupApprovalPhrase = `${cleanupApprovalToken}: ${cleanupApplyCommand}`;
const deployCommand = deployBundle.approvalSteps?.find((step) => step.includes("npm run deploy:post-call-fix")) || deployBundle.nextAction || "See deploy approval note.";
const deployApprovalToken = deployBundle.deployApprovalToken || "APPROVE_SMIRK_POST_CALL_FIX_DEPLOY";
const deployApprovalMeaning = deployBundle.deployApprovalMeaning || "Production deploy approval only. This does not authorize Stripe smoke, cleanup apply, proof calls, secret access, paid spend, or outreach.";
const deployState = deployBundle.deployState || "unknown";
const deployBlockerDetail = deployBundle.blockerDetail || "Pending deploy approval is required before paid-path or proof-call checks.";
const liveAlreadyCurrent = deployState === "live-already-current" && deployBundle.liveFingerprintCurrent === true && deployBundle.localDeployClean === true;
const deployApprovalNeeded = !liveAlreadyCurrent;

function runGit(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const localBranch = runGit(["branch", "--show-current"]) || "unknown";
const localCommit = runGit(["rev-parse", "HEAD"]);
const remoteMainCommit = runGit(["rev-parse", "origin/main"]);
const mergeBaseMain = runGit(["merge-base", "HEAD", "origin/main"]);
const gitRemoteSync = localCommit && remoteMainCommit && mergeBaseMain
  ? (localCommit === remoteMainCommit
    ? "current"
    : (mergeBaseMain === remoteMainCommit ? "ahead" : (mergeBaseMain === localCommit ? "behind" : "diverged")))
  : "unknown";
const requiresBranchReconcile = gitRemoteSync === "behind" || gitRemoteSync === "diverged";
const branchConflictForecastCommand = "npm run -s check:branch-sync-conflict-forecast";
const branchReconcileCommand = `git stash push -u -m "smirk-deploy-divergence" && git pull --rebase origin main && git stash pop`;
const branchReconcileApprovalToken = "APPROVE_SMIRK_BRANCH_RECONCILE";
const deployRecommendation = requiresBranchReconcile
  ? `Synchronize the local branch with origin/main before approving production deploy. The reviewed branch is ${gitRemoteSync} relative to origin/main, so deploying now risks proving or shipping the wrong approval surface.`
  : (liveAlreadyCurrent
    ? "Production is already current and the deploy-relevant working tree is clean. The next approval-gated money-path proof is the signed Stripe webhook smoke after live and buffer checks pass."
    : (deployState === "pending-local-deploy-work"
    ? (deployBundle.liveFingerprintCurrent === true
      ? `Approve the production deploy first. The local proof-hardening bundle is ready, live fingerprint is current, and deploy-relevant local work is pending approval/shipping; running paid-path or proof-call checks before this deploy risks proving the wrong approval surface.`
      : `Approve the production deploy first. The local proof-hardening bundle is ready, but production is stale; running paid-path or proof-call checks before deploy risks proving the wrong code.`)
    : `Approve the production deploy first. The local proof-hardening bundle is ready, but production is stale; running paid-path or proof-call checks before deploy risks proving the wrong code.`));

mkdirSync(outputDir, { recursive: true });

const packet = [
  "# SMIRK First-Dollar Approval Packet",
  "",
  `Generated: ${new Date().toISOString()}`,
  `Repo commit: ${deployBundle.sourceCommit || stripeApproval.sourceCommit || "unknown"}`,
  "",
  "## Purpose",
  "",
  "Move SMIRK closer to first dollar by proving paid checkout can hand off into activation without crossing any production write until Cameron explicitly approves it.",
  "",
  "## Current Recommended Approval",
  "",
  deployRecommendation,
  "",
  `Git remote sync: ${gitRemoteSync}`,
  `Branch reconciliation required: ${requiresBranchReconcile ? "yes" : "no"}`,
  `Local branch: ${localBranch}`,
  `Local commit: ${localCommit || "unknown"}`,
  `Origin main commit: ${remoteMainCommit || "unknown"}`,
  `Deploy state: ${deployState}`,
  `Deploy blocker detail: ${deployBlockerDetail}`,
  "",
  ...(requiresBranchReconcile
    ? [
        "## Approval 0: Branch Reconciliation",
        "",
        "This is the only safe next approval. It does not authorize deploy, Stripe smoke, cleanup apply, proof call, secret access, paid spend, or outreach.",
        "",
        `Approval token: \`${branchReconcileApprovalToken}\``,
        "",
        "To print the dedicated Approval 0 handoff, run:",
        "",
        "```bash",
        "npm run -s print:branch-reconcile-approval",
        "```",
        "",
        "Run the conflict forecast before branch reconciliation and respect a failure:",
        "",
        "```bash",
        branchConflictForecastCommand,
        "```",
        "",
        "Authorized command after Cameron approves the token:",
        "",
        "```bash",
        branchReconcileCommand,
        "```",
        "",
        "If rebase or `git stash pop` produces conflicts, stop and preserve the conflicted state for inspection. Do not deploy, run Stripe smoke, or run proof calls under branch-reconciliation approval.",
        "",
        "After synchronization, regenerate this packet and rerun deploy readiness before any production deploy approval.",
        "",
      ]
    : []),
  ...(requiresBranchReconcile
    ? [
        "Do not run a production deploy from this packet. Deploy approval comes only after branch synchronization and regenerated readiness pass.",
        "",
      ]
    : (deployApprovalNeeded
      ? [
        "```bash",
        deployCommand,
        "```",
        "",
        "After deploy, run `npm run -s check:ship-live`, then `WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag`. Only then request separate approval for the signed Stripe webhook smoke, cleanup apply, and one pinned real proof call.",
        "",
      ]
      : [
        "Run these non-mutating checks before using the Stripe approval phrase:",
        "",
        "```bash",
        "npm run -s check:ship-live",
        "WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag",
        "npm run -s check:stripe-webhook-smoke-approval-ready",
        "```",
        "",
        "If those pass, request separate approval for the signed Stripe webhook smoke. Deploy approval is not needed while live remains current.",
        "",
      ])),
  "",
  "## Approval 1: Production Deploy",
  "",
  requiresBranchReconcile
    ? "Production deploy is not the next safe approval until the local branch is reconciled with origin/main and readiness is regenerated."
    : (deployApprovalNeeded
      ? "Deploy approval ships the pending proof-hardening bundle; it does not prove first-dollar readiness by itself."
      : "No production deploy approval is needed right now because live already matches the reviewed commit and the deploy-relevant working tree is clean."),
  "",
  ...(requiresBranchReconcile || !deployApprovalNeeded
    ? []
    : [
        `Approval token: \`${deployApprovalToken}\``,
        "",
        deployApprovalMeaning,
        "",
      ]),
  ...(requiresBranchReconcile
    ? [
        "Deploy command intentionally withheld from the recommended action until synchronization is complete and this packet is regenerated.",
        "",
      ]
    : (deployApprovalNeeded
      ? [
        "```bash",
        deployCommand,
        "```",
        "",
      ]
      : [
        "Deploy command intentionally omitted from the recommended action because this packet is for the current live commit.",
        "",
      ])),
  `Deploy-relevant files covered: ${deployBundle.reviewFilesCount ?? deployBundle.deployRelevantDirtyFiles?.length ?? "unknown"}`,
  "",
  "## Approval 2: Stripe Webhook Smoke",
  "",
  "This is the next money-path proof after deploy and live checks. It may create production smoke provisioning/workspace state.",
  "",
  "```bash",
  stripeCommand,
  "```",
  "",
  "Approval phrase:",
  "",
  "```text",
  stripeApprovalPhrase,
  "```",
  "",
  "Separate cleanup approval phrase, only after reviewing cleanup dry-run output:",
  "",
  "```text",
  cleanupApprovalPhrase,
  "```",
  "",
  "Expected after approval:",
  "",
  "- webhook response returns `received=true`",
  "- checkout-status finds the synthetic paid provisioning row",
  "- provisioning status is `workspace_created`, `workspace_and_line_created`, or `manual_fallback_required`",
  "- checkout-status returns public activation labels: `request_summary.status_label` and `next_step_label`",
  "- checkout-status acknowledges the checkout reference without exposing the raw Stripe checkout session ID",
  "- cleanup dry-run sees the created provisioning row before any cleanup apply",
  "",
  "## Stop Rules",
  "",
  "- Deploy approval does not authorize the signed Stripe webhook smoke.",
  "- Do not run the Stripe smoke without explicit approval.",
  "- Do not apply smoke cleanup before reviewing cleanup dry-run.",
  "- Do not apply confirmed smoke cleanup without separate explicit cleanup approval.",
  "- Do not deploy without explicit deploy approval.",
  "- Do not continue branch reconciliation after a failing conflict forecast or conflicted rebase/stash-pop without inspection.",
  "- Do not place a proof call without a same-number readiness pass and explicit call approval.",
  "- Do not begin outreach until paid activation proof is either passed or honestly disclosed as manual fallback.",
  "",
  "## After Approval Sequence",
  "",
  ...(deployApprovalNeeded
    ? [
      "1. If Cameron approves deploy, run only the deploy command, then run `npm run -s check:ship-live`.",
      "2. Run `WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag` so buffered Twilio events are not silently aging before proof.",
      "3. If post-deploy live and buffer lag checks pass, request separate approval for the signed Stripe smoke.",
      "4. If Cameron approves the Stripe smoke, run only the signed smoke command and inspect the result.",
      "5. If smoke rows are created, run cleanup dry-run only; stop before confirmed cleanup apply unless Cameron separately approves cleanup.",
      "6. If checkout/provisioning proof passes, request explicit approval for one pinned proof call to a safe number.",
      "7. Begin outreach only after proof passes, or after the remaining manual fallback is written plainly into the offer.",
    ]
    : [
      "1. Run `npm run -s check:ship-live` and `WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag` to confirm live and buffer health.",
      "2. Run `npm run -s check:stripe-webhook-smoke-approval-ready` to confirm the signed Stripe smoke is still approval-ready.",
      "3. If Cameron approves the Stripe smoke, run only the signed smoke command and inspect the result.",
      "4. If smoke rows are created, run cleanup dry-run only; stop before confirmed cleanup apply unless Cameron separately approves cleanup.",
      "5. If checkout/provisioning proof passes, request explicit approval for one pinned proof call to a safe number.",
      "6. Begin outreach only after proof passes, or after the remaining manual fallback is written plainly into the offer.",
    ]),
  "",
  "## Deploy Preflight Evidence Required",
  "",
  `Required passes: ${Array.isArray(deployBundle.deployPreflightRequiredPasses) && deployBundle.deployPreflightRequiredPasses.length
    ? deployBundle.deployPreflightRequiredPasses.join(", ")
    : "unknown"}.`,
  "",
  "## Source: Stripe Smoke Approval",
  "",
  stripeNote,
  "",
  "## Source: Deploy Approval",
  "",
  deployNote,
  "",
].join("\n");

writeFileSync(targetPath, packet);

console.log(JSON.stringify({
  ok: true,
  path: targetPath,
  stripeCommand,
  deployCommand,
  deployRelevantFileCount: deployBundle.reviewFilesCount ?? null,
}, null, 2));
