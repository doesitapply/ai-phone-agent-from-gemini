#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { evaluateCanonicalMailboxAliases, normalizeStrictMailbox } from '../src/email-safety.js';
import { CUSTOMER_POLICY_APPROVAL_MANIFEST, evaluateCustomerPolicyApproval } from '../src/customer-policy-approval.js';
import { evaluateFirstDollarVoiceReadiness } from '../src/first-dollar-voice-readiness.js';
import { evaluateFirstDollarPaymentLinkConfiguration } from './lib/qualifying-revenue-evidence.mjs';
import { evaluateStarterPaymentLinkFulfillmentIds } from '../src/payment-link-fulfillment-ids.js';

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
const voiceReadiness = evaluateFirstDollarVoiceReadiness({ ...fileEnv, ...process.env });
const resolvedEnv = { ...fileEnv, ...process.env };
const OPERATOR_ALERT_ALIAS_KEYS = Object.freeze(['NOTIFICATION_EMAIL', 'OWNER_ALERT_EMAIL', 'OWNER_EMAIL', 'OPERATOR_EMAIL']);
const customerPolicyVersion = pick('SMIRK_CUSTOMER_POLICY_APPROVED_VERSION');
const customerPolicyApproval = evaluateCustomerPolicyApproval(customerPolicyVersion);
const paymentLinkConfiguration = evaluateFirstDollarPaymentLinkConfiguration({
  starter: { url: pick('STRIPE_PAYMENT_LINK_STARTER'), id: pick('STRIPE_PAYMENT_LINK_STARTER_ID') },
  pro: { url: pick('STRIPE_PAYMENT_LINK_PRO'), id: pick('STRIPE_PAYMENT_LINK_PRO_ID') },
  enterprise: { url: pick('STRIPE_PAYMENT_LINK_ENTERPRISE'), id: pick('STRIPE_PAYMENT_LINK_ENTERPRISE_ID') },
}, { enterpriseUsageReady: customerPolicyApproval.enterpriseUsageReady });
const starterFulfillmentIds = evaluateStarterPaymentLinkFulfillmentIds({
  currentId: pick('STRIPE_PAYMENT_LINK_STARTER_ID'),
  rawIds: pick('STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS'),
});
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
  if (label === 'SMIRK_CUSTOMER_POLICY_APPROVED_VERSION') {
    const policy = evaluateCustomerPolicyApproval(normalized);
    if (!policy.coreReady) return policy.coreBlockers[0]?.message || 'checked-in core customer policy owner approval is incomplete';
  }
  if (!normalized) return null;
  if (label === 'APP_URL' && !/^https:\/\/(?:ai-phone-agent-production-6811\.up\.railway\.app|(?:www\.)?smirkcalls\.com)\/?$/i.test(normalized)) {
    return 'must be an exact allowlisted SMIRK production HTTPS origin with no path, query, credentials, or custom port';
  }
  if (label === 'LANDING_APP_URL') {
    if (/manus\.space/i.test(normalized)) return 'must point at the production marketing domain, not manus.space';
    if (!/^https:\/\/smirkcalls\.com\/?$/i.test(normalized)) return 'must be exactly https://smirkcalls.com';
  }
  if (label === 'AUTO_FULFILL_PROVISIONING_REQUESTS' && normalized !== 'true') {
    return 'must be exactly true so a paid checkout cannot stop at an unstaffed manual fallback';
  }
  if (label.startsWith('STRIPE_PAYMENT_LINK_') && label.endsWith('_ID') && !/^plink_[A-Za-z0-9_]+$/.test(normalized)) {
    return 'must be the exact live plink_ ID, not the public buy.stripe.com URL';
  }
  if (label === 'STRIPE_REVENUE_READ_KEY' && !/^rk_live_[A-Za-z0-9_]+$/.test(normalized)) {
    return 'must be a dedicated live restricted key with the required read-only Stripe permissions';
  }
  if (label === 'STRIPE_BILLING_PORTAL_KEY' && !/^rk_live_[A-Za-z0-9_]+$/.test(normalized)) {
    return 'must be a dedicated live restricted key with Billing Portal configuration read and session write access';
  }
  if (label === 'STRIPE_BILLING_PORTAL_CONFIGURATION_ID' && !/^bpc_[A-Za-z0-9_]+$/.test(normalized)) {
    return 'must be the exact active live Billing Portal configuration ID beginning with bpc_';
  }
  if (label === 'FROM_EMAIL' && !normalizeStrictMailbox(normalized)) {
    return 'must contain one strict non-placeholder sender mailbox';
  }
  if (label === 'operator alert recipient aliases') {
    const aliases = evaluateCanonicalMailboxAliases(resolvedEnv, OPERATOR_ALERT_ALIAS_KEYS);
    if (!aliases.ready) return aliases.blockers.join('; ');
  }
  if (label === 'TWILIO_ACCOUNT_SID' && !voiceReadiness.parentAccountSidReady) return 'must be the exact parent-account AC... SID used for managed workspace provisioning';
  if (label === 'TWILIO_AUTH_TOKEN' && !voiceReadiness.parentAuthTokenReady) return 'must be the non-placeholder parent-account provisioning token';
  if (label === 'WORKSPACE_SECRET_ENCRYPTION_KEY' && !voiceReadiness.workspaceSecretEncryptionReady) return 'must be a dedicated secret of at least 32 characters';
  if (label === 'OPENROUTER_API_KEY' && !voiceReadiness.openRouterKeyReady) return 'must be a non-placeholder sk-or-... key for streaming phone-call AI';
  if (label === 'OPENROUTER_ENABLED' && !voiceReadiness.openRouterEnabled) return 'must be exactly true';
  if (label === 'FAST_LIVE_CALLS' && !voiceReadiness.streamingPathEnabled) return 'must be exactly false because true bypasses streamingTtsPipeline';
  if (label === 'streaming TTS provider' && !voiceReadiness.streamingTtsReady) return 'requires at least one enabled Cartesia, ElevenLabs, Google TTS, or OpenAI TTS credential';
  return null;
};

