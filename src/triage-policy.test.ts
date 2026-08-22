import { describe, expect, it } from "vitest";
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

describe("buildDecisionReadyIncidents", () => {
  it("routes an incomplete missed call to review instead of P0 callback work", () => {
    const [incident] = buildDecisionReadyIncidents([base()]);

    expect(incident).toMatchObject({
      priority: "P2",
      action: "review",
      kind: "capture_review",
      label: "Call capture incomplete — review",
    });
    expect(incident.detail).toContain("do not treat this as an automatic callback instruction");
  });

  it("keeps an explicit callback outcome with conversation evidence as P0 recovery work", () => {
    const [incident] = buildDecisionReadyIncidents([base({
      turnCount: 4,
      outcome: "callback_needed",
      summary: "Caller asked for an afternoon callback about an HVAC repair.",
      nextAction: "Call after 2 PM.",
    })]);

    expect(incident).toMatchObject({
      priority: "P0",
      action: "recovery",
      kind: "recovery",
      label: "Callback requested",
    });
  });

  it("collapses nearby repeat attempts from the same caller into one review decision", () => {
    const incidents = buildDecisionReadyIncidents([
      base({ callSid: "CA_new", startedAt: "2026-08-22T18:02:00.000Z" }),
      base({ callSid: "CA_middle", startedAt: "2026-08-22T18:01:00.000Z" }),
      base({ callSid: "CA_old", startedAt: "2026-08-22T18:00:00.000Z" }),
    ]);

    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      duplicateCount: 3,
      priority: "P2",
      action: "review",
    });
    expect(incidents[0].label).toContain("3 repeat missed calls");
  });
});
