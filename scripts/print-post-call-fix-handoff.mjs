#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

function runJson(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { ok: true, data: JSON.parse(out) };
  } catch (error) {
    const out = String(error?.stdout || error?.stderr || error?.message || '').trim();
    try {
      return { ok: false, data: JSON.parse(out) };
    } catch {
      return { ok: false, data: { raw: out || null } };
    }
  }
}

const approval = runJson('npm', ['run', '-s', 'print:deploy-approval-request']);
const blocker = runJson('npm', ['run', '-s', 'print:deploy-blocker']);

const approvalData = approval.data || null;
const blockerData = blocker.data || null;
const blockerDetail = blockerData?.detail || null;
const fingerprintDetail = blockerDetail?.detail || blockerDetail || null;

const artifactPaths = {
  handoffJson: 'output/post-call-fix-handoff.json',
  approvalRequest: 'output/deploy-approval-request.json',
  approvalNote: 'output/post-call-fix-approval-note.md',
  highRiskReview: 'output/high-risk-deploy-review.json',
  approvalBundle: 'output/deploy-approval-bundle.json',
};
const approvalBundleCommand = 'npm run write:deploy-approval-bundle';
const highRiskReviewCommand = 'npm run print:high-risk-deploy-review';
const localBranch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() || 'main';
const fallbackDeployCommand = localBranch !== 'main'
  ? `CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix CONFIRM_SMIRK_DEPLOY_BRANCH=${localBranch} npm run deploy:post-call-fix`
  : 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix npm run deploy:post-call-fix';
const deployCommand = approvalData?.command || fallbackDeployCommand;
const requiresApproval = approvalData?.requiresApproval === true || blockerData?.requiresApproval === true;
const nextAction = requiresApproval
  ? `Generate the approval bundle, get approval, then run ${deployCommand}`
  : blockerData?.nextAction || approvalData?.command || null;
const postDeployProofSteps = Array.isArray(approvalData?.postDeployProofSteps)
  ? approvalData.postDeployProofSteps
  : [
      'npm run -s check:ship-live',
      'WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag',
      'npm run -s check:real-call-readiness -- <safe-number>',
      'npm run -s proof:real-call -- <safe-number>',
    ];
const postDeployProofExpectedArtifacts = Array.isArray(approvalData?.postDeployProofExpectedArtifacts)
  ? approvalData.postDeployProofExpectedArtifacts
  : [
      'call record',
      'generated summary',
      'owner email alert',
      'callback task',
      'dashboard proof counters',
    ];
const deployPreflightRequiredPasses = Array.isArray(approvalData?.deployPreflightRequiredPasses)
  ? approvalData.deployPreflightRequiredPasses
  : [
      'noTextingCopy',
      'firstDollarOfferScope',
      'smirkOpsCopy',
      'callFlow',
      'firstDollarGuardCoverage',
      'openApi',
      'authRegression',
      'paidHandoffSafety',
      'selfServeActivation',
      'billingLifecycle',
      'clientOnboardingIntake',
      'customerDashboard',
      'stripeWebhookPreflight',
      'stripeWebhookApprovalReady',
      'operationalAuthLive',
      'proofArtifactsLive',
      'postCallIntelligenceLive',
      'handoffSafety',
      'railwayAccess',
    ];
const postDeployProofReadinessGuards = Array.isArray(approvalData?.postDeployProofReadinessGuards)
  ? approvalData.postDeployProofReadinessGuards
  : [
      'check:post-deploy-live',
      'check:first-dollar-guard-coverage',
      'check:real-call-readiness -- <safe-number>',
    ];
const postDeployStripeWebhookSmokeApprovalPhrase = approvalData?.postDeployStripeWebhookSmokeApprovalPhrase
  || 'APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE: ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live';
const postDeploySmokeCleanupApplyApprovalPhrase = approvalData?.postDeploySmokeCleanupApplyApprovalPhrase
  || 'APPROVE_SMIRK_SMOKE_CLEANUP_APPLY: APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply';
const deployApprovalToken = approvalData?.deployApprovalToken || 'APPROVE_SMIRK_POST_CALL_FIX_DEPLOY';
const deployApprovalMeaning = approvalData?.deployApprovalMeaning
  || 'Production deploy approval only. This does not authorize Stripe smoke, cleanup apply, proof calls, secret access, paid spend, or outreach.';

console.log(JSON.stringify({
  ok: approval.ok,
  handoff: 'post-call-fix-deploy',
  requiresApproval,
  deployApprovalToken,
  deployApprovalMeaning,
  liveVersionCurrent: approvalData?.liveVersionCurrent === true,
  deployState: approvalData?.deployState || null,
  blockerDetail: approvalData?.blockerDetail || blockerData?.blockerDetail || null,
  liveFingerprintCurrent: approvalData?.liveFingerprintCurrent === true,
  localDeployClean: approvalData?.localDeployClean === true,
  gitRemoteSync: approvalData?.gitRemoteSync || null,
  branchReconcileRequired: approvalData?.branchReconcileRequired === true,
  deployBranchMismatch: approvalData?.deployBranchMismatch === true,
  deployBranchMismatchReason: approvalData?.deployBranchMismatchReason || null,
  expectedVersion: approvalData?.expectedVersion || blockerData?.expectedVersion || blockerData?.localCommit || null,
  actualVersion: approvalData?.actualVersion || blockerData?.actualVersion || null,
  changedFileCount: approvalData?.changedFileCount ?? null,
  changedFileGroups: approvalData?.changedFileGroups || null,
  highRiskFileCount: approvalData?.highRiskFileCount ?? null,
  highRiskFiles: approvalData?.highRiskFiles || null,
  highRiskDiffStats: approvalData?.highRiskDiffStats || null,
  highRiskFileReasons: approvalData?.highRiskFileReasons || null,
  artifactPaths,
  approvalBundleCommand,
  highRiskReviewCommand,
  deployCommand,
  approvalSteps: [approvalBundleCommand, highRiskReviewCommand, `Get explicit ${deployApprovalToken} approval from Cameron.`, deployCommand],
  postDeployProofRequired: approvalData?.postDeployProofRequired === true,
  proofRunnerRequiresPostDeployLive: approvalData?.proofRunnerRequiresPostDeployLive === true,
  deployPreflightRequiredPasses,
  expectedDeployBlockerAfterRequiredPasses: approvalData?.expectedDeployBlockerAfterRequiredPasses || 'stale-production-deploy',
  postDeployProofReadinessGuards,
  postDeployStripeWebhookSmokeApprovalPhrase,
  postDeploySmokeCleanupApplyApprovalPhrase,
  postDeployProofSteps,
  postDeployProofExpectedArtifacts,
  nextAction,
  liveHealth: {
    url: fingerprintDetail?.url || null,
    status: fingerprintDetail?.status ?? null,
    readinessHeader: fingerprintDetail?.readinessHeader || blockerData?.liveReadinessHeader || null,
    branchHeader: blockerData?.liveBranch || fingerprintDetail?.branchHeader || approvalData?.liveBranch || null,
    versionHeader: blockerData?.actualVersion || fingerprintDetail?.actualVersion || fingerprintDetail?.versionHeader || approvalData?.actualVersion || null,
    failure: fingerprintDetail?.failure || blockerDetail?.failure || blockerData?.failure || null,
  },
  approvalRequest: approvalData,
  blockerStatus: blockerData,
}, null, 2));

if (!approval.ok) process.exit(1);
