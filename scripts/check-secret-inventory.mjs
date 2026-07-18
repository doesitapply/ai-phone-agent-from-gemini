#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { railwayVariables } from './railway-json.mjs';
import { evaluateFirstDollarPaymentLinkConfiguration } from './lib/qualifying-revenue-evidence.mjs';
import { evaluateStarterPaymentLinkFulfillmentIds } from '../src/payment-link-fulfillment-ids.js';

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

function readRailwayVariables() {
  try {
    return railwayVariables({ quiet: true });
  } catch {
    return null;
  }
}

const operatorEnv = parseEnvFile(operatorEnvPath);
const smirkEnv = parseEnvFile(smirkEnvPath);
const inventory = fs.existsSync(inventoryPath) ? JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) : {};
const railwayVars = readRailwayVariables();

function pickFromMap(map, where, keys) {
  for (const key of keys) {
    const value = String(map?.[key] || '').trim();
    if (value) return { key, where, value };
  }
  return { key: keys[0], where: null, value: '' };
}

function pickLocal(keys) {
  const fromProcess = pickFromMap(process.env, 'process env', keys);
  if (fromProcess.value) return fromProcess;
  const fromOperator = pickFromMap(operatorEnv, '.env.operator', keys);
  if (fromOperator.value) return fromOperator;
  const fromSmirk = pickFromMap(smirkEnv, '.env.smirk', keys);
  if (fromSmirk.value) return fromSmirk;
  return { key: keys[0], where: null, value: '' };
}

function looksPlaceholder(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return true;
  const exact = new Set([
    'change_me',
    'changeme',
    'replace_me',
    'your_auth_token_here',
    'generate-a-strong-random-key-here',
    'https://buy.stripe.com/...',
    're_...',
    'you@yourdomain.com',
  ]);
  if (exact.has(normalized)) return true;
  return ['your_', 'example.com', 'xxxxx', '...'].some((marker) => normalized.includes(marker));
}

