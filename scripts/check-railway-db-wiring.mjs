#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { railwayVariables } from './railway-json.mjs';

const appUrl = (process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');
const fetchTimeoutMs = Number(process.env.SMIRK_RAILWAY_DB_WIRING_FETCH_TIMEOUT_MS || 15000);
const fetchAttempts = Number(process.env.SMIRK_RAILWAY_DB_WIRING_FETCH_ATTEMPTS || 2);
const fetchRetryDelayMs = Number(process.env.SMIRK_RAILWAY_DB_WIRING_FETCH_RETRY_DELAY_MS || 750);
const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() || 'main';
const deployCommand = branch !== 'main'
  ? `CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix CONFIRM_SMIRK_DEPLOY_BRANCH=${branch} npm run deploy:post-call-fix`
  : 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix npm run deploy:post-call-fix';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeFetchError(error) {
  if (error?.name === 'AbortError') {
    return `fetch timed out after ${fetchTimeoutMs}ms`;
  }
  return String(error?.message || error || 'unknown fetch error');
}

function summarizeRailwayError(error) {
  const detail = error?.detail || null;
  const text = [
    error?.message,
    detail?.message,
    detail?.stdout,
    detail?.stderr,
    detail?.error,
  ].filter(Boolean).join('\n');
  return {
    message: String(error?.message || 'Railway variable lookup failed'),
    detail,
    retryable: /rate\s*limit|ratelimit|ratelimited|too many requests|econnreset|etimedout|timeout/i.test(text),
  };
}

async function fetchHealthWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchHealthWithRetry(url) {
  let lastError = null;
  const attempts = Math.max(1, fetchAttempts);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await fetchHealthWithTimeout(url);
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(fetchRetryDelayMs);
      }
    }
  }
  return {
    error: 'railway-db-wiring-fetch-failed',
    detail: normalizeFetchError(lastError),
    attempts,
  };
}

let liveHealth = null;
const liveHealthResult = await fetchHealthWithRetry(`${appUrl}/health`);
if (liveHealthResult.error) {
  liveHealth = {
    status: null,
    appStatus: null,
    db: null,
    warning: liveHealthResult.error,
    detail: liveHealthResult.detail,
    attempts: liveHealthResult.attempts,
  };
} else {
  const { res, text, attempts } = liveHealthResult;
  try {
    const parsed = JSON.parse(text);
    liveHealth = {
      status: res.status,
      appStatus: parsed?.status || null,
      db: parsed?.db || null,
      attempts,
    };
  } catch {
    liveHealth = {
      status: res.status,
      appStatus: null,
      db: null,
      warning: 'railway-db-wiring-invalid-health-json',
      detail: text.slice(0, 240),
      attempts,
    };
  }
}

let vars = null;
let dbUrl = '';
let railwayVariableRead = { ok: true, retryable: false, error: null };
try {
  vars = railwayVariables();
  dbUrl = String(vars.DATABASE_URL || '').trim();
} catch (error) {
  railwayVariableRead = {
    ok: false,
    ...summarizeRailwayError(error),
  };
}

let host = null;
if (dbUrl) {
  try {
    host = new URL(dbUrl).hostname;
  } catch {
    console.error(JSON.stringify({ ok: false, error: 'invalid-database-url' }, null, 2));
    process.exit(1);
  }
}

const internalHost = /railway\.internal$/i.test(host);
const dbDegraded = !!(liveHealth?.db?.enabled && liveHealth?.db?.ok === false);
const liveDbHealthy = !!(liveHealth?.db?.enabled && liveHealth?.db?.ok === true);

if (!dbUrl && railwayVariableRead.ok) {
  console.error(JSON.stringify({ ok: false, error: 'missing-database-url' }, null, 2));
  process.exit(1);
}

if (!dbUrl && !railwayVariableRead.ok && (!railwayVariableRead.retryable || !liveDbHealthy)) {
  console.error(JSON.stringify({
    ok: false,
    error: 'database-url-unreadable',
    railwayVariableRead,
    liveHealth,
    remediation: {
      retry: 'Wait for Railway variable-read rate limits to clear, then rerun npm run check:railway-db-wiring.',
      verifyLiveDb: 'npm run check:live-db-health',
    },
  }, null, 2));
  process.exit(1);
}

const out = {
  ok: true,
  host,
  internalHost,
  liveHealth,
  railwayVariableRead,
  warning: !dbUrl && railwayVariableRead.retryable && liveDbHealthy
    ? 'Railway variable lookup is rate-limited, but live /health reports DB enabled and OK. Host inspection is skipped for this run.'
    : internalHost
      ? 'DATABASE_URL uses a Railway private host. If live DB health is degraded, reselect DATABASE_URL from the Postgres service reference variable instead of using a pasted value.'
      : null,
  diagnosis: internalHost && dbDegraded
    ? 'DATABASE_URL points at a Railway internal host and live /health reports DB degraded. Treat this as a real DB wiring/attachment failure until proven otherwise.'
    : null,
  remediation: internalHost
    ? {
        railwayUi: [
          'Open Railway project ai-phone-agent',
          'Open production environment',
          'Open app service ai-phone-agent → Variables',
          'Replace DATABASE_URL with an Add Reference value from the Postgres service in the same environment',
          'Common reference forms: ${{Postgres.DATABASE_URL}} or ${{postgres.DATABASE_URL}} depending on the service name',
        ],
        verifyCommands: [
          deployCommand,
          'npm run check:live-db-health',
          'npm run check:post-deploy-live',
        ],
      }
    : null,
};

if (internalHost && dbDegraded) {
  console.error(JSON.stringify(out, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(out, null, 2));
