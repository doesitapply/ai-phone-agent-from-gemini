#!/usr/bin/env node
const appUrl = String(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');

async function check(label, path, init, expect) {
  const res = await fetch(`${appUrl}${path}`, init);
  const text = await res.text();
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
  (status, text) => {
    if (status !== 200) return false;
    try {
      const body = JSON.parse(text);
      const plans = Array.isArray(body.plans) ? body.plans : [];
      const expected = new Map([
        ['starter', 299],
        ['pro', 599],
        ['enterprise', 1499],
      ]);

      if (plans.length !== expected.size) return false;

      const joined = JSON.stringify(plans).toLowerCase();
      if (/\b(text|sms|reply yes|customer texting)\b/.test(joined)) return false;

      return plans.every((plan) => {
        const expectedPrice = expected.get(plan?.id);
        return (
          expectedPrice === plan?.price &&
          plan?.interval === 'month' &&
          /^https:\/\/buy\.stripe\.com\//.test(String(plan?.checkout_url || '')) &&
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
  'POST /api/provisioning/request',
  '/api/provisioning/request',
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  (status, text) => {
    if (status === 429) return /too many demo requests/i.test(text);
    return status !== 404 && /business_name and owner_email required/i.test(text);
  }
);

await check(
  'POST /api/provisioning/checkout-status',
  '/api/provisioning/checkout-status',
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  (status, text) => {
    if (status === 429) return /too many demo requests/i.test(text);
    return status !== 404 && /email required/i.test(text);
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
