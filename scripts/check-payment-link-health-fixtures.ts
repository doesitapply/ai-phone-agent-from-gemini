#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { evaluatePaymentLinkConfiguration } from "../src/payment-link-configuration.js";

const starter = {
  STRIPE_PAYMENT_LINK_STARTER: "https://buy.stripe.com/starter_live_fixture",
  STRIPE_PAYMENT_LINK_STARTER_ID: "plink_starter_live_fixture",
};
const pro = {
  STRIPE_PAYMENT_LINK_PRO: "https://buy.stripe.com/pro_live_fixture",
  STRIPE_PAYMENT_LINK_PRO_ID: "plink_pro_live_fixture",
};
const enterprise = {
  STRIPE_PAYMENT_LINK_ENTERPRISE: "https://buy.stripe.com/enterprise_live_fixture",
  STRIPE_PAYMENT_LINK_ENTERPRISE_ID: "plink_enterprise_live_fixture",
};

const missing = evaluatePaymentLinkConfiguration({});
assert.equal(missing.ready, false);
assert.ok(missing.blockers.includes("core-payment-link-pair-missing"));
assert.equal(missing.providerVerification, "not_checked");

const starterOnly = evaluatePaymentLinkConfiguration(starter);
assert.equal(starterOnly.ready, true, "one complete Starter pair must satisfy configuration health");
assert.deepEqual(starterOnly.configuredCorePlans, ["starter"]);
assert.equal(starterOnly.enterpriseConfigured, false);

const proOnly = evaluatePaymentLinkConfiguration(pro);
assert.equal(proOnly.ready, true, "one complete Pro pair must satisfy configuration health");
assert.deepEqual(proOnly.configuredCorePlans, ["pro"]);

const bothCore = evaluatePaymentLinkConfiguration({ ...starter, ...pro });
assert.equal(bothCore.ready, true, "two complete core pairs may remain configured");

const partialSibling = evaluatePaymentLinkConfiguration({
  ...starter,
  STRIPE_PAYMENT_LINK_PRO: pro.STRIPE_PAYMENT_LINK_PRO,
});
assert.equal(partialSibling.ready, false, "a partial configured sibling must fail closed");
assert.ok(partialSibling.blockers.includes("pro-payment-link-pair-incomplete"));

const placeholderSibling = evaluatePaymentLinkConfiguration({
  ...starter,
  STRIPE_PAYMENT_LINK_PRO: "https://buy.stripe.com/...",
  STRIPE_PAYMENT_LINK_PRO_ID: "plink_...",
});
assert.equal(placeholderSibling.ready, false, "placeholder sibling values must fail closed");
assert.ok(placeholderSibling.blockers.includes("pro-payment-link-url-invalid"));
assert.ok(placeholderSibling.blockers.includes("pro-payment-link-id-invalid"));

const queryUrl = evaluatePaymentLinkConfiguration({
  STRIPE_PAYMENT_LINK_STARTER: `${starter.STRIPE_PAYMENT_LINK_STARTER}?unexpected=1`,
  STRIPE_PAYMENT_LINK_STARTER_ID: starter.STRIPE_PAYMENT_LINK_STARTER_ID,
});
assert.equal(queryUrl.ready, false, "query-bearing Payment Link URLs must fail configuration health");

const explicitDefaultPort = evaluatePaymentLinkConfiguration({
  STRIPE_PAYMENT_LINK_STARTER: "https://buy.stripe.com:443/starter_live_fixture",
  STRIPE_PAYMENT_LINK_STARTER_ID: starter.STRIPE_PAYMENT_LINK_STARTER_ID,
});
assert.equal(explicitDefaultPort.ready, false, "explicit default ports must not normalize into an accepted Payment Link URL");
assert.ok(explicitDefaultPort.blockers.includes("starter-payment-link-url-invalid"));

const duplicateBinding = evaluatePaymentLinkConfiguration({
  ...starter,
  STRIPE_PAYMENT_LINK_PRO: starter.STRIPE_PAYMENT_LINK_STARTER,
  STRIPE_PAYMENT_LINK_PRO_ID: starter.STRIPE_PAYMENT_LINK_STARTER_ID,
});
assert.equal(duplicateBinding.ready, false, "two plans must not share one Payment Link binding");
assert.ok(duplicateBinding.blockers.includes("duplicate-payment-link-url"));
assert.ok(duplicateBinding.blockers.includes("duplicate-payment-link-id"));

const unapprovedEnterprise = evaluatePaymentLinkConfiguration({ ...starter, ...enterprise });
assert.equal(unapprovedEnterprise.ready, false, "configured Enterprise must remain conditional on separate policy readiness");
assert.ok(unapprovedEnterprise.blockers.includes("enterprise-payment-link-policy-not-ready"));

const approvedEnterprise = evaluatePaymentLinkConfiguration(
  { ...starter, ...enterprise },
  { enterpriseUsageReady: true },
);
assert.equal(approvedEnterprise.ready, true, "a complete Enterprise pair may pass configuration health only after separate policy readiness");
assert.equal(approvedEnterprise.enterpriseConfigured, true);
assert.equal(approvedEnterprise.providerVerification, "not_checked", "configuration health must never imply provider verification");

console.log("OK Payment Link health accepts one complete core pair, rejects partial or placeholder siblings, and keeps provider proof separate");
