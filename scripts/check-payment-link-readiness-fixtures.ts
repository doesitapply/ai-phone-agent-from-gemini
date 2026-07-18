#!/usr/bin/env tsx
import assert from "node:assert/strict";
import {
  CANONICAL_PAYMENT_LINK_SUCCESS_URL,
  buildPlanCheckoutReadiness,
  verifyCanonicalPaymentLink,
  type StripeCheckoutPlan,
} from "../src/stripe-payment-link-readiness.js";

const policyVersion = "2026-07-18-fixture";
const taxMode = "stripe_automatic_tax";
const specs: Record<StripeCheckoutPlan, { amount: number; productName: string }> = {
  starter: { amount: 19_700, productName: "SMIRK AI Starter" },
  pro: { amount: 39_700, productName: "SMIRK AI Pro" },
  enterprise: { amount: 69_700, productName: "SMIRK AI Agency" },
};

const providerFixture = (plan: StripeCheckoutPlan) => {
  const id = `plink_${plan}_fixture`;
  const url = `https://buy.stripe.com/${plan}_fixture`;
  return {
    id,
    url,
    link: {
      id,
      url,
      livemode: true,
      active: true,
      allow_promotion_codes: false,
      optional_items: [],
      shipping_address_collection: null,
      shipping_options: [],
      consent_collection: { terms_of_service: "required" },
      automatic_tax: { enabled: true },
      after_completion: {
        type: "redirect",
        redirect: { url: CANONICAL_PAYMENT_LINK_SUCCESS_URL },
      },
      metadata: { smirk_customer_policy_version: policyVersion },
      subscription_data: {
        metadata: { smirk_customer_policy_version: policyVersion },
        trial_period_days: null,
      },
    },
    lineItems: {
      has_more: false,
      data: [{
        quantity: 1,
        adjustable_quantity: { enabled: false },
        price: {
          id: `price_${plan}_fixture`,
          livemode: true,
          active: true,
          billing_scheme: "per_unit",
          custom_unit_amount: null,
          transform_quantity: null,
          type: "recurring",
          currency: "usd",
          unit_amount: specs[plan].amount,
          recurring: {
            interval: "month",
            interval_count: 1,
            usage_type: "licensed",
            meter: null,
            trial_period_days: null,
          },
          product: {
            id: `prod_${plan}_fixture`,
            livemode: true,
            active: true,
            name: specs[plan].productName,
          },
        },
      }],
    },
  };
};

const verifyFixture = async (input: {
  selectedPlan: StripeCheckoutPlan;
  providerPlan?: StripeCheckoutPlan;
  paymentLinkId?: string;
  paymentLinkUrl?: string;
  restrictedKey?: string;
  mutateLink?: (link: any) => void;
  mutateLineItems?: (lineItems: any) => void;
  providerError?: boolean;
}) => {
  const provider = providerFixture(input.providerPlan || input.selectedPlan);
  input.mutateLink?.(provider.link);
  input.mutateLineItems?.(provider.lineItems);
  let providerCalls = 0;
  const proof = await verifyCanonicalPaymentLink({
    restrictedKey: input.restrictedKey ?? "rk_live_payment_link_fixture",
    plan: input.selectedPlan,
    paymentLinkId: input.paymentLinkId ?? provider.id,
    paymentLinkUrl: input.paymentLinkUrl ?? provider.url,
    policyVersion,
    taxMode,
    retrievePaymentLink: async () => {
      providerCalls += 1;
      if (input.providerError) throw new Error("fixture-provider-error");
      return provider.link;
    },
    listPaymentLinkLineItems: async () => {
      providerCalls += 1;
      if (input.providerError) throw new Error("fixture-provider-error");
      return provider.lineItems;
    },
  });
  return { proof, providerCalls };
};

