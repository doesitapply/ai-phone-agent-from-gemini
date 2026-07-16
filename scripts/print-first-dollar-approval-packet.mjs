#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const packetPath = path.join(repoRoot, "output", "first-dollar-approval-packet.md");

function fail(message, detail = {}) {
  console.error(JSON.stringify({ ok: false, message, detail }, null, 2));
  process.exit(1);
}

function runJson(cmd, args) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return JSON.parse(out);
  } catch (error) {
    const out = String(error?.stdout || error?.stderr || "").trim();
    try {
      return out ? JSON.parse(out) : { ok: false, error: "empty-output" };
    } catch {
      return { ok: false, error: "invalid-json-output", sample: out.slice(0, 500) };
    }
  }
}

if (!existsSync(packetPath)) {
  fail("missing first-dollar approval packet", {
    packetPath,
    nextAction: "Run npm run write:deploy-approval-bundle, then rerun npm run print:first-dollar-approval-packet.",
  });
}

const handoff = runJson("npm", ["run", "-s", "check:deploy-approval-handoff"]);
if (handoff.ok !== true) {
  fail("first-dollar approval packet is stale or unsafe to print", {
    packetPath,
    handoff,
    nextAction: "Run npm run write:deploy-approval-bundle, then rerun npm run print:first-dollar-approval-packet.",
  });
}

let deployBundle = {};
try {
  deployBundle = JSON.parse(readFileSync(path.join(repoRoot, "output", "deploy-approval-bundle.json"), "utf8"));
} catch {
  deployBundle = {};
}
function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
const localCommit = git(["rev-parse", "HEAD"]);
const remoteMainCommit = git(["rev-parse", "origin/main"]);
const mergeBaseMain = git(["merge-base", "HEAD", "origin/main"]);
const gitRemoteSync = localCommit && remoteMainCommit && mergeBaseMain
  ? (localCommit === remoteMainCommit
    ? "current"
    : (mergeBaseMain === remoteMainCommit ? "ahead" : (mergeBaseMain === localCommit ? "behind" : "diverged")))
  : "unknown";
const requiresBranchReconcile = gitRemoteSync === "behind" || gitRemoteSync === "diverged";

const packet = readFileSync(packetPath, "utf8");
const stripeSmokeCommand = "ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live";
const stripeSmokeApprovalPhrase = `APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE: ${stripeSmokeCommand}`;
const smokeCleanupCommand = "APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply";
const smokeCleanupApprovalPhrase = `APPROVE_SMIRK_SMOKE_CLEANUP_APPLY: ${smokeCleanupCommand}`;
const deployPreflightRequiredPasses = Array.isArray(deployBundle.deployPreflightRequiredPasses)
  ? deployBundle.deployPreflightRequiredPasses
  : [];
const requiredPassesLine = deployPreflightRequiredPasses.length
  ? `Required passes: ${deployPreflightRequiredPasses.join(", ")}.`
  : null;
