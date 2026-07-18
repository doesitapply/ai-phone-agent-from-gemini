#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const proofWorkspaceId = 37;
const proofCallSid = 'CA11111111111111111111111111111111';
const now = new Date().toISOString();
const requests = [];
let reportedWorkspaceId = proofWorkspaceId;

function json(res, body) {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-workspace-id', String(reportedWorkspaceId));
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  requests.push({
    path: req.url,
    workspaceId: String(req.headers['x-workspace-id'] || ''),
  });
  const workspace = { workspaceId: reportedWorkspaceId };
  if (req.url === '/api/workspace-overview') {
    return json(res, {
      ...workspace,
      currentWorkspaceId: reportedWorkspaceId,
      totalCalls: 1,
      summariesGenerated: 1,
      callbackTasksCreated: 1,
      ownerEmailAlertsSent: 1,
      completeProofCalls: 1,
    });
  }
  if (req.url === '/api/public-proof-snapshot') {
    return json(res, {
      ...workspace,
      totalCalls: 1,
      callsThisMonth: 1,
      summariesGenerated: 1,
      callbackTasksCreated: 1,
      ownerEmailAlertsSent: 1,
      completeProofCalls: 1,
      transferredHandoffs: 0,
      summaryCoverage: 100,
      proofFreshness: {
        latestCompleteProofAt: now,
        ageHours: 0,
        fresh: true,
        needsProofCall: false,
      },
    });
  }
  if (req.url === '/api/system-health') {
    return json(res, {
      ...workspace,
      checks: [{ id: 'proof_loop', status: 'pass' }],
    });
  }
  if (req.url?.startsWith('/api/calls?')) {
    return json(res, {
      ...workspace,
      calls: [{
        call_sid: proofCallSid,
        call_summary: 'The owner requested a callback.',
        outcome: 'callback_needed',
        started_at: now,
      }],
    });
  }
  if (req.url?.startsWith('/api/tasks?')) {
    return json(res, {
      ...workspace,
      tasks: [{
        id: 501,
        call_sid: proofCallSid,
        task_type: 'callback',
        title: 'Return the owner proof call',
        status: 'open',
        created_at: now,
      }],
    });
  }
  if (req.url?.startsWith('/api/events?')) {
    return json(res, {
      ...workspace,
      events: [{
        call_sid: proofCallSid,
        event_type: 'OWNER_EMAIL_ALERT_SENT',
        created_at: now,
      }],
    });
  }
  res.statusCode = 404;
  res.end('{}');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.equal(typeof address, 'object');
const appUrl = `http://127.0.0.1:${address.port}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smirk-proof-workspace-'));
const tempScriptsDir = path.join(tempDir, 'scripts');
const tempBinDir = path.join(tempDir, 'bin');
fs.mkdirSync(tempScriptsDir, { recursive: true });
fs.mkdirSync(tempBinDir, { recursive: true });
fs.writeFileSync(path.join(tempScriptsDir, 'check-live-is-current.mjs'), 'process.exit(0);\n');
for (const command of ['npm', 'railway']) {
  const commandPath = path.join(tempBinDir, command);
  fs.writeFileSync(commandPath, command === 'railway' ? '#!/bin/sh\nprintf "{}"\n' : '#!/bin/sh\nexit 0\n');
  fs.chmodSync(commandPath, 0o755);
}

function runScript(script, { args = [], workspaceId = String(proofWorkspaceId), proofRequestId = '901' } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      PATH: `${tempBinDir}${path.delimiter}${process.env.PATH || ''}`,
      APP_URL: appUrl,
      DASHBOARD_API_KEY: 'fixture-dashboard-key',
      SMIRK_PROOF_WORKSPACE_ID: workspaceId,
      SMIRK_RAILWAY_JSON_ATTEMPTS: '1',
      SMIRK_DASHBOARD_PROOF_FETCH_ATTEMPTS: '1',
      SMIRK_PROOF_ARTIFACT_FETCH_ATTEMPTS: '1',
      SMIRK_POST_CALL_INTELLIGENCE_FETCH_ATTEMPTS: '1',
      PROOF_CALL_SID: proofCallSid,
      SMIRK_PROOF_REQUEST_ID: proofRequestId,
    };
    if (workspaceId === undefined) delete childEnv.SMIRK_PROOF_WORKSPACE_ID;
    const child = spawn(process.execPath, [path.join(root, script), ...args], {
      cwd: tempDir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

try {
  for (const script of [
    'scripts/check-dashboard-proof-live.mjs',
    'scripts/check-proof-artifacts-live.mjs',
    'scripts/check-post-call-intelligence-live.mjs',
  ]) {
    const result = await runScript(script);
    assert.equal(result.code, 0, `${script} should pass for non-1 workspace ${proofWorkspaceId}: ${result.stderr || result.stdout}`);
  }
  assert.ok(requests.length >= 8, 'the focused live checks should exercise every proof endpoint');
  assert.equal(
    requests.every((request) => request.workspaceId === String(proofWorkspaceId)),
    true,
    `every proof fetch must carry x-workspace-id=${proofWorkspaceId}: ${JSON.stringify(requests)}`,
  );

  reportedWorkspaceId = 1;
  requests.length = 0;
  const mismatch = await runScript('scripts/check-post-call-intelligence-live.mjs');
  assert.notEqual(mismatch.code, 0, 'a response that reports workspace 1 must fail a workspace 37 proof check');
  assert.match(`${mismatch.stdout}\n${mismatch.stderr}`, /expectedWorkspaceId[^\n]*37/);

  for (const script of [
    'scripts/check-dashboard-proof-live.mjs',
    'scripts/check-proof-artifacts-live.mjs',
    'scripts/check-post-call-intelligence-live.mjs',
  ]) {
    const invalid = await runScript(script, { workspaceId: '1e2' });
    assert.notEqual(invalid.code, 0, `${script} must reject a non-decimal workspace ID`);
    assert.match(`${invalid.stdout}\n${invalid.stderr}`, /invalid-proof-workspace-id/);
  }
  const invalidRunner = await runScript('scripts/run-real-proof-call.mjs', {
    args: ['+14155550123'],
    workspaceId: '1e2',
  });
  assert.notEqual(invalidRunner.code, 0, 'the proof runner must reject a non-decimal workspace ID before preflight');
  assert.match(`${invalidRunner.stdout}\n${invalidRunner.stderr}`, /missing-customer-proof-request-context/);
  const invalidRequestRunner = await runScript('scripts/run-real-proof-call.mjs', {
    args: ['+14155550123'],
    proofRequestId: '9e2',
  });
  assert.notEqual(invalidRequestRunner.code, 0, 'the proof runner must reject a non-decimal proof request ID before preflight');
  assert.match(`${invalidRequestRunner.stdout}\n${invalidRequestRunner.stderr}`, /missing-customer-proof-request-context/);

  console.log(`OK live proof checks carry and verify exact non-1 workspace ${proofWorkspaceId}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}
