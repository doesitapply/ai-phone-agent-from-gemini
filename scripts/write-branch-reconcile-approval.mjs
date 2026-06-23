#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function git(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const outputDir = path.join(process.cwd(), "output");
const markdownPath = path.join(outputDir, "branch-reconcile-approval.md");
const jsonPath = path.join(outputDir, "branch-reconcile-approval.json");

const localBranch = git(["branch", "--show-current"]) || "unknown";
const localCommit = git(["rev-parse", "HEAD"]);
const remoteBranch = "origin/main";
const remoteCommit = git(["rev-parse", remoteBranch]);
const mergeBase = git(["merge-base", "HEAD", remoteBranch]);

let gitRemoteSync = "unknown";
if (localCommit && remoteCommit && mergeBase) {
  if (localCommit === remoteCommit) {
    gitRemoteSync = "current";
  } else if (mergeBase === remoteCommit) {
    gitRemoteSync = "ahead";
  } else if (mergeBase === localCommit) {
    gitRemoteSync = "behind";
  } else {
    gitRemoteSync = "diverged";
  }
}

const approvalRequired = gitRemoteSync === "behind" || gitRemoteSync === "diverged";
const approvalToken = "APPROVE_SMIRK_BRANCH_RECONCILE";
const branchReconcileCommand =
  'git stash push -u -m "smirk-deploy-divergence" && git pull --rebase origin main && git stash pop';
const conflictForecastCommand = "npm run -s check:branch-sync-conflict-forecast";
const stopRule =
  "If rebase or git stash pop produces conflicts, stop and preserve the conflicted state for inspection. Do not deploy, run Stripe smoke, or run proof calls.";
const verificationCommands = [
  "npm run -s check:deploy-post-call-fix-ready",
  "npm run write:deploy-approval-bundle",
  "npm run -s check:deploy-approval-handoff",
];

const data = {
  ok: true,
  generatedAt: new Date().toISOString(),
  approvalRequired,
  approvalToken,
  boundary:
    "Branch reconciliation approval only. This does not authorize deploy, Stripe smoke, cleanup apply, proof call, secret access, paid spend, or outreach.",
  localBranch,
  localCommit,
  remoteBranch,
  remoteCommit,
  mergeBaseWithRemote: mergeBase,
  gitRemoteSync,
  branchReconcileCommand,
  conflictForecastCommand,
  stopRule,
  verificationCommands,
  nextAction: approvalRequired
    ? `Ask Cameron for ${approvalToken} before running branch synchronization.`
    : "No branch reconciliation approval is needed from the current git sync state.",
};

const lines = [
  "# SMIRK Branch Reconciliation Approval",
  "",
  "## Boundary",
  data.boundary,
  "",
  "## Current State",
  `- Local branch: ${localBranch}`,
  `- Local commit: ${localCommit || "unknown"}`,
  `- Remote branch: ${remoteBranch}`,
  `- Remote commit: ${remoteCommit || "unknown"}`,
  `- Merge base: ${mergeBase || "unknown"}`,
  `- Git remote sync: ${gitRemoteSync}`,
  "",
  "## Approval Required",
  approvalRequired ? "Yes." : "No.",
  "",
  "## Approval Token",
  approvalToken,
  "",
  "## Authorized Command After Approval",
  "```sh",
  conflictForecastCommand,
  "```",
  "```sh",
  branchReconcileCommand,
  "```",
  "",
  "## Stop Rule",
  stopRule,
  "",
  "## Required Verification After Reconciliation",
  ...verificationCommands.flatMap((command) => ["```sh", command, "```"]),
  "",
  "## Next Action",
  data.nextAction,
  "",
];

mkdirSync(outputDir, { recursive: true });
writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`);
writeFileSync(markdownPath, `${lines.join("\n")}\n`);

console.log(
  JSON.stringify(
    {
      ok: true,
      markdownPath,
      jsonPath,
      approvalRequired,
      gitRemoteSync,
      nextAction: data.nextAction,
    },
    null,
    2,
  ),
);
