#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

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
const changedFiles = execFileSync('git', ['status', '--short'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter((line) => line.trim());

const changedFilePaths = changedFiles.flatMap((line) => {
  const file = line.replace(/^.{1,2}\s+/, '').replace(/^.* -> /, '').trim();
  const status = line.slice(0, 2).trim();
  if (status === '??' && existsSync(file) && statSync(file).isDirectory()) {
    return execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', file], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean);
  }
  return [file];
});
const deployRelevantDirtyFiles = changedFilePaths.filter((file) => !file.startsWith('output/') && !file.startsWith('outputs/') && !file.startsWith('tmp/'));
const hasDeployRelevantDirtyFiles = deployRelevantDirtyFiles.length > 0;

const changedFileGroups = changedFilePaths.reduce((acc, file) => {
  if (file.startsWith('scripts/')) acc.scripts += 1;
  else if (file.startsWith('src/') || file === 'server.ts' || file === 'package.json' || file === 'deploy.sh') acc.app += 1;
  else if (file.startsWith('output/') || file.startsWith('outputs/')) acc.output += 1;
  else if (file.endsWith('.md') || file === '.env.example') acc.docs += 1;
  else acc.other += 1;
  return acc;
}, { docs: 0, scripts: 0, app: 0, output: 0, other: 0 });

const highRiskFiles = deployRelevantDirtyFiles;

const highRiskDiffStats = highRiskFiles.map((file) => {
  try {
    const raw = execFileSync('git', ['diff', '--numstat', '--', file], { encoding: 'utf8' }).trim();
    if (!raw && existsSync(file) && statSync(file).isFile()) {
      const text = readFileSync(file, 'utf8');
      return {
        file,
        added: text.split(/\r?\n/).length,
        removed: 0,
      };
    }
    const [added, removed] = raw.split(/\s+/);
    return {
      file,
      added: Number(added || 0),
      removed: Number(removed || 0),
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

let liveCheck = null;
try {
  const raw = execFileSync('npm', ['run', '-s', 'check:live-is-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  liveCheck = raw ? JSON.parse(raw) : null;
} catch (error) {
  const text = String(error?.stdout || error?.stderr || '').trim();
  try {
    liveCheck = text ? JSON.parse(text) : null;
  } catch {
    liveCheck = text ? { raw: text } : null;
  }
}

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
  ? `CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix CONFIRM_SMIRK_DEPLOY_BRANCH=${branch} npm run deploy:post-call-fix`
  : 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix npm run deploy:post-call-fix';
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
  'clientOnboardingIntake',
  'customerDashboard',
  'stripeWebhookPreflight',
  'stripeWebhookApprovalReady',
  'operationalAuthLive',
  ...(branchReconcileRequired ? ['branchSyncConflictForecast'] : []),
  'proofArtifactsLive',
  'postCallIntelligenceLive',
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
  changedFileCount: changedFiles.length,
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
  changedFiles: changedFiles.slice(0, 25),
  changedFilesTruncated: changedFiles.length > 25,
  command: deployCommand,
  reason: `After explicit ${deployApprovalToken} approval, deploy local HEAD to Railway so live matches the current code before the real proof-call verification run.`
}, null, 2));