const requiredSpecs = [
  ['APP_URL', ['APP_URL'], 'public app base URL used in checkout and callback links', 'APP_URL="https://ai-phone-agent-production-6811.up.railway.app"'],
  ['LANDING_APP_URL', ['LANDING_APP_URL'], 'landing app base URL for provisioning-complete proof webhooks', 'LANDING_APP_URL="https://smirkcalls.com"'],
  ['PHONE_AGENT_PROVISIONING_SECRET', ['PHONE_AGENT_PROVISIONING_SECRET'], 'server-to-server secret shared with the landing app webhook', 'PHONE_AGENT_PROVISIONING_SECRET="change_me_to_a_unique_secret"'],
  ['STRIPE_REVENUE_READ_KEY', ['STRIPE_REVENUE_READ_KEY'], 'read-only Payment Link and settled-revenue verification', 'STRIPE_REVENUE_READ_KEY="rk_live_..."'],
  ['STRIPE_BILLING_PORTAL_KEY', ['STRIPE_BILLING_PORTAL_KEY'], 'dedicated authenticated Billing Portal configuration/session access', 'STRIPE_BILLING_PORTAL_KEY="rk_live_..."'],
  ['STRIPE_BILLING_PORTAL_CONFIGURATION_ID', ['STRIPE_BILLING_PORTAL_CONFIGURATION_ID'], 'exact active live Billing Portal configuration', 'STRIPE_BILLING_PORTAL_CONFIGURATION_ID="bpc_..."'],
  ['STRIPE_WEBHOOK_SECRET', ['STRIPE_WEBHOOK_SECRET'], 'signed Stripe checkout fulfillment', 'STRIPE_WEBHOOK_SECRET="whsec_..."'],
  ['DATABASE_URL', ['DATABASE_URL'], 'durable workspace/provisioning persistence', 'DATABASE_URL="postgresql://..."'],
  ['AUTO_FULFILL_PROVISIONING_REQUESTS', ['AUTO_FULFILL_PROVISIONING_REQUESTS'], 'automatic paid-buyer activation', 'AUTO_FULFILL_PROVISIONING_REQUESTS="true"'],
  ['SMIRK_CUSTOMER_POLICY_APPROVED_VERSION', ['SMIRK_CUSTOMER_POLICY_APPROVED_VERSION'], 'exact match for the checked-in owner-approved manifest; an env value alone cannot approve policy', CUSTOMER_POLICY_APPROVAL_MANIFEST.approvalState === 'approved' && CUSTOMER_POLICY_APPROVAL_MANIFEST.policyVersion ? `SMIRK_CUSTOMER_POLICY_APPROVED_VERSION="${CUSTOMER_POLICY_APPROVAL_MANIFEST.policyVersion}"` : null],
  ['RESEND_API_KEY', ['RESEND_API_KEY'], 'owner email alert delivery', 'RESEND_API_KEY="re_..."'],
  ['FROM_EMAIL', ['FROM_EMAIL'], 'sender address for owner alerts', 'FROM_EMAIL="SMIRK <alerts@smirkcalls.com>"'],
  ['operator alert recipient aliases', OPERATOR_ALERT_ALIAS_KEYS, 'all four aliases must equal one reviewed mailbox for paid-buyer lifecycle alerts', 'NOTIFICATION_EMAIL="operator@smirkcalls.com" OWNER_ALERT_EMAIL="operator@smirkcalls.com" OWNER_EMAIL="operator@smirkcalls.com" OPERATOR_EMAIL="operator@smirkcalls.com"'],
  ['BOOKING_LINK or CALENDLY_URL', ['BOOKING_LINK', 'CALENDLY_URL'], 'handled setup-help fallback link', 'BOOKING_LINK="https://calendly.com/smirkcalls/smirk-setup"'],
  ['TWILIO_ACCOUNT_SID', ['TWILIO_ACCOUNT_SID'], 'parent account for managed customer subaccount provisioning', 'TWILIO_ACCOUNT_SID="AC..."'],
  ['TWILIO_AUTH_TOKEN', ['TWILIO_AUTH_TOKEN'], 'parent credential for managed customer subaccount provisioning', 'TWILIO_AUTH_TOKEN="replace_with_parent_token"'],
  ['WORKSPACE_SECRET_ENCRYPTION_KEY', ['WORKSPACE_SECRET_ENCRYPTION_KEY'], 'dedicated encryption key for customer subaccount tokens', 'WORKSPACE_SECRET_ENCRYPTION_KEY="replace_with_32_or_more_random_characters"'],
  ['OPENROUTER_API_KEY', ['OPENROUTER_API_KEY'], 'streaming phone-call AI provider', 'OPENROUTER_API_KEY="sk-or-v1-..."'],
  ['OPENROUTER_ENABLED', ['OPENROUTER_ENABLED'], 'enables the runtime streaming AI provider', 'OPENROUTER_ENABLED="true"'],
  ['FAST_LIVE_CALLS', ['FAST_LIVE_CALLS'], 'selects the actual streamingTtsPipeline call path', 'FAST_LIVE_CALLS="false"'],
  ['streaming TTS provider', ['CARTESIA_API_KEY', 'ELEVENLABS_API_KEY', 'GOOGLE_TTS_API_KEY', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'OPENAI_API_KEY'], 'premium synthesis for the streaming call path', 'CARTESIA_API_KEY="replace_with_tts_key"'],
];

