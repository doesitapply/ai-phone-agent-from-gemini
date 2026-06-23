#!/usr/bin/env node

const appUrl = (process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');
const url = `${appUrl}/health`;
const fetchTimeoutMs = Number(process.env.SMIRK_LIVE_DB_HEALTH_FETCH_TIMEOUT_MS || 15000);
const fetchAttempts = Number(process.env.SMIRK_LIVE_DB_HEALTH_FETCH_ATTEMPTS || 2);
const fetchRetryDelayMs = Number(process.env.SMIRK_LIVE_DB_HEALTH_FETCH_RETRY_DELAY_MS || 750);

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

async function fetchHealth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchHealthWithRetry() {
  const attempts = Math.max(1, fetchAttempts);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchHealth();
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
      url,
      appUrl,
      attempts,
      timeoutMs: fetchTimeoutMs,
      retryDelayMs: fetchRetryDelayMs,
      lastError: normalizeFetchError(lastError),
    },
  };
}

const fetched = await fetchHealthWithRetry();
if (fetched.fetchFailed) {
  console.error(JSON.stringify({
    ok: false,
    error: 'live-db-health-fetch-failed',
    message: 'Could not verify live database health after bounded retries.',
    detail: fetched.detail,
  }, null, 2));
  process.exit(1);
}

const { res, text } = fetched;
let parsed = null;
try {
  parsed = JSON.parse(text);
} catch {
  console.error(JSON.stringify({ ok: false, url, status: res.status, error: 'invalid-json', sample: text.slice(0, 200) }, null, 2));
  process.exit(1);
}

const dbEnabled = !!parsed?.db?.enabled;
const dbOk = !!parsed?.db?.ok;
const appStatus = parsed?.status || 'unknown';
const out = {
  ok: res.ok && (!dbEnabled || dbOk),
  url,
  status: res.status,
  appStatus,
  db: parsed?.db || null,
  version: parsed?.version || null,
  branch: parsed?.branch || null,
};

if (!res.ok) {
  console.error(JSON.stringify({ ...out, error: 'http-failure' }, null, 2));
  process.exit(1);
}

if (dbEnabled && !dbOk) {
  console.error(JSON.stringify({ ...out, error: 'db-unreachable', likelyCause: 'Live app booted but Postgres is degraded/unreachable. Verify Railway Postgres service attachment and DATABASE_URL wiring.' }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(out, null, 2));
