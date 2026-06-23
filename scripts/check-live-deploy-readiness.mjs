#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() || 'main';
const deployCommand = branch !== 'main'
  ? `CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix CONFIRM_SMIRK_DEPLOY_BRANCH=${branch} npm run deploy:post-call-fix`
  : 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix npm run deploy:post-call-fix';

function run(label, command) {
  try {
    const output = execFileSync('bash', ['-lc', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { label, ok: true, output: output.trim() };
  } catch (error) {
    return {
      label,
      ok: false,
      output: `${String(error.stdout || '').trim()}${error.stderr ? `\n${String(error.stderr).trim()}` : ''}`.trim(),
    };
  }
}

const checks = [
  run('real proof-call docs', 'npm run -s check:real-call-docs'),
  run('real proof-call target safety', 'npm run -s check:real-call-target-safety'),
  run('test-call allowlist safety', 'npm run -s check:test-call-allowlist-safety'),
  run('no-texting copy guard', 'npm run -s check:no-texting-copy'),
  run('OpenAPI route inventory', 'npm run -s check:openapi'),
  run('auth regression', 'npm run -s check:auth'),
  run('paid handoff live-write safety', 'npm run -s check:paid-handoff-safety'),
  run('self-serve activation contract', 'npm run -s check:self-serve-activation'),
  run('client onboarding intake contract', 'npm run -s check:client-onboarding-intake'),
  run('Stripe webhook handoff preflight', 'npm run -s check:stripe-webhook-handoff-live:preflight'),
  run('Stripe webhook smoke approval readiness', 'npm run -s check:stripe-webhook-smoke-approval-ready'),
  run('deploy approval handoff safety', 'npm run -s check:deploy-approval-handoff'),
  run('payment page source guard', 'npm run -s check:pricing'),
  run('railway access', 'npm run -s check:railway'),
  run('railway first-dollar env', 'npm run -s check:railway:first-dollar-env'),
  run('railway healthcheck config', 'npm run -s check:railway:healthcheck'),
  run('live critical first-dollar health', 'npm run -s check:live:health'),
  run('live buyer routes', 'node scripts/check-live-buyer-routes.mjs'),
  run('live operational auth', 'npm run -s check:operational-auth-live'),
  run('branded domain cutover', 'npm run -s check:domain-cutover:authoritative'),
  run('latest failed deploy', 'npm run -s check:latest-failed-deploy'),
];

for (const check of checks) {
  console.log(`=== ${check.label} ===`);
  console.log(check.output || '(no output)');
  console.log('');
}

const accessCheck = checks.find((c) => c.label === 'railway access');
const envCheck = checks.find((c) => c.label === 'railway first-dollar env');
const staleLive = checks.find((c) => c.label === 'live buyer routes' && !c.ok);
const domainCutover = checks.find((c) => c.label === 'branded domain cutover');
const failedDeploy = checks.find((c) => c.label === 'latest failed deploy');

if (accessCheck && !accessCheck.ok) {
  console.error('FAIL Railway access is not working; restore CLI/dashboard auth before trusting env or deploy diagnostics.');
  console.error('Need the exact steps?');
  console.error('  npm run -s print:railway-auth-setup');
  console.error('Fast path:');
  console.error("  printf '%s' '<valid-token>' | npm run -s bootstrap:railway-auth");
  console.error('  # bootstrap:railway-auth will save the token and immediately run npm run check:ship-live');
  process.exit(1);
}

if (envCheck && !envCheck.ok) {
  console.error('FAIL live first-dollar env is incomplete; fill the missing Railway variables before trusting any deploy result.');
  console.error('Fast path:');
  console.error('  npm run -s check:railway:first-dollar-env');
  console.error('  # then fill the reported Railway variables and run: npm run -s set:first-dollar-live-env');
  console.error('  # if sender domain is blocking FROM_EMAIL, run first: npm run -s cutover:sender-domain -- --dry-run');
  console.error('  npm run -s check:ship-live');
  process.exit(1);
}

if (staleLive) {
  console.error('FAIL live app is still stale or undeployed; fix Railway deploy health/startup and redeploy current repo.');
  console.error('Fast path:');
  console.error('  npm run -s check:railway:healthcheck');
  console.error('  npm run -s check:latest-failed-deploy');
  console.error(`  ${deployCommand}`);
  console.error('  npm run -s check:ship-live');
  if (failedDeploy?.output && /Healthcheck failed!/i.test(failedDeploy.output)) {
    console.error('Likely cause from latest failed deploy: Railway healthcheck/startup failure.');
  }
  process.exit(1);
}

if (domainCutover && !domainCutover.ok) {
  console.error('FAIL branded domain is not cut over to Railway; do not treat the direct Railway URL as public launch readiness.');
  console.error('Fast path:');
  console.error('  npm run -s check:domain-cutover:authoritative');
  console.error('  npm run -s write:domain-cutover-runbook');
  console.error('  # then update Namecheap Advanced DNS with the reported CNAME/TXT records');
  console.error('  npm run -s check:ship-live');
  process.exit(1);
}

const failedChecks = checks.filter((c) => !c.ok);
if (failedChecks.length > 0) {
  console.error(`FAIL ${failedChecks.length} deploy readiness check(s) failed: ${failedChecks.map((c) => c.label).join(', ')}`);
  console.error('Fix the failed check output above, then rerun: npm run -s check:live-deploy-readiness');
  process.exit(1);
}

console.log('OK live deploy readiness checks passed');
console.log('Next: npm run -s check:post-deploy-live');
