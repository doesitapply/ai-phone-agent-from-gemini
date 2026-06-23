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
for (const scriptName of [
  'check:ship-live',
  'check:post-deploy-live',
  'check:live-deploy-readiness',
  'check:deploy',
]) {
  const script = String(packageJson.scripts?.[scriptName] || '');
  if (/\b(?:proof:real-call|place-real-test-call|run-real-proof-call)\b/.test(script)) {
    failures.push(`package.json: ${scriptName} must stay non-mutating and must not invoke a real proof call`);
  }
}

const proofRunner = fs.readFileSync('scripts/run-real-proof-call.mjs', 'utf8');
if (!/const target = String\(process\.argv\[2\] \|\| ''\)\.trim\(\);/.test(proofRunner)) {
  failures.push('scripts/run-real-proof-call.mjs: target must come only from the explicit CLI argument');
}
if (!proofRunner.includes("printAndRun('node', ['scripts/place-real-test-call.mjs', target], { env })")) {
  failures.push('scripts/run-real-proof-call.mjs: full proof runner must invoke the isolated helper directly');
}
if (proofRunner.includes("call:real-test")) {
  failures.push('scripts/run-real-proof-call.mjs: must not use a direct call:real-test shortcut');
}
if (proofRunner.includes('This will place a real outbound call')) {
  failures.push('scripts/run-real-proof-call.mjs: preflight output must not claim an outbound call will be placed before readiness passes');
}

const proofRunnerOrder = [
  ['live parity check', "printAndRun('npm', ['run', '-s', 'check:live-is-current'], { env })", 'first'],
  ['post-deploy live check', "printAndRun('npm', ['run', '-s', 'check:post-deploy-live'], { env })", 'first'],
  ['target readiness check', "printAndRun('npm', ['run', '-s', 'check:real-call-readiness', '--', target], { env })", 'first'],
  ['dashboard baseline check', "printAndRun('npm', ['run', '-s', 'check:dashboard-proof-live'], { env })", 'first'],
  ['real outbound proof-call helper', "printAndRun('node', ['scripts/place-real-test-call.mjs', target], { env })", 'first'],
  ['proof call SID assignment', 'env.PROOF_CALL_SID = proofCallSid;', 'first'],
  ['proof artifact check', "printAndRun('npm', ['run', '-s', 'check:proof-artifacts-live', '--', proofStartedAt], { env })", 'first'],
  ['post-call intelligence check', "printAndRun('npm', ['run', '-s', 'check:post-call-intelligence-live', '--', proofStartedAt], { env })", 'first'],
  ['final dashboard proof check', "printAndRun('npm', ['run', '-s', 'check:dashboard-proof-live'], { env })", 'last'],
];
const proofRunnerOrderIndexes = proofRunnerOrder.map(([label, snippet, mode]) => [
  label,
  mode === 'last' ? proofRunner.lastIndexOf(snippet) : proofRunner.indexOf(snippet),
]);
for (const [label, index] of proofRunnerOrderIndexes) {
  if (index === -1) failures.push(`scripts/run-real-proof-call.mjs: missing ordered proof-runner step: ${label}`);
}
for (let i = 1; i < proofRunnerOrderIndexes.length; i += 1) {
  const [previousLabel, previousIndex] = proofRunnerOrderIndexes[i - 1];
  const [label, index] = proofRunnerOrderIndexes[i];
  if (previousIndex !== -1 && index !== -1 && previousIndex > index) {
    failures.push(`scripts/run-real-proof-call.mjs: ${label} must occur after ${previousLabel}`);
  }
}

