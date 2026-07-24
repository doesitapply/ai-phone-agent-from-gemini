#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { buildExactDeployCommand } from './lib/deploy-command.mjs';
import { analyzeDeployRemoteSync } from './lib/git-deploy-sync.mjs';

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
const billingLifecycle = run('npm', ['run', '-s', 'check:billing-lifecycle']);
const realRevenueContract = run('npm', ['run', '-s', 'check:real-revenue-contract']);
const clientOnboardingIntake = run('npm', ['run', '-s', 'check:client-onboarding-intake']);
const stripeWebhookPreflight = run('npm', ['run', '-s', 'check:stripe-webhook-handoff-live:preflight']);
const stripeWebhookApprovalReady = run('npm', ['run', '-s', 'check:stripe-webhook-smoke-approval-ready']);
const operationalAuthLive = run('npm', ['run', '-s', 'check:operational-auth-live']);
const branchReconcileApproval = run('npm', ['run', '-s', 'check:branch-reconcile-approval']);
const proofArtifactsLive = run('npm', ['run', '-s', 'check:proof-artifacts-live']);
const postCallIntelligenceLive = run('npm', ['run', '-s', 'check:post-call-intelligence-live']);
const webhookBuffer = run('npm', ['run', '-s', 'check:webhook-buffer']);
const postCallDurability = run('npm', ['run', '-s', 'check:post-call-durability']);
const deployGuidanceSafety = checkDeployGuidanceSafety();
const handoffSafety = run('npm', ['run', '-s', 'check:deploy-approval-handoff']);
const live = run('npm', ['run', '-s', 'check:live-is-current']);
const pendingFirstDollarEnvInspection = run('npm', ['run', '-s', 'print:first-dollar-pending-env-activation']);
const gitFetch = run('git', ['fetch', 'origin', 'main']);

let liveParsed = null;
try {
  liveParsed = live.output ? JSON.parse(live.output) : null;
} catch {
  liveParsed = null;
}
const liveFingerprint = liveParsed?.detail || liveParsed || null;
let pendingFirstDollarEnvParsed = null;
try {
  pendingFirstDollarEnvParsed = pendingFirstDollarEnvInspection.output
    ? JSON.parse(pendingFirstDollarEnvInspection.output)
    : null;
} catch {
  pendingFirstDollarEnvParsed = null;
}
const pendingFirstDollarEnvInspectionOk = pendingFirstDollarEnvInspection.ok && pendingFirstDollarEnvParsed?.ok === true;
const pendingFirstDollarEnvStaged = pendingFirstDollarEnvInspectionOk && pendingFirstDollarEnvParsed?.pending === true;

const localCommit = run('git', ['rev-parse', 'HEAD']);
const branch = run('git', ['branch', '--show-current']);
const localBranchName = branch.ok ? branch.output : 'main';
const gitFetchTarget = localBranchName && localBranchName !== 'main'
  ? run('git', ['fetch', 'origin', localBranchName])
  : { ok: true, output: '' };
const gitRemoteAnalysis = analyzeDeployRemoteSync({
  localBranch: localBranchName,
  localCommit: localCommit.ok ? localCommit.output : null,
  resolveRemoteCommit: (remoteRef) => {
    const result = run('git', ['rev-parse', remoteRef]);
    return result.ok ? result.output : null;
  },
  resolveMergeBase: (_commit, remoteRef) => {
    const result = run('git', ['merge-base', 'HEAD', remoteRef]);
    return result.ok ? result.output : null;
  },
});
const remoteCommit = {
  ok: Boolean(gitRemoteAnalysis.remoteCommit),
  output: gitRemoteAnalysis.remoteCommit || '',
};
const remoteRef = gitRemoteAnalysis.remoteRef;
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
// Git status already respects .gitignore. Every reported path can change the
// exact deploy and must block a clean-commit approval. A status failure must
// fail closed rather than masquerade as a clean worktree.
const deployRelevantDirtyFiles = status.ok ? dirtyFiles : ['<git-status-unavailable>'];
const hasDeployRelevantDirtyFiles = deployRelevantDirtyFiles.length > 0;
const liveFingerprintCurrent = live.ok;
const deployState = pendingFirstDollarEnvStaged
  ? 'pending-first-dollar-env-activation-deploy'
  : (hasDeployRelevantDirtyFiles
  ? 'pending-local-deploy-work'
  : (!liveFingerprintCurrent ? 'stale-production-deploy' : 'live-already-current'));
const gitRemoteSync = gitRemoteAnalysis.gitRemoteSync;
const gitRemoteDiverged = gitRemoteSync === 'diverged';
const gitRemoteBehind = gitRemoteSync === 'behind';
const gitRemoteNeedsSync = gitRemoteBehind || gitRemoteDiverged;
const branchSyncConflictForecast = gitRemoteNeedsSync
  ? run('env', [`SMIRK_BRANCH_SYNC_REMOTE=${remoteRef}`, 'npm', 'run', '-s', 'check:branch-sync-conflict-forecast'])
  : { ok: true, output: 'not-needed' };
