#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  collectSmirkApprovalTokens,
  DEPLOY_APPROVAL_ONE_DECISION_TOKEN,
  isDeployApprovalOneDecisionReady,
  renderDeployApprovalOneDecisionCard,
  validateNoDeployApprovalTokens,
  validateDeployApprovalOneDecisionCard,
} from './lib/deploy-approval-one-decision-card.mjs';

const commit = 'c5a7e50a89de567f08ad9a2e546739525f121809';
const branch = 'codex/market-validation-launch';
const deployCommand = `SMIRK_FIRST_DOLLAR_ENV_BOOTSTRAP_DEPLOY=deploy-fail-closed-checkout CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix CONFIRM_SMIRK_DEPLOY_BRANCH=${branch} CONFIRM_SMIRK_DEPLOY_COMMIT=${commit} npm run deploy:post-call-fix`;
const readyBundle = {
  ok: true,
  generatedAt: '2026-07-18T19:04:08.001Z',
  sourceCommit: commit,
  localCommit: commit,
  expectedVersion: commit,
  actualVersion: '8f5ceb7d2df6fbdbce09736219d75e2b3e375687',
  localBranch: branch,
  liveStatus: 200,
  liveReadinessHeader: '1',
  liveVersionCurrent: false,
  deployState: 'stale-production-deploy',
  localDeployClean: true,
  deployRelevantDirtyFiles: [],
  reviewFilesCount: 235,
  reviewReady: true,
  branchReconcileRequired: false,
  pendingFirstDollarEnvStaged: false,
  liveFirstDollarEnvReady: false,
  firstDollarBootstrapDeployRequired: true,
  firstDollarBootstrapDeployMode: 'SMIRK_FIRST_DOLLAR_ENV_BOOTSTRAP_DEPLOY=deploy-fail-closed-checkout',
  deployApprovalToken: DEPLOY_APPROVAL_ONE_DECISION_TOKEN,
  deployCommand,
};

assert.equal(isDeployApprovalOneDecisionReady(readyBundle), true);
const card = renderDeployApprovalOneDecisionCard(readyBundle);
const validation = validateDeployApprovalOneDecisionCard(card, readyBundle);
assert.deepEqual(validation, {
  ok: true,
  ready: true,
  approvalTokens: [DEPLOY_APPROVAL_ONE_DECISION_TOKEN],
  failures: [],
});
assert.equal((card.match(/\bAPPROVE_SMIRK_[A-Z0-9_]+\b/g) || []).length, 1);
assert.deepEqual(collectSmirkApprovalTokens(card), [DEPLOY_APPROVAL_ONE_DECISION_TOKEN]);
assert.equal(validateNoDeployApprovalTokens(card).ok, false);
assert.equal((card.match(/## One post-action/g) || []).length, 1);
assert.equal((card.match(/npm run -s check:ship-live/g) || []).length, 1);
for (const expected of [
  `- Branch: ${branch}`,
  `- Reviewed HEAD: ${commit}`,
  `- Live version: ${readyBundle.actualVersion}`,
  '- Live health: 200 (readiness 1)',
  '- Local deploy clean: yes',
  '- Reviewed deploy-relevant files: 235',
  deployCommand,
  'It does not authorize a Git push, live environment changes, checkout activation, charges, Stripe smoke, proof calls, outreach, paid spend, cleanup, or production-data deletion.',
]) {
  assert.ok(card.includes(expected), `ready card must include ${expected}`);
}

const injectedApproval = card.replace(
  'Detailed evidence remains',
  '`APPROVE_SMIRK_OUTREACH_BATCH`\n\nDetailed evidence remains',
);
const injectedValidation = validateDeployApprovalOneDecisionCard(injectedApproval, readyBundle);
assert.equal(injectedValidation.ok, false);
assert.deepEqual(injectedValidation.approvalTokens, [
  DEPLOY_APPROVAL_ONE_DECISION_TOKEN,
  'APPROVE_SMIRK_OUTREACH_BATCH',
]);
assert.ok(injectedValidation.failures.some((failure) => failure.includes('no other APPROVE_SMIRK_* token')));

const driftedCard = card.replace(readyBundle.actualVersion, 'different-live-version');
const driftedValidation = validateDeployApprovalOneDecisionCard(driftedCard, readyBundle);
assert.equal(driftedValidation.ok, false);
assert.ok(driftedValidation.failures.includes('card content must exactly match the current deploy approval bundle'));

for (const unsafeBundle of [
  { ...readyBundle, localDeployClean: false, deployRelevantDirtyFiles: ['server.ts'] },
  { ...readyBundle, branchReconcileRequired: true },
  { ...readyBundle, pendingFirstDollarEnvStaged: true },
  { ...readyBundle, deployCommand: deployCommand.replace(commit, 'wrong-commit') },
  { ...readyBundle, deployCommand: `${deployCommand} && APPROVE_SMIRK_OUTREACH_BATCH=1` },
  { ...readyBundle, deployCommand: `ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 ${deployCommand}` },
  { ...readyBundle, deployCommand: deployCommand.replace('SMIRK_FIRST_DOLLAR_ENV_BOOTSTRAP_DEPLOY=deploy-fail-closed-checkout ', '') },
  { ...readyBundle, deployCommand: deployCommand.replace('CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix', 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=wrong') },
]) {
  assert.equal(isDeployApprovalOneDecisionReady(unsafeBundle), false);
  const unsafeCard = renderDeployApprovalOneDecisionCard(unsafeBundle);
  assert.equal((unsafeCard.match(/\bAPPROVE_SMIRK_[A-Z0-9_]+\b/g) || []).length, 0);
  assert.equal(validateDeployApprovalOneDecisionCard(unsafeCard, unsafeBundle).ok, true);
  assert.equal(validateNoDeployApprovalTokens(unsafeCard).ok, true);
}

const handoffVerifierSource = fs.readFileSync('scripts/check-deploy-approval-handoff.mjs', 'utf8');
assert.match(handoffVerifierSource, /if \(expectedFiles\.length === 0\) \{[\s\S]*collectSmirkApprovalTokens[\s\S]*process\.exit\(failures\.length === 0 \? 0 : 1\);/);

console.log(JSON.stringify({
  ok: true,
  fixtureCount: 11,
  approvalTokenCount: validation.approvalTokens.length,
  failures: [],
}, null, 2));
