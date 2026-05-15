#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workspaceRoot = process.env.WORKSPACE_ROOT || path.join(os.homedir(), '.openclaw', 'workspace');
const operatorEnvPath = path.join(workspaceRoot, '.env.operator');
const smirkEnvPath = path.join(workspaceRoot, '.env.smirk');
const inventoryPath = path.join(workspaceRoot, 'state', 'secret-inventory.json');

function stripWrappingQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
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

const operatorEnv = parseEnvFile(operatorEnvPath);
const smirkEnv = parseEnvFile(smirkEnvPath);
const inventory = fs.existsSync(inventoryPath) ? JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) : {};

const pick = (...keys) => {
  for (const key of keys) {
    const fromOperator = String(operatorEnv[key] || '').trim();
    if (fromOperator) return { key, where: '.env.operator', value: fromOperator };
    const fromSmirk = String(smirkEnv[key] || '').trim();
    if (fromSmirk) return { key, where: '.env.smirk', value: fromSmirk };
  }
  return { key: keys[0], where: null, value: '' };
};

const looksPlaceholder = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return true;
  return ['change_me', 'replace_me', 'your_', 'example.com', 'https://buy.stripe.com/...', 're_...'].some((marker) => normalized.includes(marker));
};

const specs = [
  ['Railway CLI auth', ['RAILWAY_API_TOKEN', 'RAILWAY_TOKEN'], 'operator access'],
  ['GitHub push auth', ['GITHUB_TOKEN', 'GITHUB_PAT'], 'optional unless git push/auth is needed'],
  ['Resend API', ['RESEND_API_KEY'], 'owner email alerts'],
  ['From email', ['FROM_EMAIL'], 'verified sender for owner alerts'],
  ['Stripe starter link', ['STRIPE_PAYMENT_LINK_STARTER'], 'paid signup'],
  ['Stripe pro link', ['STRIPE_PAYMENT_LINK_PRO'], 'paid signup'],
  ['Stripe enterprise link', ['STRIPE_PAYMENT_LINK_ENTERPRISE'], 'paid signup'],
  ['Provisioning secret', ['PHONE_AGENT_PROVISIONING_SECRET'], 'landing -> app webhook auth'],
  ['Landing app URL', ['LANDING_APP_URL'], 'post-checkout handoff'],
  ['App URL', ['APP_URL'], 'callback/provisioning links'],
  ['Twilio SID', ['TWILIO_ACCOUNT_SID'], 'voice handling'],
  ['Twilio auth token', ['TWILIO_AUTH_TOKEN'], 'voice handling'],
  ['Twilio phone number', ['TWILIO_PHONE_NUMBER'], 'voice handling'],
  ['Database URL', ['DATABASE_URL'], 'live app persistence'],
  ['Dashboard API key', ['DASHBOARD_API_KEY'], 'operator admin auth'],
];

let missing = 0;
console.log('SMIRK secret inventory');
console.log(`Workspace: ${workspaceRoot}`);
console.log(`Inventory file: ${inventoryPath}${fs.existsSync(inventoryPath) ? '' : ' (will appear after first set-operator-secret run)'}`);
console.log('');
for (const [label, keys, note] of specs) {
  const found = pick(...keys);
  const ok = !!found.value && !looksPlaceholder(found.value);
  if (!ok) missing += 1;
  const tracked = inventory[found.key] || inventory[keys[0]];
  const trackedNote = tracked?.updated_at ? ` | tracked ${tracked.updated_at}` : '';
  console.log(`${ok ? 'OK  ' : 'MISS'} ${label.padEnd(24)} ${String(found.where || 'not found').padEnd(14)} ${note}${trackedNote}`);
}
console.log('');
if (missing > 0) {
  console.log(`FAIL missing or placeholder: ${missing}`);
  process.exit(1);
}
console.log('OK inventory looks complete');
