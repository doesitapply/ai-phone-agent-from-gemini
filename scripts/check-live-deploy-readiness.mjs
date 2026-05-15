#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

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
  run('railway healthcheck config', 'npm run -s check:railway:healthcheck'),
  run('live buyer routes', 'node scripts/check-live-buyer-routes.mjs'),
  run('latest failed deploy', 'npm run -s check:latest-failed-deploy'),
];

for (const check of checks) {
  console.log(`=== ${check.label} ===`);
  console.log(check.output || '(no output)');
  console.log('');
}

const staleLive = checks.find((c) => c.label === 'live buyer routes' && !c.ok);
const failedDeploy = checks.find((c) => c.label === 'latest failed deploy');

if (staleLive) {
  console.error('FAIL live app is still stale or undeployed; fix Railway deploy health/startup and redeploy current repo.');
  if (failedDeploy?.output && /Healthcheck failed!/i.test(failedDeploy.output)) {
    console.error('Likely cause from latest failed deploy: Railway healthcheck/startup failure.');
  }
  process.exit(1);
}

console.log('OK live deploy readiness checks passed');
