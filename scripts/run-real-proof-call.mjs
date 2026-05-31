#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const target = String(process.argv[2] || process.env.TEST_CALL_TO || process.env.TWILIO_TEST_TO || process.env.ALLOWLIST_TEST_NUMBER || '').trim();

function run(command, args, options = {}) {
  console.log(`\n$ ${[command, ...args].join(' ')}`);
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function printAndRun(command, args, options = {}) {
  try {
    const output = run(command, args, options);
    if (output.trim()) console.log(output.trim());
    return output;
  } catch (error) {
    const stdout = String(error?.stdout || '').trim();
    const stderr = String(error?.stderr || '').trim();
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    throw error;
  }
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(String(output || '').trim());
  } catch {
    throw new Error(`Could not parse ${label} JSON output`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (!target) {
  console.error(JSON.stringify({
    ok: false,
    error: 'missing-proof-call-target',
    acceptedTargetEnvVars: ['TEST_CALL_TO', 'TWILIO_TEST_TO', 'ALLOWLIST_TEST_NUMBER'],
    usage: 'npm run -s proof:real-call -- +15551234567',
    nextAction: 'Provide a safe phone number you control or have explicit permission to call.',
  }, null, 2));
  process.exit(1);
}

const proofStartedAt = new Date().toISOString();
const env = { ...process.env, PROOF_STARTED_AT: proofStartedAt };

console.log(JSON.stringify({
  ok: true,
  target,
  proofStartedAt,
  message: 'Starting fresh SMIRK proof-call run. This will place a real outbound call.',
}, null, 2));

try {
  printAndRun('npm', ['run', '-s', 'check:live-is-current'], { env });
  printAndRun('npm', ['run', '-s', 'check:real-call-readiness', '--', target], { env });
  const baselineDashboard = parseJsonOutput(
    printAndRun('npm', ['run', '-s', 'check:dashboard-proof-live'], { env }),
    'baseline dashboard proof'
  );
  const baselineCompleteProofCalls = Number(baselineDashboard?.counters?.completeProofCalls || 0);
  printAndRun('npm', ['run', '-s', 'call:real-test', '--', target], { env });

  printAndRun('npm', ['run', '-s', 'check:proof-loop-live'], { env });

  let artifactsOk = false;
  let lastArtifactsOutput = '';
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      lastArtifactsOutput = printAndRun('npm', ['run', '-s', 'check:proof-artifacts-live', '--', proofStartedAt], { env });
      artifactsOk = true;
      break;
    } catch (error) {
      lastArtifactsOutput = String(error?.stdout || error?.stderr || '').trim();
      if (attempt === 10) break;
      console.log(`Fresh proof artifacts not complete yet; retrying in 30s (${attempt}/10).`);
      await sleep(30_000);
    }
  }

  if (!artifactsOk) {
    console.error(JSON.stringify({
      ok: false,
      error: 'fresh-proof-artifacts-not-found',
      proofStartedAt,
      lastArtifactsOutput,
      nextAction: 'Check the call outcome, then rerun the artifact checks with the same PROOF_STARTED_AT.',
    }, null, 2));
    process.exit(1);
  }

  printAndRun('npm', ['run', '-s', 'check:post-call-intelligence-live', '--', proofStartedAt], { env });
  const finalDashboard = parseJsonOutput(
    printAndRun('npm', ['run', '-s', 'check:dashboard-proof-live'], { env }),
    'final dashboard proof'
  );
  const finalCompleteProofCalls = Number(finalDashboard?.counters?.completeProofCalls || 0);
  if (finalCompleteProofCalls <= baselineCompleteProofCalls) {
    console.error(JSON.stringify({
      ok: false,
      error: 'dashboard-proof-counter-not-incremented',
      proofStartedAt,
      baselineCompleteProofCalls,
      finalCompleteProofCalls,
      nextAction: 'Check /api/workspace-overview completeProofCalls correlation for the fresh proof call.',
    }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    proofStartedAt,
    target,
    baselineCompleteProofCalls,
    finalCompleteProofCalls,
    result: 'Fresh proof call run completed and artifacts plus dashboard proof counter were verified.',
  }, null, 2));
} catch (error) {
  process.exit(error?.status || 1);
}
