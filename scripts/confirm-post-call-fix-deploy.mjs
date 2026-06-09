#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const expected = 'deploy-post-call-fix';
const actual = String(process.env.CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY || '').trim();
const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() || 'main';
const branchConfirmation = String(process.env.CONFIRM_SMIRK_DEPLOY_BRANCH || '').trim();

if (actual !== expected) {
  console.error(JSON.stringify({
    ok: false,
    error: 'missing-deploy-confirmation',
    requiredEnv: 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY',
    requiredValue: expected,
    nextAction: `Run only after explicit approval: CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=${expected} npm run deploy:post-call-fix`,
  }, null, 2));
  process.exit(1);
}

if (branch !== 'main' && branchConfirmation !== branch) {
  console.error(JSON.stringify({
    ok: false,
    error: 'missing-branch-deploy-confirmation',
    branch,
    requiredEnv: 'CONFIRM_SMIRK_DEPLOY_BRANCH',
    requiredValue: branch,
    nextAction: `Run only after explicit approval for this branch: CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=${expected} CONFIRM_SMIRK_DEPLOY_BRANCH=${branch} npm run deploy:post-call-fix`,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  confirmation: 'pass',
  requiredEnv: 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY',
  requiredValue: expected,
  branch,
  branchConfirmation: branch === 'main' ? 'not-required' : 'pass',
}, null, 2));
