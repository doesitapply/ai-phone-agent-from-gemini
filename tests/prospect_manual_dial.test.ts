import assert from "node:assert/strict";
import test from "node:test";
import {
  getProspectManualDialAvailability,
  type ProspectManualDialReceipt,
} from "../src/prospect-manual-dial.ts";

const receipt: ProspectManualDialReceipt = {
  recipient: "+12025550124",
  recipientTimezone: "America/Los_Angeles",
  checkedAt: "2026-08-01T16:00:00.000Z",
  validUntil: "2026-08-02T16:00:00.000Z",
  dncChecks: [
    {
      scope: "federal",
      status: "clear",
      source: "Synthetic federal fixture",
      reference: "federal-fixture-001",
    },
    {
      scope: "state",
      status: "clear",
      source: "Synthetic state fixture",
      reference: "state-fixture-001",
    },
    {
      scope: "internal",
      status: "clear",
      source: "Synthetic internal fixture",
      reference: "internal-fixture-001",
    },
  ],
  callingWindow: { start: "09:00", end: "17:00" },
  manualDialOnly: true,
  contactAuthorizedByReceipt: false,
  automatedDialingAuthorized: false,
};

test("an approved in-window call exposes only a manual tel handoff", () => {
  const result = getProspectManualDialAvailability({
    recipient: "+12025550124",
    receipt,
    now: new Date("2026-08-01T18:15:00.000Z"),
  });

  assert.equal(result.eligible, true);
  assert.equal(result.code, "ELIGIBLE");
  assert.equal(result.localTime, "2026-08-01 11:15");
  assert.equal(result.href, "tel:+12025550124");
  assert.equal(result.contactAuthorized, false);
  assert.equal(result.automatedDialingAuthorized, false);
});

test("the dial handoff closes outside 09:00-17:00 recipient local time", () => {
  const before = getProspectManualDialAvailability({
    recipient: "+12025550124",
    receipt,
    now: new Date("2026-08-01T15:59:00.000Z"),
  });
  const atEnd = getProspectManualDialAvailability({
    recipient: "+12025550124",
    receipt,
    now: new Date("2026-08-02T00:00:00.000Z"),
  });

  assert.equal(before.code, "RECEIPT_NOT_YET_VALID");
  assert.equal(atEnd.code, "OUTSIDE_CALLING_WINDOW");
  assert.equal(atEnd.localTime, "2026-08-01 17:00");
  assert.equal(atEnd.href, null);
});

test("invalid recipients and incomplete DNC scope receipts fail closed", () => {
  const invalidRecipient = getProspectManualDialAvailability({
    recipient: "202-555-0124;pause",
    receipt,
    now: new Date("2026-08-01T18:15:00.000Z"),
  });
  const missingScope = getProspectManualDialAvailability({
    recipient: "+12025550124",
    receipt: {
      ...receipt,
      dncChecks: receipt.dncChecks.slice(0, 2),
    },
    now: new Date("2026-08-01T18:15:00.000Z"),
  });
  const changedBinding = getProspectManualDialAvailability({
    recipient: "+12025550125",
    receipt,
    now: new Date("2026-08-01T18:15:00.000Z"),
  });

  assert.equal(invalidRecipient.code, "INVALID_RECIPIENT");
  assert.equal(missingScope.code, "INVALID_RECEIPT");
  assert.equal(changedBinding.code, "INVALID_RECEIPT");
  assert.equal(invalidRecipient.href, null);
  assert.equal(missingScope.href, null);
  assert.equal(changedBinding.href, null);
});

test("future, expired, and malformed receipt clocks never expose a dial link", () => {
  const future = getProspectManualDialAvailability({
    recipient: "+12025550124",
    receipt,
    now: new Date("2026-08-01T15:59:59.000Z"),
  });
  const expired = getProspectManualDialAvailability({
    recipient: "+12025550124",
    receipt,
    now: new Date("2026-08-02T16:00:00.001Z"),
  });
  const malformed = getProspectManualDialAvailability({
    recipient: "+12025550124",
    receipt: { ...receipt, validUntil: "not-a-date" },
    now: new Date("2026-08-01T18:15:00.000Z"),
  });
  const widenedValidity = getProspectManualDialAvailability({
    recipient: "+12025550124",
    receipt: { ...receipt, validUntil: "2026-08-03T16:00:00.001Z" },
    now: new Date("2026-08-01T18:15:00.000Z"),
  });

  assert.equal(future.code, "RECEIPT_NOT_YET_VALID");
  assert.equal(expired.code, "RECEIPT_EXPIRED");
  assert.equal(malformed.code, "INVALID_RECEIPT");
  assert.equal(widenedValidity.code, "INVALID_RECEIPT");
  assert.equal(future.href, null);
  assert.equal(expired.href, null);
  assert.equal(malformed.href, null);
  assert.equal(widenedValidity.href, null);
});

test("receipt authority cannot be widened into dialing eligibility", () => {
  const widened = getProspectManualDialAvailability({
    recipient: "+12025550124",
    receipt: {
      ...receipt,
      automatedDialingAuthorized: true,
    } as unknown as ProspectManualDialReceipt,
    now: new Date("2026-08-01T18:15:00.000Z"),
  });

  assert.equal(widened.code, "INVALID_RECEIPT");
  assert.equal(widened.href, null);
});
