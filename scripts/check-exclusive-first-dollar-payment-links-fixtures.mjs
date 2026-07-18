#!/usr/bin/env node
import assert from "node:assert/strict";
import { verifyExclusiveActiveFirstDollarPaymentLink } from "./lib/exclusive-first-dollar-payment-links.mjs";

const starterId = "plink_live_starter_fixture";
const productNames = {
  starter: "SMIRK AI Starter",
  pro: "SMIRK AI Pro",
  enterprise: "SMIRK AI Agency",
  legacy_enterprise: "SMIRK AI Enterprise",
  unrelated: "Unrelated Product",
};

function link(id, plan, metadata = {}, extra = {}) {
  return { id, active: true, livemode: true, metadata, subscription_data: { metadata: {} }, fixturePlan: plan, ...extra };
}

function stripeFixture(links, { lineItemFailureFor = null, historicalStates = {}, paginatedLineItems = {}, activePages = null } = {}) {
  return {
    paymentLinks: {
      async list(params = {}) {
        if (!activePages) return { data: links, has_more: false };
        return params.starting_after ? activePages[1] : activePages[0];
      },
      async retrieve(id) {
        return historicalStates[id] || links.find((entry) => entry.id === id) || null;
      },
      async listLineItems(id, params = {}) {
        if (id === lineItemFailureFor) throw Object.assign(new Error("fixture read failed"), { code: "fixture_error" });
        const current = links.find((entry) => entry.id === id);
        const pages = paginatedLineItems[id];
        if (pages) {
          const pageIndex = params.starting_after ? Number(String(params.starting_after).split("_").at(-1)) : 0;
          return pages[pageIndex];
        }
        const amounts = { starter: 19700, pro: 39700, enterprise: 69700, legacy_enterprise: 149900 };
        return {
          data: [{
            id: `li_${id}_0`,
            price: {
              unit_amount: current?.fixtureAmount ?? amounts[current?.fixturePlan],
              currency: "usd",
              recurring: { interval: "month", interval_count: 1 },
              product: { name: productNames[current?.fixturePlan || "unrelated"] },
            },
          }],
          has_more: false,
        };
      },
    },
  };
}

const exclusive = await verifyExclusiveActiveFirstDollarPaymentLink({
  stripe: stripeFixture([link(starterId, "starter"), link("plink_unrelated", "unrelated")]),
  expectedStarterId: starterId,
  approvedFulfillmentIds: [starterId],
});
assert.equal(exclusive.ok, true, "one canonical Starter plus unrelated Stripe links must pass");

for (const [label, legacy] of [
  ["old Starter", link("plink_old_starter", "starter")],
  ["old Pro", link("plink_old_pro", "pro")],
  ["old Agency", link("plink_old_agency", "enterprise")],
]) {
  const result = await verifyExclusiveActiveFirstDollarPaymentLink({
    stripe: stripeFixture([link(starterId, "starter"), legacy]),
    expectedStarterId: starterId,
    approvedFulfillmentIds: [starterId],
  });
  assert.equal(result.ok, false, `${label} must remain a blocker until provider-side deactivation`);
  assert.ok(result.blockers.some((blocker) => blocker.includes(`:${legacy.id}`)));
}

const conflicting = await verifyExclusiveActiveFirstDollarPaymentLink({
  stripe: stripeFixture([link(starterId, "starter", {
    plan: "pro",
    smirk_customer_policy_version: "fixture-policy-v1",
  })]),
  expectedStarterId: starterId,
  approvedFulfillmentIds: [starterId],
});
assert.equal(conflicting.ok, false, "conflicting SMIRK plan markers must fail closed");

const unclassifiedProductMarker = link("plink_unclassified_smirk_marker", "unrelated", {
  smirk_product: "missed_call_recovery",
});
const unclassifiedProductMarkerResult = await verifyExclusiveActiveFirstDollarPaymentLink({
  stripe: stripeFixture([link(starterId, "starter"), unclassifiedProductMarker]),
  expectedStarterId: starterId,
  approvedFulfillmentIds: [starterId],
});
assert.equal(unclassifiedProductMarkerResult.ok, false, "a SMIRK product marker without a valid plan must fail closed after mutable names are removed");
assert.ok(unclassifiedProductMarkerResult.blockers.some((blocker) => blocker.includes(unclassifiedProductMarker.id)));

const providerFailure = await verifyExclusiveActiveFirstDollarPaymentLink({
  stripe: stripeFixture([link(starterId, "starter")], { lineItemFailureFor: starterId }),
  expectedStarterId: starterId,
  approvedFulfillmentIds: [starterId],
});
assert.equal(providerFailure.ok, false, "incomplete Stripe inspection must fail closed");
assert.equal(providerFailure.reason, "active-payment-link-provider-read-failed");

const legacyEnterprise = link("plink_legacy_enterprise", "legacy_enterprise");
const legacyEnterpriseResult = await verifyExclusiveActiveFirstDollarPaymentLink({
  stripe: stripeFixture([link(starterId, "starter"), legacyEnterprise]),
  expectedStarterId: starterId,
  approvedFulfillmentIds: [starterId],
});
assert.equal(legacyEnterpriseResult.ok, false, "known legacy SMIRK AI Enterprise links must never be classified as unrelated");
assert.ok(legacyEnterpriseResult.blockers.some((blocker) => blocker.includes(legacyEnterprise.id)));