const staleProductionExpected = !hasDeployRelevantDirtyFiles && !liveFingerprintCurrent && !gitRemoteNeedsSync;
const gitRemoteSyncDetail = gitRemoteDiverged
  ? `Local branch ${localBranchName || 'unknown'} at ${localCommit.ok ? localCommit.output : 'unknown'} is diverged from ${remoteRef} at ${remoteCommit.ok ? remoteCommit.output : 'unknown'}; reconcile before deploy or proof checks.`
  : (gitRemoteBehind
    ? `Local branch ${localBranchName || 'unknown'} at ${localCommit.ok ? localCommit.output : 'unknown'} is behind ${remoteRef} at ${remoteCommit.ok ? remoteCommit.output : 'unknown'}; synchronize before deploy or proof checks.`
    : null);
const railwayAuthMissing = !railway.ok && /Railway auth missing/i.test(railway.output || '');
const railwayAuthInvalid = !railway.ok && !railwayAuthMissing;
const needsDeploy = pendingFirstDollarEnvStaged || hasDeployRelevantDirtyFiles || !live.ok;
const liveProofInspectionBlockedByDeploy = needsDeploy && !gitRemoteNeedsSync;
const stripeWebhookApprovalReadyStatus = liveProofInspectionBlockedByDeploy
  ? 'blocked-until-deploy'
  : (stripeWebhookApprovalReady.ok ? 'pass' : 'fail');
const branchSyncConflictForecastStatus = gitRemoteNeedsSync
  ? (branchSyncConflictForecast.ok ? 'pass' : 'fail')
  : 'not-needed';
const deployCommand = pendingFirstDollarEnvStaged
  ? pendingFirstDollarEnvParsed.activationCommand
  : buildExactDeployCommand({ branch: localBranchName, commit: localCommit.output });
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
  [!billingLifecycle.ok, 'billing-lifecycle-drift'],
  [!realRevenueContract.ok, 'real-revenue-contract-drift'],
  [!clientOnboardingIntake.ok, 'client-onboarding-intake-drift'],
  [!stripeWebhookPreflight.ok, 'stripe-webhook-handoff-preflight-drift'],
  [!branchReconcileApproval.ok, 'branch-reconcile-approval-drift'],
  [gitRemoteNeedsSync && !branchSyncConflictForecast.ok, 'branch-sync-conflict-forecast'],
  [gitRemoteBehind, 'git-remote-behind'],
  [gitRemoteDiverged, 'git-remote-diverged'],
  [!staleProductionExpected && !stripeWebhookApprovalReady.ok, 'stripe-webhook-smoke-approval-handoff-drift'],
  [!liveProofInspectionBlockedByDeploy && !operationalAuthLive.ok, 'operational-auth-live-drift'],
  [!liveProofInspectionBlockedByDeploy && !proofArtifactsLive.ok, 'proof-artifacts-live-drift'],
  [!liveProofInspectionBlockedByDeploy && !postCallIntelligenceLive.ok, 'post-call-intelligence-live-drift'],
  [!webhookBuffer.ok, 'webhook-buffer-contract-drift'],
  [!postCallDurability.ok, 'post-call-durability-drift'],
  [!deployGuidanceSafety.ok, 'deploy-guidance-safety-drift'],
  [!handoffSafety.ok, 'deploy-approval-handoff-drift'],
  [!pendingFirstDollarEnvInspectionOk, 'pending-first-dollar-env-inspection-failed'],
  [railwayAuthMissing, 'railway-auth-missing'],
  [railwayAuthInvalid, 'railway-auth-invalid'],
];
const blocker = blockerChecks.find(([failed]) => failed)?.[1]
  || (pendingFirstDollarEnvStaged ? 'pending-first-dollar-env-activation-deploy' : (needsDeploy ? 'stale-production-deploy' : 'live-already-current'));
