#!/usr/bin/env node
const appUrl = String(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');
const fetchTimeoutMs = Number(process.env.SMIRK_LIVE_APP_HEALTH_FETCH_TIMEOUT_MS || 15000);
const fetchAttempts = Number(process.env.SMIRK_LIVE_APP_HEALTH_FETCH_ATTEMPTS || 2);
const fetchRetryDelayMs = Number(process.env.SMIRK_LIVE_APP_HEALTH_FETCH_RETRY_DELAY_MS || 750);

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
    const res = await fetch(`${appUrl}${pathname}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await res.text();
    return { res, text };
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

async function main() {
  const [healthFetched, versionFetched] = await Promise.all([
    fetchTextWithRetry('/health'),
    fetchTextWithRetry('/api/version'),
  ]);

  const failedFetch = [
    ['health', healthFetched],
    ['version', versionFetched],
  ].find(([, fetched]) => fetched?.fetchFailed);

  if (failedFetch) {
    console.error(JSON.stringify({
      ok: false,
      error: 'live-app-health-fetch-failed',
      failedCheck: failedFetch[0],
      detail: failedFetch[1].detail,
      nextAction: 'Fix live app reachability or rerun after the transient fetch failure clears; do not rely on post-deploy proof until live critical health passes.',
    }, null, 2));
    process.exit(1);
  }

  const { res: healthRes, text: healthText } = healthFetched;
  const { res: versionRes, text: versionText } = versionFetched;

  let health;
  try {
    health = JSON.parse(healthText);
  } catch {
    console.error('FAIL /health did not return JSON');
    process.exit(1);
  }

  const dbOk = Boolean(health?.db?.ok);
  const twilioOk = Boolean(health?.twilioConfigured);
  const aiOk = Boolean(health?.aiConfigured);
  const paymentOk = Boolean(health?.paymentLinksConfigured);
  const ownerEmailOk = Boolean(health?.ownerEmailDeliveryConfigured);
  const versionOk = versionRes.status === 200 && /"version"\s*:/.test(versionText);

  console.log(`GET /health -> ${healthRes.status}`);
  console.log(`status=${health?.status} twilioConfigured=${health?.twilioConfigured} aiConfigured=${health?.aiConfigured} paymentLinksConfigured=${health?.paymentLinksConfigured} ownerEmailDeliveryConfigured=${health?.ownerEmailDeliveryConfigured} db.ok=${health?.db?.ok}`);
  console.log(`GET /api/version -> ${versionRes.status}`);

  if (!dbOk || !twilioOk || !aiOk || !paymentOk || !ownerEmailOk || !versionOk) {
    if (!dbOk) console.log('Diagnosis: live app database path is degraded, so calls/workspace persistence are not fully healthy.');
    if (!twilioOk) console.log('Diagnosis: Twilio is not configured, so live calls cannot enter the missed-call recovery path.');
    if (!aiOk) console.log('Diagnosis: AI is not configured, so calls cannot produce useful post-call summaries.');
    if (!paymentOk) console.log('Diagnosis: payment links are not configured, so a prospect cannot pay online.');
    if (!ownerEmailOk) console.log(`Diagnosis: owner email delivery is not configured, so callback-ready leads cannot alert the business.${health?.ownerEmailNextAction ? ` Next action: ${health.ownerEmailNextAction}` : ''}`);
    if (!versionOk) console.log('Diagnosis: live app is still stale or missing the current deploy freshness route.');
    process.exit(1);
  }

  console.log('OK live app critical first-dollar health is green');
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    error: 'live-app-critical-health-failed',
    detail: {
      name: err?.name || null,
      message: String(err?.message || err || ''),
      code: err?.cause?.code || err?.code || null,
    },
  }, null, 2));
  process.exit(1);
});