const specs = [
  { label: 'Railway CLI auth', keys: ['RAILWAY_API_TOKEN', 'RAILWAY_TOKEN'], note: 'operator access to read/deploy live config', required: true, live: false },
  { label: 'GitHub push auth', keys: ['GITHUB_TOKEN', 'GITHUB_PAT'], note: 'optional unless git push/auth is needed', required: false, live: false },
  { label: 'Resend API', keys: ['RESEND_API_KEY'], note: 'owner/buyer email alerts', required: true, live: true },
  { label: 'From email', keys: ['FROM_EMAIL'], note: 'verified sender for owner alerts', required: true, live: true },
  { label: 'Stripe enterprise link', keys: ['STRIPE_PAYMENT_LINK_ENTERPRISE'], note: 'disabled until owner-approved hard caps match runtime enforcement', required: false, live: true },
  { label: 'Stripe enterprise link ID', keys: ['STRIPE_PAYMENT_LINK_ENTERPRISE_ID'], note: 'disabled Enterprise exact webhook/product binding', required: false, live: true },
  { label: 'Stripe secret key', keys: ['STRIPE_SECRET_KEY'], note: 'future native Checkout only; disabled and not required for the hosted first-dollar lane', required: false, live: true },
  { label: 'Stripe restricted revenue key', keys: ['STRIPE_REVENUE_READ_KEY'], note: 'read-only Payment Link and settled revenue proof', required: true, live: true },
  { label: 'Stripe restricted billing portal key', keys: ['STRIPE_BILLING_PORTAL_KEY'], note: 'Billing Portal configuration read and tenant session write', required: true, live: true },
  { label: 'Stripe billing portal configuration', keys: ['STRIPE_BILLING_PORTAL_CONFIGURATION_ID'], note: 'exact active live bpc_ configuration', required: true, live: true },
  { label: 'Stripe webhook secret', keys: ['STRIPE_WEBHOOK_SECRET'], note: 'signed paid-checkout fulfillment proof', required: true, live: true },
  { label: 'Auto fulfill flag', keys: ['AUTO_FULFILL_PROVISIONING_REQUESTS'], note: 'explicit concierge vs automatic activation mode', required: true, live: true },
  { label: 'Provisioning secret', keys: ['PHONE_AGENT_PROVISIONING_SECRET'], note: 'landing -> app webhook auth', required: true, live: true },
  { label: 'Landing app URL', keys: ['LANDING_APP_URL'], note: 'post-checkout handoff', required: true, live: true },
  { label: 'App URL', keys: ['APP_URL'], note: 'callback/provisioning links', required: true, live: true },
  { label: 'Setup help link', keys: ['BOOKING_LINK', 'CALENDLY_URL'], note: 'handled setup/fallback help', required: true, live: true },
  { label: 'Google OAuth client', keys: ['GOOGLE_OAUTH_CLIENT_ID'], note: 'workspace login without raw API key', required: true, live: true },
  { label: 'Twilio SID', keys: ['TWILIO_ACCOUNT_SID'], note: 'voice handling and managed line provisioning', required: true, live: true },
  { label: 'Twilio auth token', keys: ['TWILIO_AUTH_TOKEN'], note: 'voice handling and managed line provisioning', required: true, live: true },
  { label: 'Twilio phone number', keys: ['TWILIO_PHONE_NUMBER'], note: 'primary live number', required: true, live: true },
  { label: 'Workspace encryption key', keys: ['WORKSPACE_SECRET_ENCRYPTION_KEY'], note: 'encrypts managed workspace Twilio tokens', required: true, live: true },
  { label: 'OpenRouter streaming AI', keys: ['OPENROUTER_API_KEY'], note: 'actual streaming phone-call AI path', required: true, live: true },
  { label: 'Streaming TTS provider', keys: ['CARTESIA_API_KEY', 'ELEVENLABS_API_KEY', 'GOOGLE_TTS_API_KEY', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'OPENAI_API_KEY'], note: 'premium audio for the streaming phone-call path', required: true, live: true },
  { label: 'Database URL', keys: ['DATABASE_URL'], note: 'live app persistence', required: true, live: true },
  { label: 'Dashboard API key', keys: ['DASHBOARD_API_KEY'], note: 'operator admin auth', required: true, live: true },
];

let requiredMissing = 0;
let optionalMissing = 0;
let localOnlyWarnings = 0;

console.log('SMIRK secret inventory');
console.log(`Workspace: ${workspaceRoot}`);
console.log(`Inventory file: ${inventoryPath}${fs.existsSync(inventoryPath) ? '' : ' (will appear after first set-operator-secret run)'}`);
console.log(`Live Railway variables: ${railwayVars ? 'available' : 'not available'}`);
console.log('');

for (const spec of specs) {
  const local = pickLocal(spec.keys);
  const live = spec.live && railwayVars ? pickFromMap(railwayVars, 'Railway live', spec.keys) : { key: spec.keys[0], where: null, value: '' };
  const localOk = Boolean(local.value) && !looksPlaceholder(local.value);
  const liveOk = Boolean(live.value) && !looksPlaceholder(live.value);
  const ok = spec.live ? (localOk || liveOk) : localOk;
  if (!ok && spec.required) requiredMissing += 1;
  if (!ok && !spec.required) optionalMissing += 1;
  if (spec.live && liveOk && !localOk) localOnlyWarnings += 1;

  const tracked = inventory[local.key] || inventory[live.key] || inventory[spec.keys[0]];
  const trackedNote = tracked?.updated_at ? ` | tracked ${tracked.updated_at}` : '';
  const source = ok
    ? liveOk ? `${live.where}${localOk ? ` + ${local.where}` : ' (local missing)'}`
      : String(local.where)
    : 'not found';
  const status = ok ? (spec.required ? 'OK  ' : 'WARN') : (spec.required ? 'MISS' : 'OPT ');
  console.log(`${status} ${spec.label.padEnd(28)} ${source.padEnd(30)} ${spec.note}${trackedNote}`);
}

