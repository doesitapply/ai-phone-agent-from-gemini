import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProspectMessagePolicySchema,
  buildProspectMessagePolicyReceipt,
  buildProspectMessagePolicyRelease,
  hashProspectMessagePolicyValue,
  prospectMessagePolicyReleaseSchema,
  rollbackProspectMessagePolicySchema,
} from "../src/prospect-message-policy.ts";

const controls = {
  nextExperimentControlOnly: true as const,
  existingJobsChanged: false as const,
  contactAuthorized: false as const,
  executionAuthorized: false as const,
  spendAuthorized: false as const,
};

test("an approved promotion produces one immutable next-experiment receipt", () => {
  const release = buildProspectMessagePolicyRelease({
    releaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId: 1,
    campaignId: 7,
    channel: "email",
    version: 1,
    action: "PROMOTE",
    championVariantKey: "owner-language-v2",
    previousChampionVariantKey: "owner-language-v1",
    sourceCandidate: {
      id: 11,
      candidateKey:
        "experiment:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      version: 1,
      experimentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      experimentDefinitionHash: "1".repeat(64),
      proposalHash: "2".repeat(64),
      sampleSize: 20,
    },
    rollbackOfReleaseId: null,
    reason: null,
    appliedBy: "dashboard_operator",
    appliedAt: "2026-07-30T20:00:00.000Z",
    attestations: {
      approvedCandidateReviewed: true,
      measuredEvidenceReviewed: true,
      futureExperimentsOnly: true,
      noContactOrSpendAuthorized: true,
    },
    controls,
  });
  const releaseHash = hashProspectMessagePolicyValue(release);
  const receipt = buildProspectMessagePolicyReceipt({
    release,
    releaseHash,
  });

  assert.equal(release.action, "PROMOTE");
  assert.equal(release.controls.contactAuthorized, false);
  assert.equal(receipt.championVariantKey, "owner-language-v2");
  assert.equal(receipt.releaseHash, releaseHash);
  assert.notEqual(
    hashProspectMessagePolicyValue({
      ...release,
      championVariantKey: "owner-language-v1",
    }),
    releaseHash
  );
});

test("rollback is append-only and restores the reviewed previous control", () => {
  const release = buildProspectMessagePolicyRelease({
    releaseId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    workspaceId: 1,
    campaignId: 7,
    channel: "email",
    version: 2,
    action: "ROLLBACK",
    championVariantKey: "owner-language-v1",
    previousChampionVariantKey: "owner-language-v2",
    sourceCandidate: null,
    rollbackOfReleaseId:
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    reason: "Restore the prior measured control.",
    appliedBy: "dashboard_operator",
    appliedAt: "2026-07-30T21:00:00.000Z",
    attestations: {
      currentPolicyReviewed: true,
      rollbackTargetReviewed: true,
      futureExperimentsOnly: true,
      noContactOrSpendAuthorized: true,
    },
    controls,
  });

  assert.equal(release.action, "ROLLBACK");
  assert.equal(release.version, 2);
  assert.equal(release.championVariantKey, "owner-language-v1");
  assert.equal(release.sourceCandidate, null);
});

test("policy authority is exact and cannot be inferred from partial input", () => {
  assert.equal(
    applyProspectMessagePolicySchema.safeParse({
      proposalHash: "2".repeat(64),
      confirmation: "apply-one-approved-message-policy-v1",
      attestations: {
        approvedCandidateReviewed: true,
        measuredEvidenceReviewed: true,
        futureExperimentsOnly: true,
        noContactOrSpendAuthorized: true,
      },
    }).success,
    true
  );
  assert.equal(
    applyProspectMessagePolicySchema.safeParse({
      proposalHash: "2".repeat(64),
      confirmation: "approve",
      attestations: {
        approvedCandidateReviewed: true,
        measuredEvidenceReviewed: true,
        futureExperimentsOnly: true,
        noContactOrSpendAuthorized: true,
      },
    }).success,
    false
  );
  assert.equal(
    rollbackProspectMessagePolicySchema.safeParse({
      releaseHash: "3".repeat(64),
      reason: "Restore reviewed control.",
      confirmation: "rollback-one-message-policy-v1",
      attestations: {
        currentPolicyReviewed: true,
        rollbackTargetReviewed: true,
        futureExperimentsOnly: true,
        noContactOrSpendAuthorized: true,
      },
    }).success,
    true
  );
  assert.equal(
    prospectMessagePolicyReleaseSchema.safeParse({
      action: "PROMOTE",
    }).success,
    false
  );
});
