#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const deployConfirmation = 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix';
const deployApprovalToken = 'APPROVE_SMIRK_POST_CALL_FIX_DEPLOY';
const deployApprovalMeaning = 'Production deploy approval only. This does not authorize Stripe smoke, cleanup apply, proof calls, secret access, paid spend, or outreach.';

function deployRelevantFiles() {
  return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .flatMap((line) => {
      const file = line.replace(/^.{1,2}\s+/, '').replace(/^.* -> /, '').trim();
      const status = line.slice(0, 2).trim();
      if (status === '??' && existsSync(file) && statSync(file).isDirectory()) {
        return execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', file], { encoding: 'utf8' })
          .split(/\r?\n/)
          .filter(Boolean);
      }
      return [file];
    })
    .filter((file) => file && !file.startsWith('output/') && !file.startsWith('outputs/') && !file.startsWith('tmp/') && !file.startsWith('.artifacts/'));
}

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

const expectedFiles = deployRelevantFiles();

if (expectedFiles.length === 0) {
  console.log(JSON.stringify({
    ok: true,
    deployRelevantFileCount: 0,
    checkedArtifacts: [],
    skippedArtifacts: [
      'output/deploy-approval-bundle.json',
      'output/deploy-approval-request.json',
      'output/high-risk-deploy-review.json',
      'output/post-call-fix-handoff.json',
    ],
    reason: 'No deploy-relevant local changes; deploy approval handoff is not required.',
    failures: [],
  }, null, 2));
  process.exit(0);
}