for (const plan of ["starter", "pro", "enterprise"] as const) {
  const { proof, providerCalls } = await verifyFixture({ selectedPlan: plan });
  assert.equal(proof.ready, true, `${plan} exact provider binding should be ready`);
  assert.equal(proof.binding?.plan, plan);
  assert.equal(proof.binding?.paymentLinkUrl, `https://buy.stripe.com/${plan}_fixture`);
  assert.equal(providerCalls, 2);
}

const starterOnly = buildPlanCheckoutReadiness({
  nativeCheckoutReady: false,
  activationPrerequisitesReady: true,
  enterpriseUsagePolicyReady: false,
  paymentLinkCheckoutReadyByPlan: { starter: true },
});
assert.equal(starterOnly.firstDollarReadyByPlan.starter, true, "Starter must launch without a Pro link");
assert.equal(starterOnly.firstDollarReadyByPlan.pro, false, "missing Pro must remain unavailable");
assert.equal(starterOnly.firstDollarReady, true, "one launchable core plan must satisfy aggregate first-dollar readiness");

const proOnly = buildPlanCheckoutReadiness({
  nativeCheckoutReady: false,
  activationPrerequisitesReady: true,
  enterpriseUsagePolicyReady: false,
  paymentLinkCheckoutReadyByPlan: { pro: true },
});
assert.equal(proOnly.firstDollarReadyByPlan.starter, false, "missing Starter must remain unavailable");
assert.equal(proOnly.firstDollarReadyByPlan.pro, true, "Pro must launch without a Starter link");
assert.equal(proOnly.firstDollarReady, true);

const nativeOnly = buildPlanCheckoutReadiness({
  nativeCheckoutReady: true,
  activationPrerequisitesReady: true,
  enterpriseUsagePolicyReady: false,
  paymentLinkCheckoutReadyByPlan: {},
});
assert.equal(nativeOnly.firstDollarReadyByPlan.starter, true, "native checkout must not depend on Payment Link proof");
assert.equal(nativeOnly.firstDollarReadyByPlan.pro, true, "native checkout must remain independently available for Pro");
assert.equal(nativeOnly.firstDollarReadyByPlan.enterprise, false, "native checkout must not bypass Enterprise policy");

const enterpriseWithoutPolicy = buildPlanCheckoutReadiness({
  nativeCheckoutReady: false,
  activationPrerequisitesReady: true,
  enterpriseUsagePolicyReady: false,
  paymentLinkCheckoutReadyByPlan: { starter: true, enterprise: true },
});
assert.equal(enterpriseWithoutPolicy.firstDollarReadyByPlan.starter, true);
assert.equal(enterpriseWithoutPolicy.firstDollarReadyByPlan.enterprise, false, "verified Enterprise link must remain disabled without policy approval");

const activationBlocked = buildPlanCheckoutReadiness({
  nativeCheckoutReady: false,
  activationPrerequisitesReady: false,
  enterpriseUsagePolicyReady: false,
  paymentLinkCheckoutReadyByPlan: { starter: true },
});
assert.equal(activationBlocked.checkoutReadyByPlan.starter, true);
assert.equal(activationBlocked.firstDollarReadyByPlan.starter, false, "payment route alone must not bypass activation readiness");
assert.equal(activationBlocked.firstDollarReady, false);

const swappedPlan = await verifyFixture({ selectedPlan: "starter", providerPlan: "pro" });
assert.equal(swappedPlan.proof.ready, false, "a Pro provider object must not authorize Starter");
assert.ok(swappedPlan.proof.blockers.includes("payment-link-amount-mismatch"));
assert.ok(swappedPlan.proof.blockers.includes("payment-link-product-mismatch"));

const starterProvider = providerFixture("starter");
const swappedUrl = await verifyFixture({
  selectedPlan: "starter",
  paymentLinkId: starterProvider.id,
  paymentLinkUrl: "https://buy.stripe.com/pro_fixture",
});
assert.equal(swappedUrl.proof.ready, false, "a URL from another plan must fail exact provider binding");
assert.ok(swappedUrl.proof.blockers.includes("payment-link-url-mismatch"));

