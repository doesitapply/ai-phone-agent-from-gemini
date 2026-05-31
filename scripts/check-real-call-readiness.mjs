#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const appUrl = String(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');

function loadRailwayAuth() {
  try {
    execFileSync('bash', ['-lc', 'source ./scripts/load-railway-auth.sh >/dev/null 2>&1 && env | grep -E "^(RAILWAY_API_TOKEN|RAILWAY_TOKEN)="'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => {
        const eq = line.indexOf('=');
        if (eq === -1) return;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key && value && !process.env[key]) process.env[key] = value;
      });
  } catch {
    // Let Railway access remain optional; live app checks can still run without it.
  }
}

function getLiveRailwayVars() {
  try {
    loadRailwayAuth();
    const raw = execFileSync('railway', ['variable', 'list', '--json'], { encoding: 'utf8' });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readLocalEnvValue(key) {
  const files = [
    '.env.local',
    '.env',
    path.join(process.env.HOME || '', '.openclaw', 'workspace', '.env.operator'),
    path.join(process.env.HOME || '', '.openclaw', 'workspace', '.env.smirk'),
    path.join(process.env.HOME || '', '.openclaw', 'workspace', '.env'),
  ];
  for (const file of files) {
    const p = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith(`${key}=`)) continue;
      return line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return '';
}

function pick(...keys) {
  for (const key of keys) {
    const value = String(process.env[key] || readLocalEnvValue(key) || '').trim();
    if (value) return value;
  }
  return '';
}

const liveRailwayVars = getLiveRailwayVars();

function pickLiveFirst(...keys) {
  for (const key of keys) {
    const value = String(process.env[key] || liveRailwayVars?.[key] || readLocalEnvValue(key) || '').trim();
    if (value) return value;
  }
  return '';
}

const apiKey = pickLiveFirst('DASHBOARD_API_KEY');
if (!apiKey) {
  console.error(JSON.stringify({ ok: false, error: 'missing-dashboard-api-key' }, null, 2));
  process.exit(1);
}

const cliTarget = String(process.argv[2] || '').trim();
const targetNumber = cliTarget || pick('TEST_CALL_TO', 'TWILIO_TEST_TO', 'ALLOWLIST_TEST_NUMBER');
let liveIsCurrent = { ok: true };
try {
  const raw = execFileSync('npm', ['run', '-s', 'check:live-is-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (raw) {
    try {
      liveIsCurrent = JSON.parse(raw);
    } catch {
      liveIsCurrent = { ok: true, raw };
    }
  }
} catch (error) {
  const text = String(error?.stdout || error?.stderr || '').trim();
  try {
    liveIsCurrent = text ? JSON.parse(text) : { ok: false, failure: 'live-version-mismatch' };
  } catch {
    liveIsCurrent = { ok: false, failure: 'live-version-mismatch', raw: text || null };
  }
}
const localAllowlist = pick('COMPLIANCE_ALWAYS_ALLOW_NUMBERS')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const liveAllowlist = String(liveRailwayVars?.COMPLIANCE_ALWAYS_ALLOW_NUMBERS || '').trim()
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const effectiveAllowlist = liveAllowlist.length > 0 ? liveAllowlist : localAllowlist;

const [healthRes, operatorRes, overviewRes] = await Promise.all([
  fetch(`${appUrl}/api/system-health`, { headers: { 'x-api-key': apiKey } }),
  fetch(`${appUrl}/api/operator/session`, { headers: { 'x-api-key': apiKey } }),
  fetch(`${appUrl}/api/workspace-overview`, { headers: { 'x-api-key': apiKey } }),
]);

const health = await healthRes.json();
const operator = await operatorRes.json();
let overview = null;
try {
  overview = await overviewRes.json();
} catch {
  overview = null;
}
const proofLoop = Array.isArray(health?.checks)
  ? health.checks.find((check) => check?.id === 'proof_loop')?.status || null
  : null;
const dashboardProofCounters = [
  'totalCalls',
  'summariesGenerated',
  'callbackTasksCreated',
  'ownerEmailAlertsSent',
  'completeProofCalls',
];
const missingDashboardProofCounters = overview && typeof overview === 'object'
  ? dashboardProofCounters.filter((key) => !(key in overview))
  : dashboardProofCounters;
const invalidDashboardProofCounters = overview && typeof overview === 'object'
  ? dashboardProofCounters.filter((key) => key in overview && (!Number.isFinite(Number(overview[key])) || Number(overview[key]) < 0))
  : dashboardProofCounters;
const completeProofCallsBaseline = overview && typeof overview === 'object' && Number.isFinite(Number(overview.completeProofCalls))
  ? Number(overview.completeProofCalls)
  : null;
const dashboardProof = overviewRes.ok && missingDashboardProofCounters.length === 0 && invalidDashboardProofCounters.length === 0;

const hasTargetNumber = !!targetNumber;
const targetAllowlisted = hasTargetNumber
  ? effectiveAllowlist.length === 0 || effectiveAllowlist.includes(targetNumber)
  : false;
const ok = healthRes.ok && operatorRes.ok && operator?.ok === true && proofLoop === 'pass' && dashboardProof && liveIsCurrent?.ok === true && hasTargetNumber && targetAllowlisted;

const out = {
  ok,
  appUrl,
  proofLoop,
  liveVersionCurrent: liveIsCurrent?.ok === true,
  liveVersionFailure: liveIsCurrent?.ok === true ? null : liveIsCurrent?.failure || 'live-version-mismatch',
  expectedVersion: liveIsCurrent?.expectedVersion || null,
  actualVersion: liveIsCurrent?.actualVersion || liveIsCurrent?.versionHeader || null,
  operatorSession: operator?.ok === true ? 'pass' : 'fail',
  dashboardProof: dashboardProof ? 'pass' : 'fail',
  completeProofCallsBaseline,
  dashboardProofCounters: overview && typeof overview === 'object'
    ? Object.fromEntries(dashboardProofCounters.map((key) => [key, Number(overview[key] || 0)]))
    : null,
  missingDashboardProofCounters,
  invalidDashboardProofCounters,
  proofRunWillRequireCompleteProofIncrement: true,
  targetNumber: targetNumber || null,
  missingTargetNumber: !hasTargetNumber,
  acceptedTargetEnvVars: ['TEST_CALL_TO', 'TWILIO_TEST_TO', 'ALLOWLIST_TEST_NUMBER'],
  allowlistConfigured: effectiveAllowlist.length > 0,
  allowlistSource: liveAllowlist.length > 0 ? 'railway' : localAllowlist.length > 0 ? 'local' : 'none',
  targetAllowlisted,
  nextAction: liveIsCurrent?.ok !== true
    ? 'Deploy local HEAD to production, wait for live version parity, then rerun this check.'
    : hasTargetNumber
      ? targetAllowlisted
        ? 'Run npm run proof:real-call with this target number to place the call and verify summary, owner email, callback task, and dashboard proof.'
        : `Add ${targetNumber} to production COMPLIANCE_ALWAYS_ALLOW_NUMBERS${liveAllowlist.length > 0 ? ' in Railway' : ''}, then rerun this check.`
      : 'Set TEST_CALL_TO (or TWILIO_TEST_TO / ALLOWLIST_TEST_NUMBER) to a safe real phone number, then rerun this check before placing the live test call.',
};

console.log(JSON.stringify(out, null, 2));
if (!ok) process.exit(1);
