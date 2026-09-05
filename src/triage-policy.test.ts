import assert from "node:assert/strict";
import test from "node:test";
import { buildDecisionReadyIncidents, type RecoveryTriageCandidate } from "./triage-policy.js";

const base = (overrides: Partial<RecoveryTriageCandidate> = {}): RecoveryTriageCandidate => ({
  callSid: "CA_test_1",
  startedAt: "2026-08-22T18:00:00.000Z",
  fromNumber: "+17753863205",
  contactName: null,
  durationSeconds: 8,
  turnCount: 0,
  recoveryCallbackStartedAt: null,
  recoveryClosedAt: null,
  recoveryStatus: "open",
  outcome: null,
  summary: null,
  nextAction: null,
  sentiment: null,
  ...overrides,
});

test("routes an incomplete missed call to review instead of P0 callback work", () => {
  const [incident] = buildDecisionReadyIncidents([base()]);

  assert.equal(incident.priority, "P2");
  assert.equal(incident.action, "review");
  assert.equal(incident.kind, "capture_review");
  assert.equal(incident.label, "Call capture incomplete — review");
  assert.match(incident.detail, /do not treat this as an automatic callback instruction/);
});

test("keeps an explicit callback outcome with conversation evidence as P0 recovery work", () => {
  const [incident] = buildDecisionReadyIncidents([base({
    turnCount: 4,
    outcome: "callback_needed",
    summary: "Caller asked for an afternoon callback about an HVAC repair.",
    nextAction: "Call after 2 PM.",
  })]);

  assert.equal(incident.priority, "P0");
  assert.equal(incident.action, "recovery");
  assert.equal(incident.kind, "recovery");
  assert.equal(incident.label, "Callback requested");
});

test("collapses nearby repeat attempts from the same caller into one review decision", () => {
  const incidents = buildDecisionReadyIncidents([
    base({ callSid: "CA_new", startedAt: "2026-08-22T18:02:00.000Z" }),
    base({ callSid: "CA_middle", startedAt: "2026-08-22T18:01:00.000Z" }),
    base({ callSid: "CA_old", startedAt: "2026-08-22T18:00:00.000Z" }),
  ]);

  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].duplicateCount, 3);
  assert.equal(incidents[0].priority, "P2");
  assert.equal(incidents[0].action, "review");
  assert.match(incidents[0].label, /3 repeat missed calls/);
});
