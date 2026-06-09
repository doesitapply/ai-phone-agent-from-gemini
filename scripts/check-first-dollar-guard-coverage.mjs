#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const read = (path) => readFileSync(path, 'utf8');

const checks = [
  {
    label: 'deploy preflight runs no-texting guard',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: "check:no-texting-copy",
  },
  {
    label: 'deploy preflight exposes noTextingCopy result',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'noTextingCopy',
  },
  {
    label: 'deploy preflight runs paid handoff safety guard',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: "check:paid-handoff-safety",
  },
  {
    label: 'deploy preflight exposes paidHandoffSafety result',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'paidHandoffSafety',
  },
  {
    label: 'live deploy readiness runs no-texting guard',
    file: 'scripts/check-live-deploy-readiness.mjs',
    needle: "check:no-texting-copy",
  },
  {
    label: 'live deploy readiness runs paid handoff safety guard',
    file: 'scripts/check-live-deploy-readiness.mjs',
    needle: "check:paid-handoff-safety",
  },
  {
    label: 'launch blockers run no-texting guard',
    file: 'scripts/check-launch-blockers.sh',
    needle: 'check:no-texting-copy',
  },
  {
    label: 'launch blockers run paid handoff safety guard',
    file: 'scripts/check-launch-blockers.sh',
    needle: 'check:paid-handoff-safety',
  },
  {
    label: 'deploy script runs deploy preflight',
    file: 'deploy.sh',
    needle: 'check:deploy-post-call-fix-ready',
  },
  {
    label: 'deploy script runs launch blockers',
    file: 'deploy.sh',
    needle: 'check:launch-blockers',
  },
];

const scriptChecks = [
  {
    label: 'post-deploy live script starts with no-texting guard',
    script: 'check:post-deploy-live',
    needle: 'check:no-texting-copy',
  },
  {
    label: 'post-deploy live script runs paid handoff safety guard',
    script: 'check:post-deploy-live',
    needle: 'check:paid-handoff-safety',
  },
  {
    label: 'post-deploy live script runs buyer auth smoke safety guard',
    script: 'check:post-deploy-live',
    needle: 'check:buyer-auth-smoke-safety',
  },
  {
    label: 'ship-live script runs live deploy readiness',
    script: 'check:ship-live',
    needle: 'check:live-deploy-readiness',
  },
  {
    label: 'ship-live script runs post-deploy live checks',
    script: 'check:ship-live',
    needle: 'check:post-deploy-live',
  },
];

const failures = [];

for (const check of checks) {
  const text = read(check.file);
  if (!text.includes(check.needle)) {
    failures.push(`${check.label}: missing ${check.needle} in ${check.file}`);
  }
}

for (const check of scriptChecks) {
  const value = packageJson.scripts?.[check.script] || '';
  if (!value.includes(check.needle)) {
    failures.push(`${check.label}: missing ${check.needle} in package script ${check.script}`);
  }
}

const out = {
  ok: failures.length === 0,
  checkedFiles: checks.map((check) => check.file),
  checkedPackageScripts: scriptChecks.map((check) => check.script),
  failures,
};

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