const required = requiredSpecs.map(([label, keys, note]) => [label, keys.map(pick).find((value) => String(value || '').trim().length > 0) || '', note]);

const optional = [
  ['PHONE_AGENT_API_KEY', pick('PHONE_AGENT_API_KEY'), 'live /api/demo submissions from landing or demo tools'],
  ['TWILIO_PHONE_NUMBER', pick('TWILIO_PHONE_NUMBER'), 'voice handling'],
];

let missing = 0;
const row = (name, value, note) => {
  const ok = isConfigured(value);
  const customIssue = ok || name === 'SMIRK_CUSTOMER_POLICY_APPROVED_VERSION' ? customValidation(name, value) : null;
  if (!ok || customIssue) missing += 1;
  return `${ok && !customIssue ? 'OK  ' : 'MISS'} ${name.padEnd(34)} ${note}${customIssue ? ` — ${customIssue}` : ''}`;
};

console.log('SMIRK first-dollar env readiness');
if (loadedEnvFiles.length) console.log(`Env files checked: ${loadedEnvFiles.join(', ')}`);
console.log('Required for paid signup + activation proof:\n');
for (const [name, value, note] of required) console.log(row(name, value, note));

const revenueRestrictedKey = pick('STRIPE_REVENUE_READ_KEY');
const portalRestrictedKey = pick('STRIPE_BILLING_PORTAL_KEY');
if (revenueRestrictedKey && portalRestrictedKey && revenueRestrictedKey === portalRestrictedKey) {
  missing += 1;
  console.log(`MISS ${'Stripe restricted-key separation'.padEnd(34)} revenue verification and Billing Portal require distinct rk_live_ credentials`);
} else {
  console.log(`OK   ${'Stripe restricted-key separation'.padEnd(34)} revenue and portal credentials are distinct`);
}
const nativeCheckoutFlag = pick('SMIRK_NATIVE_CHECKOUT_ENABLED');
const nativeCheckoutDisabled = nativeCheckoutFlag === 'false';
if (!nativeCheckoutDisabled) missing += 1;
console.log(`${nativeCheckoutDisabled ? 'OK  ' : 'MISS'} ${'native Stripe Checkout'.padEnd(34)} ${nativeCheckoutDisabled ? 'explicitly disabled; the reviewed Starter Payment Link is the only checkout lane' : 'must be exactly false for the Starter Payment-Link-only launch'}`);
if (!starterFulfillmentIds.ready) missing += 1;
console.log(`${starterFulfillmentIds.ready ? 'OK  ' : 'MISS'} ${'Starter fulfillment Payment Link IDs'.padEnd(34)} ${starterFulfillmentIds.ready ? `${starterFulfillmentIds.ids.length} exact current/historical ID(s); current Starter included` : starterFulfillmentIds.blockers.join(', ')}`);

