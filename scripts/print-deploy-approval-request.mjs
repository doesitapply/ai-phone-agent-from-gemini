#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  collectDeployChangeSet,
  diffNumstatFromBase,
  resolveApprovalDeployReviewBase,
} from './lib/deploy-change-set.mjs';

const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() || 'main';
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const remoteMainCommit = (() => {
  try { return execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim(); } catch { return null; }
})();
const mergeBaseMain = (() => {
  try { return execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { encoding: 'utf8' }).trim(); } catch { return null; }
})();
const gitRemoteSync = commit && remoteMainCommit && mergeBaseMain
  ? (commit === remoteMainCommit
    ? 'current'
    : (mergeBaseMain === remoteMainCommit ? 'ahead' : (mergeBaseMain === commit ? 'behind' : 'diverged')))
  : 'unknown';
const branchReconcileRequired = gitRemoteSync === 'behind' || gitRemoteSync === 'diverged';
const authoritativeBase = resolveApprovalDeployReviewBase();
const changeSet = collectDeployChangeSet({ baseRef: authoritativeBase.ref });
const changedFilePaths = changeSet.files;
const deployRelevantFiles = changeSet.files;
const deployRelevantDirtyFiles = changeSet.dirtyFiles;
const hasDeployRelevantDirtyFiles = deployRelevantDirtyFiles.length > 0;

const changedFileGroups = changedFilePaths.reduce((acc, file) => {
  if (file.startsWith('scripts/')) acc.scripts += 1;
  else if (file.startsWith('src/') || file === 'server.ts' || file === 'package.json' || file === 'deploy.sh') acc.app += 1;
  else if (file.startsWith('output/') || file.startsWith('outputs/')) acc.output += 1;
  else if (file.endsWith('.md') || file === '.env.example') acc.docs += 1;
  else acc.other += 1;
  return acc;
}, { docs: 0, scripts: 0, app: 0, output: 0, other: 0 });

const highRiskFiles = deployRelevantFiles;

const highRiskDiffStats = highRiskFiles.map((file) => {
  try {
    return {
      file,
      ...diffNumstatFromBase(file, changeSet.baseRef),
    };
  } catch {
    return { file, added: null, removed: null };
  }
});

const staticReasons = {
  'deploy.sh': 'Wait for live commit parity after Railway upload, then run the full ship check automatically.',
  'package.json': 'Adds the live verification, deploy handoff, and real proof-call scripts used to prove the shipped path.',
  'server.ts': 'Always trigger post-call intelligence after call end so summaries are attempted on production calls.',
  'src/App.tsx': 'Hides Mission Control and advanced operational screens from customer workspace sessions.',
};

function reasonFor(file) {
  if (staticReasons[file]) return staticReasons[file];
  if (file.startsWith('scripts/')) return 'Changes deploy, proof-call, auth, or launch verification helpers that gate first-dollar readiness.';
  if (file.endsWith('.md')) return 'Changes operator or buyer-facing readiness documentation used before production proof.';
  if (file.startsWith('src/')) return 'Changes frontend behavior or copy visible to buyer/operator workflows.';
  return 'Deploy-relevant local change included in the production approval surface.';
}

const highRiskFileReasons = Object.fromEntries(highRiskFiles.map((file) => [file, reasonFor(file)]));

const liveCheck = authoritativeBase.liveCheck;

const liveFingerprint = liveCheck?.detail || liveCheck || null;
const liveBranch = liveCheck?.actualBranch || liveFingerprint?.actualBranch || liveFingerprint?.branchHeader || null;
const liveFingerprintCurrent = liveCheck?.ok === true;
const localDeployClean = !hasDeployRelevantDirtyFiles;
const deployState = hasDeployRelevantDirtyFiles
  ? 'pending-local-deploy-work'
  : (!liveFingerprintCurrent ? 'stale-production-deploy' : 'live-already-current');
const blockerDetail = hasDeployRelevantDirtyFiles && liveFingerprintCurrent
  ? 'Live fingerprint matches local HEAD, but deploy-relevant working-tree changes still need explicit approval and shipping before Stripe smoke or proof-call approval.'
  : (!liveFingerprintCurrent
    ? 'Live Railway fingerprint does not match local HEAD yet.'
    : 'Live fingerprint is current and deploy-relevant working tree is clean.');
