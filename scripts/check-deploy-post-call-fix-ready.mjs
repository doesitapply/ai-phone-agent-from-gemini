#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

function run(command, args) {
  try {
    const output = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { ok: true, output };
  } catch (error) {
    const stdout = String(error?.stdout || '').trim();
    const stderr = String(error?.stderr || '').trim();
    const message = String(error?.message || '').trim();
    const parts = [];
    if (stdout) parts.push(stdout);
    if (stderr && !stderr.startsWith('Command failed:')) parts.push(stderr);
    if (!parts.length && message) parts.push(message);
    return {
      ok: false,
      output: parts.join('\n\n').trim(),
    };
  }
}

function checkDeployGuidanceSafety() {
  const files = [
    'scripts/check-live-deploy-readiness.mjs',
    'scripts/check-railway-db-wiring.mjs',
    'scripts/check-live-is-current.mjs',
    'scripts/wait-for-live-current.mjs',
  ];
  const failures = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (/\.\/deploy\.sh|bash deploy\.sh|railway up --detach/.test(text)) {
      failures.push(`${file}: operator-facing remediation must use the confirmed deploy command, not direct deploy helpers`);
    }
  }
  return {
    ok: failures.length === 0,
    output: failures.length ? failures.join('\n') : 'OK deploy guidance uses the confirmed deploy command',
  };
}

const railway = run('npm', ['run', '-s', 'check:railway']);
const proofDocs = run('npm', ['run', '-s', 'check:real-call-docs']);
const targetSafety = run('npm', ['run', '-s', 'check:real-call-target-safety']);
const allowlistSafety = run('npm', ['run', '-s', 'check:test-call-allowlist-safety']);
const noTextingCopy = run('npm', ['run', '-s', 'check:no-texting-copy']);
const firstDollarOfferScope = run('npm', ['run', '-s', 'check:first-dollar-offer-scope']);
const smirkOpsCopy = run('npm', ['run', '-s', 'check:smirk-ops-copy']);
const callFlow = run('npm', ['run', '-s', 'check:call-flow']);
const firstDollarGuardCoverage = run('npm', ['run', '-s', 'check:first-dollar-guard-coverage']);
const openApi = run('npm', ['run', '-s', 'check:openapi']);
const authRegression = run('npm', ['run', '-s', 'check:auth']);
const paidHandoffSafety = run('npm', ['run', '-s', 'check:paid-handoff-safety']);
const selfServeActivation = run('npm', ['run', '-s', 'check:self-serve-activation']);
const clientOnboardingIntake = run('npm', ['run', '-s', 'check:client-onboarding-intake']);
const stripeWebhookPreflight = run('npm', ['run', '-s', 'check:stripe-webhook-handoff-live:preflight']);
const stripeWebhookApprovalReady = run('npm', ['run', '-s', 'check:stripe-webhook-smoke-approval-ready']);
const operationalAuthLive = run('npm', ['run', '-s', 'check:operational-auth-live']);
const branchReconcileApproval = run('npm', ['run', '-s', 'check:branch-reconcile-approval']);
const branchSyncConflictForecast = run('npm', ['run', '-s', 'check:branch-sync-conflict-forecast']);
const proofArtifactsLive = run('npm', ['run', '-s', 'check:proof-artifacts-live']);
const postCallIntelligenceLive = run('npm', ['run', '-s', 'check:post-call-intelligence-live']);
const webhookBuffer = run('npm', ['run', '-s', 'check:webhook-buffer']);
const deployGuidanceSafety = checkDeployGuidanceSafety();
const handoffSafety = run('npm', ['run', '-s', 'check:deploy-approval-handoff']);
const live = run('npm', ['run', '-s', 'check:live-is-current']);
const gitFetch = run('git', ['fetch', 'origin', 'main']);

let liveParsed = null;
try {
  liveParsed = live.output ? JSON.parse(live.output) : null;
} catch {
  liveParsed = null;
}
const liveFingerprint = liveParsed?.detail || liveParsed || null;

