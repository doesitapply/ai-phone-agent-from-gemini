#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REQUIRED_BOOTSTRAP_PREFLIGHT_BLOCKED_UNTIL_DEPLOY,
  REQUIRED_BOOTSTRAP_PREFLIGHT_PASSES,
  evaluateFirstDollarBootstrapDeploy,
} from './lib/first-dollar-bootstrap-deploy.mjs';

const targetCommit = 'b'.repeat(40);
const liveCommit = 'a'.repeat(40);
const targetBranch = 'codex/market-validation-launch';

function validPreflight() {
  const value = {
    ok: true,
    blocker: 'stale-production-deploy',
    deployState: 'stale-production-deploy',
    liveFingerprintCurrent: false,
    liveCurrent: 'stale',
    localDeployClean: true,
    deployRelevantDirtyFiles: [],
    localCommit: targetCommit,
    expectedVersion: targetCommit,
    localBranch: targetBranch,
    gitRemoteSync: 'ahead',
    branchSyncConflictForecast: 'not-needed',
    requiresApproval: true,
    proofArtifactsLive: 'blocked-until-deploy',
    postCallIntelligenceLive: 'blocked-until-deploy',
    liveDetail: {
      ok: false,
      blocker: 'stale-production-deploy',
      appUrl: 'https://ai-phone-agent-production-6811.up.railway.app/health',
      expectedBranch: targetBranch,
      expectedVersion: targetCommit,
      actualVersion: liveCommit,
      liveStatus: 200,
      liveReadinessHeader: '1',
      detail: {
        ok: false,
        url: 'https://ai-phone-agent-production-6811.up.railway.app/health',
        failure: 'version-mismatch',
        status: 200,
        readinessHeader: '1',
        actualVersion: liveCommit,
      },
    },
  };
  for (const field of REQUIRED_BOOTSTRAP_PREFLIGHT_PASSES) value[field] = 'pass';
  for (const field of REQUIRED_BOOTSTRAP_PREFLIGHT_BLOCKED_UNTIL_DEPLOY) value[field] = 'blocked-until-deploy';
  return value;
}

function evaluate(overrides = {}, preflightOverrides = {}) {
  return evaluateFirstDollarBootstrapDeploy({
    preflight: { ...validPreflight(), ...preflightOverrides },
    targetCommit,
    targetBranch,
    bootstrapMode: 'deploy-fail-closed-checkout',
    deployConfirmation: 'deploy-post-call-fix',
    branchConfirmation: targetBranch,
    commitConfirmation: targetCommit,
    ...overrides,
  });
}

assert.equal(evaluate().ok, true, 'healthy stale production plus exact approvals and all strict contracts must allow the narrow bootstrap path');
assert.equal(evaluate({ bootstrapMode: '' }).ok, false, 'ordinary deploy mode must not bypass incomplete first-dollar env');
assert.equal(evaluate({ bootstrapMode: '1' }).ok, false, 'generic truthy bootstrap mode must fail closed');
assert.equal(evaluate({ deployConfirmation: '' }).ok, false, 'missing production deploy confirmation must fail closed');
assert.equal(evaluate({ branchConfirmation: 'main' }).ok, false, 'wrong branch confirmation must fail closed');
assert.equal(evaluate({ commitConfirmation: liveCommit }).ok, false, 'wrong exact-commit confirmation must fail closed');
assert.equal(evaluate({}, { ok: false }).ok, false, 'failed guarded preflight must fail closed');
assert.equal(evaluate({}, { blocker: 'auth-regression-drift' }).ok, false, 'any blocker other than stale production must fail closed');
assert.equal(evaluate({}, { deployRelevantDirtyFiles: [' M server.ts'] }).ok, false, 'dirty deploy work must fail closed');
assert.equal(evaluate({}, { realRevenueContract: 'fail' }).ok, false, 'fail-closed revenue contract drift must block bootstrap deploy');
assert.equal(evaluate({}, { paidHandoffSafety: 'fail' }).ok, false, 'paid handoff safety drift must block bootstrap deploy');
assert.equal(evaluate({}, { firstDollarGuardCoverage: 'fail' }).ok, false, 'first-dollar guard drift must block bootstrap deploy');
assert.equal(evaluate({}, { stripeWebhookApprovalReady: 'fail' }).ok, false, 'raw Stripe approval failure must not masquerade as the expected stale-live dependency');
assert.equal(evaluate({}, { stripeWebhookApprovalReady: 'pass' }).ok, false, 'a stale live deploy cannot truthfully carry a current-live Stripe approval artifact');
assert.equal(evaluate({}, { operationalAuthLive: 'fail' }).ok, false, 'raw operational-auth failure must not masquerade as the expected stale-live dependency');
assert.equal(evaluate({}, { operationalAuthLive: 'pass' }).ok, false, 'bootstrap evidence must preserve that operational auth remains unproven until the new source is live');
assert.equal(evaluate({}, { proofArtifactsLive: 'pass' }).ok, false, 'bootstrap evidence must preserve the explicit proof-artifact blocked-until-deploy state');
assert.equal(evaluate({}, { postCallIntelligenceLive: 'fail' }).ok, false, 'bootstrap evidence must preserve the explicit post-call blocked-until-deploy state');
assert.equal(evaluate({}, { gitRemoteSync: 'diverged' }).ok, false, 'a diverged target must fail closed');
assert.equal(evaluate({}, {
  liveDetail: {
    ...validPreflight().liveDetail,
    liveStatus: 503,
  },
}).ok, false, 'an unhealthy or unverified live target must not masquerade as stale production');

const launchBlockers = readFileSync(new URL('./check-launch-blockers.sh', import.meta.url), 'utf8');
const stripeAttachStep = launchBlockers.indexOf('echo "[9/30] Stripe attach readiness"');
const broaderOfferFailure = launchBlockers.indexOf('broader_stripe_offer_configured', stripeAttachStep);
const bootstrapSkip = launchBlockers.indexOf('first_dollar_env_bootstrap_allowed', stripeAttachStep);
assert.ok(stripeAttachStep >= 0, 'launch blocker audit must retain the Stripe attach step');
assert.ok(
  broaderOfferFailure > stripeAttachStep && broaderOfferFailure < bootstrapSkip,
  'broader Stripe offers must fail before the fail-closed bootstrap can skip browser attach',
);
assert.match(
  launchBlockers,
  /SKIP Stripe attach readiness for exact-commit fail-closed checkout bootstrap;/,
  'fail-closed checkout bootstrap deploy must not require local Stripe browser attach',
);

console.log('OK first-dollar bootstrap deploy fixtures require exact approval, a clean exact commit, healthy stale production, and every fail-closed contract');
