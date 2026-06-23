#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const appUrl = String(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');
const fetchTimeoutMs = Number(process.env.SMIRK_DASHBOARD_PROOF_FETCH_TIMEOUT_MS || 15000);
const fetchAttempts = Number(process.env.SMIRK_DASHBOARD_PROOF_FETCH_ATTEMPTS || 2);
const fetchRetryDelayMs = Number(process.env.SMIRK_DASHBOARD_PROOF_FETCH_RETRY_DELAY_MS || 750);

function liveIsCurrent() {
  try {
    execFileSync('node', ['scripts/check-live-is-current.mjs'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: String(error?.stdout || error?.stderr || error?.message || '').trim(),
    };
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

function readRailwayEnvValue(key) {
  try {
    const raw = execFileSync(
      'bash',
      ['-lc', 'source ./scripts/load-railway-auth.sh >/dev/null 2>&1 || true; railway variable list --json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const vars = JSON.parse(raw);
    return String(vars[key] || '').trim();
  } catch {
    return '';
  }
}

const apiKeyCandidates = [
  String(process.env.DASHBOARD_API_KEY || '').trim(),
  readLocalEnvValue('DASHBOARD_API_KEY'),
  readRailwayEnvValue('DASHBOARD_API_KEY'),
].filter(Boolean);

if (apiKeyCandidates.length === 0) {
  console.error(JSON.stringify({
    ok: false,
    error: 'missing-dashboard-api-key',
    message: 'Set DASHBOARD_API_KEY in env, .env.local, or ~/.openclaw/workspace/.env.operator to verify live dashboard proof counters.',
  }, null, 2));
  process.exit(1);
}

const current = liveIsCurrent();
if (!current.ok) {
  console.error(JSON.stringify({
    ok: false,
    error: 'stale-production-deploy',
    message: 'Refusing to verify dashboard proof counters against stale production. Deploy local HEAD first.',
    detail: current.detail,
  }, null, 2));
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

async function fetchText(pathname, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const res = await fetch(`${appUrl}${pathname}`, {
      ...init,
      signal: controller.signal,
    });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithRetry(pathname, init = {}) {
  const attempts = Math.max(1, fetchAttempts);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchText(pathname, init);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(fetchRetryDelayMs);
      }
    }
  }
  const normalized = normalizeFetchError(lastError);
  const err = new Error(`fetch failed for ${pathname}: ${normalized.message}`);
  err.detail = {
    pathname,
    appUrl,
    attempts,
    timeoutMs: fetchTimeoutMs,
    retryDelayMs: fetchRetryDelayMs,
    lastError: normalized,
  };
  throw err;
}

let res;
let text = '';
try {
  for (const apiKey of apiKeyCandidates) {
    ({ res, text } = await fetchTextWithRetry('/api/workspace-overview', {
      headers: { 'x-api-key': apiKey },
    }));
    if (res.status !== 401) break;
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: 'dashboard-proof-fetch-failed',
    message: 'Could not fetch live dashboard proof counters after bounded retries.',
    detail: error?.detail || normalizeFetchError(error),
  }, null, 2));
  process.exit(1);
}

let parsed = null;
try {
  parsed = JSON.parse(text);
} catch {
  console.error(JSON.stringify({ ok: false, status: res.status, error: 'invalid-json', sample: text.slice(0, 200) }, null, 2));
  process.exit(1);
}

const counters = [
  'totalCalls',
  'summariesGenerated',
  'callbackTasksCreated',
  'ownerEmailAlertsSent',
  'completeProofCalls',
];
const missing = counters.filter((key) => !(key in parsed));
const nonNumeric = counters.filter((key) => key in parsed && !Number.isFinite(Number(parsed[key])));
const negative = counters.filter((key) => Number(parsed[key]) < 0);
const impossibleCompleteProofCount =
  Number(parsed.completeProofCalls) > Math.min(
    Number(parsed.summariesGenerated),
    Number(parsed.ownerEmailAlertsSent)
  );

let publicRes;
let publicText = '';
try {
  ({ res: publicRes, text: publicText } = await fetchTextWithRetry('/api/public-proof-snapshot'));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: 'dashboard-proof-fetch-failed',
    message: 'Could not fetch live public proof snapshot after bounded retries.',
    detail: error?.detail || normalizeFetchError(error),
  }, null, 2));
  process.exit(1);
}
let publicSnapshot = null;
try {
  publicSnapshot = JSON.parse(publicText);
} catch {
  console.error(JSON.stringify({ ok: false, status: publicRes.status, error: 'invalid-public-proof-json', sample: publicText.slice(0, 200) }, null, 2));
  process.exit(1);
}