const blockerDetail = gitRemoteNeedsSync
  ? gitRemoteSyncDetail
  : (pendingFirstDollarEnvStaged
    ? 'A digest-bound first-dollar environment manifest is staged with --skip-deploys; the separately approved exact activation deploy is required even though the source commit is already live.'
    : (hasDeployRelevantDirtyFiles && liveFingerprintCurrent
    ? 'Live fingerprint matches local HEAD, but deploy-relevant working-tree changes still need explicit approval and shipping before Stripe smoke or proof-call approval.'
    : (!liveFingerprintCurrent
      ? 'Live Railway fingerprint does not match local HEAD yet.'
      : 'Live fingerprint is current and deploy-relevant working tree is clean.')));
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
    billingLifecycle.ok &&
    realRevenueContract.ok &&
    clientOnboardingIntake.ok &&
    stripeWebhookPreflight.ok &&
    (stripeWebhookApprovalReady.ok || staleProductionExpected) &&
    (operationalAuthLive.ok || liveProofInspectionBlockedByDeploy) &&
    branchReconcileApproval.ok &&
    (!gitRemoteNeedsSync || branchSyncConflictForecast.ok) &&
    (proofArtifactsLive.ok || liveProofInspectionBlockedByDeploy) &&
    (postCallIntelligenceLive.ok || liveProofInspectionBlockedByDeploy) &&
    webhookBuffer.ok &&
    postCallDurability.ok &&
    deployGuidanceSafety.ok &&
    handoffSafety.ok &&
    pendingFirstDollarEnvInspectionOk &&
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
  billingLifecycle: billingLifecycle.ok ? 'pass' : 'fail',
  realRevenueContract: realRevenueContract.ok ? 'pass' : 'fail',
  clientOnboardingIntake: clientOnboardingIntake.ok ? 'pass' : 'fail',
  stripeWebhookPreflight: stripeWebhookPreflight.ok ? 'pass' : 'fail',
  stripeWebhookApprovalReady: stripeWebhookApprovalReadyStatus,
  operationalAuthLive: liveProofInspectionBlockedByDeploy ? 'blocked-until-deploy' : (operationalAuthLive.ok ? 'pass' : 'fail'),
  branchReconcileApproval: branchReconcileApproval.ok ? 'pass' : 'fail',
  branchSyncConflictForecast: branchSyncConflictForecastStatus,
  proofArtifactsLive: proofArtifactsLive.ok ? 'pass' : (liveProofInspectionBlockedByDeploy ? 'blocked-until-deploy' : 'fail'),
  postCallIntelligenceLive: postCallIntelligenceLive.ok ? 'pass' : (liveProofInspectionBlockedByDeploy ? 'blocked-until-deploy' : 'fail'),
  webhookBuffer: webhookBuffer.ok ? 'pass' : 'fail',
  postCallDurability: postCallDurability.ok ? 'pass' : 'fail',
  deployGuidanceSafety: deployGuidanceSafety.ok ? 'pass' : 'fail',
  handoffSafety: handoffSafety.ok ? 'pass' : 'fail',
  pendingFirstDollarEnvInspection: pendingFirstDollarEnvInspectionOk ? 'pass' : 'fail',
  pendingFirstDollarEnvStaged,
  pendingFirstDollarEnvManifest: pendingFirstDollarEnvStaged ? pendingFirstDollarEnvParsed.manifest : null,
  railwayAccess: railway.ok ? 'pass' : 'fail',
  liveCurrent: live.ok && !hasDeployRelevantDirtyFiles && !pendingFirstDollarEnvStaged ? 'pass' : (pendingFirstDollarEnvStaged ? 'pending-env-activation' : 'stale'),
  deployState,
  blockerDetail,
  liveFingerprintCurrent,
  localDeployClean: !hasDeployRelevantDirtyFiles,
  deployRelevantDirtyFiles,
  requiresApproval: railway.ok,
  localBranch: localBranchName || null,
  localCommit: localCommit.ok ? localCommit.output : null,
  remoteBranch: remoteRef,
  remoteCommit: remoteCommit.ok ? remoteCommit.output : null,
  remoteStates: gitRemoteAnalysis.remotes,
  gitRemoteSync,
  gitRemoteSyncHelp: gitRemoteNeedsSync
    ? [
        `SMIRK_BRANCH_SYNC_REMOTE=${remoteRef} npm run -s check:branch-sync-conflict-forecast`,
        `git pull --rebase ${gitRemoteAnalysis.remoteName} ${gitRemoteAnalysis.remoteBranch}`,
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
        ? `Synchronize local branch with ${remoteRef} before deploy.`
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
  billingLifecycleDetail: billingLifecycle.output || null,
  realRevenueContractDetail: realRevenueContract.output || null,
  clientOnboardingIntakeDetail: clientOnboardingIntake.output || null,
  stripeWebhookPreflightDetail: stripeWebhookPreflight.output || null,
  stripeWebhookApprovalReadyDetail: stripeWebhookApprovalReady.output || null,
  operationalAuthLiveDetail: operationalAuthLive.output || null,
  branchSyncConflictForecastDetail: branchSyncConflictForecast.output || null,
  proofArtifactsLiveDetail: proofArtifactsLive.output || null,
  postCallIntelligenceLiveDetail: postCallIntelligenceLive.output || null,
  webhookBufferDetail: webhookBuffer.output || null,
  postCallDurabilityDetail: postCallDurability.output || null,
  deployGuidanceSafetyDetail: deployGuidanceSafety.output || null,
  handoffSafetyDetail: handoffSafety.output || null,
  pendingFirstDollarEnvInspectionDetail: pendingFirstDollarEnvParsed || pendingFirstDollarEnvInspection.output || null,
  railwayDetail: railway.output || null,
  liveDetail: liveParsed || live.output || null,
  gitFetchDetail: [gitFetch.output, gitFetchTarget.output].filter(Boolean).join('\n') || null,
};

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
