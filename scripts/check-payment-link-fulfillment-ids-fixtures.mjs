#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  candidateStarterPaymentLinkFulfillmentIds,
  evaluateStarterPaymentLinkFulfillmentIds,
} from "../src/payment-link-fulfillment-ids.js";

const currentId = "plink_current_starter_fixture";
const currentOnly = evaluateStarterPaymentLinkFulfillmentIds({ currentId, rawIds: currentId });
assert.equal(currentOnly.ready, true, "the explicit current Starter ID must be sufficient for a first cutover");

const rotated = evaluateStarterPaymentLinkFulfillmentIds({
  currentId,
  rawIds: `plink_prior_starter_fixture,${currentId}`,
});
assert.equal(rotated.ready, true, "a bounded exact prior-ID allowlist must preserve already-open paid Sessions after rotation");
assert.deepEqual(rotated.ids, ["plink_prior_starter_fixture", currentId]);

for (const [label, rawIds, blocker] of [
  ["missing allowlist", "", "starter-fulfillment-payment-link-ids-missing"],
  ["current ID omitted", "plink_prior_starter_fixture", "starter-current-payment-link-id-not-allowlisted"],
  ["invalid ID", `${currentId},not-a-plink`, "starter-fulfillment-payment-link-id-invalid"],
  ["duplicate ID", `${currentId},${currentId}`, "starter-fulfillment-payment-link-id-duplicate"],
]) {
  const result = evaluateStarterPaymentLinkFulfillmentIds({ currentId, rawIds });
  assert.equal(result.ready, false, `${label} must fail closed`);
  assert.ok(result.blockers.includes(blocker));
  assert.deepEqual(result.ids, [], `${label} must never return a partial authority list`);
}

const tooManyIds = Array.from({ length: 21 }, (_, index) => `plink_starter_history_${index}`).join(",");
const overBound = evaluateStarterPaymentLinkFulfillmentIds({
  currentId: "plink_starter_history_0",
  rawIds: tooManyIds,
});
assert.equal(overBound.ready, false, "more than 20 exact IDs must exceed the bounded rotation window");
assert.ok(overBound.blockers.includes("starter-fulfillment-payment-link-ids-too-many"));
assert.deepEqual(overBound.ids, []);

const invalidCurrent = evaluateStarterPaymentLinkFulfillmentIds({
  currentId: "not-a-current-plink",
  rawIds: currentId,
});
assert.equal(invalidCurrent.ready, false, "an invalid current ID must fail closed even when the list itself is well shaped");
assert.ok(invalidCurrent.blockers.includes("starter-current-payment-link-id-invalid"));
assert.deepEqual(invalidCurrent.ids, []);

assert.deepEqual(
  candidateStarterPaymentLinkFulfillmentIds({
    currentId,
    rawIds: `not-a-link,plink_prior_starter_fixture,${currentId},plink_prior_starter_fixture`,
  }),
  [currentId, "plink_prior_starter_fixture"],
  "rescue classification may recognize only bounded exact configured candidates without granting fulfillment authority",
);
assert.equal(
  candidateStarterPaymentLinkFulfillmentIds({
    currentId: "plink_starter_history_0",
    rawIds: tooManyIds,
  }).length,
  20,
  "rescue candidates must remain bounded even when malformed configuration contains too many IDs",
);

console.log("OK Starter fulfillment Payment Link ID allowlist is explicit, bounded, exact, and rotation-safe");
