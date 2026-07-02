#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { readRailwayEnvValue } from './railway-json.mjs';

const appUrl = (process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');
const fetchTimeoutMs = Number(process.env.SMIRK_OPERATOR_SESSION_FETCH_TIMEOUT_MS || 15000);
const fetchAttempts = Number(process.env.SMIRK_OPERATOR_SESSION_FETCH_ATTEMPTS || 2);
const fetchRetryDelayMs = Number(process.env.SMIRK_OPERATOR_SESSION_FETCH_RETRY_DELAY_MS || 750);

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

async function fetchOperatorSession(apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const res = await fetch(`${appUrl}/api/operator/session`, {
      headers: { 'x-api-key': apiKey },
      signal: controller.signal,
    });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOperatorSessionWithRetry(apiKey, source) {
  const attempts = Math.max(1, fetchAttempts);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchOperatorSession(apiKey);
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
      source,
      appUrl,
      path: '/api/operator/session',
      attempts,
      timeoutMs: fetchTimeoutMs,
      retryDelayMs: fetchRetryDelayMs,
      lastError: normalizeFetchError(lastError),
    },
  };
}

function readLocalEnvValue(key) {
  for (const file of ['.env.local', '.env']) {
    const p = path.resolve(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith(`${key}=`)) continue;
      return line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return '';
}

const candidates = [
  ['process env', String(process.env.DASHBOARD_API_KEY || '').trim()],
  ['local env file', readLocalEnvValue('DASHBOARD_API_KEY')],
  ['railway variables', readRailwayEnvValue('DASHBOARD_API_KEY', { quiet: true })],
].filter(([, value]) => String(value || '').trim().length > 0);

if (candidates.length === 0) {
  console.error(JSON.stringify({ ok: false, error: 'missing-dashboard-api-key', message: 'Set DASHBOARD_API_KEY in env, .env.local, or live Railway variables to verify live operator auth.' }, null, 2));
  process.exit(1);
}

let lastFailure = null;

for (const [source, apiKey] of candidates) {
  const fetched = await fetchOperatorSessionWithRetry(apiKey, source);
  if (fetched.fetchFailed) {
    lastFailure = {
      ok: false,
      error: 'operator-session-fetch-failed',
      message: 'Could not verify live operator session after bounded retries.',
      detail: fetched.detail,
    };
    continue;
  }
  const { res, text } = fetched;
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    lastFailure = { source, status: res.status, error: 'invalid-json', sample: text.slice(0, 200) };
    continue;
  }

  const ok = res.ok && parsed?.ok === true && parsed?.role === 'operator';
  const out = {
    ok,
    source,
    status: res.status,
    role: parsed?.role || null,
    capabilities: parsed?.capabilities || null,
    url: `${appUrl}/api/operator/session`,
  };

  if (ok) {
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  lastFailure = { ...out, error: 'operator-session-check-failed' };
}

console.error(JSON.stringify(lastFailure || { ok: false, error: 'operator-session-check-failed' }, null, 2));
process.exit(1);