const localCommit = run('git', ['rev-parse', 'HEAD']);
const branch = run('git', ['branch', '--show-current']);
const remoteCommit = run('git', ['rev-parse', 'origin/main']);
const mergeBase = run('git', ['merge-base', 'HEAD', 'origin/main']);
const status = run('git', ['status', '--porcelain']);
const dirtyFiles = status.ok
  ? status.output.split(/\r?\n/).filter((line) => line.trim()).flatMap((line) => {
      const file = line.replace(/^.{1,2}\s+/, '').replace(/^.* -> /, '').trim();
      const statusCode = line.slice(0, 2).trim();
      if (statusCode === '??' && existsSync(file) && statSync(file).isDirectory()) {
        return execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', file], { encoding: 'utf8' })
          .split(/\r?\n/)
          .filter(Boolean)
          .map((entry) => `?? ${entry}`);
      }
      return [line];
    })
  : [];
const deployRelevantDirtyFiles = dirtyFiles.filter((line) => {
  const file = line.replace(/^.{1,2}\s+/, '').replace(/^.* -> /, '');
  return !file.startsWith('output/') && !file.startsWith('outputs/') && !file.startsWith('tmp/');
});
const hasDeployRelevantDirtyFiles = deployRelevantDirtyFiles.length > 0;
const liveFingerprintCurrent = live.ok;
const deployState = hasDeployRelevantDirtyFiles
  ? 'pending-local-deploy-work'
  : (!liveFingerprintCurrent ? 'stale-production-deploy' : 'live-already-current');
const gitRemoteSync = localCommit.ok && remoteCommit.ok && mergeBase.ok
  ? (localCommit.output === remoteCommit.output
      ? 'current'
      : (mergeBase.output === remoteCommit.output ? 'ahead' : (mergeBase.output === localCommit.output ? 'behind' : 'diverged')))
  : 'unknown';
const localBranchName = branch.ok ? branch.output : 'main';
const gitRemoteDiverged = gitRemoteSync === 'diverged';
const gitRemoteBehind = gitRemoteSync === 'behind';
const gitRemoteNeedsSync = gitRemoteBehind || gitRemoteDiverged;
const staleProductionExpected = !hasDeployRelevantDirtyFiles && !liveFingerprintCurrent && !gitRemoteNeedsSync;
const gitRemoteSyncDetail = gitRemoteDiverged
  ? `Local branch ${localBranchName || 'unknown'} at ${localCommit.ok ? localCommit.output : 'unknown'} is diverged from origin/main at ${remoteCommit.ok ? remoteCommit.output : 'unknown'}; reconcile before deploy or proof checks.`
  : (gitRemoteBehind
    ? `Local branch ${localBranchName || 'unknown'} at ${localCommit.ok ? localCommit.output : 'unknown'} is behind origin/main at ${remoteCommit.ok ? remoteCommit.output : 'unknown'}; synchronize before deploy or proof checks.`
    : null);
const railwayAuthMissing = !railway.ok && /Railway auth missing/i.test(railway.output || '');
const railwayAuthInvalid = !railway.ok && !railwayAuthMissing;
const needsDeploy = hasDeployRelevantDirtyFiles || !live.ok;
const liveProofInspectionBlockedByDeploy = needsDeploy && !gitRemoteNeedsSync;
const branchSyncConflictForecastStatus = gitRemoteNeedsSync
  ? (branchSyncConflictForecast.ok ? 'pass' : 'fail')
  : 'not-needed';
const deployCommand = localBranchName && localBranchName !== 'main'
  ? `CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix CONFIRM_SMIRK_DEPLOY_BRANCH=${localBranchName} npm run deploy:post-call-fix`
  : 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix npm run deploy:post-call-fix';
