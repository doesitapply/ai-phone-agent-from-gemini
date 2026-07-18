#!/usr/bin/env node
import assert from "node:assert/strict";
import { evaluateStripeWebhookSmokeApprovalIntegrity } from "./lib/stripe-webhook-smoke-approval-integrity.mjs";

const commit = "a".repeat(40);
const staleCommit = "b".repeat(40);
const branch = "codex/market-validation-launch";
const currentLive = { ok: true, version: commit, branch };
const approval = {
  sourceCommit: commit,
  sourceBranch: branch,
  liveVersion: commit,
  liveBranch: branch,
  readiness: { liveCurrent: currentLive },
};
const note = `Commit: ${commit}\nBranch: ${branch}\nLive version: ${commit}\nLive branch: ${branch}\n`;
const evaluate = (overrides = {}) => evaluateStripeWebhookSmokeApprovalIntegrity({
  approval,
  note,
  currentCommit: commit,
  currentBranch: branch,
  currentLive,
  ...overrides,
});

assert.equal(evaluate().ok, true, "exact source and live identity must pass");
assert.equal(evaluate({ approval: { ...approval, sourceCommit: staleCommit } }).ok, false, "stale source commit must fail");
assert.equal(evaluate({ approval: { ...approval, sourceBranch: "main" } }).ok, false, "stale source branch must fail");
assert.equal(evaluate({ approval: { ...approval, liveVersion: staleCommit } }).ok, false, "stale explicit live version must fail");
assert.equal(evaluate({ currentLive: { ok: true, version: staleCommit, branch } }).ok, false, "production drift after artifact generation must fail");
assert.equal(evaluate({ note: "unbound note" }).ok, false, "unbound human approval note must fail");

console.log("OK Stripe webhook smoke approval is bound to exact current source and live fingerprints");
