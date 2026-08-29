import assert from "node:assert/strict";
import { evaluatePaymentLinkConfiguration } from "../src/payment-link-configuration.ts";

const starter = {
  STRIPE_PAYMENT_LINK_STARTER: "https://buy.stripe.com/7sYaEX4fx4nScmbfxo6Zy0m",
  STRIPE_PAYMENT_LINK_STARTER_ID: "plink_1U8tw3IoSdlZwew1jZOl3zKS",
  STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS: "plink_1U8tw3IoSdlZwew1jZOl3zKS",
};

const starterOnly = evaluatePaymentLinkConfiguration(starter);
assert.equal(starterOnly.ready, true, "a valid Starter link must be launch-ready without Pro or Enterprise");
assert.deepEqual(starterOnly.blockers, [], "Starter-only launch must not inherit deferred-plan blockers");

const legacyDeferredPlans = evaluatePaymentLinkConfiguration({
  ...starter,
  STRIPE_PAYMENT_LINK_PRO: "https://buy.stripe.com/legacy",
  STRIPE_PAYMENT_LINK_ENTERPRISE_ID: "plink_legacyenterprise",
});
assert.equal(legacyDeferredPlans.ready, true, "incomplete deferred plan settings must not block the active Starter launch");
assert.ok(legacyDeferredPlans.deferredPlanWarnings.includes("pro-payment-link-pair-incomplete"), "legacy Pro configuration must remain visible as a warning");
assert.ok(legacyDeferredPlans.deferredPlanWarnings.includes("enterprise-payment-link-pair-incomplete"), "legacy Enterprise configuration must remain visible as a warning");

const missingStarterId = evaluatePaymentLinkConfiguration({
  STRIPE_PAYMENT_LINK_STARTER: starter.STRIPE_PAYMENT_LINK_STARTER,
});
assert.equal(missingStarterId.ready, false, "a missing canonical Starter ID must block checkout");
assert.ok(missingStarterId.blockers.includes("starter-payment-link-pair-incomplete"), "missing Starter pair must be explicit");

console.log("Payment-link configuration checks passed (8 assertions).");