const deployBranchMismatch = Boolean(liveBranch && branch && liveBranch !== branch);
const requiresDeployBranchConfirmation = branch !== 'main';
const deployCommand = requiresDeployBranchConfirmation
  ? `CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix CONFIRM_SMIRK_DEPLOY_BRANCH=${branch} CONFIRM_SMIRK_DEPLOY_COMMIT=${commit} npm run deploy:post-call-fix`
  : `CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix CONFIRM_SMIRK_DEPLOY_COMMIT=${commit} npm run deploy:post-call-fix`;
const postDeployProofSteps = [
  'npm run -s check:ship-live',
  'WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag',
  'npm run -s check:real-call-readiness -- <safe-number>',
  'npm run -s proof:real-call -- <safe-number>',
];
const deployPreflightRequiredPasses = [
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
  ...(branchReconcileRequired ? ['branchSyncConflictForecast'] : []),
  'proofArtifactsLive',
  'postCallIntelligenceLive',
  'webhookBuffer',
  'handoffSafety',
  'railwayAccess',
];
const postDeployProofReadinessGuards = [
  'check:post-deploy-live',
  'check:first-dollar-guard-coverage',
  'check:real-call-readiness -- <safe-number>',
];
const postDeployStripeWebhookSmokeApprovalPhrase = 'APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE: ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live';
const postDeploySmokeCleanupApplyApprovalPhrase = 'APPROVE_SMIRK_SMOKE_CLEANUP_APPLY: APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply';
const deployApprovalToken = 'APPROVE_SMIRK_POST_CALL_FIX_DEPLOY';

console.log(JSON.stringify({
  requiresApproval: true,
  deployApprovalToken,
  deployApprovalMeaning: 'Production deploy approval only. This does not authorize Stripe smoke, cleanup apply, proof calls, secret access, paid spend, or outreach.',
  branch,
  commit,
  gitRemoteSync,
  branchReconcileRequired,
  remoteMainCommit,
  liveVersionCurrent: hasDeployRelevantDirtyFiles ? false : liveCheck?.ok === true,
  deployState,
  blockerDetail,
  liveFingerprintCurrent,
  localDeployClean,
  expectedVersion: hasDeployRelevantDirtyFiles ? 'pending-local-commit' : (liveCheck?.expectedVersion || commit),
  actualVersion: liveCheck?.actualVersion || liveFingerprint?.actualVersion || liveFingerprint?.versionHeader || null,
  liveBranch,
  deployBranchMismatch,
  requiresDeployBranchConfirmation,
  deployBranchMismatchReason: deployBranchMismatch
    ? `Local deploy branch ${branch} differs from live branch ${liveBranch}; approval must cover deploying this branch to production.`
    : null,
  liveReadinessHeader: liveCheck?.liveReadinessHeader || liveFingerprint?.readinessHeader || null,
  liveStatus: liveCheck?.liveStatus ?? liveFingerprint?.status ?? null,
  appUrl: liveCheck?.appUrl || liveFingerprint?.url || null,
  changedFileCount: deployRelevantFiles.length,
  deployReviewBaseRef: changeSet.baseRef,
  deployReviewBaseCommit: changeSet.baseCommit,
  deployReviewBaseSource: changeSet.baseSource,
  deployRelevantFiles,
  committedDeployRelevantFiles: changeSet.committedFiles,
  deployRelevantDirtyFiles,
  changedFileGroups,
  highRiskFileCount: highRiskFiles.length,
  highRiskFiles,
  highRiskDiffStats,
  highRiskFileReasons,
  postDeployProofRequired: true,
  proofRunnerRequiresPostDeployLive: true,
  deployPreflightRequiredPasses,
  expectedDeployBlockerAfterRequiredPasses: 'stale-production-deploy',
  postDeployProofReadinessGuards,
  postDeployStripeWebhookSmokeApprovalPhrase,
  postDeploySmokeCleanupApplyApprovalPhrase,
  postDeployProofSteps,
  postDeployProofExpectedArtifacts: [
    'call record',
    'generated summary',
    'owner email alert',
    'callback task',
    'dashboard proof counters',
  ],
  changedFiles: deployRelevantFiles.slice(0, 25),
  changedFilesTruncated: deployRelevantFiles.length > 25,
  command: deployCommand,
  reason: `After explicit ${deployApprovalToken} approval, deploy local HEAD to Railway so live matches the current code before the real proof-call verification run.`
}, null, 2));