for (const [label, mutation, expectedBlocker] of [
  ["inactive", (link: any) => { link.active = false; }, "payment-link-not-active"],
  ["test mode", (link: any) => { link.livemode = false; }, "payment-link-not-live"],
  ["promotion codes", (link: any) => { link.allow_promotion_codes = true; }, "payment-link-promotion-codes-enabled"],
  ["trial period", (link: any) => { link.subscription_data.trial_period_days = 30; }, "payment-link-trial-enabled"],
  ["optional item", (link: any) => { link.optional_items = [{ price: "price_optional_fixture", quantity: 1 }]; }, "payment-link-optional-items-enabled"],
  ["shipping collection", (link: any) => { link.shipping_address_collection = { allowed_countries: ["US"] }; }, "payment-link-shipping-address-collection-enabled"],
  ["shipping option", (link: any) => { link.shipping_options = [{ shipping_rate: "shr_fixture", shipping_amount: 500 }]; }, "payment-link-shipping-options-enabled"],
  ["stale link policy", (link: any) => { link.metadata.smirk_customer_policy_version = "stale"; }, "payment-link-policy-version-mismatch"],
  ["stale subscription policy", (link: any) => { link.subscription_data.metadata.smirk_customer_policy_version = "stale"; }, "payment-link-subscription-policy-version-mismatch"],
  ["wrong redirect", (link: any) => { link.after_completion.redirect.url = "https://example.invalid"; }, "payment-link-success-url-mismatch"],
  ["missing Terms consent", (link: any) => { link.consent_collection = null; }, "payment-link-terms-consent-not-required"],
  ["wrong automatic tax mode", (link: any) => { link.automatic_tax.enabled = false; }, "payment-link-tax-mode-mismatch"],
] as const) {
  const result = await verifyFixture({ selectedPlan: "starter", mutateLink: mutation });
  assert.equal(result.proof.ready, false, `${label} must fail closed`);
  assert.ok(result.proof.blockers.includes(expectedBlocker));
}

for (const [label, mutation, expectedBlocker] of [
  ["wrong amount", (lineItems: any) => { lineItems.data[0].price.unit_amount = 1; }, "payment-link-amount-mismatch"],
  ["wrong currency", (lineItems: any) => { lineItems.data[0].price.currency = "eur"; }, "payment-link-amount-mismatch"],
  ["wrong interval", (lineItems: any) => { lineItems.data[0].price.recurring.interval = "year"; }, "payment-link-recurring-price-invalid"],
  ["metered price", (lineItems: any) => { lineItems.data[0].price.recurring.usage_type = "metered"; }, "payment-link-recurring-billing-model-invalid"],
  ["meter-bound price", (lineItems: any) => { lineItems.data[0].price.recurring.meter = "mtr_fixture"; }, "payment-link-recurring-billing-model-invalid"],
  ["price default trial", (lineItems: any) => { lineItems.data[0].price.recurring.trial_period_days = 30; }, "payment-link-recurring-billing-model-invalid"],
  ["tiered price", (lineItems: any) => { lineItems.data[0].price.billing_scheme = "tiered"; }, "payment-link-recurring-billing-model-invalid"],
  ["custom amount", (lineItems: any) => { lineItems.data[0].price.custom_unit_amount = { minimum: 1 }; }, "payment-link-recurring-billing-model-invalid"],
  ["transformed quantity", (lineItems: any) => { lineItems.data[0].price.transform_quantity = { divide_by: 100, round: "up" }; }, "payment-link-recurring-billing-model-invalid"],
  ["inactive price", (lineItems: any) => { lineItems.data[0].price.active = false; }, "payment-link-price-not-active"],
  ["test-mode price", (lineItems: any) => { lineItems.data[0].price.livemode = false; }, "payment-link-price-not-live"],
  ["wrong product", (lineItems: any) => { lineItems.data[0].price.product.name = "Unrelated"; }, "payment-link-product-mismatch"],
  ["inactive product", (lineItems: any) => { lineItems.data[0].price.product.active = false; }, "payment-link-product-not-active"],
  ["test-mode product", (lineItems: any) => { lineItems.data[0].price.product.livemode = false; }, "payment-link-product-not-live"],
  ["adjustable quantity", (lineItems: any) => { lineItems.data[0].adjustable_quantity.enabled = true; }, "payment-link-quantity-invalid"],
] as const) {
  const result = await verifyFixture({ selectedPlan: "starter", mutateLineItems: mutation });
  assert.equal(result.proof.ready, false, `${label} must fail closed`);
  assert.ok(result.proof.blockers.includes(expectedBlocker));
}

