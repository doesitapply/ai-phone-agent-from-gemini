#!/usr/bin/env node
import assert from "node:assert/strict";
import { evaluateFirstDollarPaymentLinkDiscovery } from "./lib/first-dollar-payment-link-discovery.mjs";

function paymentLink({
  id,
  url = `https://buy.stripe.com/${id}`,
  amount = 19700,
  plan = "starter",
  ready = true,
  active = true,
  livemode = true,
} = {}) {
  return {
    id,
    url,
    active,
    livemode,
    classifiedPlan: plan,
    lines: [{
      productId: `prod_${id}`,
      productName: `SMIRK AI ${plan}`,
      priceId: `price_${id}`,
      amount,
      currency: "usd",
      interval: "month",
      intervalCount: 1,
    }],
    checks: {
      canonicalStarterPrice: plan === "starter" && amount === 19700,
      canonicalSuccessRedirect: ready,
      termsAcceptanceRequired: ready,
      phoneCollectionRequired: ready,
      businessNameCollectionRequired: ready,
      policyVersionRecorded: ready,
      productMetadataBound: ready,
      starterMetadataBound: ready,
      automaticTaxEnabled: false,
    },
  };
}

const canonical = paymentLink({ id: "plink_canonical" });
const clean = evaluateFirstDollarPaymentLinkDiscovery({
  described: [canonical],
  configuredUrls: { starter: canonical.url },
});
assert.equal(clean.ok, true, "one configured, launch-ready $197 Starter link must pass");
assert.equal(clean.proposedStarterId, canonical.id);
assert.deepEqual(clean.activeLinksRequiringResolution, []);

const secondCanonical = paymentLink({ id: "plink_second" });
const ambiguous = evaluateFirstDollarPaymentLinkDiscovery({
  described: [canonical, secondCanonical],
  configuredUrls: { starter: canonical.url },
});
assert.equal(ambiguous.ok, false, "two active $197 Starter candidates must fail closed");
assert.equal(ambiguous.proposedStarterId, null, "ambiguous discovery must never choose an ID");
assert.ok(ambiguous.blockers.includes("multiple-active-canonical-197-starter-candidates"));
assert.ok(ambiguous.blockers.includes("multiple-launch-ready-starter-payment-links"));

const configured299 = paymentLink({
  id: "plink_configured_299",
  amount: 29900,
});
const mispriced = evaluateFirstDollarPaymentLinkDiscovery({
  described: [configured299, canonical],
  configuredUrls: { starter: configured299.url },
});
assert.equal(mispriced.ok, false, "a configured $299 Starter link must fail the $197 gate");
assert.ok(mispriced.blockers.includes(
  "configured-starter-url-is-not-active-live-canonical-197-starter",
));

const incomplete = paymentLink({ id: "plink_incomplete", ready: false });
const incompleteResult = evaluateFirstDollarPaymentLinkDiscovery({
  described: [incomplete],
  configuredUrls: { starter: incomplete.url },
});
assert.equal(incompleteResult.ok, false, "an incomplete $197 checkout must not be proposed");
assert.equal(incompleteResult.proposedStarterId, null);
assert.ok(incompleteResult.blockers.includes("no-launch-ready-starter-payment-link"));
assert.ok(incompleteResult.blockers.includes("configured-starter-url-is-not-launch-ready"));

const oldStarter = paymentLink({
  id: "plink_old_starter",
  amount: 9900,
});
const extraStarter = evaluateFirstDollarPaymentLinkDiscovery({
  described: [canonical, oldStarter],
  configuredUrls: { starter: canonical.url },
});
assert.equal(extraStarter.ok, false, "an extra active noncanonical Starter must block exclusivity");
assert.ok(extraStarter.activeLinksRequiringResolution.some((link) => link.id === oldStarter.id));
assert.ok(extraStarter.blockers.includes("active-smirk-payment-links-require-resolution"));

const oldPro = paymentLink({
  id: "plink_old_pro",
  amount: 39700,
  plan: "pro",
});
const broaderPlan = evaluateFirstDollarPaymentLinkDiscovery({
  described: [canonical, oldPro],
  configuredUrls: { starter: canonical.url },
});
assert.equal(broaderPlan.ok, false, "an active Pro link must block first-dollar exclusivity");
assert.ok(broaderPlan.activeLinksRequiringResolution.some((link) => link.id === oldPro.id));

const unrelatedInactive = paymentLink({
  id: "plink_inactive_old",
  amount: 9900,
  active: false,
});
const inactiveIgnored = evaluateFirstDollarPaymentLinkDiscovery({
  described: [canonical, unrelatedInactive],
  configuredUrls: { starter: canonical.url },
});
assert.equal(inactiveIgnored.ok, true, "inactive historical links must not block active exclusivity");

console.log("OK first-dollar Payment Link discovery fails closed on ambiguity, incomplete checkout, configured price drift, extra Starter links, and broader active plans");
