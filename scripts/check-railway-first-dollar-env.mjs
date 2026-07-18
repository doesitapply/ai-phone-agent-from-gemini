#!/usr/bin/env node
import { railwayVariables } from './railway-json.mjs';

function looksPlaceholder(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return true;
  const exact = new Set([
    'change_me',
    'changeme',
    'replace_me',
    'your_gemini_api_key_here',
    'your_auth_token_here',
    'generate-a-strong-random-key-here',
    'https://your-app-url.example.com',
    'https://buy.stripe.com/...',
    're_...',
    'you@yourdomain.com',
  ]);
  if (exact.has(normalized)) return true;
  return ['your_', 'example.com', 'xxxxx', '...'].some((marker) => normalized.includes(marker));
}

function customValidation(label, value) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  if (label === 'LANDING_APP_URL') {
    if (/manus\.space/i.test(normalized)) return 'must point at the production marketing domain, not manus.space';
    if (!/^https:\/\/smirkcalls\.com\/?$/i.test(normalized)) return 'must be exactly https://smirkcalls.com';
  }
  if (label.startsWith('STRIPE_PAYMENT_LINK_') && label.endsWith('_ID') && !/^plink_[A-Za-z0-9_]+$/.test(normalized)) {
    return 'must be the exact live plink_ ID, not the public buy.stripe.com URL';
  }
  return null;
}

function getVars() {
  return railwayVariables();
}

let vars;
try {
  vars = getVars();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: 'railway-env-unavailable',
    message: 'Could not read Railway variables after bounded retries. This is a Railway CLI/API access problem, not proof that required env values are missing.',
    detail: error?.detail || String(error?.message || error),
  }, null, 2));
  process.exit(1);
}
const pick = (keys) => keys.map((k) => String(vars[k] || '').trim()).find(Boolean) || '';

const requiredSpecs = [
  ['APP_URL', ['APP_URL'], 'public app base URL used in checkout and callback links'],
  ['LANDING_APP_URL', ['LANDING_APP_URL'], 'landing app base URL for provisioning-complete proof webhooks'],
  ['PHONE_AGENT_PROVISIONING_SECRET', ['PHONE_AGENT_PROVISIONING_SECRET'], 'server-to-server secret shared with the landing app webhook'],
  ['STRIPE_PAYMENT_LINK_STARTER', ['STRIPE_PAYMENT_LINK_STARTER'], 'starter checkout link'],
  ['STRIPE_PAYMENT_LINK_STARTER_ID', ['STRIPE_PAYMENT_LINK_STARTER_ID'], 'starter webhook/product binding ID'],
  ['STRIPE_PAYMENT_LINK_PRO', ['STRIPE_PAYMENT_LINK_PRO'], 'pro checkout link'],
  ['STRIPE_PAYMENT_LINK_PRO_ID', ['STRIPE_PAYMENT_LINK_PRO_ID'], 'pro webhook/product binding ID'],
  ['STRIPE_PAYMENT_LINK_ENTERPRISE', ['STRIPE_PAYMENT_LINK_ENTERPRISE'], 'enterprise checkout link'],
  ['STRIPE_PAYMENT_LINK_ENTERPRISE_ID', ['STRIPE_PAYMENT_LINK_ENTERPRISE_ID'], 'enterprise webhook/product binding ID'],
  ['AUTO_FULFILL_PROVISIONING_REQUESTS', ['AUTO_FULFILL_PROVISIONING_REQUESTS'], 'set true for automatic activation or false for tracked manual fallback'],
  ['RESEND_API_KEY', ['RESEND_API_KEY'], 'owner email alert delivery'],
  ['FROM_EMAIL', ['FROM_EMAIL'], 'sender address for owner alerts'],
  ['BOOKING_LINK or CALENDLY_URL', ['BOOKING_LINK', 'CALENDLY_URL'], 'handled setup-help fallback link'],
  ['GOOGLE_OAUTH_CLIENT_ID', ['GOOGLE_OAUTH_CLIENT_ID'], 'workspace users can sign in without needing a workspace API key'],
];

