#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';

const envSearchPaths = [
  process.env.ENV_FILE,
  './.env.local',
  `${os.homedir()}/.openclaw/workspace/.env.smirk`,
  `${os.homedir()}/.openclaw/workspace/.env.operator`,
  `${os.homedir()}/OpenClaw/.env.smirk`,
  `${os.homedir()}/OpenClaw/.env.operator`,
  '../../.env',
  '../../.env.local',
].filter(Boolean);

function stripWrappingQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseEnvFile(path) {
  const out = {};
  for (const rawLine of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = stripWrappingQuotes(line.slice(eq + 1).trim());
    if (key) out[key] = value;
  }
  return out;
}

function loadEnvFiles(paths) {
  const merged = {};
  const loaded = [];
  for (const path of paths) {
    if (!path || !fs.existsSync(path)) continue;
    Object.assign(merged, parseEnvFile(path));
    loaded.push(path);
  }
  return { merged, loaded };
}

const { merged: fileEnv, loaded: loadedEnvFiles } = loadEnvFiles(envSearchPaths);
const pick = (key) => {
  const runtime = String(process.env[key] || '').trim();
  if (runtime) return runtime;
  return String(fileEnv[key] || '').trim();
};
const hasFileKey = (key) => Object.prototype.hasOwnProperty.call(fileEnv, key) && String(fileEnv[key] || '').trim().length > 0;
const looksPlaceholder = (value) => {
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
  ]);
  if (exact.has(normalized)) return true;
  return [
    'your_',
    'example.com',
    'xxxxx',
    '...'
  ].some((marker) => normalized.includes(marker));
};
const isConfigured = (value) => !looksPlaceholder(value);
const customValidation = (label, value) => {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  if (label === 'LANDING_APP_URL') {
    if (/manus\.space/i.test(normalized)) return 'must point at the production marketing domain, not manus.space';
    if (!/^https:\/\/smirkcalls\.com\/?$/i.test(normalized)) return 'must be exactly https://smirkcalls.com';
  }
  return null;
};

const requiredSpecs = [
  ['APP_URL', ['APP_URL'], 'public app base URL used in checkout and callback links', 'APP_URL="https://ai-phone-agent-production-6811.up.railway.app"'],
  ['LANDING_APP_URL', ['LANDING_APP_URL'], 'landing app base URL for provisioning-complete proof webhooks', 'LANDING_APP_URL="https://smirkcalls.com"'],
  ['PHONE_AGENT_PROVISIONING_SECRET', ['PHONE_AGENT_PROVISIONING_SECRET'], 'server-to-server secret shared with the landing app webhook', 'PHONE_AGENT_PROVISIONING_SECRET="change_me_to_a_unique_secret"'],
  ['STRIPE_PAYMENT_LINK_STARTER', ['STRIPE_PAYMENT_LINK_STARTER'], 'starter checkout link', 'STRIPE_PAYMENT_LINK_STARTER="https://buy.stripe.com/..."'],
  ['STRIPE_PAYMENT_LINK_PRO', ['STRIPE_PAYMENT_LINK_PRO'], 'pro checkout link', 'STRIPE_PAYMENT_LINK_PRO="https://buy.stripe.com/..."'],
  ['STRIPE_PAYMENT_LINK_ENTERPRISE', ['STRIPE_PAYMENT_LINK_ENTERPRISE'], 'enterprise checkout link', 'STRIPE_PAYMENT_LINK_ENTERPRISE="https://buy.stripe.com/..."'],
  ['AUTO_FULFILL_PROVISIONING_REQUESTS', ['AUTO_FULFILL_PROVISIONING_REQUESTS'], 'set true for automatic activation or false for tracked manual fallback', 'AUTO_FULFILL_PROVISIONING_REQUESTS="false"'],
  ['RESEND_API_KEY', ['RESEND_API_KEY'], 'owner email alert delivery', 'RESEND_API_KEY="re_..."'],
  ['FROM_EMAIL', ['FROM_EMAIL'], 'sender address for owner alerts', 'FROM_EMAIL="SMIRK <alerts@smirkcalls.com>"'],
  ['BOOKING_LINK or CALENDLY_URL', ['BOOKING_LINK', 'CALENDLY_URL'], 'handled setup / fallback scheduling link', 'BOOKING_LINK="https://calendly.com/smirkcalls/smirk-setup"'],
];

const required = requiredSpecs.map(([label, keys, note]) => [label, keys.map(pick).find((value) => String(value || '').trim().length > 0) || '', note]);

const optional = [
  ['PHONE_AGENT_API_KEY', pick('PHONE_AGENT_API_KEY'), 'live /api/demo submissions from landing or demo tools'],
  ['TWILIO_ACCOUNT_SID', pick('TWILIO_ACCOUNT_SID'), 'voice handling'],
  ['TWILIO_AUTH_TOKEN', pick('TWILIO_AUTH_TOKEN'), 'voice handling'],
  ['TWILIO_PHONE_NUMBER', pick('TWILIO_PHONE_NUMBER'), 'voice handling'],
  ['DATABASE_URL', pick('DATABASE_URL'), 'workspace/provisioning persistence'],
];

let missing = 0;
const row = (name, value, note) => {
  const ok = isConfigured(value);
  const customIssue = ok ? customValidation(name, value) : null;
  if (!ok || customIssue) missing += 1;
  return `${ok && !customIssue ? 'OK  ' : 'MISS'} ${name.padEnd(34)} ${note}${customIssue ? ` — ${customIssue}` : ''}`;
};

console.log('SMIRK first-dollar env readiness');
if (loadedEnvFiles.length) console.log(`Env files checked: ${loadedEnvFiles.join(', ')}`);
console.log('Required for paid signup + activation proof:\n');
for (const [name, value, note] of required) console.log(row(name, value, note));

console.log('\nOptional but important:\n');
for (const [name, value, note] of optional) {
  const ok = isConfigured(value);
  console.log(`${ok ? 'OK  ' : 'WARN'} ${name.padEnd(34)} ${note}`);
}

const auto = String(pick('AUTO_FULFILL_PROVISIONING_REQUESTS') || '').trim();
if (auto && auto !== 'true' && auto !== 'false') {
  console.log('\nWARN AUTO_FULFILL_PROVISIONING_REQUESTS should be exactly true or false');
}

if (missing > 0) {
  if (process.env.ENV_FILE) {
    const suggested = requiredSpecs
      .filter(([, keys]) => !keys.some((key) => hasFileKey(key) && isConfigured(fileEnv[key])))
      .map(([, , , example]) => example);
    if (suggested.length) {
      console.log('\nSuggested additions for the env file:\n');
      for (const line of suggested) console.log(line);
    }
  }
  console.error(`\nFAIL missing ${missing} required env value(s) for first-dollar readiness`);
  console.error('This checked local/runtime env only. To verify deployed buyer readiness, run: npm run -s check:railway:first-dollar-env');
  process.exit(1);
}

console.log('\nOK required first-dollar env values are present');