const stripeWebhookSmokeApprovalPhrase = 'APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE: ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live';
const smokeCleanupApplyApprovalPhrase = 'APPROVE_SMIRK_SMOKE_CLEANUP_APPLY: APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply';
const blockerChecks = [
  [!proofDocs.ok, 'real-proof-call-docs-drift'],
  [!targetSafety.ok, 'real-proof-call-target-safety-drift'],
  [!allowlistSafety.ok, 'test-call-allowlist-safety-drift'],
  [!noTextingCopy.ok, 'no-texting-copy-drift'],
  [!firstDollarOfferScope.ok, 'first-dollar-offer-scope-drift'],
  [!smirkOpsCopy.ok, 'smirk-ops-copy-drift'],
  [!callFlow.ok, 'call-flow-contract-drift'],
  [!firstDollarGuardCoverage.ok, 'first-dollar-guard-coverage-drift'],
  [!openApi.ok, 'openapi-route-inventory-drift'],
  [!authRegression.ok, 'auth-regression-drift'],
  [!paidHandoffSafety.ok, 'paid-handoff-safety-drift'],
  [!selfServeActivation.ok, 'self-serve-activation-drift'],
  [!clientOnboardingIntake.ok, 'client-onboarding-intake-drift'],
  [!stripeWebhookPreflight.ok, 'stripe-webhook-handoff-preflight-drift'],
  [!staleProductionExpected && !stripeWebhookApprovalReady.ok, 'stripe-webhook-smoke-approval-handoff-drift'],
  [!liveProofInspectionBlockedByDeploy && !operationalAuthLive.ok, 'operational-auth-live-drift'],
  [!branchReconcileApproval.ok, 'branch-reconcile-approval-drift'],
  [gitRemoteNeedsSync && !branchSyncConflictForecast.ok, 'branch-sync-conflict-forecast'],
  [gitRemoteBehind, 'git-remote-behind'],
  [gitRemoteDiverged, 'git-remote-diverged'],
  [!liveProofInspectionBlockedByDeploy && !proofArtifactsLive.ok, 'proof-artifacts-live-drift'],
  [!liveProofInspectionBlockedByDeploy && !postCallIntelligenceLive.ok, 'post-call-intelligence-live-drift'],
  [!webhookBuffer.ok, 'webhook-buffer-contract-drift'],
  [!deployGuidanceSafety.ok, 'deploy-guidance-safety-drift'],
  [!handoffSafety.ok, 'deploy-approval-handoff-drift'],
  [railwayAuthMissing, 'railway-auth-missing'],
  [railwayAuthInvalid, 'railway-auth-invalid'],
];
const blocker = blockerChecks.find(([failed]) => failed)?.[1] || (needsDeploy ? 'stale-production-deploy' : 'live-already-current');
const blockerDetail = gitRemoteNeedsSync
  ? gitRemoteSyncDetail
  : (hasDeployRelevantDirtyFiles && liveFingerprintCurrent
    ? 'Live fingerprint matches local HEAD, but deploy-relevant working-tree changes still need explicit approval and shipping before Stripe smoke or proof-call approval.'
    : (!liveFingerprintCurrent
      ? 'Live Railway fingerprint does not match local HEAD yet.'
      : 'Live fingerprint is current and deploy-relevant working tree is clean.'));
