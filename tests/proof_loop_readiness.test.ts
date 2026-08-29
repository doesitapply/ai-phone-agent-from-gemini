import assert from "node:assert/strict";
import { evaluateProofLoopReadiness } from "../src/proof-loop-readiness.ts";

const readyInputs = {
  databaseReady: true,
  aiReady: true,
  twilioReady: true,
  ownerAlertsReady: true,
  callbackReady: true,
  paymentReady: true,
};

assert.equal(evaluateProofLoopReadiness({ ...readyInputs, completeProofCalls: 0 }).status, "warn", "a ready system without proof evidence must not claim a proof pass");
assert.equal(evaluateProofLoopReadiness({ ...readyInputs, completeProofCalls: 1 }).status, "pass", "one complete evidence chain should verify the proof loop");
assert.equal(evaluateProofLoopReadiness({ ...readyInputs, ownerAlertsReady: false, completeProofCalls: 3 }).status, "fail", "missing a required dependency must fail proof readiness");

console.log("Proof-loop readiness checks passed (3 assertions).");
