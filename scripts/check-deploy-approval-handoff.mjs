#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { collectDeployChangeSet, resolveAuthoritativeLiveDeployReviewBase } from './lib/deploy-change-set.mjs';
import {
  collectSmirkApprovalTokens,
  DEPLOY_APPROVAL_ONE_DECISION_PATH,
  validateDeployApprovalOneDecisionCard,
} from './lib/deploy-approval-one-decision-card.mjs';
import {
  CUSTOMER_POLICY_VERSION_RAILWAY_SOURCE,
  verifiedRailwayCustomerPolicyVersion,
} from './lib/deploy-customer-policy-version.mjs';
import { SMIRK_RAILWAY_PRODUCTION_TARGET } from './lib/first-dollar-pending-env.mjs';

const deployConfirmation = 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix';
const deployApprovalToken = 'APPROVE_SMIRK_POST_CALL_FIX_DEPLOY';
const deployApprovalMeaning = 'Production deploy approval only. This does not authorize a Git push, Stripe smoke, cleanup apply, proof calls, secret access, paid spend, outreach, or activation of a staged first-dollar environment manifest; pending activation requires the exact staged digest plus distinct activation-deploy and real Starter checkout authority.';
const firstDollarBootstrapDeployMode = 'SMIRK_FIRST_DOLLAR_ENV_BOOTSTRAP_DEPLOY=deploy-fail-closed-checkout';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sameSet(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((item) => !actualSet.has(item)),
    extra: actual.filter((item) => !expectedSet.has(item)),
  };
}

let authoritativeBase;
try {
  authoritativeBase = resolveAuthoritativeLiveDeployReviewBase();
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    deployRelevantFileCount: null,
    checkedArtifacts: [],
    failures: [String(error?.message || error)],
  }, null, 2));
  process.exit(1);
}
const authoritativeLiveReviewBaseRef = authoritativeBase.ref;
const expectedChangeSet = collectDeployChangeSet({ baseRef: authoritativeLiveReviewBaseRef });
if (expectedChangeSet.baseRef !== authoritativeLiveReviewBaseRef || expectedChangeSet.baseCommit !== authoritativeLiveReviewBaseRef) {
  console.log(JSON.stringify({
    ok: false,
    deployRelevantFileCount: null,
    checkedArtifacts: [],
    failures: [`Live deployment fingerprint ${authoritativeLiveReviewBaseRef} did not resolve to the exact review baseline commit.`],
  }, null, 2));
  process.exit(1);
}
const expectedFiles = expectedChangeSet.files;
const expectedDirtyFiles = expectedChangeSet.dirtyFiles;

if (expectedFiles.length === 0) {
  const retainedApprovalTokens = existsSync(DEPLOY_APPROVAL_ONE_DECISION_PATH)
    ? collectSmirkApprovalTokens(readFileSync(DEPLOY_APPROVAL_ONE_DECISION_PATH, 'utf8'))
    : [];
  const failures = retainedApprovalTokens.length === 0
    ? []
    : [`${DEPLOY_APPROVAL_ONE_DECISION_PATH} must be absent or tokenless when no deploy-relevant changes remain; found ${retainedApprovalTokens.join(', ')}`];
  console.log(JSON.stringify({
    ok: failures.length === 0,
    deployRelevantFileCount: 0,
    checkedArtifacts: existsSync(DEPLOY_APPROVAL_ONE_DECISION_PATH) ? [DEPLOY_APPROVAL_ONE_DECISION_PATH] : [],
    skippedArtifacts: [
      'output/deploy-approval-bundle.json',
      'output/deploy-approval-request.json',
      'output/high-risk-deploy-review.json',
      'output/post-call-fix-handoff.json',
    ],
    reason: failures.length === 0
      ? 'No deploy-relevant local changes; deploy approval handoff is not required and no approval token remains.'
      : 'No deploy-relevant local changes, but a stale deploy approval token remains.',
    failures,
  }, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

const artifactPaths = [
  'output/deploy-approval-bundle.json',
  'output/deploy-approval-request.json',
  'output/high-risk-deploy-review.json',
  'output/post-call-fix-handoff.json',
  'output/stripe-webhook-smoke-approval.json',
  'output/stripe-webhook-smoke-approval.md',
  'output/first-dollar-approval-packet.md',
  DEPLOY_APPROVAL_ONE_DECISION_PATH,
];

const missingArtifacts = artifactPaths.filter((path) => !existsSync(path));
if (missingArtifacts.length) {
  console.log(JSON.stringify({
    ok: false,
    deployRelevantFileCount: expectedFiles.length,
    checkedArtifacts: artifactPaths,
    failures: missingArtifacts.map((path) => `${path} is required when deploy-relevant local changes exist`),
  }, null, 2));
  process.exit(1);
}

const bundle = readJson('output/deploy-approval-bundle.json');
const request = readJson('output/deploy-approval-request.json');
const liveFirstDollarEnvReady = request.liveFirstDollarEnvReady === true;
const incompleteFirstDollarEnvRecommendation = 'Production is current, but first-dollar checkout remains fail-closed. Complete the owner policy decision card and exact Starter-only Railway/Stripe configuration before requesting any Stripe write smoke.';
const incompleteFirstDollarEnvNextAction = 'Do not request the signed Stripe smoke yet. First complete the canonical owner decision card, run `npm run -s check:railway:first-dollar-env`, and prepare a masked provider-verified `set:first-dollar-live-env -- --dry-run` for digest-bound review.';
const review = readJson('output/high-risk-deploy-review.json');
const handoff = readJson('output/post-call-fix-handoff.json');
const packageJson = readJson('package.json');
const approvalNote = readFileSync('output/post-call-fix-approval-note.md', 'utf8');
const firstDollarApprovalPacket = readFileSync('output/first-dollar-approval-packet.md', 'utf8');
const deployApprovalOneDecisionCard = readFileSync(DEPLOY_APPROVAL_ONE_DECISION_PATH, 'utf8');
const firstHumanRun = readFileSync('FIRST_HUMAN_RUN.md', 'utf8');
const readme = readFileSync('README.md', 'utf8');
const handoffSource = readFileSync('scripts/print-post-call-fix-handoff.mjs', 'utf8');
const deploySource = readFileSync('deploy.sh', 'utf8');
const deployFingerprintSource = readFileSync('scripts/check-deploy-fingerprint.mjs', 'utf8');
const deployChangeSetSource = readFileSync('scripts/lib/deploy-change-set.mjs', 'utf8');
const deployFingerprintStampSource = readFileSync('scripts/stamp-railway-deploy-fingerprint.mjs', 'utf8');
const deployLiveBaselineSource = readFileSync('scripts/check-deploy-live-baseline.mjs', 'utf8');
const railwayJsonSource = readFileSync('scripts/railway-json.mjs', 'utf8');
const firstDollarSetterSource = readFileSync('scripts/set-first-dollar-live-env.sh', 'utf8');
const pendingEnvManifestSource = readFileSync('scripts/lib/first-dollar-pending-env.mjs', 'utf8');
const pendingEnvActivationSource = readFileSync('scripts/check-first-dollar-pending-env-activation.mjs', 'utf8');
const pendingEnvReceiptSource = readFileSync('scripts/record-first-dollar-activation-receipt.mjs', 'utf8');
const pendingEnvDeploymentBaselineSource = readFileSync('scripts/capture-first-dollar-pending-env-deployment-baseline.mjs', 'utf8');
const pendingEnvDeploymentWaitSource = readFileSync('scripts/wait-first-dollar-pending-env-deployment.mjs', 'utf8');

const reviewFiles = Array.isArray(review.files) ? review.files.map((item) => item.file) : [];
const requestFiles = Array.isArray(request.highRiskFiles) ? request.highRiskFiles : [];
const requestDeployFiles = Array.isArray(request.deployRelevantFiles) ? request.deployRelevantFiles : [];
const requestDirtyFiles = Array.isArray(request.deployRelevantDirtyFiles) ? request.deployRelevantDirtyFiles : [];
const bundleDeployFiles = Array.isArray(bundle.deployRelevantFiles) ? bundle.deployRelevantFiles : [];
const bundleDirtyFiles = Array.isArray(bundle.deployRelevantDirtyFiles) ? bundle.deployRelevantDirtyFiles : [];
const handoffFiles = Array.isArray(handoff.highRiskFiles) ? handoff.highRiskFiles : [];
const handoffDeployFiles = Array.isArray(handoff.deployRelevantFiles) ? handoff.deployRelevantFiles : [];
const expectedPostDeployProofSteps = [
  'npm run -s check:ship-live',
  'WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag',
  'npm run -s check:real-call-readiness -- <safe-number>',
  'APPROVE_SMIRK_REAL_PROOF_CALL: <exact-approved-e164>',
  "CONFIRM_SMIRK_REAL_PROOF_CALL=place-one-smirk-real-proof-call CONFIRM_SMIRK_REAL_PROOF_CALL_TARGET='<exact-approved-e164>' npm run -s proof:real-call -- '<exact-approved-e164>'",
];
const expectedDeployPreflightRequiredPasses = [
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
  'webhookBuffer',
  'handoffSafety',
  'railwayAccess',
  'pendingFirstDollarEnvActivation',
];
if (bundle.branchReconcileRequired === true) {
  expectedDeployPreflightRequiredPasses.splice(
    expectedDeployPreflightRequiredPasses.indexOf('proofArtifactsLive'),
    0,
    'branchSyncConflictForecast',
  );
}
const deployPreflightRequiredPassesLine = Array.isArray(bundle.deployPreflightRequiredPasses) && bundle.deployPreflightRequiredPasses.length > 0
  ? `Required passes: ${bundle.deployPreflightRequiredPasses.join(', ')}.`
  : null;
const expectedPostDeployProofReadinessGuards = [
  'check:post-deploy-live',
  'check:first-dollar-guard-coverage',
  'check:real-call-readiness -- <safe-number>',
];
const expectedPostDeployStripeWebhookSmokeApprovalPhrase = 'APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE: ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live';
const expectedPostDeploySmokeCleanupApplyApprovalPhrase = 'APPROVE_SMIRK_SMOKE_CLEANUP_APPLY: APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply';
const expectedLiveCurrentBlockerDetail = 'Live fingerprint matches local HEAD, but deploy-relevant working-tree changes still need explicit approval and shipping before Stripe smoke or proof-call approval.';
const expectedStaleBlockerDetail = 'Live Railway fingerprint does not match local HEAD yet.';
const localCommit = (() => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; }
})();
const remoteMainCommit = (() => {
  try { return execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim(); } catch { return null; }
})();
const mergeBaseMain = (() => {
  try { return execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { encoding: 'utf8' }).trim(); } catch { return null; }
})();
const gitRemoteSync = localCommit && remoteMainCommit && mergeBaseMain
  ? (localCommit === remoteMainCommit
    ? 'current'
    : (mergeBaseMain === remoteMainCommit ? 'ahead' : (mergeBaseMain === localCommit ? 'behind' : 'diverged')))
  : 'unknown';
