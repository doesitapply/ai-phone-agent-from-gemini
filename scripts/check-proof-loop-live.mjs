#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const appUrl = String(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');
const fetchTimeoutMs = Number(process.env.SMIRK_PROOF_LOOP_FETCH_TIMEOUT_MS || 15000);
const fetchAttempts = Number(process.env.SMIRK_PROOF_LOOP_FETCH_ATTEMPTS || 2);
const fetchRetryDelayMs = Number(process.env.SMIRK_PROOF_LOOP_FETCH_RETRY_DELAY_MS || 750);

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
  console.error(JSON.stringify({ ok: false, error: 'missing-dashboard-api-key', message: 'Set DASHBOARD_API_KEY in env, .env.local, or ~/.openclaw/workspace/.env.operator to verify live proof-loop readiness.' }, null, 2));
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

async function fetchText(apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const res = await fetch(`${appUrl}/api/system-health`, {
      headers: { 'x-api-key': apiKey },
      signal: controller.signal,
    });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithRetry(apiKey) {
  const attempts = Math.max(1, fetchAttempts);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchText(apiKey);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(fetchRetryDelayMs);
      }
    }
  }
  const normalized = normalizeFetchError(lastError);
  const err = new Error(`fetch failed for /api/system-health: ${normalized.message}`);
  err.detail = {
    pathname: '/api/system-health',
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
    ({ res, text } = await fetchTextWithRetry(apiKey));
    if (res.status !== 401) break;
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: 'proof-loop-fetch-failed',
    message: 'Could not fetch live proof-loop readiness after bounded retries.',
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

const checks = Array.isArray(parsed?.checks) ? parsed.checks : [];
const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
const required = ['payment_path', 'owner_alerts', 'callbacks', 'proof_loop', 'auth'];
const missing = required.filter((id) => !byId[id]);
if (missing.length) {
  console.error(JSON.stringify({ ok: false, status: res.status, error: 'missing-checks', missing }, null, 2));
  process.exit(1);
}

const failed = required.filter((id) => byId[id]?.status === 'fail');
const cacheControl = String(res.headers.get('cache-control') || '').toLowerCase();
const cacheProtected = cacheControl.includes('no-store');
const out = {
  ok: res.ok && cacheProtected && failed.length === 0,
  status: res.status,
  url: `${appUrl}/api/system-health`,
  proofLoop: byId.proof_loop?.status || null,
  paymentPath: byId.payment_path?.status || null,
  ownerAlerts: byId.owner_alerts?.status || null,
  callbacks: byId.callbacks?.status || null,
  auth: byId.auth?.status || null,
  calls: byId.calls?.detail || null,
  intelligence: byId.intelligence?.detail || null,
  contacts: byId.contacts?.detail || null,
  cacheControl,
  cacheProtected,
  summary: parsed?.summary || null,
};

console.log(JSON.stringify(out, null, 2));

if (!out.ok) {
  process.exit(1);
}
