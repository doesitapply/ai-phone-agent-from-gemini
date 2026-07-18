#!/usr/bin/env node
import Stripe from 'stripe';
import {
  evaluateFirstDollarPaymentLinkConfiguration,
  verifyCanonicalRevenuePaymentLinks,
} from './lib/qualifying-revenue-evidence.mjs';
import { evaluateCustomerPolicyApproval } from '../src/customer-policy-approval.js';
import { evaluateStarterPaymentLinkFulfillmentIds } from '../src/payment-link-fulfillment-ids.js';

const restrictedKey = String(process.env.STRIPE_REVENUE_READ_KEY || '').trim();
const policyVersion = String(process.env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION || '').trim();
const customerPolicy = evaluateCustomerPolicyApproval(policyVersion);
if (!/^rk_live_[A-Za-z0-9_]+$/.test(restrictedKey)) {
  console.error('FAIL proposed Payment Link verification requires the dedicated live restricted STRIPE_REVENUE_READ_KEY');
  process.exit(1);
}

const configuration = evaluateFirstDollarPaymentLinkConfiguration({
  starter: {
    url: process.env.STRIPE_PAYMENT_LINK_STARTER,
    id: process.env.STRIPE_PAYMENT_LINK_STARTER_ID,
  },
  pro: {
    url: process.env.STRIPE_PAYMENT_LINK_PRO,
    id: process.env.STRIPE_PAYMENT_LINK_PRO_ID,
  },
});
if (!configuration.ok) {
  console.error('FAIL proposed Starter-only Payment Link configuration is incomplete, unsafe, or includes a broader offer');
  for (const failure of configuration.failures) console.error(`- ${failure.message}`);
  process.exit(1);
}

const fulfillmentIds = evaluateStarterPaymentLinkFulfillmentIds({
  currentId: process.env.STRIPE_PAYMENT_LINK_STARTER_ID,
  rawIds: process.env.STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS,
});
if (!fulfillmentIds.ready) {
  console.error('FAIL proposed Starter fulfillment-ID allowlist must explicitly include the current exact plink_ ID');
  for (const blocker of fulfillmentIds.blockers) console.error(`- ${blocker}`);
  process.exit(1);
}

const stripe = new Stripe(restrictedKey, {
  apiVersion: '2026-04-22.dahlia',
  maxNetworkRetries: 2,
  timeout: 15_000,
});
for (const offer of configuration.coreOffers) {
  const verification = await verifyCanonicalRevenuePaymentLinks({
    stripe,
    configs: [{ plan: offer.plan, id: offer.id, url: offer.url }],
    policyVersion,
    taxMode: customerPolicy.billingPolicy.taxMode,
  });
  if (!verification.ok) {
    const detail = verification.failedChecks?.join(', ')
      || verification.stripeError?.code
      || verification.stripeError?.type
      || verification.reason
      || 'provider verification failed';
    console.error(`FAIL proposed ${offer.plan} Payment Link did not pass exact Stripe verification: ${detail}`);
    process.exit(1);
  }
  console.log(`OK proposed ${offer.plan} Payment Link is exact, live, active, immediately billable, and policy-bound`);
}

console.log('OK the proposed Starter Payment Link passed read-only provider verification before Railway mutation; Pro and Enterprise remain disabled');
