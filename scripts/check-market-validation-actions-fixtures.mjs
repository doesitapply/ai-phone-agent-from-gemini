#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildMarketValidationNextActions } from "./lib/market-validation-actions.mjs";

const baseInput = {
  traction: {
    companies: 200,
    touches: 0,
    checkout_starts: 0,
    paid_activations: 0,
  },
  ledgerSummary: {
    blocked_activation_count: 0,
  },
  prospectReadiness: {
    execution_ready_prospects: 20,
  },
  spendGate: {
    paid_spend_allowed: false,
  },
};

function hasAction(actions, pattern) {
  return actions.some((action) => pattern.test(action));
}

const staleProduction = buildMarketValidationNextActions({
  ...baseInput,
  liveCurrent: false,
  selectedLedgerAlignment: { ok: true },
});
assert.equal(hasAction(staleProduction, /production is not running the current guarded Velvet -> SMIRK loop/), true);
assert.equal(hasAction(staleProduction, /Prepare a narrow exact-approval packet/), false);
assert.equal(hasAction(staleProduction, /first 200 human-reviewed manual touches/), false);

const liveWithDrift = buildMarketValidationNextActions({
  ...baseInput,
  liveCurrent: true,
  selectedLedgerAlignment: { ok: false },
});
assert.equal(hasAction(liveWithDrift, /Reconcile the exact 20 locally execution-ready prospect/), true);
assert.equal(hasAction(liveWithDrift, /Prepare a narrow exact-approval packet/), false);
assert.equal(hasAction(liveWithDrift, /first 200 human-reviewed manual touches/), false);

const liveAndAligned = buildMarketValidationNextActions({
  ...baseInput,
  liveCurrent: true,
  selectedLedgerAlignment: { ok: true },
});
assert.equal(hasAction(liveAndAligned, /Prepare a narrow exact-approval packet/), true);
assert.equal(hasAction(liveAndAligned, /After exact owner approval/), true);
assert.equal(hasAction(liveAndAligned, /production is not running the current guarded Velvet -> SMIRK loop/), false);

const noReadyProspects = buildMarketValidationNextActions({
  ...baseInput,
  prospectReadiness: { execution_ready_prospects: 0 },
  liveCurrent: true,
  selectedLedgerAlignment: { ok: true },
});
assert.equal(hasAction(noReadyProspects, /Verify a direct public contact path/), true);
assert.equal(hasAction(noReadyProspects, /Prepare a narrow exact-approval packet/), false);
assert.equal(hasAction(noReadyProspects, /first 200 human-reviewed manual touches/), false);

console.log(JSON.stringify({
  ok: true,
  fixtures: 4,
  assertions: 12,
  proves: [
    "stale production pauses outbound preparation and execution",
    "exact selected-prospect reconciliation is required before packet preparation",
    "touch progression is named only after exact owner approval",
    "zero execution-ready prospects remain evidence-gated",
  ],
}, null, 2));
