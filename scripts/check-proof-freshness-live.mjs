#!/usr/bin/env node

const appUrl = String(process.env.APP_URL || 'https://smirkcalls.com').replace(/\/$/, '');
const allowStale = process.argv.includes('--allow-stale');
const fetchTimeoutMs = Number(process.env.SMIRK_PROOF_FRESHNESS_FETCH_TIMEOUT_MS || 15000);
const fetchAttempts = Number(process.env.SMIRK_PROOF_FRESHNESS_FETCH_ATTEMPTS || 2);
const fetchRetryDelayMs = Number(process.env.SMIRK_PROOF_FRESHNESS_FETCH_RETRY_DELAY_MS || 750);

function fail(message, detail = {}) {
  console.error(JSON.stringify({ ok: false, message, detail }, null, 2));
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

async function fetchText(pathname) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const response = await fetch(`${appUrl}${pathname}`, {
      signal: controller.signal,
    });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithRetry(pathname) {
  const attempts = Math.max(1, fetchAttempts);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchText(pathname);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(fetchRetryDelayMs);
      }
    }
  }
  const normalized = normalizeFetchError(lastError);
  fail('proof-freshness-fetch-failed', {
    pathname,
    appUrl,
    attempts,
    timeoutMs: fetchTimeoutMs,
    retryDelayMs: fetchRetryDelayMs,
    lastError: normalized,
  });
}

const { response, text } = await fetchTextWithRetry('/api/public-proof-snapshot');
let body;
try {
  body = JSON.parse(text);
} catch {
  fail('public proof snapshot did not return JSON', {
    status: response.status,
    sample: text.slice(0, 500),
  });
}

const proofFreshness = body?.proofFreshness;
if (!response.ok || !proofFreshness || typeof proofFreshness !== 'object') {
  fail('public proof snapshot is missing proofFreshness', {
    status: response.status,
    body,
  });
}

const completeProofCalls = Number(body.completeProofCalls || 0);
const fresh = proofFreshness.fresh === true;
const cacheControl = String(response.headers.get('cache-control') || '').toLowerCase();
const cacheProtected = cacheControl.includes('no-store');
const output = {
  ok: response.ok && cacheProtected && completeProofCalls > 0 && (fresh || allowStale),
  appUrl,
  completeProofCalls,
  proofFreshness,
  cacheControl,
  cacheProtected,
  freshnessGate: fresh ? 'pass' : 'stale-or-missing',
  allowStale,
};

console.log(JSON.stringify(output, null, 2));

if (!output.ok) {
  process.exit(1);
}
