#!/usr/bin/env node
const appUrl = String(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');
const fetchTimeoutMs = Number(process.env.SMIRK_BUYER_ROUTES_FETCH_TIMEOUT_MS || 15000);
const fetchAttempts = Number(process.env.SMIRK_BUYER_ROUTES_FETCH_ATTEMPTS || 2);
const fetchRetryDelayMs = Number(process.env.SMIRK_BUYER_ROUTES_FETCH_RETRY_DELAY_MS || 750);

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

async function fetchText(path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const res = await fetch(`${appUrl}${path}`, {
      ...init,
      signal: controller.signal,
    });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithRetry(path, init = {}) {
  const attempts = Math.max(1, fetchAttempts);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchText(path, init);
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
      path,
      appUrl,
      attempts,
      timeoutMs: fetchTimeoutMs,
      retryDelayMs: fetchRetryDelayMs,
      lastError: normalizeFetchError(lastError),
    },
  };
}

async function check(label, path, init, expect) {
  const fetched = await fetchTextWithRetry(path, init);
  if (fetched.fetchFailed) {
    console.log(`FAIL ${label} -> fetch failed`);
    console.log(JSON.stringify({
      ok: false,
      error: 'buyer-route-fetch-failed',
      message: 'Could not fetch live buyer route after bounded retries.',
      detail: fetched.detail,
    }, null, 2));
    process.exitCode = 1;
    return;
  }
  const { res, text } = fetched;
  const ok = expect(res.status, text, res.headers);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} -> ${res.status}`);
  if (!ok) {
    console.log(text.slice(0, 400));
    if (path === '/api/version' && res.status === 404) {
      console.log('Diagnosis: live app is reachable, but the current Railway deployment is stale or serving an older route set that does not include /api/version.');
      console.log('Next action: redeploy the current app service from this repo, then rerun this buyer route audit.');
    }
    process.exitCode = 1;
  }
}

function cacheProtected(headers) {
  return String(headers.get('cache-control') || '').toLowerCase().includes('no-store');
}

await check(
  'GET /',
  '/',
  {},
  (status, _text, headers) => status === 200 && !String(headers.get('www-authenticate') || '').toLowerCase().includes('basic')
);

await check(
  'GET /api/version',
  '/api/version',
  {},
  (status, text) => status === 200 && /"version"\s*:/.test(text)
);

await check(
  'GET /api/pricing',
  '/api/pricing',
  {},
  (status, text, headers) => {
    if (status !== 200 || !cacheProtected(headers)) return false;
    try {
      const body = JSON.parse(text);
      const plans = Array.isArray(body.plans) ? body.plans : [];
      const expected = new Map([
        ['starter', { price: 197, usage: '500 calls and 1,000 minutes per month.' }],
        ['pro', { price: 397, usage: '2,000 calls and 5,000 minutes per month.' }],
        ['enterprise', { price: 697, usage: 'Usage limits and any overage terms require an owner-approved Enterprise policy before checkout is available.' }],
      ]);

      if (plans.length !== expected.size) return false;

      const joined = JSON.stringify(plans).toLowerCase();
      if (/\b(text|sms|reply yes|customer texting)\b/.test(joined)) return false;

      return plans.every((plan) => {
        const expectedPlan = expected.get(plan?.id);
        return (
          expectedPlan?.price === plan?.price &&
          expectedPlan?.usage === plan?.usage_summary &&
          plan?.interval === 'month' &&
          plan?.checkout_available === (plan?.id !== 'enterprise') &&
          !Object.prototype.hasOwnProperty.call(plan, 'checkout_url') &&
          Array.isArray(plan?.features) &&
          plan.features.length > 0
        );
      });
    } catch {
      return false;
    }
  }
);

await check(
  'GET /api/first-dollar-readiness',
  '/api/first-dollar-readiness',
  {},
  (status, text, headers) => {
    if (
      status !== 200 ||
      String(headers.get('www-authenticate') || '').toLowerCase().includes('basic') ||
      !cacheProtected(headers)
    ) return false;
    try {
      const body = JSON.parse(text);
      const joined = JSON.stringify(body).toLowerCase();
      const forbidden = [
        'stripe_secret_key',
        'checkout_urls_in_pricing',
        'database_url',
        'phone_agent_api_key',
        'phone_agent_provisioning_secret',
        'dashboard_api_key',
        'workspace_api_key',
        'invite_token',
        'owner_email',
        'from_number',
        'to_number',
        'phone_number',
        'transcript',
        'recording_url',
        'call_summary',
        'task_notes',
        'messages',
        'stack',
      ];
      return typeof body?.checkoutReady === 'boolean' &&
        typeof body?.activationReady === 'boolean' &&
        typeof body?.firstDollarReady === 'boolean' &&
        body?.firstDollarReady === (body.checkoutReady && body.activationReady) &&
        ['automatic', 'not_ready'].includes(body?.activationMode) &&
        typeof body?.fulfillmentBound === 'boolean' &&
        Number.isFinite(Number(body?.planCount)) &&
        !forbidden.some((key) => joined.includes(key));
    } catch {
      return false;
    }
  }
);

await check(
  'POST /api/checkout/create',
  '/api/checkout/create',
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"plan":"__invalid_smirk_audit_plan__"}' },
  (status, text, headers) => {
    if (status === 429) return /too many demo requests/i.test(text);
    return status === 400 &&
      /unknown plan/i.test(text) &&
      cacheProtected(headers) &&
      !String(headers.get('www-authenticate') || '').toLowerCase().includes('basic');
  }
);

await check(
  'GET /api/public-proof-snapshot',
  '/api/public-proof-snapshot',
  {},
  (status, text) => {
    if (status !== 200) return false;
    try {
      const body = JSON.parse(text);
      const requiredNumeric = [
        'totalCalls',
        'callsThisMonth',
        'summariesGenerated',
        'callbackTasksCreated',
        'ownerEmailAlertsSent',
        'completeProofCalls',
        'transferredHandoffs',
        'summaryCoverage',
      ];
      const forbidden = ['from_number', 'to_number', 'phone_number', 'transcript', 'recording_url', 'call_summary', 'task_notes', 'messages'];
      const joined = JSON.stringify(body).toLowerCase();
      return requiredNumeric.every((key) => Number.isFinite(Number(body[key]))) &&
        typeof body.updatedAt === 'string' &&
        !forbidden.some((key) => joined.includes(key));
    } catch {
      return false;
    }
  }
);

await check(
  'POST /api/provisioning/request',
  '/api/provisioning/request',
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  (status, text, headers) => {
    if (status === 429) return /too many demo requests/i.test(text);
    return status !== 404 &&
      /business_name and owner_email required/i.test(text) &&
      cacheProtected(headers);
  }
);

await check(
  'POST /api/provisioning/checkout-status',
  '/api/provisioning/checkout-status',
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  (status, text, headers) => {
    if (status === 429) return /too many demo requests/i.test(text);
    return status !== 404 &&
      /email required/i.test(text) &&
      cacheProtected(headers);
  }
);

await check(
  'POST /api/provisioning/checkout-status not-found',
  '/api/provisioning/checkout-status',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"email":"smirk-live-audit-not-found@example.invalid"}',
  },
  (status, text, headers) => {
    if (status === 429) return /too many demo requests/i.test(text);
    if (
      status !== 200 ||
      String(headers.get('www-authenticate') || '').toLowerCase().includes('basic') ||
      !cacheProtected(headers)
    ) return false;
    try {
      const body = JSON.parse(text);
      const joined = JSON.stringify(body).toLowerCase();
      return body?.ok === true &&
        body?.found === false &&
        body?.status === 'secure_reference_required' &&
        body?.status_label === 'Secure checkout reference required' &&
        body?.access_active === false &&
        !body?.request &&
        !body?.request_summary &&
        !body?.activation_status &&
        !joined.includes('invite_link') &&
        !joined.includes('workspace_api_key') &&
        !joined.includes('api_key');
    } catch {
      return false;
    }
  }
);

await check(
  'POST /api/provisioning/checkout-status malformed-session',
  '/api/provisioning/checkout-status',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"email":"smirk-live-audit-not-found@example.invalid","checkout_session_id":"not-a-checkout-session"}',
  },
  (status, text, headers) => {
    if (status === 429) return /too many demo requests/i.test(text);
    return status === 400 &&
      /valid checkout_session_id required/i.test(text) &&
      cacheProtected(headers);
  }
);

await check(
  'GET /success',
  '/success',
  {},
  (status, text, headers) =>
    status === 200 &&
    !String(headers.get('www-authenticate') || '').toLowerCase().includes('basic') &&
    /<div\s+id=["']root["']\s*>/i.test(text)
);

await check(
  'GET /cancel',
  '/cancel',
  {},
  (status, text, headers) =>
    status === 200 &&
    !String(headers.get('www-authenticate') || '').toLowerCase().includes('basic') &&
    /<div\s+id=["']root["']\s*>/i.test(text)
);

if (process.exitCode) {
  console.error(`\nFAIL buyer route audit for ${appUrl}`);
  process.exit(process.exitCode);
}

console.log(`\nOK buyer route audit for ${appUrl}`);
