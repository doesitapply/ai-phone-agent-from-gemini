#!/usr/bin/env node
const expected = 'deploy-post-call-fix';
const actual = String(process.env.CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY || '').trim();

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

console.log(JSON.stringify({
  ok: true,
  confirmation: 'pass',
  requiredEnv: 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY',
  requiredValue: expected,
}, null, 2));
