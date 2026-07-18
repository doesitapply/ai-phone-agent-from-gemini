#!/usr/bin/env node
import Stripe from 'stripe';
import {
  evaluateFirstDollarPaymentLinkConfiguration,
  verifyCanonicalRevenuePaymentLinks,
} from './lib/qualifying-revenue-evidence.mjs';
import { evaluateCustomerPolicyApproval } from '../src/customer-policy-approval.js';

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
  console.error('FAIL proposed core Payment Link configuration is incomplete or unsafe');
  for (const failure of configuration.failures) console.error(`- ${failure.message}`);
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

console.log('OK all proposed core Payment Links passed read-only provider verification before Railway mutation');
