export const defaultDeployApprovalPhrase = "APPROVE_SMIRK_POST_CALL_FIX_DEPLOY";
export const defaultBranchReconcileApprovalPhrase = "APPROVE_SMIRK_BRANCH_RECONCILE";
export const defaultLocalGitCommitApprovalPhrase = "APPROVE_LOCAL_GIT_COMMIT";

function failingChecks(checks) {
  return (Array.isArray(checks) ? checks : []).filter((check) => check?.ok !== true);
}

export function deriveFirstCustomerNextAction(checks, options = {}) {
  const deployApprovalPhrase = String(options.deployApprovalPhrase || defaultDeployApprovalPhrase);
  const branchReconcileApprovalPhrase = String(
    options.branchReconcileApprovalPhrase || defaultBranchReconcileApprovalPhrase,
  );
  const localGitCommitApprovalPhrase = String(
    options.localGitCommitApprovalPhrase || defaultLocalGitCommitApprovalPhrase,
  );
  const stripeSmokeApprovalPhrase = String(options.stripeSmokeApprovalPhrase || "");
  const unmet = failingChecks(checks);
  const ids = new Set(unmet.map((check) => String(check?.id || "")));

  if (unmet.length === 0) {
    return {
      stage: "complete",
      approvalRequired: false,
      userActionRequired: false,
      requiredNextApproval: null,
      blockerIds: [],
      summary: "All first-customer readiness checks pass.",
    };
  }

  if (ids.has("git-clean")) {
    return {
      stage: "local-review-and-commit",
      approvalRequired: true,
      userActionRequired: true,
      requiredNextApproval: localGitCommitApprovalPhrase,
      blockerIds: ["git-clean"],
      summary: "Review and commit the intended local changes before branch reconciliation or an exact-SHA deploy approval.",
    };
  }

  if (ids.has("branch-reconcile")) {
    return {
      stage: "branch-reconciliation",
      approvalRequired: true,
      userActionRequired: true,
      requiredNextApproval: branchReconcileApprovalPhrase,
      blockerIds: ["branch-reconcile"],
      summary: "Preserve and reconcile the changed deploy-branch remote before requesting an exact-SHA production deploy.",
    };
  }

  if (ids.has("live-current")) {
    return {
      stage: "deploy-parity",
      approvalRequired: true,
      userActionRequired: true,
      requiredNextApproval: deployApprovalPhrase,
      blockerIds: ["live-current"],
      summary: "Deploy the reviewed fail-closed release and prove live/current parity before any Stripe write smoke.",
    };
  }

  if (ids.has("railway-first-dollar-env")) {
    return {
      stage: "live-policy-and-configuration",
      approvalRequired: true,
      userActionRequired: true,
      requiredNextApproval: null,
      blockerIds: ["railway-first-dollar-env"],
      summary: "Complete the owner policy decisions and restricted live billing/voice configuration before any Stripe write smoke.",
    };
  }

  const smokePreflightBlockers = ["stripe-preflight", "stripe-approval-ready"].filter((id) => ids.has(id));
  if (smokePreflightBlockers.length > 0) {
    return {
      stage: "stripe-smoke-preflight",
      approvalRequired: false,
      userActionRequired: false,
      requiredNextApproval: null,
      blockerIds: smokePreflightBlockers,
      summary: "Repair the read-only Stripe smoke preflight before requesting approval for a production write smoke.",
    };
  }

  const nonWriteProofBlockers = unmet
    .map((check) => String(check?.id || ""))
    .filter((id) => id && id !== "approved-checkout-provisioning-write");
  if (nonWriteProofBlockers.length > 0) {
    return {
      stage: "repair-unmet-gates",
      approvalRequired: false,
      userActionRequired: false,
      requiredNextApproval: null,
      blockerIds: nonWriteProofBlockers,
      summary: "Repair or verify the remaining non-write gates before requesting a Stripe production smoke.",
    };
  }

  if (ids.has("approved-checkout-provisioning-write")) {
    return {
      stage: "approved-checkout-provisioning-write",
      approvalRequired: true,
      userActionRequired: true,
      requiredNextApproval: stripeSmokeApprovalPhrase || null,
      blockerIds: ["approved-checkout-provisioning-write"],
      summary: "All read-only prerequisites pass; request the exact approval for one signed Stripe checkout/provisioning write smoke.",
    };
  }

  return {
    stage: "repair-unmet-gates",
    approvalRequired: false,
    userActionRequired: false,
    requiredNextApproval: null,
    blockerIds: [...ids].filter(Boolean),
    summary: "Repair or verify the remaining first-customer gates.",
  };
}
