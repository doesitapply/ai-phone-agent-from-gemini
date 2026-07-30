import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertProspectOutcomeMatchesChannel,
  assertProspectOutreachApprovalAttestations,
  assertRecordedExecutionWindow,
  buildProspectOutreachPayload,
  canTransitionProspectOutreach,
  hashProspectEvidence,
  hashProspectOutreachPayload,
  isExactProspectOutcomeReplay,
  isExactRecordedExecutionReplay,
  isValidExecutionProofReference,
  prospectOutcomeSchema,
  prospectOutreachApprovalSchema,
} from "../src/prospect-outreach.ts";
import {
  buildProspectLearningScorecard,
  evaluateProspectLearningCandidate,
} from "../src/prospect-learning.ts";
import {
  buildVelvetOutcomePayload,
  hashVelvetOutcomePayload,
  signVelvetOutcomePayload,
} from "../src/velvet-outcome.ts";
import {
  buildVelvetResearchPayloadHash,
  velvetResearchPayloadSchema,
} from "../src/velvet-research.ts";
import {
  buildVelvetLeadSourceRequest,
  hashVelvetLeadSourceValue,
  validateVelvetLeadSourceResponse,
} from "../src/velvet-lead-source.ts";

const SYNTHETIC_NOW = new Date("2026-07-30T16:20:00.000Z");
const SYNTHETIC_PREPARED_AT = "2026-07-30T16:00:00.000Z";
const SYNTHETIC_APPROVED_AT = "2026-07-30T16:10:00.000Z";
const SYNTHETIC_EXECUTED_AT = "2026-07-30T16:15:00.000Z";
const SYNTHETIC_OUTCOME_AT = "2026-07-30T16:18:00.000Z";
const SYNTHETIC_SECRET =
  "synthetic-cross-repository-signing-secret-0001";
const SYNTHETIC_APPROVAL_ID =
  "11111111-1111-4111-8111-111111111111";

type GitState = {
  path: string;
  branch: string;
  commit: string;
  dirty: boolean;
};

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(
    prefix.length
  );
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readGitState(repo: string): GitState {
  return {
    path: repo,
    branch: git(repo, ["branch", "--show-current"]),
    commit: git(repo, ["rev-parse", "HEAD"]),
    dirty: Boolean(git(repo, ["status", "--porcelain"])),
  };
}

function requireModule(repo: string, relativePath: string): string {
  const modulePath = path.join(repo, relativePath);
  if (!existsSync(modulePath)) {
    throw new Error(`Required cross-repository module is missing: ${modulePath}`);
  }
  return pathToFileURL(modulePath).href;
}

function observationsForVariant(
  variantKey: string,
  positives: number
): Array<{
  channel: "email";
  variantKey: string;
  outcome: "replied" | "delivered";
}> {
  return Array.from({ length: 10 }, (_, index) => ({
    channel: "email" as const,
    variantKey,
    outcome: index < positives ? ("replied" as const) : ("delivered" as const),
  }));
}

function observationsForCategory(
  category: string,
  positives: number
): Array<{
  category: string;
  city: string;
  state: string;
  channel: "email";
  outcome: "replied" | "delivered";
}> {
  return Array.from({ length: 10 }, (_, index) => ({
    category,
    city: "Reno",
    state: "NV",
    channel: "email" as const,
    outcome: index < positives ? ("replied" as const) : ("delivered" as const),
  }));
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const smirkRepo = path.resolve(scriptDirectory, "..");
const velvetRepo = path.resolve(
  readArg("velvet-repo") ||
    process.env.VELVET_REPO_PATH ||
    path.join(smirkRepo, "..", "velvet-alchemy-landing")
);
const requireClean = process.argv.includes("--require-clean");
const smirkGit = readGitState(smirkRepo);
const velvetGit = readGitState(velvetRepo);

if (requireClean && (smirkGit.dirty || velvetGit.dirty)) {
  throw new Error(
    `A clean source pair is required (SMIRK dirty=${smirkGit.dirty}, Velvet dirty=${velvetGit.dirty}).`
  );
}

let networkAttempts = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  networkAttempts += 1;
  throw new Error(
    "Network access is forbidden in the synthetic closed-loop release gate."
  );
}) as typeof fetch;