const renamedLegacyPro = link("plink_renamed_legacy_pro", "unrelated", {}, { fixtureAmount: 39700 });
const renamedLegacyProResult = await verifyExclusiveActiveFirstDollarPaymentLink({
  stripe: stripeFixture([link(starterId, "starter"), renamedLegacyPro]),
  expectedStarterId: starterId,
  approvedFulfillmentIds: [starterId],
});
assert.equal(renamedLegacyProResult.ok, false, "an old monthly Pro link must remain detectable by canonical amount after its mutable product name and metadata are stripped");
assert.ok(renamedLegacyProResult.blockers.some((blocker) => blocker.includes(renamedLegacyPro.id)));

for (const [legacyPlan, legacyAmount] of [["Starter", 29900], ["Pro", 59900]]) {
  const legacyId = `plink_renamed_legacy_${legacyPlan.toLowerCase()}_price`;
  const result = await verifyExclusiveActiveFirstDollarPaymentLink({
    stripe: stripeFixture([link(starterId, "starter"), link(legacyId, "unrelated", {}, { fixtureAmount: legacyAmount })]),
    expectedStarterId: starterId,
    approvedFulfillmentIds: [starterId],
  });
  assert.equal(result.ok, false, `a renamed legacy $${legacyAmount / 100} ${legacyPlan} link must remain detectable after mutable markers are stripped`);
  assert.ok(result.blockers.some((blocker) => blocker.includes(legacyId)));
}

const paginatedLegacyAgencyId = "plink_paginated_legacy_agency";
const paginatedLegacyAgency = link(paginatedLegacyAgencyId, "unrelated");
const paginatedLegacyAgencyResult = await verifyExclusiveActiveFirstDollarPaymentLink({
  stripe: stripeFixture([link(starterId, "starter"), paginatedLegacyAgency], {
    paginatedLineItems: {
      [paginatedLegacyAgencyId]: [
        { data: [{ id: "li_page_1", price: { unit_amount: 1234, currency: "usd", recurring: { interval: "month", interval_count: 1 }, product: { name: "Unrelated Product" } } }], has_more: true },
        { data: [{ id: "li_page_2", price: { unit_amount: 69700, currency: "usd", recurring: { interval: "month", interval_count: 1 }, product: { name: "Renamed Product" } } }], has_more: false },
      ],
    },
  }),
  expectedStarterId: starterId,
  approvedFulfillmentIds: [starterId],
});
assert.equal(paginatedLegacyAgencyResult.ok, false, "SMIRK markers after the first line-item page must remain visible to the exclusivity scan");
assert.ok(paginatedLegacyAgencyResult.blockers.some((blocker) => blocker.includes(paginatedLegacyAgencyId)));

const secondPageLegacyPro = link("plink_second_page_legacy_pro", "pro");
const secondActivePageResult = await verifyExclusiveActiveFirstDollarPaymentLink({
  stripe: stripeFixture([link(starterId, "starter"), secondPageLegacyPro], {
    activePages: [
      { data: [link(starterId, "starter")], has_more: true },
      { data: [secondPageLegacyPro], has_more: false },
    ],
  }),
  expectedStarterId: starterId,
  approvedFulfillmentIds: [starterId],
});
assert.equal(secondActivePageResult.ok, false, "an old SMIRK link on the second active-link page must remain visible to the exclusivity scan");
assert.ok(secondActivePageResult.blockers.some((blocker) => blocker.includes(secondPageLegacyPro.id)));

const boundedActivePageResult = await verifyExclusiveActiveFirstDollarPaymentLink({
  stripe: stripeFixture([link(starterId, "starter")], {
    activePages: [
      { data: [link(starterId, "starter")], has_more: true },
      { data: [], has_more: true },
    ],
  }),
  expectedStarterId: starterId,
  approvedFulfillmentIds: [starterId],
  maxPages: 1,
});
assert.equal(boundedActivePageResult.ok, false, "a truncated active-link scan must fail closed at its explicit page bound");
assert.ok(boundedActivePageResult.blockers.includes("active-payment-link-scan-limit-exceeded"));

const malformedCurrentState = await verifyExclusiveActiveFirstDollarPaymentLink({
  stripe: stripeFixture([link(starterId, "starter", {}, { active: false })]),
  expectedStarterId: starterId,
  approvedFulfillmentIds: [starterId],
});
assert.equal(malformedCurrentState.ok, false, "the listed current Starter must explicitly be active and live-mode");
assert.ok(malformedCurrentState.blockers.includes(`active-payment-link-state-invalid:${starterId}`));

const priorId = "plink_prior_starter_fixture";
const inactiveHistorical = await verifyExclusiveActiveFirstDollarPaymentLink({
  stripe: stripeFixture([link(starterId, "starter")], {
    historicalStates: { [priorId]: { id: priorId, livemode: true, active: false } },
  }),
  expectedStarterId: starterId,
  approvedFulfillmentIds: [priorId, starterId],
});
assert.equal(inactiveHistorical.ok, true, "an exact inactive historical Starter ID may remain allowlisted for already-open paid Sessions");

const activeRenamedHistorical = await verifyExclusiveActiveFirstDollarPaymentLink({
  stripe: stripeFixture([link(starterId, "starter")], {
    historicalStates: { [priorId]: { id: priorId, livemode: true, active: true } },
  }),
  expectedStarterId: starterId,
  approvedFulfillmentIds: [priorId, starterId],
});
assert.equal(activeRenamedHistorical.ok, false, "every exact historical allowlist ID must be provider-inactive even if its product markers were renamed");
assert.ok(activeRenamedHistorical.blockers.includes(`historical-payment-link-still-active:${priorId}`));

console.log("OK exclusive first-dollar Payment Link proof rejects active renamed, paginated, old Starter, Pro, Agency, and legacy Enterprise links while preserving only exact inactive historical fulfillment IDs");
