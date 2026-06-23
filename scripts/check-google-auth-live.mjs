#!/usr/bin/env node
const appUrl = String(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');
const appOrigin = new URL(appUrl).origin;
const configUrl = `${appUrl}/api/auth/google/config`;

const fetchTimeoutMs = Number(process.env.SMIRK_GOOGLE_AUTH_FETCH_TIMEOUT_MS || 15_000);
const fetchAttempts = Number(process.env.SMIRK_GOOGLE_AUTH_FETCH_ATTEMPTS || 2);
const fetchRetryDelayMs = Number(process.env.SMIRK_GOOGLE_AUTH_FETCH_RETRY_DELAY_MS || 750);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeFetchError(error) {
  if (error?.name === 'AbortError') {
    return `Timed out after ${fetchTimeoutMs}ms`;
  }
  return error?.message || String(error);
}

async function fetchConfig() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    return await fetch(configUrl, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchConfigWithRetry() {
  let lastError = null;
  for (let attempt = 1; attempt <= fetchAttempts; attempt += 1) {
    try {
      return { res: await fetchConfig(), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < fetchAttempts) {
        await sleep(fetchRetryDelayMs);
      }
    }
  }

  return {
    error: lastError,
    detail: normalizeFetchError(lastError),
    attempts: fetchAttempts,
  };
}

const fetched = await fetchConfigWithRetry();
if (!fetched.res) {
  console.error(JSON.stringify({
    ok: false,
    error: 'google-auth-fetch-failed',
    message: 'Could not verify live Google auth config after bounded retries.',
    url: configUrl,
    attempts: fetched.attempts,
    detail: fetched.detail,
  }, null, 2));
  process.exit(1);
}

const { res } = fetched;
const text = await res.text();
let body = {};
try {
  body = JSON.parse(text);
} catch {
  console.error(JSON.stringify({
    ok: false,
    error: 'google-auth-invalid-json',
    message: 'Live Google auth config endpoint did not return JSON.',
    url: configUrl,
    status: res.status,
    bodySample: text.slice(0, 240),
  }, null, 2));
  process.exit(1);
}

const enabled = !!body.enabled;
const clientId = String(body.clientId || '').trim();
const adminEnabled = !!body.adminEnabled;
const adminHint = String(body.adminHint || '').trim();

console.log(`GET /api/auth/google/config -> ${res.status}`);
console.log(`enabled=${enabled} clientIdPresent=${clientId ? 'yes' : 'no'} adminEnabled=${adminEnabled} adminHintPresent=${adminHint ? 'yes' : 'no'}`);

if (res.status !== 200) {
  console.error(body.error || `FAIL Google auth config endpoint returned HTTP ${res.status}`);
  process.exit(1);
}

if (!enabled || !clientId) {
  console.error('FAIL live Google workspace sign-in is not enabled. Set GOOGLE_OAUTH_CLIENT_ID in Railway.');
  console.error('Setup checklist: npm run print:google-auth-setup');
  console.error('Local scan: npm run find:google-auth-client-id');
  console.error('Auto dry run: npm run fix:google-auth-live:from-scan -- --dry-run');
  console.error('Dry run:   npm run fix:google-auth-live:dry -- your-google-web-client-id.apps.googleusercontent.com');
  console.error('Fast path: npm run fix:google-auth-live -- your-google-web-client-id.apps.googleusercontent.com');
  console.error('One-shot:  npm run fix:google-auth-live -- your-google-web-client-id.apps.googleusercontent.com && npm run -s check:ship-live');
  console.error('Alt path:  GOOGLE_OAUTH_CLIENT_ID="your-google-web-client-id.apps.googleusercontent.com" npm run set:google-auth-env');
  process.exit(1);
}

console.log('OK live Google workspace sign-in is enabled');
console.log(`Google Console must include this Authorized JavaScript origin: ${appOrigin}`);
console.log('If the browser shows Error 400: origin_mismatch, add that exact origin to the OAuth 2.0 Web application client.');
if (!adminEnabled) {
  console.log('WARN admin Google sign-in is not fully enabled yet; set GOOGLE_ADMIN_EMAILS alongside DASHBOARD_API_KEY if needed.');
}
