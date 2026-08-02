import assert from "node:assert/strict";
import test from "node:test";
import { prepareProspectOutreachSchema } from "../src/prospect-outreach.ts";
import { buildProspectMessageContext } from "../src/prospect-message-variants.ts";
import { buildProspectQcReceipt } from "../src/prospect-qc.ts";
import {
  buildProspectQcRevisionFingerprint,
  buildProspectQcRevisionPayload,
  hashProspectQcRevisionPayload,
  prospectQcRevisionPayloadSchema,
} from "../src/prospect-qc-revision.ts";

const evidenceHash = "e".repeat(64);
const emailCompliance = {
  senderIdentity: "SMIRK",
  advertisementDisclosure: "This is a commercial message from SMIRK.",
  physicalPostalAddress: "1605 McKinley Drive, Reno, NV 89509",
  optOutInstructions:
    "If this is not relevant, reply no and I will not follow up.",
};
const context = buildProspectMessageContext({
  businessName: "Silver State Home Services Demo",
  industry: "plumbing",
  researchEvidence: [
    {
      kind: "contact_path",
      basis: "observed",
      observation: "The public page offers emergency service contact.",
    },
  ],
});

function failedDraft() {
  return prepareProspectOutreachSchema.parse({
    channel: "email",
    subject: "quick question [Company]",
    body:
      "Hi {{first_name}} - Cameron with SMIRK. How are after-hours calls handled?",
    emailCompliance,
    variantKey: "micro-after-hours-v1",
    maxCostCents: 2,
    expiresInHours: 24,
  });
}

function revisionAt(preparedAt: string) {
  const draft = failedDraft();
  if (draft.channel !== "email") {
    throw new Error("Synthetic revision fixture must remain email-only.");
  }
  const qcReceipt = buildProspectQcReceipt({
    draft,
    context,
    evidenceHash,
    evaluatedAt: preparedAt,
  });
  assert.equal(qcReceipt.verdict, "REVISION_REQUIRED");
  return buildProspectQcRevisionPayload({
    workspaceId: 7,
    campaignId: 2,
    prospectId: 3,
    channel: "email",
    recipient: "owner@example.invalid",
    subject: draft.subject,
    content: draft.body,
    variantKey: draft.variantKey,
    evidenceHash,
    emailCompliance,
    maxCostCents: draft.maxCostCents,
    expiresInHours: draft.expiresInHours,
    qcReceipt,
    preparedAt,
  });
}

function fingerprintFor(
  revision: ReturnType<typeof revisionAt>
): string {
  return buildProspectQcRevisionFingerprint({
    workspaceId: revision.workspaceId,
    campaignId: revision.campaignId,
    prospectId: revision.prospectId,
    channel: revision.channel,
    recipient: revision.recipient,
    subject: revision.subject,
    content: revision.content,
    variantKey: revision.variantKey,
    evidenceHash: revision.evidenceHash,
    emailCompliance: revision.emailCompliance,
    maxCostCents: revision.maxCostCents,
    expiresInHours: revision.expiresInHours,
    qcReceipt: revision.qcReceipt,
    experimentAssignment: revision.experimentAssignment,
  });
}

test("failed deterministic QC creates an immutable non-executable revision receipt", () => {
  const revision = revisionAt("2026-08-01T16:00:00.000Z");
  assert.equal(revision.qcReceipt.deterministicPassed, false);
  assert.match(
    revision.qcReceipt.failureReasons.join("\n"),
    /PLACEHOLDERS_RESOLVED/
  );
  assert.deepEqual(revision.controls, {
    humanReviewRequired: true,
    approvalAuthorized: false,
    contactAuthorized: false,
    executionAuthorized: false,
    modelReviewAuthorized: false,
    providerRequestAuthorized: false,
    smsAllowed: false,
    automatedDialingAllowed: false,
  });
  assert.match(hashProspectQcRevisionPayload(revision), /^[a-f0-9]{64}$/);
});

test("revision fingerprints deduplicate the same failed bytes across attempts", () => {
  const first = revisionAt("2026-08-01T16:00:00.000Z");
  const replay = revisionAt("2026-08-01T16:05:00.000Z");
  assert.notEqual(first.revisionId, replay.revisionId);
  assert.notEqual(
    hashProspectQcRevisionPayload(first),
    hashProspectQcRevisionPayload(replay)
  );
  assert.equal(fingerprintFor(first), fingerprintFor(replay));

  const changed = {
    ...replay,
    content: `${replay.content} Changed copy.`,
  };
  assert.notEqual(
    fingerprintFor(first),
    buildProspectQcRevisionFingerprint({
      workspaceId: changed.workspaceId,
      campaignId: changed.campaignId,
      prospectId: changed.prospectId,
      channel: changed.channel,
      recipient: changed.recipient,
      subject: changed.subject,
      content: changed.content,
      variantKey: changed.variantKey,
      evidenceHash: changed.evidenceHash,
      emailCompliance: changed.emailCompliance,
      maxCostCents: changed.maxCostCents,
      expiresInHours: changed.expiresInHours,
      qcReceipt: changed.qcReceipt,
      experimentAssignment: changed.experimentAssignment,
    })
  );
});

test("revision schema rejects passing receipts, changed copy, stale time, or widened authority", () => {
  const revision = revisionAt("2026-08-01T16:00:00.000Z");
  const passingDraft = prepareProspectOutreachSchema.parse({
    channel: "email",
    subject: "After-hours call volume",
    body:
      "Cameron with SMIRK. We build overflow phone systems for local trade contractors.",
    emailCompliance,
    variantKey: "operator-v1",
    maxCostCents: 2,
    expiresInHours: 24,
  });
  const passingReceipt = buildProspectQcReceipt({
    draft: passingDraft,
    context,
    evidenceHash,
    evaluatedAt: revision.preparedAt,
  });
  assert.equal(passingReceipt.deterministicPassed, true);

  for (const forged of [
    { ...revision, qcReceipt: passingReceipt },
    { ...revision, content: `${revision.content} Changed.` },
    { ...revision, preparedAt: "2026-08-01T16:05:00.000Z" },
    {
      ...revision,
      controls: { ...revision.controls, contactAuthorized: true },
    },
  ]) {
    assert.equal(prospectQcRevisionPayloadSchema.safeParse(forged).success, false);
  }
});