const requiresBranchReconcile = gitRemoteSync === 'behind' || gitRemoteSync === 'diverged';

const failures = [];
const policyVersionEvidence = verifiedRailwayCustomerPolicyVersion(bundle);
const expectedPolicyTarget = {
  projectId: SMIRK_RAILWAY_PRODUCTION_TARGET.projectId,
  serviceId: SMIRK_RAILWAY_PRODUCTION_TARGET.serviceId,
  environmentId: SMIRK_RAILWAY_PRODUCTION_TARGET.environmentId,
};
const policyTargetMatches = Object.entries(expectedPolicyTarget).every(
  ([key, value]) => bundle.customerPolicyVersionTarget?.[key] === value,
);
if (typeof bundle.customerPolicyVersionReadSucceeded !== 'boolean') {
  failures.push('bundle.customerPolicyVersionReadSucceeded must explicitly record whether the Railway production variables read succeeded');
}
if (!policyTargetMatches) {
  failures.push('bundle.customerPolicyVersionTarget must identify the exact pinned Railway production project, service, and environment');
}
if (bundle.customerPolicyVersionReadSucceeded === true) {
  if (bundle.customerPolicyVersionSource !== CUSTOMER_POLICY_VERSION_RAILWAY_SOURCE) {
    failures.push(`bundle.customerPolicyVersionSource must be ${CUSTOMER_POLICY_VERSION_RAILWAY_SOURCE} after a successful Railway read`);
  }
  if (bundle.customerPolicyVersionReadFailure !== null) {
    failures.push('bundle.customerPolicyVersionReadFailure must be null after a successful Railway read');
  }
  if (bundle.customerPolicyVersionRecorded === true && policyVersionEvidence.provenanceVerified !== true) {
    failures.push('bundle recorded customer policy version must have successful exact Railway production provenance');
  }
  if (bundle.customerPolicyVersionRecorded !== true && bundle.customerPolicyVersion !== null) {
    failures.push('bundle.customerPolicyVersion must be null when the successful Railway read did not return a valid policy version');
  }
} else {
  if (
    bundle.customerPolicyVersion !== null
    || bundle.customerPolicyVersionRecorded !== false
    || bundle.customerPolicyVersionSource !== null
    || bundle.customerPolicyVersionReadFailure !== 'railway-production-variables-read-failed'
  ) {
    failures.push('failed Railway policy-version reads must fail closed with no version, no source claim, and an explicit sanitized failure code');
  }
}
if (
  packageJson.scripts?.['check:first-dollar-pending-env-activation'] !== 'node scripts/check-first-dollar-pending-env-activation.mjs'
  || packageJson.scripts?.['print:first-dollar-pending-env-activation'] !== 'node scripts/check-first-dollar-pending-env-activation.mjs --inspect'
  || packageJson.scripts?.['record:first-dollar-activation-receipt'] !== 'node scripts/record-first-dollar-activation-receipt.mjs'
  || packageJson.scripts?.['capture:first-dollar-pending-env-deployment-baseline'] !== 'node scripts/capture-first-dollar-pending-env-deployment-baseline.mjs'
  || packageJson.scripts?.['wait:first-dollar-pending-env-deployment'] !== 'node scripts/wait-first-dollar-pending-env-deployment.mjs'
) {
  failures.push('package.json must expose exact pending first-dollar inspect, activation-check, deployment-rollout, and activation-receipt commands');
}
if (
  !firstDollarSetterSource.includes('CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST')
  || !firstDollarSetterSource.includes('SMIRK_PENDING_FIRST_DOLLAR_ENV_DIGEST')
  || !firstDollarSetterSource.includes('--skip-deploys')
  || firstDollarSetterSource.includes('if [ "${CONFIRM_SMIRK_REAL_STARTER_CHECKOUT')
) {
  failures.push('first-dollar environment staging must be exact-digest-bound, persist pending sentinels with --skip-deploys, and not require real-checkout authority');
}
for (const required of [
  'createHash("sha256")',
  'SMIRK_RAILWAY_PRODUCTION_TARGET',
  'pending-env-current-commit-mismatch',
  'pending-env-exact-digest-confirmation-missing',
  'pending-env-activation-deploy-confirmation-missing',
  'pending-env-real-starter-checkout-confirmation-missing',
]) {
  if (!pendingEnvManifestSource.includes(required)) failures.push(`pending first-dollar manifest guard is missing: ${required}`);
}
if (
  !pendingEnvActivationSource.includes('railwayProjectContext')
  || !pendingEnvActivationSource.includes('railwayVariables')
  || !pendingEnvActivationSource.includes('FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.activationDeploy')
  || !pendingEnvActivationSource.includes('FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.realStarterCheckout')
) {
  failures.push('pending first-dollar activation check must recompute exact pinned Railway state and require separate activation plus real-checkout authority');
}
if (
  !pendingEnvReceiptSource.includes('FIRST_DOLLAR_ACTIVATED_ENV_RECEIPT')
  || !pendingEnvReceiptSource.includes('skipDeploys: true')
  || !pendingEnvReceiptSource.includes('SMIRK_PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON')
  || !pendingEnvReceiptSource.includes('deploymentMatchesPendingActivation')
  || !pendingEnvReceiptSource.includes('=== "SUCCESS"')
  || !pendingEnvReceiptSource.includes('["run", "-s", "check:ship-live"]')
  || pendingEnvReceiptSource.includes('FIRST_DOLLAR_PENDING_ENV_SENTINELS')
  || !deploySource.includes('SMIRK_PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON="$PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON" npm run -s record:first-dollar-activation-receipt')
) {
  failures.push('pending first-dollar activation completion must independently verify the exact successful nonce-bound rollout and full live ship gate, then record a digest receipt with --skip-deploys while preserving pending-manifest evidence');
}
if (
  !pendingEnvDeploymentBaselineSource.includes('baselineDeploymentIds')
  || !pendingEnvDeploymentBaselineSource.includes('pendingActivationUploadMessage')
  || !pendingEnvDeploymentWaitSource.includes('deploymentMatchesPendingActivation')
  || !pendingEnvDeploymentWaitSource.includes('=== "SUCCESS"')
  || !deploySource.includes('--message "$PENDING_ACTIVATION_UPLOAD_MESSAGE"')
) {
  failures.push('pending first-dollar activation must bind Railway upload and rollout success to the exact reviewed commit, manifest digest, and one-use nonce');
}
if (!deployFingerprintStampSource.includes('railwaySetVariable(name, value, { skipDeploys: true })') || !railwayJsonSource.includes('args.push("--skip-deploys")')) {
  failures.push('deploy fingerprint variables must be updated with --skip-deploys so an old-source variable redeploy cannot race railway up');
}
if (
  deployFingerprintSource.includes('process.env.APP_URL')
  || !deployFingerprintSource.includes('SMIRK_DEPLOY_FINGERPRINT_APP_URL')
  || !deployFingerprintSource.includes('AUTHORITATIVE_PRODUCTION_ORIGINS.includes(parsedTarget.origin)')
  || !deployFingerprintSource.includes('redirect: "error"')
  || !deployChangeSetSource.includes('SMIRK_DEPLOY_FINGERPRINT_APP_URL: AUTHORITATIVE_PRODUCTION_APP_URL')
  || !deployChangeSetSource.includes('assertAuthoritativeProductionLiveOrigin(liveCheck)')
) {
  failures.push('authoritative deploy fingerprints must ignore ambient APP_URL and require an allowlisted production HTTPS origin');
}
if (expectedDirtyFiles.length > 0) {
  failures.push('Deploy approval requires a clean exact commit; commit the intended files and regenerate the packet.');
}
if (bundle.deployReviewBaseVerified !== true) {
  failures.push('bundle.deployReviewBaseVerified must be true');
}
if (bundle.deployReviewBaseRef !== authoritativeLiveReviewBaseRef) {
  failures.push(`bundle.deployReviewBaseRef=${bundle.deployReviewBaseRef || null} does not match live fingerprint ${authoritativeLiveReviewBaseRef}`);
}
if (bundle.deployReviewBaseCommit !== authoritativeLiveReviewBaseRef) {
  failures.push(`bundle.deployReviewBaseCommit=${bundle.deployReviewBaseCommit || null} does not match live fingerprint ${authoritativeLiveReviewBaseRef}`);
}
for (const [label, data] of [
  ['request', request],
  ['review', review],
  ['handoff', handoff],
]) {
  if (data.deployReviewBaseRef !== authoritativeLiveReviewBaseRef) {
    failures.push(`${label}.deployReviewBaseRef must match live fingerprint ${authoritativeLiveReviewBaseRef}`);
  }
  if (data.deployReviewBaseCommit !== authoritativeLiveReviewBaseRef) {
    failures.push(`${label}.deployReviewBaseCommit must match live fingerprint ${authoritativeLiveReviewBaseRef}`);
  }
}
const countChecks = [
  ['bundle.highRiskFileCount', bundle.highRiskFileCount],
  ['bundle.reviewFilesCount', bundle.reviewFilesCount],
  ['request.highRiskFileCount', request.highRiskFileCount],
  ['review.files.length', reviewFiles.length],
  ['review.deployRelevantFileCount', review.deployRelevantFileCount],
  ['handoff.highRiskFileCount', handoff.highRiskFileCount],
];