const optionalSpecs = [
  ['PHONE_AGENT_API_KEY', ['PHONE_AGENT_API_KEY'], 'live /api/demo submissions from landing or demo tools'],
  ['DASHBOARD_API_KEY', ['DASHBOARD_API_KEY'], 'live operator admin profile + authenticated dashboard operator access'],
  ['GOOGLE_ADMIN_EMAILS', ['GOOGLE_ADMIN_EMAILS'], 'optional allowlist for admin/operator Google sign-in when DASHBOARD_API_KEY is set'],
  ['TWILIO_ACCOUNT_SID', ['TWILIO_ACCOUNT_SID'], 'voice handling'],
  ['TWILIO_AUTH_TOKEN', ['TWILIO_AUTH_TOKEN'], 'voice handling'],
  ['TWILIO_PHONE_NUMBER', ['TWILIO_PHONE_NUMBER'], 'voice handling'],
  ['DATABASE_URL', ['DATABASE_URL'], 'workspace/provisioning persistence'],
];

let missing = 0;
let placeholder = 0;
const missingLabels = [];
const placeholderLabels = [];
const row = (label, value, note) => {
  const present = String(value || '').trim().length > 0;
  const configured = present && !looksPlaceholder(value);
  const customIssue = configured ? customValidation(label, value) : null;
  if (!present) {
    missing += 1;
    missingLabels.push(label);
  } else if (!configured || customIssue) {
    placeholder += 1;
    placeholderLabels.push(label);
  }
  const status = !present ? 'MISS' : (!configured || customIssue) ? 'WARN' : 'OK  ';
  return `${status} ${label.padEnd(34)} ${note}${customIssue ? ` — ${customIssue}` : ''}`;
};

console.log('SMIRK Railway first-dollar env readiness');
console.log('Target: live Railway service variables\n');
console.log('Required for paid signup + activation proof:\n');
for (const [label, keys, note] of requiredSpecs) console.log(row(label, pick(keys), note));
console.log('\nOptional but important:\n');
for (const [label, keys, note] of optionalSpecs) {
  const value = pick(keys);
  const configured = String(value || '').trim().length > 0 && !looksPlaceholder(value);

  if (label === 'DATABASE_URL' && configured) {
    let host = '';
    try {
      host = new URL(String(value)).hostname;
    } catch {
      console.log(`WARN ${label.padEnd(34)} invalid database URL format`);
      continue;
    }
    const internalHost = /railway\.internal$/i.test(host);
    console.log(`${internalHost ? 'WARN' : 'OK  '} ${label.padEnd(34)} ${internalHost ? `workspace/provisioning persistence — internal host ${host}; if live DB health is degraded, reselect the Postgres reference variable in Railway` : note}`);
    continue;
  }

  console.log(`${configured ? 'OK  ' : 'WARN'} ${label.padEnd(34)} ${note}`);
}

const auto = pick(['AUTO_FULFILL_PROVISIONING_REQUESTS']);
if (auto && auto !== 'true' && auto !== 'false') console.log('\nWARN AUTO_FULFILL_PROVISIONING_REQUESTS should be exactly true or false');

