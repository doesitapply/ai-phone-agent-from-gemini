import { buildExactDeployCommand } from './deploy-command.mjs';

const FIRST_DOLLAR_BOOTSTRAP_MODE = 'deploy-fail-closed-checkout';

export const DEPLOY_APPROVAL_ONE_DECISION_TOKEN = 'APPROVE_SMIRK_POST_CALL_FIX_DEPLOY';
export const DEPLOY_APPROVAL_ONE_DECISION_PATH = 'output/smirk-deploy-approval-one-line-latest.md';

function value(value) {
  return String(value ?? '').trim();
}

export function collectSmirkApprovalTokens(card) {
  return String(card ?? '').match(/\bAPPROVE_SMIRK_[A-Z0-9_]+\b/g) || [];
}

export function validateNoDeployApprovalTokens(card) {
  const approvalTokens = collectSmirkApprovalTokens(card);
  return {
    ok: approvalTokens.length === 0,
    approvalTokens,
    failures: approvalTokens.length === 0
      ? []
      : ['no deploy-relevant change may retain an APPROVE_SMIRK_* token in the latest one-decision card'],
  };
}

export function isDeployApprovalOneDecisionReady(bundle = {}) {
  const sourceCommit = value(bundle.sourceCommit);
  const localCommit = value(bundle.localCommit);
  const expectedVersion = value(bundle.expectedVersion);
  const localBranch = value(bundle.localBranch);
  const actualVersion = value(bundle.actualVersion);
  const deployCommand = value(bundle.deployCommand);
  const firstDollarBootstrapDeployRequired = bundle.firstDollarBootstrapDeployRequired === true;
  const liveFirstDollarEnvReady = bundle.liveFirstDollarEnvReady === true;
  const dirtyFiles = Array.isArray(bundle.deployRelevantDirtyFiles)
    ? bundle.deployRelevantDirtyFiles
    : null;
  let exactDeployCommand = null;
  try {
    exactDeployCommand = buildExactDeployCommand({
      branch: localBranch,
      commit: sourceCommit,
      bootstrapMode: firstDollarBootstrapDeployRequired ? FIRST_DOLLAR_BOOTSTRAP_MODE : null,
    });
  } catch {
    return false;
  }

  return bundle.ok === true
    && bundle.reviewReady === true
    && bundle.branchReconcileRequired === false
    && bundle.pendingFirstDollarEnvStaged !== true
    && bundle.deployState === 'stale-production-deploy'
    && bundle.liveVersionCurrent === false
    && bundle.localDeployClean === true
    && dirtyFiles?.length === 0
    && sourceCommit.length > 0
    && sourceCommit === localCommit
    && sourceCommit === expectedVersion
    && localBranch.length > 0
    && actualVersion.length > 0
    && actualVersion !== sourceCommit
    && Number(bundle.liveStatus) === 200
    && value(bundle.liveReadinessHeader) === '1'
    && Number.isInteger(bundle.reviewFilesCount)
    && bundle.reviewFilesCount > 0
    && bundle.deployApprovalToken === DEPLOY_APPROVAL_ONE_DECISION_TOKEN
    && firstDollarBootstrapDeployRequired === !liveFirstDollarEnvReady
    && (!firstDollarBootstrapDeployRequired || value(bundle.firstDollarBootstrapDeployMode) === `SMIRK_FIRST_DOLLAR_ENV_BOOTSTRAP_DEPLOY=${FIRST_DOLLAR_BOOTSTRAP_MODE}`)
    && deployCommand === exactDeployCommand;
}

export function renderDeployApprovalOneDecisionCard(bundle = {}) {
  const generatedAt = value(bundle.generatedAt) || 'unknown';
  const sourceCommit = value(bundle.sourceCommit) || 'unknown';
  const localBranch = value(bundle.localBranch) || 'unknown';
  const actualVersion = value(bundle.actualVersion) || 'unknown';

  if (!isDeployApprovalOneDecisionReady(bundle)) {
    return [
      '# SMIRK production deploy - one decision now',
      '',
      `Generated: ${generatedAt}`,
      '',
      '## No deploy approval requested',
      '',
      'The exact-commit deploy bundle is not approval-ready. Do not approve or run a production deploy from this card.',
      '',
      `- Branch: ${localBranch}`,
      `- Reviewed HEAD: ${sourceCommit}`,
      `- Live version: ${actualVersion}`,
      `- Bundle ready: ${bundle.ok === true ? 'yes' : 'no'}`,
      `- Local deploy clean: ${bundle.localDeployClean === true ? 'yes' : 'no'}`,
      '',
      'Regenerate with `npm run write:deploy-approval-bundle` after the exact commit is clean and all deploy-review gates pass.',
    ].join('\n') + '\n';
  }

  return [
    '# SMIRK production deploy - one decision now',
    '',
    `Generated: ${generatedAt}`,
    '',
    '## Decision now',
    '',
    'Reply exactly:',
    '',
    `\`${DEPLOY_APPROVAL_ONE_DECISION_TOKEN}\``,
    '',
    '## Exact reviewed target',
    '',
    `- Branch: ${localBranch}`,
    `- Reviewed HEAD: ${sourceCommit}`,
    `- Live version: ${actualVersion}`,
    `- Live health: ${Number(bundle.liveStatus)} (readiness ${value(bundle.liveReadinessHeader)})`,
    '- Local deploy clean: yes',
    `- Reviewed deploy-relevant files: ${bundle.reviewFilesCount}`,
    '',
    '## Exact command after approval',
    '',
    '```bash',
    value(bundle.deployCommand),
    '```',
    '',
    '## Scope',
    '',
    'This authorizes only the exact-commit production deploy above. It does not authorize a Git push, live environment changes, checkout activation, charges, Stripe smoke, proof calls, outreach, paid spend, cleanup, or production-data deletion.',
    '',
    '## One post-action',
    '',
    'Run `npm run -s check:ship-live`, then stop and report the result. No other production action is authorized by this card.',
    '',
    'Detailed evidence remains in `output/deploy-approval-bundle.json`, `output/post-call-fix-approval-note.md`, and `output/first-dollar-approval-packet.md`.',
  ].join('\n') + '\n';
}

export function validateDeployApprovalOneDecisionCard(card, bundle = {}) {
  const failures = [];
  const content = String(card ?? '');
  const ready = isDeployApprovalOneDecisionReady(bundle);
  const expected = renderDeployApprovalOneDecisionCard(bundle);
  const approvalTokens = collectSmirkApprovalTokens(content);

  if (content !== expected) {
    failures.push('card content must exactly match the current deploy approval bundle');
  }
  if (ready) {
    if (approvalTokens.length !== 1 || approvalTokens[0] !== DEPLOY_APPROVAL_ONE_DECISION_TOKEN) {
      failures.push(`approval-ready card must contain exactly one ${DEPLOY_APPROVAL_ONE_DECISION_TOKEN} token and no other APPROVE_SMIRK_* token`);
    }
  } else if (approvalTokens.length !== 0) {
    failures.push('non-ready card must not contain any APPROVE_SMIRK_* token');
  }

  return {
    ok: failures.length === 0,
    ready,
    approvalTokens,
    failures,
  };
}
