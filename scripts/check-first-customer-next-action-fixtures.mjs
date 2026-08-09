#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  defaultBranchReconcileApprovalPhrase,
  defaultDeployApprovalPhrase,
  defaultLocalGitCommitApprovalPhrase,
  deriveFirstCustomerNextAction,
  summarizeBuyerRouteAudit,
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

assert.equal(
  summarizeBuyerRouteAudit({
    ok: false,
    stdout: [
      "OK   GET / -> 200",
      "FAIL GET /api/pricing -> 200",
      "FAIL GET /api/first-dollar-readiness -> 200",
      "OK   GET /cancel -> 200",
    ].join("\n"),
    stderr: "FAIL buyer route audit for https://example.invalid",
  }),
  "FAIL GET /api/pricing -> 200; FAIL GET /api/first-dollar-readiness -> 200",
  "buyer-route summary must surface the specific failures instead of the last successful route",
);
assert.equal(
  summarizeBuyerRouteAudit({
    ok: true,
    stdout: "OK   GET /cancel -> 200\nOK buyer route audit for https://example.invalid",
    stderr: "",
  }),
  "OK buyer route audit for https://example.invalid",
  "passing buyer-route summary must preserve the terminal audit result",
);
assert.equal(
  summarizeBuyerRouteAudit({
    ok: false,
    stdout: "unexpected buyer-route output",
    stderr: "",
  }),
  "buyer route audit failed",
  "a subprocess without the required terminal marker must not be summarized as passing",
);

console.log("OK first-customer next-action precedence fixtures passed.");
