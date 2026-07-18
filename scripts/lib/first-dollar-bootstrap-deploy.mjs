export const FIRST_DOLLAR_BOOTSTRAP_MODE_ENV = 'SMIRK_FIRST_DOLLAR_ENV_BOOTSTRAP_DEPLOY';
export const DEPLOY_CONFIRMATION_ENV = 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY';
export const DEPLOY_BRANCH_CONFIRMATION_ENV = 'CONFIRM_SMIRK_DEPLOY_BRANCH';
export const DEPLOY_COMMIT_CONFIRMATION_ENV = 'CONFIRM_SMIRK_DEPLOY_COMMIT';

export const REQUIRED_BOOTSTRAP_PREFLIGHT_PASSES = Object.freeze([
  'proofDocs',
  'targetSafety',
  'allowlistSafety',
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
  'realRevenueContract',
  'clientOnboardingIntake',
  'stripeWebhookPreflight',
  'stripeWebhookApprovalReady',
  'operationalAuthLive',
  'branchReconcileApproval',
  'webhookBuffer',
  'postCallDurability',
  'deployGuidanceSafety',
  'handoffSafety',
  'railwayAccess',
]);

const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const AUTHORITATIVE_PRODUCTION_HEALTH_URL = 'https://ai-phone-agent-production-6811.up.railway.app/health';

function pushFailure(failures, condition, message) {
  if (!condition) failures.push(message);
}

function isHealthyStaleFingerprint(preflight, targetCommit, targetBranch) {
  const live = preflight?.liveDetail;
  const detail = live?.detail;
  return live?.ok === false
    && live?.blocker === 'stale-production-deploy'
    && live?.appUrl === AUTHORITATIVE_PRODUCTION_HEALTH_URL
    && live?.expectedBranch === targetBranch
    && live?.expectedVersion === targetCommit
    && Number(live?.liveStatus) >= 200
    && Number(live?.liveStatus) < 300
    && live?.liveReadinessHeader === '1'
    && COMMIT_PATTERN.test(String(live?.actualVersion || ''))
    && detail?.ok === false
    && detail?.url === AUTHORITATIVE_PRODUCTION_HEALTH_URL
    && ['version-mismatch', 'branch-mismatch'].includes(detail?.failure)
    && Number(detail?.status) >= 200
    && Number(detail?.status) < 300
    && detail?.readinessHeader === '1'
    && detail?.actualVersion === live.actualVersion;
}

export function evaluateFirstDollarBootstrapDeploy({
  preflight,
  targetCommit,
  targetBranch,
  bootstrapMode,
  deployConfirmation,
  branchConfirmation,
  commitConfirmation,
}) {
  const failures = [];
  const normalizedCommit = String(targetCommit || '').trim();
  const normalizedBranch = String(targetBranch || '').trim();

  pushFailure(failures, COMMIT_PATTERN.test(normalizedCommit), 'target commit must be an exact 40-character Git commit');
  pushFailure(failures, normalizedBranch.length > 0, 'target branch must be explicit');
  pushFailure(
    failures,
    String(bootstrapMode || '').trim() === 'deploy-fail-closed-checkout',
    `${FIRST_DOLLAR_BOOTSTRAP_MODE_ENV} must equal deploy-fail-closed-checkout`,
  );
  pushFailure(failures, String(deployConfirmation || '').trim() === 'deploy-post-call-fix', `${DEPLOY_CONFIRMATION_ENV} must equal deploy-post-call-fix`);
  pushFailure(failures, String(branchConfirmation || '').trim() === normalizedBranch, `${DEPLOY_BRANCH_CONFIRMATION_ENV} must match the exact target branch`);
  pushFailure(failures, String(commitConfirmation || '').trim() === normalizedCommit, `${DEPLOY_COMMIT_CONFIRMATION_ENV} must match the exact target commit`);

  pushFailure(failures, preflight && typeof preflight === 'object' && !Array.isArray(preflight), 'guarded deploy preflight JSON is required');
  if (preflight && typeof preflight === 'object' && !Array.isArray(preflight)) {
    pushFailure(failures, preflight.ok === true, 'guarded deploy preflight must pass');
    pushFailure(failures, preflight.blocker === 'stale-production-deploy', 'guarded deploy preflight sole blocker must be stale-production-deploy');
    pushFailure(failures, preflight.deployState === 'stale-production-deploy', 'deploy state must be stale-production-deploy');
    pushFailure(failures, preflight.liveFingerprintCurrent === false, 'live fingerprint must be stale');
    pushFailure(failures, preflight.liveCurrent === 'stale', 'live-current preflight status must be stale');
    pushFailure(failures, preflight.localDeployClean === true, 'local deploy worktree must be clean');
    pushFailure(
      failures,
      Array.isArray(preflight.deployRelevantDirtyFiles) && preflight.deployRelevantDirtyFiles.length === 0,
      'preflight must report no deploy-relevant dirty files',
    );
    pushFailure(failures, preflight.localCommit === normalizedCommit, 'preflight local commit must match the exact target commit');
    pushFailure(failures, preflight.expectedVersion === normalizedCommit, 'preflight expected version must match the exact target commit');
    pushFailure(failures, preflight.localBranch === normalizedBranch, 'preflight local branch must match the exact target branch');
    pushFailure(failures, ['current', 'ahead'].includes(preflight.gitRemoteSync), 'target commit must not be behind or diverged from origin/main');
    pushFailure(failures, preflight.branchSyncConflictForecast === 'not-needed', 'branch conflict forecast must be not-needed for the exact deploy target');
    pushFailure(failures, preflight.requiresApproval === true, 'preflight must preserve explicit deploy approval');
    pushFailure(failures, isHealthyStaleFingerprint(preflight, normalizedCommit, normalizedBranch), 'stale production must be proven by a healthy authoritative live fingerprint mismatch');
    pushFailure(failures, preflight.proofArtifactsLive === 'blocked-until-deploy', 'proof artifacts must be blocked only by the stale deploy');
    pushFailure(failures, preflight.postCallIntelligenceLive === 'blocked-until-deploy', 'post-call intelligence must be blocked only by the stale deploy');

    for (const field of REQUIRED_BOOTSTRAP_PREFLIGHT_PASSES) {
      pushFailure(failures, preflight[field] === 'pass', `preflight ${field} must pass`);
    }
  }

  return {
    ok: failures.length === 0,
    mode: 'incomplete-first-dollar-env-bootstrap-deploy',
    targetBranch: normalizedBranch || null,
    targetCommit: COMMIT_PATTERN.test(normalizedCommit) ? normalizedCommit : null,
    requiredPasses: [...REQUIRED_BOOTSTRAP_PREFLIGHT_PASSES],
    failures,
  };
}