console.log('\nStarter-only Stripe offer configuration:\n');
for (const offer of paymentLinkConfiguration.offers) {
  const failures = paymentLinkConfiguration.failures.filter((failure) => failure.plan === offer.plan);
  const status = !offer.configured ? 'OFF ' : failures.length > 0 ? 'MISS' : 'OK  ';
  const note = !offer.configured
    ? (offer.plan === 'starter'
      ? 'required exact $197/month URL + plink_ ID pair is not configured'
      : 'disabled as required during the Starter-only first-dollar launch')
    : failures.length > 0
      ? failures.map((failure) => failure.message).join('; ')
      : 'exact Starter $197/month URL + plink_ ID pair is configured';
  console.log(`${status} ${`${offer.plan} offer`.padEnd(34)} ${note}`);
}
const starterOfferFailure = paymentLinkConfiguration.failures.find((failure) => failure.code === 'starter-payment-link-offer-missing');
if (starterOfferFailure) console.log(`MISS ${'Starter offer requirement'.padEnd(34)} ${starterOfferFailure.message}`);
missing += paymentLinkConfiguration.failures.length;

console.log('\nOptional but important:\n');
for (const [name, value, note] of optional) {
  const ok = isConfigured(value);
  console.log(`${ok ? 'OK  ' : 'WARN'} ${name.padEnd(34)} ${note}`);
}

if (missing > 0) {
  if (process.env.ENV_FILE) {
    const suggested = requiredSpecs
      .filter(([, keys]) => !keys.some((key) => hasFileKey(key) && isConfigured(fileEnv[key])))
      .map(([, , , example]) => example)
      .filter(Boolean);
    if (suggested.length) {
      console.log('\nSuggested additions for the env file:\n');
      for (const line of suggested) console.log(line);
    }
    if (!paymentLinkConfiguration.ok) {
      console.log('\nConfigure the exact Starter pair and keep every broader checkout lane empty:\n');
      console.log('STRIPE_PAYMENT_LINK_STARTER="https://buy.stripe.com/..."');
      console.log('STRIPE_PAYMENT_LINK_STARTER_ID="plink_..."');
      console.log('STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS="plink_current,...optional_inactive_prior_ids"');
      console.log('STRIPE_PAYMENT_LINK_PRO=""');
      console.log('STRIPE_PAYMENT_LINK_PRO_ID=""');
      console.log('STRIPE_PAYMENT_LINK_ENTERPRISE=""');
      console.log('STRIPE_PAYMENT_LINK_ENTERPRISE_ID=""');
    }
  }
  console.error(`\nFAIL missing ${missing} required env value(s) for first-dollar readiness`);
  if (CUSTOMER_POLICY_APPROVAL_MANIFEST.approvalState !== 'approved') {
    console.error('Customer policy is intentionally NOT APPROVED in src/customer-policy-approval.js. Complete owner and qualified review plus publication proof; do not invent an env version.');
  }
  console.error('This checked local/runtime env only. To verify deployed buyer readiness, run: npm run -s check:railway:first-dollar-env');
  process.exit(1);
}

console.log('\nOK required first-dollar env values are present');
