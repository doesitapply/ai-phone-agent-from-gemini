#!/usr/bin/env node
const appUrl = String(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');

const res = await fetch(`${appUrl}/api/auth/google/config`);
const text = await res.text();
let body = {};
try {
  body = JSON.parse(text);
} catch {
  console.error(`FAIL ${appUrl}/api/auth/google/config did not return JSON`);
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
if (!adminEnabled) {
  console.log('WARN admin Google sign-in is not fully enabled yet; set GOOGLE_ADMIN_EMAILS alongside DASHBOARD_API_KEY if needed.');
}
