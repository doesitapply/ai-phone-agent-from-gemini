#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateFirstDollarPaymentLinkConfiguration } from './lib/qualifying-revenue-evidence.mjs';

const starter = Object.freeze({
  url: 'https://buy.stripe.com/starterFixture',
  id: 'plink_starter_fixture',
});
const pro = Object.freeze({
  url: 'https://buy.stripe.com/proFixture',
  id: 'plink_pro_fixture',
});
const enterprise = Object.freeze({
  url: 'https://buy.stripe.com/enterpriseFixture',
  id: 'plink_enterprise_fixture',
});

const noCoreOffer = evaluateFirstDollarPaymentLinkConfiguration({});
assert.equal(noCoreOffer.ok, false, 'missing Starter must fail first-dollar readiness');
assert.ok(noCoreOffer.failures.some((failure) => failure.code === 'starter-payment-link-offer-missing'));

const starterOnly = evaluateFirstDollarPaymentLinkConfiguration({ starter });
assert.equal(starterOnly.ok, true, 'one complete Starter pair must satisfy the Starter-only launch configuration');
assert.deepEqual(starterOnly.coreOffers.map((offer) => offer.plan), ['starter']);
assert.equal(starterOnly.enterpriseEnabled, false, 'Enterprise must remain disabled by default');

const proOnly = evaluateFirstDollarPaymentLinkConfiguration({ pro });
assert.equal(proOnly.ok, false, 'one complete Pro pair must not satisfy Starter-only first-dollar readiness');
assert.deepEqual(proOnly.coreOffers, []);
assert.ok(proOnly.failures.some((failure) => failure.code === 'pro-payment-link-out-of-first-dollar-scope'));
assert.ok(proOnly.failures.some((failure) => failure.code === 'starter-payment-link-offer-missing'));

const bothCoreOffers = evaluateFirstDollarPaymentLinkConfiguration({ starter, pro });
assert.equal(bothCoreOffers.ok, false, 'configured Pro must block the Starter-only first-dollar launch');
assert.deepEqual(bothCoreOffers.coreOffers.map((offer) => offer.plan), ['starter']);
assert.ok(bothCoreOffers.failures.some((failure) => failure.code === 'pro-payment-link-out-of-first-dollar-scope'));

const partialExtraOffer = evaluateFirstDollarPaymentLinkConfiguration({
  starter,
  pro: { url: pro.url },
});
assert.equal(partialExtraOffer.ok, false, 'a partially configured out-of-scope Pro offer must fail closed');
assert.ok(partialExtraOffer.failures.some((failure) => failure.code === 'pro-payment-link-id-missing'));
assert.ok(partialExtraOffer.failures.some((failure) => failure.code === 'pro-payment-link-out-of-first-dollar-scope'));

const placeholderExtraOffer = evaluateFirstDollarPaymentLinkConfiguration({
  starter,
  pro: { url: 'https://buy.stripe.com/...', id: pro.id },
});
assert.equal(placeholderExtraOffer.ok, false, 'a placeholder configured offer must fail closed');
assert.ok(placeholderExtraOffer.failures.some((failure) => failure.code === 'pro-payment-link-url-invalid'));

const placeholderIdOffer = evaluateFirstDollarPaymentLinkConfiguration({
  starter: { ...starter, id: 'plink_replace_with_exact_live_id' },
});
assert.equal(placeholderIdOffer.ok, false, 'a prose-shaped plink_ placeholder must fail before live mutation');
assert.ok(placeholderIdOffer.failures.some((failure) => failure.code === 'starter-payment-link-id-invalid'));

for (const unsafeUrl of [
  'https://buy.stripe.com/starterFixture?prefilled_email=owner@example.com',
  'https://buy.stripe.com/starterFixture#fragment',
  'https://user:pass@buy.stripe.com/starterFixture',
  'https://buy.stripe.com:443/starterFixture',
  'https://buy.stripe.com.evil.example/starterFixture',
  'https://checkout.stripe.com/starterFixture',
]) {
  const unsafeOffer = evaluateFirstDollarPaymentLinkConfiguration({
    starter: { ...starter, url: unsafeUrl },
  });
  assert.equal(unsafeOffer.ok, false, `unsafe Payment Link URL must fail before live mutation: ${unsafeUrl}`);
  assert.ok(unsafeOffer.failures.some((failure) => failure.code === 'starter-payment-link-url-invalid'));
}

const duplicateBinding = evaluateFirstDollarPaymentLinkConfiguration({
  starter,
  pro: { url: starter.url, id: starter.id },
});
assert.equal(duplicateBinding.ok, false, 'enabled offers must not share a Payment Link URL or ID');
assert.ok(duplicateBinding.failures.some((failure) => failure.code === 'duplicate-payment-link-id'));
assert.ok(duplicateBinding.failures.some((failure) => failure.code === 'duplicate-payment-link-url'));

const unapprovedEnterprise = evaluateFirstDollarPaymentLinkConfiguration({ starter, enterprise });
assert.equal(unapprovedEnterprise.ok, false, 'Enterprise must remain outside the Starter-only first-dollar launch');
assert.ok(unapprovedEnterprise.failures.some((failure) => failure.code === 'enterprise-payment-link-out-of-first-dollar-scope'));

const approvedEnterprise = evaluateFirstDollarPaymentLinkConfiguration(
  { starter, enterprise },
  { enterpriseUsageReady: true },
);
assert.equal(approvedEnterprise.ok, false, 'broader policy readiness must not reopen Enterprise during the Starter-only launch');
assert.equal(approvedEnterprise.enterpriseEnabled, false);
assert.ok(approvedEnterprise.failures.some((failure) => failure.code === 'enterprise-payment-link-out-of-first-dollar-scope'));

const partialApprovedEnterprise = evaluateFirstDollarPaymentLinkConfiguration(
  { starter, enterprise: { id: enterprise.id } },
  { enterpriseUsageReady: true },
);
assert.equal(partialApprovedEnterprise.ok, false, 'separate approval must not excuse an incomplete Enterprise pair');
assert.ok(partialApprovedEnterprise.failures.some((failure) => failure.code === 'enterprise-payment-link-url-missing'));

console.log('OK first-dollar offer selection requires one exact Starter pair and rejects configured Pro/Enterprise lanes');