for (const [label, count] of countChecks) {
  if (count !== expectedFiles.length) {
    failures.push(`${label}=${count} does not match deploy-relevant file count ${expectedFiles.length}`);
  }
}

const setChecks = [
  ['bundle.deployRelevantFiles', bundleDeployFiles],
  ['request.deployRelevantFiles', requestDeployFiles],
  ['request.highRiskFiles', requestFiles],
  ['review.files', reviewFiles],
  ['handoff.deployRelevantFiles', handoffDeployFiles],
  ['handoff.highRiskFiles', handoffFiles],
];

for (const [label, files] of setChecks) {
  const { missing, extra } = sameSet(files, expectedFiles);
  if (missing.length || extra.length) {
    failures.push(`${label} does not match deploy-relevant files: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
  }
}

for (const [label, files] of [
  ['bundle.deployRelevantDirtyFiles', bundleDirtyFiles],
  ['request.deployRelevantDirtyFiles', requestDirtyFiles],
]) {
  const { missing, extra } = sameSet(files, expectedDirtyFiles);
  if (missing.length || extra.length) {
    failures.push(`${label} does not match dirty deploy-relevant files: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
  }
}

const deployCommands = [
  ['request.command', request.command],
  ['handoff.deployCommand', handoff.deployCommand],
  ['bundle.deployCommand', bundle.deployCommand],
];
for (const [label, value] of deployCommands) {
  if (typeof value !== 'string' || !value.includes(deployConfirmation) || !value.includes('npm run deploy:post-call-fix')) {
    failures.push(`${label} must include the confirmed deploy command`);
  }
  if (typeof value !== 'string' || !value.includes(`CONFIRM_SMIRK_DEPLOY_COMMIT=${localCommit}`)) {
    failures.push(`${label} must bind approval to exact commit ${localCommit}`);
  }
}
if (new Set(deployCommands.map(([, value]) => value)).size !== 1) {
  failures.push('request, handoff, and bundle deploy commands must match exactly');
}
const bootstrapRequirementValues = [
  ['request.firstDollarBootstrapDeployRequired', request.firstDollarBootstrapDeployRequired],
  ['handoff.firstDollarBootstrapDeployRequired', handoff.firstDollarBootstrapDeployRequired],
  ['bundle.firstDollarBootstrapDeployRequired', bundle.firstDollarBootstrapDeployRequired],
];
const bootstrapDeployRequired = request.firstDollarBootstrapDeployRequired === true;
for (const [label, value] of bootstrapRequirementValues) {
  if (value !== bootstrapDeployRequired) {
    failures.push(`${label} must match the deploy approval request bootstrap requirement`);
  }
}
if (bootstrapDeployRequired) {
  for (const [label, data] of [['request', request], ['handoff', handoff], ['bundle', bundle]]) {
    if (data.firstDollarBootstrapDeployMode !== firstDollarBootstrapDeployMode) {
      failures.push(`${label}.firstDollarBootstrapDeployMode must preserve the exact incomplete-env bootstrap mode`);
    }
    if (typeof data.firstDollarBootstrapDeployMeaning !== 'string' || !data.firstDollarBootstrapDeployMeaning.trim()) {
      failures.push(`${label}.firstDollarBootstrapDeployMeaning must preserve the narrow bootstrap authority`);
    }
  }
  for (const [label, value] of deployCommands) {
    if (typeof value !== 'string' || !value.includes(firstDollarBootstrapDeployMode)) {
      failures.push(`${label} must include ${firstDollarBootstrapDeployMode} when live first-dollar env is incomplete`);
    }
  }
  const bundleDeployCommand = Array.isArray(bundle.approvalSteps)
    ? bundle.approvalSteps.find((step) => String(step).includes('npm run deploy:post-call-fix'))
    : null;
  if (typeof bundleDeployCommand !== 'string' || !bundleDeployCommand.includes(firstDollarBootstrapDeployMode)) {
    failures.push('bundle.approvalSteps must carry the exact bootstrap-mode deploy command when required');
  }
  if (!firstDollarApprovalPacket.includes(firstDollarBootstrapDeployMode)
      || (typeof bundleDeployCommand === 'string' && !firstDollarApprovalPacket.includes(bundleDeployCommand))) {
    failures.push('first-dollar approval packet must expose the exact bootstrap-mode deploy command when required');
  }
}
if (!requiresBranchReconcile && (typeof bundle.nextAction !== 'string' || !bundle.nextAction.includes(deployConfirmation) || !bundle.nextAction.includes('npm run deploy:post-call-fix'))) {
  failures.push('bundle.nextAction must include the confirmed deploy command when branch reconciliation is not required');
}
if (!requiresBranchReconcile && !bundle.nextAction.includes(`CONFIRM_SMIRK_DEPLOY_COMMIT=${localCommit}`)) {
  failures.push('bundle.nextAction must bind approval to the exact local commit');
}
if (bundle.sourceCommit !== localCommit || bundle.localCommit !== localCommit) {
  failures.push(`bundle source/local commit must both match current HEAD ${localCommit}`);
}
if (bundle.ok !== true || bundle.reviewReady !== true) {
  failures.push('bundle must be approval-ready for the clean exact commit');
}
const deployApprovalOneDecisionValidation = validateDeployApprovalOneDecisionCard(
  deployApprovalOneDecisionCard,
  bundle,
);
for (const failure of deployApprovalOneDecisionValidation.failures) {
  failures.push(`deploy one-decision card: ${failure}`);
}
if (bundle.deployApprovalOneDecisionReady !== true || deployApprovalOneDecisionValidation.ready !== true) {
  failures.push('deploy one-decision card must be approval-ready with the current exact-commit bundle');
}
if (
  bundle.deployApprovalOneDecisionPath !== DEPLOY_APPROVAL_ONE_DECISION_PATH
  && !String(bundle.deployApprovalOneDecisionPath || '').endsWith(`/${DEPLOY_APPROVAL_ONE_DECISION_PATH}`)
) {
  failures.push(`bundle.deployApprovalOneDecisionPath must point to ${DEPLOY_APPROVAL_ONE_DECISION_PATH}`);
}
if (
  bundle.artifactPaths?.deployApprovalOneDecisionPath !== DEPLOY_APPROVAL_ONE_DECISION_PATH
  && !String(bundle.artifactPaths?.deployApprovalOneDecisionPath || '').endsWith(`/${DEPLOY_APPROVAL_ONE_DECISION_PATH}`)
) {
  failures.push(`bundle.artifactPaths.deployApprovalOneDecisionPath must point to ${DEPLOY_APPROVAL_ONE_DECISION_PATH}`);
}
if (
  bundle.artifacts?.deployApprovalOneDecision?.exists !== true
  || Number(bundle.artifacts?.deployApprovalOneDecision?.bytes || 0) <= 0
) {
  failures.push('bundle.artifacts.deployApprovalOneDecision must record a non-empty generated card');
}

if (request.postDeployProofRequired !== true) {
  failures.push('request.postDeployProofRequired must be true so deploy approval does not imply proof completion');
}

if (request.proofRunnerRequiresPostDeployLive !== true) {
  failures.push('request.proofRunnerRequiresPostDeployLive must be true so proof calls remain gated by post-deploy live checks');
}

for (const [label, data] of [
  ['handoff', handoff],
  ['bundle', bundle],
]) {
  if (data.postDeployProofRequired !== true) {
    failures.push(`${label}.postDeployProofRequired must be true so deploy approval does not imply proof completion`);
  }
  if (data.proofRunnerRequiresPostDeployLive !== true) {
    failures.push(`${label}.proofRunnerRequiresPostDeployLive must be true so proof calls remain gated by post-deploy live checks`);
  }
}

for (const step of expectedPostDeployProofSteps) {
  if (!Array.isArray(request.postDeployProofSteps) || !request.postDeployProofSteps.includes(step)) {
    failures.push(`request.postDeployProofSteps must include ${step}`);
  }
  if (!Array.isArray(handoff.postDeployProofSteps) || !handoff.postDeployProofSteps.includes(step)) {
    failures.push(`handoff.postDeployProofSteps must include ${step}`);
  }
  if (!Array.isArray(bundle.postDeployProofSteps) || !bundle.postDeployProofSteps.includes(step)) {
    failures.push(`bundle.postDeployProofSteps must include ${step}`);
  }
}

for (const pass of expectedDeployPreflightRequiredPasses) {
  if (!Array.isArray(request.deployPreflightRequiredPasses) || !request.deployPreflightRequiredPasses.includes(pass)) {
    failures.push(`request.deployPreflightRequiredPasses must include ${pass}`);
  }
  if (!Array.isArray(handoff.deployPreflightRequiredPasses) || !handoff.deployPreflightRequiredPasses.includes(pass)) {
    failures.push(`handoff.deployPreflightRequiredPasses must include ${pass}`);
  }
  if (!Array.isArray(bundle.deployPreflightRequiredPasses) || !bundle.deployPreflightRequiredPasses.includes(pass)) {
    failures.push(`bundle.deployPreflightRequiredPasses must include ${pass}`);
  }
}

if (bundle.branchReconcileRequired !== true) {
  for (const [label, data] of [
    ['request', request],
    ['handoff', handoff],
    ['bundle', bundle],
  ]) {
    if (Array.isArray(data.deployPreflightRequiredPasses) && data.deployPreflightRequiredPasses.includes('branchSyncConflictForecast')) {
      failures.push(`${label}.deployPreflightRequiredPasses must not require branchSyncConflictForecast when branch reconciliation is not required`);
    }
  }
}

for (const guard of expectedPostDeployProofReadinessGuards) {
  if (!Array.isArray(request.postDeployProofReadinessGuards) || !request.postDeployProofReadinessGuards.includes(guard)) {
    failures.push(`request.postDeployProofReadinessGuards must include ${guard}`);
  }
  if (!Array.isArray(handoff.postDeployProofReadinessGuards) || !handoff.postDeployProofReadinessGuards.includes(guard)) {
    failures.push(`handoff.postDeployProofReadinessGuards must include ${guard}`);
  }
  if (!Array.isArray(bundle.postDeployProofReadinessGuards) || !bundle.postDeployProofReadinessGuards.includes(guard)) {
    failures.push(`bundle.postDeployProofReadinessGuards must include ${guard}`);
  }
}

for (const [label, data] of [
  ['request', request],
  ['handoff', handoff],
  ['bundle', bundle],
]) {
  if (data.deployApprovalToken !== deployApprovalToken) {
    failures.push(`${label}.deployApprovalToken must be ${deployApprovalToken}`);
  }
  if (data.deployApprovalMeaning !== deployApprovalMeaning) {
    failures.push(`${label}.deployApprovalMeaning must preserve the deploy-only approval scope`);
  }
  const expectedDeployBlocker = data.pendingFirstDollarEnvStaged === true
    ? data.deployState
    : 'stale-production-deploy';
  if (data.expectedDeployBlockerAfterRequiredPasses !== expectedDeployBlocker) {
    failures.push(`${label}.expectedDeployBlockerAfterRequiredPasses must be ${expectedDeployBlocker}`);
  }
  if (data.postDeployStripeWebhookSmokeApprovalPhrase !== expectedPostDeployStripeWebhookSmokeApprovalPhrase) {
    failures.push(`${label}.postDeployStripeWebhookSmokeApprovalPhrase must preserve the exact Stripe smoke approval phrase`);
  }
  if (data.postDeploySmokeCleanupApplyApprovalPhrase !== expectedPostDeploySmokeCleanupApplyApprovalPhrase) {
    failures.push(`${label}.postDeploySmokeCleanupApplyApprovalPhrase must preserve the exact smoke cleanup approval phrase`);
  }
}

if (expectedFiles.length > 0) {
  const expectedLocalDeployClean = expectedDirtyFiles.length === 0;
  for (const [label, data] of [
    ['request', request],
    ['handoff', handoff],
    ['bundle', bundle],
  ]) {
    const expectedDeployState = data.pendingFirstDollarEnvStaged === true
      ? 'pending-first-dollar-env-activation-deploy'
      : (expectedLocalDeployClean
        ? (data.liveFingerprintCurrent === true ? 'live-already-current' : 'stale-production-deploy')
        : 'pending-local-deploy-work');
    if (data.deployState !== expectedDeployState) {
      failures.push(`${label}.deployState must be ${expectedDeployState} for the current deploy delta`);
    }
    const expectedBlockerDetail = data.pendingFirstDollarEnvStaged === true
      ? 'A digest-bound first-dollar environment manifest is staged with --skip-deploys. Activation requires the inspector-printed exact command plus separate deploy, digest, commit, activation-deploy, and real Starter checkout authority.'
      : (!expectedLocalDeployClean && data.liveFingerprintCurrent === true
      ? expectedLiveCurrentBlockerDetail
      : (data.liveFingerprintCurrent === true
        ? 'Live fingerprint is current and deploy-relevant working tree is clean.'
        : expectedStaleBlockerDetail));
    if (data.blockerDetail !== expectedBlockerDetail) {
      failures.push(`${label}.blockerDetail must match live fingerprint state: expected ${JSON.stringify(expectedBlockerDetail)}`);
    }
    if (typeof data.liveFingerprintCurrent !== 'boolean') {
      failures.push(`${label}.liveFingerprintCurrent must be a boolean`);
    }
    if (data.localDeployClean !== expectedLocalDeployClean) {
      failures.push(`${label}.localDeployClean must be ${expectedLocalDeployClean} for the current dirty deploy delta`);
    }
  }
}

for (const artifact of [
  'call record',
  'generated summary',
  'owner email alert',
  'callback task',
  'dashboard proof counters',
]) {
  if (!Array.isArray(request.postDeployProofExpectedArtifacts) || !request.postDeployProofExpectedArtifacts.includes(artifact)) {
    failures.push(`request.postDeployProofExpectedArtifacts must include ${artifact}`);
  }
  if (!Array.isArray(handoff.postDeployProofExpectedArtifacts) || !handoff.postDeployProofExpectedArtifacts.includes(artifact)) {
    failures.push(`handoff.postDeployProofExpectedArtifacts must include ${artifact}`);
  }
  if (!Array.isArray(bundle.postDeployProofExpectedArtifacts) || !bundle.postDeployProofExpectedArtifacts.includes(artifact)) {
    failures.push(`bundle.postDeployProofExpectedArtifacts must include ${artifact}`);
  }
}

if (request.liveVersionCurrent !== true && expectedFiles.length > 0) {
  if (!approvalNote.includes('## Current blocker')) {
    failures.push('approval note must include a Current blocker section when deploy-relevant local changes exist');
  }
  if (!approvalNote.includes('- stale-production-deploy')) {
    failures.push('approval note must name stale-production-deploy as the current blocker when live is stale');
  }
  if (!approvalNote.includes(`- Deploy-relevant pending files: ${expectedFiles.length}`)) {
    failures.push(`approval note must include the deploy-relevant pending file count ${expectedFiles.length}`);
  }
  if (!approvalNote.includes(`- Deploy state: ${request.deployState}`)) {
    failures.push(`approval note must include ${request.deployState} deploy state`);
  }
  const expectedNoteBlockerDetail = request.liveFingerprintCurrent === true
    ? expectedLiveCurrentBlockerDetail
    : expectedStaleBlockerDetail;
  if (!approvalNote.includes(`- Detail: ${expectedNoteBlockerDetail}`)) {
    failures.push('approval note current blocker must include the live fingerprint blocker detail');
  }
  const expectedFingerprintLine = `- Live fingerprint current: ${request.liveFingerprintCurrent === true ? 'yes' : 'no'}`;
  if (!approvalNote.includes(expectedFingerprintLine)) {
    failures.push(`approval note must state the live fingerprint state: ${expectedFingerprintLine}`);
  }
  const expectedLocalDeployCleanLine = `- Local deploy clean: ${expectedDirtyFiles.length === 0 ? 'yes' : 'no'}`;
  if (!approvalNote.includes(expectedLocalDeployCleanLine)) {
    failures.push(`approval note must state current dirty deploy cleanliness: ${expectedLocalDeployCleanLine}`);
  }
  if (/Approval artifact freshness:.*approval note unknown/.test(approvalNote)) {
    failures.push('approval note artifact freshness must include the approval note timestamp, not unknown');
  }
  if (approvalNote.includes('## Current blocker\n- unknown')) {
    failures.push('approval note current blocker must not be unknown when deploy-relevant local changes exist');
  }
  for (const required of [
    '## Approval decision summary',
    'Approve only the production deploy of the pending first-dollar hardening bundle.',
    'This deploy is required before a fresh proof call can verify the updated missed-call recovery path.',
    'This approval does not claim first-dollar readiness by itself.',
    'After deploy, run the post-deploy ship checks and one fresh pinned proof call before outreach.',
    `Approval token: ${deployApprovalToken}`,
    `Approval meaning: ${deployApprovalMeaning}`,
    `Git remote sync: ${gitRemoteSync}`,
    `Branch reconciliation required: ${requiresBranchReconcile ? 'yes' : 'no'}`,
    '## Deploy preflight evidence required',
    'Before deploy: npm run -s check:deploy-post-call-fix-ready',
    'Expected blocker after those passes: stale-production-deploy.',
    'If any required pass is missing, do not deploy.',
    '## Post-deploy Gate 4 proof',
    'Deploy approval only ships the pending proof-hardening bundle; it does not prove the missed-call recovery outcome by itself.',
    'npm run -s check:ship-live',
    'WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag',
    'npm run -s check:real-call-readiness -- <safe-number>',
    'APPROVE_SMIRK_REAL_PROOF_CALL: <exact-approved-e164>',
    "CONFIRM_SMIRK_REAL_PROOF_CALL=place-one-smirk-real-proof-call CONFIRM_SMIRK_REAL_PROOF_CALL_TARGET='<exact-approved-e164>' npm run -s proof:real-call -- '<exact-approved-e164>'",
    'The proof runner re-runs check:post-deploy-live, then requires both exact confirmations after readiness and before dialing. Readiness or deploy approval alone never authorizes a call.',
    'The webhook buffer lag check verifies that received/retry Twilio payloads are not silently aging before proof calls.',
    'Real-call readiness runs first-dollar guard coverage before clearing a proof call.',
    'Expected proof: call record, generated summary, owner email alert, callback task, and dashboard proof counters.',
    'Do not place a real proof call until check:real-call-readiness passes and APPROVE_SMIRK_REAL_PROOF_CALL names the same exact E.164 number.',
    '## Post-deploy Gate 3 payment/provisioning smoke',
    'Deploy approval does not authorize the signed Stripe webhook smoke.',
    'Run the Stripe webhook smoke only after this exact approval phrase:',
    expectedPostDeployStripeWebhookSmokeApprovalPhrase,
    'Confirmed smoke cleanup requires separate approval after reviewing the cleanup dry-run.',
    expectedPostDeploySmokeCleanupApplyApprovalPhrase,
  ]) {
    if (!approvalNote.includes(required)) {
      failures.push(`approval note must include deploy/proof instruction: ${required}`);
    }
  }
  if (deployPreflightRequiredPassesLine && !approvalNote.includes(deployPreflightRequiredPassesLine)) {
    failures.push(`approval note must include deploy preflight required passes from bundle: ${deployPreflightRequiredPassesLine}`);
  }
}

for (const required of [
  '## Current Recommended Approval',
  requiresBranchReconcile
    ? 'Synchronize the local branch with origin/main before approving production deploy.'
    : (request.deployState === 'live-already-current' && request.liveFingerprintCurrent === true && expectedFiles.length === 0
      ? (liveFirstDollarEnvReady
        ? 'Production is already current and the deploy-relevant working tree is clean. The next approval-gated money-path proof is the signed Stripe webhook smoke after live and buffer checks pass.'
        : incompleteFirstDollarEnvRecommendation)
      : 'Approve the production deploy first.'),
  requiresBranchReconcile
    ? 'After synchronization, regenerate this packet and rerun deploy readiness before any production deploy approval.'
    : (request.deployState === 'live-already-current' && request.liveFingerprintCurrent === true && expectedFiles.length === 0
      ? (liveFirstDollarEnvReady
        ? 'If those pass, request separate approval for the signed Stripe webhook smoke. Deploy approval is not needed while live remains current.'
        : incompleteFirstDollarEnvNextAction)
      : (request.liveFingerprintCurrent === true
      ? 'deploy-relevant local work is pending approval/shipping; running paid-path or proof-call checks before this deploy risks proving the wrong approval surface.'
      : 'production is stale; running paid-path or proof-call checks before deploy risks proving the wrong code.')),
  `Git remote sync: ${gitRemoteSync}`,
  `Branch reconciliation required: ${requiresBranchReconcile ? 'yes' : 'no'}`,
  `Deploy state: ${request.deployState}`,
  `Deploy blocker detail: ${request.blockerDetail}`,
  '## Approval 1: Production Deploy',
  '## Approval 2: Stripe Webhook Smoke',
  '## Approval 3: Smoke Cleanup Apply',
  '## Approval 4: Stage Pending Live Railway Environment (No Deploy)',
  'APPROVE_SMIRK_FIRST_DOLLAR_ENV_STAGE: digest=<exact-sha256-from-dry-run>',
  'CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE=apply-smirk-first-dollar-live-env',
  'CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST=<exact-sha256-from-dry-run>',
  'SMIRK_PENDING_FIRST_DOLLAR_ENV_DIGEST',
  'It does not restart production, expose checkout, or require real-checkout authority',
  'npm run -s print:first-dollar-pending-env-activation',
  '## Approval 5: Deploy and Activate Real Starter Checkout',
  'APPROVE_SMIRK_REAL_STARTER_CHECKOUT: accept buyer-initiated subscriptions from unrelated real customers for Starter at the existing $197/month price only',
  'APPROVE_SMIRK_FIRST_DOLLAR_ACTIVATION_DEPLOY: digest=<exact-staged-sha256>',
  'CONFIRM_SMIRK_REAL_STARTER_CHECKOUT=accept-buyer-initiated-starter-197-monthly',
  'CONFIRM_SMIRK_FIRST_DOLLAR_ACTIVATION_DEPLOY=activate-reviewed-first-dollar-pending-env',
  'existing deploy authority, exact commit, same digest, distinct activation-deploy authority, and real Starter checkout authority',
  'generates a one-use upload message bound to the exact commit, pending digest, and random nonce',
  'receipt command independently re-queries Railway for that exact successful nonce-bound deployment',
  'reruns the full live ship gate',
  'preserves all four pending-manifest sentinels as durable evidence',
  '## Approval 6: One Pinned Real Proof Call',
  'APPROVE_SMIRK_REAL_PROOF_CALL: <exact-approved-e164>',
  "CONFIRM_SMIRK_REAL_PROOF_CALL=place-one-smirk-real-proof-call CONFIRM_SMIRK_REAL_PROOF_CALL_TARGET='<exact-approved-e164>' npm run -s proof:real-call -- '<exact-approved-e164>'",
  '## Approval 7: Outreach Batch',
  'APPROVE_SMIRK_OUTREACH_BATCH: targets=<exact-list-or-ledger-ids>; channel=<exact-approved-channel>; copy=<exact-reviewed-template-or-hash>; batch=<exact-count>',
  'This packet never sends or queues outreach.',
  'This is the next money-path proof after deploy and live checks.',
  'ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live',
  'Deploy approval does not authorize the signed Stripe webhook smoke.',
  'APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE: ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live',
  'APPROVE_SMIRK_SMOKE_CLEANUP_APPLY: APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply',
  'checkout-status returns public activation labels: `request_summary.status_label` and `next_step_label`',
  'checkout-status acknowledges the checkout reference without exposing the raw Stripe checkout session ID',
  'Do not run the Stripe smoke without explicit approval.',
  'Do not apply confirmed smoke cleanup without separate explicit cleanup approval.',
  'Do not deploy without explicit deploy approval.',
  'Do not send, queue, or begin outreach without a separate target/channel/copy/batch approval; proof or manual-fallback disclosure is not outreach authority.',
  ...(requiresBranchReconcile ? [] : (
    request.deployState === 'live-already-current' && request.liveFingerprintCurrent === true && expectedFiles.length === 0
      ? [
        ...(liveFirstDollarEnvReady
          ? [
              'Run these non-mutating checks before using the Stripe approval phrase:',
              'npm run -s check:ship-live',
              'WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag',
              'npm run -s check:stripe-webhook-smoke-approval-ready',
              'Run `npm run -s check:ship-live` and `WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag` to confirm live and buffer health.',
              'Run `npm run -s check:stripe-webhook-smoke-approval-ready` to confirm the signed Stripe smoke is still approval-ready.',
            ]
          : [incompleteFirstDollarEnvNextAction]),
        'No production deploy approval is needed right now because live already matches the reviewed commit and the deploy-relevant working tree is clean.',
        'Deploy command intentionally omitted from the recommended action because this packet is for the current live commit.',
      ]
      : [
        `Approval token: \`${deployApprovalToken}\``,
        deployApprovalMeaning,
    'After deploy, run `npm run -s check:ship-live`, then `WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag`.',
    'Run `WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag` so buffered Twilio events are not silently aging before proof.',
    'If post-deploy live and buffer lag checks pass, request separate approval for the signed Stripe smoke.',
      ])),
]) {
  if (!firstDollarApprovalPacket.includes(required)) {
    failures.push(`first-dollar approval packet must include: ${required}`);
  }
}
for (const forbidden of [
  'Begin outreach only after proof passes, or after the remaining manual fallback is written plainly into the offer.',
  'If the write would ' + 'make Starter checkout available',
  'setter enforces both Approval 4 ' + 'and Approval 5',
  'live environment write that would ' + 'open Starter checkout',
  'one Starter-only ' + 'Railway write',
]) {
  if (firstDollarApprovalPacket.includes(forbidden)) {
    failures.push(`first-dollar approval packet contains stale or unsafe authority wording: ${forbidden}`);
  }
}
if (Array.isArray(bundle.deployPreflightRequiredPasses) && bundle.deployPreflightRequiredPasses.length > 0) {
  const requiredPassesLine = `Required passes: ${bundle.deployPreflightRequiredPasses.join(', ')}.`;
  if (!firstDollarApprovalPacket.includes(requiredPassesLine)) {
    failures.push(`first-dollar approval packet must include deploy preflight required passes: ${requiredPassesLine}`);
  }
}
if (requiresBranchReconcile) {
  for (const required of [
    '## Approval 0: Branch Reconciliation',
    'This is the only safe next approval. It does not authorize deploy, Stripe smoke, cleanup apply, proof call, secret access, paid spend, or outreach.',
    'Approval token: `APPROVE_SMIRK_BRANCH_RECONCILE`',
    'npm run -s print:branch-reconcile-approval',
    'Authorized command after Cameron approves the token:',
    'Do not run a production deploy from this packet. Deploy approval comes only after branch synchronization and regenerated readiness pass.',
    'Deploy command intentionally withheld from the recommended action until synchronization is complete and this packet is regenerated.',
  ]) {
    if (!firstDollarApprovalPacket.includes(required)) {
      failures.push(`first-dollar approval packet must include branch reconciliation guardrail: ${required}`);
    }
  }
  for (const [label, content] of [
    ['FIRST_HUMAN_RUN.md', firstHumanRun],
    ['README.md', readme],
  ]) {
    for (const required of [
      'npm run -s print:branch-reconcile-approval',
      'APPROVE_SMIRK_BRANCH_RECONCILE',
      'dedicated packet',
      'It does not authorize deploy, Stripe smoke, cleanup apply, proof call, secret access, paid spend, or outreach.',
    ]) {
      if (!content.includes(required)) {
        failures.push(`${label} must include branch reconciliation handoff guardrail: ${required}`);
      }
    }
  }
  if (packageJson.scripts?.['print:branch-reconcile-approval'] !== 'node scripts/print-branch-reconcile-approval.mjs') {
    failures.push('package.json must expose print:branch-reconcile-approval for the dedicated branch reconciliation handoff');
  }
  if (!existsSync('scripts/print-branch-reconcile-approval.mjs')) {
    failures.push('scripts/print-branch-reconcile-approval.mjs must exist for the dedicated branch reconciliation handoff');
  }
}
if (!firstDollarApprovalPacket.includes(`Deploy-relevant files covered: ${expectedFiles.length}`)) {
  failures.push(`first-dollar approval packet must include deploy-relevant file count ${expectedFiles.length}`);
}
if (request.deployState !== 'live-already-current' && typeof request.command === 'string' && !firstDollarApprovalPacket.includes(request.command)) {
  failures.push('first-dollar approval packet must include the current deploy approval command');
}

const requestBranch = request.branch;
const requiresDeployBranchConfirmation = requestBranch && requestBranch !== 'main';
if (request.deployBranchMismatch === true) {
  for (const [label, value] of [
    ['request.deployBranchMismatchReason', request.deployBranchMismatchReason],
    ['handoff.deployBranchMismatchReason', handoff.deployBranchMismatchReason],
    ['approval note deploy branch mismatch line', approvalNote],
  ]) {
    if (typeof value !== 'string' || !value.includes('differs from live branch')) {
      failures.push(`${label} must explain the local/live branch mismatch`);
    }
  }
}

if (requiresDeployBranchConfirmation) {
  if (request.gitRemoteSync !== gitRemoteSync) {
    failures.push(`request.gitRemoteSync must be ${gitRemoteSync}`);
  }
  if (handoff.gitRemoteSync !== gitRemoteSync) {
    failures.push(`handoff.gitRemoteSync must be ${gitRemoteSync}`);
  }
  if (bundle.gitRemoteSync !== gitRemoteSync) {
    failures.push(`bundle.gitRemoteSync must be ${gitRemoteSync}`);
  }
  if (request.branchReconcileRequired !== requiresBranchReconcile) {
    failures.push(`request.branchReconcileRequired must be ${requiresBranchReconcile}`);
  }
  if (handoff.branchReconcileRequired !== requiresBranchReconcile) {
    failures.push(`handoff.branchReconcileRequired must be ${requiresBranchReconcile}`);
  }
  if (bundle.branchReconcileRequired !== requiresBranchReconcile) {
    failures.push(`bundle.branchReconcileRequired must be ${requiresBranchReconcile}`);
  }
  if (requiresBranchReconcile) {
    if (typeof bundle.branchReconcileCommand !== 'string' || !bundle.branchReconcileCommand.includes('git pull --rebase origin main')) {
      failures.push('bundle.branchReconcileCommand must include the origin/main rebase step when branch reconciliation is required');
    }
    if (typeof bundle.nextSafeAction !== 'string' || !bundle.nextSafeAction.includes('Synchronize local branch with origin/main')) {
      failures.push('bundle.nextSafeAction must tell the operator to synchronize local branch with origin/main before deploy approval');
    }
    if (typeof bundle.nextAction !== 'string' || !bundle.nextAction.includes('Synchronize local branch with origin/main')) {
      failures.push('bundle.nextAction must tell the operator to synchronize local branch with origin/main before deploy approval');
    }
    if (bundle.artifactPaths?.branchReconcileApprovalPath !== 'output/branch-reconcile-approval.md' && !String(bundle.artifactPaths?.branchReconcileApprovalPath || '').endsWith('/output/branch-reconcile-approval.md')) {
      failures.push('bundle.artifactPaths.branchReconcileApprovalPath must point to output/branch-reconcile-approval.md when branch reconciliation is required');
    }
  } else {
    if (bundle.branchReconcileCommand !== null) {
      failures.push('bundle.branchReconcileCommand must be null when branch reconciliation is not required');
    }
    if (bundle.nextSafeAction !== null) {
      failures.push('bundle.nextSafeAction must be null when branch reconciliation is not required');
    }
    if (bundle.artifactPaths?.branchReconcileApprovalPath !== null || bundle.artifactPaths?.branchReconcileApprovalJsonPath !== null) {
      failures.push('bundle branch reconciliation artifact paths must be null when branch reconciliation is not required');
    }
  }
  for (const [label, value] of deployCommands) {
    if (typeof value !== 'string' || !value.includes(`CONFIRM_SMIRK_DEPLOY_BRANCH=${requestBranch}`)) {
      failures.push(`${label} must include CONFIRM_SMIRK_DEPLOY_BRANCH=${requestBranch} when deploying from a non-main branch`);
    }
  }
  if (!handoffSource.includes('fallbackDeployCommand') || handoffSource.includes("approvalData?.command || 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix npm run deploy:post-call-fix'")) {
    failures.push('scripts/print-post-call-fix-handoff.mjs fallback deploy command must be branch-aware');
  }
}

if (deploySource.includes('git push')) {
  failures.push('deploy.sh must not push Git under production-deploy approval; source-control publication requires separate authority');
}

for (const required of [
  'git fetch origin "$TARGET_BRANCH"',
  'origin/$TARGET_BRANCH',
  'git pull --rebase origin $TARGET_BRANCH',
]) {
  if (!deploySource.includes(required)) {
    failures.push(`deploy.sh must verify target branch remote sync before deploy: missing ${required}`);
  }
}

const verifyBundleIndex = deploySource.indexOf('npm run check:deploy-approval-handoff');
const deployPreflightIndexes = [
  deploySource.indexOf('npm run check:deploy-post-call-fix-ready'),
  deploySource.indexOf('npm run -s check:deploy-post-call-fix-ready'),
].filter((index) => index !== -1);
const deployPreflightIndex = deployPreflightIndexes.length > 0
  ? Math.min(...deployPreflightIndexes)
  : -1;
if (verifyBundleIndex === -1 || deployPreflightIndex === -1 || verifyBundleIndex > deployPreflightIndex) {
  failures.push('deploy.sh must validate the saved exact-commit approval packet before running deploy preflight');
}
if (deploySource.includes('npm run write:deploy-approval-bundle')) {
  failures.push('deploy.sh must not regenerate the approval packet after the user approves it');
}
if (deploySource.includes('git add -A') || deploySource.includes('git commit -m')) {
  failures.push('deploy.sh must not alter the reviewed source commit');
}
if (!deploySource.includes('deploy requires a clean, reviewed exact commit')) {
  failures.push('deploy.sh must fail closed on a dirty worktree before approval confirmation');
}

const liveBaselineCommand = 'npm run -s check:deploy-live-baseline';
const archiveSafetyCommand = 'npm run -s check:deploy-archive-safety';
const pendingActivationBaselineBlock = String.raw`echo "=== Capturing exact-target deployment baseline for any pending first-dollar activation ==="
PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON="$(npm run -s capture:first-dollar-pending-env-deployment-baseline)"
printf '%s\n' "$PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON"
PENDING_ACTIVATION_UPLOAD_MESSAGE="$(node -e '
  const baseline = JSON.parse(process.argv[1]);
  if (baseline.pending === true && !/^smirk-first-dollar-activation:[a-f0-9]{40}:[a-f0-9]{64}:[a-f0-9]{24}$/.test(String(baseline.uploadMessage || ""))) {
    throw new Error("pending activation upload message is missing or invalid");
  }
  process.stdout.write(baseline.pending === true ? String(baseline.uploadMessage) : "");
' "$PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON")"
if [ -z "$PENDING_ACTIVATION_UPLOAD_MESSAGE" ]; then
  PENDING_ACTIVATION_UPLOAD_MESSAGE="smirk-reviewed-deploy:$TARGET_COMMIT"
fi`;
const finalExactCommitAssertion = 'if [ "$(git rev-parse HEAD)" != "$TARGET_COMMIT" ] || [ -n "$(git status --porcelain=v1 --untracked-files=all)" ]; then';
const railwayUpIndex = deploySource.indexOf('railway up --detach');
const existingDeployConfirmationIndex = deploySource.indexOf('npm run confirm:post-call-fix-deploy');
const pendingActivationCheckIndex = deploySource.indexOf('npm run -s check:first-dollar-pending-env-activation');
const postDeployShipCheckIndex = deploySource.indexOf('npm run check:ship-live');
const activationReceiptIndex = deploySource.indexOf('npm run -s record:first-dollar-activation-receipt');
const pendingActivationBaselineIndex = deploySource.indexOf(pendingActivationBaselineBlock);
const pendingActivationDeploymentWaitIndex = deploySource.indexOf('npm run -s wait:first-dollar-pending-env-deployment');
const liveCommitWaitIndex = deploySource.indexOf('npm run wait:live-is-current');
const stampIndex = deploySource.indexOf('npm run stamp:deploy-fingerprint');
const liveBaselineIndex = deploySource.indexOf(liveBaselineCommand);
const archiveSafetyIndex = deploySource.indexOf(archiveSafetyCommand);
const finalExactCommitIndex = deploySource.lastIndexOf(finalExactCommitAssertion);
const finalExactCommitEnd = finalExactCommitIndex === -1
  ? -1
  : deploySource.indexOf('\nfi', finalExactCommitIndex);
if (
  existingDeployConfirmationIndex === -1
  || pendingActivationCheckIndex === -1
  || railwayUpIndex === -1
  || !(existingDeployConfirmationIndex < pendingActivationCheckIndex && pendingActivationCheckIndex < railwayUpIndex)
) {
  failures.push('deploy.sh must verify existing deploy authority and strict pending first-dollar activation authority before every Railway upload');
}
if (
  postDeployShipCheckIndex === -1
  || activationReceiptIndex === -1
  || activationReceiptIndex < postDeployShipCheckIndex
) {
  failures.push('deploy.sh must record the first-dollar activation receipt only after the full post-deploy ship check succeeds');
}
if (
  pendingActivationDeploymentWaitIndex === -1
  || liveCommitWaitIndex === -1
  || railwayUpIndex === -1
  || !(railwayUpIndex < pendingActivationDeploymentWaitIndex && pendingActivationDeploymentWaitIndex < liveCommitWaitIndex && liveCommitWaitIndex < postDeployShipCheckIndex)
) {
  failures.push('deploy.sh must wait for the exact nonce-bound reviewed activation upload before live commit, ship checks, and activation receipt recording');
}
if (railwayUpIndex === -1 || stampIndex === -1 || stampIndex > railwayUpIndex) {
  failures.push('deploy.sh must stamp the deploy fingerprint before uploading the built bundle');
}
if (packageJson.scripts?.['check:deploy-live-baseline'] !== 'node scripts/check-deploy-live-baseline.mjs') {
  failures.push('package.json must expose the final independent production live-baseline check');
}
for (const required of [
  "resolveAuthoritativeLiveDeployReviewBase()",
  "output/deploy-approval-bundle.json",
  "bundle.deployReviewBaseRef !== authoritativeBase.ref",
  "bundle.deployReviewBaseCommit !== authoritativeBase.commit",
  "bundle.sourceCommit !== currentHead",
]) {
  if (!deployLiveBaselineSource.includes(required)) {
    failures.push(`final deploy live-baseline check is missing required binding: ${required}`);
  }
}
if (
  railwayUpIndex === -1
  || liveBaselineIndex === -1
  || archiveSafetyIndex === -1
  || pendingActivationBaselineIndex === -1
  || finalExactCommitIndex === -1
  || finalExactCommitEnd === -1
  || !(stampIndex < liveBaselineIndex && liveBaselineIndex < archiveSafetyIndex && archiveSafetyIndex < pendingActivationBaselineIndex && pendingActivationBaselineIndex < finalExactCommitIndex && finalExactCommitIndex < railwayUpIndex)
) {
  failures.push('deploy.sh must recheck the approved production baseline, run archive safety, capture the activation deployment baseline, then assert final exact HEAD+clean state immediately before railway up');
} else {
  const betweenLiveBaselineAndArchiveSafety = deploySource
    .slice(liveBaselineIndex + liveBaselineCommand.length, archiveSafetyIndex)
    .trim();
  const betweenArchiveSafetyAndPendingBaseline = deploySource
    .slice(archiveSafetyIndex + archiveSafetyCommand.length, pendingActivationBaselineIndex)
    .trim();
  const betweenPendingBaselineAndFinalAssertion = deploySource
    .slice(pendingActivationBaselineIndex + pendingActivationBaselineBlock.length, finalExactCommitIndex)
    .trim();
  const betweenFinalAssertionAndRailwayUp = deploySource
    .slice(finalExactCommitEnd + '\nfi'.length, railwayUpIndex)
    .trim();
  if (betweenLiveBaselineAndArchiveSafety || betweenArchiveSafetyAndPendingBaseline || betweenPendingBaselineAndFinalAssertion || betweenFinalAssertionAndRailwayUp) {
    failures.push('deploy.sh must recheck the approved production baseline, run archive safety, capture the activation deployment baseline, then assert final exact HEAD+clean state immediately before railway up');
  }
}

const out = {
  ok: failures.length === 0,
  deployRelevantFileCount: expectedFiles.length,
  checkedArtifacts: artifactPaths,
  failures,
};

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