try {
  const [
    velvetResearch,
    velvetOutcome,
    velvetLearning,
    velvetLeadBatch,
  ] = await Promise.all([
    import(requireModule(velvetRepo, "server/lib/smirkResearch.ts")),
    import(requireModule(velvetRepo, "server/lib/smirkOutcome.ts")),
    import(requireModule(velvetRepo, "server/lib/acquisitionLearning.ts")),
    import(requireModule(velvetRepo, "server/lib/smirkLeadBatch.ts")),
  ]);

  const lead = {
    id: 42,
    userId: 7,
    companyName: "Silver State Home Services Demo",
    websiteUrl: "https://example.com/silver-state-demo",
    phone: "+12025550124",
    verifiedOwnerEmail: "owner@example.com",
    category: "plumbing",
    address: "100 Example Way",
    city: "Reno",
    state: "NV",
    screenshotUrl: null,
    googleRating: null,
    reviewCount: null,
    googlePlaceId: null,
    updatedAt: new Date(SYNTHETIC_PREPARED_AT),
  };

  const velvetResearchPayload = velvetResearch.buildSmirkResearchPayload(
    lead,
    1
  );
  const smirkResearchPayload =
    velvetResearchPayloadSchema.parse(velvetResearchPayload);
  assert.equal(
    velvetResearch.SMIRK_RESEARCH_CONTRACT_VERSION,
    smirkResearchPayload.contractVersion
  );
  assert.equal(
    smirkResearchPayload.externalId,
    "velvet-owner-7-lead-42"
  );
  assert.equal(
    smirkResearchPayload.prospect.emailVerification,
    "verified_owner_email"
  );
  assert.equal(
    smirkResearchPayload.prospect.phoneContactMode,
    "operator_review_only"
  );

  const velvetResearchHash =
    velvetResearch.buildSmirkResearchPayloadHash(velvetResearchPayload);
  const smirkResearchHash =
    buildVelvetResearchPayloadHash(smirkResearchPayload);
  assert.equal(velvetResearchHash, smirkResearchHash);
  assert.deepEqual(
    velvetResearch.buildSmirkResearchPayload(lead, 1),
    velvetResearchPayload
  );
  const changedResearchPayload = velvetResearch.buildSmirkResearchPayload(
    { ...lead, companyName: "Changed Synthetic Business" },
    1
  );
  assert.notEqual(
    velvetResearch.buildSmirkResearchPayloadHash(changedResearchPayload),
    velvetResearchHash
  );

  const importedReceipt = velvetResearch.parseSmirkResearchResponse(201, {
    ok: true,
    state: "IMPORTED",
    campaignId: 17,
    prospectId: 23,
    externalAction: "none",
  });
  const duplicateReceipt = velvetResearch.parseSmirkResearchResponse(200, {
    ok: true,
    state: "DUPLICATE",
    campaignId: 17,
    prospectId: 23,
    externalAction: "none",
  });
  assert.equal(importedReceipt.success, true);
  assert.equal(duplicateReceipt.success, true);
  assert.equal(importedReceipt.externalAction, "none");
  assert.equal(duplicateReceipt.externalAction, "none");

  const evidenceHash = hashProspectEvidence(
    smirkResearchPayload.prospect.evidence
  );
  const emailPayload = buildProspectOutreachPayload({
    workspaceId: 1,
    campaignId: 17,
    prospectId: 23,
    recipient: smirkResearchPayload.prospect.email,
    evidenceHash,
    preparedAt: SYNTHETIC_PREPARED_AT,
    draft: {
      channel: "email",
      subject: "Capturing urgent plumbing calls",
      body:
        "I noticed a possible mobile booking issue that may be creating friction. Would a review-only proof call be useful?",
      emailCompliance: {
        senderIdentity: "SMIRK",
        advertisementDisclosure:
          "This is a commercial message from SMIRK.",
        physicalPostalAddress: "100 Example Way, Reno, NV 89501",
        optOutInstructions:
          "If this is not relevant, reply no and I will not follow up.",
      },
      variantKey: "owner-language-v2",
      maxCostCents: 2,
      expiresInHours: 24,
    },
  });
  const emailPayloadHash = hashProspectOutreachPayload(emailPayload);
  const emailApproval = prospectOutreachApprovalSchema.parse({
    payloadHash: emailPayloadHash,
    attestations: {
      recipientReviewed: true,
      suppressionChecked: true,
      emailComplianceReviewed: true,
    },
  });
  assertProspectOutreachApprovalAttestations("email", emailApproval);
  assert.equal(emailPayload.controls.smsAllowed, false);
  assert.equal(emailPayload.controls.bulkExecution, false);
  assert.equal(
    emailPayload.controls.providerExecution,
    "operator-triggered-single-recipient"
  );
  assert.equal(canTransitionProspectOutreach("PREPARED", "APPROVED"), true);
  assert.equal(canTransitionProspectOutreach("APPROVED", "SENDING"), true);
  assert.equal(canTransitionProspectOutreach("SENDING", "SENT"), true);

  const callPayload = buildProspectOutreachPayload({
    workspaceId: 1,
    campaignId: 17,
    prospectId: 23,
    recipient: smirkResearchPayload.prospect.phone,
    evidenceHash,
    preparedAt: SYNTHETIC_PREPARED_AT,
    draft: {
      channel: "call",
      callBrief:
        "Review the public business record and ask whether a missed-call backup path would be useful. Do not claim any measured business outcome.",
      variantKey: "manual-owner-call-v1",
      maxCostCents: 10,
      expiresInHours: 8,
    },
  });
  const callPayloadHash = hashProspectOutreachPayload(callPayload);
  const callApproval = prospectOutreachApprovalSchema.parse({
    payloadHash: callPayloadHash,
    attestations: {
      recipientReviewed: true,
      suppressionChecked: true,
      doNotCallChecked: true,
      callingWindowChecked: true,
      manualDialOnly: true,
    },
  });
  assertProspectOutreachApprovalAttestations("call", callApproval);
  assert.equal(callPayload.controls.smsAllowed, false);
  assert.equal(callPayload.controls.providerExecution, "disabled");
  assert.equal(
    callPayload.controls.compliance.channel === "call" &&
      callPayload.controls.compliance.automatedDialing,
    false
  );

  const executionProof = "manual:synthetic-call-log-0001";
  assert.equal(isValidExecutionProofReference(executionProof), true);
  assertRecordedExecutionWindow({
    approvedAt: SYNTHETIC_APPROVED_AT,
    occurredAt: SYNTHETIC_EXECUTED_AT,
    expiresAt: callPayload.expiresAt,
    now: SYNTHETIC_NOW,
  });
  assert.equal(
    isExactRecordedExecutionReplay(
      {
        sentAt: SYNTHETIC_EXECUTED_AT,
        proofReference: executionProof,
      },
      {
        occurredAt: SYNTHETIC_EXECUTED_AT,
        proofReference: executionProof,
      }
    ),
    true
  );
  assert.equal(
    isExactRecordedExecutionReplay(
      {
        sentAt: SYNTHETIC_EXECUTED_AT,
        proofReference: executionProof,
      },
      {
        occurredAt: "2026-07-30T16:16:00.000Z",
        proofReference: executionProof,
      }
    ),
    false
  );

  const outcomeInput = prospectOutcomeSchema.parse({
    externalEventId: "synthetic-email-replied-0001",
    outreachApprovalId: SYNTHETIC_APPROVAL_ID,
    outcome: "replied",
    occurredAt: SYNTHETIC_OUTCOME_AT,
    notes: "Synthetic outcome used only for contract verification.",
  });
  assertProspectOutcomeMatchesChannel("email", outcomeInput.outcome);
  assert.equal(
    isExactProspectOutcomeReplay(
      {
        lead_id: 23,
        outreach_job_id: 31,
        outcome: outcomeInput.outcome,
        occurred_at: outcomeInput.occurredAt,
        notes: outcomeInput.notes || null,
      },
      {
        leadId: 23,
        outreachJobId: 31,
        outcome: outcomeInput.outcome,
        occurredAt: outcomeInput.occurredAt,
        notes: outcomeInput.notes,
      }
    ),
    true
  );
  assert.equal(
    isExactProspectOutcomeReplay(
      {
        lead_id: 23,
        outreach_job_id: 31,
        outcome: outcomeInput.outcome,
        occurred_at: outcomeInput.occurredAt,
        notes: outcomeInput.notes || null,
      },
      {
        leadId: 23,
        outreachJobId: 31,
        outcome: "converted",
        occurredAt: outcomeInput.occurredAt,
        notes: outcomeInput.notes,
      }
    ),
    false
  );

  const smirkOutcomePayload = buildVelvetOutcomePayload({
    workspaceId: 1,
    externalProspectId: smirkResearchPayload.externalId,
    externalEventId: outcomeInput.externalEventId,
    outreachApprovalId: SYNTHETIC_APPROVAL_ID,
    channel: "email",
    outcome: outcomeInput.outcome,
    occurredAt: outcomeInput.occurredAt,
    evidenceHash,
    outreachPayloadHash: emailPayloadHash,
    notes: outcomeInput.notes,
  });
  const velvetParsedOutcome =
    velvetOutcome.smirkOutcomePayloadSchema.parse(smirkOutcomePayload);
  const smirkOutcomeHash = hashVelvetOutcomePayload(smirkOutcomePayload);
  const velvetOutcomeHash =
    velvetOutcome.hashSmirkOutcomePayload(velvetParsedOutcome);
  assert.equal(smirkOutcomeHash, velvetOutcomeHash);

  const timestamp = String(Math.floor(SYNTHETIC_NOW.getTime() / 1_000));
  const smirkSignature = signVelvetOutcomePayload(
    smirkOutcomePayload,
    timestamp,
    SYNTHETIC_SECRET
  );
  const velvetSignature = velvetOutcome.signSmirkOutcome(
    velvetParsedOutcome,
    timestamp,
    SYNTHETIC_SECRET
  );
  assert.equal(smirkSignature, velvetSignature);
  assert.deepEqual(
    velvetOutcome.verifySmirkOutcomeSignature({
      payload: velvetParsedOutcome,
      timestamp,
      signature: smirkSignature,
      secret: SYNTHETIC_SECRET,
      now: SYNTHETIC_NOW,
    }),
    { ok: true }
  );
  assert.deepEqual(
    velvetOutcome.verifySmirkOutcomeSignature({
      payload: velvetParsedOutcome,
      timestamp,
      signature: `${smirkSignature.slice(0, -1)}${
        smirkSignature.endsWith("0") ? "1" : "0"
      }`,
      secret: SYNTHETIC_SECRET,
      now: SYNTHETIC_NOW,
    }),
    { ok: false, code: "SMIRK_OUTCOME_SIGNATURE_INVALID" }
  );

  const researchReceipt = JSON.stringify({
    externalId: smirkResearchPayload.externalId,
    workspaceId: 1,
    state: "IMPORTED",
    campaignId: 17,
    prospectId: 23,
    externalAction: "none",
  });
  assert.deepEqual(
    velvetOutcome.validateSmirkOutcomeResearchReceipt(
      researchReceipt,
      velvetParsedOutcome
    ),
    { ok: true }
  );
  assert.deepEqual(
    velvetOutcome.validateSmirkOutcomeResearchReceipt(
      JSON.stringify({
        ...JSON.parse(researchReceipt),
        externalId: "velvet-owner-7-lead-999",
      }),
      velvetParsedOutcome
    ),
    { ok: false, code: "SMIRK_OUTCOME_RESEARCH_RECEIPT_MISMATCH" }
  );

  const variantObservations = [
    ...observationsForVariant("owner-language-v1", 1),
    ...observationsForVariant("owner-language-v2", 6),
  ];
  const variantScorecard =
    buildProspectLearningScorecard(variantObservations);
  const variantCandidate = evaluateProspectLearningCandidate({
    channel: "email",
    currentVariant: "owner-language-v1",
    challengerVariant: "owner-language-v2",
    observations: variantObservations,
  });
  assert.equal(variantCandidate.ready, true);
  assert.equal("policyChanged" in variantCandidate, false);

  const acquisitionObservations = [
    ...observationsForCategory("plumbing", 6),
    ...observationsForCategory("hvac", 1),
  ];
  const acquisitionScorecard =
    velvetLearning.buildAcquisitionSegmentScorecard(
      acquisitionObservations,
      "category"
    );
  const acquisitionCandidate =
    velvetLearning.evaluateAcquisitionLearningCandidate({
      observations: acquisitionObservations,
      dimension: "category",
      value: "plumbing",
    });
  assert.equal(acquisitionCandidate.ready, true);
  assert.equal("policyChanged" in acquisitionCandidate, false);

  if (!acquisitionCandidate.ready) {
    throw new Error("Synthetic acquisition candidate was not ready.");
  }
  const approvedSourcingCandidate =
    velvetLeadBatch.parseApprovedSourcingCandidate({
      id: 71,
      candidateKey: "category:plumbing",
      version: 1,
      proposal: JSON.stringify(acquisitionCandidate.proposal),
    });
  assert.ok(approvedSourcingCandidate);
  const smirkLeadSourceRequest = buildVelvetLeadSourceRequest({
    requestId:
      "smirk-source-22222222-2222-4222-8222-222222222222",
    workspaceId: 1,
    criteria: {
      limit: 12,
      learningMode: "latest_approved",
    },
  });
  const velvetLeadSourceRequest =
    velvetLeadBatch.smirkLeadBatchRequestSchema.parse(
      smirkLeadSourceRequest
    );
  assert.equal(
    velvetLeadBatch.SMIRK_LEAD_BATCH_REQUEST_CONTRACT,
    smirkLeadSourceRequest.contractVersion
  );
  assert.equal(
    velvetLeadBatch.hashSmirkLeadBatchValue(
      velvetLeadSourceRequest
    ),
    hashVelvetLeadSourceValue(smirkLeadSourceRequest)
  );
  const learnedFilters = velvetLeadBatch.sourcingFiltersForRequest(
    velvetLeadSourceRequest,
    approvedSourcingCandidate
  );
  assert.deepEqual(learnedFilters, {
    category: "plumbing",
    limit: 12,
  });
  const sourcedProspect = velvetResearch.buildSmirkResearchPayload(
    lead,
    1,
    null,
    {
      externalId: smirkLeadSourceRequest.requestId,
      name: "Velvet learned segment: plumbing",
      targetIndustry: learnedFilters.category,
    }
  );
  const sourcedProspects = [sourcedProspect];
  const leadSourceResponse = {
    ok: true,
    contractVersion:
      velvetLeadBatch.SMIRK_LEAD_BATCH_RESPONSE_CONTRACT,
    state: "EXPORTED",
    originalState: "EXPORTED",
    requestId: smirkLeadSourceRequest.requestId,
    requestPayloadHash: hashVelvetLeadSourceValue(
      smirkLeadSourceRequest
    ),
    batchId: 91,
    prospectsHash:
      velvetLeadBatch.hashSmirkLeadBatchValue(sourcedProspects),
    prospects: sourcedProspects,
    appliedLearningCandidate: approvedSourcingCandidate,
    contactActionAllowed: false,
    spendAuthorized: false,
    externalAction: "research_export_only",
  };
  velvetLeadBatch.smirkLeadBatchResponseSchema.parse(
    leadSourceResponse
  );
  const acceptedLeadSourceResponse =
    validateVelvetLeadSourceResponse({
      httpStatus: 201,
      body: leadSourceResponse,
      request: smirkLeadSourceRequest,
    });
  assert.equal(acceptedLeadSourceResponse.success, true);
  assert.equal(leadSourceResponse.contactActionAllowed, false);
  assert.equal(leadSourceResponse.spendAuthorized, false);
  assert.equal(networkAttempts, 0);

  const report = {
    ok: true,
    mode: "synthetic-local-no-network",
    sourcePair: {
      smirk: smirkGit,
      velvet: velvetGit,
    },
    research: {
      contractVersion: smirkResearchPayload.contractVersion,
      externalProspectId: smirkResearchPayload.externalId,
      payloadHashAgreement: true,
      stableReplayHash: true,
      changedPayloadHashDetected: true,
      importedReceiptAccepted: true,
      duplicateReceiptAccepted: true,
      contactProvenance: {
        email: smirkResearchPayload.prospect.emailVerification,
        phone: smirkResearchPayload.prospect.phoneContactMode,
      },
      externalAction: "none",
    },
    sourcing: {
      requestContract: smirkLeadSourceRequest.contractVersion,
      responseContract: leadSourceResponse.contractVersion,
      requestHashAgreement: true,
      responseHashAgreement: true,
      maximumRequested: smirkLeadSourceRequest.criteria.limit,
      appliedLearningCandidate: {
        id: approvedSourcingCandidate.id,
        dimension:
          approvedSourcingCandidate.proposal.dimension,
        value: approvedSourcingCandidate.proposal.value,
      },
      learnedFilters,
      exportedProspects: sourcedProspects.length,
      contactActionAllowed: false,
      spendAuthorized: false,
      externalAction: "research_export_only",
    },
    outreach: {
      email: {
        syntheticStateProof: [
          "PREPARED",
          "APPROVED",
          "SENDING",
          "SENT",
        ],
        payloadHash: emailPayloadHash,
        evidenceHash,
        recipientSpecific: true,
        providerExecution: "operator-triggered-single-recipient",
      },
      call: {
        syntheticStateProof: ["PREPARED", "APPROVED", "SENT"],
        payloadHash: callPayloadHash,
        execution: "manual-dial-only",
        exactManualReplayAccepted: true,
        changedManualReplayRejected: true,
        doNotCallCheckRequired: true,
        callingWindowCheckRequired: true,
        automatedDialing: false,
        providerExecution: "disabled",
      },
      smsAllowed: false,
      bulkExecution: false,
    },
    outcome: {
      contractVersion: smirkOutcomePayload.contractVersion,
      payloadHashAgreement: smirkOutcomeHash === velvetOutcomeHash,
      signatureAgreement: smirkSignature === velvetSignature,
      signatureVerified: true,
      researchReceiptBound: true,
      exactReplaySemanticsVerified: true,
    },
    learning: {
      variantScorecard,
      variantCandidate,
      acquisitionScorecard,
      acquisitionCandidate,
      humanReviewRequired: true,
      candidateGenerationOnly: true,
      automaticPolicyMutationAttempted: false,
    },
    externalActions: {
      providerRequests: networkAttempts,
      emailSent: false,
      smsSent: false,
      callPlaced: false,
      deployment: false,
      productionWrite: false,
    },
    limits: [
      "This proves source-level contract compatibility, hashing, signatures, approval rules, replay rules, and candidate generation.",
      "It does not prove database persistence, deployed commit parity, provider delivery, live credentials, or a real commercial outcome.",
    ],
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  globalThis.fetch = originalFetch;
}