const out = {
  ok: proofDocs.ok &&
    targetSafety.ok &&
    allowlistSafety.ok &&
    noTextingCopy.ok &&
    firstDollarOfferScope.ok &&
    smirkOpsCopy.ok &&
    callFlow.ok &&
    firstDollarGuardCoverage.ok &&
    openApi.ok &&
    authRegression.ok &&
    paidHandoffSafety.ok &&
    selfServeActivation.ok &&
    clientOnboardingIntake.ok &&
    stripeWebhookPreflight.ok &&
    (stripeWebhookApprovalReady.ok || staleProductionExpected) &&
    (operationalAuthLive.ok || liveProofInspectionBlockedByDeploy) &&
    branchReconcileApproval.ok &&
    (!gitRemoteNeedsSync || branchSyncConflictForecast.ok) &&
    (proofArtifactsLive.ok || liveProofInspectionBlockedByDeploy) &&
    (postCallIntelligenceLive.ok || liveProofInspectionBlockedByDeploy) &&
    webhookBuffer.ok &&
    deployGuidanceSafety.ok &&
    handoffSafety.ok &&
    railway.ok &&
    needsDeploy &&
    !gitRemoteNeedsSync,
  blocker,
  proofDocs: proofDocs.ok ? 'pass' : 'fail',
  targetSafety: targetSafety.ok ? 'pass' : 'fail',
  allowlistSafety: allowlistSafety.ok ? 'pass' : 'fail',
  noTextingCopy: noTextingCopy.ok ? 'pass' : 'fail',
  firstDollarOfferScope: firstDollarOfferScope.ok ? 'pass' : 'fail',
  smirkOpsCopy: smirkOpsCopy.ok ? 'pass' : 'fail',
  callFlow: callFlow.ok ? 'pass' : 'fail',
  firstDollarGuardCoverage: firstDollarGuardCoverage.ok ? 'pass' : 'fail',
  openApi: openApi.ok ? 'pass' : 'fail',
  authRegression: authRegression.ok ? 'pass' : 'fail',
  paidHandoffSafety: paidHandoffSafety.ok ? 'pass' : 'fail',
  selfServeActivation: selfServeActivation.ok ? 'pass' : 'fail',
  clientOnboardingIntake: clientOnboardingIntake.ok ? 'pass' : 'fail',
  stripeWebhookPreflight: stripeWebhookPreflight.ok ? 'pass' : 'fail',
  stripeWebhookApprovalReady: stripeWebhookApprovalReady.ok ? 'pass' : 'fail',
  operationalAuthLive: operationalAuthLive.ok ? 'pass' : (liveProofInspectionBlockedByDeploy ? 'blocked-until-deploy' : 'fail'),
  branchReconcileApproval: branchReconcileApproval.ok ? 'pass' : 'fail',
  branchSyncConflictForecast: branchSyncConflictForecastStatus,
  proofArtifactsLive: proofArtifactsLive.ok ? 'pass' : (liveProofInspectionBlockedByDeploy ? 'blocked-until-deploy' : 'fail'),
  postCallIntelligenceLive: postCallIntelligenceLive.ok ? 'pass' : (liveProofInspectionBlockedByDeploy ? 'blocked-until-deploy' : 'fail'),
  webhookBuffer: webhookBuffer.ok ? 'pass' : 'fail',
  deployGuidanceSafety: deployGuidanceSafety.ok ? 'pass' : 'fail',
  handoffSafety: handoffSafety.ok ? 'pass' : 'fail',
  railwayAccess: railway.ok ? 'pass' : 'fail',
  liveCurrent: live.ok && !hasDeployRelevantDirtyFiles ? 'pass' : 'stale',
  deployState,
  blockerDetail,
  liveFingerprintCurrent,
  localDeployClean: !hasDeployRelevantDirtyFiles,
  deployRelevantDirtyFiles,
  requiresApproval: railway.ok,
  localBranch: localBranchName || null,
  localCommit: localCommit.ok ? localCommit.output : null,
  remoteBranch: 'origin/main',
  remoteCommit: remoteCommit.ok ? remoteCommit.output : null,
  gitRemoteSync,
  gitRemoteSyncHelp: gitRemoteNeedsSync
    ? [
        'git stash push -u -m "smirk-deploy-divergence"',
        'git pull --rebase origin main',
        'git stash pop',
        deployCommand
      ]
    : null,
  expectedVersion: hasDeployRelevantDirtyFiles ? 'pending-local-commit' : (liveParsed?.expectedVersion || liveFingerprint?.expectedVersion || (localCommit.ok ? localCommit.output : null)),
  actualVersion: liveParsed?.actualVersion || liveFingerprint?.actualVersion || liveFingerprint?.versionHeader || null,
  liveBranch: liveParsed?.actualBranch || liveFingerprint?.actualBranch || liveFingerprint?.branchHeader || null,
  liveReadinessHeader: liveFingerprint?.readinessHeader || null,
  deployCommand,
  postDeployStripeWebhookSmokeApprovalPhrase: stripeWebhookSmokeApprovalPhrase,
  postDeploySmokeCleanupApplyApprovalPhrase: smokeCleanupApplyApprovalPhrase,
  authSetupCommand: (railwayAuthMissing || railwayAuthInvalid) ? 'npm run -s print:railway-auth-setup' : null,
  authOpenTokenPageCommand: (railwayAuthMissing || railwayAuthInvalid) ? 'npm run -s open:railway-token-page' : null,
  authStatusCommand: (railwayAuthMissing || railwayAuthInvalid) ? 'npm run -s print:railway-auth-status' : null,
  authInitCommand: (railwayAuthMissing || railwayAuthInvalid) ? 'npm run -s init:railway-auth-file' : null,
  authBootstrapCommand: (railwayAuthMissing || railwayAuthInvalid)
    ? "printf '%s' '<real-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth"
    : null,
  authReplaceCommand: railwayAuthInvalid
    ? "printf '%s' '<real-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth"
    : null,
  authOneShotCommand: (railwayAuthMissing || railwayAuthInvalid)
    ? "printf '%s' '<real-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth-and-deploy"
    : null,
  authReplaceAndDeployCommand: railwayAuthInvalid
    ? "printf '%s' '<real-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth-and-deploy"
    : null,
  authPrimaryCommand: (railwayAuthMissing || railwayAuthInvalid)
    ? 'npm run -s bootstrap:railway-auth-open-page-watch-clipboard-and-deploy'
    : null,
  authRecommendedSequence: railwayAuthInvalid
    ? [
        'npm run -s open:railway-token-page',
        "printf '%s' '<real-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth",
        'npm run -s check:deploy-post-call-fix-ready',
        'npm run write:deploy-approval-bundle',
        deployCommand
      ]
    : (railwayAuthMissing
      ? ['npm run -s bootstrap:railway-auth-open-page-watch-clipboard-and-deploy']
      : null),
  authNextSteps: (railwayAuthMissing || railwayAuthInvalid)
    ? [
        'npm run -s check:railway',
        'npm run -s check:deploy-post-call-fix-ready',
        'npm run write:deploy-approval-bundle',
        deployCommand
      ]
    : null,
  nextAction: railwayAuthMissing
    ? 'Run npm run -s bootstrap:railway-auth-open-page-watch-clipboard-and-deploy, then copy a real Railway token when the page opens; the helper will run auth checks, generate the approval bundle, and deploy.'
    : (railwayAuthInvalid
      ? 'Replace the invalid Railway token, then rerun deploy readiness, generate the approval bundle, and deploy.'
      : (gitRemoteNeedsSync
        ? 'Synchronize local branch with origin/main before deploy.'
        : (railway.ok && needsDeploy ? `Generate the approval bundle, get approval, then run ${deployCommand}` : null))),
  approvalBundleCommand: (railwayAuthMissing || railwayAuthInvalid || (railway.ok && needsDeploy)) ? 'npm run write:deploy-approval-bundle' : null,
  approvalBundlePath: (railwayAuthMissing || railwayAuthInvalid || (railway.ok && needsDeploy)) ? 'output/deploy-approval-bundle.json' : null,
  proofDocsDetail: proofDocs.output || null,
  targetSafetyDetail: targetSafety.output || null,
  allowlistSafetyDetail: allowlistSafety.output || null,
  noTextingCopyDetail: noTextingCopy.output || null,
  firstDollarOfferScopeDetail: firstDollarOfferScope.output || null,
  smirkOpsCopyDetail: smirkOpsCopy.output || null,
  callFlowDetail: callFlow.output || null,
  firstDollarGuardCoverageDetail: firstDollarGuardCoverage.output || null,
  openApiDetail: openApi.output || null,
  authRegressionDetail: authRegression.output || null,
  paidHandoffSafetyDetail: paidHandoffSafety.output || null,
  selfServeActivationDetail: selfServeActivation.output || null,
  clientOnboardingIntakeDetail: clientOnboardingIntake.output || null,
  stripeWebhookPreflightDetail: stripeWebhookPreflight.output || null,
  stripeWebhookApprovalReadyDetail: stripeWebhookApprovalReady.output || null,
  operationalAuthLiveDetail: operationalAuthLive.output || null,
  branchSyncConflictForecastDetail: branchSyncConflictForecast.output || null,
  proofArtifactsLiveDetail: proofArtifactsLive.output || null,
  postCallIntelligenceLiveDetail: postCallIntelligenceLive.output || null,
  webhookBufferDetail: webhookBuffer.output || null,
  deployGuidanceSafetyDetail: deployGuidanceSafety.output || null,
  handoffSafetyDetail: handoffSafety.output || null,
  railwayDetail: railway.output || null,
  liveDetail: liveParsed || live.output || null,
  gitFetchDetail: gitFetch.output || null,
};

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