for (const snippet of [
  "phase: 'preflight'",
  "phase: 'placing-call'",
  'No outbound call is placed unless live parity, post-deploy checks, target readiness, and dashboard baseline checks pass.',
  'expectedDashboardCounters',
  'proofCallSid',
  'PROOF_CALL_SID',
  'missing-proof-call-sid',
  'Check the placed call outcome, then rerun artifact and post-call checks with the same PROOF_STARTED_AT and PROOF_CALL_SID.',
  "'totalCalls'",
  "'summariesGenerated'",
  "'callbackTasksCreated'",
  "'ownerEmailAlertsSent'",
  "'completeProofCalls'",
  'dashboard-proof-counters-not-incremented',
  'after the pinned PROOF_CALL_SID run',
  'artifacts pinned to the placed callSid',
]) {
  if (!proofRunner.includes(snippet)) {
    failures.push(`scripts/run-real-proof-call.mjs: missing truthful proof-call phase snippet: ${snippet}`);
  }
}

const artifactChecker = fs.readFileSync('scripts/check-proof-artifacts-live.mjs', 'utf8');
for (const snippet of [
  'const expectedCallSid = String(process.env.PROOF_CALL_SID || \'\').trim();',
  'const expectedCallSidMatches = (item) => {',
  'callSidOf(item) === expectedCallSid',
  'expectedCallSid: expectedCallSid || null',
  'callSidPinning',
  'const pinnedCallAction = expectedCallSid',
  'Inspect or reprocess the placed PROOF_CALL_SID so that exact call produces a summary, open callback task, and owner email event',
  'for the placed PROOF_CALL_SID',
]) {
  if (!artifactChecker.includes(snippet)) {
    failures.push(`scripts/check-proof-artifacts-live.mjs: missing placed-call SID pinning snippet: ${snippet}`);
  }
}

const postCallChecker = fs.readFileSync('scripts/check-post-call-intelligence-live.mjs', 'utf8');
for (const snippet of [
  'const expectedCallSid = String(process.env.PROOF_CALL_SID || \'\').trim();',
  'const expectedCallSidMatches = (item) => {',
  'callSid === expectedCallSid',
  'const candidateCalls = freshCalls.filter(expectedCallSidMatches);',
  'const candidateTasks = freshTasks.filter(expectedCallSidMatches);',
  "getJson('/api/calls?limit=50')",
  'Inspect or reprocess the placed PROOF_CALL_SID so that exact call has a real summary and an open callback task',
  'Post-call intelligence looks healthy${pinnedCallText}.',
]) {
  if (!postCallChecker.includes(snippet)) {
    failures.push(`scripts/check-post-call-intelligence-live.mjs: missing placed-call SID pinning snippet: ${snippet}`);
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
const workspaceActivationRoutes = fs.readFileSync('src/routes/workspace-activation-routes.ts', 'utf8');
if (!/const targetNumber = cliTarget;/.test(readiness)) {
  failures.push('scripts/check-real-call-readiness.mjs: target must come only from the explicit CLI argument');
}
for (const snippet of [
  'function getDeployRelevantDirtyFiles()',
  "execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', file]",
  'const localDeployClean = deployRelevantDirtyFiles.length === 0;',
  'const productionMatchesLocalWork = liveIsCurrent?.ok === true && localDeployClean;',
  'pending-local-deploy-work',
  'deployRelevantDirtyFileCount',
  'proofRunWillRequireDashboardCounterIncrements',
  'npm run check:real-call-readiness -- <safe-number>, then run npm run proof:real-call -- <safe-number> only after readiness passes.',
  'Run npm run proof:real-call -- <safe-number> with this same target to place the call and verify summary, owner email, callback task, and dashboard proof.',
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
if (!workspaceActivationRoutes.includes('First run npm run check:real-call-readiness -- <safe-number>; only after readiness passes, run npm run proof:real-call -- <safe-number>.')) {
  failures.push('src/routes/workspace-activation-routes.ts: proof-call request command_hint must preserve readiness-before-proof order');
}
if (workspaceActivationRoutes.includes('npm run check:real-call-readiness -- <safe-number> && npm run proof:real-call -- <safe-number>')) {
  failures.push('src/routes/workspace-activation-routes.ts: proof-call request command_hint must not collapse readiness and proof into a chained one-liner');
}

if (failures.length > 0) {
  console.error('FAIL real proof-call target safety drifted away from explicit CLI target selection:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('OK real proof-call target selection is explicit CLI-only, masked, proof-runner-only, and blocked by pending local deploy work');