const expectedDeployStateLine = `Deploy state: ${deployBundle.deployState || "unknown"}`;
const liveAlreadyCurrent = deployBundle.deployState === "live-already-current" && deployBundle.liveFingerprintCurrent === true && deployBundle.localDeployClean === true;
for (const required of [
  "## Current Recommended Approval",
  requiresBranchReconcile
    ? "Synchronize the local branch with origin/main before approving production deploy."
    : (liveAlreadyCurrent
      ? "Production is already current and the deploy-relevant working tree is clean. The next approval-gated money-path proof is the signed Stripe webhook smoke after live and buffer checks pass."
      : "Approve the production deploy first."),
  requiresBranchReconcile
    ? "After synchronization, regenerate this packet and rerun deploy readiness before any production deploy approval."
    : (liveAlreadyCurrent
      ? "If those pass, request separate approval for the signed Stripe webhook smoke. Deploy approval is not needed while live remains current."
      : (deployBundle.liveFingerprintCurrent === true
      ? "deploy-relevant local work is pending approval/shipping; running paid-path or proof-call checks before this deploy risks proving the wrong approval surface."
      : "production is stale; running paid-path or proof-call checks before deploy risks proving the wrong code.")),
  `Git remote sync: ${gitRemoteSync}`,
  ...(liveAlreadyCurrent && localCommit
    ? [
        `Stripe approval artifact commit: ${localCommit}`,
        "Stripe approval artifact current: yes",
        `Commit: ${localCommit}`,
      ]
    : ["Stripe approval artifact current:"]),
  expectedDeployStateLine,
  `Deploy blocker detail: ${deployBundle.blockerDetail || "Pending deploy approval is required before paid-path or proof-call checks."}`,
  "## Approval 1: Production Deploy",
  "## Approval 2: Stripe Webhook Smoke",
  "This is the next money-path proof after deploy and live checks.",
  stripeSmokeCommand,
  stripeSmokeApprovalPhrase,
  smokeCleanupApprovalPhrase,
  "Deploy approval does not authorize the signed Stripe webhook smoke.",
  "checkout-status acknowledges the checkout reference without exposing the raw Stripe checkout session ID",
  "Do not apply confirmed smoke cleanup without separate explicit cleanup approval.",
  "Do not place a proof call without a same-number readiness pass and explicit call approval.",
  "Do not begin outreach until paid activation proof is either passed or honestly disclosed as manual fallback.",
  "## After Approval Sequence",
  "## Deploy Preflight Evidence Required",
  ...(requiredPassesLine ? [requiredPassesLine] : ["Required passes:", "smirkOpsCopy"]),
  "Begin outreach only after proof passes, or after the remaining manual fallback is written plainly into the offer.",
  ...(requiresBranchReconcile
    ? [
        "## Approval 0: Branch Reconciliation",
        "This is the only safe next approval. It does not authorize deploy, Stripe smoke, cleanup apply, proof call, secret access, paid spend, or outreach.",
        "Approval token: `APPROVE_SMIRK_BRANCH_RECONCILE`",
        "npm run -s print:branch-reconcile-approval",
        "Run the conflict forecast before branch reconciliation and respect a failure:",
        "npm run -s check:branch-sync-conflict-forecast",
        "Authorized command after Cameron approves the token:",
        "If rebase or `git stash pop` produces conflicts, stop and preserve the conflicted state for inspection. Do not deploy, run Stripe smoke, or run proof calls under branch-reconciliation approval.",
        "Do not continue branch reconciliation after a failing conflict forecast or conflicted rebase/stash-pop without inspection.",
        "Do not run a production deploy from this packet. Deploy approval comes only after branch synchronization and regenerated readiness pass.",
        "Deploy command intentionally withheld from the recommended action until synchronization is complete and this packet is regenerated.",
      ]
    : (liveAlreadyCurrent
      ? [
        "Run these non-mutating checks before using the Stripe approval phrase:",
        "npm run -s check:ship-live",
        "WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag",
        "npm run -s check:stripe-webhook-smoke-approval-ready",
        "No production deploy approval is needed right now because live already matches the reviewed commit and the deploy-relevant working tree is clean.",
        "Deploy command intentionally omitted from the recommended action because this packet is for the current live commit.",
        "Run `npm run -s check:ship-live` and `WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag` to confirm live and buffer health.",
        "Run `npm run -s check:stripe-webhook-smoke-approval-ready` to confirm the signed Stripe smoke is still approval-ready.",
      ]
      : [
        "After deploy, run `npm run -s check:ship-live`, then `WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag`.",
        "If Cameron approves deploy, run only the deploy command, then run `npm run -s check:ship-live`.",
        "Run `WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag` so buffered Twilio events are not silently aging before proof.",
        "If post-deploy live and buffer lag checks pass, request separate approval for the signed Stripe smoke.",
      ])),
]) {
  if (!packet.includes(required)) {
    fail("first-dollar approval packet is missing required approval language", {
      packetPath,
      required,
    });
  }
}

process.stdout.write(packet.endsWith("\n") ? packet : `${packet}\n`);