const offerSource = railwayVars || Object.fromEntries([
  'STRIPE_PAYMENT_LINK_STARTER',
  'STRIPE_PAYMENT_LINK_STARTER_ID',
  'STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS',
  'STRIPE_PAYMENT_LINK_PRO',
  'STRIPE_PAYMENT_LINK_PRO_ID',
  'STRIPE_PAYMENT_LINK_ENTERPRISE',
  'STRIPE_PAYMENT_LINK_ENTERPRISE_ID',
  'SMIRK_CUSTOMER_POLICY_APPROVED_VERSION',
].map((key) => [key, pickLocal([key]).value]));
const offerConfiguration = evaluateFirstDollarPaymentLinkConfiguration({
  starter: {
    url: offerSource.STRIPE_PAYMENT_LINK_STARTER,
    id: offerSource.STRIPE_PAYMENT_LINK_STARTER_ID,
  },
  pro: {
    url: offerSource.STRIPE_PAYMENT_LINK_PRO,
    id: offerSource.STRIPE_PAYMENT_LINK_PRO_ID,
  },
  enterprise: {
    url: offerSource.STRIPE_PAYMENT_LINK_ENTERPRISE,
    id: offerSource.STRIPE_PAYMENT_LINK_ENTERPRISE_ID,
  },
});
const starterFulfillmentIds = evaluateStarterPaymentLinkFulfillmentIds({
  currentId: offerSource.STRIPE_PAYMENT_LINK_STARTER_ID,
  rawIds: offerSource.STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS,
});
const offerSourceLabel = railwayVars ? 'Railway live' : 'local/operator fallback';
console.log('');
for (const offer of offerConfiguration.offers) {
  const failures = offerConfiguration.failures.filter((failure) => failure.plan === offer.plan);
  const status = !offer.configured ? 'OFF ' : failures.length > 0 ? 'MISS' : 'OK  ';
  const note = !offer.configured
    ? (offer.plan === 'starter'
      ? 'required exact $197/month URL + plink_ ID pair is not configured'
      : 'disabled as required during the Starter-only first-dollar launch')
    : failures.length > 0
      ? failures.map((failure) => failure.message).join('; ')
      : 'exact Starter $197/month URL + plink_ ID pair; live provider verification is a separate gate';
  console.log(`${status} ${`Stripe ${offer.plan} offer`.padEnd(28)} ${offerSourceLabel.padEnd(30)} ${note}`);
}
const starterOfferFailure = offerConfiguration.failures.find((failure) => failure.code === 'starter-payment-link-offer-missing');
if (starterOfferFailure) console.log(`MISS ${'Stripe Starter offer'.padEnd(28)} ${offerSourceLabel.padEnd(30)} ${starterOfferFailure.message}`);
if (!offerConfiguration.ok) requiredMissing += 1;
const fulfillmentStatus = starterFulfillmentIds.ready ? 'OK  ' : 'MISS';
const fulfillmentNote = starterFulfillmentIds.ready
  ? `${starterFulfillmentIds.ids.length} exact current/historical ID(s); provider inactivity proof is a separate gate`
  : starterFulfillmentIds.blockers.join('; ');
console.log(`${fulfillmentStatus} ${'Starter fulfillment IDs'.padEnd(28)} ${offerSourceLabel.padEnd(30)} ${fulfillmentNote}`);
if (!starterFulfillmentIds.ready) requiredMissing += 1;

console.log('');
if (localOnlyWarnings > 0) {
  console.log(`NOTE ${localOnlyWarnings} required value(s) are present in live Railway but missing from local/operator files. That is not a production blocker.`);
}
if (optionalMissing > 0) {
  console.log(`NOTE optional missing or placeholder: ${optionalMissing}`);
}
if (requiredMissing > 0) {
  console.log(`FAIL required missing or placeholder across usable sources: ${requiredMissing}`);
  process.exit(1);
}
console.log('OK required secret inventory is covered by local/operator files or live Railway variables');