const artifactPaths = [
  'output/deploy-approval-bundle.json',
  'output/deploy-approval-request.json',
  'output/high-risk-deploy-review.json',
  'output/post-call-fix-handoff.json',
  'output/stripe-webhook-smoke-approval.json',
  'output/stripe-webhook-smoke-approval.md',
  'output/first-dollar-approval-packet.md',
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
const review = readJson('output/high-risk-deploy-review.json');
const handoff = readJson('output/post-call-fix-handoff.json');
const packageJson = readJson('package.json');
const approvalNote = readFileSync('output/post-call-fix-approval-note.md', 'utf8');
const firstDollarApprovalPacket = readFileSync('output/first-dollar-approval-packet.md', 'utf8');
const firstHumanRun = readFileSync('FIRST_HUMAN_RUN.md', 'utf8');
const readme = readFileSync('README.md', 'utf8');
const handoffSource = readFileSync('scripts/print-post-call-fix-handoff.mjs', 'utf8');
const deploySource = readFileSync('deploy.sh', 'utf8');

const reviewFiles = Array.isArray(review.files) ? review.files.map((item) => item.file) : [];
const requestFiles = Array.isArray(request.highRiskFiles) ? request.highRiskFiles : [];
const requestDirtyFiles = Array.isArray(request.deployRelevantDirtyFiles) ? request.deployRelevantDirtyFiles : [];
const bundleDirtyFiles = Array.isArray(bundle.deployRelevantDirtyFiles) ? bundle.deployRelevantDirtyFiles : [];
const handoffFiles = Array.isArray(handoff.highRiskFiles) ? handoff.highRiskFiles : [];
const expectedPostDeployProofSteps = [
  'npm run -s check:ship-live',
  'npm run -s check:real-call-readiness -- <safe-number>',
  'npm run -s proof:real-call -- <safe-number>',
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
  'clientOnboardingIntake',
  'stripeWebhookPreflight',
  'stripeWebhookApprovalReady',
  'operationalAuthLive',
  'proofArtifactsLive',
  'postCallIntelligenceLive',
  'handoffSafety',
  'railwayAccess',
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
  ['bundle.deployRelevantDirtyFiles', bundleDirtyFiles],
  ['request.deployRelevantDirtyFiles', requestDirtyFiles],
  ['request.highRiskFiles', requestFiles],
  ['review.files', reviewFiles],
  ['handoff.highRiskFiles', handoffFiles],
];

for (const [label, files] of setChecks) {
  const { missing, extra } = sameSet(files, expectedFiles);
  if (missing.length || extra.length) {
    failures.push(`${label} does not match deploy-relevant files: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
  }
}

const deployCommands = [
  ['request.command', request.command],
  ['handoff.deployCommand', handoff.deployCommand],
];
for (const [label, value] of deployCommands) {
  if (typeof value !== 'string' || !value.includes(deployConfirmation) || !value.includes('npm run deploy:post-call-fix')) {
    failures.push(`${label} must include the confirmed deploy command`);
  }
}
if (!requiresBranchReconcile && (typeof bundle.nextAction !== 'string' || !bundle.nextAction.includes(deployConfirmation) || !bundle.nextAction.includes('npm run deploy:post-call-fix'))) {
  failures.push('bundle.nextAction must include the confirmed deploy command when branch reconciliation is not required');
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
  if (data.expectedDeployBlockerAfterRequiredPasses !== 'stale-production-deploy') {
    failures.push(`${label}.expectedDeployBlockerAfterRequiredPasses must be stale-production-deploy`);
  }
  if (data.postDeployStripeWebhookSmokeApprovalPhrase !== expectedPostDeployStripeWebhookSmokeApprovalPhrase) {
    failures.push(`${label}.postDeployStripeWebhookSmokeApprovalPhrase must preserve the exact Stripe smoke approval phrase`);
  }
  if (data.postDeploySmokeCleanupApplyApprovalPhrase !== expectedPostDeploySmokeCleanupApplyApprovalPhrase) {
    failures.push(`${label}.postDeploySmokeCleanupApplyApprovalPhrase must preserve the exact smoke cleanup approval phrase`);
  }
}

if (expectedFiles.length > 0) {
  for (const [label, data] of [
    ['request', request],
    ['handoff', handoff],
    ['bundle', bundle],
  ]) {
    if (data.deployState !== 'pending-local-deploy-work') {
      failures.push(`${label}.deployState must be pending-local-deploy-work when deploy-relevant local changes exist`);
    }
    const expectedBlockerDetail = data.liveFingerprintCurrent === true
      ? expectedLiveCurrentBlockerDetail
      : expectedStaleBlockerDetail;
    if (data.blockerDetail !== expectedBlockerDetail) {
      failures.push(`${label}.blockerDetail must match live fingerprint state: expected ${JSON.stringify(expectedBlockerDetail)}`);
    }
    if (typeof data.liveFingerprintCurrent !== 'boolean') {
      failures.push(`${label}.liveFingerprintCurrent must be a boolean`);
    }
    if (data.localDeployClean !== false) {
      failures.push(`${label}.localDeployClean must be false when deploy-relevant local changes exist`);
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
  if (!approvalNote.includes('- Deploy state: pending-local-deploy-work')) {
    failures.push('approval note must include pending-local-deploy-work deploy state when deploy-relevant local changes exist');
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
  if (!approvalNote.includes('- Local deploy clean: no')) {
    failures.push('approval note must state that local deploy is not clean when deploy-relevant changes exist');
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
    'npm run -s check:real-call-readiness -- <safe-number>',
    'npm run -s proof:real-call -- <safe-number>',
    'The proof runner re-runs check:post-deploy-live and stops before dialing unless the deployed app passes the post-deploy live audit.',
    'Real-call readiness runs first-dollar guard coverage before clearing a proof call.',
    'Expected proof: call record, generated summary, owner email alert, callback task, and dashboard proof counters.',
    'Do not place a real proof call until check:real-call-readiness passes for the same explicit safe number.',
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
    : 'Approve the production deploy first.',
  requiresBranchReconcile
    ? 'After synchronization, regenerate this packet and rerun deploy readiness before any production deploy approval.'
    : (request.liveFingerprintCurrent === true
      ? 'deploy-relevant local work is pending approval/shipping; running paid-path or proof-call checks before this deploy risks proving the wrong approval surface.'
      : 'production is stale; running paid-path or proof-call checks before deploy risks proving the wrong code.'),
  `Git remote sync: ${gitRemoteSync}`,
  `Branch reconciliation required: ${requiresBranchReconcile ? 'yes' : 'no'}`,
  'Deploy state: pending-local-deploy-work',
  `Deploy blocker detail: ${request.blockerDetail}`,
  '## Approval 1: Production Deploy',
  `Approval token: \`${deployApprovalToken}\``,
  deployApprovalMeaning,
  '## Approval 2: Stripe Webhook Smoke',
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
  'Do not begin outreach until paid activation proof is either passed or honestly disclosed as manual fallback.',
  ...(requiresBranchReconcile ? [] : ['After deploy, run `npm run -s check:ship-live`.']),
]) {
  if (!firstDollarApprovalPacket.includes(required)) {
    failures.push(`first-dollar approval packet must include: ${required}`);
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
if (typeof request.command === 'string' && !firstDollarApprovalPacket.includes(request.command)) {
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

if (!deploySource.includes('git push origin "HEAD:$TARGET_BRANCH"')) {
  failures.push('deploy.sh must push the reviewed current HEAD to its confirmed target branch');
}

if (deploySource.includes('git push origin main')) {
  failures.push('deploy.sh must not push local main implicitly from a non-main deploy branch');
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

const writeBundleIndex = deploySource.indexOf('npm run write:deploy-approval-bundle');
const deployPreflightIndex = deploySource.indexOf('npm run check:deploy-post-call-fix-ready');
if (writeBundleIndex === -1 || deployPreflightIndex === -1 || writeBundleIndex > deployPreflightIndex) {
  failures.push('deploy.sh must refresh deploy approval artifacts before running deploy preflight');
}

const railwayUpIndex = deploySource.indexOf('railway up --detach');
const stampIndex = deploySource.indexOf('npm run stamp:deploy-fingerprint');
if (railwayUpIndex === -1 || stampIndex === -1 || stampIndex > railwayUpIndex) {
  failures.push('deploy.sh must stamp the deploy fingerprint before uploading the built bundle');
}

const out = {
  ok: failures.length === 0,
  deployRelevantFileCount: expectedFiles.length,
  checkedArtifacts: artifactPaths,
  failures,
};

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
