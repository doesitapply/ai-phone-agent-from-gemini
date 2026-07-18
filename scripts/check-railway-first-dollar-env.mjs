#!/usr/bin/env node
import { railwayVariables } from './railway-json.mjs';
import Stripe from 'stripe';
import { normalizeStrictMailbox, parseStrictMailboxList } from '../src/email-safety.js';
import { evaluateCustomerPolicyApproval, verifyPublishedCustomerPolicyDocumentsForPlan } from '../src/customer-policy-approval.js';
import { evaluateFirstDollarVoiceReadiness } from '../src/first-dollar-voice-readiness.js';
import { verifyBillingPortalConfiguration } from '../src/stripe-billing-portal.js';
import {
  CANONICAL_REVENUE_SUCCESS_URL,
  evaluateFirstDollarPaymentLinkConfiguration,
  verifyCanonicalRevenuePaymentLinks,
} from './lib/qualifying-revenue-evidence.mjs';
const REQUIRED_WEBHOOK_EVENTS = Object.freeze([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
  'payment_link.updated',
]);

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
  if (label.startsWith('STRIPE_PAYMENT_LINK_') && label.endsWith('_ID') && !/^plink_[A-Za-z0-9_]+$/.test(normalized)) {
    return 'must be the exact live plink_ ID, not the public buy.stripe.com URL';
  }
  if (label === 'AUTO_FULFILL_PROVISIONING_REQUESTS' && normalized !== 'true') {
    return 'must be exactly true so a paid checkout cannot stop at an unstaffed manual fallback';
  }
  if (label === 'STRIPE_REVENUE_READ_KEY' && !/^rk_live_[A-Za-z0-9_]+$/.test(normalized)) {
    return 'must be a dedicated live restricted key so Payment Links and settled revenue can be verified read-only';
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
  if (label === 'operator alert recipient' && parseStrictMailboxList(normalized).length === 0) {
    return 'must contain at least one valid operator email address';
  }
  if (label === 'TWILIO_ACCOUNT_SID' && !voiceReadiness.parentAccountSidReady) return 'must be the exact parent-account AC... SID used for managed workspace provisioning';
  if (label === 'TWILIO_AUTH_TOKEN' && !voiceReadiness.parentAuthTokenReady) return 'must be the non-placeholder parent-account provisioning token';
  if (label === 'WORKSPACE_SECRET_ENCRYPTION_KEY' && !voiceReadiness.workspaceSecretEncryptionReady) return 'must be a dedicated secret of at least 32 characters';
  if (label === 'OPENROUTER_API_KEY' && !voiceReadiness.openRouterKeyReady) return 'must be a non-placeholder sk-or-... key for streaming phone-call AI';
  if (label === 'OPENROUTER_ENABLED' && !voiceReadiness.openRouterEnabled) return 'must be exactly true';
  if (label === 'FAST_LIVE_CALLS' && !voiceReadiness.streamingPathEnabled) return 'must be exactly false because true bypasses streamingTtsPipeline';
  if (label === 'streaming TTS provider' && !voiceReadiness.streamingTtsReady) return 'requires at least one enabled Cartesia, ElevenLabs, Google TTS, or OpenAI TTS credential';
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
const voiceReadiness = evaluateFirstDollarVoiceReadiness(vars);
const customerPolicyVersion = pick(['SMIRK_CUSTOMER_POLICY_APPROVED_VERSION']);
const customerPolicyApproval = evaluateCustomerPolicyApproval(customerPolicyVersion);
const paymentLinkConfiguration = evaluateFirstDollarPaymentLinkConfiguration({
  starter: {
    url: pick(['STRIPE_PAYMENT_LINK_STARTER']),
    id: pick(['STRIPE_PAYMENT_LINK_STARTER_ID']),
  },
  pro: {
    url: pick(['STRIPE_PAYMENT_LINK_PRO']),
    id: pick(['STRIPE_PAYMENT_LINK_PRO_ID']),
  },
  enterprise: {
    url: pick(['STRIPE_PAYMENT_LINK_ENTERPRISE']),
    id: pick(['STRIPE_PAYMENT_LINK_ENTERPRISE_ID']),
  },
}, { enterpriseUsageReady: customerPolicyApproval.enterpriseUsageReady });

const requiredSpecs = [
  ['APP_URL', ['APP_URL'], 'public app base URL used in checkout and callback links'],
  ['LANDING_APP_URL', ['LANDING_APP_URL'], 'landing app base URL for provisioning-complete proof webhooks'],
  ['PHONE_AGENT_PROVISIONING_SECRET', ['PHONE_AGENT_PROVISIONING_SECRET'], 'server-to-server secret shared with the landing app webhook'],
  ['STRIPE_REVENUE_READ_KEY', ['STRIPE_REVENUE_READ_KEY'], 'read-only verification of live Payment Links and settled revenue'],
  ['STRIPE_BILLING_PORTAL_KEY', ['STRIPE_BILLING_PORTAL_KEY'], 'dedicated authenticated Billing Portal configuration/session access'],
  ['STRIPE_BILLING_PORTAL_CONFIGURATION_ID', ['STRIPE_BILLING_PORTAL_CONFIGURATION_ID'], 'exact active live Billing Portal configuration'],
  ['STRIPE_WEBHOOK_SECRET', ['STRIPE_WEBHOOK_SECRET'], 'signed Stripe checkout fulfillment'],
  ['DATABASE_URL', ['DATABASE_URL'], 'durable workspace/provisioning persistence'],
  ['AUTO_FULFILL_PROVISIONING_REQUESTS', ['AUTO_FULFILL_PROVISIONING_REQUESTS'], 'automatic paid-buyer activation'],
  ['SMIRK_CUSTOMER_POLICY_APPROVED_VERSION', ['SMIRK_CUSTOMER_POLICY_APPROVED_VERSION'], 'explicit business-owner approval marker for the published customer policy set'],
  ['RESEND_API_KEY', ['RESEND_API_KEY'], 'owner email alert delivery'],
  ['FROM_EMAIL', ['FROM_EMAIL'], 'sender address for owner alerts'],
  ['operator alert recipient', ['NOTIFICATION_EMAIL', 'OWNER_ALERT_EMAIL', 'OWNER_EMAIL', 'OPERATOR_EMAIL'], 'recipient for paid-buyer lifecycle alerts'],
  ['BOOKING_LINK or CALENDLY_URL', ['BOOKING_LINK', 'CALENDLY_URL'], 'handled setup-help fallback link'],
  ['GOOGLE_OAUTH_CLIENT_ID', ['GOOGLE_OAUTH_CLIENT_ID'], 'workspace users can sign in without needing a workspace API key'],
  ['TWILIO_ACCOUNT_SID', ['TWILIO_ACCOUNT_SID'], 'parent account for managed customer subaccount provisioning'],
  ['TWILIO_AUTH_TOKEN', ['TWILIO_AUTH_TOKEN'], 'parent credential for managed customer subaccount provisioning'],
  ['WORKSPACE_SECRET_ENCRYPTION_KEY', ['WORKSPACE_SECRET_ENCRYPTION_KEY'], 'dedicated encryption key for customer subaccount tokens'],
  ['OPENROUTER_API_KEY', ['OPENROUTER_API_KEY'], 'streaming phone-call AI provider'],
  ['OPENROUTER_ENABLED', ['OPENROUTER_ENABLED'], 'enables the runtime streaming AI provider'],
  ['FAST_LIVE_CALLS', ['FAST_LIVE_CALLS'], 'selects the actual streamingTtsPipeline call path'],
  ['streaming TTS provider', ['CARTESIA_API_KEY', 'ELEVENLABS_API_KEY', 'GOOGLE_TTS_API_KEY', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'OPENAI_API_KEY'], 'premium synthesis for the streaming call path'],
];

const optionalSpecs = [
  ['PHONE_AGENT_API_KEY', ['PHONE_AGENT_API_KEY'], 'live /api/demo submissions from landing or demo tools'],
  ['DASHBOARD_API_KEY', ['DASHBOARD_API_KEY'], 'live operator admin profile + authenticated dashboard operator access'],
  ['GOOGLE_ADMIN_EMAILS', ['GOOGLE_ADMIN_EMAILS'], 'optional allowlist for admin/operator Google sign-in when DASHBOARD_API_KEY is set'],
  ['TWILIO_PHONE_NUMBER', ['TWILIO_PHONE_NUMBER'], 'voice handling'],
];

let missing = 0;
let placeholder = 0;
const missingLabels = [];
const placeholderLabels = [];
const row = (label, value, note) => {
  const present = String(value || '').trim().length > 0;
  const configured = present && !looksPlaceholder(value);
  const customIssue = configured || label === 'SMIRK_CUSTOMER_POLICY_APPROVED_VERSION' ? customValidation(label, value) : null;
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

const revenueRestrictedKey = pick(['STRIPE_REVENUE_READ_KEY']);
const portalRestrictedKey = pick(['STRIPE_BILLING_PORTAL_KEY']);
if (revenueRestrictedKey && portalRestrictedKey && revenueRestrictedKey === portalRestrictedKey) {
  placeholder += 1;
  placeholderLabels.push('Stripe restricted-key separation');
  console.log(`WARN ${'Stripe restricted-key separation'.padEnd(34)} revenue verification and Billing Portal require distinct rk_live_ credentials`);
} else {
  console.log(`OK   ${'Stripe restricted-key separation'.padEnd(34)} revenue and portal credentials are distinct`);
}
const nativeCheckoutFlag = pick(['SMIRK_NATIVE_CHECKOUT_ENABLED']);
const nativeCheckoutFlagValid = !nativeCheckoutFlag || nativeCheckoutFlag === 'true' || nativeCheckoutFlag === 'false';
const nativeStripeKey = pick(['STRIPE_SECRET_KEY']);
const nativeStripeKeyReady = /^sk_live_[A-Za-z0-9_]{16,}$/.test(nativeStripeKey) && !looksPlaceholder(nativeStripeKey);
if (!nativeCheckoutFlagValid || (nativeCheckoutFlag === 'true' && !nativeStripeKeyReady)) {
  placeholder += 1;
  placeholderLabels.push('native Stripe Checkout');
}
console.log(`${nativeCheckoutFlagValid && (nativeCheckoutFlag !== 'true' || nativeStripeKeyReady) ? 'OK  ' : 'WARN'} ${'native Stripe Checkout'.padEnd(34)} ${nativeCheckoutFlag === 'true' ? 'explicitly enabled with a non-placeholder live key' : 'disabled by default; Payment Link readiness remains independent'}`);

console.log('\nPlan-aware Stripe offer configuration:\n');
for (const offer of paymentLinkConfiguration.offers) {
  const failures = paymentLinkConfiguration.failures.filter((failure) => failure.plan === offer.plan);
  if (!offer.configured) {
    const note = offer.plan === 'enterprise'
      ? 'disabled; requires separate owner-approved hard caps and enabled matching runtime enforcement'
      : 'not enabled; the other core offer may satisfy first-dollar readiness';
    console.log(`OFF  ${`${offer.plan} offer`.padEnd(34)} ${note}`);
  } else if (failures.length > 0) {
    console.log(`WARN ${`${offer.plan} offer`.padEnd(34)} ${failures.map((failure) => failure.message).join('; ')}`);
  } else {
    console.log(`OK   ${`${offer.plan} offer`.padEnd(34)} complete URL + exact plink_ ID pair; provider verification follows`);
  }
}
for (const failure of paymentLinkConfiguration.failures) {
  const label = failure.code;
  if (failure.kind === 'missing') {
    missing += 1;
    missingLabels.push(label);
  } else {
    placeholder += 1;
    placeholderLabels.push(label);
  }
  if (failure.plan === 'core') console.log(`MISS ${'core offer requirement'.padEnd(34)} ${failure.message}`);
}
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

if (missing > 0 || placeholder > 0) {
  console.error(`\nFAIL live Railway env has ${missing} missing and ${placeholder} placeholder required value(s)`);
  if (missingLabels.length) console.error(`Missing: ${missingLabels.join(', ')}`);
  if (placeholderLabels.length) console.error(`Placeholder/needs replacement: ${placeholderLabels.join(', ')}`);

  const needsFastPath = !paymentLinkConfiguration.ok || ['STRIPE_REVENUE_READ_KEY', 'STRIPE_BILLING_PORTAL_KEY', 'STRIPE_BILLING_PORTAL_CONFIGURATION_ID', 'SMIRK_CUSTOMER_POLICY_APPROVED_VERSION', 'FROM_EMAIL', 'operator alert recipient', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'WORKSPACE_SECRET_ENCRYPTION_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_ENABLED', 'FAST_LIVE_CALLS', 'streaming TTS provider']
    .some((label) => missingLabels.includes(label) || placeholderLabels.includes(label));

  if (needsFastPath || placeholderLabels.includes('LANDING_APP_URL') || missingLabels.includes('LANDING_APP_URL') || missingLabels.includes('GOOGLE_OAUTH_CLIENT_ID') || placeholderLabels.includes('GOOGLE_OAUTH_CLIENT_ID')) {
    console.error('\nFast path to fix the live blocker:');
    console.error('  # Configure at least one complete core pair; omit the other pair entirely unless it is also enabled:');
    console.error("  STRIPE_PAYMENT_LINK_STARTER=\"https://buy.stripe.com/...\" \\");
    console.error("  STRIPE_PAYMENT_LINK_STARTER_ID=\"plink_...\" \\");
    console.error('  # OR:');
    console.error("  STRIPE_PAYMENT_LINK_PRO=\"https://buy.stripe.com/...\" \\");
    console.error("  STRIPE_PAYMENT_LINK_PRO_ID=\"plink_...\" \\");
    console.error("  STRIPE_REVENUE_READ_KEY=\"rk_live_...\" \\");
    console.error("  STRIPE_BILLING_PORTAL_KEY=\"rk_live_...\" \\");
    console.error("  STRIPE_BILLING_PORTAL_CONFIGURATION_ID=\"bpc_...\" \\");
    console.error("  AUTO_FULFILL_PROVISIONING_REQUESTS=\"true\" \\");
    console.error("  RESEND_API_KEY=\"re_...\" \\");
    console.error("  FROM_EMAIL=\"SMIRK <alerts@smirkcalls.com>\" \\");
    console.error("  NOTIFICATION_EMAIL=\"operator@smirkcalls.com\" \\");
    console.error("  LANDING_APP_URL=\"https://smirkcalls.com\" \\");
    console.error("  GOOGLE_OAUTH_CLIENT_ID=\"your-google-web-client-id.apps.googleusercontent.com\" \\");
    console.error("  TWILIO_ACCOUNT_SID=\"AC...\" \\");
    console.error("  TWILIO_AUTH_TOKEN=\"your-parent-auth-token\" \\");
    console.error("  WORKSPACE_SECRET_ENCRYPTION_KEY=\"32-or-more-random-characters\" \\");
    console.error("  OPENROUTER_API_KEY=\"sk-or-v1-...\" \\");
    console.error("  OPENROUTER_ENABLED=\"true\" \\");
    console.error("  FAST_LIVE_CALLS=\"false\" \\");
    console.error("  CARTESIA_API_KEY=\"your-streaming-tts-key\" \\");
    console.error('  npm run set:first-dollar-live-env');
    if (missingLabels.includes('SMIRK_CUSTOMER_POLICY_APPROVED_VERSION') || placeholderLabels.includes('SMIRK_CUSTOMER_POLICY_APPROVED_VERSION')) {
      console.error('  # The environment value is insufficient by itself: first record explicit owner approval, matching versions, and live policy URLs in src/customer-policy-approval.js.');
      console.error('  # Only then export SMIRK_CUSTOMER_POLICY_APPROVED_VERSION with that exact checked-in version before running the setter.');
      console.error('  # Do not mark that manifest approved until the owner and qualified reviewer have completed the policy decisions.');
    }
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

const stripeReadKey = pick(['STRIPE_REVENUE_READ_KEY']);
const stripePortalKey = pick(['STRIPE_BILLING_PORTAL_KEY']);
const stripePortalConfigurationId = pick(['STRIPE_BILLING_PORTAL_CONFIGURATION_ID']);
const publishedPolicyProof = await verifyPublishedCustomerPolicyDocumentsForPlan(customerPolicyVersion, 'starter');
if (!publishedPolicyProof.ok) {
  console.error('\nFAIL owner-approved customer policy publication proof');
  for (const failure of publishedPolicyProof.failures) console.error(`- ${failure}`);
  console.error('Complete the checked-in core approval manifest only after owner/legal review, publish all six core policy URLs, and rerun this check. Enterprise remains separately disabled until its caps are approved.');
  process.exit(1);
}
console.log('OK   owner-approved core customer policy manifest and six required public policy documents are live');
if (paymentLinkConfiguration.enterpriseEnabled) {
  const publishedEnterprisePolicyProof = await verifyPublishedCustomerPolicyDocumentsForPlan(customerPolicyVersion, 'enterprise');
  if (!publishedEnterprisePolicyProof.ok) {
    console.error('\nFAIL owner-approved Enterprise policy publication proof');
    for (const failure of publishedEnterprisePolicyProof.failures) console.error(`- ${failure}`);
    console.error('Disable the Enterprise Payment Link pair or complete its separate owner approval, exact runtime hard caps, and public policy publication.');
    process.exit(1);
  }
  console.log('OK   separately approved Enterprise usage policy and exact public document are live');
} else {
  console.log('OK   Enterprise checkout remains disabled pending separate owner-approved hard caps');
}
const stripe = new Stripe(stripeReadKey, { apiVersion: '2026-04-22.dahlia', maxNetworkRetries: 2, timeout: 15_000 });
const stripePortal = new Stripe(stripePortalKey, { maxNetworkRetries: 2, timeout: 15_000 });
const canonicalWebhookUrl = `${new URL(pick(['APP_URL'])).origin}/api/stripe/webhook`;

try {
  const portalProof = await verifyBillingPortalConfiguration({
    restrictedKey: stripePortalKey,
    revenueRestrictedKey: stripeReadKey,
    configurationId: stripePortalConfigurationId,
    policyBinding: {
      termsUrl: customerPolicyApproval.documentUrls.terms,
      privacyUrl: customerPolicyApproval.documentUrls.privacy,
      cancellationMode: customerPolicyApproval.billingPolicy.cancellationMode,
      cancellationProrationBehavior: customerPolicyApproval.billingPolicy.cancellationProrationBehavior,
    },
    retrieveConfiguration: async (configurationId) => stripePortal.billingPortal.configurations.retrieve(configurationId),
  });
  if (!portalProof.ready) throw new Error(`portal-configuration-failed:${portalProof.blockers.join(',')}`);
  console.log('OK   Stripe Billing Portal exact live configuration matches approved Terms, Privacy, cancellation, and proration policy');
} catch (error) {
  console.error('\nFAIL live Stripe Billing Portal configuration verification');
  console.error(`Expected exact active live configuration: ${stripePortalConfigurationId}`);
  console.error(`Provider result: ${String(error?.code || error?.type || error?.message || error)}`);
  console.error('The dedicated portal key must be distinct from the revenue-read key and the exact live configuration must match approved policy URLs and cancellation behavior.');
  process.exit(1);
}

try {
  const endpoints = [];
  let startingAfter;
  do {
    const page = await stripe.webhookEndpoints.list({ limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    endpoints.push(...page.data);
    if (!page.has_more) break;
    startingAfter = page.data.at(-1)?.id;
    if (!startingAfter) throw new Error('truncated-webhook-endpoint-page');
  } while (true);

  const matching = endpoints.filter((endpoint) => endpoint.url === canonicalWebhookUrl && endpoint.status === 'enabled');
  const fullyConfigured = matching.filter((endpoint) => {
    const enabled = new Set(endpoint.enabled_events || []);
    return enabled.has('*') || REQUIRED_WEBHOOK_EVENTS.every((eventType) => enabled.has(eventType));
  });
  if (fullyConfigured.length !== 1) {
    throw new Error(`expected-one-enabled-endpoint-with-required-events-found-${fullyConfigured.length}`);
  }
  const endpoint = fullyConfigured[0];
  const proofFreshnessSeconds = 24 * 60 * 60;
  const proofSince = Math.max(Number(endpoint.created || 0), Math.floor(Date.now() / 1000) - proofFreshnessSeconds);
  const deliveredEvents = await stripe.events.list({
    types: ['payment_link.updated'],
    delivery_success: true,
    created: { gte: proofSince },
    limit: 10,
  });
  const providerDeliveryProof = deliveredEvents.data.find((event) => event.livemode === true && event.type === 'payment_link.updated');
  if (!providerDeliveryProof) throw new Error('fresh-provider-origin-delivery-proof-missing');
  console.log(`OK   Stripe webhook endpoint is enabled for the exact production route and ${REQUIRED_WEBHOOK_EVENTS.length} required event types`);
  console.log('OK   Stripe reports a fresh live Payment Link update successfully delivered to all enabled webhook endpoints; the deployed signing secret accepted a provider-origin event');
} catch (error) {
  console.error('\nFAIL live Stripe webhook endpoint verification');
  console.error(`Expected exact enabled endpoint: ${canonicalWebhookUrl}`);
  console.error(`Required events: ${REQUIRED_WEBHOOK_EVENTS.join(', ')}`);
  console.error(`Provider result: ${String(error?.code || error?.type || error?.message || error)}`);
  console.error('The restricted Stripe key also needs Webhook Endpoints and Events read access. After the endpoint is configured, make an approved harmless Payment Link update in Stripe and rerun this check within 24 hours; Stripe delivery_success proof must show the deployed signing secret accepted the provider-origin event.');
  process.exit(1);
}

const paymentLinkFailures = [];
const providerVerifiedCorePlans = [];
for (const offer of paymentLinkConfiguration.enabledOffers) {
  const verification = await verifyCanonicalRevenuePaymentLinks({
    stripe,
    configs: [{ plan: offer.plan, id: offer.id, url: offer.url }],
    policyVersion: customerPolicyVersion,
    taxMode: customerPolicyApproval.billingPolicy.taxMode,
  });
  if (!verification.ok) {
    const detail = verification.failedChecks?.join(', ')
      || verification.stripeError?.code
      || verification.stripeError?.type
      || verification.reason
      || 'provider verification failed';
    paymentLinkFailures.push(`${offer.plan}: ${detail}`);
    continue;
  }
  if (offer.plan !== 'enterprise') providerVerifiedCorePlans.push(offer.plan);
  console.log(`OK   Stripe ${offer.plan.padEnd(10)} exact live monthly product, policy binding, and recovery redirect verified`);
}

if (paymentLinkFailures.length > 0 || providerVerifiedCorePlans.length === 0) {
  console.error('\nFAIL live Stripe Payment Link product verification:');
  for (const failure of paymentLinkFailures) console.error(`- ${failure}`);
  if (providerVerifiedCorePlans.length === 0) console.error('- no configured Starter or Pro offer completed exact provider verification');
  console.error(`Expected success redirect: ${CANONICAL_REVENUE_SUCCESS_URL}`);
  console.error('Do not enable a configured offer until its exact URL, plink_ ID, live/active state, canonical monthly price/product, policy metadata, and recovery redirect all pass.');
  process.exit(1);
}

console.log(`OK   provider-verified core offer path: ${providerVerifiedCorePlans.join(', ')}`);

console.log('\nOK required live Railway env values are present');

const googleClientId = pick(['GOOGLE_OAUTH_CLIENT_ID']);
if (!String(googleClientId || '').trim() || looksPlaceholder(googleClientId)) {
  console.log('\nWARN live Google workspace sign-in is not enabled yet.');
  console.log('Fast path: npm run fix:google-auth-live -- your-google-web-client-id.apps.googleusercontent.com');
  console.log('Alt path:  GOOGLE_OAUTH_CLIENT_ID="your-google-web-client-id.apps.googleusercontent.com" npm run set:google-auth-env');
}
