#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  defaultBranchReconcileApprovalPhrase,
  defaultDeployApprovalPhrase,
  defaultLocalGitCommitApprovalPhrase,
  deriveFirstCustomerNextAction,
} from "./lib/first-customer-next-action.mjs";

const stripeApproval = "APPROVE_ONE_SIGNED_STRIPE_SMOKE";
const derive = (checks) => deriveFirstCustomerNextAction(checks, {
  stripeSmokeApprovalPhrase: stripeApproval,
});

assert.deepEqual(derive([{ id: "live-current", ok: true }]), {
  stage: "complete",
  approvalRequired: false,
  userActionRequired: false,
  requiredNextApproval: null,
  blockerIds: [],
  summary: "All first-customer readiness checks pass.",
});

const stale = derive([
  { id: "live-current", ok: false },
  { id: "railway-first-dollar-env", ok: false },
  { id: "approved-checkout-provisioning-write", ok: false },
]);
assert.equal(stale.stage, "deploy-parity");
assert.equal(stale.requiredNextApproval, defaultDeployApprovalPhrase);

const dirty = derive([
  { id: "git-clean", ok: false },
  { id: "branch-reconcile", ok: false },
  { id: "live-current", ok: false },
]);
assert.equal(dirty.stage, "local-review-and-commit");
assert.equal(dirty.requiredNextApproval, defaultLocalGitCommitApprovalPhrase);

const diverged = derive([
  { id: "git-clean", ok: true },
  { id: "branch-reconcile", ok: false },
  { id: "live-current", ok: false },
]);
assert.equal(diverged.stage, "branch-reconciliation");
assert.equal(diverged.requiredNextApproval, defaultBranchReconcileApprovalPhrase);

const env = derive([
  { id: "live-current", ok: true },
  { id: "railway-first-dollar-env", ok: false },
  { id: "approved-checkout-provisioning-write", ok: false },
]);
assert.equal(env.stage, "live-policy-and-configuration");
assert.equal(env.requiredNextApproval, null);

const preflight = derive([
  { id: "live-current", ok: true },
  { id: "railway-first-dollar-env", ok: true },
  { id: "stripe-preflight", ok: false },
  { id: "approved-checkout-provisioning-write", ok: false },
]);
assert.equal(preflight.stage, "stripe-smoke-preflight");
assert.equal(preflight.requiredNextApproval, null);

const unrelatedFailure = derive([
  { id: "live-current", ok: true },
  { id: "railway-first-dollar-env", ok: true },
  { id: "buyer-routes-live", ok: false },
  { id: "approved-checkout-provisioning-write", ok: false },
]);
assert.equal(unrelatedFailure.stage, "repair-unmet-gates");
assert.equal(unrelatedFailure.requiredNextApproval, null);

const smoke = derive([
  { id: "live-current", ok: true },
  { id: "railway-first-dollar-env", ok: true },
  { id: "approved-checkout-provisioning-write", ok: false },
]);
assert.equal(smoke.stage, "approved-checkout-provisioning-write");
assert.equal(smoke.requiredNextApproval, stripeApproval);

console.log("OK first-customer next-action precedence fixtures passed.");
