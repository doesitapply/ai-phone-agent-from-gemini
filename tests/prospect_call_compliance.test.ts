import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProspectCallComplianceForExecution,
  buildProspectCallComplianceReceipt,
  prospectCallComplianceEvidenceSchema,
} from "../src/prospect-call-compliance.ts";

const base = {
  workspaceId: 1,
  approvalId: "11111111-1111-4111-8111-111111111111",
  outreachJobId: 7,
  leadId: 9,
  recipient: "+12025550124",
  actor: "operator:test",
  approvedAt: "2026-07-30T17:05:00.000Z",
  jobExpiresAt: "2026-07-31T02:00:00.000Z",
  evidence: {
    checkedAt: "2026-07-30T17:00:00.000Z",
    recipientTimezone: "America/Los_Angeles",
    dncChecks: [
      {
        scope: "federal" as const,
        status: "clear" as const,
        source: "Synthetic registry fixture",
        reference: "federal-fixture-001",
      },
      {
        scope: "state" as const,
        status: "clear" as const,
        source: "Synthetic registry fixture",
        reference: "state-fixture-001",
      },
      {
        scope: "internal" as const,
        status: "clear" as const,
        source: "SMIRK suppression fixture",
        reference: "internal-fixture-001",
      },
    ],
  },
};

test("a complete three-scope check produces a hash-bound inert receipt", () => {
  const built = buildProspectCallComplianceReceipt(base);
  assert.equal(built.receipt.manualDialOnly, true);
  assert.equal(built.receipt.contactAuthorizedByReceipt, false);
  assert.equal(built.receipt.automatedDialingAuthorized, false);
  assert.match(built.receiptHash, /^[a-f0-9]{64}$/);
  const execution = assertProspectCallComplianceForExecution({
    receipt: built.receipt,
    receiptHash: built.receiptHash,
    workspaceId: base.workspaceId,
    approvalId: base.approvalId,
    outreachJobId: base.outreachJobId,
    leadId: base.leadId,
    recipient: base.recipient,
    occurredAt: "2026-07-30T18:00:00.000Z",
    approvedBy: base.actor,
    approvedAt: base.approvedAt,
    jobExpiresAt: base.jobExpiresAt,
  });
  assert.equal(execution.localTime, "2026-07-30 11:00");
});

test("missing or duplicate DNC scopes are rejected", () => {
  assert.equal(
    prospectCallComplianceEvidenceSchema.safeParse({
      ...base.evidence,
      dncChecks: [
        base.evidence.dncChecks[0],
        base.evidence.dncChecks[0],
        base.evidence.dncChecks[2],
      ],
    }).success,
    false
  );
});

test("stale evidence and invalid timezones fail before approval", () => {
  assert.throws(
    () =>
      buildProspectCallComplianceReceipt({
        ...base,
        evidence: {
          ...base.evidence,
          checkedAt: "2026-07-29T16:59:59.000Z",
        },
      }),
    /more than 24 hours old/
  );
  assert.throws(
    () =>
      buildProspectCallComplianceReceipt({
        ...base,
        evidence: {
          ...base.evidence,
          recipientTimezone: "Not/A_Timezone",
        },
      }),
    /valid IANA/
  );
});

test("tampering, cross-tenant reuse, expiry, and calls outside 9-5 fail closed", () => {
  const built = buildProspectCallComplianceReceipt(base);
  const verify = (overrides: Record<string, unknown> = {}) =>
    assertProspectCallComplianceForExecution({
      receipt: built.receipt,
      receiptHash: built.receiptHash,
      workspaceId: base.workspaceId,
      approvalId: base.approvalId,
      outreachJobId: base.outreachJobId,
      leadId: base.leadId,
      recipient: base.recipient,
      occurredAt: "2026-07-30T18:00:00.000Z",
      approvedBy: base.actor,
      approvedAt: base.approvedAt,
      jobExpiresAt: base.jobExpiresAt,
      ...overrides,
    });
  assert.throws(() => verify({ workspaceId: 2 }), /another action/);
  assert.throws(
    () => verify({ approvedBy: "operator:other" }),
    /durable approval/
  );
  assert.throws(
    () => verify({ receiptHash: "0".repeat(64) }),
    /hash changed/
  );
  assert.throws(
    () => verify({ occurredAt: "2026-07-31T18:00:00.000Z" }),
    /validity window/
  );
  assert.throws(
    () => verify({ occurredAt: "2026-07-31T00:00:00.000Z" }),
    /09:00-17:00/
  );
});