for (const restrictedKey of ["", "sk_live_wrong_credential", "sk_test_wrong_credential"]) {
  const result = await verifyFixture({ selectedPlan: "starter", restrictedKey });
  assert.equal(result.proof.ready, false, "only the dedicated live restricted key may verify a Payment Link");
  assert.equal(result.providerCalls, 0, "invalid credentials must fail before provider access");
  assert.deepEqual(result.proof.blockers, ["payment-link-dedicated-live-read-key-invalid"]);
}

const unsafeUrl = await verifyFixture({
  selectedPlan: "starter",
  paymentLinkUrl: "https://buy.stripe.com.evil.example/starter",
});
assert.equal(unsafeUrl.proof.ready, false);
assert.equal(unsafeUrl.providerCalls, 0, "untrusted Payment Link URL must fail before provider access");

for (const paymentLinkUrl of [
  "https://buy.stripe.com:443/starter_live",
  "https://buy.stripe.com/...",
  "https://buy.stripe.com/replace_me",
  "https://buy.stripe.com/example_live",
  "https://buy.stripe.com/your_link",
  "https://buy.stripe.com/xxxxx",
]) {
  const result = await verifyFixture({ selectedPlan: "starter", paymentLinkUrl });
  assert.equal(result.proof.ready, false, `${paymentLinkUrl} must not be accepted as a live Payment Link URL`);
  assert.equal(result.providerCalls, 0, "placeholder/default-port Payment Link URLs must fail before provider access");
  assert.deepEqual(result.proof.blockers, ["payment-link-config-invalid"]);
}

for (const paymentLinkId of [
  "plink_replace_me",
  "plink_example_live",
  "plink_your_link",
  "plink_xxxxx",
]) {
  const result = await verifyFixture({ selectedPlan: "starter", paymentLinkId });
  assert.equal(result.proof.ready, false, `${paymentLinkId} must not be accepted as a live Payment Link ID`);
  assert.equal(result.providerCalls, 0, "placeholder Payment Link IDs must fail before provider access");
  assert.deepEqual(result.proof.blockers, ["payment-link-config-invalid"]);
}

const providerFailure = await verifyFixture({ selectedPlan: "starter", providerError: true });
assert.equal(providerFailure.proof.ready, false);
assert.deepEqual(providerFailure.proof.blockers, ["payment-link-provider-read-failed"]);
assert.equal(providerFailure.proof.binding, null);

const invalidTaxModeProvider = providerFixture("starter");
let invalidTaxModeCalls = 0;
const invalidTaxMode = await verifyCanonicalPaymentLink({
  restrictedKey: "rk_live_payment_link_fixture",
  plan: "starter",
  paymentLinkId: invalidTaxModeProvider.id,
  paymentLinkUrl: invalidTaxModeProvider.url,
  policyVersion,
  taxMode: "",
  retrievePaymentLink: async () => { invalidTaxModeCalls += 1; return invalidTaxModeProvider.link; },
  listPaymentLinkLineItems: async () => { invalidTaxModeCalls += 1; return invalidTaxModeProvider.lineItems; },
});
assert.deepEqual(invalidTaxMode.blockers, ["payment-link-tax-mode-invalid"]);
assert.equal(invalidTaxModeCalls, 0, "unapproved tax mode must fail before provider access");

console.log("OK plan-specific Payment Link readiness requires exact provider bindings and preserves native/Enterprise isolation");
