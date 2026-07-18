#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  REAL_PROOF_CALL_CONFIRMATION_ENV,
  REAL_PROOF_CALL_CONFIRMATION_VALUE,
  REAL_PROOF_CALL_TARGET_CONFIRMATION_ENV,
  evaluateRealProofCallApproval,
  isExactE164,
  realProofCallApprovalCommand,
} from './lib/real-proof-call-approval.mjs';

const target = String(process.argv[2] || '').trim();

function maskPhone(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  const suffix = digits.slice(-4);
  return suffix ? `${s.startsWith('+') ? '+' : ''}***${suffix}` : '***';
}

function run(command, args, options = {}) {
  const rendered = [command, ...args].map((arg) => (arg === target ? maskPhone(arg) : arg)).join(' ');
  console.log(`\n$ ${rendered}`);
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

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

if (!target) {
  console.error(JSON.stringify({
    ok: false,
    error: 'missing-proof-call-target',
    acceptedTargetSource: 'cli-argument-only',
    usage: realProofCallApprovalCommand(),
    approvalPhrase: 'APPROVE_SMIRK_REAL_PROOF_CALL: <exact-approved-e164>',
    nextAction: 'Run the no-argument readiness check, choose a safe allowlisted target from the masked hints, rerun readiness with the full E.164 target, obtain target-specific approval, then repeat that exact target in both confirmation positions.',
  }, null, 2));
  process.exit(1);
}

if (!isExactE164(target)) {
  console.error(JSON.stringify({
    ok: false,
    error: 'invalid-proof-call-target',
    acceptedTargetSource: 'cli-argument-only',
    message: 'The proof-call target must be one exact E.164 number such as +14155550123.',
    maskedTarget: maskPhone(target),
  }, null, 2));
  process.exit(1);
}

const proofStartedAt = new Date().toISOString();
const env = { ...process.env, PROOF_STARTED_AT: proofStartedAt, SMIRK_PROOF_RUNNER: '1' };
const maskedTarget = maskPhone(target);

console.log(JSON.stringify({
  ok: true,
  phase: 'preflight',
  maskedTarget,
  proofStartedAt,
  message: 'Starting fresh SMIRK proof-call preflight. No outbound call is placed unless live parity, pre-proof live checks, target readiness, and dashboard baseline checks pass.',
}, null, 2));

try {
  printAndRun('npm', ['run', '-s', 'check:live-is-current'], { env });
  printAndRun('npm', ['run', '-s', 'check:pre-proof-call-live'], { env });
  printAndRun('npm', ['run', '-s', 'check:real-call-readiness', '--', target], { env });
  const baselineEnv = { ...env, SMIRK_DASHBOARD_PROOF_ALLOW_STALE: '1' };
  const baselineDashboard = parseJsonOutput(
    printAndRun('npm', ['run', '-s', 'check:dashboard-proof-live'], { env: baselineEnv }),
    'baseline dashboard proof'
  );
  const expectedDashboardCounters = [
    'totalCalls',
    'summariesGenerated',
    'callbackTasksCreated',
    'ownerEmailAlertsSent',
    'completeProofCalls',
  ];
  const baselineCounters = Object.fromEntries(
    expectedDashboardCounters.map((key) => [key, Number(baselineDashboard?.counters?.[key] || 0)])
  );
  const approval = evaluateRealProofCallApproval({
    target,
    machineConfirmation: process.env[REAL_PROOF_CALL_CONFIRMATION_ENV],
    targetConfirmation: process.env[REAL_PROOF_CALL_TARGET_CONFIRMATION_ENV],
  });
  if (!approval.ok) {
    console.error(JSON.stringify({
      ok: false,
      phase: 'approval',
      error: 'real-proof-call-approval-required',
      failures: approval.failures,
      maskedTarget,
      readinessPassed: true,
      message: 'Readiness passed, but readiness alone never authorizes dialing. Obtain one target-specific approval, then supply both exact confirmations.',
      approvalPhrase: 'APPROVE_SMIRK_REAL_PROOF_CALL: <exact-approved-e164>',
      requiredMachineConfirmation: `${REAL_PROOF_CALL_CONFIRMATION_ENV}=${REAL_PROOF_CALL_CONFIRMATION_VALUE}`,
      requiredTargetConfirmation: `${REAL_PROOF_CALL_TARGET_CONFIRMATION_ENV}=<same-exact-approved-e164>`,
      commandTemplate: realProofCallApprovalCommand(),
    }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({
    ok: true,
    phase: 'placing-call',
    maskedTarget,
    proofStartedAt,
    expectedDashboardCounters,
    message: 'Preflight and both exact call confirmations passed; placing one real outbound proof call now.',
  }, null, 2));
  const placedCall = parseJsonOutput(
    printAndRun('node', ['scripts/place-real-test-call.mjs', target], { env }),
    'placed proof call'
  );
  const proofCallSid = String(placedCall?.callSid || '').trim();
  if (!proofCallSid) {
    console.error(JSON.stringify({
      ok: false,
      error: 'missing-proof-call-sid',
      proofStartedAt,
      maskedTarget,
      nextAction: 'The real-call helper did not return a callSid, so the proof run cannot pin artifacts to the call that was placed.',
    }, null, 2));
    process.exit(1);
  }
  env.PROOF_CALL_SID = proofCallSid;

  printAndRun('npm', ['run', '-s', 'check:proof-loop-live'], { env });

  let artifactsOk = false;
  let lastArtifactsOutput = '';
  const maxArtifactAttempts = Math.floor(positiveNumber(process.env.PROOF_ARTIFACT_ATTEMPTS, 16));
  const artifactRetryDelayMs = positiveNumber(process.env.PROOF_ARTIFACT_RETRY_MS, 30_000);
  for (let attempt = 1; attempt <= maxArtifactAttempts; attempt += 1) {
    try {
      lastArtifactsOutput = printAndRun('npm', ['run', '-s', 'check:proof-artifacts-live', '--', proofStartedAt], { env });
      artifactsOk = true;
      break;
    } catch (error) {
      lastArtifactsOutput = String(error?.stdout || error?.stderr || '').trim();
      if (attempt === maxArtifactAttempts) break;
      console.log(`Fresh proof artifacts not complete yet; retrying in ${Math.round(artifactRetryDelayMs / 1000)}s (${attempt}/${maxArtifactAttempts}).`);
      await sleep(artifactRetryDelayMs);
    }
  }

  if (!artifactsOk) {
    console.error(JSON.stringify({
      ok: false,
      error: 'fresh-proof-artifacts-not-found',
      proofStartedAt,
      proofCallSid,
      lastArtifactsOutput,
      nextAction: 'Check the placed call outcome, then rerun artifact and post-call checks with the same PROOF_STARTED_AT and PROOF_CALL_SID.',
    }, null, 2));
    process.exit(1);
  }

  printAndRun('npm', ['run', '-s', 'check:post-call-intelligence-live', '--', proofStartedAt], { env });
  const finalDashboard = parseJsonOutput(
    printAndRun('npm', ['run', '-s', 'check:dashboard-proof-live'], { env }),
    'final dashboard proof'
  );
  const finalCounters = Object.fromEntries(
    expectedDashboardCounters.map((key) => [key, Number(finalDashboard?.counters?.[key] || 0)])
  );
  const missingIncrements = expectedDashboardCounters.filter((key) => finalCounters[key] <= baselineCounters[key]);
  if (missingIncrements.length > 0) {
    console.error(JSON.stringify({
      ok: false,
      error: 'dashboard-proof-counters-not-incremented',
      proofStartedAt,
      proofCallSid,
      baselineCounters,
      finalCounters,
      missingIncrements,
      nextAction: 'Check /api/workspace-overview counters for the placed proof call: total calls, summaries, callback tasks, owner email alerts, and complete proof calls must all increase after the pinned PROOF_CALL_SID run.',
    }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    proofStartedAt,
    maskedTarget,
    proofCallSid,
    baselineCounters,
    finalCounters,
    result: 'Fresh proof call run completed and artifacts pinned to the placed callSid plus all dashboard proof counters were verified.',
  }, null, 2));
} catch (error) {
  process.exit(error?.status || 1);
}
