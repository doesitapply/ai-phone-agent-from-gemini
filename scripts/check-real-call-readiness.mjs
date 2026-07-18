#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const appUrl = String(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');
const fetchTimeoutMs = Number(process.env.SMIRK_REAL_CALL_READINESS_FETCH_TIMEOUT_MS || 15000);
const fetchAttempts = Number(process.env.SMIRK_REAL_CALL_READINESS_FETCH_ATTEMPTS || 2);
const fetchRetryDelayMs = Number(process.env.SMIRK_REAL_CALL_READINESS_FETCH_RETRY_DELAY_MS || 750);

function requireFirstDollarGuardCoverage() {
  try {
    execFileSync('npm', ['run', '-s', 'check:first-dollar-guard-coverage'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (error) {
    const output = [error?.stdout, error?.stderr]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join('\n');
    console.error(JSON.stringify({
      ok: false,
      error: 'first-dollar-guard-coverage-drift',
      detail: output || 'check:first-dollar-guard-coverage failed',
      nextAction: 'Fix first-dollar guard coverage before checking real proof-call readiness.',
    }, null, 2));
    process.exit(1);
  }
}

const firstDollarGuardCoverage = requireFirstDollarGuardCoverage();

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeFetchError(error) {
  return {
    name: error?.name || null,
    message: String(error?.message || error || ''),
    code: error?.cause?.code || error?.code || null,
    cause: error?.cause?.constructor?.name || null,
  };
}

async function fetchJson(pathname, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const res = await fetch(`${appUrl}${pathname}`, {
      ...init,
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { res, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonWithRetry(pathname, init = {}) {
  const attempts = Math.max(1, fetchAttempts);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchJson(pathname, init);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(fetchRetryDelayMs);
      }
    }
  }
  return {
    fetchFailed: true,
    detail: {
      path: pathname,
      appUrl,
      attempts,
      timeoutMs: fetchTimeoutMs,
      retryDelayMs: fetchRetryDelayMs,
      lastError: normalizeFetchError(lastError),
    },
  };
}

const cliTarget = String(process.argv[2] || '').trim();
const targetNumber = cliTarget;
function getDeployRelevantDirtyFiles() {
  try {
    const raw = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
    return raw
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .flatMap((line) => {
        const file = line.replace(/^.{1,2}\s+/, '').replace(/^.* -> /, '');
        const status = line.slice(0, 2).trim();
        if (status === '??' && fs.existsSync(file) && fs.statSync(file).isDirectory()) {
          return execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', file], { encoding: 'utf8' })
            .split(/\r?\n/)
            .filter(Boolean);
        }
        return [file];
      })
      .filter(Boolean);
  } catch {
    return ['<git-status-unavailable>'];
  }
}

const deployRelevantDirtyFiles = getDeployRelevantDirtyFiles();
const localDeployClean = deployRelevantDirtyFiles.length === 0;
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

const [healthFetched, operatorFetched, overviewFetched] = await Promise.all([
  fetchJsonWithRetry('/api/system-health', { headers: { 'x-api-key': apiKey } }),
  fetchJsonWithRetry('/api/operator/session', { headers: { 'x-api-key': apiKey } }),
  fetchJsonWithRetry('/api/workspace-overview', { headers: { 'x-api-key': apiKey } }),
]);

const failedFetch = [
  ['systemHealth', healthFetched],
  ['operatorSession', operatorFetched],
  ['workspaceOverview', overviewFetched],
].find(([, fetched]) => fetched?.fetchFailed);

if (failedFetch) {
  console.error(JSON.stringify({
    ok: false,
    error: 'real-call-readiness-fetch-failed',
    failedCheck: failedFetch[0],
    detail: failedFetch[1].detail,
    nextAction: 'Fix live app reachability or rerun after the transient fetch failure clears; do not place a proof call until readiness passes.',
  }, null, 2));
  process.exit(1);
}

const { res: healthRes, body: health } = healthFetched;
const { res: operatorRes, body: operator } = operatorFetched;
const { res: overviewRes, body: overview } = overviewFetched;
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
const dashboardProof = overviewRes.ok && missingDashboardProofCounters.length === 0 && invalidDashboardProofCounters.length === 0;

const hasTargetNumber = !!targetNumber;
const targetAllowlisted = hasTargetNumber
  ? effectiveAllowlist.length === 0 || effectiveAllowlist.includes(targetNumber)
  : false;
const productionMatchesLocalWork = liveIsCurrent?.ok === true && localDeployClean;
const ok = healthRes.ok && operatorRes.ok && operator?.ok === true && proofLoop === 'pass' && dashboardProof && productionMatchesLocalWork && hasTargetNumber && targetAllowlisted;

function maskPhone(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  const suffix = digits.slice(-4);
  return suffix ? `${s.startsWith('+') ? '+' : ''}***${suffix}` : '***';
}

const allowlistedTargetHints = effectiveAllowlist.map(maskPhone).filter(Boolean);
const missingTargetNextAction = effectiveAllowlist.length > 0
  ? 'Choose a safe number from the configured COMPLIANCE_ALWAYS_ALLOW_NUMBERS allowlist, pass it explicitly as npm run check:real-call-readiness -- <safe-number>, then run npm run proof:real-call -- <safe-number> only after readiness passes.'
  : 'Choose an approved safe proof-call target, pass it explicitly as npm run check:real-call-readiness -- <safe-number>, then run npm run proof:real-call -- <safe-number> only after readiness passes.';

const out = {
  ok,
  appUrl,
  proofLoop,
  liveVersionCurrent: productionMatchesLocalWork,
  firstDollarGuardCoverage: firstDollarGuardCoverage.ok ? 'pass' : 'fail',
  liveVersionFailure: productionMatchesLocalWork
    ? null
    : (!localDeployClean ? 'pending-local-deploy-work' : liveIsCurrent?.failure || 'live-version-mismatch'),
  expectedVersion: liveIsCurrent?.expectedVersion || null,
  actualVersion: liveIsCurrent?.actualVersion || liveIsCurrent?.versionHeader || null,
  localDeployClean,
  deployRelevantDirtyFileCount: deployRelevantDirtyFiles.length,
  deployRelevantDirtyFiles,
  operatorSession: operator?.ok === true ? 'pass' : 'fail',
  dashboardProof: dashboardProof ? 'pass' : 'fail',
  dashboardProofCounters: overview && typeof overview === 'object'
    ? Object.fromEntries(dashboardProofCounters.map((key) => [key, Number(overview[key] || 0)]))
    : null,
  missingDashboardProofCounters,
  invalidDashboardProofCounters,
  proofRunWillRequireDashboardCounterIncrements: dashboardProofCounters,
  maskedTarget: targetNumber ? maskPhone(targetNumber) : null,
  missingTargetNumber: !hasTargetNumber,
  acceptedTargetSource: 'cli-argument-only',
  allowlistConfigured: effectiveAllowlist.length > 0,
  allowlistSource: liveAllowlist.length > 0 ? 'railway' : localAllowlist.length > 0 ? 'local' : 'none',
  allowlistedTargetCount: effectiveAllowlist.length,
  allowlistedTargetHints,
  targetAllowlisted,
  nextAction: productionMatchesLocalWork !== true
    ? 'Deploy the current local proof hardening to production, wait for live version parity with a clean worktree, then rerun this check.'
    : hasTargetNumber
      ? targetAllowlisted
        ? 'Run npm run proof:real-call -- <safe-number> with this same target to place the call and verify summary, owner email, callback task, and dashboard proof.'
        : 'Use a target from the configured allowlist, or update the production allowlist only through the confirmed allowlist mutation path after explicit approval, then rerun this check.'
      : missingTargetNextAction,
};

console.log(JSON.stringify(out, null, 2));
if (!ok) process.exit(1);