const publicCounters = [
  'totalCalls',
  'callsThisMonth',
  'summariesGenerated',
  'callbackTasksCreated',
  'ownerEmailAlertsSent',
  'completeProofCalls',
  'transferredHandoffs',
  'summaryCoverage',
];
const publicMissing = publicCounters.filter((key) => !(key in publicSnapshot));
const publicNonNumeric = publicCounters.filter((key) => key in publicSnapshot && !Number.isFinite(Number(publicSnapshot[key])));
const publicNegative = publicCounters.filter((key) => Number(publicSnapshot[key]) < 0);
const publicImpossibleCompleteProofCount =
  Number(publicSnapshot.completeProofCalls) > Math.min(
    Number(publicSnapshot.summariesGenerated),
    Number(publicSnapshot.ownerEmailAlertsSent)
  );
const publicForbidden = [
  'owner_email',
  'from_number',
  'to_number',
  'phone_number',
  'transcript',
  'recording_url',
  'call_summary',
  'task_notes',
  'messages',
  'workspace_api_key',
  'api_key',
  'invite_link',
];
const publicJoined = JSON.stringify(publicSnapshot).toLowerCase();
const publicLeakedFields = publicForbidden.filter((key) => publicJoined.includes(key));
const publicCacheControl = String(publicRes.headers.get('cache-control') || '').toLowerCase();
const publicCacheProtected = publicCacheControl.includes('no-store');
const publicProofFreshness = publicSnapshot?.proofFreshness || {};
const publicFreshnessValid =
  publicSnapshot.completeProofCalls > 0
    ? publicProofFreshness &&
      typeof publicProofFreshness === 'object' &&
      typeof publicProofFreshness.latestCompleteProofAt === 'string' &&
      Number.isFinite(Number(publicProofFreshness.ageHours)) &&
      typeof publicProofFreshness.fresh === 'boolean' &&
      publicProofFreshness.needsProofCall === false
    : publicProofFreshness?.needsProofCall === true;
const publicProofFresh =
  Number(publicSnapshot.completeProofCalls || 0) === 0 ||
  publicProofFreshness.fresh === true;

const out = {
  ok: res.ok &&
    publicRes.ok &&
    missing.length === 0 &&
    nonNumeric.length === 0 &&
    negative.length === 0 &&
    !impossibleCompleteProofCount &&
    publicMissing.length === 0 &&
    publicNonNumeric.length === 0 &&
    publicNegative.length === 0 &&
    !publicImpossibleCompleteProofCount &&
    publicLeakedFields.length === 0 &&
    publicCacheProtected &&
    publicFreshnessValid &&
    publicProofFresh,
  status: res.status,
  url: `${appUrl}/api/workspace-overview`,
  counters: Object.fromEntries(counters.map((key) => [key, Number(parsed[key] || 0)])),
  missing,
  nonNumeric,
  negative,
  impossibleCompleteProofCount,
  publicProof: {
    status: publicRes.status,
    url: `${appUrl}/api/public-proof-snapshot`,
    counters: Object.fromEntries(publicCounters.map((key) => [key, Number(publicSnapshot[key] || 0)])),
    missing: publicMissing,
    nonNumeric: publicNonNumeric,
    negative: publicNegative,
    impossibleCompleteProofCount: publicImpossibleCompleteProofCount,
    leakedFields: publicLeakedFields,
    cacheControl: publicCacheControl,
    cacheProtected: publicCacheProtected,
    proofFreshness: publicProofFreshness,
    freshnessValid: publicFreshnessValid,
    proofFresh: publicProofFresh,
  },
};

console.log(JSON.stringify(out, null, 2));

if (!out.ok) {
  process.exit(1);
}
