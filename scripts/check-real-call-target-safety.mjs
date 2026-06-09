#!/usr/bin/env node
import fs from 'node:fs';

const files = [
  'scripts/run-real-proof-call.mjs',
  'scripts/place-real-test-call.mjs',
  'scripts/check-real-call-readiness.mjs',
];

const failures = [];

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  if (/\bacceptedTargetEnvVars\b/.test(text)) {
    failures.push(`${file}: exposes env vars as accepted proof-call target sources`);
  }
  if (/\b(?:TEST_CALL_TO|TWILIO_TEST_TO|ALLOWLIST_TEST_NUMBER)\b/.test(text)) {
    failures.push(`${file}: references env-derived proof-call target variables`);
  }
  if (!text.includes("acceptedTargetSource: 'cli-argument-only'")) {
    failures.push(`${file}: missing cli-argument-only target-source marker`);
  }
  if (!text.includes('maskPhone(')) {
    failures.push(`${file}: proof-call target output must be masked`);
  }
  if (/(?:targetNumber|target|to):\s*(?:targetNumber|target|to)\b/.test(text)) {
    failures.push(`${file}: proof-call output must not print the raw target number`);
  }
}

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (packageJson.scripts?.['call:real-test']) {
  failures.push('package.json: must not expose a direct call:real-test script; use proof:real-call only');
}

const proofRunner = fs.readFileSync('scripts/run-real-proof-call.mjs', 'utf8');
if (!/const target = String\(process\.argv\[2\] \|\| ''\)\.trim\(\);/.test(proofRunner)) {
  failures.push('scripts/run-real-proof-call.mjs: target must come only from the explicit CLI argument');
}
if (!proofRunner.includes("printAndRun('node', ['scripts/place-real-test-call.mjs', target], { env });")) {
  failures.push('scripts/run-real-proof-call.mjs: full proof runner must invoke the isolated helper directly');
}
if (proofRunner.includes("call:real-test")) {
  failures.push('scripts/run-real-proof-call.mjs: must not use a direct call:real-test shortcut');
}
if (proofRunner.includes('This will place a real outbound call')) {
  failures.push('scripts/run-real-proof-call.mjs: preflight output must not claim an outbound call will be placed before readiness passes');
}
for (const snippet of [
  "phase: 'preflight'",
  "phase: 'placing-call'",
  'No outbound call is placed unless live parity, target readiness, and dashboard baseline checks pass.',
  'expectedDashboardCounters',
  "'totalCalls'",
  "'summariesGenerated'",
  "'callbackTasksCreated'",
  "'ownerEmailAlertsSent'",
  "'completeProofCalls'",
  'dashboard-proof-counters-not-incremented',
]) {
  if (!proofRunner.includes(snippet)) {
    failures.push(`scripts/run-real-proof-call.mjs: missing truthful proof-call phase snippet: ${snippet}`);
  }
}

const isolatedHelper = fs.readFileSync('scripts/place-real-test-call.mjs', 'utf8');
if (!/const to = cliTarget;/.test(isolatedHelper)) {
  failures.push('scripts/place-real-test-call.mjs: target must come only from the explicit CLI argument');
}
if (!isolatedHelper.includes("process.env.SMIRK_PROOF_RUNNER !== '1'")) {
  failures.push('scripts/place-real-test-call.mjs: isolated real-call helper must require the full proof runner');
}
if (!proofRunner.includes("SMIRK_PROOF_RUNNER: '1'")) {
  failures.push('scripts/run-real-proof-call.mjs: full proof runner must mark internal call-helper invocation');
}

const readiness = fs.readFileSync('scripts/check-real-call-readiness.mjs', 'utf8');
if (!/const targetNumber = cliTarget;/.test(readiness)) {
  failures.push('scripts/check-real-call-readiness.mjs: target must come only from the explicit CLI argument');
}
for (const snippet of [
  'function getDeployRelevantDirtyFiles()',
  'const localDeployClean = deployRelevantDirtyFiles.length === 0;',
  'const productionMatchesLocalWork = liveIsCurrent?.ok === true && localDeployClean;',
  'pending-local-deploy-work',
  'deployRelevantDirtyFileCount',
  'proofRunWillRequireDashboardCounterIncrements',
]) {
  if (!readiness.includes(snippet)) {
    failures.push(`scripts/check-real-call-readiness.mjs: missing dirty local deploy proof gate snippet: ${snippet}`);
  }
}
for (const obsoleteSnippet of [
  'completeProofCallsBaseline',
  'proofRunWillRequireCompleteProofIncrement',
]) {
  if (readiness.includes(obsoleteSnippet)) {
    failures.push(`scripts/check-real-call-readiness.mjs: obsolete single-counter proof flag returned: ${obsoleteSnippet}`);
  }
}

if (failures.length > 0) {
  console.error('FAIL real proof-call target safety drifted away from explicit CLI target selection:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('OK real proof-call target selection is explicit CLI-only, masked, proof-runner-only, and blocked by pending local deploy work');