if (missing > 0 || placeholder > 0) {
  console.error(`\nFAIL live Railway env has ${missing} missing and ${placeholder} placeholder required value(s)`);
  if (missingLabels.length) console.error(`Missing: ${missingLabels.join(', ')}`);
  if (placeholderLabels.length) console.error(`Placeholder/needs replacement: ${placeholderLabels.join(', ')}`);

  const needsFastPath = ['STRIPE_PAYMENT_LINK_STARTER', 'STRIPE_PAYMENT_LINK_STARTER_ID', 'STRIPE_PAYMENT_LINK_PRO', 'STRIPE_PAYMENT_LINK_PRO_ID', 'STRIPE_PAYMENT_LINK_ENTERPRISE', 'STRIPE_PAYMENT_LINK_ENTERPRISE_ID', 'FROM_EMAIL']
    .some((label) => missingLabels.includes(label) || placeholderLabels.includes(label));

  if (needsFastPath || placeholderLabels.includes('LANDING_APP_URL') || missingLabels.includes('LANDING_APP_URL') || missingLabels.includes('GOOGLE_OAUTH_CLIENT_ID') || placeholderLabels.includes('GOOGLE_OAUTH_CLIENT_ID')) {
    console.error('\nFast path to fix the live blocker:');
    console.error("  STRIPE_PAYMENT_LINK_STARTER=\"https://buy.stripe.com/...\" \\");
    console.error("  STRIPE_PAYMENT_LINK_STARTER_ID=\"plink_...\" \\");
    console.error("  STRIPE_PAYMENT_LINK_PRO=\"https://buy.stripe.com/...\" \\");
    console.error("  STRIPE_PAYMENT_LINK_PRO_ID=\"plink_...\" \\");
    console.error("  STRIPE_PAYMENT_LINK_ENTERPRISE=\"https://buy.stripe.com/...\" \\");
    console.error("  STRIPE_PAYMENT_LINK_ENTERPRISE_ID=\"plink_...\" \\");
    console.error("  FROM_EMAIL=\"SMIRK <alerts@smirkcalls.com>\" \\");
    console.error("  LANDING_APP_URL=\"https://smirkcalls.com\" \\");
    console.error("  GOOGLE_OAUTH_CLIENT_ID=\"your-google-web-client-id.apps.googleusercontent.com\" \\");
    console.error('  npm run set:first-dollar-live-env');
    if ((placeholderLabels.length === 1 && placeholderLabels[0] === 'LANDING_APP_URL') || (missingLabels.length === 1 && missingLabels[0] === 'LANDING_APP_URL')) {
      console.error('');
      console.error('Landing-only fast path:');
      console.error('  npm run set:landing-app-url');
      console.error('  # or explicitly: LANDING_APP_URL="https://smirkcalls.com" npm run set:landing-app-url');
    }
    if ((placeholderLabels.length === 1 && placeholderLabels[0] === 'GOOGLE_OAUTH_CLIENT_ID') || (missingLabels.length === 1 && missingLabels[0] === 'GOOGLE_OAUTH_CLIENT_ID')) {
      console.error('');
      console.error('Google-auth-only fast path:');
      console.error('  npm run find:google-auth-client-id');
      console.error('  npm run print:google-auth-setup');
      console.error('  # auto dry run if a local client ID exists: npm run fix:google-auth-live:from-scan -- --dry-run');
      console.error('  # dry run: npm run fix:google-auth-live:dry -- your-google-web-client-id.apps.googleusercontent.com');
      console.error('  # then:    npm run fix:google-auth-live -- your-google-web-client-id.apps.googleusercontent.com');
      console.error('  # alt:     GOOGLE_OAUTH_CLIENT_ID="your-google-web-client-id.apps.googleusercontent.com" npm run set:google-auth-env');
    }
    console.error('');
    console.error('If FROM_EMAIL is the blocker, first run:');
    console.error('  npm run cutover:sender-domain -- --dry-run');
  }
  process.exit(1);
}

console.log('\nOK required live Railway env values are present');

const googleClientId = pick(['GOOGLE_OAUTH_CLIENT_ID']);
if (!String(googleClientId || '').trim() || looksPlaceholder(googleClientId)) {
  console.log('\nWARN live Google workspace sign-in is not enabled yet.');
  console.log('Fast path: npm run fix:google-auth-live -- your-google-web-client-id.apps.googleusercontent.com');
  console.log('Alt path:  GOOGLE_OAUTH_CLIENT_ID="your-google-web-client-id.apps.googleusercontent.com" npm run set:google-auth-env');
}
