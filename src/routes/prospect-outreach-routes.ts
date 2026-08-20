import { createHash, randomUUID } from "node:crypto";
import express, {
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { z } from "zod";
import {
  PROSPECT_MANUAL_CALL_RECORD_CONFIRMATION,
  PROSPECT_OUTREACH_CONTRACT_VERSION,
  assertRecordedExecutionWindow,
  assertProspectOutcomeMatchesChannel,
  assertProspectOutreachApprovalAttestations,
  buildProspectOutreachPayload,
  hashProspectEvidence,
  hashProspectOutreachPayload,
  isExactRecordedExecutionReplay,
  isExactProspectOutcomeReplay,
  isValidExecutionProofReference,
  normalizeProspectOutreachRecipient,
  outcomeToProspectStatus,
  prospectEmailComplianceSchema,
  prepareProspectOutreachSchema,
  prospectOutreachApprovalSchema,
  prospectOutreachPayloadSchema,
  prospectOutreachStoredApprovalSchema,
  prospectOutcomeSchema,
  selectCanonicalProspectOutcomeEvent,
  type PrepareProspectOutreachInput,
  type ProspectOutcome,
} from "../prospect-outreach.js";
import {
  assertProspectCallComplianceForExecution,
  buildProspectCallComplianceReceipt,
} from "../prospect-call-compliance.js";
import {
  publicProspectManualCallConfig,
  readProspectManualCallConfig,
} from "../prospect-manual-call-config.js";
import {
  PROSPECT_EMAIL_EXECUTION_CONFIRMATION,
  buildProspectEmailIdempotencyKey,
  readProspectEmailProviderConfig,
  sendApprovedProspectEmail,
  type ProspectEmailProviderConfig,
  type ProspectEmailProviderResult,
} from "../prospect-email-provider.js";
import {
  classifyProspectEmailWebhookEvent,
  readProspectEmailWebhookConfig,
  verifyProspectEmailWebhook,
} from "../prospect-email-webhook.js";
import {
  ProspectEmailReceivingError,
  buildProspectInboundReplyContentReceipt,
  hashProspectInboundReplyContentReceipt,
  hashProspectInboundReplyContentRequest,
  prospectInboundReplyContentReceiptSchema,
  readProspectEmailReceivingConfig,
  retrieveProspectInboundReplyContentSchema,
  retrieveProspectReceivedEmail,
} from "../prospect-email-receiving.js";
import {
  buildProspectInboundReplyResolutionReceipt,
  buildProspectInboundReplyReviewPayload,
  hashProspectInboundReplyResolutionReceipt,
  hashProspectInboundReplyResolutionRequest,
  hashProspectInboundReplyReviewPayload,
  prospectInboundReplyResolutionReceiptSchema,
  prospectInboundReplyReviewPayloadSchema,
  resolveProspectInboundReplySchema,
} from "../prospect-inbound-reply-review.js";
import {
  VELVET_OUTCOME_DISPATCH_CONFIRMATION,
  buildVelvetOutcomePayload,
  buildVelvetOutcomeIdempotencyKey,
  dispatchVelvetOutcome,
  hashVelvetOutcomePayload,
  readVelvetOutcomeDispatchConfig,
  velvetOutcomePayloadSchema,
} from "../velvet-outcome.js";
import {
  MAXIMUM_ONE_SIDED_FISHER_P_VALUE,
  PROSPECT_LEARNING_STATISTICAL_TEST,
  buildProspectLearningScorecard,
  calculateOneSidedFisherExactPValue,
  evaluateProspectLearningCandidate,
  learningOutcomeSchema,
  type LearningObservation,
} from "../prospect-learning.js";
import {
  PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION,
  buildProspectMessageContext,
  findMatchingProspectMessageVariant,
  getProspectMessageVariantDefinition,
  renderProspectMessageVariant,
} from "../prospect-message-variants.js";
import {
  PROSPECT_MESSAGE_EXPERIMENT_ACTIVATION_CONFIRMATION,
  PROSPECT_MESSAGE_EXPERIMENT_CANCEL_CONFIRMATION,
  PROSPECT_MESSAGE_EXPERIMENT_CLOSE_CONFIRMATION,
  PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION,
  PROSPECT_MESSAGE_EXPERIMENT_DEFAULT_COHORT_SIZE,
  PROSPECT_MESSAGE_EXPERIMENT_LEGACY_CONTRACT_VERSION,
  PROSPECT_MESSAGE_EXPERIMENT_LEGACY_STUDY_DESIGN,
  PROSPECT_MESSAGE_EXPERIMENT_MAX_COHORT_SIZE,
  PROSPECT_MESSAGE_EXPERIMENT_MAX_ELIGIBLE_POPULATION,
  PROSPECT_MESSAGE_EXPERIMENT_OBSERVATION_WINDOW_HOURS,
  PROSPECT_MESSAGE_EXPERIMENT_PREPARE_DRAFTS_CONFIRMATION,
  PROSPECT_MESSAGE_EXPERIMENT_STUDY_DESIGN,
  buildProspectMessageExperimentAssignment,
  buildProspectMessageExperimentDefinition,
  evaluateProspectMessageExperimentCoverage,
  getProspectMessageExperimentCohortEntry,
  getProspectMessageExperimentStudyDesign,
  hashProspectMessageExperimentDefinition,
  prospectMessageExperimentArmCoverageSchema,
  prospectMessageExperimentObservationWindowEndsAt,
  prospectMessageExperimentAssignmentSchema,
  prospectMessageExperimentDefinitionSchema,
  verifyProspectMessageExperimentAssignment,
  type ProspectMessageExperimentArmCoverage,
  type ProspectMessageExperimentDefinition,
} from "../prospect-message-experiments.js";
import {
  applyProspectMessagePolicySchema,
  buildProspectMessagePolicyReceipt,
  buildProspectMessagePolicyRelease,
  hashProspectMessagePolicyValue,
  prospectMessagePolicyReleaseSchema,
  rollbackProspectMessagePolicySchema,
  type ProspectMessagePolicyRelease,
} from "../prospect-message-policy.js";
import { loadPassingProspectInboxPlacementProof } from "../prospect-inbox-placement-store.js";
import {
  SMIRK_INTERNAL_INBOX_SEED_SOURCE,
  assertProspectInboxPlacementSeedActionBinding,
  readProspectInboxPlacementConfig,
} from "../prospect-inbox-placement.js";
import {
  acknowledgeProspectPositiveOutcomeSchema,
  buildProspectPositiveOutcomeAcknowledgmentReceipt,
  buildProspectPositiveOutcomeReviewPayload,
  hashProspectPositiveOutcomeAcknowledgmentReceipt,
  hashProspectPositiveOutcomeAcknowledgmentRequest,
  hashProspectPositiveOutcomeReviewPayload,
  isPositiveProspectOutcome,
  prospectPositiveOutcomeAcknowledgmentReceiptSchema,
  prospectPositiveOutcomeReviewPayloadSchema,
} from "../prospect-positive-outcome-review.js";
import {
  ProspectAcquisitionPausedError,
  acquireProspectAcquisitionWorkspaceLock,
  assertProspectAcquisitionMutationUnpaused,
  assertProspectAcquisitionUnpaused,
  createProspectAcquisitionUnpausedGuard,
} from "../prospect-positive-outcome-pause.js";
import {
  buildProspectQcModelReviewReceipt,
  hashProspectQcModelRequest,
  hashProspectQcModelReviewReceipt,
  prospectQcModelReviewActionSchema,
  prospectQcModelReviewReceiptSchema,
  publicProspectQcModelProviderConfig,
  readProspectQcModelProviderConfig,
  requestProspectQcModelReview,
  type ProspectQcModelProviderConfig,
  type ProspectQcModelProviderInput,
  type ProspectQcModelReviewReceipt,
} from "../prospect-qc-model-provider.js";
import { buildProspectQcReceipt } from "../prospect-qc.js";
import {
  buildProspectQcRevisionFingerprint,
  buildProspectQcRevisionPayload,
  hashProspectQcRevisionPayload,
  prospectQcRevisionPayloadSchema,
  type ProspectQcRevisionPayload,
} from "../prospect-qc-revision.js";

type SqlClient = any;

type ProspectOutreachRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  requireFullOperator: RequestHandler;
  sql: SqlClient;
  dbEnabled: boolean;
  getWorkspaceId: (req: Request) => number;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

type ProspectRow = {
  id: number;
  campaign_id: number;
  business_name: string;
  industry: string | null;
  email: string | null;
  email_verification: string | null;
  phone: string | null;
  phone_contact_mode: string | null;
  status: string;
  review_state: string;
  research_evidence: unknown;
  external_id: string | null;
  source: string;
};

type ProspectMessageExperimentRow = {
  id: number;
  experiment_id: string;
  workspace_id: number;
  campaign_id: number;
  channel: "email" | "call";
  state: "PREPARED" | "ACTIVE" | "CLOSED" | "CANCELLED";
  control_variant_key: string;
  challenger_variant_key: string;
  allocation_basis_points: number;
  definition: unknown;
  definition_hash: string;
  prepared_by?: string;
  activated_by?: string | null;
  activated_at?: string | Date | null;
  closed_by?: string | null;
  closed_at?: string | Date | null;
  inbox_placement_test_id?: string | null;
  inbox_placement_receipt_hash?: string | null;
  inbox_placement_state?: string | null;
  inbox_placement_valid_until?: string | Date | null;
  inbox_placement_fresh?: boolean | null;
  created_at?: string | Date;
  updated_at?: string | Date;
  enrolled_count?: number | string;
  prepared_count?: number | string;
  terminal_count?: number | string;
};

type ProspectMessagePolicyRow = {
  id: number;
  release_id: string;
  workspace_id: number;
  campaign_id: number;
  channel: "email" | "call";
  version: number;
  action: "PROMOTE" | "ROLLBACK";
  champion_variant_key: string;
  previous_champion_variant_key: string;
  source_candidate_id: number | null;
  rollback_of_release_id: string | null;
  release: unknown;
  release_hash: string;
  applied_by: string;
  applied_at: string | Date;
  created_at?: string | Date;
};

type ProspectMessageExperimentEvidence = {
  observations: LearningObservation[];
  armStats: {
    control: ProspectMessageExperimentArmCoverage;
    challenger: ProspectMessageExperimentArmCoverage;
  };
  assignedProspects: number;
  executedProspects: number;
  measuredProspects: number;
  outcomeEventCount: number;
  executedProtocolDeviationCount: number;
};

class ProspectOutreachRouteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
  }
}

async function assertCurrentControlledInboxSeedBinding(input: {
  tx: SqlClient;
  env: Record<string, string | undefined>;
  workspaceId: number;
  outreachJobId: number;
  recipient: string;
  variantKey: string;
  now: Date;
}): Promise<void> {
  const rows = await input.tx<{
    state: string;
    definition: unknown;
    definition_hash: string;
    expires_at: string | Date;
    slot: number;
    recipient_hash: string;
    assigned_variant_key: string;
  }[]>`
    SELECT t.state, t.definition, t.definition_hash, t.expires_at,
           i.slot, i.recipient_hash, i.assigned_variant_key
    FROM prospect_inbox_placement_items i
    JOIN prospect_inbox_placement_tests t
      ON t.id = i.test_row_id
     AND t.workspace_id = i.workspace_id
    WHERE i.workspace_id = ${input.workspaceId}
      AND i.outreach_job_id = ${input.outreachJobId}
    LIMIT 1
    FOR SHARE OF t, i
  `;
  const row = rows[0];
  if (!row) {
    throw new ProspectOutreachRouteError(
      "The controlled inbox seed has no durable test binding.",
      409,
      "PROSPECT_INBOX_PLACEMENT_SEED_BINDING_INVALID"
    );
  }

  try {
    assertProspectInboxPlacementSeedActionBinding({
      definition: row.definition,
      definitionHash: row.definition_hash,
      config: readProspectInboxPlacementConfig(input.env),
      workspaceId: input.workspaceId,
      testState: row.state,
      storedExpiresAt: row.expires_at,
      slot: row.slot,
      storedRecipientHash: row.recipient_hash,
      storedAssignedVariantKey: row.assigned_variant_key,
      recipient: input.recipient,
      assignedVariantKey: input.variantKey,
      now: input.now,
    });
  } catch (error) {
    throw new ProspectOutreachRouteError(
      error instanceof Error
        ? error.message
        : "The controlled inbox seed binding is invalid.",
      409,
      "PROSPECT_INBOX_PLACEMENT_SEED_BINDING_INVALID"
    );
  }
}

const decisionSchema = z
  .object({
    decision: z.enum(["pending_review", "qualified", "rejected"]),
    notes: z.string().trim().max(2_000).optional(),
  })
  .strict();

const rejectSchema = z
  .object({
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

const recordExecutionSchema = z
  .object({
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    occurredAt: z.string().datetime({ offset: true }),
    confirmation: z.literal(PROSPECT_MANUAL_CALL_RECORD_CONFIRMATION),
    proofReference: z
      .string()
      .trim()
      .min(10)
      .max(500)
      .refine(isValidExecutionProofReference),
  })
  .strict();

const executeEmailSchema = z
  .object({
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.literal(PROSPECT_EMAIL_EXECUTION_CONFIRMATION),
  })
  .strict();

const dispatchVelvetOutcomeSchema = z
  .object({
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.literal(VELVET_OUTCOME_DISPATCH_CONFIRMATION),
  })
  .strict();

const learningCandidateSchema = z
  .object({
    experimentId: z.string().uuid(),
  })
  .strict();

const learningDecisionSchema = z
  .object({
    decision: z.enum(["APPROVED", "REJECTED"]),
  })
  .strict();

const deterministicCandidateArmSchema = z
  .object({
    channel: z.enum(["email", "call"]),
    variantKey: z.string().trim().min(2).max(64),
    sampleSize: z.number().int().min(10),
    positive: z.number().int().nonnegative(),
    positiveRate: z.number().min(0).max(1),
  })
  .passthrough()
  .refine(value => value.positive <= value.sampleSize, {
    message: "Positive outcomes cannot exceed the arm sample size.",
  });

const deterministicCandidateStudyDesignSchema = z.enum([
  PROSPECT_MESSAGE_EXPERIMENT_LEGACY_STUDY_DESIGN,
  PROSPECT_MESSAGE_EXPERIMENT_STUDY_DESIGN,
]);

const deterministicCandidateProposalSchema = z
  .object({
    channel: z.enum(["email", "call"]),
    promoteVariant: z.string().trim().min(2).max(64),
    replaceVariant: z.string().trim().min(2).max(64),
    studyDesign: deterministicCandidateStudyDesignSchema,
    experimentId: z.string().uuid(),
    experimentDefinitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    registryVersion: z.literal(
      PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION
    ),
    runtimePolicyChange: z.literal(false),
  })
  .passthrough();

const deterministicCandidateEvidenceSchema = z
  .object({
    current: deterministicCandidateArmSchema,
    challenger: deterministicCandidateArmSchema,
    studyDesign: deterministicCandidateStudyDesignSchema,
    experimentId: z.string().uuid(),
    experimentDefinitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    registryVersion: z.literal(
      PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION
    ),
    executedProtocolDeviationCount: z.literal(0),
    absoluteLift: z.number().positive().max(1),
    statisticalTest: z.literal(
      PROSPECT_LEARNING_STATISTICAL_TEST
    ),
    oneSidedFisherPValue: z
      .number()
      .min(0)
      .max(MAXIMUM_ONE_SIDED_FISHER_P_VALUE),
    maximumOneSidedFisherPValue: z.literal(
      MAXIMUM_ONE_SIDED_FISHER_P_VALUE
    ),
    armStats: z
      .object({
        control: prospectMessageExperimentArmCoverageSchema,
        challenger: prospectMessageExperimentArmCoverageSchema,
      })
      .strict(),
    assignedProspects: z.number().int().positive(),
    executedProspects: z.number().int().nonnegative(),
    measuredProspects: z.number().int().nonnegative(),
    outcomeEventCount: z.number().int().nonnegative(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const assigned =
      value.armStats.control.assigned +
      value.armStats.challenger.assigned;
    const executed =
      value.armStats.control.executed +
      value.armStats.challenger.executed;
    const measured =
      value.armStats.control.measured +
      value.armStats.challenger.measured;
    const outcomeEvents =
      value.armStats.control.outcomeEvents +
      value.armStats.challenger.outcomeEvents;
    if (
      value.assignedProspects !== assigned ||
      value.executedProspects !== executed ||
      value.measuredProspects !== measured ||
      value.outcomeEventCount !== outcomeEvents
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["armStats"],
        message: "Candidate coverage totals do not match the two arms.",
      });
    }
  });

const prepareMessageExperimentSchema = z
  .object({
    campaignId: z.number().int().positive(),
    channel: z.enum(["email", "call"]),
    controlVariantKey: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[A-Za-z0-9:_-]+$/),
    challengerVariantKey: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[A-Za-z0-9:_-]+$/),
    cohortSize: z
      .number()
      .int()
      .min(PROSPECT_MESSAGE_EXPERIMENT_DEFAULT_COHORT_SIZE)
      .max(PROSPECT_MESSAGE_EXPERIMENT_MAX_COHORT_SIZE)
      .refine(value => value % 2 === 0, {
        message: "The frozen cohort size must be even.",
      })
      .default(PROSPECT_MESSAGE_EXPERIMENT_DEFAULT_COHORT_SIZE),
  })
  .strict()
  .refine(
    value => value.controlVariantKey !== value.challengerVariantKey,
    "Control and challenger strategies must be different."
  );

const activateMessageExperimentSchema = z
  .object({
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.literal(
      PROSPECT_MESSAGE_EXPERIMENT_ACTIVATION_CONFIRMATION
    ),
    attestations: z
      .object({
        registeredContentReviewed: z.literal(true),
        deterministicAssignmentReviewed: z.literal(true),
        noContactOrSpendAuthorized: z.literal(true),
      })
      .strict(),
  })
  .strict();

const prepareMessageExperimentDraftsSchema = z.discriminatedUnion(
  "channel",
  [
    z
      .object({
        channel: z.literal("email"),
        definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
        confirmation: z.literal(
          PROSPECT_MESSAGE_EXPERIMENT_PREPARE_DRAFTS_CONFIRMATION
        ),
        emailCompliance: z
          .object({
            senderIdentity: z.string().trim().min(2).max(160),
            advertisementDisclosure: z
              .string()
              .trim()
              .min(10)
              .max(500),
            physicalPostalAddress: z
              .string()
              .trim()
              .min(10)
              .max(500),
            optOutInstructions: z
              .string()
              .trim()
              .min(10)
              .max(500),
          })
          .strict(),
        maxCostCents: z.number().int().min(0).max(5).default(2),
        expiresInHours: z.number().int().min(1).max(72).default(24),
        attestations: z
          .object({
            frozenCohortReviewed: z.literal(true),
            recipientApprovalStillRequired: z.literal(true),
            noContactOrSpendAuthorized: z.literal(true),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        channel: z.literal("call"),
        definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
        confirmation: z.literal(
          PROSPECT_MESSAGE_EXPERIMENT_PREPARE_DRAFTS_CONFIRMATION
        ),
        maxCostCents: z.number().int().min(1).max(100).default(1),
        expiresInHours: z.number().int().min(1).max(24).default(8),
        attestations: z
          .object({
            frozenCohortReviewed: z.literal(true),
            recipientApprovalStillRequired: z.literal(true),
            noContactOrSpendAuthorized: z.literal(true),
          })
          .strict(),
      })
      .strict(),
  ]
);

const closeMessageExperimentSchema = z
  .object({
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.literal(
      PROSPECT_MESSAGE_EXPERIMENT_CLOSE_CONFIRMATION
    ),
    attestations: z
      .object({
        enrollmentStopped: z.literal(true),
        allJobsTerminal: z.literal(true),
        outcomeWindowReviewed: z.literal(true),
      })
      .strict(),
  })
  .strict();

const cancelMessageExperimentSchema = z
  .object({
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.literal(
      PROSPECT_MESSAGE_EXPERIMENT_CANCEL_CONFIRMATION
    ),
  })
  .strict();

const positiveOutcomeReviewListQuerySchema = z
  .object({
    state: z
      .enum(["pending", "acknowledged", "all"])
      .optional()
      .default("pending"),
  })
  .strict();

const inboundReplyReviewListQuerySchema = z
  .object({
    state: z
      .enum(["pending", "resolved", "all"])
      .optional()
      .default("pending"),
  })
  .strict();

function actorForRequest(req: Request): string {
  return (req as any).authMode === "operator"
    ? "dashboard_operator"
    : "unknown_operator";
}

function auditedOutreachActorForRequest(req: Request): string {
  const authMode = String((req as any).authMode || "");
  const actor =
    authMode === "operator"
      ? "dashboard_operator"
      : authMode === "demo_operator"
        ? "dashboard_demo_operator"
        : "unknown_operator";
  const apiKey = String(req.headers?.["x-api-key"] || "").trim();
  if (!apiKey || actor === "unknown_operator") return actor;
  const fingerprint = createHash("sha256")
    .update(apiKey)
    .digest("hex")
    .slice(0, 16);
  return `${actor}:${fingerprint}`;
}

function positiveOutcomeReviewerForRequest(req: Request): string {
  const apiKey = String(req.headers["x-api-key"] || "").trim();
  if ((req as any).authMode !== "operator" || !apiKey) {
    return actorForRequest(req);
  }
  const fingerprint = createHash("sha256")
    .update(apiKey)
    .digest("hex")
    .slice(0, 16);
  return `dashboard_operator:${fingerprint}`;
}

function parsePositiveId(raw: string): number | null {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseOpaqueApprovalId(raw: string): string | null {
  return z.string().uuid().safeParse(raw).success ? raw : null;
}

function canonicalJsonHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function publicEmailProviderConfig(
  config: ProspectEmailProviderConfig,
  workspaceId: number
) {
  return {
    enabled: config.enabled,
    configured: config.configured,
    availableForWorkspace:
      config.configured && config.workspaceId === workspaceId,
    mode: config.mode,
    missing: config.missing,
    dailyRecipientCap: config.dailyRecipientCap,
    dailySpendCapCents: config.dailySpendCapCents,
    reservedCostPerEmailCents: config.unitCostCents,
    provider: "resend" as const,
    sendsSms: false,
    placesCalls: false,
  };
}

function safeTimestampMs(value: unknown): number | null {
  const milliseconds = new Date(String(value || "")).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function safeProviderFailureCode(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9:_-]/g, "_")
    .slice(0, 160);
  return normalized || "PROSPECT_EMAIL_PROVIDER_FAILED";
}

function fail(res: Response, error: unknown) {
  if (error instanceof ProspectEmailReceivingError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      externalAction: "none",
    });
  }
  if (error instanceof ProspectAcquisitionPausedError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      pendingPositiveOutcomeReviews: error.pendingCount,
      externalAction: "none",
    });
  }
  if (error instanceof ProspectOutreachRouteError) {
    return res
      .status(error.status)
      .json({ error: error.message, code: error.code });
  }
  return res.status(503).json({
    error: "Prospect outreach storage is temporarily unavailable.",
    code: "PROSPECT_OUTREACH_STORAGE_UNAVAILABLE",
  });
}

async function requireProspect(
  sql: SqlClient,
  workspaceId: number,
  leadId: number,
  lock = false
): Promise<ProspectRow> {
  const rows = await sql<ProspectRow[]>`
    SELECT l.id, l.campaign_id, l.business_name, l.industry, l.email,
           l.email_verification, l.phone, l.phone_contact_mode, l.status,
           l.review_state, l.research_evidence, l.external_id, l.source
    FROM prospect_leads l
    JOIN prospecting_campaigns c ON c.id = l.campaign_id
    WHERE l.id = ${leadId} AND c.workspace_id = ${workspaceId}
    LIMIT 1
    ${lock ? sql`FOR UPDATE` : sql``}
  `;
  if (!rows[0]) {
    throw new ProspectOutreachRouteError(
      "Prospect not found.",
      404,
      "PROSPECT_NOT_FOUND"
    );
  }
  return rows[0];
}

async function appendOutreachEvent(
  tx: SqlClient,
  input: {
    workspaceId: number;
    jobId: number;
    fromState: string | null;
    toState: string;
    actor: string;
    payloadHash: string;
    details?: Record<string, unknown>;
  }
) {
  const rows = await tx<{ id: number }[]>`
    INSERT INTO prospect_outreach_events (
      event_id, workspace_id, outreach_job_id, from_state, to_state,
      actor, payload_hash, details
    ) VALUES (
      ${randomUUID()}, ${input.workspaceId}, ${input.jobId},
      ${input.fromState}, ${input.toState}, ${input.actor},
      ${input.payloadHash}, ${tx.json(input.details || {})}
    )
    RETURNING id
  `;
  if (!rows[0]) {
    throw new ProspectOutreachRouteError(
      "The outreach audit event was not recorded.",
      503,
      "PROSPECT_OUTREACH_AUDIT_WRITE_FAILED"
    );
  }
}

async function appendProspectQcRevisionEvent(
  tx: SqlClient,
  input: {
    workspaceId: number;
    revisionRowId: number;
    fromState: string | null;
    toState: string;
    actor: string;
    payloadHash: string;
    details?: Record<string, unknown>;
  }
) {
  const rows = await tx<{ id: number }[]>`
    INSERT INTO prospect_qc_revision_events (
      event_id, workspace_id, revision_row_id, from_state, to_state,
      actor, payload_hash, details
    ) VALUES (
      ${randomUUID()}, ${input.workspaceId}, ${input.revisionRowId},
      ${input.fromState}, ${input.toState}, ${input.actor},
      ${input.payloadHash}, ${tx.json(input.details || {})}
    )
    RETURNING id
  `;
  if (!rows[0]) {
    throw new ProspectOutreachRouteError(
      "The QC revision audit event was not recorded.",
      503,
      "PROSPECT_QC_REVISION_AUDIT_WRITE_FAILED"
    );
  }
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseInboundReplyReviewDetails(value: unknown) {
  const details = parseStoredJson(value);
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    throw new ProspectOutreachRouteError(
      "The inbound-reply review metadata is unavailable.",
      503,
      "PROSPECT_INBOUND_REPLY_REVIEW_CORRUPT"
    );
  }
  const record = details as Record<string, unknown>;
  const payload = prospectInboundReplyReviewPayloadSchema.safeParse(
    parseStoredJson(record.replyReview)
  );
  const payloadHash = String(record.replyReviewPayloadHash || "");
  if (
    !payload.success ||
    !/^[a-f0-9]{64}$/.test(payloadHash) ||
    hashProspectInboundReplyReviewPayload(payload.data) !== payloadHash
  ) {
    throw new ProspectOutreachRouteError(
      "The inbound-reply review failed its immutable payload check.",
      503,
      "PROSPECT_INBOUND_REPLY_REVIEW_CORRUPT"
    );
  }

  const contentReceiptValue = record.replyContentReceipt;
  const contentReceiptHash = String(
    record.replyContentReceiptHash || ""
  );
  const contentRequestHash = String(
    record.replyContentRequestHash || ""
  );
  let contentReceipt: z.infer<
    typeof prospectInboundReplyContentReceiptSchema
  > | null = null;
  if (
    contentReceiptValue === undefined ||
    contentReceiptValue === null
  ) {
    if (contentReceiptHash || contentRequestHash) {
      throw new ProspectOutreachRouteError(
        "The inbound-reply review has incomplete content metadata.",
        503,
        "PROSPECT_INBOUND_REPLY_REVIEW_CORRUPT"
      );
    }
  } else {
    const parsedContentReceipt =
      prospectInboundReplyContentReceiptSchema.safeParse(
        parseStoredJson(contentReceiptValue)
      );
    if (
      !parsedContentReceipt.success ||
      !/^[a-f0-9]{64}$/.test(contentReceiptHash) ||
      !/^[a-f0-9]{64}$/.test(contentRequestHash) ||
      parsedContentReceipt.data.reviewId !== payload.data.reviewId ||
      parsedContentReceipt.data.workspaceId !== payload.data.workspaceId ||
      parsedContentReceipt.data.providerEventId !==
        payload.data.providerEventId ||
      parsedContentReceipt.data.inboundMessageId !==
        payload.data.inboundMessageId ||
      parsedContentReceipt.data.replyReviewPayloadHash !== payloadHash ||
      parsedContentReceipt.data.retrievalRequestHash !==
        contentRequestHash ||
      parsedContentReceipt.data.sender !== payload.data.sender ||
      hashProspectInboundReplyContentReceipt(
        parsedContentReceipt.data
      ) !== contentReceiptHash
    ) {
      throw new ProspectOutreachRouteError(
        "The inbound-reply content failed its immutable receipt check.",
        503,
        "PROSPECT_INBOUND_REPLY_CONTENT_CORRUPT"
      );
    }
    contentReceipt = parsedContentReceipt.data;
  }

  const receiptValue = record.replyResolutionReceipt;
  const receiptHash = String(record.replyResolutionReceiptHash || "");
  const requestHash = String(record.replyResolutionRequestHash || "");
  if (receiptValue === undefined || receiptValue === null) {
    if (receiptHash || requestHash) {
      throw new ProspectOutreachRouteError(
        "The inbound-reply review has incomplete resolution metadata.",
        503,
        "PROSPECT_INBOUND_REPLY_REVIEW_CORRUPT"
      );
    }
    return {
      record,
      payload: payload.data,
      payloadHash,
      contentReceipt,
      contentReceiptHash: contentReceipt ? contentReceiptHash : null,
      contentRequestHash: contentReceipt ? contentRequestHash : null,
      receipt: null,
      receiptHash: null,
      requestHash: null,
    };
  }

  const receipt =
    prospectInboundReplyResolutionReceiptSchema.safeParse(
      parseStoredJson(receiptValue)
    );
  if (
    !receipt.success ||
    receipt.data.reviewId !== payload.data.reviewId ||
    receipt.data.payloadHash !== payloadHash ||
    !contentReceipt ||
    receipt.data.contentReceiptHash !== contentReceiptHash ||
    !/^[a-f0-9]{64}$/.test(receiptHash) ||
    !/^[a-f0-9]{64}$/.test(requestHash) ||
    receipt.data.requestHash !== requestHash ||
    (receipt.data.selectedOutreachApprovalId !== null &&
      !payload.data.candidates.some(
        candidate =>
          candidate.outreachApprovalId ===
          receipt.data.selectedOutreachApprovalId
      )) ||
    (receipt.data.resolution === "opt_out" &&
      payload.data.candidates.length > 0 &&
      receipt.data.selectedOutreachApprovalId === null) ||
    hashProspectInboundReplyResolutionReceipt(receipt.data) !==
      receiptHash
  ) {
    throw new ProspectOutreachRouteError(
      "The inbound-reply resolution failed its immutable receipt check.",
      503,
      "PROSPECT_INBOUND_REPLY_REVIEW_CORRUPT"
    );
  }
  return {
    record,
    payload: payload.data,
    payloadHash,
    contentReceipt,
    contentReceiptHash,
    contentRequestHash,
    receipt: receipt.data,
    receiptHash,
    requestHash,
  };
}

function inboundReplyOutcomeExternalEventId(
  providerEventId: string
): string {
  return `resend:${createHash("sha256")
    .update(providerEventId)
    .digest("hex")
    .slice(0, 32)}`;
}

type ProspectQcModelReviewRow = {
  id: number;
  review_id: string;
  workspace_id: number;
  outreach_job_id: number;
  state:
    | "SENDING"
    | "COMPLETED"
    | "DEFINITIVE_FAILURE"
    | "OUTCOME_UNKNOWN";
  request_hash: string;
  payload_hash: string;
  draft_hash: string;
  evidence_hash: string;
  provider: string;
  model: string;
  reserved_cost_cents: number;
  provider_request_id: string | null;
  provider_response_hash: string | null;
  provider_reported_cost_usd: number | string | null;
  total_tokens: number | null;
  review: unknown;
  receipt: unknown;
  receipt_hash: string | null;
  failure_code: string | null;
  requested_by: string;
  requested_at: string | Date;
  completed_at: string | Date | null;
};

function safeQcModelFailureCode(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9:_-]/g, "_")
    .slice(0, 160);
  return normalized || "PROSPECT_QC_MODEL_PROVIDER_FAILED";
}

function requireProspectQcModelReviewReceipt(
  row: ProspectQcModelReviewRow,
  input: {
    workspaceId: number;
    outreachJobId: number;
    approvalId: string;
    payloadHash: string;
    draftHash: string;
    evidenceHash: string;
  }
): ProspectQcModelReviewReceipt {
  if (row.state !== "COMPLETED" || !row.receipt_hash) {
    throw new ProspectOutreachRouteError(
      "The advisory QC review is not complete.",
      409,
      "PROSPECT_QC_MODEL_REVIEW_INCOMPLETE"
    );
  }
  const parsed = prospectQcModelReviewReceiptSchema.safeParse(
    parseStoredJson(row.receipt)
  );
  if (
    !parsed.success ||
    hashProspectQcModelReviewReceipt(parsed.data) !==
      row.receipt_hash ||
    parsed.data.reviewId !== row.review_id ||
    parsed.data.workspaceId !== input.workspaceId ||
    parsed.data.outreachJobId !== input.outreachJobId ||
    parsed.data.approvalId !== input.approvalId ||
    parsed.data.requestHash !== row.request_hash ||
    parsed.data.payloadHash !== input.payloadHash ||
    parsed.data.draftHash !== input.draftHash ||
    parsed.data.evidenceHash !== input.evidenceHash
  ) {
    throw new ProspectOutreachRouteError(
      "The advisory QC review failed its immutable receipt check.",
      409,
      "PROSPECT_QC_MODEL_RECEIPT_INVALID"
    );
  }
  return parsed.data;
}

async function loadBoundProspectQcModelReview(
  sql: SqlClient,
  input: {
    workspaceId: number;
    outreachJobId: number;
    approvalId: string;
    payloadHash: string;
    draftHash: string;
    evidenceHash: string;
    model?: string | null;
  }
): Promise<{
  row: ProspectQcModelReviewRow;
  receipt: ProspectQcModelReviewReceipt | null;
} | null> {
  const rows = await sql<ProspectQcModelReviewRow[]>`
    SELECT *
    FROM prospect_qc_model_reviews
    WHERE workspace_id = ${input.workspaceId}
      AND outreach_job_id = ${input.outreachJobId}
      AND payload_hash = ${input.payloadHash}
      AND draft_hash = ${input.draftHash}
      AND evidence_hash = ${input.evidenceHash}
    ORDER BY requested_at DESC
    LIMIT 20
  `;
  const row = input.model
    ? rows.find(candidate => candidate.model === input.model)
    : rows.find(candidate => candidate.state === "COMPLETED") ||
      rows[0];
  if (!row) return null;
  return {
    row,
    receipt:
      row.state === "COMPLETED"
        ? requireProspectQcModelReviewReceipt(row, input)
        : null,
  };
}

function assertRequiredProspectQcModelConfig(
  config: ProspectQcModelProviderConfig,
  workspaceId: number
): void {
  if (
    config.requiredForApproval &&
    (!config.enabled ||
      !config.configured ||
      config.workspaceId !== workspaceId)
  ) {
    throw new ProspectOutreachRouteError(
      "Approval requires advisory QC, but its dedicated provider configuration is unavailable for this workspace.",
      503,
      "PROSPECT_QC_MODEL_REQUIRED_NOT_CONFIGURED"
    );
  }
}

async function loadApprovedProspectQcModelReview(
  sql: SqlClient,
  input: {
    workspaceId: number;
    outreachJobId: number;
    approvalId: string;
    payloadHash: string;
    draftHash: string;
    evidenceHash: string;
    reviewId: unknown;
    receiptHash: unknown;
  }
): Promise<ProspectQcModelReviewReceipt | null> {
  const reviewId =
    typeof input.reviewId === "string"
      ? input.reviewId.trim()
      : "";
  const receiptHash =
    typeof input.receiptHash === "string"
      ? input.receiptHash.trim()
      : "";
  if (!reviewId && !receiptHash) return null;
  if (
    !z.string().uuid().safeParse(reviewId).success ||
    !/^[a-f0-9]{64}$/.test(receiptHash)
  ) {
    throw new ProspectOutreachRouteError(
      "The approved advisory QC binding is incomplete.",
      409,
      "PROSPECT_QC_MODEL_APPROVAL_BINDING_INVALID"
    );
  }
  const rows = await sql<ProspectQcModelReviewRow[]>`
    SELECT *
    FROM prospect_qc_model_reviews
    WHERE workspace_id = ${input.workspaceId}
      AND outreach_job_id = ${input.outreachJobId}
      AND review_id = ${reviewId}
    LIMIT 1
  `;
  if (
    !rows[0] ||
    rows[0].receipt_hash !== receiptHash
  ) {
    throw new ProspectOutreachRouteError(
      "The approved advisory QC receipt is missing or changed.",
      409,
      "PROSPECT_QC_MODEL_APPROVAL_BINDING_INVALID"
    );
  }
  return requireProspectQcModelReviewReceipt(rows[0], input);
}

function requireExperimentDefinition(
  row: ProspectMessageExperimentRow
): ProspectMessageExperimentDefinition {
  const parsed = prospectMessageExperimentDefinitionSchema.safeParse(
    parseStoredJson(row.definition)
  );
  if (
    !parsed.success ||
    parsed.data.experimentId !== row.experiment_id ||
    parsed.data.workspaceId !== Number(row.workspace_id) ||
    parsed.data.campaignId !== Number(row.campaign_id) ||
    parsed.data.channel !== row.channel ||
    parsed.data.controlVariantKey !== row.control_variant_key ||
    parsed.data.challengerVariantKey !== row.challenger_variant_key ||
    hashProspectMessageExperimentDefinition(parsed.data) !==
      row.definition_hash
  ) {
    throw new ProspectOutreachRouteError(
      "The stored message experiment failed its immutable definition check.",
      409,
      "PROSPECT_MESSAGE_EXPERIMENT_DEFINITION_INVALID"
    );
  }
  return parsed.data;
}

function requireDeterministicCandidateBinding(
  candidate: {
    candidate_key: string;
    proposal: unknown;
    evidence: unknown;
    sample_size: number;
  },
  experiment: ProspectMessageExperimentRow
): void {
  const proposal = deterministicCandidateProposalSchema.safeParse(
    parseStoredJson(candidate.proposal)
  );
  const evidence = deterministicCandidateEvidenceSchema.safeParse(
    parseStoredJson(candidate.evidence)
  );
  if (!proposal.success || !evidence.success) {
    throw new ProspectOutreachRouteError(
      "Only a closed deterministic-assignment candidate can be approved.",
      409,
      "PROSPECT_LEARNING_CANDIDATE_INELIGIBLE"
    );
  }
  const definition = requireExperimentDefinition(experiment);
  const expectedStudyDesign =
    getProspectMessageExperimentStudyDesign(definition);
  const expectedCurrentRate =
    Math.round(
      (evidence.data.current.positive /
        evidence.data.current.sampleSize) *
        10_000
    ) / 10_000;
  const expectedChallengerRate =
    Math.round(
      (evidence.data.challenger.positive /
        evidence.data.challenger.sampleSize) *
        10_000
    ) / 10_000;
  const expectedAbsoluteLift =
    Math.round(
      (expectedChallengerRate - expectedCurrentRate) * 10_000
    ) / 10_000;
  const expectedFisherPValue =
    calculateOneSidedFisherExactPValue({
      currentPositive: evidence.data.current.positive,
      currentSampleSize: evidence.data.current.sampleSize,
      challengerPositive: evidence.data.challenger.positive,
      challengerSampleSize: evidence.data.challenger.sampleSize,
    });
  const coverageEvaluation =
    evaluateProspectMessageExperimentCoverage({
      definition,
      coverage: {
        armStats: evidence.data.armStats,
        assignedProspects: evidence.data.assignedProspects,
        executedProspects: evidence.data.executedProspects,
        measuredProspects: evidence.data.measuredProspects,
        outcomeEventCount: evidence.data.outcomeEventCount,
      },
    });
  const fullCoverage =
    coverageEvaluation.eligible &&
    evidence.data.current.sampleSize ===
      evidence.data.armStats.control.measured &&
    evidence.data.challenger.sampleSize ===
      evidence.data.armStats.challenger.measured &&
    Number(candidate.sample_size) ===
      evidence.data.measuredProspects;
  const valid =
    experiment.state === "CLOSED" &&
    candidate.candidate_key ===
      `experiment:${definition.experimentId}` &&
    proposal.data.experimentId === definition.experimentId &&
    evidence.data.experimentId === definition.experimentId &&
    proposal.data.experimentDefinitionHash ===
      experiment.definition_hash &&
    evidence.data.experimentDefinitionHash ===
      experiment.definition_hash &&
    proposal.data.studyDesign === expectedStudyDesign &&
    evidence.data.studyDesign === expectedStudyDesign &&
    proposal.data.channel === definition.channel &&
    evidence.data.current.channel === definition.channel &&
    evidence.data.challenger.channel === definition.channel &&
    proposal.data.replaceVariant ===
      definition.controlVariantKey &&
    proposal.data.promoteVariant ===
      definition.challengerVariantKey &&
    evidence.data.current.variantKey ===
      definition.controlVariantKey &&
    evidence.data.challenger.variantKey ===
      definition.challengerVariantKey &&
    evidence.data.current.positiveRate === expectedCurrentRate &&
    evidence.data.challenger.positiveRate ===
      expectedChallengerRate &&
    evidence.data.absoluteLift === expectedAbsoluteLift &&
    evidence.data.oneSidedFisherPValue ===
      expectedFisherPValue &&
    fullCoverage &&
    Number(candidate.sample_size) ===
      evidence.data.current.sampleSize +
        evidence.data.challenger.sampleSize;
  if (!valid) {
    throw new ProspectOutreachRouteError(
      "The learning candidate is not bound to the exact closed experiment evidence.",
      409,
      "PROSPECT_LEARNING_CANDIDATE_INELIGIBLE"
    );
  }
}

function requireProspectMessagePolicyRelease(
  row: ProspectMessagePolicyRow
): ProspectMessagePolicyRelease {
  const parsed = prospectMessagePolicyReleaseSchema.safeParse(
    parseStoredJson(row.release)
  );
  const appliedAt = new Date(row.applied_at);
  if (
    !parsed.success ||
    !Number.isFinite(appliedAt.getTime()) ||
    parsed.data.releaseId !== row.release_id ||
    parsed.data.workspaceId !== Number(row.workspace_id) ||
    parsed.data.campaignId !== Number(row.campaign_id) ||
    parsed.data.channel !== row.channel ||
    parsed.data.version !== Number(row.version) ||
    parsed.data.action !== row.action ||
    parsed.data.championVariantKey !==
      row.champion_variant_key ||
    parsed.data.previousChampionVariantKey !==
      row.previous_champion_variant_key ||
    (parsed.data.action === "PROMOTE"
      ? parsed.data.sourceCandidate.id
      : null) !==
      (row.source_candidate_id === null
        ? null
        : Number(row.source_candidate_id)) ||
    parsed.data.rollbackOfReleaseId !==
      row.rollback_of_release_id ||
    parsed.data.appliedBy !== row.applied_by ||
    parsed.data.appliedAt !== appliedAt.toISOString() ||
    hashProspectMessagePolicyValue(parsed.data) !== row.release_hash
  ) {
    throw new ProspectOutreachRouteError(
      "The stored message-policy release failed its immutable receipt check.",
      409,
      "PROSPECT_MESSAGE_POLICY_RELEASE_INVALID"
    );
  }
  return parsed.data;
}

async function loadCurrentProspectMessagePolicy(
  tx: SqlClient,
  input: {
    workspaceId: number;
    campaignId: number;
    channel: "email" | "call";
    lock?: boolean;
  }
): Promise<
  | {
      row: ProspectMessagePolicyRow;
      release: ProspectMessagePolicyRelease;
      receipt: ReturnType<typeof buildProspectMessagePolicyReceipt>;
    }
  | null
> {
  const rows = input.lock
    ? await tx<ProspectMessagePolicyRow[]>`
        SELECT id, release_id, workspace_id, campaign_id, channel,
               version, action, champion_variant_key,
               previous_champion_variant_key, source_candidate_id,
               rollback_of_release_id, release, release_hash,
               applied_by, applied_at, created_at
        FROM prospect_message_policy_releases
        WHERE workspace_id = ${input.workspaceId}
          AND campaign_id = ${input.campaignId}
          AND channel = ${input.channel}
        ORDER BY version DESC
        LIMIT 1
        FOR UPDATE
      `
    : await tx<ProspectMessagePolicyRow[]>`
        SELECT id, release_id, workspace_id, campaign_id, channel,
               version, action, champion_variant_key,
               previous_champion_variant_key, source_candidate_id,
               rollback_of_release_id, release, release_hash,
               applied_by, applied_at, created_at
        FROM prospect_message_policy_releases
        WHERE workspace_id = ${input.workspaceId}
          AND campaign_id = ${input.campaignId}
          AND channel = ${input.channel}
        ORDER BY version DESC
        LIMIT 1
        FOR SHARE
      `;
  if (!rows[0]) return null;
  const release = requireProspectMessagePolicyRelease(rows[0]);
  return {
    row: rows[0],
    release,
    receipt: buildProspectMessagePolicyReceipt({
      release,
      releaseHash: rows[0].release_hash,
    }),
  };
}

function frozenCohortProspectIds(
  definition: ProspectMessageExperimentDefinition
): number[] | null {
  if (
    definition.contractVersion !==
    PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION
  ) {
    return null;
  }
  return definition.cohort
    .map(entry => entry.prospectId)
    .sort((left, right) => left - right);
}

function assertFrozenCohortEnrollment(
  definition: ProspectMessageExperimentDefinition,
  enrolledProspectIds: number[]
): void {
  const expected = frozenCohortProspectIds(definition);
  if (!expected) return;
  const actual = [...new Set(enrolledProspectIds)].sort(
    (left, right) => left - right
  );
  if (
    actual.length !== enrolledProspectIds.length ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    throw new ProspectOutreachRouteError(
      `The frozen cohort is incomplete: ${actual.length} of ${expected.length} selected prospects are enrolled.`,
      409,
      "PROSPECT_MESSAGE_EXPERIMENT_FROZEN_COHORT_INCOMPLETE"
    );
  }
}

async function appendExperimentEvent(
  tx: SqlClient,
  input: {
    workspaceId: number;
    experimentRowId: number;
    fromState: string | null;
    toState: string;
    actor: string;
    definitionHash: string;
    details?: Record<string, unknown>;
  }
) {
  const rows = await tx<{ id: number }[]>`
    INSERT INTO prospect_message_experiment_events (
      event_id, workspace_id, experiment_row_id, from_state, to_state,
      actor, definition_hash, details
    ) VALUES (
      ${randomUUID()}, ${input.workspaceId}, ${input.experimentRowId},
      ${input.fromState}, ${input.toState}, ${input.actor},
      ${input.definitionHash}, ${tx.json(input.details || {})}
    )
    RETURNING id
  `;
  if (rows.length !== 1) {
    throw new ProspectOutreachRouteError(
      "The message experiment audit event was not recorded.",
      503,
      "PROSPECT_MESSAGE_EXPERIMENT_AUDIT_WRITE_FAILED"
    );
  }
}

async function loadActiveMessageExperiment(
  tx: SqlClient,
  input: {
    workspaceId: number;
    campaignId: number;
    channel: "email" | "call";
  }
): Promise<
  | {
      row: ProspectMessageExperimentRow;
      definition: ProspectMessageExperimentDefinition;
    }
  | null
> {
  const rows = await tx<ProspectMessageExperimentRow[]>`
    SELECT e.id, e.experiment_id, e.workspace_id, e.campaign_id,
           e.channel, e.state, e.control_variant_key,
           e.challenger_variant_key, e.allocation_basis_points,
           e.definition, e.definition_hash,
           e.inbox_placement_test_id,
           e.inbox_placement_receipt_hash,
           t.state AS inbox_placement_state,
           t.valid_until AS inbox_placement_valid_until,
           (t.valid_until > NOW()) AS inbox_placement_fresh
    FROM prospect_message_experiments e
    LEFT JOIN prospect_inbox_placement_tests t
      ON t.workspace_id = e.workspace_id
     AND t.test_id = e.inbox_placement_test_id
     AND t.receipt_hash = e.inbox_placement_receipt_hash
    WHERE e.workspace_id = ${input.workspaceId}
      AND e.campaign_id = ${input.campaignId}
      AND e.channel = ${input.channel}
      AND e.state = 'ACTIVE'
    ORDER BY e.activated_at DESC
    LIMIT 2
    FOR SHARE OF e
  `;
  if (rows.length > 1) {
    throw new ProspectOutreachRouteError(
      "More than one active message experiment exists for this campaign and channel.",
      409,
      "PROSPECT_MESSAGE_EXPERIMENT_ACTIVE_CONFLICT"
    );
  }
  if (!rows[0]) return null;
  if (
    input.channel === "email" &&
    (!rows[0].inbox_placement_test_id ||
      !rows[0].inbox_placement_receipt_hash ||
      rows[0].inbox_placement_state !== "PASSED" ||
      !rows[0].inbox_placement_valid_until ||
      rows[0].inbox_placement_fresh !== true)
  ) {
    throw new ProspectOutreachRouteError(
      "The active email experiment no longer has a fresh passing inbox-placement receipt.",
      409,
      "PROSPECT_INBOX_PLACEMENT_PROOF_REQUIRED"
    );
  }
  return {
    row: rows[0],
    definition: requireExperimentDefinition(rows[0]),
  };
}

async function loadActiveFrozenCohortReservations(
  tx: SqlClient,
  input: {
    workspaceId: number;
    campaignId: number;
  }
): Promise<
  Array<{
    row: ProspectMessageExperimentRow;
    definition: ProspectMessageExperimentDefinition & {
      contractVersion: typeof PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION;
    };
  }>
> {
  const rows = await tx<ProspectMessageExperimentRow[]>`
    SELECT id, experiment_id, workspace_id, campaign_id, channel,
           state, control_variant_key, challenger_variant_key,
           allocation_basis_points, definition, definition_hash
    FROM prospect_message_experiments
    WHERE workspace_id = ${input.workspaceId}
      AND campaign_id = ${input.campaignId}
      AND state = 'ACTIVE'
    ORDER BY activated_at ASC, id ASC
    FOR SHARE
  `;
  const reservations: Array<{
    row: ProspectMessageExperimentRow;
    definition: ProspectMessageExperimentDefinition & {
      contractVersion: typeof PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION;
    };
  }> = [];
  for (const row of rows) {
    const definition = requireExperimentDefinition(row);
    if (
      definition.contractVersion ===
      PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION
    ) {
      reservations.push({ row, definition });
    }
  }
  return reservations;
}

async function loadEligibleExperimentProspectIds(
  tx: SqlClient,
  input: {
    workspaceId: number;
    campaignId: number;
    channel: "email" | "call";
  }
): Promise<number[]> {
  const rowLimit =
    PROSPECT_MESSAGE_EXPERIMENT_MAX_ELIGIBLE_POPULATION + 1;
  const rows =
    input.channel === "email"
      ? await tx<{ id: number }[]>`
          SELECT l.id
          FROM prospect_leads l
          JOIN prospecting_campaigns c
            ON c.id = l.campaign_id
           AND c.workspace_id = ${input.workspaceId}
          WHERE l.campaign_id = ${input.campaignId}
            AND c.external_source IS DISTINCT FROM
              ${SMIRK_INTERNAL_INBOX_SEED_SOURCE}
            AND l.review_state = 'qualified'
            AND l.status = 'pending'
            AND l.email_verification = 'verified_owner_email'
            AND l.email IS NOT NULL
            AND BTRIM(l.email) <> ''
            AND l.email ~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
            AND JSONB_TYPEOF(l.research_evidence) = 'array'
            AND JSONB_ARRAY_LENGTH(l.research_evidence) > 0
            AND NOT EXISTS (
              SELECT 1
              FROM prospect_email_suppressions s
              WHERE s.workspace_id = ${input.workspaceId}
                AND s.active = TRUE
                AND LOWER(BTRIM(s.email)) = LOWER(BTRIM(l.email))
            )
            AND NOT EXISTS (
              SELECT 1
              FROM prospect_outreach_jobs j
              WHERE j.workspace_id = ${input.workspaceId}
                AND j.lead_id = l.id
                AND j.is_seed = FALSE
            )
          ORDER BY l.id ASC
          LIMIT ${rowLimit}
          FOR SHARE OF l
        `
      : await tx<{ id: number }[]>`
          SELECT l.id
          FROM prospect_leads l
          JOIN prospecting_campaigns c
            ON c.id = l.campaign_id
           AND c.workspace_id = ${input.workspaceId}
          WHERE l.campaign_id = ${input.campaignId}
            AND c.external_source IS DISTINCT FROM
              ${SMIRK_INTERNAL_INBOX_SEED_SOURCE}
            AND l.review_state = 'qualified'
            AND l.status = 'pending'
            AND l.phone_contact_mode = 'operator_review_only'
            AND l.phone IS NOT NULL
            AND BTRIM(l.phone) ~ '^[+][1-9][0-9]{7,14}$'
            AND JSONB_TYPEOF(l.research_evidence) = 'array'
            AND JSONB_ARRAY_LENGTH(l.research_evidence) > 0
            AND NOT EXISTS (
              SELECT 1
              FROM prospect_outreach_jobs j
              WHERE j.workspace_id = ${input.workspaceId}
                AND j.lead_id = l.id
                AND j.is_seed = FALSE
            )
          ORDER BY l.id ASC
          LIMIT ${rowLimit}
          FOR SHARE OF l
        `;
  if (
    rows.length >
    PROSPECT_MESSAGE_EXPERIMENT_MAX_ELIGIBLE_POPULATION
  ) {
    throw new ProspectOutreachRouteError(
      `The eligible population exceeds the ${PROSPECT_MESSAGE_EXPERIMENT_MAX_ELIGIBLE_POPULATION}-prospect audit limit.`,
      409,
      "PROSPECT_MESSAGE_EXPERIMENT_POPULATION_TOO_LARGE"
    );
  }
  return rows.map(row => Number(row.id));
}

type ActiveProspectMessageExperiment = NonNullable<
  Awaited<ReturnType<typeof loadActiveMessageExperiment>>
>;

type PreparedProspectOutreachResult = {
  outcome: "created" | "duplicate";
  approvalId: string;
  state: string;
  payloadHash: string;
  variantKey: string;
  experimentAssignment:
    | z.infer<typeof prospectMessageExperimentAssignmentSchema>
    | undefined;
};

type ProspectQcRevisionResult = {
  outcome: "revision_required" | "revision_duplicate";
  revisionId: string;
  state: "REVISION_REQUIRED" | "REJECTED" | "SUPERSEDED";
  payloadHash: string;
  variantKey: string;
  qcReceipt: ProspectQcRevisionPayload["qcReceipt"];
  experimentAssignment:
    | z.infer<typeof prospectMessageExperimentAssignmentSchema>
    | undefined;
};

async function persistProspectQcRevision(
  tx: SqlClient,
  input: {
    workspaceId: number;
    campaignId: number;
    leadId: number;
    actor: string;
    preparedAt: string;
    recipient: string;
    subject?: string;
    content: string;
    variantKey: string;
    evidenceHash: string;
    emailCompliance?: z.infer<
      typeof prospectEmailComplianceSchema
    >;
    maxCostCents: number;
    expiresInHours: number;
    qcReceipt: ProspectQcRevisionPayload["qcReceipt"];
    experimentAssignment?: z.infer<
      typeof prospectMessageExperimentAssignmentSchema
    >;
  }
): Promise<ProspectQcRevisionResult> {
  const revisionPayload = buildProspectQcRevisionPayload({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    prospectId: input.leadId,
    channel: input.qcReceipt.channel,
    recipient: input.recipient,
    subject: input.subject,
    content: input.content,
    variantKey: input.variantKey,
    evidenceHash: input.evidenceHash,
    emailCompliance: input.emailCompliance,
    maxCostCents: input.maxCostCents,
    expiresInHours: input.expiresInHours,
    qcReceipt: input.qcReceipt,
    experimentAssignment: input.experimentAssignment,
    preparedAt: input.preparedAt,
  });
  const payloadHash = hashProspectQcRevisionPayload(
    revisionPayload
  );
  const draftFingerprint = buildProspectQcRevisionFingerprint({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    prospectId: input.leadId,
    channel: revisionPayload.channel,
    recipient: revisionPayload.recipient,
    subject: revisionPayload.subject,
    content: revisionPayload.content,
    variantKey: revisionPayload.variantKey,
    evidenceHash: revisionPayload.evidenceHash,
    emailCompliance: revisionPayload.emailCompliance,
    maxCostCents: revisionPayload.maxCostCents,
    expiresInHours: revisionPayload.expiresInHours,
    qcReceipt: revisionPayload.qcReceipt,
    experimentAssignment: revisionPayload.experimentAssignment,
  });
  type ExistingRevisionRow = {
    revision_id: string;
    state: ProspectQcRevisionResult["state"];
    payload: unknown;
    payload_hash: string;
  };
  const readExistingRevision = async () =>
    tx<ExistingRevisionRow[]>`
      SELECT revision_id, state, payload, payload_hash
      FROM prospect_qc_revision_items
      WHERE workspace_id = ${input.workspaceId}
        AND lead_id = ${input.leadId}
        AND draft_fingerprint = ${draftFingerprint}
      LIMIT 1
      FOR UPDATE
    `;
  const duplicateResult = (
    row: ExistingRevisionRow
  ): ProspectQcRevisionResult => {
    const stored = prospectQcRevisionPayloadSchema.safeParse(
      parseStoredJson(row.payload)
    );
    if (
      !stored.success ||
      stored.data.revisionId !== row.revision_id ||
      stored.data.workspaceId !== input.workspaceId ||
      stored.data.campaignId !== input.campaignId ||
      stored.data.prospectId !== input.leadId ||
      hashProspectQcRevisionPayload(stored.data) !==
        row.payload_hash
    ) {
      throw new ProspectOutreachRouteError(
        "The existing QC revision failed its immutable payload check.",
        409,
        "PROSPECT_QC_REVISION_PAYLOAD_INVALID"
      );
    }
    return {
      outcome: "revision_duplicate",
      revisionId: row.revision_id,
      state: row.state,
      payloadHash: row.payload_hash,
      variantKey: stored.data.variantKey,
      qcReceipt: stored.data.qcReceipt,
      experimentAssignment: stored.data.experimentAssignment,
    };
  };
  const existingRows = await readExistingRevision();
  if (existingRows[0]) {
    return duplicateResult(existingRows[0]);
  }

  const rows = await tx<{ id: number }[]>`
    INSERT INTO prospect_qc_revision_items (
      revision_id, workspace_id, campaign_id, lead_id, channel, state,
      recipient, subject, content, variant_key, evidence_hash,
      draft_fingerprint, payload, payload_hash, prepared_by, prepared_at
    ) VALUES (
      ${revisionPayload.revisionId}, ${input.workspaceId},
      ${input.campaignId}, ${input.leadId}, ${revisionPayload.channel},
      'REVISION_REQUIRED', ${revisionPayload.recipient},
      ${revisionPayload.subject || null}, ${revisionPayload.content},
      ${revisionPayload.variantKey}, ${revisionPayload.evidenceHash},
      ${draftFingerprint}, ${tx.json(revisionPayload)}, ${payloadHash},
      ${input.actor}, ${revisionPayload.preparedAt}
    )
    ON CONFLICT (workspace_id, lead_id, draft_fingerprint)
    DO NOTHING
    RETURNING id
  `;
  if (!rows[0]) {
    const racedRows = await readExistingRevision();
    if (racedRows[0]) {
      return duplicateResult(racedRows[0]);
    }
    throw new ProspectOutreachRouteError(
      "The QC revision was not persisted.",
      503,
      "PROSPECT_QC_REVISION_WRITE_FAILED"
    );
  }
  await appendProspectQcRevisionEvent(tx, {
    workspaceId: input.workspaceId,
    revisionRowId: rows[0].id,
    fromState: null,
    toState: "REVISION_REQUIRED",
    actor: input.actor,
    payloadHash,
    details: {
      qcReceiptId: revisionPayload.qcReceipt.receiptId,
      qcRuleVersion: revisionPayload.qcReceipt.ruleVersion,
      failureReasons: revisionPayload.qcReceipt.failureReasons,
      externalAction: "none",
      approvalAuthorized: false,
      contactAuthorized: false,
      executionAuthorized: false,
      providerRequestAuthorized: false,
    },
  });
  return {
    outcome: "revision_required",
    revisionId: revisionPayload.revisionId,
    state: "REVISION_REQUIRED",
    payloadHash,
    variantKey: revisionPayload.variantKey,
    qcReceipt: revisionPayload.qcReceipt,
    experimentAssignment: revisionPayload.experimentAssignment,
  };
}

async function supersedeOpenProspectQcRevisions(
  tx: SqlClient,
  input: {
    workspaceId: number;
    leadId: number;
    channel: "email" | "call";
    outreachJobId: number;
    actor: string;
  }
): Promise<void> {
  const rows = await tx<{
    id: number;
    revision_id: string;
    payload: unknown;
    payload_hash: string;
  }[]>`
    UPDATE prospect_qc_revision_items
    SET state = 'SUPERSEDED',
        superseded_by_job_id = ${input.outreachJobId},
        superseded_at = NOW(), updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND lead_id = ${input.leadId}
      AND channel = ${input.channel}
      AND state = 'REVISION_REQUIRED'
    RETURNING id, revision_id, payload, payload_hash
  `;
  for (const row of rows) {
    const payload = prospectQcRevisionPayloadSchema.safeParse(
      parseStoredJson(row.payload)
    );
    if (
      !payload.success ||
      payload.data.revisionId !== row.revision_id ||
      payload.data.workspaceId !== input.workspaceId ||
      payload.data.prospectId !== input.leadId ||
      payload.data.channel !== input.channel ||
      hashProspectQcRevisionPayload(payload.data) !== row.payload_hash
    ) {
      throw new ProspectOutreachRouteError(
        "A superseded QC revision failed its immutable payload check.",
        409,
        "PROSPECT_QC_REVISION_PAYLOAD_INVALID"
      );
    }
    await appendProspectQcRevisionEvent(tx, {
      workspaceId: input.workspaceId,
      revisionRowId: row.id,
      fromState: "REVISION_REQUIRED",
      toState: "SUPERSEDED",
      actor: input.actor,
      payloadHash: row.payload_hash,
      details: {
        outreachJobId: input.outreachJobId,
        externalAction: "none",
        contactAuthorized: false,
        executionAuthorized: false,
      },
    });
  }
}

async function prepareProspectOutreachJob(
  tx: SqlClient,
  input: {
    workspaceId: number;
    actor: string;
    leadId: number;
    draft: z.infer<typeof prepareProspectOutreachSchema>;
    preparedAt: string;
    activeExperiment?: ActiveProspectMessageExperiment | null;
    requiredExperimentId?: string;
    crossChannelReservationChecked?: boolean;
    lead?: ProspectRow;
  }
): Promise<
  PreparedProspectOutreachResult | ProspectQcRevisionResult
> {
  const lead =
    input.lead ||
    (await requireProspect(
      tx,
      input.workspaceId,
      input.leadId,
      true
    ));
  if (lead.id !== input.leadId) {
    throw new ProspectOutreachRouteError(
      "The supplied prospect does not match the requested outreach draft.",
      409,
      "PROSPECT_OUTREACH_LEAD_MISMATCH"
    );
  }
  if (lead.review_state !== "qualified") {
    throw new ProspectOutreachRouteError(
      "A prospect must be explicitly qualified before outreach can be prepared.",
      409,
      "PROSPECT_OUTREACH_REVIEW_REQUIRED"
    );
  }
  if (lead.status === "dnc") {
    throw new ProspectOutreachRouteError(
      "This prospect is on the do-not-contact list.",
      409,
      "PROSPECT_OUTREACH_DNC"
    );
  }
  if (
    input.draft.channel === "email" &&
    lead.email_verification !== "verified_owner_email"
  ) {
    throw new ProspectOutreachRouteError(
      "A Velvet-verified owner email is required before email outreach can be prepared.",
      409,
      "PROSPECT_OUTREACH_VERIFIED_EMAIL_REQUIRED"
    );
  }
  if (
    input.draft.channel === "call" &&
    lead.phone_contact_mode !== "operator_review_only"
  ) {
    throw new ProspectOutreachRouteError(
      "The business phone must be explicitly limited to operator review before a call brief can be prepared.",
      409,
      "PROSPECT_OUTREACH_MANUAL_CALL_REVIEW_REQUIRED"
    );
  }

  const evidence = Array.isArray(lead.research_evidence)
    ? lead.research_evidence
    : [];
  if (evidence.length === 0) {
    throw new ProspectOutreachRouteError(
      "Source-classified evidence is required before drafting outreach.",
      409,
      "PROSPECT_OUTREACH_EVIDENCE_REQUIRED"
    );
  }
  const evidenceHash = hashProspectEvidence(evidence);
  let recipient: string;
  try {
    recipient = normalizeProspectOutreachRecipient(
      input.draft.channel,
      input.draft.channel === "email" ? lead.email : lead.phone
    );
  } catch (error) {
    throw new ProspectOutreachRouteError(
      error instanceof Error
        ? error.message
        : "The prospect recipient is invalid.",
      409,
      "PROSPECT_OUTREACH_RECIPIENT_INVALID"
    );
  }
  const messageContext = buildProspectMessageContext({
    businessName: lead.business_name,
    industry: lead.industry,
    researchEvidence: evidence,
  });
  const draftContent =
    input.draft.channel === "email"
      ? input.draft.body
      : input.draft.callBrief;
  const matchedVariant = findMatchingProspectMessageVariant({
    channel: input.draft.channel,
    subject:
      input.draft.channel === "email"
        ? input.draft.subject
        : undefined,
    content: draftContent,
    context: messageContext,
  });
  const attributedVariantKey =
    matchedVariant?.key ||
    `operator-custom-${canonicalJsonHash({
      channel: input.draft.channel,
      subject:
        input.draft.channel === "email"
          ? input.draft.subject.trim()
          : null,
      content: draftContent.trim(),
    }).slice(0, 16)}`;
  const attributedDraft = {
    ...input.draft,
    variantKey: attributedVariantKey,
  } satisfies PrepareProspectOutreachInput;
  const activeExperiment =
    input.activeExperiment === undefined
      ? await loadActiveMessageExperiment(tx, {
          workspaceId: input.workspaceId,
          campaignId: lead.campaign_id,
          channel: input.draft.channel,
        })
      : input.activeExperiment;
  if (
    input.requiredExperimentId &&
    activeExperiment?.definition.experimentId !==
      input.requiredExperimentId
  ) {
    throw new ProspectOutreachRouteError(
      "The required frozen experiment is no longer active for this prospect.",
      409,
      "PROSPECT_MESSAGE_EXPERIMENT_STATE_CONFLICT"
    );
  }
  if (!input.crossChannelReservationChecked) {
    const reservedByOtherChannel =
      (
        await loadActiveFrozenCohortReservations(tx, {
          workspaceId: input.workspaceId,
          campaignId: lead.campaign_id,
        })
      ).find(
        reservation =>
          reservation.definition.channel !== input.draft.channel &&
          reservation.definition.cohort.some(
            entry => entry.prospectId === lead.id
          )
      );
    if (reservedByOtherChannel) {
      throw new ProspectOutreachRouteError(
        `This prospect is reserved by the active ${reservedByOtherChannel.definition.channel} experiment and cannot enter a competing channel.`,
        409,
        "PROSPECT_MESSAGE_EXPERIMENT_COHORT_RESERVED"
      );
    }
  }
  if (
    activeExperiment?.definition.contractVersion ===
      PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION &&
    !getProspectMessageExperimentCohortEntry(
      activeExperiment.definition,
      lead.id
    )
  ) {
    throw new ProspectOutreachRouteError(
      "This prospect is outside the active experiment's frozen cohort. Close or cancel that experiment before preparing an unassigned draft.",
      409,
      "PROSPECT_MESSAGE_EXPERIMENT_PROSPECT_NOT_SELECTED"
    );
  }
  const experimentAssignment = activeExperiment
    ? buildProspectMessageExperimentAssignment({
        definition: activeExperiment.definition,
        prospectId: lead.id,
        actualVariantKey: attributedVariantKey,
      })
    : undefined;
  if (experimentAssignment) {
    const assignedDefinition = getProspectMessageVariantDefinition(
      experimentAssignment.assignedVariantKey
    );
    if (
      !assignedDefinition ||
      assignedDefinition.channel !== input.draft.channel
    ) {
      throw new ProspectOutreachRouteError(
        "The active experiment references a strategy that is no longer registered for this channel.",
        409,
        "PROSPECT_MESSAGE_EXPERIMENT_VARIANT_INVALID"
      );
    }
  }
  const qcReceipt = buildProspectQcReceipt({
    draft: attributedDraft,
    context: messageContext,
    evidenceHash,
    evaluatedAt: input.preparedAt,
  });
  if (
    !qcReceipt.deterministicPassed ||
    qcReceipt.verdict !== "ELIGIBLE_FOR_HUMAN_APPROVAL"
  ) {
    return persistProspectQcRevision(tx, {
      workspaceId: input.workspaceId,
      campaignId: lead.campaign_id,
      leadId: lead.id,
      actor: input.actor,
      preparedAt: input.preparedAt,
      recipient,
      subject:
        attributedDraft.channel === "email"
          ? attributedDraft.subject
          : undefined,
      content:
        attributedDraft.channel === "email"
          ? attributedDraft.body
          : attributedDraft.callBrief,
      variantKey: attributedVariantKey,
      evidenceHash,
      emailCompliance:
        attributedDraft.channel === "email"
          ? attributedDraft.emailCompliance
          : undefined,
      maxCostCents: attributedDraft.maxCostCents,
      expiresInHours: attributedDraft.expiresInHours,
      qcReceipt,
      experimentAssignment,
    });
  }
  let payload;
  try {
    payload = buildProspectOutreachPayload({
      workspaceId: input.workspaceId,
      campaignId: lead.campaign_id,
      prospectId: lead.id,
      recipient,
      evidenceHash,
      preparedAt: input.preparedAt,
      draft: attributedDraft,
      qcContext: messageContext,
      experimentAssignment,
    });
  } catch (error) {
    throw new ProspectOutreachRouteError(
      error instanceof Error
        ? `QC revision required: ${error.message}`
        : "The draft failed deterministic QC.",
      422,
      "PROSPECT_QC_REVISION_REQUIRED"
    );
  }
  const payloadHash = hashProspectOutreachPayload(payload);
  const draftFingerprint = canonicalJsonHash({
    workspaceId: input.workspaceId,
    prospectId: lead.id,
    channel: payload.channel,
    recipient: payload.recipient,
    subject: payload.subject || null,
    content: payload.content,
    variantKey: payload.variantKey,
    experimentAssignmentHash:
      payload.experimentAssignment?.assignmentHash || null,
    experimentProtocolCompliant:
      payload.experimentAssignment?.protocolCompliant ?? null,
    evidenceHash,
    maxCostCents: payload.maxCostCents,
  });

  if (experimentAssignment) {
    const enrollmentRows = await tx<{
      id: number;
      approval_id: string;
      state: string;
      payload_hash: string;
      variant_key: string;
      payload: unknown;
    }[]>`
      SELECT id, approval_id, state, payload_hash, variant_key, payload
      FROM prospect_outreach_jobs
      WHERE workspace_id = ${input.workspaceId}
        AND lead_id = ${lead.id}
        AND payload->'experimentAssignment'->>'experimentId'
          = ${experimentAssignment.experimentId}
      LIMIT 1
      FOR UPDATE
    `;
    if (enrollmentRows[0]) {
      const storedPayload = prospectOutreachPayloadSchema.safeParse(
        parseStoredJson(enrollmentRows[0].payload)
      );
      const storedAssignment = storedPayload.success
        ? storedPayload.data.experimentAssignment
        : undefined;
      if (
        !storedPayload.success ||
        hashProspectOutreachPayload(storedPayload.data) !==
          enrollmentRows[0].payload_hash ||
        !storedAssignment ||
        !activeExperiment ||
        !verifyProspectMessageExperimentAssignment({
          definition: activeExperiment.definition,
          assignment: storedAssignment,
        })
      ) {
        throw new ProspectOutreachRouteError(
          "The existing experiment enrollment failed its immutable assignment check.",
          409,
          "PROSPECT_MESSAGE_EXPERIMENT_ASSIGNMENT_INVALID"
        );
      }
      if (
        input.requiredExperimentId &&
        (!storedAssignment.protocolCompliant ||
          storedAssignment.actualVariantKey !==
            storedAssignment.assignedVariantKey ||
          enrollmentRows[0].variant_key !==
            storedAssignment.assignedVariantKey)
      ) {
        throw new ProspectOutreachRouteError(
          "The existing experiment enrollment is off protocol and cannot satisfy the assigned review queue.",
          409,
          "PROSPECT_MESSAGE_EXPERIMENT_DRAFT_CONFLICT"
        );
      }
      if (
        ["PREPARED", "APPROVED", "SENDING", "SENT"].includes(
          enrollmentRows[0].state
        )
      ) {
        await supersedeOpenProspectQcRevisions(tx, {
          workspaceId: input.workspaceId,
          leadId: lead.id,
          channel: payload.channel,
          outreachJobId: enrollmentRows[0].id,
          actor: input.actor,
        });
      }
      return {
        outcome: "duplicate",
        approvalId: enrollmentRows[0].approval_id,
        state: enrollmentRows[0].state,
        payloadHash: enrollmentRows[0].payload_hash,
        variantKey: enrollmentRows[0].variant_key,
        experimentAssignment: storedAssignment,
      };
    }
  }

  const existingRows = await tx<{
    id: number;
    approval_id: string;
    state: string;
    payload_hash: string;
    variant_key: string;
  }[]>`
    SELECT id, approval_id, state, payload_hash, variant_key
    FROM prospect_outreach_jobs
    WHERE workspace_id = ${input.workspaceId}
      AND lead_id = ${lead.id}
      AND draft_fingerprint = ${draftFingerprint}
      AND state IN ('PREPARED', 'APPROVED', 'SENDING')
    LIMIT 1
    FOR UPDATE
  `;
  if (existingRows[0]) {
    await supersedeOpenProspectQcRevisions(tx, {
      workspaceId: input.workspaceId,
      leadId: lead.id,
      channel: payload.channel,
      outreachJobId: existingRows[0].id,
      actor: input.actor,
    });
    return {
      outcome: "duplicate",
      approvalId: existingRows[0].approval_id,
      state: existingRows[0].state,
      payloadHash: existingRows[0].payload_hash,
      variantKey: existingRows[0].variant_key,
      experimentAssignment,
    };
  }

  const approvalId = randomUUID();
  const rows = await tx<{ id: number }[]>`
    INSERT INTO prospect_outreach_jobs (
      approval_id, workspace_id, campaign_id, lead_id, channel, state,
      recipient, subject, content, contract_version, evidence_hash,
      variant_key, draft_fingerprint, payload, payload_hash, max_cost_cents,
      prepared_by, expires_at
    ) VALUES (
      ${approvalId}, ${input.workspaceId}, ${lead.campaign_id}, ${lead.id},
      ${payload.channel}, 'PREPARED', ${payload.recipient},
      ${payload.subject || null}, ${payload.content},
      ${PROSPECT_OUTREACH_CONTRACT_VERSION}, ${evidenceHash},
      ${payload.variantKey}, ${draftFingerprint}, ${tx.json(payload)}, ${payloadHash},
      ${payload.maxCostCents}, ${input.actor}, ${payload.expiresAt}
    )
    RETURNING id
  `;
  if (!rows[0]) {
    throw new ProspectOutreachRouteError(
      "The outreach draft was not persisted.",
      503,
      "PROSPECT_OUTREACH_WRITE_FAILED"
    );
  }
  await appendOutreachEvent(tx, {
    workspaceId: input.workspaceId,
    jobId: rows[0].id,
    fromState: null,
    toState: "PREPARED",
    actor: input.actor,
    payloadHash,
    details: {
      externalAction: "none",
      requestedVariantKey: input.draft.variantKey,
      attributedVariantKey: payload.variantKey,
      variantRegistryVersion:
        PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION,
      registeredVariantContentMatched: Boolean(matchedVariant),
      experimentId:
        payload.experimentAssignment?.experimentId || null,
      experimentArm:
        payload.experimentAssignment?.arm || null,
      assignedVariantKey:
        payload.experimentAssignment?.assignedVariantKey || null,
      experimentProtocolCompliant:
        payload.experimentAssignment?.protocolCompliant ?? null,
      qcVerdict: payload.qcReceipt!.verdict,
      qcReceiptId: payload.qcReceipt!.receiptId,
      qcRuleVersion: payload.qcReceipt!.ruleVersion,
      qcModelStatus: payload.qcReceipt!.modelReview.status,
      contactAuthorizedByQc:
        payload.qcReceipt!.contactAuthorized,
      executionAuthorizedByQc:
        payload.qcReceipt!.executionAuthorized,
    },
  });
  await supersedeOpenProspectQcRevisions(tx, {
    workspaceId: input.workspaceId,
    leadId: lead.id,
    channel: payload.channel,
    outreachJobId: rows[0].id,
    actor: input.actor,
  });
  return {
    outcome: "created",
    approvalId,
    state: "PREPARED",
    payloadHash,
    variantKey: payload.variantKey,
    experimentAssignment,
  };
}

function emptyExperimentArmStats(): ProspectMessageExperimentArmCoverage {
  return {
    assigned: 0,
    executed: 0,
    measured: 0,
    outcomeEvents: 0,
  };
}

function normalizedStoredTimestamp(value: unknown): string {
  const timestamp = new Date(String(value || ""));
  if (!Number.isFinite(timestamp.getTime())) {
    throw new ProspectOutreachRouteError(
      "The experiment cohort contains an invalid stored timestamp.",
      409,
      "PROSPECT_MESSAGE_EXPERIMENT_COHORT_INVALID"
    );
  }
  return timestamp.toISOString();
}

async function loadProspectMessageExperimentEvidence(
  tx: SqlClient,
  input: {
    workspaceId: number;
    definition: ProspectMessageExperimentDefinition;
  }
): Promise<ProspectMessageExperimentEvidence> {
  const rows = await tx<{
    outreach_job_id: number;
    campaign_id: number;
    lead_id: number;
    channel: "email" | "call";
    state: string;
    variant_key: string;
    payload: unknown;
    payload_hash: string;
    outcome: string | null;
    occurred_at: string | Date | null;
  }[]>`
    SELECT j.id AS outreach_job_id, j.campaign_id, j.lead_id,
           j.channel, j.state, j.variant_key, j.payload, j.payload_hash,
           e.outcome, e.occurred_at
    FROM prospect_outreach_jobs j
    LEFT JOIN prospect_outcome_events e
      ON e.outreach_job_id = j.id
     AND e.workspace_id = j.workspace_id
    WHERE j.workspace_id = ${input.workspaceId}
      AND j.campaign_id = ${input.definition.campaignId}
      AND j.channel = ${input.definition.channel}
      AND j.payload->'experimentAssignment'->>'experimentId'
        = ${input.definition.experimentId}
    ORDER BY j.id ASC, e.occurred_at ASC
  `;

  const armStats = {
    control: emptyExperimentArmStats(),
    challenger: emptyExperimentArmStats(),
  };
  const jobs = new Map<
    number,
    {
      leadId: number;
      state: string;
      assignment: z.infer<
        typeof prospectMessageExperimentAssignmentSchema
      >;
      outcomes: LearningObservation[];
    }
  >();
  const enrolledProspects = new Set<number>();

  for (const row of rows) {
    let job = jobs.get(row.outreach_job_id);
    if (!job) {
      const payload = prospectOutreachPayloadSchema.safeParse(
        parseStoredJson(row.payload)
      );
      if (
        !payload.success ||
        payload.data.workspaceId !== input.workspaceId ||
        payload.data.campaignId !== input.definition.campaignId ||
        payload.data.prospectId !== row.lead_id ||
        payload.data.channel !== input.definition.channel ||
        payload.data.channel !== row.channel ||
        payload.data.variantKey !== row.variant_key ||
        hashProspectOutreachPayload(payload.data) !== row.payload_hash
      ) {
        throw new ProspectOutreachRouteError(
          "An enrolled outreach job failed its immutable payload check.",
          409,
          "PROSPECT_MESSAGE_EXPERIMENT_COHORT_INVALID"
        );
      }
      const assignment = payload.data.experimentAssignment;
      if (
        !assignment ||
        assignment.experimentId !== input.definition.experimentId ||
        assignment.workspaceId !== input.workspaceId ||
        assignment.campaignId !== input.definition.campaignId ||
        assignment.prospectId !== row.lead_id ||
        assignment.channel !== input.definition.channel ||
        assignment.actualVariantKey !== row.variant_key ||
        !verifyProspectMessageExperimentAssignment({
          definition: input.definition,
          assignment,
        })
      ) {
        throw new ProspectOutreachRouteError(
          "An enrolled outreach job failed its immutable assignment check.",
          409,
          "PROSPECT_MESSAGE_EXPERIMENT_COHORT_INVALID"
        );
      }
      if (enrolledProspects.has(row.lead_id)) {
        throw new ProspectOutreachRouteError(
          "A prospect was enrolled more than once in the same experiment.",
          409,
          "PROSPECT_MESSAGE_EXPERIMENT_DUPLICATE_ENROLLMENT"
        );
      }
      enrolledProspects.add(row.lead_id);
      job = {
        leadId: row.lead_id,
        state: row.state,
        assignment,
        outcomes: [],
      };
      jobs.set(row.outreach_job_id, job);
    } else if (
      job.leadId !== row.lead_id ||
      job.state !== row.state
    ) {
      throw new ProspectOutreachRouteError(
        "The experiment cohort query returned conflicting job data.",
        409,
        "PROSPECT_MESSAGE_EXPERIMENT_COHORT_INVALID"
      );
    }

    if (row.outcome === null) continue;
    const outcome = learningOutcomeSchema.safeParse(row.outcome);
    if (!outcome.success || row.occurred_at === null) {
      throw new ProspectOutreachRouteError(
        "The experiment cohort contains an invalid outcome event.",
        409,
        "PROSPECT_MESSAGE_EXPERIMENT_COHORT_INVALID"
      );
    }
    job.outcomes.push({
      outreachJobId: String(row.outreach_job_id),
      channel: row.channel,
      variantKey: row.variant_key,
      outcome: outcome.data,
      occurredAt: normalizedStoredTimestamp(row.occurred_at),
    });
  }

  assertFrozenCohortEnrollment(
    input.definition,
    [...enrolledProspects]
  );

  const observations: LearningObservation[] = [];
  let executedProtocolDeviationCount = 0;
  for (const job of jobs.values()) {
    const stats = armStats[job.assignment.arm];
    stats.assigned += 1;
    if (job.state !== "SENT") {
      if (job.outcomes.length > 0) {
        throw new ProspectOutreachRouteError(
          "An unexecuted experiment enrollment has measured outcomes.",
          409,
          "PROSPECT_MESSAGE_EXPERIMENT_COHORT_INVALID"
        );
      }
      continue;
    }
    stats.executed += 1;
    if (!job.assignment.protocolCompliant) {
      executedProtocolDeviationCount += 1;
      continue;
    }
    if (job.outcomes.length > 0) {
      stats.measured += 1;
      stats.outcomeEvents += job.outcomes.length;
      observations.push(...job.outcomes);
    }
  }

  return {
    observations,
    armStats,
    assignedProspects: jobs.size,
    executedProspects:
      armStats.control.executed + armStats.challenger.executed,
    measuredProspects:
      armStats.control.measured + armStats.challenger.measured,
    outcomeEventCount:
      armStats.control.outcomeEvents + armStats.challenger.outcomeEvents,
    executedProtocolDeviationCount,
  };
}

async function appendPositiveOutcomeReviewEvent(
  tx: SqlClient,
  input: {
    workspaceId: number;
    reviewRowId: number;
    fromState: string | null;
    toState: string;
    actor: string;
    receiptHash: string;
    details?: Record<string, unknown>;
  }
) {
  const rows = await tx<{ id: number }[]>`
    INSERT INTO prospect_positive_outcome_review_events (
      event_id, workspace_id, review_row_id, from_state, to_state,
      actor, receipt_hash, details
    ) VALUES (
      ${randomUUID()}, ${input.workspaceId}, ${input.reviewRowId},
      ${input.fromState}, ${input.toState}, ${input.actor},
      ${input.receiptHash}, ${tx.json(input.details || {})}
    )
    RETURNING id
  `;
  if (rows.length !== 1) {
    throw new ProspectOutreachRouteError(
      "The positive-outcome review audit event was not recorded.",
      503,
      "PROSPECT_POSITIVE_OUTCOME_REVIEW_AUDIT_FAILED"
    );
  }
}

async function preparePositiveOutcomeReview(
  tx: SqlClient,
  input: {
    workspaceId: number;
    lead: ProspectRow;
    outreachJob: {
      id: number;
      approval_id: string;
      channel: "email" | "call";
    };
    outcomeEventId: number;
    source: "operator" | "resend_webhook";
    actor: string;
    externalEventId: string;
    outcome: "replied" | "qualified" | "demo_booked" | "converted";
    occurredAt: string;
    notes?: string;
  }
) {
  const reviewId = randomUUID();
  const payload = buildProspectPositiveOutcomeReviewPayload({
    reviewId,
    workspaceId: input.workspaceId,
    campaignId: input.lead.campaign_id,
    prospectId: input.lead.id,
    businessName: input.lead.business_name,
    outreachJobId: input.outreachJob.id,
    outreachApprovalId: input.outreachJob.approval_id,
    channel: input.outreachJob.channel,
    outcomeEventId: input.outcomeEventId,
    outcome: input.outcome,
    eventSource: input.source,
    externalEventId: input.externalEventId,
    occurredAt: input.occurredAt,
    recordedBy: input.actor,
    notes: input.notes,
  });
  const payloadHash =
    hashProspectPositiveOutcomeReviewPayload(payload);
  const rows = await tx<{ id: number }[]>`
    INSERT INTO prospect_positive_outcome_reviews (
      review_id, workspace_id, campaign_id, lead_id,
      outreach_job_id, outcome_event_id, payload, payload_hash,
      state
    ) VALUES (
      ${reviewId}, ${input.workspaceId}, ${input.lead.campaign_id},
      ${input.lead.id}, ${input.outreachJob.id},
      ${input.outcomeEventId}, ${tx.json(payload)}, ${payloadHash},
      'PENDING'
    )
    ON CONFLICT (workspace_id, outcome_event_id) DO NOTHING
    RETURNING id
  `;
  if (rows.length !== 1) {
    throw new ProspectOutreachRouteError(
      "The positive market interaction was not durably queued for human review.",
      503,
      "PROSPECT_POSITIVE_OUTCOME_REVIEW_WRITE_FAILED"
    );
  }
  await appendPositiveOutcomeReviewEvent(tx, {
    workspaceId: input.workspaceId,
    reviewRowId: rows[0].id,
    fromState: null,
    toState: "PENDING",
    actor: input.actor,
    receiptHash: payloadHash,
    details: {
      outcomeEventId: input.outcomeEventId,
      externalAction: "none",
      contactAuthorized: false,
      executionAuthorized: false,
    },
  });
  return {
    reviewId,
    state: "PENDING" as const,
    payloadHash,
  };
}

async function recordProspectOutcomeTransaction(
  tx: SqlClient,
  input: {
    workspaceId: number;
    leadId: number;
    source: "operator" | "resend_webhook";
    actor: string;
    externalEventId: string;
    outcome: z.infer<typeof prospectOutcomeSchema>["outcome"];
    occurredAt: string;
    outreachApprovalId?: string;
    notes?: string;
  }
) {
  if (isPositiveProspectOutcome(input.outcome)) {
    await acquireProspectAcquisitionWorkspaceLock(
      tx,
      input.workspaceId
    );
  }
  const lead = await requireProspect(
    tx,
    input.workspaceId,
    input.leadId,
    true
  );
  let outreachJobId: number | null = null;
  let outreachJob:
    | {
        id: number;
        state: string;
        approval_id: string;
        channel: "email" | "call";
      evidence_hash: string;
      payload_hash: string;
      is_seed: boolean;
    }
    | undefined;
  if (input.outreachApprovalId) {
    const jobRows = await tx<{
      id: number;
      state: string;
      approval_id: string;
      channel: "email" | "call";
      evidence_hash: string;
      payload_hash: string;
      is_seed: boolean;
    }[]>`
      SELECT id, state, approval_id, channel, evidence_hash, payload_hash,
             is_seed
      FROM prospect_outreach_jobs
      WHERE approval_id = ${input.outreachApprovalId}
        AND workspace_id = ${input.workspaceId}
        AND lead_id = ${input.leadId}
      LIMIT 1
    `;
    if (!jobRows[0] || jobRows[0].state !== "SENT") {
      throw new ProspectOutreachRouteError(
        "The outcome must reference an executed recipient-specific outreach job.",
        409,
        "PROSPECT_OUTCOME_EXECUTION_REQUIRED"
      );
    }
    outreachJob = jobRows[0];
    outreachJobId = outreachJob.id;
    if (outreachJob.is_seed) {
      throw new ProspectOutreachRouteError(
        "Controlled inbox seed events cannot become prospect outcomes.",
        409,
        "PROSPECT_SEED_OUTCOME_FORBIDDEN"
      );
    }
    try {
      assertProspectOutcomeMatchesChannel(
        outreachJob.channel,
        input.outcome
      );
    } catch (error) {
      throw new ProspectOutreachRouteError(
        error instanceof Error
          ? error.message
          : "The outcome does not match the outreach channel.",
        409,
        "PROSPECT_OUTCOME_CHANNEL_MISMATCH"
      );
    }
  }
  if (lead.source === SMIRK_INTERNAL_INBOX_SEED_SOURCE) {
    throw new ProspectOutreachRouteError(
      "Controlled inbox seed records cannot become prospect outcomes.",
      409,
      "PROSPECT_SEED_OUTCOME_FORBIDDEN"
    );
  }
  if (
    lead.source === "velvet_alchemy_research" &&
    (!lead.external_id || !outreachJob)
  ) {
    throw new ProspectOutreachRouteError(
      "A Velvet prospect outcome must reference an executed outreach job.",
      409,
      "VELVET_OUTCOME_EXECUTION_REQUIRED"
    );
  }

  const inserted = await tx<{ id: number }[]>`
    INSERT INTO prospect_outcome_events (
      workspace_id, campaign_id, lead_id, outreach_job_id, source,
      external_event_id, outcome, occurred_at, notes, recorded_by
    ) VALUES (
      ${input.workspaceId}, ${lead.campaign_id}, ${input.leadId},
      ${outreachJobId}, ${input.source},
      ${input.externalEventId}, ${input.outcome},
      ${input.occurredAt}, ${input.notes || null}, ${input.actor}
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  if (!inserted[0]) {
    const existingRows = await tx<{
      lead_id: number;
      outreach_job_id: number | null;
      outcome: string;
      occurred_at: string | Date;
      notes: string | null;
    }[]>`
      SELECT lead_id, outreach_job_id, outcome, occurred_at, notes
      FROM prospect_outcome_events
      WHERE workspace_id = ${input.workspaceId}
        AND source = ${input.source}
        AND external_event_id = ${input.externalEventId}
      LIMIT 1
    `;
    if (
      existingRows[0] &&
      isExactProspectOutcomeReplay(existingRows[0], {
        leadId: input.leadId,
        outreachJobId,
        outcome: input.outcome,
        occurredAt: input.occurredAt,
        notes: input.notes,
      })
    ) {
      return {
        outcome: "duplicate" as const,
        outreachJobId,
        positiveReviewState:
          outreachJobId && isPositiveProspectOutcome(input.outcome)
            ? ("EXISTING" as const)
            : ("not_applicable" as const),
      };
    }
    if (existingRows[0]) {
      throw new ProspectOutreachRouteError(
        "The external event ID was already used for different outcome data.",
        409,
        "PROSPECT_OUTCOME_IDEMPOTENCY_CONFLICT"
      );
    }
    if (outreachJobId) {
      const duplicateOutcomeRows = await tx<{ id: number }[]>`
        SELECT id
        FROM prospect_outcome_events
        WHERE workspace_id = ${input.workspaceId}
          AND outreach_job_id = ${outreachJobId}
          AND outcome = ${input.outcome}
        LIMIT 1
      `;
      if (duplicateOutcomeRows[0]) {
        return {
          outcome: "duplicate" as const,
          outreachJobId,
          positiveReviewState:
            isPositiveProspectOutcome(input.outcome)
              ? ("EXISTING" as const)
              : ("not_applicable" as const),
        };
      }
    }
    throw new ProspectOutreachRouteError(
      "The outcome event conflicted with an existing record.",
      409,
      "PROSPECT_OUTCOME_WRITE_CONFLICT"
    );
  }

  let positiveReview:
    | {
        reviewId: string;
        state: "PENDING";
        payloadHash: string;
      }
    | null = null;
  if (
    outreachJob &&
    isPositiveProspectOutcome(input.outcome)
  ) {
    positiveReview = await preparePositiveOutcomeReview(tx, {
      workspaceId: input.workspaceId,
      lead,
      outreachJob,
      outcomeEventId: inserted[0].id,
      source: input.source,
      actor: input.actor,
      externalEventId: input.externalEventId,
      outcome: input.outcome,
      occurredAt: input.occurredAt,
      notes: input.notes,
    });
  }

  const leadOutcomeRows = await tx<{
    external_event_id: string;
    outcome: ProspectOutcome;
    occurred_at: string | Date;
  }[]>`
    SELECT external_event_id, outcome, occurred_at
    FROM prospect_outcome_events
    WHERE workspace_id = ${input.workspaceId}
      AND lead_id = ${input.leadId}
  `;
  const canonicalOutcome =
    selectCanonicalProspectOutcomeEvent(
      leadOutcomeRows.map(row => ({
        externalEventId: row.external_event_id,
        outcome: row.outcome,
        occurredAt: row.occurred_at,
      }))
    );
  const status = outcomeToProspectStatus(
    canonicalOutcome.outcome
  );
  const updated = await tx<{ id: number }[]>`
    UPDATE prospect_leads
    SET status = ${status},
        called_at = CASE
          WHEN ${input.outcome} IN (
            'call_connected', 'voicemail', 'no_answer'
          ) THEN GREATEST(
            COALESCE(
              called_at,
              ${input.occurredAt}::timestamptz
            ),
            ${input.occurredAt}::timestamptz
          )
          ELSE called_at
        END
    WHERE id = ${input.leadId}
      AND EXISTS (
        SELECT 1
        FROM prospecting_campaigns c
        WHERE c.id = prospect_leads.campaign_id
          AND c.workspace_id = ${input.workspaceId}
      )
    RETURNING id
  `;
  if (updated.length !== 1) {
    throw new ProspectOutreachRouteError(
      "The outcome was not linked to the expected prospect row.",
      409,
      "PROSPECT_OUTCOME_LINK_FAILED"
    );
  }

  let velvetCallbackState: "not_applicable" | "PREPARED" =
    "not_applicable";
  if (
    lead.source === "velvet_alchemy_research" &&
    lead.external_id &&
    outreachJob
  ) {
    const velvetPayload = buildVelvetOutcomePayload({
      workspaceId: input.workspaceId,
      externalProspectId: lead.external_id,
      externalEventId: input.externalEventId,
      outreachApprovalId: outreachJob.approval_id,
      channel: outreachJob.channel,
      outcome: input.outcome,
      occurredAt: input.occurredAt,
      evidenceHash: outreachJob.evidence_hash,
      outreachPayloadHash: outreachJob.payload_hash,
      notes: input.notes,
    });
    const velvetPayloadHash = hashVelvetOutcomePayload(velvetPayload);
    const outboxRows = await tx<{ id: number }[]>`
      INSERT INTO velvet_outcome_outbox (
        workspace_id, lead_id, outcome_event_id, external_event_id,
        external_prospect_id, payload, payload_hash, state
      ) VALUES (
        ${input.workspaceId}, ${input.leadId}, ${inserted[0].id},
        ${input.externalEventId}, ${lead.external_id},
        ${tx.json(velvetPayload)}, ${velvetPayloadHash}, 'PREPARED'
      )
      ON CONFLICT (workspace_id, external_event_id) DO NOTHING
      RETURNING id
    `;
    if (outboxRows.length !== 1) {
      throw new ProspectOutreachRouteError(
        "The Velvet outcome callback was not durably prepared.",
        409,
        "VELVET_OUTCOME_OUTBOX_WRITE_FAILED"
      );
    }
    velvetCallbackState = "PREPARED";
  }
  return {
    outcome: "recorded" as const,
    status,
    velvetCallbackState,
    outreachJobId,
    positiveReviewState:
      positiveReview?.state || "not_applicable",
    positiveReviewId: positiveReview?.reviewId || null,
  };
}

async function upsertProspectEmailSuppression(
  tx: SqlClient,
  input: {
    workspaceId: number;
    email: string;
    reason: string;
    source: string;
    recordedBy: string;
  }
) {
  const rows = await tx<{ id: number }[]>`
    INSERT INTO prospect_email_suppressions (
      workspace_id, email, reason, source, active, recorded_by
    ) VALUES (
      ${input.workspaceId}, ${input.email}, ${input.reason},
      ${input.source}, TRUE, ${input.recordedBy}
    )
    ON CONFLICT (workspace_id, email) DO UPDATE
    SET reason = EXCLUDED.reason,
        source = EXCLUDED.source,
        active = TRUE,
        recorded_by = EXCLUDED.recorded_by,
        updated_at = NOW()
    RETURNING id
  `;
  if (rows.length !== 1) {
    throw new ProspectOutreachRouteError(
      "The email suppression was not durably recorded.",
      503,
      "PROSPECT_EMAIL_SUPPRESSION_WRITE_FAILED"
    );
  }
}

async function appendVelvetDispatchEvent(
  tx: SqlClient,
  input: {
    workspaceId: number;
    outboxId: number;
    fromState: string | null;
    toState: string;
    actor: string;
    payloadHash: string;
    details?: Record<string, unknown>;
  }
) {
  const rows = await tx<{ id: number }[]>`
    INSERT INTO velvet_outcome_dispatch_events (
      event_id, workspace_id, outbox_id, from_state, to_state,
      actor, payload_hash, details
    ) VALUES (
      ${randomUUID()}, ${input.workspaceId}, ${input.outboxId},
      ${input.fromState}, ${input.toState}, ${input.actor},
      ${input.payloadHash}, ${tx.json(input.details || {})}
    )
    RETURNING id
  `;
  if (rows.length !== 1) {
    throw new ProspectOutreachRouteError(
      "The Velvet dispatch audit event was not recorded.",
      503,
      "VELVET_OUTCOME_AUDIT_WRITE_FAILED"
    );
  }
}

export function registerProspectOutreachRoutes(
  app: Express,
  deps: ProspectOutreachRouteDeps
): void {
  const {
    dashboardAuth,
    requireOperator,
    requireFullOperator,
    sql,
    dbEnabled,
    getWorkspaceId,
    env = process.env,
    fetchImpl = fetch,
    now = () => new Date(),
  } = deps;
  const requireAcquisitionUnpaused =
    createProspectAcquisitionUnpausedGuard({
      sql,
      dbEnabled,
      getWorkspaceId,
    });

  app.post(
    "/api/prospecting/resend/webhook",
    express.raw({ type: "application/json", limit: "64kb" }),
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
        });
      }
      const webhookConfig = readProspectEmailWebhookConfig(env);
      if (!webhookConfig.enabled) {
        return res.status(503).json({
          error: "Prospect email webhook is disabled.",
          code: "PROSPECT_EMAIL_WEBHOOK_DISABLED",
        });
      }
      if (!webhookConfig.configured || !webhookConfig.workspaceId) {
        return res.status(503).json({
          error: `Prospect email webhook is not configured: ${webhookConfig.missing.join(", ")}`,
          code: "PROSPECT_EMAIL_WEBHOOK_NOT_CONFIGURED",
        });
      }

      let verified: ReturnType<typeof verifyProspectEmailWebhook>;
      try {
        verified = verifyProspectEmailWebhook({
          rawBody: req.body,
          headers: req.headers,
          config: webhookConfig,
        });
      } catch {
        return res.status(401).json({
          error: "Prospect email webhook signature verification failed.",
          code: "PROSPECT_EMAIL_WEBHOOK_SIGNATURE_INVALID",
        });
      }

      let classification: ReturnType<
        typeof classifyProspectEmailWebhookEvent
      >;
      try {
        classification = classifyProspectEmailWebhookEvent(
          verified.event,
          webhookConfig.fromAddress,
          webhookConfig.replyToAddress
        );
      } catch {
        return res.status(400).json({
          error: "Prospect email webhook payload is invalid.",
          code: "PROSPECT_EMAIL_WEBHOOK_PAYLOAD_INVALID",
        });
      }

      const workspaceId = webhookConfig.workspaceId;
      const providerMessageId =
        classification.kind === "outbound_outcome"
          ? classification.providerMessageId
          : classification.kind === "inbound_reply_candidate"
            ? classification.inboundMessageId
            : null;
      const externalEventId = inboundReplyOutcomeExternalEventId(
        verified.eventId
      );

      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          const insertedRows = await tx<{ id: number }[]>`
            INSERT INTO prospect_email_provider_events (
              workspace_id, provider, provider_event_id,
              provider_message_id, event_type, payload_hash,
              process_status, details
            ) VALUES (
              ${workspaceId}, 'resend', ${verified.eventId},
              ${providerMessageId}, ${verified.event.type},
              ${verified.payloadHash}, 'RECEIVED', ${tx.json({})}
            )
            ON CONFLICT (provider, provider_event_id) DO NOTHING
            RETURNING id
          `;
          let receiptId = insertedRows[0]?.id;
          if (!receiptId) {
            const existingRows = await tx<{
              id: number;
              workspace_id: number;
              event_type: string;
              payload_hash: string;
              process_status: string;
            }[]>`
              SELECT id, workspace_id, event_type, payload_hash,
                     process_status
              FROM prospect_email_provider_events
              WHERE provider = 'resend'
                AND provider_event_id = ${verified.eventId}
              LIMIT 1 FOR UPDATE
            `;
            const existing = existingRows[0];
            if (
              !existing ||
              existing.workspace_id !== workspaceId ||
              existing.event_type !== verified.event.type ||
              existing.payload_hash !== verified.payloadHash
            ) {
              throw new ProspectOutreachRouteError(
                "The provider event ID conflicts with a different payload.",
                409,
                "PROSPECT_EMAIL_WEBHOOK_IDEMPOTENCY_CONFLICT"
              );
            }
            if (existing.process_status !== "RETRY") {
              return {
                outcome: "duplicate" as const,
                status: existing.process_status,
              };
            }
            receiptId = existing.id;
          }

          const updateReceipt = async (input: {
            status:
              | "PROCESSED"
              | "IGNORED"
              | "RETRY"
              | "REVIEW_REQUIRED";
            jobId?: number;
            details: Record<string, unknown>;
          }) => {
            const rows = await tx<{ id: number }[]>`
              UPDATE prospect_email_provider_events
              SET process_status = ${input.status},
                  outreach_job_id = ${input.jobId || null},
                  details = ${tx.json(input.details)},
                  processed_at = CASE
                    WHEN ${input.status} IN (
                      'PROCESSED', 'IGNORED', 'REVIEW_REQUIRED'
                    ) THEN NOW()
                    ELSE NULL
                  END,
                  updated_at = NOW()
              WHERE id = ${receiptId}
                AND workspace_id = ${workspaceId}
              RETURNING id
            `;
            if (rows.length !== 1) {
              throw new ProspectOutreachRouteError(
                "The provider event receipt did not change state.",
                503,
                "PROSPECT_EMAIL_WEBHOOK_RECEIPT_WRITE_FAILED"
              );
            }
          };

          if (classification.kind === "ignored") {
            await updateReceipt({
              status: "IGNORED",
              details: { reason: classification.reason },
            });
            return {
              outcome: "ignored" as const,
              status: "IGNORED" as const,
            };
          }

          if (classification.kind === "suppression_added") {
            await upsertProspectEmailSuppression(tx, {
              workspaceId,
              email: classification.email,
              reason: classification.reason,
              source: "resend_webhook",
              recordedBy: "resend_webhook",
            });
            await updateReceipt({
              status: "PROCESSED",
              details: {
                action: "suppression_recorded",
                reason: classification.reason,
              },
            });
            return {
              outcome: "processed" as const,
              status: "PROCESSED" as const,
            };
          }

          if (classification.kind === "outbound_outcome") {
            const jobRows = await tx<{
              id: number;
              lead_id: number;
              approval_id: string;
              recipient: string;
              state: string;
              is_seed: boolean;
            }[]>`
              SELECT id, lead_id, approval_id, recipient, state, is_seed
              FROM prospect_outreach_jobs
              WHERE workspace_id = ${workspaceId}
                AND provider_name = 'resend'
                AND provider_message_id =
                  ${classification.providerMessageId}
              LIMIT 1 FOR UPDATE
            `;
            const job = jobRows[0];
            if (!job || job.state !== "SENT") {
              await updateReceipt({
                status: "RETRY",
                details: {
                  reason: "provider_message_not_finalized",
                },
              });
              return {
                outcome: "retry" as const,
                status: "RETRY" as const,
              };
            }
            if (classification.suppressionReason) {
              await upsertProspectEmailSuppression(tx, {
                workspaceId,
                email: job.recipient,
                reason: classification.suppressionReason,
                source: "resend_webhook",
                recordedBy: "resend_webhook",
              });
            }
            if (job.is_seed) {
              await updateReceipt({
                status: "PROCESSED",
                jobId: job.id,
                details: {
                  action: "controlled_seed_provider_event_recorded",
                  controlledSeed: true,
                  providerOutcome: classification.outcome,
                  marketOutcomeRecorded: false,
                  velvetCallbackPrepared: false,
                },
              });
              return {
                outcome: "controlled_seed_processed" as const,
                status: "PROCESSED" as const,
                controlledSeed: true,
                marketOutcomeRecorded: false,
                velvetCallbackPrepared: false,
              };
            }
            const outcomeResult =
              await recordProspectOutcomeTransaction(tx, {
                workspaceId,
                leadId: job.lead_id,
                source: "resend_webhook",
                actor: "resend_webhook",
                externalEventId,
                outcome: classification.outcome,
                occurredAt: classification.occurredAt,
                outreachApprovalId: job.approval_id,
                notes: `Signed Resend ${verified.event.type} event.`,
              });
            await updateReceipt({
              status: "PROCESSED",
              jobId: job.id,
              details: {
                action: "outcome_recorded",
                outcome: classification.outcome,
                outcomeWrite: outcomeResult.outcome,
                velvetCallbackState:
                  "velvetCallbackState" in outcomeResult
                    ? outcomeResult.velvetCallbackState
                    : "unchanged",
              },
            });
            return {
              outcome: outcomeResult.outcome,
              status: "PROCESSED" as const,
            };
          }

          const occurredAtMs = new Date(
            classification.occurredAt
          ).getTime();
          const replyWindowStart = new Date(
            occurredAtMs - 30 * 24 * 60 * 60_000
          ).toISOString();
          const jobRows = await tx<{
            id: number;
            lead_id: number;
            approval_id: string;
            is_seed: boolean;
            business_name: string;
            sent_at: string | Date;
          }[]>`
            SELECT j.id, j.lead_id, j.approval_id, j.is_seed,
                   l.business_name, j.sent_at
            FROM prospect_outreach_jobs j
            JOIN prospect_leads l ON l.id = j.lead_id
            WHERE j.workspace_id = ${workspaceId}
              AND j.channel = 'email'
              AND j.provider_name = 'resend'
              AND j.state = 'SENT'
              AND LOWER(j.recipient) = ${classification.sender}
              AND j.sent_at >= ${replyWindowStart}
              AND j.sent_at <= ${classification.occurredAt}
            ORDER BY j.sent_at DESC
            LIMIT 2
            FOR UPDATE
          `;
          const marketJobs = jobRows.filter(job => !job.is_seed);
          if (jobRows.length > 0 && marketJobs.length === 0) {
            const job = jobRows[0];
            await updateReceipt({
              status: "PROCESSED",
              jobId: job.id,
              details: {
                action: "controlled_seed_reply_event_recorded",
                controlledSeed: true,
                marketOutcomeRecorded: false,
                velvetCallbackPrepared: false,
              },
            });
            return {
              outcome: "controlled_seed_processed" as const,
              status: "PROCESSED" as const,
              controlledSeed: true,
              marketOutcomeRecorded: false,
              velvetCallbackPrepared: false,
            };
          }
          const replyReview = buildProspectInboundReplyReviewPayload({
            reviewId: randomUUID(),
            workspaceId,
            providerEventId: verified.eventId,
            inboundMessageId: classification.inboundMessageId,
            webhookPayloadHash: verified.payloadHash,
            sender: classification.sender,
            occurredAt: classification.occurredAt,
            candidates: marketJobs.map(job => ({
              outreachJobId: job.id,
              outreachApprovalId: job.approval_id,
              prospectId: job.lead_id,
              businessName: job.business_name,
              sentAt: job.sent_at,
            })),
          });
          const replyReviewPayloadHash =
            hashProspectInboundReplyReviewPayload(replyReview);
          await updateReceipt({
            status: "REVIEW_REQUIRED",
            jobId:
              marketJobs.length === 1 ? marketJobs[0].id : undefined,
            details: {
              action:
                "inbound_reply_queued_for_human_classification",
              replyReview,
              replyReviewPayloadHash,
              contactAuthorized: false,
              executionAuthorized: false,
              providerRequestAuthorized: false,
            },
          });
          return {
            outcome: "review_required" as const,
            status: "REVIEW_REQUIRED" as const,
            reviewId: replyReview.reviewId,
            positiveOutcomeRecorded: false,
            suppressionRecorded: false,
          };
        });

        if (result.outcome === "retry") {
          return res.status(503).json({
            error:
              "The signed provider event arrived before its email job finalized.",
            code: "PROSPECT_EMAIL_WEBHOOK_RETRY_REQUIRED",
            status: result.status,
          });
        }
        return res.json({
          ok: true,
          ...result,
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.patch(
    "/api/prospecting/leads/:id/review",
    dashboardAuth,
    requireOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
        });
      }
      const leadId = parsePositiveId(req.params.id);
      const parsed = decisionSchema.safeParse(req.body);
      if (!leadId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid prospect review decision.",
          code: "PROSPECT_REVIEW_INVALID",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = actorForRequest(req);
      try {
        const rows = await sql<{ id: number }[]>`
          UPDATE prospect_leads l
          SET review_state = ${parsed.data.decision},
              reviewed_by = ${actor},
              reviewed_at = NOW(),
              notes = COALESCE(${parsed.data.notes || null}, notes)
          WHERE l.id = ${leadId}
            AND EXISTS (
              SELECT 1 FROM prospecting_campaigns c
              WHERE c.id = l.campaign_id AND c.workspace_id = ${workspaceId}
            )
          RETURNING id
        `;
        if (rows.length !== 1) {
          return res.status(404).json({
            error: "Prospect not found.",
            code: "PROSPECT_NOT_FOUND",
          });
        }
        return res.json({
          ok: true,
          reviewState: parsed.data.decision,
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.get(
    "/api/prospecting/learning/experiments",
    dashboardAuth,
    requireOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) return res.json({ experiments: [] });
      try {
        const workspaceId = getWorkspaceId(req);
        const rows = await sql<ProspectMessageExperimentRow[]>`
          SELECT e.id, e.experiment_id, e.workspace_id, e.campaign_id,
                 e.channel, e.state, e.control_variant_key,
                 e.challenger_variant_key, e.allocation_basis_points,
                 e.definition, e.definition_hash, e.prepared_by,
                 e.activated_by, e.activated_at, e.closed_by,
                 e.closed_at, e.inbox_placement_test_id,
                 e.inbox_placement_receipt_hash, e.created_at,
                 e.updated_at,
                 (
                   SELECT COUNT(*)::int
                   FROM prospect_outreach_jobs j
                   WHERE j.workspace_id = e.workspace_id
                     AND j.payload->'experimentAssignment'->>'experimentId'
                       = e.experiment_id
                 ) AS enrolled_count,
                 (
                   SELECT COUNT(*)::int
                   FROM prospect_outreach_jobs j
                   WHERE j.workspace_id = e.workspace_id
                     AND j.payload->'experimentAssignment'->>'experimentId'
                       = e.experiment_id
                     AND j.state = 'PREPARED'
                 ) AS prepared_count,
                 (
                   SELECT COUNT(*)::int
                   FROM prospect_outreach_jobs j
                   WHERE j.workspace_id = e.workspace_id
                     AND j.payload->'experimentAssignment'->>'experimentId'
                       = e.experiment_id
                     AND j.state IN (
                       'SENT', 'FAILED', 'REJECTED', 'EXPIRED', 'CANCELLED'
                     )
                 ) AS terminal_count
          FROM prospect_message_experiments e
          WHERE e.workspace_id = ${workspaceId}
          ORDER BY e.created_at DESC
          LIMIT 100
        `;
        const experiments = rows.map(row => {
          requireExperimentDefinition(row);
          return row;
        });
        return res.json({
          experiments,
          policyChanged: false,
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/learning/experiments",
    dashboardAuth,
    requireOperator,
    requireFullOperator,
    requireAcquisitionUnpaused,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
        });
      }
      const parsed = prepareMessageExperimentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid message experiment definition.",
          code: "PROSPECT_MESSAGE_EXPERIMENT_INVALID",
        });
      }
      const control = getProspectMessageVariantDefinition(
        parsed.data.controlVariantKey
      );
      const challenger = getProspectMessageVariantDefinition(
        parsed.data.challengerVariantKey
      );
      if (
        !control ||
        !challenger ||
        control.channel !== parsed.data.channel ||
        challenger.channel !== parsed.data.channel
      ) {
        return res.status(409).json({
          error:
            "Message experiments require two registered content-bound strategies for the selected channel.",
          code: "PROSPECT_MESSAGE_EXPERIMENT_VARIANT_INVALID",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = actorForRequest(req);
      const preparedAt = now().toISOString();
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          await assertProspectAcquisitionMutationUnpaused(
            tx,
            workspaceId
          );
          const campaignRows = await tx<{ id: number }[]>`
            SELECT id
            FROM prospecting_campaigns
            WHERE id = ${parsed.data.campaignId}
              AND workspace_id = ${workspaceId}
              AND external_source IS DISTINCT FROM
                ${SMIRK_INTERNAL_INBOX_SEED_SOURCE}
            LIMIT 1
            FOR UPDATE
          `;
          if (campaignRows.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The selected prospecting campaign was not found.",
              404,
              "PROSPECT_CAMPAIGN_NOT_FOUND"
            );
          }
          const currentPolicy =
            await loadCurrentProspectMessagePolicy(tx, {
              workspaceId,
              campaignId: parsed.data.campaignId,
              channel: parsed.data.channel,
            });
          if (
            currentPolicy &&
            parsed.data.controlVariantKey !==
              currentPolicy.release.championVariantKey
          ) {
            throw new ProspectOutreachRouteError(
              "The next experiment control must match the campaign's current reviewed message-policy champion.",
              409,
              "PROSPECT_MESSAGE_POLICY_CONTROL_REQUIRED"
            );
          }
          const activeRows = await tx<{ experiment_id: string }[]>`
            SELECT experiment_id
            FROM prospect_message_experiments
            WHERE workspace_id = ${workspaceId}
              AND campaign_id = ${parsed.data.campaignId}
              AND channel = ${parsed.data.channel}
              AND state = 'ACTIVE'
            LIMIT 1
            FOR UPDATE
          `;
          if (activeRows[0]) {
            throw new ProspectOutreachRouteError(
              "Close the active experiment for this campaign and channel before preparing another.",
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_ALREADY_ACTIVE"
            );
          }
          const eligibleProspectIds =
            await loadEligibleExperimentProspectIds(tx, {
              workspaceId,
              campaignId: parsed.data.campaignId,
              channel: parsed.data.channel,
            });
          if (
            eligibleProspectIds.length <
            parsed.data.cohortSize
          ) {
            throw new ProspectOutreachRouteError(
              `The campaign has ${eligibleProspectIds.length} untouched eligible ${parsed.data.channel} prospects; ${parsed.data.cohortSize} are required for this frozen cohort.`,
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_ELIGIBLE_COHORT_TOO_SMALL"
            );
          }
          const definition = buildProspectMessageExperimentDefinition({
            workspaceId,
            campaignId: parsed.data.campaignId,
            channel: parsed.data.channel,
            controlVariantKey: parsed.data.controlVariantKey,
            challengerVariantKey: parsed.data.challengerVariantKey,
            preparedAt,
            eligibleProspectIds,
            cohortSize: parsed.data.cohortSize,
            appliedPolicy: currentPolicy?.receipt,
          });
          const definitionHash =
            hashProspectMessageExperimentDefinition(definition);
          const rows = await tx<{ id: number }[]>`
            INSERT INTO prospect_message_experiments (
              experiment_id, workspace_id, campaign_id, channel, state,
              control_variant_key, challenger_variant_key,
              allocation_basis_points, definition, definition_hash,
              prepared_by
            ) VALUES (
              ${definition.experimentId}, ${workspaceId},
              ${definition.campaignId}, ${definition.channel}, 'PREPARED',
              ${definition.controlVariantKey},
              ${definition.challengerVariantKey},
              ${definition.allocationBasisPoints}, ${tx.json(definition)},
              ${definitionHash}, ${actor}
            )
            RETURNING id
          `;
          if (rows.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The message experiment was not durably prepared.",
              503,
              "PROSPECT_MESSAGE_EXPERIMENT_WRITE_FAILED"
            );
          }
          await appendExperimentEvent(tx, {
            workspaceId,
            experimentRowId: rows[0].id,
            fromState: null,
            toState: "PREPARED",
            actor,
            definitionHash,
            details: {
              studyDesign: definition.studyDesign,
              eligiblePopulationSize:
                definition.eligiblePopulationSize,
              eligiblePopulationHash:
                definition.eligiblePopulationHash,
              cohortSize: definition.cohortSize,
              selectedProspectIdsHash:
                definition.selectedProspectIdsHash,
              controlProspects: definition.cohort.filter(
                entry => entry.arm === "control"
              ).length,
              challengerProspects: definition.cohort.filter(
                entry => entry.arm === "challenger"
              ).length,
              externalAction: "none",
              contactAuthorized: false,
              spendAuthorized: false,
            },
          });
          return { definition, definitionHash };
        });
        return res.status(201).json({
          ok: true,
          state: "PREPARED",
          experimentId: result.definition.experimentId,
          definition: result.definition,
          definitionHash: result.definitionHash,
          policyChanged: false,
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/learning/experiments/:experimentId/activate",
    dashboardAuth,
    requireOperator,
    requireFullOperator,
    requireAcquisitionUnpaused,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
        });
      }
      const experimentId = z.string().uuid().safeParse(
        req.params.experimentId
      );
      const parsed = activateMessageExperimentSchema.safeParse(req.body);
      if (!experimentId.success || !parsed.success) {
        return res.status(400).json({
          error: "Invalid message experiment activation.",
          code: "PROSPECT_MESSAGE_EXPERIMENT_ACTIVATION_INVALID",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = actorForRequest(req);
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          await assertProspectAcquisitionMutationUnpaused(
            tx,
            workspaceId
          );
          const rows = await tx<ProspectMessageExperimentRow[]>`
            SELECT id, experiment_id, workspace_id, campaign_id, channel,
                   state, control_variant_key, challenger_variant_key,
                   allocation_basis_points, definition, definition_hash,
                   inbox_placement_test_id,
                   inbox_placement_receipt_hash
            FROM prospect_message_experiments
            WHERE workspace_id = ${workspaceId}
              AND experiment_id = ${experimentId.data}
            LIMIT 1
            FOR UPDATE
          `;
          const row = rows[0];
          if (!row) {
            throw new ProspectOutreachRouteError(
              "Message experiment not found.",
              404,
              "PROSPECT_MESSAGE_EXPERIMENT_NOT_FOUND"
            );
          }
          const definition = requireExperimentDefinition(row);
          if (row.definition_hash !== parsed.data.definitionHash) {
            throw new ProspectOutreachRouteError(
              "The activation does not match the reviewed experiment definition.",
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_HASH_MISMATCH"
            );
          }
          const inboxPlacementProof =
            row.channel === "email"
              ? await loadPassingProspectInboxPlacementProof(tx, {
                  workspaceId,
                  campaignId: row.campaign_id,
                  controlVariantKey: row.control_variant_key,
                  challengerVariantKey: row.challenger_variant_key,
                  now: now(),
                })
              : null;
          if (row.state === "ACTIVE") {
            if (
              row.channel === "email" &&
              (!inboxPlacementProof ||
                row.inbox_placement_test_id !==
                  inboxPlacementProof.testId ||
                row.inbox_placement_receipt_hash !==
                  inboxPlacementProof.receiptHash)
            ) {
              throw new ProspectOutreachRouteError(
                "The active email experiment is not bound to a fresh passing inbox-placement receipt.",
                409,
                "PROSPECT_INBOX_PLACEMENT_PROOF_REQUIRED"
              );
            }
            return {
              outcome: "duplicate" as const,
              row,
              inboxPlacementProof,
            };
          }
          if (row.state !== "PREPARED") {
            throw new ProspectOutreachRouteError(
              `A ${row.state} experiment cannot be activated.`,
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_STATE_CONFLICT"
            );
          }
          const campaignRows = await tx<{ id: number }[]>`
            SELECT id
            FROM prospecting_campaigns
            WHERE id = ${row.campaign_id}
              AND workspace_id = ${workspaceId}
            LIMIT 1
            FOR UPDATE
          `;
          if (campaignRows.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The experiment campaign was not found.",
              404,
              "PROSPECT_CAMPAIGN_NOT_FOUND"
            );
          }
          const currentPolicy =
            await loadCurrentProspectMessagePolicy(tx, {
              workspaceId,
              campaignId: row.campaign_id,
              channel: row.channel,
              lock: true,
            });
          const appliedPolicy =
            definition.contractVersion ===
            PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION
              ? definition.appliedPolicy
              : undefined;
          const policyStillCurrent =
            (!currentPolicy && !appliedPolicy) ||
            Boolean(
              currentPolicy &&
                appliedPolicy &&
                currentPolicy.receipt.releaseId ===
                  appliedPolicy.releaseId &&
                currentPolicy.receipt.releaseHash ===
                  appliedPolicy.releaseHash &&
                currentPolicy.receipt.version ===
                  appliedPolicy.version &&
                currentPolicy.receipt.championVariantKey ===
                  appliedPolicy.championVariantKey
            );
          if (!policyStillCurrent) {
            throw new ProspectOutreachRouteError(
              "The reviewed message policy changed after this experiment was prepared. Cancel it and prepare a new frozen cohort.",
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_POLICY_STALE"
            );
          }
          const activeRows = await tx<{ experiment_id: string }[]>`
            SELECT experiment_id
            FROM prospect_message_experiments
            WHERE workspace_id = ${workspaceId}
              AND campaign_id = ${row.campaign_id}
              AND channel = ${row.channel}
              AND state = 'ACTIVE'
              AND experiment_id <> ${row.experiment_id}
            LIMIT 1
            FOR UPDATE
          `;
          if (activeRows[0]) {
            throw new ProspectOutreachRouteError(
              "Another experiment is already active for this campaign and channel.",
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_ALREADY_ACTIVE"
            );
          }
          if (
            definition.contractVersion ===
            PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION
          ) {
            const currentlyEligible =
              await loadEligibleExperimentProspectIds(tx, {
                workspaceId,
                campaignId: definition.campaignId,
                channel: definition.channel,
              });
            const currentEligibleSet = new Set(currentlyEligible);
            const ineligibleSelected = definition.cohort.filter(
              entry => !currentEligibleSet.has(entry.prospectId)
            );
            if (ineligibleSelected.length > 0) {
              throw new ProspectOutreachRouteError(
                `${ineligibleSelected.length} selected prospects are no longer untouched and eligible. Cancel this experiment and prepare a new frozen cohort.`,
                409,
                "PROSPECT_MESSAGE_EXPERIMENT_COHORT_ELIGIBILITY_DRIFT"
              );
            }
            const selectedIds = new Set(
              definition.cohort.map(entry => entry.prospectId)
            );
            const conflictingReservations =
              (
                await loadActiveFrozenCohortReservations(tx, {
                  workspaceId,
                  campaignId: definition.campaignId,
                })
              ).filter(
                reservation =>
                  reservation.row.experiment_id !==
                    definition.experimentId &&
                  reservation.definition.cohort.some(entry =>
                    selectedIds.has(entry.prospectId)
                  )
              );
            if (conflictingReservations.length > 0) {
              throw new ProspectOutreachRouteError(
                "Another active experiment already reserves at least one selected prospect.",
                409,
                "PROSPECT_MESSAGE_EXPERIMENT_COHORT_RESERVATION_CONFLICT"
              );
            }
          }
          if (row.channel === "email" && !inboxPlacementProof) {
            throw new ProspectOutreachRouteError(
              "A fresh all-pass five-inbox placement receipt is required before an email experiment can activate.",
              409,
              "PROSPECT_INBOX_PLACEMENT_PROOF_REQUIRED"
            );
          }
          const updated = await tx<{ id: number }[]>`
            UPDATE prospect_message_experiments
            SET state = 'ACTIVE', activated_by = ${actor},
                activated_at = NOW(),
                inbox_placement_test_id =
                  ${inboxPlacementProof?.testId || null},
                inbox_placement_receipt_hash =
                  ${inboxPlacementProof?.receiptHash || null},
                updated_at = NOW()
            WHERE id = ${row.id}
              AND workspace_id = ${workspaceId}
              AND state = 'PREPARED'
              AND definition_hash = ${parsed.data.definitionHash}
            RETURNING id
          `;
          if (updated.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The experiment activation changed no durable row.",
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_ACTIVATION_CONFLICT"
            );
          }
          await appendExperimentEvent(tx, {
            workspaceId,
            experimentRowId: row.id,
            fromState: "PREPARED",
            toState: "ACTIVE",
            actor,
            definitionHash: row.definition_hash,
            details: {
              attestations: parsed.data.attestations,
              inboxPlacementTestId:
                inboxPlacementProof?.testId || null,
              inboxPlacementReceiptHash:
                inboxPlacementProof?.receiptHash || null,
              inboxPlacementValidUntil:
                inboxPlacementProof?.validUntil || null,
              contactAuthorized: false,
              spendAuthorized: false,
            },
          });
          return {
            outcome: "activated" as const,
            row,
            inboxPlacementProof,
          };
        });
        return res.json({
          ok: true,
          outcome: result.outcome,
          state: "ACTIVE",
          experimentId: result.row.experiment_id,
          inboxPlacementTestId:
            result.inboxPlacementProof?.testId ||
            result.row.inbox_placement_test_id ||
            null,
          policyChanged: false,
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/learning/experiments/:experimentId/prepare-drafts",
    dashboardAuth,
    requireOperator,
    requireFullOperator,
    requireAcquisitionUnpaused,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
        });
      }
      const experimentId = z.string().uuid().safeParse(
        req.params.experimentId
      );
      const parsed = prepareMessageExperimentDraftsSchema.safeParse(
        req.body
      );
      if (!experimentId.success || !parsed.success) {
        return res.status(400).json({
          error:
            "Invalid frozen-cohort draft preparation request.",
          code: "PROSPECT_MESSAGE_EXPERIMENT_DRAFTS_INVALID",
          issues: parsed.success ? [] : parsed.error.issues,
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = auditedOutreachActorForRequest(req);
      const preparedAt = now().toISOString();
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          await assertProspectAcquisitionMutationUnpaused(
            tx,
            workspaceId
          );
          const rows = await tx<ProspectMessageExperimentRow[]>`
            SELECT id, experiment_id, workspace_id, campaign_id, channel,
                   state, control_variant_key, challenger_variant_key,
                   allocation_basis_points, definition, definition_hash,
                   inbox_placement_test_id,
                   inbox_placement_receipt_hash
            FROM prospect_message_experiments
            WHERE workspace_id = ${workspaceId}
              AND experiment_id = ${experimentId.data}
            LIMIT 1
            FOR UPDATE
          `;
          const row = rows[0];
          if (!row) {
            throw new ProspectOutreachRouteError(
              "Message experiment not found.",
              404,
              "PROSPECT_MESSAGE_EXPERIMENT_NOT_FOUND"
            );
          }
          const definition = requireExperimentDefinition(row);
          if (row.definition_hash !== parsed.data.definitionHash) {
            throw new ProspectOutreachRouteError(
              "The draft batch does not match the reviewed experiment definition.",
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_HASH_MISMATCH"
            );
          }
          if (row.state !== "ACTIVE") {
            throw new ProspectOutreachRouteError(
              `A ${row.state} experiment cannot prepare cohort drafts.`,
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_STATE_CONFLICT"
            );
          }
          if (
            definition.contractVersion !==
            PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION
          ) {
            throw new ProspectOutreachRouteError(
              "Only an immutable frozen-cohort experiment can prepare assigned drafts.",
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_FROZEN_COHORT_REQUIRED"
            );
          }
          if (definition.channel !== parsed.data.channel) {
            throw new ProspectOutreachRouteError(
              "The requested draft channel does not match the frozen experiment.",
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_CHANNEL_MISMATCH"
            );
          }

          const campaignRows = await tx<{ id: number }[]>`
            SELECT id
            FROM prospecting_campaigns
            WHERE id = ${definition.campaignId}
              AND workspace_id = ${workspaceId}
            LIMIT 1
            FOR UPDATE
          `;
          if (campaignRows.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The experiment campaign was not found.",
              404,
              "PROSPECT_CAMPAIGN_NOT_FOUND"
            );
          }
          const activeExperiment = await loadActiveMessageExperiment(tx, {
            workspaceId,
            campaignId: definition.campaignId,
            channel: definition.channel,
          });
          if (
            !activeExperiment ||
            activeExperiment.definition.experimentId !==
              definition.experimentId
          ) {
            throw new ProspectOutreachRouteError(
              "The reviewed frozen experiment is no longer the active assignment source.",
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_STATE_CONFLICT"
            );
          }
          const selectedIds = new Set(
            definition.cohort.map(entry => entry.prospectId)
          );
          const reservationConflict =
            (
              await loadActiveFrozenCohortReservations(tx, {
                workspaceId,
                campaignId: definition.campaignId,
              })
            ).find(
              reservation =>
                reservation.row.experiment_id !==
                  definition.experimentId &&
                reservation.definition.cohort.some(entry =>
                  selectedIds.has(entry.prospectId)
                )
            );
          if (reservationConflict) {
            throw new ProspectOutreachRouteError(
              "Another active experiment reserves at least one selected prospect.",
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_COHORT_RESERVATION_CONFLICT"
            );
          }

          const preparedResults: PreparedProspectOutreachResult[] = [];
          const cohort = [...definition.cohort].sort(
            (left, right) =>
              left.selectionRank - right.selectionRank
          );
          for (const entry of cohort) {
            const lead = await requireProspect(
              tx,
              workspaceId,
              entry.prospectId,
              true
            );
            const evidence = Array.isArray(lead.research_evidence)
              ? lead.research_evidence
              : [];
            const rendered = renderProspectMessageVariant(
              entry.assignedVariantKey,
              buildProspectMessageContext({
                businessName: lead.business_name,
                industry: lead.industry,
                researchEvidence: evidence,
              })
            );
            if (
              !rendered ||
              rendered.channel !== definition.channel ||
              (definition.channel === "email" &&
                !rendered.subject)
            ) {
              throw new ProspectOutreachRouteError(
                "A frozen cohort assignment no longer resolves to valid registered content.",
                409,
                "PROSPECT_MESSAGE_EXPERIMENT_VARIANT_INVALID"
              );
            }
            const draft = prepareProspectOutreachSchema.safeParse(
              definition.channel === "email"
                ? {
                    channel: "email",
                    subject: rendered.subject,
                    body: rendered.content,
                    emailCompliance:
                      parsed.data.channel === "email"
                        ? parsed.data.emailCompliance
                        : undefined,
                    variantKey: entry.assignedVariantKey,
                    maxCostCents: parsed.data.maxCostCents,
                    expiresInHours: parsed.data.expiresInHours,
                  }
                : {
                    channel: "call",
                    callBrief: rendered.content,
                    variantKey: entry.assignedVariantKey,
                    maxCostCents: parsed.data.maxCostCents,
                    expiresInHours: parsed.data.expiresInHours,
                  }
            );
            if (!draft.success) {
              throw new ProspectOutreachRouteError(
                "A frozen cohort draft failed its recipient-specific schema.",
                422,
                "PROSPECT_QC_REVISION_REQUIRED"
              );
            }
            const prepared = await prepareProspectOutreachJob(tx, {
              workspaceId,
              actor,
              leadId: entry.prospectId,
              lead,
              draft: draft.data,
              preparedAt,
              activeExperiment,
              requiredExperimentId: definition.experimentId,
              crossChannelReservationChecked: true,
            });
            if (
              prepared.outcome === "revision_required" ||
              prepared.outcome === "revision_duplicate" ||
              !("approvalId" in prepared)
            ) {
              throw new ProspectOutreachRouteError(
                "A frozen cohort draft requires deterministic revision; no partial cohort queue was committed.",
                422,
                "PROSPECT_QC_REVISION_REQUIRED"
              );
            }
            preparedResults.push(prepared);
          }

          const stateCounts = preparedResults.reduce<
            Record<string, number>
          >((counts, prepared) => {
            counts[prepared.state] =
              (counts[prepared.state] || 0) + 1;
            return counts;
          }, {});
          const createdCount = preparedResults.filter(
            prepared => prepared.outcome === "created"
          ).length;
          const approvalIds = preparedResults
            .map(prepared => prepared.approvalId)
            .sort();
          if (createdCount > 0) {
            await appendExperimentEvent(tx, {
              workspaceId,
              experimentRowId: row.id,
              fromState: "ACTIVE",
              toState: "ACTIVE",
              actor,
              definitionHash: row.definition_hash,
              details: {
                action: "frozen_cohort_drafts_prepared",
                selectedCount: cohort.length,
                createdCount,
                duplicateCount:
                  preparedResults.length - createdCount,
                pendingHumanReview:
                  stateCounts.PREPARED || 0,
                stateCounts,
                approvalIdsHash: canonicalJsonHash(approvalIds),
                attestations: parsed.data.attestations,
                externalAction: "none",
                contactAuthorized: false,
                executionAuthorized: false,
                spendAuthorized: false,
              },
            });
          }
          return {
            selectedCount: cohort.length,
            createdCount,
            duplicateCount:
              preparedResults.length - createdCount,
            pendingHumanReview: stateCounts.PREPARED || 0,
            stateCounts,
            approvalIds,
          };
        });
        return res
          .status(result.createdCount > 0 ? 201 : 200)
          .json({
            ok: true,
            outcome:
              result.createdCount > 0 ? "created" : "duplicate",
            experimentId: experimentId.data,
            ...result,
            externalAction: "none",
            contactAuthorized: false,
            executionAuthorized: false,
            spendAuthorized: false,
          });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/learning/experiments/:experimentId/close",
    dashboardAuth,
    requireOperator,
    requireFullOperator,
    requireAcquisitionUnpaused,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
        });
      }
      const experimentId = z.string().uuid().safeParse(
        req.params.experimentId
      );
      const parsed = closeMessageExperimentSchema.safeParse(req.body);
      if (!experimentId.success || !parsed.success) {
        return res.status(400).json({
          error: "Invalid message experiment closure.",
          code: "PROSPECT_MESSAGE_EXPERIMENT_CLOSE_INVALID",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = actorForRequest(req);
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          await assertProspectAcquisitionMutationUnpaused(
            tx,
            workspaceId
          );
          const rows = await tx<ProspectMessageExperimentRow[]>`
            SELECT id, experiment_id, workspace_id, campaign_id, channel,
                   state, control_variant_key, challenger_variant_key,
                   allocation_basis_points, definition, definition_hash
            FROM prospect_message_experiments
            WHERE workspace_id = ${workspaceId}
              AND experiment_id = ${experimentId.data}
            LIMIT 1
            FOR UPDATE
          `;
          const row = rows[0];
          if (!row) {
            throw new ProspectOutreachRouteError(
              "Message experiment not found.",
              404,
              "PROSPECT_MESSAGE_EXPERIMENT_NOT_FOUND"
            );
          }
          const definition = requireExperimentDefinition(row);
          if (row.definition_hash !== parsed.data.definitionHash) {
            throw new ProspectOutreachRouteError(
              "The closure does not match the active experiment definition.",
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_HASH_MISMATCH"
            );
          }
          if (row.state === "CLOSED") {
            return { outcome: "duplicate" as const, row };
          }
          if (row.state !== "ACTIVE") {
            throw new ProspectOutreachRouteError(
              `A ${row.state} experiment cannot be closed.`,
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_STATE_CONFLICT"
            );
          }
          if (
            definition.contractVersion ===
            PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION
          ) {
            const enrollmentRows = await tx<{
              lead_id: number;
              campaign_id: number;
              channel: "email" | "call";
            }[]>`
              SELECT lead_id, campaign_id, channel
              FROM prospect_outreach_jobs
              WHERE workspace_id = ${workspaceId}
                AND payload->'experimentAssignment'->>'experimentId'
                  = ${row.experiment_id}
              ORDER BY lead_id ASC
            `;
            if (
              enrollmentRows.some(
                enrollment =>
                  Number(enrollment.campaign_id) !==
                    definition.campaignId ||
                  enrollment.channel !== definition.channel
              )
            ) {
              throw new ProspectOutreachRouteError(
                "An enrolled job does not match the frozen experiment campaign and channel.",
                409,
                "PROSPECT_MESSAGE_EXPERIMENT_COHORT_INVALID"
              );
            }
            assertFrozenCohortEnrollment(
              definition,
              enrollmentRows.map(enrollment =>
                Number(enrollment.lead_id)
              )
            );
          }
          const closureRows = await tx<{
            pending_count: number | string;
            sent_count: number | string;
            sent_without_timestamp_count: number | string;
            sent_without_outcome_count: number | string;
            latest_sent_at: string | Date | null;
            observed_at: string | Date;
          }[]>`
            SELECT
              (COUNT(*) FILTER (
                WHERE j.state IN ('PREPARED', 'APPROVED', 'SENDING')
              ))::int AS pending_count,
              (COUNT(*) FILTER (
                WHERE j.state = 'SENT'
              ))::int AS sent_count,
              (COUNT(*) FILTER (
                WHERE j.state = 'SENT' AND j.sent_at IS NULL
              ))::int AS sent_without_timestamp_count,
              (COUNT(*) FILTER (
                WHERE j.state = 'SENT'
                  AND NOT EXISTS (
                    SELECT 1
                    FROM prospect_outcome_events o
                    WHERE o.workspace_id = j.workspace_id
                      AND o.outreach_job_id = j.id
                  )
              ))::int AS sent_without_outcome_count,
              MAX(j.sent_at) FILTER (
                WHERE j.state = 'SENT'
              ) AS latest_sent_at,
              NOW() AS observed_at
            FROM prospect_outreach_jobs j
            WHERE j.workspace_id = ${workspaceId}
              AND j.payload->'experimentAssignment'->>'experimentId'
                = ${row.experiment_id}
          `;
          const closure = closureRows[0];
          const pendingCount = Number(closure?.pending_count || 0);
          const sentCount = Number(closure?.sent_count || 0);
          const sentWithoutTimestampCount = Number(
            closure?.sent_without_timestamp_count || 0
          );
          const sentWithoutOutcomeCount = Number(
            closure?.sent_without_outcome_count || 0
          );
          if (!Number.isSafeInteger(pendingCount) || pendingCount > 0) {
            throw new ProspectOutreachRouteError(
              "Resolve or cancel every prepared, approved, or sending experiment job before closure.",
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_JOBS_NOT_TERMINAL"
            );
          }
          if (
            !Number.isSafeInteger(sentCount) ||
            !Number.isSafeInteger(sentWithoutTimestampCount) ||
            sentWithoutTimestampCount > 0 ||
            (sentCount > 0 &&
              (!closure ||
                closure.latest_sent_at === null ||
                closure.latest_sent_at === undefined))
          ) {
            throw new ProspectOutreachRouteError(
              "Every sent experiment job requires a durable execution timestamp before closure.",
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_SENT_TIMESTAMP_REQUIRED"
            );
          }
          if (
            !Number.isSafeInteger(sentWithoutOutcomeCount) ||
            sentWithoutOutcomeCount > 0
          ) {
            throw new ProspectOutreachRouteError(
              "Every sent experiment job requires at least one measured outcome before closure.",
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_OUTCOMES_INCOMPLETE"
            );
          }
          const closureObservedAt = normalizedStoredTimestamp(
            closure?.observed_at
          );
          let latestSentAt: string | null = null;
          let observationWindowEndsAt: string | null = null;
          if (sentCount > 0) {
            latestSentAt = normalizedStoredTimestamp(
              closure?.latest_sent_at
            );
            observationWindowEndsAt =
              prospectMessageExperimentObservationWindowEndsAt({
                channel: definition.channel,
                latestSentAt,
              });
            if (
              new Date(closureObservedAt).getTime() <
              new Date(observationWindowEndsAt).getTime()
            ) {
              throw new ProspectOutreachRouteError(
                `The ${definition.channel} outcome observation window remains open until ${observationWindowEndsAt}.`,
                409,
                "PROSPECT_MESSAGE_EXPERIMENT_OBSERVATION_WINDOW_OPEN"
              );
            }
          }
          const observationWindow = {
            channel: definition.channel,
            hours:
              PROSPECT_MESSAGE_EXPERIMENT_OBSERVATION_WINDOW_HOURS[
                definition.channel
              ],
            sentJobCount: sentCount,
            measuredSentJobCount:
              sentCount - sentWithoutOutcomeCount,
            latestSentAt,
            endsAt: observationWindowEndsAt,
            observedAt: closureObservedAt,
          };
          const updated = await tx<{ id: number }[]>`
            UPDATE prospect_message_experiments
            SET state = 'CLOSED', closed_by = ${actor},
                closed_at = NOW(), updated_at = NOW()
            WHERE id = ${row.id}
              AND workspace_id = ${workspaceId}
              AND state = 'ACTIVE'
              AND definition_hash = ${parsed.data.definitionHash}
            RETURNING id
          `;
          if (updated.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The experiment closure changed no durable row.",
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_CLOSE_CONFLICT"
            );
          }
          await appendExperimentEvent(tx, {
            workspaceId,
            experimentRowId: row.id,
            fromState: "ACTIVE",
            toState: "CLOSED",
            actor,
            definitionHash: row.definition_hash,
            details: {
              attestations: parsed.data.attestations,
              observationWindow,
              externalAction: "none",
              contactAuthorized: false,
              spendAuthorized: false,
            },
          });
          return {
            outcome: "closed" as const,
            row,
            observationWindow,
          };
        });
        return res.json({
          ok: true,
          outcome: result.outcome,
          state: "CLOSED",
          experimentId: result.row.experiment_id,
          ...(result.outcome === "closed"
            ? { observationWindow: result.observationWindow }
            : {}),
          policyChanged: false,
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/learning/experiments/:experimentId/cancel",
    dashboardAuth,
    requireOperator,
    requireFullOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
        });
      }
      const experimentId = z.string().uuid().safeParse(
        req.params.experimentId
      );
      const parsed = cancelMessageExperimentSchema.safeParse(req.body);
      if (!experimentId.success || !parsed.success) {
        return res.status(400).json({
          error: "Invalid message experiment cancellation.",
          code: "PROSPECT_MESSAGE_EXPERIMENT_CANCEL_INVALID",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = actorForRequest(req);
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          const rows = await tx<ProspectMessageExperimentRow[]>`
            SELECT id, experiment_id, workspace_id, campaign_id, channel,
                   state, control_variant_key, challenger_variant_key,
                   allocation_basis_points, definition, definition_hash
            FROM prospect_message_experiments
            WHERE workspace_id = ${workspaceId}
              AND experiment_id = ${experimentId.data}
            LIMIT 1
            FOR UPDATE
          `;
          const row = rows[0];
          if (!row) {
            throw new ProspectOutreachRouteError(
              "Message experiment not found.",
              404,
              "PROSPECT_MESSAGE_EXPERIMENT_NOT_FOUND"
            );
          }
          requireExperimentDefinition(row);
          if (row.definition_hash !== parsed.data.definitionHash) {
            throw new ProspectOutreachRouteError(
              "The cancellation does not match the prepared experiment definition.",
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_HASH_MISMATCH"
            );
          }
          if (row.state === "CANCELLED") {
            return { outcome: "duplicate" as const, row };
          }
          if (row.state !== "PREPARED") {
            throw new ProspectOutreachRouteError(
              `A ${row.state} experiment cannot be cancelled.`,
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_STATE_CONFLICT"
            );
          }
          const updated = await tx<{ id: number }[]>`
            UPDATE prospect_message_experiments
            SET state = 'CANCELLED', closed_by = ${actor},
                closed_at = NOW(), updated_at = NOW()
            WHERE id = ${row.id}
              AND workspace_id = ${workspaceId}
              AND state = 'PREPARED'
              AND definition_hash = ${parsed.data.definitionHash}
            RETURNING id
          `;
          if (updated.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The experiment cancellation changed no durable row.",
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_CANCEL_CONFLICT"
            );
          }
          await appendExperimentEvent(tx, {
            workspaceId,
            experimentRowId: row.id,
            fromState: "PREPARED",
            toState: "CANCELLED",
            actor,
            definitionHash: row.definition_hash,
            details: {
              externalAction: "none",
              contactAuthorized: false,
              spendAuthorized: false,
            },
          });
          return { outcome: "cancelled" as const, row };
        });
        return res.json({
          ok: true,
          outcome: result.outcome,
          state: "CANCELLED",
          experimentId: result.row.experiment_id,
          policyChanged: false,
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/leads/:id/outreach",
    dashboardAuth,
    requireOperator,
    requireAcquisitionUnpaused,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
        });
      }
      const leadId = parsePositiveId(req.params.id);
      const parsed = prepareProspectOutreachSchema.safeParse(req.body);
      if (!leadId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid recipient-specific outreach draft.",
          code: "PROSPECT_OUTREACH_INVALID_DRAFT",
          issues: parsed.success ? [] : parsed.error.issues,
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = auditedOutreachActorForRequest(req);
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          await assertProspectAcquisitionMutationUnpaused(
            tx,
            workspaceId
          );
          return prepareProspectOutreachJob(tx, {
            workspaceId,
            actor,
            leadId,
            draft: parsed.data,
            preparedAt: now().toISOString(),
          });
        });
        return res
          .status(
            ["created", "revision_required"].includes(
              result.outcome
            )
              ? 201
              : 200
          )
          .json({
          ok: true,
          ...result,
          externalAction: "none",
          });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/outreach/:approvalId/qc-model-review",
    dashboardAuth,
    requireFullOperator,
    requireAcquisitionUnpaused,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
        });
      }
      const approvalId = parseOpaqueApprovalId(
        req.params.approvalId
      );
      const parsed =
        prospectQcModelReviewActionSchema.safeParse(req.body);
      if (!approvalId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid advisory QC review request.",
          code: "PROSPECT_QC_MODEL_REVIEW_INVALID",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = actorForRequest(req);
      const config = readProspectQcModelProviderConfig(env);
      if (!config.enabled) {
        return res.status(503).json({
          error: "Advisory QC model review is disabled.",
          code: "PROSPECT_QC_MODEL_DISABLED",
          externalAction: "none",
        });
      }
      if (
        !config.configured ||
        config.workspaceId !== workspaceId ||
        !config.dailyReviewCap ||
        !config.dailySpendCapCents ||
        !config.reservedCostCents
      ) {
        return res.status(503).json({
          error: `Advisory QC model review is not configured for this workspace: ${config.missing.join(", ")}`,
          code: "PROSPECT_QC_MODEL_NOT_CONFIGURED",
          externalAction: "none",
        });
      }

      try {
        const reservation = await sql.begin(
          async (tx: SqlClient) => {
            await assertProspectAcquisitionMutationUnpaused(
              tx,
              workspaceId
            );
            const rows = await tx<any[]>`
              SELECT j.id, j.state, j.payload, j.payload_hash,
                     j.evidence_hash, j.variant_key, j.channel,
                     l.business_name, l.industry, l.contact_name,
                     l.city, l.state AS lead_state, l.website,
                     l.research_evidence
              FROM prospect_outreach_jobs j
              JOIN prospect_leads l ON l.id = j.lead_id
              JOIN prospecting_campaigns c ON c.id = l.campaign_id
              WHERE j.approval_id = ${approvalId}
                AND j.workspace_id = ${workspaceId}
                AND c.workspace_id = ${workspaceId}
              LIMIT 1
              FOR UPDATE
            `;
            const job = rows[0];
            if (!job) {
              throw new ProspectOutreachRouteError(
                "Outreach job was not found.",
                404,
                "PROSPECT_OUTREACH_NOT_FOUND"
              );
            }
            if (job.state !== "PREPARED") {
              throw new ProspectOutreachRouteError(
                `A ${job.state} outreach job cannot start advisory QC.`,
                409,
                "PROSPECT_QC_MODEL_REVIEW_STATE_CONFLICT"
              );
            }
            if (job.payload_hash !== parsed.data.payloadHash) {
              throw new ProspectOutreachRouteError(
                "The advisory QC request does not match the prepared payload.",
                409,
                "PROSPECT_OUTREACH_PAYLOAD_MISMATCH"
              );
            }
            const storedPayload =
              prospectOutreachPayloadSchema.safeParse(
                parseStoredJson(job.payload)
              );
            if (
              !storedPayload.success ||
              hashProspectOutreachPayload(storedPayload.data) !==
                job.payload_hash ||
              !storedPayload.data.qcReceipt ||
              !storedPayload.data.qcReceipt.deterministicPassed ||
              storedPayload.data.qcReceipt.verdict !==
                "ELIGIBLE_FOR_HUMAN_APPROVAL"
            ) {
              throw new ProspectOutreachRouteError(
                "Deterministic QC must pass before an advisory model request can spend a token.",
                409,
                "PROSPECT_QC_MODEL_DETERMINISTIC_GATE"
              );
            }
            const evidence = Array.isArray(
              job.research_evidence
            )
              ? job.research_evidence
              : [];
            if (
              evidence.length === 0 ||
              hashProspectEvidence(evidence) !==
                storedPayload.data.evidenceHash
            ) {
              throw new ProspectOutreachRouteError(
                "The reviewed evidence changed after draft preparation.",
                409,
                "PROSPECT_QC_MODEL_EVIDENCE_MISMATCH"
              );
            }
            const providerPayload: ProspectQcModelProviderInput = {
              workspaceId,
              approvalId,
              payloadHash: job.payload_hash,
              draftHash:
                storedPayload.data.qcReceipt.draftHash,
              evidenceHash:
                storedPayload.data.qcReceipt.evidenceHash,
              channel: storedPayload.data.channel,
              variantKey: storedPayload.data.variantKey,
              subject: storedPayload.data.subject,
              content: storedPayload.data.content,
              prospect: {
                businessName: String(
                  job.business_name || ""
                ),
                industry: String(job.industry || ""),
                contactName: String(
                  job.contact_name || ""
                ),
                city: String(job.city || ""),
                state: String(job.lead_state || ""),
                website: job.website
                  ? String(job.website)
                  : null,
                evidence: evidence.map(
                  (item: Record<string, unknown>) => ({
                    kind: String(item?.kind || ""),
                    basis: String(item?.basis || ""),
                    observation: String(
                      item?.observation || ""
                    ),
                    url: item?.url
                      ? String(item.url)
                      : null,
                  })
                ),
              },
            };
            const requestHash =
              hashProspectQcModelRequest(
                providerPayload,
                config
              );
            const existing =
              await tx<ProspectQcModelReviewRow[]>`
                SELECT *
                FROM prospect_qc_model_reviews
                WHERE workspace_id = ${workspaceId}
                  AND outreach_job_id = ${job.id}
                  AND request_hash = ${requestHash}
                LIMIT 1
                FOR UPDATE
              `;
            if (existing[0]) {
              if (existing[0].state === "COMPLETED") {
                const receipt =
                  requireProspectQcModelReviewReceipt(
                    existing[0],
                    {
                      workspaceId,
                      outreachJobId: job.id,
                      approvalId,
                      payloadHash: job.payload_hash,
                      draftHash:
                        storedPayload.data.qcReceipt.draftHash,
                      evidenceHash:
                        storedPayload.data.qcReceipt.evidenceHash,
                    }
                  );
                return {
                  outcome: "duplicate" as const,
                  reviewId: existing[0].review_id,
                  receipt,
                  receiptHash: existing[0].receipt_hash!,
                  providerPayload,
                  requestHash,
                  shouldRequestProvider: false as const,
                };
              }
              throw new ProspectOutreachRouteError(
                `The existing advisory QC request is ${existing[0].state}. It cannot automatically call the provider again.`,
                409,
                "PROSPECT_QC_MODEL_REVIEW_REPLAY_BLOCKED"
              );
            }
            const usage = await tx<
              Array<{
                review_count: number | string;
                reserved_spend_cents: number | string;
              }>
            >`
              SELECT COUNT(*)::int AS review_count,
                     COALESCE(
                       SUM(
                         GREATEST(
                           reserved_cost_cents,
                           COALESCE(
                             CEIL(provider_reported_cost_usd * 100)::int,
                             reserved_cost_cents
                           )
                         )
                       ),
                       0
                     )::int AS reserved_spend_cents
              FROM prospect_qc_model_reviews
              WHERE workspace_id = ${workspaceId}
                AND requested_at >= NOW() - INTERVAL '24 hours'
            `;
            const reviewCount = Number(
              usage[0]?.review_count || 0
            );
            const reservedSpendCents = Number(
              usage[0]?.reserved_spend_cents || 0
            );
            if (
              reviewCount >= config.dailyReviewCap ||
              reservedSpendCents + config.reservedCostCents >
                config.dailySpendCapCents
            ) {
              throw new ProspectOutreachRouteError(
                "The rolling advisory QC review or spend cap has been reached.",
                429,
                "PROSPECT_QC_MODEL_DAILY_CAP"
              );
            }
            const reviewId = randomUUID();
            const inserted = await tx<{ id: number }[]>`
              INSERT INTO prospect_qc_model_reviews (
                review_id, workspace_id, outreach_job_id, state,
                request_hash, payload_hash, draft_hash, evidence_hash,
                provider, model, reserved_cost_cents, requested_by
              ) VALUES (
                ${reviewId}, ${workspaceId}, ${job.id}, 'SENDING',
                ${requestHash}, ${job.payload_hash},
                ${storedPayload.data.qcReceipt.draftHash},
                ${storedPayload.data.qcReceipt.evidenceHash},
                'openrouter', ${config.model},
                ${config.reservedCostCents}, ${actor}
              )
              RETURNING id
            `;
            if (inserted.length !== 1) {
              throw new ProspectOutreachRouteError(
                "The advisory QC reservation was not persisted.",
                503,
                "PROSPECT_QC_MODEL_RESERVATION_FAILED"
              );
            }
            return {
              outcome: "reserved" as const,
              rowId: inserted[0].id,
              reviewId,
              outreachJobId: job.id,
              providerPayload,
              requestHash,
              shouldRequestProvider: true as const,
            };
          }
        );

        if (!reservation.shouldRequestProvider) {
          return res.status(200).json({
            ok: true,
            outcome: reservation.outcome,
            reviewId: reservation.reviewId,
            receipt: reservation.receipt,
            receiptHash: reservation.receiptHash,
            providerRequestPerformed: false,
            contactAuthorized: false,
            executionAuthorized: false,
            externalAction: "none",
          });
        }

        const providerResult =
          await requestProspectQcModelReview({
            config,
            payload: reservation.providerPayload,
            fetchImpl,
          });
        const final = await sql.begin(
          async (tx: SqlClient) => {
            const rows =
              await tx<ProspectQcModelReviewRow[]>`
                SELECT *
                FROM prospect_qc_model_reviews
                WHERE id = ${reservation.rowId}
                  AND workspace_id = ${workspaceId}
                LIMIT 1
                FOR UPDATE
              `;
            const row = rows[0];
            if (!row || row.state !== "SENDING") {
              throw new ProspectOutreachRouteError(
                "The advisory QC reservation changed before the provider result could be recorded.",
                409,
                "PROSPECT_QC_MODEL_REVIEW_STATE_CONFLICT"
              );
            }
            if (providerResult.status === "accepted") {
              const built = buildProspectQcModelReviewReceipt({
                reviewId: reservation.reviewId,
                workspaceId,
                approvalId,
                outreachJobId: reservation.outreachJobId,
                requestHash: reservation.requestHash,
                payloadHash:
                  reservation.providerPayload.payloadHash,
                draftHash:
                  reservation.providerPayload.draftHash,
                evidenceHash:
                  reservation.providerPayload.evidenceHash,
                result: providerResult,
                reservedCostCents:
                  config.reservedCostCents!,
                reviewedAt: now().toISOString(),
              });
              const updated = await tx<{ id: number }[]>`
                UPDATE prospect_qc_model_reviews
                SET state = 'COMPLETED',
                    provider_request_id =
                      ${providerResult.providerRequestId},
                    provider_response_hash =
                      ${providerResult.responseHash},
                    provider_reported_cost_usd =
                      ${providerResult.providerReportedCostUsd},
                    total_tokens = ${providerResult.totalTokens},
                    review = ${tx.json(providerResult.review)},
                    receipt = ${tx.json(built.receipt)},
                    receipt_hash = ${built.receiptHash},
                    completed_at = NOW(), updated_at = NOW()
                WHERE id = ${row.id} AND state = 'SENDING'
                RETURNING id
              `;
              if (updated.length !== 1) {
                throw new ProspectOutreachRouteError(
                  "The advisory QC completion changed no durable row.",
                  409,
                  "PROSPECT_QC_MODEL_REVIEW_STATE_CONFLICT"
                );
              }
              return {
                ok: true as const,
                receipt: built.receipt,
                receiptHash: built.receiptHash,
              };
            }
            const terminalState =
              providerResult.status === "definitive_failure"
                ? "DEFINITIVE_FAILURE"
                : "OUTCOME_UNKNOWN";
            const updated = await tx<{ id: number }[]>`
              UPDATE prospect_qc_model_reviews
              SET state = ${terminalState},
                  failure_code =
                    ${safeQcModelFailureCode(providerResult.code)},
                  completed_at = NOW(), updated_at = NOW()
              WHERE id = ${row.id} AND state = 'SENDING'
              RETURNING id
            `;
            if (updated.length !== 1) {
              throw new ProspectOutreachRouteError(
                "The advisory QC failure changed no durable row.",
                409,
                "PROSPECT_QC_MODEL_REVIEW_STATE_CONFLICT"
              );
            }
            return {
              ok: false as const,
              state: terminalState,
              code: providerResult.code,
              error: providerResult.error,
            };
          }
        );
        if (!final.ok) {
          return res
            .status(
              final.state === "DEFINITIVE_FAILURE"
                ? 502
                : 503
            )
            .json({
              error: final.error,
              code: final.code,
              reviewId: reservation.reviewId,
              state: final.state,
              providerRequestPerformed: true,
              automaticRetryAllowed: false,
              contactAuthorized: false,
              executionAuthorized: false,
              externalAction: "one-advisory-model-request",
            });
        }
        return res.status(201).json({
          ok: true,
          outcome: "reviewed",
          reviewId: reservation.reviewId,
          receipt: final.receipt,
          receiptHash: final.receiptHash,
          providerRequestPerformed: true,
          reservedCostCents: config.reservedCostCents,
          contactAuthorized: false,
          executionAuthorized: false,
          externalAction: "one-advisory-model-request",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.get(
    "/api/prospecting/leads/:id/outreach",
    dashboardAuth,
    requireOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.json({
          jobs: [],
          qcRevisions: [],
          outcomes: [],
          qcModelReviews: [],
          qcModelProvider:
            publicProspectQcModelProviderConfig(
              readProspectQcModelProviderConfig(env),
              getWorkspaceId(req)
            ),
        });
      }
      const leadId = parsePositiveId(req.params.id);
      if (!leadId) {
        return res.status(400).json({
          error: "Invalid prospect ID.",
          code: "PROSPECT_ID_INVALID",
        });
      }
      const workspaceId = getWorkspaceId(req);
      try {
        const lead = await requireProspect(sql, workspaceId, leadId);
        const experimentAssignments = [];
        for (const channel of ["email", "call"] as const) {
          const active = await loadActiveMessageExperiment(sql, {
            workspaceId,
            campaignId: lead.campaign_id,
            channel,
          });
          if (!active) continue;
          const preview = buildProspectMessageExperimentAssignment({
            definition: active.definition,
            prospectId: lead.id,
            actualVariantKey:
              buildProspectMessageExperimentAssignment({
                definition: active.definition,
                prospectId: lead.id,
                actualVariantKey:
                  active.definition.controlVariantKey,
              }).assignedVariantKey,
          });
          experimentAssignments.push(preview);
        }
        const rows = await sql`
          SELECT approval_id, channel, state, recipient, subject, content,
                 variant_key,
                 payload->'experimentAssignment' AS experiment_assignment,
                 payload->'qcReceipt' AS qc_receipt,
                 payload_hash, evidence_hash, max_cost_cents, prepared_by,
                 approved_by, approved_at, approval_attestations, expires_at,
                 qc_model_review_id, qc_model_review_receipt_hash,
                 sent_at, provider_name, provider_idempotency_key,
                 provider_message_id, provider_cost_cents,
                 provider_requested_at, provider_response_at,
                 provider_attempts, execution_proof_reference, failure_code,
                 created_at, updated_at
          FROM prospect_outreach_jobs
          WHERE workspace_id = ${workspaceId} AND lead_id = ${leadId}
          ORDER BY created_at DESC
        `;
        const revisionRows = await sql<{
          revision_id: string;
          state: ProspectQcRevisionResult["state"];
          payload: unknown;
          payload_hash: string;
          prepared_by: string;
          prepared_at: string | Date;
          rejected_by: string | null;
          rejected_at: string | Date | null;
          rejection_reason: string | null;
          superseded_by_approval_id: string | null;
          superseded_at: string | Date | null;
          created_at: string | Date;
          updated_at: string | Date;
        }[]>`
          SELECT r.revision_id, r.state, r.payload, r.payload_hash,
                 r.prepared_by, r.prepared_at, r.rejected_by,
                 r.rejected_at, r.rejection_reason,
                 j.approval_id AS superseded_by_approval_id,
                 r.superseded_at, r.created_at, r.updated_at
          FROM prospect_qc_revision_items r
          LEFT JOIN prospect_outreach_jobs j
            ON j.id = r.superseded_by_job_id
           AND j.workspace_id = r.workspace_id
          WHERE r.workspace_id = ${workspaceId}
            AND r.lead_id = ${leadId}
          ORDER BY r.created_at DESC
        `;
        const qcRevisions = revisionRows.map(row => {
          const payload = prospectQcRevisionPayloadSchema.safeParse(
            parseStoredJson(row.payload)
          );
          if (
            !payload.success ||
            payload.data.revisionId !== row.revision_id ||
            payload.data.workspaceId !== workspaceId ||
            payload.data.campaignId !== lead.campaign_id ||
            payload.data.prospectId !== leadId ||
            hashProspectQcRevisionPayload(payload.data) !==
              row.payload_hash
          ) {
            throw new ProspectOutreachRouteError(
              "A QC revision failed its immutable payload check.",
              409,
              "PROSPECT_QC_REVISION_PAYLOAD_INVALID"
            );
          }
          return {
            revision_id: row.revision_id,
            state: row.state,
            payload_hash: row.payload_hash,
            channel: payload.data.channel,
            recipient: payload.data.recipient,
            subject: payload.data.subject,
            content: payload.data.content,
            variant_key: payload.data.variantKey,
            evidence_hash: payload.data.evidenceHash,
            email_compliance: payload.data.emailCompliance,
            max_cost_cents: payload.data.maxCostCents,
            expires_in_hours: payload.data.expiresInHours,
            qc_receipt: payload.data.qcReceipt,
            experiment_assignment:
              payload.data.experimentAssignment,
            prepared_by: row.prepared_by,
            prepared_at: row.prepared_at,
            rejected_by: row.rejected_by,
            rejected_at: row.rejected_at,
            rejection_reason: row.rejection_reason,
            superseded_by_approval_id:
              row.superseded_by_approval_id,
            superseded_at: row.superseded_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
            approvalAuthorized: false,
            contactAuthorized: false,
            executionAuthorized: false,
            providerRequestAuthorized: false,
          };
        });
        const outcomes = await sql`
          SELECT j.approval_id, e.external_event_id, e.outcome,
                 e.occurred_at, e.notes, e.created_at
          FROM prospect_outcome_events e
          JOIN prospect_outreach_jobs j ON j.id = e.outreach_job_id
          WHERE e.workspace_id = ${workspaceId}
            AND j.workspace_id = ${workspaceId}
            AND j.lead_id = ${leadId}
          ORDER BY e.occurred_at DESC
        `;
        const qcModelReviews = await sql`
          SELECT r.review_id, r.outreach_job_id, j.approval_id,
                 r.state, r.payload_hash, r.draft_hash, r.evidence_hash,
                 r.provider, r.model, r.reserved_cost_cents,
                 r.provider_request_id, r.provider_response_hash,
                 r.provider_reported_cost_usd, r.total_tokens,
                 r.receipt, r.receipt_hash, r.failure_code,
                 r.requested_by, r.requested_at, r.completed_at
          FROM prospect_qc_model_reviews r
          JOIN prospect_outreach_jobs j
            ON j.id = r.outreach_job_id
           AND j.workspace_id = r.workspace_id
          WHERE r.workspace_id = ${workspaceId}
            AND j.lead_id = ${leadId}
          ORDER BY r.requested_at DESC
        `;
        return res.json({
          jobs: rows,
          qcRevisions,
          outcomes,
          qcModelReviews,
          qcModelProvider:
            publicProspectQcModelProviderConfig(
              readProspectQcModelProviderConfig(env),
              workspaceId
            ),
          experimentAssignments,
          emailProvider: publicEmailProviderConfig(
            readProspectEmailProviderConfig(env),
            workspaceId
          ),
          manualCall: publicProspectManualCallConfig(
            readProspectManualCallConfig(env),
            workspaceId
          ),
          emailWebhook: (() => {
            const config = readProspectEmailWebhookConfig(env);
            return {
              enabled: config.enabled,
              configured: config.configured,
              availableForWorkspace:
                config.configured && config.workspaceId === workspaceId,
              missing: config.missing,
            };
          })(),
          emailReceiving: (() => {
            const config = readProspectEmailReceivingConfig(env);
            return {
              enabled: config.enabled,
              configured: config.configured,
              availableForWorkspace:
                config.configured && config.workspaceId === workspaceId,
              mode: config.mode,
              missing: config.missing,
              provider: "resend" as const,
              operatorRetrievalRequired: true,
              sendsEmail: false,
            };
          })(),
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/outreach/:approvalId/approve",
    dashboardAuth,
    requireOperator,
    requireAcquisitionUnpaused,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
        });
      }
      const approvalId = parseOpaqueApprovalId(req.params.approvalId);
      const parsed = prospectOutreachApprovalSchema.safeParse(req.body);
      if (!approvalId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid approval request.",
          code: "PROSPECT_OUTREACH_INVALID_APPROVAL",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = actorForRequest(req);
      const qcModelConfig =
        readProspectQcModelProviderConfig(env);
      const manualCallConfig = readProspectManualCallConfig(env);
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          await assertProspectAcquisitionMutationUnpaused(
            tx,
            workspaceId
          );
          const rows = await tx<any[]>`
            SELECT id, lead_id, state, channel, recipient, variant_key,
                   payload, payload_hash, expires_at, is_seed
            FROM prospect_outreach_jobs
            WHERE approval_id = ${approvalId} AND workspace_id = ${workspaceId}
            LIMIT 1 FOR UPDATE
          `;
          const job = rows[0];
          if (!job) {
            throw new ProspectOutreachRouteError(
              "Outreach approval was not found.",
              404,
              "PROSPECT_OUTREACH_NOT_FOUND"
            );
          }
          if (job.payload_hash !== parsed.data.payloadHash) {
            throw new ProspectOutreachRouteError(
              "The approved payload hash does not match the prepared draft.",
              409,
              "PROSPECT_OUTREACH_PAYLOAD_MISMATCH"
            );
          }
          const storedPayload = prospectOutreachPayloadSchema.safeParse(
            parseStoredJson(job.payload)
          );
          if (
            !storedPayload.success ||
            storedPayload.data.workspaceId !== workspaceId ||
            storedPayload.data.prospectId !== job.lead_id ||
            storedPayload.data.recipient !== job.recipient ||
            storedPayload.data.variantKey !== job.variant_key ||
            hashProspectOutreachPayload(storedPayload.data) !==
              job.payload_hash
          ) {
            throw new ProspectOutreachRouteError(
              "The prepared draft failed its immutable QC-bound payload check.",
              409,
              "PROSPECT_OUTREACH_STORED_PAYLOAD_INVALID"
            );
          }
          if (!storedPayload.data.qcReceipt) {
            throw new ProspectOutreachRouteError(
              "This legacy draft has no QC receipt. Prepare a new exact draft before approval.",
              409,
              "PROSPECT_QC_RECEIPT_REQUIRED"
            );
          }
          if (job.state === "APPROVED") {
            return { outcome: "duplicate" as const, state: "APPROVED" };
          }
          if (job.state !== "PREPARED") {
            throw new ProspectOutreachRouteError(
              `A ${job.state} outreach job cannot be approved.`,
              409,
              "PROSPECT_OUTREACH_STATE_CONFLICT"
            );
          }
          if (job.channel === "call") {
            if (!manualCallConfig.enabled) {
              throw new ProspectOutreachRouteError(
                "The reviewed manual-call lane is disabled.",
                409,
                "PROSPECT_MANUAL_CALL_DISABLED"
              );
            }
            if (!manualCallConfig.configured) {
              throw new ProspectOutreachRouteError(
                `The reviewed manual-call lane is not configured: ${manualCallConfig.missing.join(", ")}`,
                503,
                "PROSPECT_MANUAL_CALL_NOT_CONFIGURED"
              );
            }
            if (manualCallConfig.workspaceId !== workspaceId) {
              throw new ProspectOutreachRouteError(
                "The reviewed manual-call lane is locked to a different workspace.",
                403,
                "PROSPECT_MANUAL_CALL_WORKSPACE_LOCKED"
              );
            }
            const approvalClock = now();
            if (!Number.isFinite(approvalClock.getTime())) {
              throw new ProspectOutreachRouteError(
                "The manual-call approval clock is unavailable.",
                503,
                "PROSPECT_MANUAL_CALL_CLOCK_INVALID"
              );
            }
            const rollingWindowStart = new Date(
              approvalClock.getTime() - 24 * 60 * 60_000
            ).toISOString();
            // Serialize approval-cap reservations across call jobs in this workspace.
            await tx`
              SELECT pg_advisory_xact_lock(
                1953655116,
                ${workspaceId}
              )
            `;
            const capRows = await tx<
              { approval_count: number | string }[]
            >`
              SELECT COUNT(*)::int AS approval_count
              FROM prospect_outreach_jobs
              WHERE workspace_id = ${workspaceId}
                AND channel = 'call'
                AND approved_at IS NOT NULL
                AND approved_at >= ${rollingWindowStart}
            `;
            const approvalCount = Number(
              capRows[0]?.approval_count
            );
            if (
              !Number.isInteger(approvalCount) ||
              approvalCount < 0
            ) {
              throw new ProspectOutreachRouteError(
                "The manual-call approval cap could not be verified.",
                503,
                "PROSPECT_MANUAL_CALL_CAP_UNAVAILABLE"
              );
            }
            if (
              approvalCount >=
              (manualCallConfig.dailyApprovalCap || 0)
            ) {
              throw new ProspectOutreachRouteError(
                "The rolling 24-hour manual-call approval cap has been reached.",
                409,
                "PROSPECT_MANUAL_CALL_DAILY_CAP_REACHED"
              );
            }
          }
          if (job.is_seed) {
            await assertCurrentControlledInboxSeedBinding({
              tx,
              env,
              workspaceId,
              outreachJobId: job.id,
              recipient: job.recipient,
              variantKey: job.variant_key,
              now: now(),
            });
          }
          assertRequiredProspectQcModelConfig(
            qcModelConfig,
            workspaceId
          );
          const modelSelection =
            await loadBoundProspectQcModelReview(tx, {
              workspaceId,
              outreachJobId: job.id,
              approvalId,
              payloadHash: job.payload_hash,
              draftHash:
                storedPayload.data.qcReceipt.draftHash,
              evidenceHash:
                storedPayload.data.qcReceipt.evidenceHash,
              model: qcModelConfig.requiredForApproval
                ? qcModelConfig.model
                : null,
            });
          if (
            qcModelConfig.requiredForApproval &&
            !modelSelection
          ) {
            throw new ProspectOutreachRouteError(
              "This exact draft requires a completed advisory QC receipt before approval.",
              409,
              "PROSPECT_QC_MODEL_REVIEW_REQUIRED"
            );
          }
          if (
            qcModelConfig.requiredForApproval &&
            modelSelection &&
            !modelSelection.receipt
          ) {
            throw new ProspectOutreachRouteError(
              `The required advisory QC review is ${modelSelection.row.state}. It cannot satisfy approval.`,
              409,
              "PROSPECT_QC_MODEL_REVIEW_INCOMPLETE"
            );
          }
          try {
            assertProspectOutreachApprovalAttestations(
              job.channel,
              parsed.data,
              storedPayload.data.qcReceipt,
              modelSelection?.receipt?.review
            );
          } catch (error) {
            throw new ProspectOutreachRouteError(
              error instanceof Error
                ? error.message
                : "Required approval attestations are missing.",
              409,
              "PROSPECT_OUTREACH_COMPLIANCE_ATTESTATION_REQUIRED"
            );
          }
          if (new Date(job.expires_at).getTime() <= now().getTime()) {
            const expired = await tx<{ id: number }[]>`
              UPDATE prospect_outreach_jobs
              SET state = 'EXPIRED', updated_at = NOW()
              WHERE id = ${job.id} AND state = 'PREPARED'
              RETURNING id
            `;
            if (expired.length !== 1) {
              throw new ProspectOutreachRouteError(
                "The expired outreach job did not change state.",
                409,
                "PROSPECT_OUTREACH_STATE_CONFLICT"
              );
            }
            await appendOutreachEvent(tx, {
              workspaceId,
              jobId: job.id,
              fromState: "PREPARED",
              toState: "EXPIRED",
              actor,
              payloadHash: job.payload_hash,
            });
            return { outcome: "expired" as const, state: "EXPIRED" };
          }
          const approvedAt = now().toISOString();
          let approvalAttestations: Record<string, unknown> =
            parsed.data.attestations;
          let callComplianceReceiptHash: string | null = null;
          if (job.channel === "call") {
            try {
              const callCompliance =
                buildProspectCallComplianceReceipt({
                  workspaceId,
                  approvalId,
                  outreachJobId: job.id,
                  leadId: job.lead_id,
                  recipient: storedPayload.data.recipient,
                  evidence:
                    parsed.data.attestations.callCompliance!,
                  actor,
                  approvedAt,
                  jobExpiresAt: job.expires_at,
                });
              callComplianceReceiptHash =
                callCompliance.receiptHash;
              approvalAttestations = {
                ...parsed.data.attestations,
                callComplianceReceipt:
                  callCompliance.receipt,
                callComplianceReceiptHash:
                  callCompliance.receiptHash,
              };
            } catch (error) {
              throw new ProspectOutreachRouteError(
                error instanceof Error
                  ? error.message
                  : "Call-compliance evidence is invalid.",
                409,
                "PROSPECT_MANUAL_CALL_COMPLIANCE_REQUIRED"
              );
            }
          }
          const updated = await tx<{ id: number }[]>`
            UPDATE prospect_outreach_jobs
            SET state = 'APPROVED', approved_by = ${actor},
                approved_at = ${approvedAt},
                approval_attestations = ${tx.json(approvalAttestations)},
                qc_model_review_id =
                  ${modelSelection?.receipt?.reviewId || null},
                qc_model_review_receipt_hash =
                  ${modelSelection?.row.receipt_hash || null},
                updated_at = NOW()
            WHERE id = ${job.id} AND state = 'PREPARED'
              AND payload_hash = ${parsed.data.payloadHash}
            RETURNING id
          `;
          if (updated.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The expected outreach row did not change state.",
              409,
              "PROSPECT_OUTREACH_STATE_CONFLICT"
            );
          }
          await appendOutreachEvent(tx, {
            workspaceId,
            jobId: job.id,
            fromState: "PREPARED",
            toState: "APPROVED",
            actor,
            payloadHash: job.payload_hash,
            details: {
              attestations: approvalAttestations,
              qcModelReview: modelSelection?.receipt
                ? {
                    reviewId: modelSelection.receipt.reviewId,
                    receiptHash:
                      modelSelection.row.receipt_hash,
                    status:
                      modelSelection.receipt.review.status,
                    authority: "advisory-only",
                  }
                : {
                    reviewId: null,
                    receiptHash: null,
                    status: "NOT_RUN",
                    authority: "advisory-only",
                  },
            },
          });
          return {
            outcome: "approved" as const,
            state: "APPROVED",
            qcModelReviewId:
              modelSelection?.receipt?.reviewId || null,
            callComplianceReceiptHash,
          };
        });
        if (result.outcome === "expired") {
          return res.status(409).json({
            error: "This outreach approval has expired.",
            code: "PROSPECT_OUTREACH_EXPIRED",
            approvalId,
            state: result.state,
            externalAction: "none",
          });
        }
        return res.json({
          ok: true,
          ...result,
          approvalId,
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.get(
    "/api/prospecting/email-provider-events",
    dashboardAuth,
    requireFullOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) return res.json({ events: [] });
      const workspaceId = getWorkspaceId(req);
      try {
        const rows = await sql`
          SELECT provider_event_id, provider_message_id, event_type,
                 process_status, outreach_job_id, details,
                 received_at, processed_at, updated_at
          FROM prospect_email_provider_events
          WHERE workspace_id = ${workspaceId}
            AND provider = 'resend'
          ORDER BY received_at DESC
          LIMIT 200
        `;
        return res.json({
          events: rows,
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/outreach/:approvalId/cancel",
    dashboardAuth,
    requireOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
        });
      }
      const approvalId = parseOpaqueApprovalId(req.params.approvalId);
      const parsed = rejectSchema.safeParse(req.body);
      if (!approvalId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid cancellation request.",
          code: "PROSPECT_OUTREACH_INVALID_CANCELLATION",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = actorForRequest(req);
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          const rows = await tx<any[]>`
            SELECT id, state, payload_hash, approved_at, expires_at
            FROM prospect_outreach_jobs
            WHERE approval_id = ${approvalId} AND workspace_id = ${workspaceId}
            LIMIT 1 FOR UPDATE
          `;
          const job = rows[0];
          if (!job) {
            throw new ProspectOutreachRouteError(
              "Outreach approval was not found.",
              404,
              "PROSPECT_OUTREACH_NOT_FOUND"
            );
          }
          if (job.payload_hash !== parsed.data.payloadHash) {
            throw new ProspectOutreachRouteError(
              "The cancelled payload hash does not match the prepared draft.",
              409,
              "PROSPECT_OUTREACH_PAYLOAD_MISMATCH"
            );
          }
          if (job.state === "CANCELLED") {
            return { outcome: "duplicate" as const, state: "CANCELLED" };
          }
          if (!["PREPARED", "APPROVED"].includes(job.state)) {
            throw new ProspectOutreachRouteError(
              `A ${job.state} outreach job cannot be cancelled.`,
              409,
              "PROSPECT_OUTREACH_STATE_CONFLICT"
            );
          }
          const updated = await tx<{ id: number }[]>`
            UPDATE prospect_outreach_jobs
            SET state = 'CANCELLED', updated_at = NOW()
            WHERE id = ${job.id}
              AND state IN ('PREPARED', 'APPROVED')
            RETURNING id
          `;
          if (updated.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The expected outreach row did not change state.",
              409,
              "PROSPECT_OUTREACH_STATE_CONFLICT"
            );
          }
          await appendOutreachEvent(tx, {
            workspaceId,
            jobId: job.id,
            fromState: job.state,
            toState: "CANCELLED",
            actor,
            payloadHash: job.payload_hash,
            details: { reason: parsed.data.reason },
          });
          return { outcome: "cancelled" as const, state: "CANCELLED" };
        });
        return res.json({
          ok: true,
          ...result,
          approvalId,
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/qc-revisions/:revisionId/reject",
    dashboardAuth,
    requireOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
        });
      }
      const revisionId = parseOpaqueApprovalId(
        req.params.revisionId
      );
      const parsed = rejectSchema.safeParse(req.body);
      if (!revisionId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid QC revision rejection.",
          code: "PROSPECT_QC_REVISION_REJECTION_INVALID",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = auditedOutreachActorForRequest(req);
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          const rows = await tx<{
            id: number;
            state: ProspectQcRevisionResult["state"];
            payload: unknown;
            payload_hash: string;
            rejected_by: string | null;
            rejection_reason: string | null;
          }[]>`
            SELECT id, state, payload, payload_hash,
                   rejected_by, rejection_reason
            FROM prospect_qc_revision_items
            WHERE workspace_id = ${workspaceId}
              AND revision_id = ${revisionId}
            LIMIT 1
            FOR UPDATE
          `;
          const row = rows[0];
          if (!row) {
            throw new ProspectOutreachRouteError(
              "QC revision not found.",
              404,
              "PROSPECT_QC_REVISION_NOT_FOUND"
            );
          }
          const payload = prospectQcRevisionPayloadSchema.safeParse(
            parseStoredJson(row.payload)
          );
          if (
            !payload.success ||
            payload.data.revisionId !== revisionId ||
            payload.data.workspaceId !== workspaceId ||
            hashProspectQcRevisionPayload(payload.data) !==
              row.payload_hash
          ) {
            throw new ProspectOutreachRouteError(
              "The QC revision failed its immutable payload check.",
              409,
              "PROSPECT_QC_REVISION_PAYLOAD_INVALID"
            );
          }
          if (row.payload_hash !== parsed.data.payloadHash) {
            throw new ProspectOutreachRouteError(
              "The rejection does not match the immutable QC revision.",
              409,
              "PROSPECT_QC_REVISION_PAYLOAD_MISMATCH"
            );
          }
          if (row.state === "REJECTED") {
            if (
              row.rejected_by === actor &&
              row.rejection_reason === parsed.data.reason
            ) {
              return { outcome: "duplicate" as const };
            }
            throw new ProspectOutreachRouteError(
              "The QC revision was already rejected with different immutable action details.",
              409,
              "PROSPECT_QC_REVISION_REPLAY_MISMATCH"
            );
          }
          if (row.state !== "REVISION_REQUIRED") {
            throw new ProspectOutreachRouteError(
              `A ${row.state} QC revision cannot be rejected.`,
              409,
              "PROSPECT_QC_REVISION_STATE_CONFLICT"
            );
          }
          const updated = await tx<{ id: number }[]>`
            UPDATE prospect_qc_revision_items
            SET state = 'REJECTED', rejected_by = ${actor},
                rejected_at = NOW(),
                rejection_reason = ${parsed.data.reason},
                updated_at = NOW()
            WHERE id = ${row.id}
              AND workspace_id = ${workspaceId}
              AND state = 'REVISION_REQUIRED'
            RETURNING id
          `;
          if (updated.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The expected QC revision row did not change state.",
              409,
              "PROSPECT_QC_REVISION_STATE_CONFLICT"
            );
          }
          await appendProspectQcRevisionEvent(tx, {
            workspaceId,
            revisionRowId: row.id,
            fromState: "REVISION_REQUIRED",
            toState: "REJECTED",
            actor,
            payloadHash: row.payload_hash,
            details: {
              reason: parsed.data.reason,
              externalAction: "none",
              contactAuthorized: false,
              executionAuthorized: false,
            },
          });
          return { outcome: "rejected" as const };
        });
        return res.json({
          ok: true,
          ...result,
          revisionId,
          state: "REJECTED",
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/outreach/:approvalId/reject",
    dashboardAuth,
    requireOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
        });
      }
      const approvalId = parseOpaqueApprovalId(req.params.approvalId);
      const parsed = rejectSchema.safeParse(req.body);
      if (!approvalId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid rejection request.",
          code: "PROSPECT_OUTREACH_INVALID_REJECTION",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = actorForRequest(req);
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          const rows = await tx<any[]>`
            SELECT id, state, payload_hash
            FROM prospect_outreach_jobs
            WHERE approval_id = ${approvalId} AND workspace_id = ${workspaceId}
            LIMIT 1 FOR UPDATE
          `;
          const job = rows[0];
          if (!job) {
            throw new ProspectOutreachRouteError(
              "Outreach approval was not found.",
              404,
              "PROSPECT_OUTREACH_NOT_FOUND"
            );
          }
          if (job.payload_hash !== parsed.data.payloadHash) {
            throw new ProspectOutreachRouteError(
              "The rejected payload hash does not match the prepared draft.",
              409,
              "PROSPECT_OUTREACH_PAYLOAD_MISMATCH"
            );
          }
          if (job.state === "REJECTED") {
            return { outcome: "duplicate" as const, state: "REJECTED" };
          }
          if (job.state !== "PREPARED") {
            throw new ProspectOutreachRouteError(
              `A ${job.state} outreach job cannot be rejected.`,
              409,
              "PROSPECT_OUTREACH_STATE_CONFLICT"
            );
          }
          const updated = await tx<{ id: number }[]>`
            UPDATE prospect_outreach_jobs
            SET state = 'REJECTED', updated_at = NOW()
            WHERE id = ${job.id} AND state = 'PREPARED'
            RETURNING id
          `;
          if (updated.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The expected outreach row did not change state.",
              409,
              "PROSPECT_OUTREACH_STATE_CONFLICT"
            );
          }
          await appendOutreachEvent(tx, {
            workspaceId,
            jobId: job.id,
            fromState: "PREPARED",
            toState: "REJECTED",
            actor,
            payloadHash: job.payload_hash,
            details: { reason: parsed.data.reason },
          });
          return { outcome: "rejected" as const, state: "REJECTED" };
        });
        return res.json({
          ok: true,
          ...result,
          approvalId,
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/outreach/:approvalId/record-execution",
    dashboardAuth,
    requireOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
        });
      }
      const approvalId = parseOpaqueApprovalId(req.params.approvalId);
      const parsed = recordExecutionSchema.safeParse(req.body);
      if (!approvalId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid execution record.",
          code: "PROSPECT_OUTREACH_INVALID_EXECUTION_RECORD",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = actorForRequest(req);
      const qcModelConfig =
        readProspectQcModelProviderConfig(env);
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          const rows = await tx<any[]>`
            SELECT j.id, j.lead_id, j.state, j.channel, j.recipient,
                   j.payload, j.payload_hash,
                   j.approved_by, j.approved_at,
                   j.approval_attestations, j.expires_at,
                   j.qc_model_review_id,
                   j.qc_model_review_receipt_hash,
                   j.sent_at, j.execution_proof_reference,
                   l.phone AS current_phone,
                   l.phone_contact_mode AS current_phone_contact_mode,
                   l.status AS current_lead_status,
                   l.review_state AS current_review_state
            FROM prospect_outreach_jobs j
            JOIN prospect_leads l
              ON l.id = j.lead_id
             AND l.campaign_id = j.campaign_id
            JOIN prospecting_campaigns c
              ON c.id = j.campaign_id
             AND c.workspace_id = j.workspace_id
            WHERE j.approval_id = ${approvalId}
              AND j.workspace_id = ${workspaceId}
              AND c.workspace_id = ${workspaceId}
            LIMIT 1 FOR UPDATE
          `;
          const job = rows[0];
          if (!job) {
            throw new ProspectOutreachRouteError(
              "Outreach approval was not found.",
              404,
              "PROSPECT_OUTREACH_NOT_FOUND"
            );
          }
          if (job.payload_hash !== parsed.data.payloadHash) {
            throw new ProspectOutreachRouteError(
              "The execution record does not match the approved payload.",
              409,
              "PROSPECT_OUTREACH_PAYLOAD_MISMATCH"
            );
          }
          if (job.channel !== "call") {
            throw new ProspectOutreachRouteError(
              "Email execution must use the guarded one-recipient provider route.",
              409,
              "PROSPECT_EMAIL_EXECUTION_ROUTE_REQUIRED"
            );
          }
          if (!parsed.data.proofReference.startsWith("manual:")) {
            throw new ProspectOutreachRouteError(
              "Manual call records require a manual proof reference.",
              409,
              "PROSPECT_MANUAL_CALL_PROOF_REQUIRED"
            );
          }
          if (job.state === "SENT") {
            if (
              isExactRecordedExecutionReplay(
                {
                  sentAt: job.sent_at,
                  proofReference: job.execution_proof_reference,
                },
                {
                  occurredAt: parsed.data.occurredAt,
                  proofReference: parsed.data.proofReference,
                }
              )
            ) {
              return { outcome: "duplicate" as const, state: "SENT" };
            }
            throw new ProspectOutreachRouteError(
              "This approval already has a different execution record.",
              409,
              "PROSPECT_OUTREACH_EXECUTION_IDEMPOTENCY_CONFLICT"
            );
          }
          if (job.state !== "APPROVED") {
            throw new ProspectOutreachRouteError(
              `A ${job.state} outreach job cannot be recorded as executed.`,
              409,
              "PROSPECT_OUTREACH_STATE_CONFLICT"
            );
          }
          const storedPayload =
            prospectOutreachPayloadSchema.safeParse(
              parseStoredJson(job.payload)
            );
          if (
            !storedPayload.success ||
            !storedPayload.data.qcReceipt ||
            hashProspectOutreachPayload(storedPayload.data) !==
              job.payload_hash
          ) {
            throw new ProspectOutreachRouteError(
              "The approved manual-call payload failed its immutable QC check.",
              409,
              "PROSPECT_OUTREACH_STORED_PAYLOAD_INVALID"
            );
          }
          assertRequiredProspectQcModelConfig(
            qcModelConfig,
            workspaceId
          );
          const approvedModelReview =
            await loadApprovedProspectQcModelReview(tx, {
              workspaceId,
              outreachJobId: job.id,
              approvalId,
              payloadHash: job.payload_hash,
              draftHash:
                storedPayload.data.qcReceipt.draftHash,
              evidenceHash:
                storedPayload.data.qcReceipt.evidenceHash,
              reviewId: job.qc_model_review_id,
              receiptHash:
                job.qc_model_review_receipt_hash,
            });
          if (
            qcModelConfig.requiredForApproval &&
            !approvedModelReview
          ) {
            throw new ProspectOutreachRouteError(
              "Manual call execution requires the advisory QC receipt bound at approval.",
              409,
              "PROSPECT_QC_MODEL_REVIEW_REQUIRED"
            );
          }
          let currentPhone: string;
          let complianceLocalTime: string;
          try {
            currentPhone = normalizeProspectOutreachRecipient(
              "call",
              job.current_phone
            );
            const storedApproval =
              prospectOutreachStoredApprovalSchema.parse({
              payloadHash: job.payload_hash,
              attestations: job.approval_attestations,
            });
            assertProspectOutreachApprovalAttestations(
              "call",
              storedApproval,
              storedPayload.data.qcReceipt,
              approvedModelReview?.review
            );
            const compliance =
              assertProspectCallComplianceForExecution({
                receipt:
                  storedApproval.attestations
                    .callComplianceReceipt,
                receiptHash:
                  storedApproval.attestations
                    .callComplianceReceiptHash || "",
                workspaceId,
                approvalId,
                outreachJobId: job.id,
                leadId: job.lead_id,
                recipient: currentPhone,
                occurredAt: parsed.data.occurredAt,
                approvedBy: job.approved_by,
                approvedAt: job.approved_at,
                jobExpiresAt: job.expires_at,
              });
            complianceLocalTime = compliance.localTime;
          } catch (error) {
            throw new ProspectOutreachRouteError(
              error instanceof Error
                ? error.message
                : "The manual call recipient or persisted compliance receipt is invalid.",
              409,
              "PROSPECT_MANUAL_CALL_CONTROLS_INVALID"
            );
          }
          if (
            job.current_review_state !== "qualified" ||
            job.current_lead_status === "dnc" ||
            job.current_phone_contact_mode !== "operator_review_only" ||
            currentPhone !== job.recipient
          ) {
            throw new ProspectOutreachRouteError(
              "The prospect no longer satisfies the reviewed manual-call controls.",
              409,
              "PROSPECT_MANUAL_CALL_REVIEW_STALE"
            );
          }
          try {
            assertRecordedExecutionWindow({
              occurredAt: parsed.data.occurredAt,
              approvedAt: job.approved_at,
              expiresAt: job.expires_at,
            });
          } catch (error) {
            throw new ProspectOutreachRouteError(
              error instanceof Error
                ? error.message
                : "The external action time is invalid.",
              409,
              "PROSPECT_OUTREACH_EXECUTION_TIME_INVALID"
            );
          }
          const updated = await tx<{ id: number }[]>`
            UPDATE prospect_outreach_jobs
            SET state = 'SENT', sent_at = ${parsed.data.occurredAt},
                execution_proof_reference = ${parsed.data.proofReference},
                updated_at = NOW()
            WHERE id = ${job.id} AND state = 'APPROVED'
            RETURNING id
          `;
          if (updated.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The expected outreach row did not change state.",
              409,
              "PROSPECT_OUTREACH_STATE_CONFLICT"
            );
          }
          await appendOutreachEvent(tx, {
            workspaceId,
            jobId: job.id,
            fromState: "APPROVED",
            toState: "SENT",
            actor,
            payloadHash: job.payload_hash,
            details: {
              executionMode: "operator_recorded_external_action",
              proofReference: parsed.data.proofReference,
              complianceLocalTime,
            },
          });
          return {
            outcome: "recorded" as const,
            state: "SENT",
            complianceLocalTime,
          };
        });
        return res.json({
          ok: true,
          ...result,
          approvalId,
          externalAction: "recorded_only",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/outreach/:approvalId/execute",
    dashboardAuth,
    requireFullOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
          externalAction: "blocked",
        });
      }
      const approvalId = parseOpaqueApprovalId(req.params.approvalId);
      const parsed = executeEmailSchema.safeParse(req.body);
      if (!approvalId || !parsed.success) {
        return res.status(400).json({
          error:
            "An exact approval ID, payload hash, and one-email confirmation are required.",
          code: "PROSPECT_EMAIL_EXECUTION_INVALID",
          externalAction: "blocked",
        });
      }

      const workspaceId = getWorkspaceId(req);
      const actor = actorForRequest(req);
      const config = readProspectEmailProviderConfig(env);
      const emailWebhookConfig =
        readProspectEmailWebhookConfig(env);
      const emailReceivingConfig =
        readProspectEmailReceivingConfig(env);
      const qcModelConfig =
        readProspectQcModelProviderConfig(env);
      if (!config.enabled) {
        return res.status(409).json({
          error: "Prospect email execution is disabled.",
          code: "PROSPECT_EMAIL_EXECUTION_DISABLED",
          externalAction: "blocked",
        });
      }
      if (!config.configured) {
        return res.status(503).json({
          error: `Prospect email execution is not configured: ${config.missing.join(", ")}`,
          code: "PROSPECT_EMAIL_EXECUTION_NOT_CONFIGURED",
          externalAction: "blocked",
        });
      }
      if (config.workspaceId !== workspaceId) {
        return res.status(403).json({
          error:
            "Prospect email execution is locked to a different workspace.",
          code: "PROSPECT_EMAIL_WORKSPACE_LOCKED",
          externalAction: "blocked",
        });
      }

      const requestedAt = now();
      if (!Number.isFinite(requestedAt.getTime())) {
        return res.status(503).json({
          error: "The email execution clock is unavailable.",
          code: "PROSPECT_EMAIL_CLOCK_INVALID",
          externalAction: "blocked",
        });
      }
      const requestedAtIso = requestedAt.toISOString();
      const rollingWindowStart = new Date(
        requestedAt.getTime() - 24 * 60 * 60_000
      ).toISOString();

      try {
        const claim = await sql.begin(async (tx: SqlClient) => {
          await acquireProspectAcquisitionWorkspaceLock(
            tx,
            workspaceId
          );
          // Serialize cap reservations across different jobs in this workspace.
          await tx`
            SELECT pg_advisory_xact_lock(
              1953655115,
              ${workspaceId}
            )
          `;
          const rows = await tx<any[]>`
            SELECT j.id, j.state, j.channel, j.lead_id, j.recipient,
                   j.variant_key, j.is_seed,
                   j.payload, j.payload_hash, j.max_cost_cents,
                   j.approved_at, j.approval_attestations, j.expires_at,
                   j.qc_model_review_id,
                   j.qc_model_review_receipt_hash,
                   j.provider_name, j.provider_idempotency_key,
                   j.provider_message_id, j.provider_cost_cents,
                   j.provider_requested_at, j.provider_response_at,
                   j.provider_attempts, j.execution_proof_reference,
                   j.failure_code,
                   l.email AS current_email,
                   l.email_verification AS current_email_verification,
                   l.status AS current_lead_status,
                   l.review_state AS current_review_state
            FROM prospect_outreach_jobs j
            JOIN prospect_leads l
              ON l.id = j.lead_id
             AND l.campaign_id = j.campaign_id
            JOIN prospecting_campaigns c
              ON c.id = j.campaign_id
             AND c.workspace_id = j.workspace_id
            WHERE j.approval_id = ${approvalId}
              AND j.workspace_id = ${workspaceId}
              AND c.workspace_id = ${workspaceId}
            LIMIT 1 FOR UPDATE
          `;
          const job = rows[0];
          if (!job) {
            throw new ProspectOutreachRouteError(
              "Outreach approval was not found.",
              404,
              "PROSPECT_OUTREACH_NOT_FOUND"
            );
          }
          if (job.payload_hash !== parsed.data.payloadHash) {
            throw new ProspectOutreachRouteError(
              "The execution request does not match the approved payload.",
              409,
              "PROSPECT_OUTREACH_PAYLOAD_MISMATCH"
            );
          }
          if (job.channel !== "email") {
            throw new ProspectOutreachRouteError(
              "Call jobs remain manual-dial-only. SMIRK cannot place this call.",
              409,
              "PROSPECT_CALL_PROVIDER_EXECUTION_DISABLED"
            );
          }

          const parsedPayload = prospectOutreachPayloadSchema.safeParse(
            job.payload
          );
          if (
            !parsedPayload.success ||
            !parsedPayload.data.qcReceipt ||
            parsedPayload.data.channel !== "email" ||
            parsedPayload.data.workspaceId !== workspaceId ||
            parsedPayload.data.prospectId !== job.lead_id ||
            parsedPayload.data.recipient !== job.recipient ||
            parsedPayload.data.variantKey !== job.variant_key ||
            hashProspectOutreachPayload(parsedPayload.data) !==
              job.payload_hash
          ) {
            throw new ProspectOutreachRouteError(
              "The stored email payload failed its immutable contract check.",
              409,
              "PROSPECT_EMAIL_STORED_PAYLOAD_INVALID"
            );
          }
          const payload = parsedPayload.data;

          if (
            job.state === "SENT" &&
            job.provider_name === "resend" &&
            job.provider_message_id &&
            job.provider_idempotency_key
          ) {
            return {
              outcome: "duplicate" as const,
              state: "SENT" as const,
              providerMessageId: String(job.provider_message_id),
              proofReference:
                String(job.execution_proof_reference || "") ||
                `provider:resend/${job.provider_message_id}`,
            };
          }
          if (job.state === "APPROVED") {
            if (!emailWebhookConfig.enabled) {
              throw new ProspectOutreachRouteError(
                "A new prospect email requires the signed outcome webhook before provider execution.",
                409,
                "PROSPECT_EMAIL_WEBHOOK_DISABLED"
              );
            }
            if (!emailWebhookConfig.configured) {
              throw new ProspectOutreachRouteError(
                `The signed prospect email outcome webhook is not configured: ${emailWebhookConfig.missing.join(", ")}`,
                503,
                "PROSPECT_EMAIL_WEBHOOK_NOT_CONFIGURED"
              );
            }
            if (emailWebhookConfig.workspaceId !== workspaceId) {
              throw new ProspectOutreachRouteError(
                "The signed prospect email outcome webhook is locked to a different workspace.",
                403,
                "PROSPECT_EMAIL_WEBHOOK_WORKSPACE_LOCKED"
              );
            }
            if (!emailReceivingConfig.enabled) {
              throw new ProspectOutreachRouteError(
                "A new prospect email requires operator-reviewed inbound content retrieval before provider execution.",
                409,
                "PROSPECT_EMAIL_RECEIVING_DISABLED"
              );
            }
            if (!emailReceivingConfig.configured) {
              throw new ProspectOutreachRouteError(
                `Operator-reviewed inbound email retrieval is not configured: ${emailReceivingConfig.missing.join(", ")}`,
                503,
                "PROSPECT_EMAIL_RECEIVING_NOT_CONFIGURED"
              );
            }
            if (emailReceivingConfig.workspaceId !== workspaceId) {
              throw new ProspectOutreachRouteError(
                "Operator-reviewed inbound email retrieval is locked to a different workspace.",
                403,
                "PROSPECT_EMAIL_RECEIVING_WORKSPACE_MISMATCH"
              );
            }
          }
          assertRequiredProspectQcModelConfig(
            qcModelConfig,
            workspaceId
          );
          const approvedModelReview =
            await loadApprovedProspectQcModelReview(tx, {
              workspaceId,
              outreachJobId: job.id,
              approvalId,
              payloadHash: job.payload_hash,
              draftHash: payload.qcReceipt.draftHash,
              evidenceHash: payload.qcReceipt.evidenceHash,
              reviewId: job.qc_model_review_id,
              receiptHash:
                job.qc_model_review_receipt_hash,
            });
          if (
            qcModelConfig.requiredForApproval &&
            !approvedModelReview
          ) {
            throw new ProspectOutreachRouteError(
              "Email execution requires the advisory QC receipt bound at approval.",
              409,
              "PROSPECT_QC_MODEL_REVIEW_REQUIRED"
            );
          }
          if (!["APPROVED", "SENDING"].includes(job.state)) {
            throw new ProspectOutreachRouteError(
              `A ${job.state} outreach job cannot execute through the email provider.`,
              409,
              "PROSPECT_OUTREACH_STATE_CONFLICT"
            );
          }
          if (job.state === "APPROVED" && job.is_seed) {
            await assertCurrentControlledInboxSeedBinding({
              tx,
              env,
              workspaceId,
              outreachJobId: job.id,
              recipient: job.recipient,
              variantKey: job.variant_key,
              now: requestedAt,
            });
          }
          if (job.state === "APPROVED") {
            await assertProspectAcquisitionUnpaused(
              tx,
              workspaceId
            );
          }

          const currentEmail = normalizeProspectOutreachRecipient(
            "email",
            job.current_email
          );
          if (
            job.current_review_state !== "qualified" ||
            job.current_lead_status === "dnc" ||
            job.current_email_verification !== "verified_owner_email" ||
            currentEmail !== payload.recipient ||
            currentEmail !== job.recipient
          ) {
            throw new ProspectOutreachRouteError(
              "The prospect no longer satisfies the reviewed recipient controls.",
              409,
              "PROSPECT_EMAIL_RECIPIENT_REVIEW_STALE"
            );
          }

          try {
            const storedApproval = prospectOutreachApprovalSchema.parse({
              payloadHash: job.payload_hash,
              attestations: job.approval_attestations,
            });
            assertProspectOutreachApprovalAttestations(
              "email",
              storedApproval,
              payload.qcReceipt,
              approvedModelReview?.review
            );
          } catch {
            throw new ProspectOutreachRouteError(
              "The persisted email approval attestations are incomplete.",
              409,
              "PROSPECT_EMAIL_APPROVAL_ATTESTATIONS_INVALID"
            );
          }

          const suppressionRows = await tx<{ id: number }[]>`
            SELECT id
            FROM prospect_email_suppressions
            WHERE workspace_id = ${workspaceId}
              AND LOWER(email) = ${payload.recipient}
              AND active = TRUE
            LIMIT 1
            FOR UPDATE
          `;
          if (suppressionRows[0]) {
            throw new ProspectOutreachRouteError(
              "This recipient is on the active email suppression list.",
              409,
              "PROSPECT_EMAIL_RECIPIENT_SUPPRESSED"
            );
          }

          const idempotencyKey = buildProspectEmailIdempotencyKey({
            approvalId,
            payloadHash: parsed.data.payloadHash,
          });
          const budgetRows = await tx<{
            recipient_count: number | string;
            reserved_spend_cents: number | string;
          }[]>`
            SELECT COUNT(*)::int AS recipient_count,
                   COALESCE(SUM(provider_cost_cents), 0)::int
                     AS reserved_spend_cents
            FROM prospect_outreach_jobs
            WHERE workspace_id = ${workspaceId}
              AND id <> ${job.id}
              AND channel = 'email'
              AND provider_name = 'resend'
              AND state IN ('SENDING', 'SENT')
              AND provider_requested_at >= ${rollingWindowStart}
          `;
          const recipientCount = Number(
            budgetRows[0]?.recipient_count || 0
          );
          const reservedSpendCents = Number(
            budgetRows[0]?.reserved_spend_cents || 0
          );
          const unitCostCents = config.unitCostCents!;
          if (
            !Number.isSafeInteger(recipientCount) ||
            !Number.isSafeInteger(reservedSpendCents) ||
            recipientCount + 1 > config.dailyRecipientCap! ||
            reservedSpendCents + unitCostCents >
              config.dailySpendCapCents!
          ) {
            throw new ProspectOutreachRouteError(
              "The rolling 24-hour recipient or spend cap blocks this email.",
              409,
              "PROSPECT_EMAIL_DAILY_CAP_REACHED"
            );
          }

          if (job.state === "APPROVED") {
            const expiresAtMs = safeTimestampMs(job.expires_at);
            if (!expiresAtMs || expiresAtMs <= requestedAt.getTime()) {
              const expired = await tx<{ id: number }[]>`
                UPDATE prospect_outreach_jobs
                SET state = 'EXPIRED', updated_at = ${requestedAtIso}
                WHERE id = ${job.id} AND state = 'APPROVED'
                RETURNING id
              `;
              if (expired.length !== 1) {
                throw new ProspectOutreachRouteError(
                  "The expired outreach job did not change state.",
                  409,
                  "PROSPECT_OUTREACH_STATE_CONFLICT"
                );
              }
              await appendOutreachEvent(tx, {
                workspaceId,
                jobId: job.id,
                fromState: "APPROVED",
                toState: "EXPIRED",
                actor,
                payloadHash: job.payload_hash,
                details: { externalAction: "none" },
              });
              return {
                outcome: "expired" as const,
                state: "EXPIRED" as const,
              };
            }
            const updated = await tx<{ id: number }[]>`
              UPDATE prospect_outreach_jobs
              SET state = 'SENDING',
                  provider_name = 'resend',
                  provider_idempotency_key = ${idempotencyKey},
                  provider_cost_cents = ${unitCostCents},
                  provider_requested_at = ${requestedAtIso},
                  provider_response_at = NULL,
                  provider_attempts = 1,
                  failure_code = NULL,
                  updated_at = ${requestedAtIso}
              WHERE id = ${job.id}
                AND state = 'APPROVED'
                AND payload_hash = ${parsed.data.payloadHash}
              RETURNING id
            `;
            if (updated.length !== 1) {
              throw new ProspectOutreachRouteError(
                "The expected outreach row did not change state.",
                409,
                "PROSPECT_OUTREACH_STATE_CONFLICT"
              );
            }
            await appendOutreachEvent(tx, {
              workspaceId,
              jobId: job.id,
              fromState: "APPROVED",
              toState: "SENDING",
              actor,
              payloadHash: job.payload_hash,
              details: {
                provider: "resend",
                executionMode: "single_recipient_operator_triggered",
                providerAttempt: 1,
                reservedCostCents: unitCostCents,
                deliveryConfirmed: false,
              },
            });
            return {
              outcome: "claimed" as const,
              state: "SENDING" as const,
              payload,
              idempotencyKey,
            };
          }

          const firstRequestedAtMs = safeTimestampMs(
            job.provider_requested_at
          );
          const lastResponseAtMs = safeTimestampMs(job.provider_response_at);
          const providerAttempts = Number(job.provider_attempts || 0);
          if (
            job.provider_name !== "resend" ||
            job.provider_idempotency_key !== idempotencyKey ||
            job.provider_message_id ||
            !firstRequestedAtMs
          ) {
            throw new ProspectOutreachRouteError(
              "The in-flight email does not match this approval.",
              409,
              "PROSPECT_EMAIL_IDEMPOTENCY_CONFLICT"
            );
          }
          if (
            requestedAt.getTime() - firstRequestedAtMs >=
            23 * 60 * 60_000
          ) {
            throw new ProspectOutreachRouteError(
              "The provider outcome is still unknown and the safe idempotent retry window has closed. Reconcile it manually.",
              409,
              "PROSPECT_EMAIL_RECONCILIATION_REQUIRED"
            );
          }
          if (
            (!lastResponseAtMs &&
              requestedAt.getTime() - firstRequestedAtMs < 60_000) ||
            (lastResponseAtMs &&
              requestedAt.getTime() - lastResponseAtMs < 30_000)
          ) {
            throw new ProspectOutreachRouteError(
              "The provider request is still in flight or in retry cooldown.",
              409,
              "PROSPECT_EMAIL_PROVIDER_REQUEST_IN_FLIGHT"
            );
          }
          if (
            !Number.isSafeInteger(providerAttempts) ||
            providerAttempts < 1 ||
            providerAttempts >= 3
          ) {
            throw new ProspectOutreachRouteError(
              "The maximum of three idempotent provider attempts has been reached. Reconcile it manually.",
              409,
              "PROSPECT_EMAIL_RECONCILIATION_REQUIRED"
            );
          }

          const retried = await tx<{ id: number }[]>`
            UPDATE prospect_outreach_jobs
            SET provider_response_at = NULL,
                provider_attempts = provider_attempts + 1,
                failure_code = NULL,
                updated_at = ${requestedAtIso}
            WHERE id = ${job.id}
              AND state = 'SENDING'
              AND provider_idempotency_key = ${idempotencyKey}
              AND provider_attempts = ${providerAttempts}
            RETURNING id
          `;
          if (retried.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The expected in-flight outreach row did not change.",
              409,
              "PROSPECT_OUTREACH_STATE_CONFLICT"
            );
          }
          await appendOutreachEvent(tx, {
            workspaceId,
            jobId: job.id,
            fromState: "SENDING",
            toState: "SENDING",
            actor,
            payloadHash: job.payload_hash,
            details: {
              provider: "resend",
              executionMode: "same_idempotency_key_retry",
              providerAttempt: providerAttempts + 1,
              deliveryConfirmed: false,
            },
          });
          return {
            outcome: "claimed" as const,
            state: "SENDING" as const,
            payload,
            idempotencyKey,
          };
        });

        if (claim.outcome === "duplicate") {
          return res.json({
            ok: true,
            outcome: "duplicate",
            approvalId,
            state: claim.state,
            provider: "resend",
            providerMessageId: claim.providerMessageId,
            proofReference: claim.proofReference,
            providerAccepted: true,
            delivered: false,
            externalAction: "none",
          });
        }
        if (claim.outcome === "expired") {
          return res.status(409).json({
            error: "This outreach approval expired before provider execution.",
            code: "PROSPECT_OUTREACH_EXPIRED",
            approvalId,
            state: claim.state,
            externalAction: "none",
          });
        }

        const providerResult = await sendApprovedProspectEmail({
          payload: claim.payload,
          payloadHash: parsed.data.payloadHash,
          approvalId,
          idempotencyKey: claim.idempotencyKey,
          config,
          fetchImpl,
        });
        const providerRespondedAt = now();
        const providerRespondedAtIso = Number.isFinite(
          providerRespondedAt.getTime()
        )
          ? providerRespondedAt.toISOString()
          : requestedAtIso;

        const finalState = await sql.begin(async (tx: SqlClient) => {
          const rows = await tx<any[]>`
            SELECT id, state, payload_hash, provider_name,
                   provider_idempotency_key, provider_message_id,
                   execution_proof_reference
            FROM prospect_outreach_jobs
            WHERE approval_id = ${approvalId}
              AND workspace_id = ${workspaceId}
            LIMIT 1 FOR UPDATE
          `;
          const job = rows[0];
          if (!job) {
            throw new ProspectOutreachRouteError(
              "The claimed email job was not found during finalization.",
              503,
              "PROSPECT_EMAIL_FINALIZATION_ROW_MISSING"
            );
          }
          if (
            job.payload_hash !== parsed.data.payloadHash ||
            job.provider_name !== "resend" ||
            job.provider_idempotency_key !== claim.idempotencyKey
          ) {
            throw new ProspectOutreachRouteError(
              "The claimed email changed before finalization.",
              409,
              "PROSPECT_EMAIL_IDEMPOTENCY_CONFLICT"
            );
          }

          if (providerResult.status === "accepted") {
            if (job.state === "SENT") {
              if (
                job.provider_message_id ===
                providerResult.providerMessageId
              ) {
                return {
                  outcome: "duplicate" as const,
                  state: "SENT" as const,
                  providerResult,
                  proofReference: String(
                    job.execution_proof_reference ||
                      `provider:resend/${providerResult.providerMessageId}`
                  ),
                };
              }
              throw new ProspectOutreachRouteError(
                "The provider message ID conflicts with the stored execution.",
                409,
                "PROSPECT_EMAIL_PROVIDER_ID_CONFLICT"
              );
            }
            const proofReference = `provider:resend/${providerResult.providerMessageId}`;
            const updated = await tx<{ id: number }[]>`
              UPDATE prospect_outreach_jobs
              SET state = 'SENT',
                  sent_at = ${providerRespondedAtIso},
                  provider_message_id = ${providerResult.providerMessageId},
                  provider_response_at = ${providerRespondedAtIso},
                  execution_proof_reference = ${proofReference},
                  failure_code = NULL,
                  updated_at = ${providerRespondedAtIso}
              WHERE id = ${job.id}
                AND state = 'SENDING'
                AND provider_idempotency_key = ${claim.idempotencyKey}
              RETURNING id
            `;
            if (updated.length !== 1) {
              throw new ProspectOutreachRouteError(
                "The provider accepted the email but the durable job did not finalize.",
                503,
                "PROSPECT_EMAIL_FINALIZATION_FAILED"
              );
            }
            await appendOutreachEvent(tx, {
              workspaceId,
              jobId: job.id,
              fromState: "SENDING",
              toState: "SENT",
              actor,
              payloadHash: job.payload_hash,
              details: {
                provider: "resend",
                providerMessageId: providerResult.providerMessageId,
                providerAccepted: true,
                deliveryConfirmed: false,
              },
            });
            return {
              outcome: "accepted" as const,
              state: "SENT" as const,
              providerResult,
              proofReference,
            };
          }

          const failureCode = safeProviderFailureCode(providerResult.code);
          if (providerResult.status === "outcome_unknown") {
            const updated = await tx<{ id: number }[]>`
              UPDATE prospect_outreach_jobs
              SET provider_response_at = ${providerRespondedAtIso},
                  failure_code = ${failureCode},
                  updated_at = ${providerRespondedAtIso}
              WHERE id = ${job.id}
                AND state = 'SENDING'
                AND provider_idempotency_key = ${claim.idempotencyKey}
              RETURNING id
            `;
            if (updated.length !== 1) {
              throw new ProspectOutreachRouteError(
                "The uncertain provider result was not recorded.",
                503,
                "PROSPECT_EMAIL_FINALIZATION_FAILED"
              );
            }
            await appendOutreachEvent(tx, {
              workspaceId,
              jobId: job.id,
              fromState: "SENDING",
              toState: "SENDING",
              actor,
              payloadHash: job.payload_hash,
              details: {
                provider: "resend",
                providerAccepted: false,
                deliveryConfirmed: false,
                outcomeUnknown: true,
                failureCode,
              },
            });
            return {
              outcome: "outcome_unknown" as const,
              state: "SENDING" as const,
              providerResult,
              proofReference: null,
            };
          }

          const updated = await tx<{ id: number }[]>`
            UPDATE prospect_outreach_jobs
            SET state = 'FAILED',
                provider_response_at = ${providerRespondedAtIso},
                failure_code = ${failureCode},
                updated_at = ${providerRespondedAtIso}
            WHERE id = ${job.id}
              AND state = 'SENDING'
              AND provider_idempotency_key = ${claim.idempotencyKey}
            RETURNING id
          `;
          if (updated.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The failed provider result was not recorded.",
              503,
              "PROSPECT_EMAIL_FINALIZATION_FAILED"
            );
          }
          await appendOutreachEvent(tx, {
            workspaceId,
            jobId: job.id,
            fromState: "SENDING",
            toState: "FAILED",
            actor,
            payloadHash: job.payload_hash,
            details: {
              provider: "resend",
              providerAccepted: false,
              deliveryConfirmed: false,
              failureCode,
            },
          });
          return {
            outcome: "failed" as const,
            state: "FAILED" as const,
            providerResult,
            proofReference: null,
          };
        });

        if (
          finalState.outcome === "accepted" ||
          finalState.outcome === "duplicate"
        ) {
          const acceptedResult =
            finalState.providerResult as Extract<
              ProspectEmailProviderResult,
              { status: "accepted" }
            >;
          return res.json({
            ok: true,
            outcome: finalState.outcome,
            approvalId,
            state: finalState.state,
            provider: "resend",
            providerMessageId: acceptedResult.providerMessageId,
            proofReference: finalState.proofReference,
            providerAccepted: true,
            delivered: false,
            externalAction: "provider_request_accepted",
          });
        }

        const failedResult = finalState.providerResult as Exclude<
          ProspectEmailProviderResult,
          { status: "accepted" }
        >;
        return res
          .status(finalState.outcome === "outcome_unknown" ? 503 : 502)
          .json({
            error: failedResult.error,
            code: failedResult.code,
            approvalId,
            state: finalState.state,
            provider: "resend",
            providerAccepted: false,
            delivered: false,
            retryable: failedResult.retryable,
            externalAction:
              finalState.outcome === "outcome_unknown"
                ? "provider_request_outcome_unknown"
                : "provider_request_failed",
          });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.get(
    "/api/prospecting/velvet-outcomes/outbox",
    dashboardAuth,
    requireOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) return res.json({ events: [] });
      const workspaceId = getWorkspaceId(req);
      const rows = await sql`
        SELECT o.id, o.lead_id, o.external_event_id,
               o.external_prospect_id, o.payload_hash, o.state, o.attempts,
               o.last_error, o.dispatched_at, o.dispatch_idempotency_key,
               o.dispatch_requested_at, o.dispatch_response_at,
               o.remote_event_id, o.created_at, o.updated_at
        FROM velvet_outcome_outbox o
        JOIN prospect_outcome_events e
          ON e.id = o.outcome_event_id
         AND e.workspace_id = o.workspace_id
        JOIN prospect_outreach_jobs j
          ON j.id = e.outreach_job_id
         AND j.workspace_id = o.workspace_id
         AND j.is_seed = FALSE
        WHERE o.workspace_id = ${workspaceId}
        ORDER BY o.created_at DESC
        LIMIT 200
      `;
      const config = readVelvetOutcomeDispatchConfig(env);
      return res.json({
        events: rows,
        dispatch: {
          enabled: config.enabled,
          configured: config.configured,
          availableForWorkspace:
            config.configured && config.workspaceId === workspaceId,
          missing: config.missing,
        },
        externalAction: "none",
      });
    }
  );

  const loadLearningObservations = async (
    workspaceId: number
  ): Promise<LearningObservation[]> => {
    const rows = await sql<{
      outreach_job_id: number;
      channel: "email" | "call";
      variant_key: string;
      outcome: string;
      occurred_at: string;
    }[]>`
      SELECT j.id AS outreach_job_id, j.channel, j.variant_key,
             e.outcome, e.occurred_at
      FROM prospect_outcome_events e
      JOIN prospect_outreach_jobs j ON j.id = e.outreach_job_id
      WHERE e.workspace_id = ${workspaceId}
        AND j.workspace_id = ${workspaceId}
        AND j.is_seed = FALSE
      ORDER BY e.occurred_at ASC
    `;
    return rows.flatMap((row) => {
      const outcome = learningOutcomeSchema.safeParse(row.outcome);
      if (
        !outcome.success ||
        !["email", "call"].includes(row.channel) ||
        !row.variant_key
      ) {
        return [];
      }
      const definition = getProspectMessageVariantDefinition(row.variant_key);
      if (!definition || definition.channel !== row.channel) return [];
      return [
        {
          outreachJobId: String(row.outreach_job_id),
          channel: row.channel,
          variantKey: row.variant_key,
          outcome: outcome.data,
          occurredAt: row.occurred_at,
        },
      ];
    });
  };

  app.get(
    "/api/prospecting/learning/scorecard",
    dashboardAuth,
    requireOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.json({
          variants: [],
          sampleSize: 0,
          eventCount: 0,
          studyDesign: "observational",
        });
      }
      try {
        const observations = await loadLearningObservations(
          getWorkspaceId(req)
        );
        const variants = buildProspectLearningScorecard(observations);
        return res.json({
          variants,
          sampleSize: variants.reduce(
            (total, variant) => total + variant.sampleSize,
            0
          ),
          eventCount: observations.length,
          studyDesign: "observational",
          candidateEligible: false,
          note:
            "These signals describe operator-selected messages. Learning candidates require a separately activated and closed deterministic-assignment experiment.",
          policyChanged: false,
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.get(
    "/api/prospecting/learning/policies",
    dashboardAuth,
    requireOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.json({
          policies: [],
          releases: [],
          externalAction: "none",
        });
      }
      const workspaceId = getWorkspaceId(req);
      try {
        const rows = await sql<ProspectMessagePolicyRow[]>`
          SELECT id, release_id, workspace_id, campaign_id, channel,
                 version, action, champion_variant_key,
                 previous_champion_variant_key, source_candidate_id,
                 rollback_of_release_id, release, release_hash,
                 applied_by, applied_at, created_at
          FROM prospect_message_policy_releases
          WHERE workspace_id = ${workspaceId}
          ORDER BY campaign_id ASC, channel ASC, version DESC
          LIMIT 200
        `;
        const releases = rows.map(row => {
          const release = requireProspectMessagePolicyRelease(row);
          return {
            release,
            releaseHash: row.release_hash,
          };
        });
        const currentKeys = new Set<string>();
        const policies = releases.filter(item => {
          const key = `${item.release.campaignId}:${item.release.channel}`;
          if (currentKeys.has(key)) return false;
          currentKeys.add(key);
          return true;
        });
        return res.json({
          policies,
          releases,
          externalAction: "none",
          contactAuthorized: false,
          executionAuthorized: false,
          spendAuthorized: false,
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.get(
    "/api/prospecting/learning/candidates",
    dashboardAuth,
    requireOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) return res.json({ candidates: [] });
      try {
        const rows = await sql`
          SELECT
            c.id, c.candidate_key, c.version, c.state, c.proposal,
            c.evidence, c.sample_size, c.generated_at, c.decided_by,
            c.decided_at,
            (
              e.id IS NOT NULL
              AND e.state = 'CLOSED'
              AND c.candidate_key = 'experiment:' || e.experiment_id
              AND c.proposal->>'studyDesign' =
                c.evidence->>'studyDesign'
              AND (
                (
                  e.definition->>'contractVersion' =
                    ${PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION}
                  AND c.proposal->>'studyDesign' =
                    ${PROSPECT_MESSAGE_EXPERIMENT_STUDY_DESIGN}
                )
                OR
                (
                  e.definition->>'contractVersion' =
                    ${PROSPECT_MESSAGE_EXPERIMENT_LEGACY_CONTRACT_VERSION}
                  AND c.proposal->>'studyDesign' =
                    ${PROSPECT_MESSAGE_EXPERIMENT_LEGACY_STUDY_DESIGN}
                )
              )
              AND c.proposal->>'experimentId' = e.experiment_id
              AND c.evidence->>'experimentId' = e.experiment_id
              AND c.proposal->>'experimentDefinitionHash' =
                e.definition_hash
              AND c.evidence->>'experimentDefinitionHash' =
                e.definition_hash
              AND c.proposal->>'registryVersion' =
                ${PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION}
              AND c.evidence->>'registryVersion' =
                ${PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION}
              AND c.proposal->>'runtimePolicyChange' = 'false'
              AND c.proposal->>'channel' = e.channel
              AND c.evidence->'current'->>'channel' = e.channel
              AND c.evidence->'challenger'->>'channel' = e.channel
              AND c.proposal->>'replaceVariant' =
                e.control_variant_key
              AND c.proposal->>'promoteVariant' =
                e.challenger_variant_key
              AND c.evidence->'current'->>'variantKey' =
                e.control_variant_key
              AND c.evidence->'challenger'->>'variantKey' =
                e.challenger_variant_key
              AND c.evidence->>'executedProtocolDeviationCount' = '0'
              AND c.evidence->>'statisticalTest' =
                ${PROSPECT_LEARNING_STATISTICAL_TEST}
              AND CASE
                WHEN
                  c.evidence->>'absoluteLift' ~
                    '^[0-9]+([.][0-9]+)?$'
                  AND c.evidence->>'oneSidedFisherPValue' ~
                    '^[0-9]+([.][0-9]+)?$'
                  AND c.evidence->>'maximumOneSidedFisherPValue' ~
                    '^[0-9]+([.][0-9]+)?$'
                THEN
                  (c.evidence->>'absoluteLift')::numeric > 0
                  AND
                    (c.evidence->>'oneSidedFisherPValue')::numeric <=
                      ${MAXIMUM_ONE_SIDED_FISHER_P_VALUE}
                  AND
                    (c.evidence->>'maximumOneSidedFisherPValue')::numeric =
                      ${MAXIMUM_ONE_SIDED_FISHER_P_VALUE}
                ELSE FALSE
              END
              AND CASE
                WHEN
                  c.evidence->'current'->>'sampleSize' ~ '^[0-9]+$'
                  AND c.evidence->'challenger'->>'sampleSize' ~
                    '^[0-9]+$'
                THEN
                  (c.evidence->'current'->>'sampleSize')::int >= 10
                  AND
                    (c.evidence->'challenger'->>'sampleSize')::int >=
                      10
                  AND c.sample_size =
                    (c.evidence->'current'->>'sampleSize')::int +
                    (c.evidence->'challenger'->>'sampleSize')::int
                ELSE FALSE
              END
              AND CASE
                WHEN
                  c.evidence->>'assignedProspects' ~ '^[0-9]+$'
                  AND c.evidence->>'executedProspects' ~ '^[0-9]+$'
                  AND c.evidence->>'measuredProspects' ~ '^[0-9]+$'
                  AND c.evidence->>'outcomeEventCount' ~ '^[0-9]+$'
                  AND c.evidence->'armStats'->'control'->>'assigned' ~ '^[0-9]+$'
                  AND c.evidence->'armStats'->'control'->>'executed' ~ '^[0-9]+$'
                  AND c.evidence->'armStats'->'control'->>'measured' ~ '^[0-9]+$'
                  AND c.evidence->'armStats'->'control'->>'outcomeEvents' ~ '^[0-9]+$'
                  AND c.evidence->'armStats'->'challenger'->>'assigned' ~ '^[0-9]+$'
                  AND c.evidence->'armStats'->'challenger'->>'executed' ~ '^[0-9]+$'
                  AND c.evidence->'armStats'->'challenger'->>'measured' ~ '^[0-9]+$'
                  AND c.evidence->'armStats'->'challenger'->>'outcomeEvents' ~ '^[0-9]+$'
                THEN
                  (c.evidence->>'assignedProspects')::int =
                    (c.evidence->>'executedProspects')::int
                  AND (c.evidence->>'assignedProspects')::int =
                    (c.evidence->>'measuredProspects')::int
                  AND (c.evidence->>'assignedProspects')::int =
                    (c.evidence->'armStats'->'control'->>'assigned')::int +
                    (c.evidence->'armStats'->'challenger'->>'assigned')::int
                  AND (c.evidence->>'executedProspects')::int =
                    (c.evidence->'armStats'->'control'->>'executed')::int +
                    (c.evidence->'armStats'->'challenger'->>'executed')::int
                  AND (c.evidence->>'measuredProspects')::int =
                    (c.evidence->'armStats'->'control'->>'measured')::int +
                    (c.evidence->'armStats'->'challenger'->>'measured')::int
                  AND (c.evidence->>'outcomeEventCount')::int =
                    (c.evidence->'armStats'->'control'->>'outcomeEvents')::int +
                    (c.evidence->'armStats'->'challenger'->>'outcomeEvents')::int
                  AND (c.evidence->>'outcomeEventCount')::int >=
                    (c.evidence->>'measuredProspects')::int
                  AND (c.evidence->'armStats'->'control'->>'assigned')::int =
                    (c.evidence->'armStats'->'control'->>'executed')::int
                  AND (c.evidence->'armStats'->'control'->>'assigned')::int =
                    (c.evidence->'armStats'->'control'->>'measured')::int
                  AND (c.evidence->'armStats'->'challenger'->>'assigned')::int =
                    (c.evidence->'armStats'->'challenger'->>'executed')::int
                  AND (c.evidence->'armStats'->'challenger'->>'assigned')::int =
                    (c.evidence->'armStats'->'challenger'->>'measured')::int
                  AND (c.evidence->'current'->>'sampleSize')::int =
                    (c.evidence->'armStats'->'control'->>'measured')::int
                  AND (c.evidence->'challenger'->>'sampleSize')::int =
                    (c.evidence->'armStats'->'challenger'->>'measured')::int
                  AND c.sample_size =
                    (c.evidence->>'measuredProspects')::int
                ELSE FALSE
              END
              AND CASE
                WHEN e.definition->>'contractVersion' =
                  ${PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION}
                THEN CASE
                  WHEN jsonb_typeof(e.definition->'cohort') = 'array'
                    AND c.evidence->>'assignedProspects' ~ '^[0-9]+$'
                    AND c.evidence->'armStats'->'control'->>'assigned' ~ '^[0-9]+$'
                    AND c.evidence->'armStats'->'challenger'->>'assigned' ~ '^[0-9]+$'
                  THEN
                    (c.evidence->>'assignedProspects')::int =
                      jsonb_array_length(e.definition->'cohort')
                    AND (c.evidence->'armStats'->'control'->>'assigned')::int =
                      jsonb_array_length(e.definition->'cohort') / 2
                    AND (c.evidence->'armStats'->'challenger'->>'assigned')::int =
                      jsonb_array_length(e.definition->'cohort') / 2
                  ELSE FALSE
                END
                ELSE TRUE
              END
            ) AS recommendation_eligible
          FROM prospect_learning_candidates c
          LEFT JOIN prospect_message_experiments e
            ON e.workspace_id = c.workspace_id
           AND e.experiment_id = c.proposal->>'experimentId'
          WHERE c.workspace_id = ${getWorkspaceId(req)}
          ORDER BY c.generated_at DESC
          LIMIT 100
        `;
        return res.json({
          candidates: rows.map(row => ({
            ...row,
            proposal_hash: hashProspectMessagePolicyValue(
              parseStoredJson(row.proposal)
            ),
          })),
          policyChanged: false,
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/learning/candidates",
    dashboardAuth,
    requireOperator,
    requireAcquisitionUnpaused,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
        });
      }
      const parsed = learningCandidateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid learning candidate request.",
          code: "PROSPECT_LEARNING_INVALID_CANDIDATE",
        });
      }
      const workspaceId = getWorkspaceId(req);
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          await assertProspectAcquisitionMutationUnpaused(
            tx,
            workspaceId
          );
          const experimentRows =
            await tx<ProspectMessageExperimentRow[]>`
              SELECT id, experiment_id, workspace_id, campaign_id,
                     channel, state, control_variant_key,
                     challenger_variant_key, allocation_basis_points,
                     definition, definition_hash, prepared_by,
                     activated_by, activated_at, closed_by, closed_at,
                     created_at, updated_at
              FROM prospect_message_experiments
              WHERE workspace_id = ${workspaceId}
                AND experiment_id = ${parsed.data.experimentId}
              LIMIT 1
              FOR UPDATE
            `;
          const experiment = experimentRows[0];
          if (!experiment) {
            throw new ProspectOutreachRouteError(
              "Message experiment not found.",
              404,
              "PROSPECT_MESSAGE_EXPERIMENT_NOT_FOUND"
            );
          }
          const definition = requireExperimentDefinition(experiment);
          if (experiment.state !== "CLOSED") {
            throw new ProspectOutreachRouteError(
              "Close the deterministic-assignment experiment before evaluating a learning candidate.",
              409,
              "PROSPECT_LEARNING_EXPERIMENT_NOT_CLOSED"
            );
          }
          const controlDefinition =
            getProspectMessageVariantDefinition(
              definition.controlVariantKey
            );
          const challengerDefinition =
            getProspectMessageVariantDefinition(
              definition.challengerVariantKey
            );
          if (
            !controlDefinition ||
            !challengerDefinition ||
            controlDefinition.channel !== definition.channel ||
            challengerDefinition.channel !== definition.channel
          ) {
            throw new ProspectOutreachRouteError(
              "The closed experiment references a strategy that is no longer in the registered content library.",
              409,
              "PROSPECT_LEARNING_UNREGISTERED_VARIANT"
            );
          }
          const candidateKey = `experiment:${definition.experimentId}`;
          const existingRows = await tx<{
            id: number;
            version: number;
            state: string;
            sample_size: number;
            evidence: unknown;
          }[]>`
            SELECT id, version, state, sample_size, evidence
            FROM prospect_learning_candidates
            WHERE workspace_id = ${workspaceId}
              AND candidate_key = ${candidateKey}
            ORDER BY version DESC
            LIMIT 1
          `;
          if (existingRows[0]) {
            const storedEvidence = parseStoredJson(
              existingRows[0].evidence
            );
            return {
              outcome: "duplicate" as const,
              id: existingRows[0].id,
              version: existingRows[0].version,
              state: existingRows[0].state,
              sampleSize: existingRows[0].sample_size,
              experimentId: definition.experimentId,
              candidateKey,
              armStats:
                storedEvidence &&
                typeof storedEvidence === "object" &&
                "armStats" in storedEvidence
                  ? (
                      storedEvidence as {
                        armStats: unknown;
                      }
                    ).armStats
                  : null,
            };
          }
          const cohort = await loadProspectMessageExperimentEvidence(tx, {
            workspaceId,
            definition,
          });
          if (cohort.executedProtocolDeviationCount > 0) {
            throw new ProspectOutreachRouteError(
              "The experiment includes executed off-protocol messages and cannot support a learning candidate.",
              409,
              "PROSPECT_LEARNING_PROTOCOL_DEVIATION"
            );
          }
          const coverageEvaluation =
            evaluateProspectMessageExperimentCoverage({
              definition,
              coverage: {
                armStats: cohort.armStats,
                assignedProspects: cohort.assignedProspects,
                executedProspects: cohort.executedProspects,
                measuredProspects: cohort.measuredProspects,
                outcomeEventCount: cohort.outcomeEventCount,
              },
            });
          if (!coverageEvaluation.eligible) {
            if (
              coverageEvaluation.code !== "COHORT_ATTRITION"
            ) {
              throw new ProspectOutreachRouteError(
                "The experiment coverage does not match its frozen cohort.",
                409,
                "PROSPECT_MESSAGE_EXPERIMENT_COHORT_INVALID"
              );
            }
            throw new ProspectOutreachRouteError(
              "Every assigned prospect must be executed with a measured outcome before this experiment can support a learning candidate. Rejecting or cancelling a draft is safe, but it invalidates promotion evidence instead of pressuring contact.",
              409,
              "PROSPECT_LEARNING_COHORT_ATTRITION"
            );
          }
          const evaluation = evaluateProspectLearningCandidate({
            channel: definition.channel,
            currentVariant: definition.controlVariantKey,
            challengerVariant: definition.challengerVariantKey,
            observations: cohort.observations,
          });
          if (evaluation.ready === false) {
            const failureMessage =
              evaluation.code === "INSUFFICIENT_SAMPLE"
                ? "Both assigned arms need at least 10 executed, protocol-compliant outreach jobs with measured outcomes."
                : evaluation.code === "INSUFFICIENT_CONFIDENCE"
                  ? "The assigned challenger lift does not pass the exact one-sided confidence gate."
                  : "The assigned challenger cohort has no measured positive lift.";
            throw new ProspectOutreachRouteError(
              failureMessage,
              409,
              `PROSPECT_LEARNING_${evaluation.code}`
            );
          }
          const studyDesign =
            getProspectMessageExperimentStudyDesign(definition);
          const proposal = {
            ...evaluation.proposal,
            studyDesign,
            experimentId: definition.experimentId,
            experimentDefinitionHash: experiment.definition_hash,
            registryVersion: PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION,
            promoteLabel: challengerDefinition.label,
            replaceLabel: controlDefinition.label,
            promoteHypothesis: challengerDefinition.hypothesis,
            runtimePolicyChange: false,
          };
          const evidence = {
            ...evaluation.evidence,
            studyDesign,
            interpretation:
              studyDesign ===
              PROSPECT_MESSAGE_EXPERIMENT_STUDY_DESIGN
                ? "Frozen operator-qualified population with deterministic balanced cohort selection and assignment. Full assigned-cohort execution and measurement are required; this remains a recommendation, not an autonomous policy change or a population-wide market estimate."
                : "Deterministically assigned cohort evidence; enrollment itself was operator-selected and this is not an autonomous policy change.",
            experimentId: definition.experimentId,
            experimentDefinitionHash: experiment.definition_hash,
            registryVersion: PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION,
            armStats: cohort.armStats,
            assignedProspects: cohort.assignedProspects,
            executedProspects: cohort.executedProspects,
            measuredProspects: cohort.measuredProspects,
            outcomeEventCount: cohort.outcomeEventCount,
            executedProtocolDeviationCount:
              cohort.executedProtocolDeviationCount,
          };
          const versionRows = await tx<{ version: number }[]>`
            SELECT COALESCE(MAX(version), 0) + 1 AS version
            FROM prospect_learning_candidates
            WHERE workspace_id = ${workspaceId}
              AND candidate_key = ${candidateKey}
          `;
          const version = Number(versionRows[0]?.version || 1);
          const rows = await tx<{ id: number }[]>`
            INSERT INTO prospect_learning_candidates (
              workspace_id, candidate_key, version, state, proposal,
              evidence, sample_size
            ) VALUES (
              ${workspaceId}, ${candidateKey}, ${version},
              'CANDIDATE', ${tx.json(proposal)},
              ${tx.json(evidence)}, ${evaluation.sampleSize}
            )
            RETURNING id
          `;
          if (rows.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The learning candidate was not durably recorded.",
              503,
              "PROSPECT_LEARNING_WRITE_FAILED"
            );
          }
          return {
            outcome: "created" as const,
            id: rows[0].id,
            version,
            state: "CANDIDATE" as const,
            sampleSize: evaluation.sampleSize,
            experimentId: definition.experimentId,
            candidateKey,
            armStats: cohort.armStats,
          };
        });
        return res.status(result.outcome === "created" ? 201 : 200).json({
          ok: true,
          ...result,
          policyChanged: false,
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/learning/candidates/:id/decision",
    dashboardAuth,
    requireFullOperator,
    requireAcquisitionUnpaused,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
        });
      }
      const candidateId = parsePositiveId(req.params.id);
      const parsed = learningDecisionSchema.safeParse(req.body);
      if (!candidateId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid learning candidate decision.",
          code: "PROSPECT_LEARNING_INVALID_DECISION",
        });
      }
      const workspaceId = getWorkspaceId(req);
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          await assertProspectAcquisitionMutationUnpaused(
            tx,
            workspaceId
          );
          const candidateRows = await tx<{
            id: number;
            candidate_key: string;
            state: string;
            proposal: unknown;
            evidence: unknown;
            sample_size: number;
          }[]>`
            SELECT id, candidate_key, state, proposal, evidence,
                   sample_size
            FROM prospect_learning_candidates
            WHERE id = ${candidateId}
              AND workspace_id = ${workspaceId}
            LIMIT 1
            FOR UPDATE
          `;
          const candidate = candidateRows[0];
          if (!candidate || candidate.state !== "CANDIDATE") {
            return { outcome: "conflict" as const };
          }
          if (parsed.data.decision === "APPROVED") {
            const proposal =
              deterministicCandidateProposalSchema.safeParse(
                parseStoredJson(candidate.proposal)
              );
            if (!proposal.success) {
              throw new ProspectOutreachRouteError(
                "Only a closed deterministic-assignment candidate can be approved.",
                409,
                "PROSPECT_LEARNING_CANDIDATE_INELIGIBLE"
              );
            }
            const experimentRows =
              await tx<ProspectMessageExperimentRow[]>`
                SELECT id, experiment_id, workspace_id, campaign_id,
                       channel, state, control_variant_key,
                       challenger_variant_key, allocation_basis_points,
                       definition, definition_hash, prepared_by,
                       activated_by, activated_at, closed_by, closed_at,
                       created_at, updated_at
                FROM prospect_message_experiments
                WHERE workspace_id = ${workspaceId}
                  AND experiment_id = ${proposal.data.experimentId}
                  AND state = 'CLOSED'
                  AND definition_hash =
                    ${proposal.data.experimentDefinitionHash}
                LIMIT 1
                FOR SHARE
              `;
            if (!experimentRows[0]) {
              throw new ProspectOutreachRouteError(
                "The candidate's closed experiment could not be verified.",
                409,
                "PROSPECT_LEARNING_CANDIDATE_INELIGIBLE"
              );
            }
            requireDeterministicCandidateBinding(
              candidate,
              experimentRows[0]
            );
          }
          const rows = await tx<{ id: number }[]>`
            UPDATE prospect_learning_candidates
            SET state = ${parsed.data.decision},
                decided_by = ${actorForRequest(req)},
                decided_at = NOW()
            WHERE id = ${candidateId}
              AND workspace_id = ${workspaceId}
              AND state = 'CANDIDATE'
            RETURNING id
          `;
          if (rows.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The learning candidate decision was not durably recorded.",
              503,
              "PROSPECT_LEARNING_WRITE_FAILED"
            );
          }
          return { outcome: "decided" as const };
        });
        if (result.outcome === "conflict") {
          return res.status(409).json({
            error: "Candidate was not found or already decided.",
            code: "PROSPECT_LEARNING_STATE_CONFLICT",
            policyChanged: false,
          });
        }
        return res.json({
          ok: true,
          state: parsed.data.decision,
          policyChanged: false,
          note:
            "Decision recorded. The next-experiment control remains unchanged until a full operator separately releases this approved candidate.",
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/learning/candidates/:id/apply-policy",
    dashboardAuth,
    requireOperator,
    requireFullOperator,
    requireAcquisitionUnpaused,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
        });
      }
      const candidateId = parsePositiveId(req.params.id);
      const parsed = applyProspectMessagePolicySchema.safeParse(
        req.body
      );
      if (!candidateId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid message-policy application.",
          code: "PROSPECT_MESSAGE_POLICY_APPLICATION_INVALID",
          issues: parsed.success ? [] : parsed.error.issues,
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = actorForRequest(req);
      const appliedAt = now().toISOString();
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          await assertProspectAcquisitionMutationUnpaused(
            tx,
            workspaceId
          );
          const candidateRows = await tx<{
            id: number;
            candidate_key: string;
            version: number;
            state: string;
            proposal: unknown;
            evidence: unknown;
            sample_size: number;
          }[]>`
            SELECT id, candidate_key, version, state, proposal,
                   evidence, sample_size
            FROM prospect_learning_candidates
            WHERE id = ${candidateId}
              AND workspace_id = ${workspaceId}
            LIMIT 1
            FOR UPDATE
          `;
          const candidate = candidateRows[0];
          if (!candidate || candidate.state !== "APPROVED") {
            throw new ProspectOutreachRouteError(
              "Only an approved deterministic learning candidate can change the next-experiment control.",
              409,
              "PROSPECT_MESSAGE_POLICY_CANDIDATE_NOT_APPROVED"
            );
          }
          const proposal =
            deterministicCandidateProposalSchema.safeParse(
              parseStoredJson(candidate.proposal)
            );
          if (
            !proposal.success ||
            hashProspectMessagePolicyValue(proposal.data) !==
              parsed.data.proposalHash
          ) {
            throw new ProspectOutreachRouteError(
              "The policy application does not match the approved candidate proposal.",
              409,
              "PROSPECT_MESSAGE_POLICY_PROPOSAL_MISMATCH"
            );
          }
          const experimentRows =
            await tx<ProspectMessageExperimentRow[]>`
              SELECT id, experiment_id, workspace_id, campaign_id,
                     channel, state, control_variant_key,
                     challenger_variant_key, allocation_basis_points,
                     definition, definition_hash, prepared_by,
                     activated_by, activated_at, closed_by, closed_at,
                     created_at, updated_at
              FROM prospect_message_experiments
              WHERE workspace_id = ${workspaceId}
                AND experiment_id = ${proposal.data.experimentId}
                AND state = 'CLOSED'
                AND definition_hash =
                  ${proposal.data.experimentDefinitionHash}
              LIMIT 1
              FOR SHARE
            `;
          const experiment = experimentRows[0];
          if (!experiment) {
            throw new ProspectOutreachRouteError(
              "The approved candidate's closed experiment could not be verified.",
              409,
              "PROSPECT_MESSAGE_POLICY_CANDIDATE_INELIGIBLE"
            );
          }
          requireDeterministicCandidateBinding(
            candidate,
            experiment
          );
          const promotedDefinition =
            getProspectMessageVariantDefinition(
              proposal.data.promoteVariant
            );
          const replacedDefinition =
            getProspectMessageVariantDefinition(
              proposal.data.replaceVariant
            );
          if (
            !promotedDefinition ||
            !replacedDefinition ||
            promotedDefinition.channel !== proposal.data.channel ||
            replacedDefinition.channel !== proposal.data.channel
          ) {
            throw new ProspectOutreachRouteError(
              "The approved policy references a strategy that is no longer registered for this channel.",
              409,
              "PROSPECT_MESSAGE_POLICY_VARIANT_INVALID"
            );
          }
          const campaignRows = await tx<{ id: number }[]>`
            SELECT id
            FROM prospecting_campaigns
            WHERE id = ${experiment.campaign_id}
              AND workspace_id = ${workspaceId}
            LIMIT 1
            FOR UPDATE
          `;
          if (campaignRows.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The candidate campaign was not found.",
              404,
              "PROSPECT_CAMPAIGN_NOT_FOUND"
            );
          }
          const currentPolicy =
            await loadCurrentProspectMessagePolicy(tx, {
              workspaceId,
              campaignId: experiment.campaign_id,
              channel: proposal.data.channel,
              lock: true,
            });
          if (
            currentPolicy?.release.action === "PROMOTE" &&
            currentPolicy.release.sourceCandidate.id === candidate.id
          ) {
            if (
              currentPolicy.release.sourceCandidate.proposalHash !==
                parsed.data.proposalHash ||
              currentPolicy.release.championVariantKey !==
                proposal.data.promoteVariant
            ) {
              throw new ProspectOutreachRouteError(
                "The existing policy application does not match this replay.",
                409,
                "PROSPECT_MESSAGE_POLICY_REPLAY_MISMATCH"
              );
            }
            return {
              outcome: "duplicate" as const,
              release: currentPolicy.release,
              releaseHash: currentPolicy.row.release_hash,
            };
          }
          const historicalApplicationRows = await tx<{
            release_id: string;
          }[]>`
            SELECT release_id
            FROM prospect_message_policy_releases
            WHERE workspace_id = ${workspaceId}
              AND source_candidate_id = ${candidate.id}
              AND action = 'PROMOTE'
            LIMIT 1
          `;
          if (historicalApplicationRows[0]) {
            throw new ProspectOutreachRouteError(
              "This learning candidate was already applied and cannot be promoted twice.",
              409,
              "PROSPECT_MESSAGE_POLICY_CANDIDATE_ALREADY_APPLIED"
            );
          }
          if (
            currentPolicy &&
            currentPolicy.release.championVariantKey !==
              proposal.data.replaceVariant
          ) {
            throw new ProspectOutreachRouteError(
              "The candidate is stale because its measured control is no longer the current campaign champion.",
              409,
              "PROSPECT_MESSAGE_POLICY_STALE_CANDIDATE"
            );
          }
          const release = buildProspectMessagePolicyRelease({
            workspaceId,
            campaignId: experiment.campaign_id,
            channel: proposal.data.channel,
            version: (currentPolicy?.release.version || 0) + 1,
            action: "PROMOTE",
            championVariantKey: proposal.data.promoteVariant,
            previousChampionVariantKey:
              currentPolicy?.release.championVariantKey ||
              proposal.data.replaceVariant,
            sourceCandidate: {
              id: candidate.id,
              candidateKey: candidate.candidate_key,
              version: Number(candidate.version),
              experimentId: proposal.data.experimentId,
              experimentDefinitionHash:
                proposal.data.experimentDefinitionHash,
              proposalHash: parsed.data.proposalHash,
              sampleSize: Number(candidate.sample_size),
            },
            rollbackOfReleaseId: null,
            reason: null,
            appliedBy: actor,
            appliedAt,
            attestations: parsed.data.attestations,
            controls: {
              nextExperimentControlOnly: true,
              existingJobsChanged: false,
              contactAuthorized: false,
              executionAuthorized: false,
              spendAuthorized: false,
            },
          });
          const releaseHash =
            hashProspectMessagePolicyValue(release);
          const inserted = await tx<{ id: number }[]>`
            INSERT INTO prospect_message_policy_releases (
              release_id, workspace_id, campaign_id, channel, version,
              action, champion_variant_key,
              previous_champion_variant_key, source_candidate_id,
              rollback_of_release_id, release, release_hash,
              applied_by, applied_at
            ) VALUES (
              ${release.releaseId}, ${workspaceId},
              ${release.campaignId}, ${release.channel},
              ${release.version}, ${release.action},
              ${release.championVariantKey},
              ${release.previousChampionVariantKey}, ${candidate.id},
              NULL, ${tx.json(release)}, ${releaseHash},
              ${release.appliedBy}, ${release.appliedAt}
            )
            RETURNING id
          `;
          if (inserted.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The message-policy release was not durably recorded.",
              503,
              "PROSPECT_MESSAGE_POLICY_WRITE_FAILED"
            );
          }
          return {
            outcome: "applied" as const,
            release,
            releaseHash,
          };
        });
        return res
          .status(result.outcome === "applied" ? 201 : 200)
          .json({
            ok: true,
            ...result,
            policyChanged: true,
            existingJobsChanged: false,
            externalAction: "none",
            contactAuthorized: false,
            executionAuthorized: false,
            spendAuthorized: false,
          });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/learning/policies/:releaseId/rollback",
    dashboardAuth,
    requireOperator,
    requireFullOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
        });
      }
      const releaseId = z.string().uuid().safeParse(
        req.params.releaseId
      );
      const parsed = rollbackProspectMessagePolicySchema.safeParse(
        req.body
      );
      if (!releaseId.success || !parsed.success) {
        return res.status(400).json({
          error: "Invalid message-policy rollback.",
          code: "PROSPECT_MESSAGE_POLICY_ROLLBACK_INVALID",
          issues: parsed.success ? [] : parsed.error.issues,
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = actorForRequest(req);
      const appliedAt = now().toISOString();
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          const targetRows = await tx<ProspectMessagePolicyRow[]>`
            SELECT id, release_id, workspace_id, campaign_id, channel,
                   version, action, champion_variant_key,
                   previous_champion_variant_key, source_candidate_id,
                   rollback_of_release_id, release, release_hash,
                   applied_by, applied_at, created_at
            FROM prospect_message_policy_releases
            WHERE workspace_id = ${workspaceId}
              AND release_id = ${releaseId.data}
            LIMIT 1
          `;
          const target = targetRows[0];
          if (!target) {
            throw new ProspectOutreachRouteError(
              "Message-policy release not found.",
              404,
              "PROSPECT_MESSAGE_POLICY_NOT_FOUND"
            );
          }
          const campaignRows = await tx<{ id: number }[]>`
            SELECT id
            FROM prospecting_campaigns
            WHERE id = ${target.campaign_id}
              AND workspace_id = ${workspaceId}
            LIMIT 1
            FOR UPDATE
          `;
          if (campaignRows.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The policy campaign was not found.",
              404,
              "PROSPECT_CAMPAIGN_NOT_FOUND"
            );
          }
          const currentPolicy =
            await loadCurrentProspectMessagePolicy(tx, {
              workspaceId,
              campaignId: target.campaign_id,
              channel: target.channel,
              lock: true,
            });
          if (
            currentPolicy?.release.action === "ROLLBACK" &&
            currentPolicy.release.rollbackOfReleaseId ===
              releaseId.data &&
            target.release_hash === parsed.data.releaseHash
          ) {
            if (
              currentPolicy.release.reason !== parsed.data.reason
            ) {
              throw new ProspectOutreachRouteError(
                "The existing policy rollback does not match this replay.",
                409,
                "PROSPECT_MESSAGE_POLICY_REPLAY_MISMATCH"
              );
            }
            return {
              outcome: "duplicate" as const,
              release: currentPolicy.release,
              releaseHash: currentPolicy.row.release_hash,
            };
          }
          if (
            !currentPolicy ||
            currentPolicy.release.releaseId !== releaseId.data
          ) {
            throw new ProspectOutreachRouteError(
              "Only the current message-policy release can be rolled back.",
              409,
              "PROSPECT_MESSAGE_POLICY_NOT_CURRENT"
            );
          }
          if (
            currentPolicy.row.release_hash !==
              parsed.data.releaseHash
          ) {
            throw new ProspectOutreachRouteError(
              "The rollback does not match the reviewed policy receipt.",
              409,
              "PROSPECT_MESSAGE_POLICY_HASH_MISMATCH"
            );
          }
          const rollbackDefinition =
            getProspectMessageVariantDefinition(
              currentPolicy.release.previousChampionVariantKey
            );
          if (
            !rollbackDefinition ||
            rollbackDefinition.channel !==
              currentPolicy.release.channel
          ) {
            throw new ProspectOutreachRouteError(
              "The rollback target is no longer a registered strategy for this channel.",
              409,
              "PROSPECT_MESSAGE_POLICY_VARIANT_INVALID"
            );
          }
          const release = buildProspectMessagePolicyRelease({
            workspaceId,
            campaignId: currentPolicy.release.campaignId,
            channel: currentPolicy.release.channel,
            version: currentPolicy.release.version + 1,
            action: "ROLLBACK",
            championVariantKey:
              currentPolicy.release.previousChampionVariantKey,
            previousChampionVariantKey:
              currentPolicy.release.championVariantKey,
            sourceCandidate: null,
            rollbackOfReleaseId:
              currentPolicy.release.releaseId,
            reason: parsed.data.reason,
            appliedBy: actor,
            appliedAt,
            attestations: parsed.data.attestations,
            controls: {
              nextExperimentControlOnly: true,
              existingJobsChanged: false,
              contactAuthorized: false,
              executionAuthorized: false,
              spendAuthorized: false,
            },
          });
          const releaseHash =
            hashProspectMessagePolicyValue(release);
          const inserted = await tx<{ id: number }[]>`
            INSERT INTO prospect_message_policy_releases (
              release_id, workspace_id, campaign_id, channel, version,
              action, champion_variant_key,
              previous_champion_variant_key, source_candidate_id,
              rollback_of_release_id, release, release_hash,
              applied_by, applied_at
            ) VALUES (
              ${release.releaseId}, ${workspaceId},
              ${release.campaignId}, ${release.channel},
              ${release.version}, ${release.action},
              ${release.championVariantKey},
              ${release.previousChampionVariantKey}, NULL,
              ${release.rollbackOfReleaseId}, ${tx.json(release)},
              ${releaseHash}, ${release.appliedBy},
              ${release.appliedAt}
            )
            RETURNING id
          `;
          if (inserted.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The policy rollback was not durably recorded.",
              503,
              "PROSPECT_MESSAGE_POLICY_WRITE_FAILED"
            );
          }
          return {
            outcome: "rolled_back" as const,
            release,
            releaseHash,
          };
        });
        return res
          .status(result.outcome === "rolled_back" ? 201 : 200)
          .json({
            ok: true,
            ...result,
            policyChanged: true,
            existingJobsChanged: false,
            externalAction: "none",
            contactAuthorized: false,
            executionAuthorized: false,
            spendAuthorized: false,
          });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/velvet-outcomes/:id/dispatch",
    dashboardAuth,
    requireFullOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
          externalAction: "blocked",
        });
      }
      const outboxId = parsePositiveId(req.params.id);
      const parsed = dispatchVelvetOutcomeSchema.safeParse(req.body);
      if (!outboxId || !parsed.success) {
        return res.status(400).json({
          error:
            "An exact outbox ID, payload hash, and one-event confirmation are required.",
          code: "VELVET_OUTCOME_DISPATCH_INVALID",
          externalAction: "blocked",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = actorForRequest(req);
      const config = readVelvetOutcomeDispatchConfig(env);
      if (!config.enabled) {
        return res.status(409).json({
          error: "Velvet outcome dispatch is disabled.",
          code: "VELVET_OUTCOME_DISPATCH_DISABLED",
          externalAction: "blocked",
        });
      }
      if (!config.configured) {
        return res.status(503).json({
          error: `Velvet outcome dispatch is not configured: ${config.missing.join(", ")}`,
          code: "VELVET_OUTCOME_NOT_CONFIGURED",
          externalAction: "blocked",
        });
      }
      if (config.workspaceId !== workspaceId) {
        return res.status(403).json({
          error:
            "Velvet outcome dispatch is locked to a different workspace.",
          code: "VELVET_OUTCOME_WORKSPACE_MISMATCH",
          externalAction: "blocked",
        });
      }
      const requestedAt = now();
      if (!Number.isFinite(requestedAt.getTime())) {
        return res.status(503).json({
          error: "The Velvet dispatch clock is unavailable.",
          code: "VELVET_OUTCOME_CLOCK_INVALID",
          externalAction: "blocked",
        });
      }
      const requestedAtIso = requestedAt.toISOString();

      try {
        const claim = await sql.begin(async (tx: SqlClient) => {
          await acquireProspectAcquisitionWorkspaceLock(
            tx,
            workspaceId
          );
          const rows = await tx<any[]>`
            SELECT o.id, o.state, o.payload, o.payload_hash, o.attempts,
                   o.last_error, o.dispatch_idempotency_key,
                   o.dispatch_requested_at, o.dispatch_response_at,
                   o.remote_event_id, o.dispatched_at
            FROM velvet_outcome_outbox o
            JOIN prospect_outcome_events e
              ON e.id = o.outcome_event_id
             AND e.workspace_id = o.workspace_id
            JOIN prospect_outreach_jobs j
              ON j.id = e.outreach_job_id
             AND j.workspace_id = o.workspace_id
             AND j.is_seed = FALSE
            WHERE o.id = ${outboxId}
              AND o.workspace_id = ${workspaceId}
            LIMIT 1 FOR UPDATE
          `;
          const row = rows[0];
          if (!row) {
            throw new ProspectOutreachRouteError(
              "Velvet outcome outbox item was not found.",
              404,
              "VELVET_OUTCOME_NOT_FOUND"
            );
          }
          if (row.payload_hash !== parsed.data.payloadHash) {
            throw new ProspectOutreachRouteError(
              "The dispatch request does not match the queued outcome.",
              409,
              "VELVET_OUTCOME_PAYLOAD_MISMATCH"
            );
          }
          const payloadResult = velvetOutcomePayloadSchema.safeParse(
            row.payload
          );
          if (
            !payloadResult.success ||
            payloadResult.data.workspaceId !== workspaceId ||
            hashVelvetOutcomePayload(payloadResult.data) !== row.payload_hash
          ) {
            throw new ProspectOutreachRouteError(
              "The stored Velvet outcome failed its immutable contract check.",
              409,
              "VELVET_OUTCOME_STORED_PAYLOAD_INVALID"
            );
          }
          const payload = payloadResult.data;
          const idempotencyKey = buildVelvetOutcomeIdempotencyKey({
            outboxId,
            payloadHash: row.payload_hash,
          });

          if (
            row.state === "DISPATCHED" &&
            Number.isSafeInteger(Number(row.remote_event_id)) &&
            Number(row.remote_event_id) > 0
          ) {
            return {
              outcome: "duplicate" as const,
              state: "DISPATCHED" as const,
              remoteEventId: Number(row.remote_event_id),
            };
          }
          if (!["PREPARED", "SENDING"].includes(row.state)) {
            throw new ProspectOutreachRouteError(
              `A ${row.state} Velvet outcome cannot be dispatched.`,
              409,
              "VELVET_OUTCOME_STATE_CONFLICT"
            );
          }
          if (row.state === "PREPARED") {
            await assertProspectAcquisitionUnpaused(
              tx,
              workspaceId
            );
          }

          if (row.state === "PREPARED") {
            const updated = await tx<{ id: number }[]>`
              UPDATE velvet_outcome_outbox
              SET state = 'SENDING',
                  dispatch_idempotency_key = ${idempotencyKey},
                  dispatch_requested_by = ${actor},
                  dispatch_requested_at = ${requestedAtIso},
                  dispatch_response_at = NULL,
                  attempts = 1,
                  last_error = NULL,
                  updated_at = ${requestedAtIso}
              WHERE id = ${outboxId}
                AND workspace_id = ${workspaceId}
                AND state = 'PREPARED'
                AND payload_hash = ${parsed.data.payloadHash}
              RETURNING id
            `;
            if (updated.length !== 1) {
              throw new ProspectOutreachRouteError(
                "The Velvet outbox item was not claimed.",
                409,
                "VELVET_OUTCOME_STATE_CONFLICT"
              );
            }
            await appendVelvetDispatchEvent(tx, {
              workspaceId,
              outboxId,
              fromState: "PREPARED",
              toState: "SENDING",
              actor,
              payloadHash: row.payload_hash,
              details: {
                executionMode: "single_event_operator_triggered",
                attempt: 1,
              },
            });
            return {
              outcome: "claimed" as const,
              state: "SENDING" as const,
              payload,
              idempotencyKey,
            };
          }

          const firstRequestedAtMs = safeTimestampMs(
            row.dispatch_requested_at
          );
          const lastResponseAtMs = safeTimestampMs(
            row.dispatch_response_at
          );
          const attempts = Number(row.attempts || 0);
          if (
            row.dispatch_idempotency_key !== idempotencyKey ||
            row.remote_event_id ||
            !firstRequestedAtMs
          ) {
            throw new ProspectOutreachRouteError(
              "The in-flight Velvet callback does not match this outcome.",
              409,
              "VELVET_OUTCOME_IDEMPOTENCY_CONFLICT"
            );
          }
          if (
            (!lastResponseAtMs &&
              requestedAt.getTime() - firstRequestedAtMs < 60_000) ||
            (lastResponseAtMs &&
              requestedAt.getTime() - lastResponseAtMs < 30_000)
          ) {
            throw new ProspectOutreachRouteError(
              "The Velvet callback is still in flight or in retry cooldown.",
              409,
              "VELVET_OUTCOME_REQUEST_IN_FLIGHT"
            );
          }
          if (
            !Number.isSafeInteger(attempts) ||
            attempts < 1 ||
            attempts >= 3
          ) {
            throw new ProspectOutreachRouteError(
              "The maximum of three idempotent Velvet attempts has been reached. Reconcile it manually.",
              409,
              "VELVET_OUTCOME_RECONCILIATION_REQUIRED"
            );
          }
          const updated = await tx<{ id: number }[]>`
            UPDATE velvet_outcome_outbox
            SET dispatch_response_at = NULL,
                attempts = attempts + 1,
                last_error = NULL,
                updated_at = ${requestedAtIso}
            WHERE id = ${outboxId}
              AND workspace_id = ${workspaceId}
              AND state = 'SENDING'
              AND dispatch_idempotency_key = ${idempotencyKey}
              AND attempts = ${attempts}
            RETURNING id
          `;
          if (updated.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The in-flight Velvet outbox item did not change.",
              409,
                "VELVET_OUTCOME_STATE_CONFLICT"
              );
            }
          await appendVelvetDispatchEvent(tx, {
            workspaceId,
            outboxId,
            fromState: "SENDING",
            toState: "SENDING",
            actor,
            payloadHash: row.payload_hash,
            details: {
              executionMode: "same_payload_idempotent_retry",
              attempt: attempts + 1,
            },
          });
          return {
            outcome: "claimed" as const,
            state: "SENDING" as const,
            payload,
            idempotencyKey,
          };
        });

        if (claim.outcome === "duplicate") {
          return res.json({
            ok: true,
            outcome: "duplicate",
            state: claim.state,
            outboxId,
            remoteEventId: claim.remoteEventId,
            externalAction: "none",
          });
        }

        const dispatchResult = await dispatchVelvetOutcome(
          claim.payload,
          config,
          fetchImpl,
          now()
        );
        const respondedAt = now();
        const respondedAtIso = Number.isFinite(respondedAt.getTime())
          ? respondedAt.toISOString()
          : requestedAtIso;
        const finalized = await sql.begin(async (tx: SqlClient) => {
          const rows = await tx<any[]>`
            SELECT id, state, payload_hash, dispatch_idempotency_key,
                   remote_event_id
            FROM velvet_outcome_outbox
            WHERE id = ${outboxId}
              AND workspace_id = ${workspaceId}
            LIMIT 1 FOR UPDATE
          `;
          const row = rows[0];
          if (
            !row ||
            row.payload_hash !== parsed.data.payloadHash ||
            row.dispatch_idempotency_key !== claim.idempotencyKey
          ) {
            throw new ProspectOutreachRouteError(
              "The claimed Velvet outcome changed before finalization.",
              409,
              "VELVET_OUTCOME_IDEMPOTENCY_CONFLICT"
            );
          }

          if (dispatchResult.success) {
            if (row.state === "DISPATCHED") {
              if (
                Number(row.remote_event_id) === dispatchResult.eventId
              ) {
                return {
                  outcome: "duplicate" as const,
                  state: "DISPATCHED" as const,
                  dispatchResult,
                };
              }
              throw new ProspectOutreachRouteError(
                "The remote Velvet event conflicts with the stored receipt.",
                409,
                "VELVET_OUTCOME_REMOTE_ID_CONFLICT"
              );
            }
            const updated = await tx<{ id: number }[]>`
              UPDATE velvet_outcome_outbox
              SET state = 'DISPATCHED',
                  remote_event_id = ${dispatchResult.eventId},
                  dispatch_response_at = ${respondedAtIso},
                  dispatched_at = ${respondedAtIso},
                  last_error = NULL,
                  updated_at = ${respondedAtIso}
              WHERE id = ${outboxId}
                AND workspace_id = ${workspaceId}
                AND state = 'SENDING'
                AND dispatch_idempotency_key = ${claim.idempotencyKey}
              RETURNING id
            `;
            if (updated.length !== 1) {
              throw new ProspectOutreachRouteError(
                "Velvet recorded the outcome but the outbox did not finalize.",
                503,
                "VELVET_OUTCOME_FINALIZATION_FAILED"
              );
            }
            await appendVelvetDispatchEvent(tx, {
              workspaceId,
              outboxId,
              fromState: "SENDING",
              toState: "DISPATCHED",
              actor,
              payloadHash: row.payload_hash,
              details: {
                remoteState: dispatchResult.state,
                remoteEventId: dispatchResult.eventId,
              },
            });
            return {
              outcome: "dispatched" as const,
              state: "DISPATCHED" as const,
              dispatchResult,
            };
          }

          const failureCode = safeProviderFailureCode(
            dispatchResult.code || "VELVET_OUTCOME_DISPATCH_FAILED"
          );
          if (dispatchResult.outcomeUnknown) {
            const updated = await tx<{ id: number }[]>`
              UPDATE velvet_outcome_outbox
              SET dispatch_response_at = ${respondedAtIso},
                  last_error = ${failureCode},
                  updated_at = ${respondedAtIso}
              WHERE id = ${outboxId}
                AND workspace_id = ${workspaceId}
                AND state = 'SENDING'
                AND dispatch_idempotency_key = ${claim.idempotencyKey}
              RETURNING id
            `;
            if (updated.length !== 1) {
              throw new ProspectOutreachRouteError(
                "The uncertain Velvet result was not recorded.",
                503,
                "VELVET_OUTCOME_FINALIZATION_FAILED"
              );
            }
            await appendVelvetDispatchEvent(tx, {
              workspaceId,
              outboxId,
              fromState: "SENDING",
              toState: "SENDING",
              actor,
              payloadHash: row.payload_hash,
              details: {
                outcomeUnknown: true,
                failureCode,
              },
            });
            return {
              outcome: "outcome_unknown" as const,
              state: "SENDING" as const,
              dispatchResult,
            };
          }

          const updated = await tx<{ id: number }[]>`
            UPDATE velvet_outcome_outbox
            SET state = 'FAILED',
                dispatch_response_at = ${respondedAtIso},
                last_error = ${failureCode},
                updated_at = ${respondedAtIso}
            WHERE id = ${outboxId}
              AND workspace_id = ${workspaceId}
              AND state = 'SENDING'
              AND dispatch_idempotency_key = ${claim.idempotencyKey}
            RETURNING id
          `;
          if (updated.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The failed Velvet result was not recorded.",
              503,
              "VELVET_OUTCOME_FINALIZATION_FAILED"
            );
          }
          await appendVelvetDispatchEvent(tx, {
            workspaceId,
            outboxId,
            fromState: "SENDING",
            toState: "FAILED",
            actor,
            payloadHash: row.payload_hash,
            details: {
              outcomeUnknown: false,
              failureCode,
            },
          });
          return {
            outcome: "failed" as const,
            state: "FAILED" as const,
            dispatchResult,
          };
        });

        if (
          finalized.outcome === "dispatched" ||
          finalized.outcome === "duplicate"
        ) {
          return res.json({
            ok: true,
            outcome: finalized.outcome,
            state: finalized.state,
            outboxId,
            remoteState: finalized.dispatchResult.state,
            remoteEventId: finalized.dispatchResult.eventId,
            externalAction: "velvet_outcome_recorded",
          });
        }
        return res
          .status(
            finalized.outcome === "outcome_unknown" ? 503 : 502
          )
          .json({
            error: finalized.dispatchResult.error,
            code: finalized.dispatchResult.code,
            state: finalized.state,
            outboxId,
            retryable:
              finalized.dispatchResult.retryable === true,
            externalAction:
              finalized.outcome === "outcome_unknown"
                ? "velvet_outcome_unknown"
                : "velvet_outcome_failed",
          });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.get(
    "/api/prospecting/email-replies",
    dashboardAuth,
    requireOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
          externalAction: "none",
        });
      }
      const parsedQuery =
        inboundReplyReviewListQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        return res.status(400).json({
          error: "Invalid inbound-reply review filter.",
          code: "PROSPECT_INBOUND_REPLY_REVIEW_FILTER_INVALID",
          externalAction: "none",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const stateFilter =
        parsedQuery.data.state === "all"
          ? "ALL"
          : parsedQuery.data.state === "pending"
            ? "REVIEW_REQUIRED"
            : "PROCESSED";
      try {
        const rows = await sql<{
          id: number;
          provider_event_id: string;
          provider_message_id: string;
          payload_hash: string;
          process_status: string;
          details: unknown;
          received_at: string | Date;
          processed_at: string | Date | null;
        }[]>`
          SELECT e.id, e.provider_event_id, e.provider_message_id,
                 e.payload_hash, e.process_status, e.details,
                 e.received_at, e.processed_at
          FROM prospect_email_provider_events e
          WHERE e.workspace_id = ${workspaceId}
            AND e.provider = 'resend'
            AND e.event_type = 'email.received'
            AND e.details ? 'replyReview'
            AND (
              ${stateFilter} = 'ALL'
              OR e.process_status = ${stateFilter}
            )
          ORDER BY
            CASE WHEN e.process_status = 'REVIEW_REQUIRED'
              THEN 0 ELSE 1 END,
            e.received_at ASC, e.id ASC
          LIMIT 100
        `;
        const reviews = rows.map(row => {
          if (
            row.process_status !== "REVIEW_REQUIRED" &&
            row.process_status !== "PROCESSED"
          ) {
            throw new ProspectOutreachRouteError(
              "An inbound-reply review has an invalid durable state.",
              503,
              "PROSPECT_INBOUND_REPLY_REVIEW_CORRUPT"
            );
          }
          const parsedDetails = parseInboundReplyReviewDetails(
            row.details
          );
          const payload = parsedDetails.payload;
          if (
            payload.workspaceId !== workspaceId ||
            payload.providerEventId !== row.provider_event_id ||
            payload.inboundMessageId !== row.provider_message_id ||
            payload.webhookPayloadHash !== row.payload_hash ||
            (row.process_status === "REVIEW_REQUIRED" &&
              parsedDetails.receipt !== null) ||
            (row.process_status === "PROCESSED" &&
              parsedDetails.receipt === null)
          ) {
            throw new ProspectOutreachRouteError(
              "An inbound-reply review failed its workspace, job, or state binding.",
              503,
              "PROSPECT_INBOUND_REPLY_REVIEW_CORRUPT"
            );
          }
          return {
            reviewId: payload.reviewId,
            state:
              row.process_status === "REVIEW_REQUIRED"
                ? ("PENDING" as const)
                : ("RESOLVED" as const),
            businessName:
              payload.candidates.length === 1
                ? payload.candidates[0].businessName
                : payload.candidates.length === 0
                  ? "Unmatched inbound email"
                  : `${payload.candidates.length} candidate outreach records`,
            payload,
            payloadHash: parsedDetails.payloadHash,
            contentReceipt: parsedDetails.contentReceipt,
            contentReceiptHash: parsedDetails.contentReceiptHash,
            resolutionReceipt: parsedDetails.receipt,
            receivedAt: new Date(row.received_at).toISOString(),
            processedAt: row.processed_at
              ? new Date(row.processed_at).toISOString()
              : null,
          };
        });
        return res.json({
          reviews,
          filter: parsedQuery.data.state,
          controls: {
            humanClassificationRequired: true,
            exactProviderContentRequiredBeforeClassification: true,
            contentRetrievalRequiresFullOperator: true,
            contactAuthorized: false,
            executionAuthorized: false,
            spendAuthorized: false,
            providerRequestAuthorized: false,
          },
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/email-replies/:reviewId/content",
    dashboardAuth,
    requireOperator,
    requireFullOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
          externalAction: "none",
        });
      }
      const receivingConfig = readProspectEmailReceivingConfig(env);
      if (!receivingConfig.enabled) {
        return res.status(503).json({
          error: "Prospect email content retrieval is disabled.",
          code: "PROSPECT_EMAIL_RECEIVING_DISABLED",
          externalAction: "none",
        });
      }
      if (
        !receivingConfig.configured ||
        !receivingConfig.workspaceId
      ) {
        return res.status(503).json({
          error: `Prospect email content retrieval is not configured: ${receivingConfig.missing.join(", ")}`,
          code: "PROSPECT_EMAIL_RECEIVING_NOT_CONFIGURED",
          externalAction: "none",
        });
      }
      const reviewId = parseOpaqueApprovalId(req.params.reviewId);
      const parsed =
        retrieveProspectInboundReplyContentSchema.safeParse(req.body);
      if (!reviewId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid inbound-reply content retrieval request.",
          code: "PROSPECT_INBOUND_REPLY_CONTENT_REQUEST_INVALID",
          issues: parsed.success ? [] : parsed.error.issues,
          externalAction: "none",
        });
      }
      const workspaceId = getWorkspaceId(req);
      if (receivingConfig.workspaceId !== workspaceId) {
        return res.status(403).json({
          error: "Prospect email content retrieval is unavailable for this workspace.",
          code: "PROSPECT_EMAIL_RECEIVING_WORKSPACE_MISMATCH",
          externalAction: "none",
        });
      }
      const retrievedBy = positiveOutcomeReviewerForRequest(req);
      const retrievedAt = now().toISOString();
      let providerReadAttempted = false;
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          await acquireProspectAcquisitionWorkspaceLock(
            tx,
            workspaceId
          );
          const rows = await tx<{
            id: number;
            provider_event_id: string;
            provider_message_id: string;
            event_type: string;
            payload_hash: string;
            process_status: string;
            details: unknown;
          }[]>`
            SELECT e.id, e.provider_event_id, e.provider_message_id,
                   e.event_type, e.payload_hash, e.process_status,
                   e.details
            FROM prospect_email_provider_events e
            WHERE e.workspace_id = ${workspaceId}
              AND e.provider = 'resend'
              AND e.event_type = 'email.received'
              AND e.details->'replyReview'->>'reviewId' = ${reviewId}
            LIMIT 1
            FOR UPDATE
          `;
          const row = rows[0];
          if (!row) {
            throw new ProspectOutreachRouteError(
              "Inbound-reply review not found.",
              404,
              "PROSPECT_INBOUND_REPLY_REVIEW_NOT_FOUND"
            );
          }
          const parsedDetails = parseInboundReplyReviewDetails(
            row.details
          );
          const payload = parsedDetails.payload;
          if (
            payload.reviewId !== reviewId ||
            payload.workspaceId !== workspaceId ||
            payload.providerEventId !== row.provider_event_id ||
            payload.inboundMessageId !== row.provider_message_id ||
            payload.webhookPayloadHash !== row.payload_hash ||
            row.event_type !== "email.received"
          ) {
            throw new ProspectOutreachRouteError(
              "The inbound-reply review failed its workspace or provider binding.",
              409,
              "PROSPECT_INBOUND_REPLY_REVIEW_PAYLOAD_MISMATCH"
            );
          }
          if (parsed.data.payloadHash !== parsedDetails.payloadHash) {
            throw new ProspectOutreachRouteError(
              "The content request does not match the reviewed inbound reply.",
              409,
              "PROSPECT_INBOUND_REPLY_REVIEW_HASH_MISMATCH"
            );
          }
          const requestHash =
            hashProspectInboundReplyContentRequest(parsed.data);
          if (parsedDetails.contentReceipt) {
            if (
              parsedDetails.contentRequestHash === requestHash &&
              parsedDetails.contentReceiptHash
            ) {
              return {
                outcome: "duplicate" as const,
                receipt: parsedDetails.contentReceipt,
                receiptHash: parsedDetails.contentReceiptHash,
              };
            }
            throw new ProspectOutreachRouteError(
              "This inbound email content was already retrieved with a different request.",
              409,
              "PROSPECT_INBOUND_REPLY_CONTENT_CONFLICT"
            );
          }
          if (
            row.process_status !== "REVIEW_REQUIRED" ||
            parsedDetails.receipt
          ) {
            throw new ProspectOutreachRouteError(
              "This inbound reply is not available for content retrieval.",
              409,
              "PROSPECT_INBOUND_REPLY_REVIEW_STATE_CONFLICT"
            );
          }

          providerReadAttempted = true;
          const content = await retrieveProspectReceivedEmail({
            config: receivingConfig,
            inboundMessageId: payload.inboundMessageId,
            expectedSender: payload.sender,
            fetchImpl,
          });
          const receipt = buildProspectInboundReplyContentReceipt({
            reviewId,
            workspaceId,
            providerEventId: payload.providerEventId,
            replyReviewPayloadHash: parsedDetails.payloadHash,
            request: parsed.data,
            content,
            retrievedBy,
            retrievedAt,
          });
          const receiptHash =
            hashProspectInboundReplyContentReceipt(receipt);
          const updated = await tx<{ id: number }[]>`
            UPDATE prospect_email_provider_events
            SET details = ${tx.json({
                  ...parsedDetails.record,
                  action:
                    "inbound_reply_content_retrieved_for_review",
                  replyContentRequestHash: requestHash,
                  replyContentReceipt: receipt,
                  replyContentReceiptHash: receiptHash,
                })},
                updated_at = NOW()
            WHERE id = ${row.id}
              AND workspace_id = ${workspaceId}
              AND process_status = 'REVIEW_REQUIRED'
              AND payload_hash = ${payload.webhookPayloadHash}
              AND NOT (details ? 'replyContentReceipt')
            RETURNING id
          `;
          if (updated.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The inbound-reply content receipt did not change the expected row.",
              409,
              "PROSPECT_INBOUND_REPLY_CONTENT_WRITE_FAILED"
            );
          }
          return {
            outcome: "retrieved" as const,
            receipt,
            receiptHash,
          };
        });
        return res
          .status(result.outcome === "retrieved" ? 201 : 200)
          .json({
            ok: true,
            ...result,
            reviewState: "PENDING",
            controls: {
              providerReadPerformed:
                result.outcome === "retrieved",
              contactAuthorized: false,
              executionAuthorized: false,
              spendAuthorized: false,
              sendAuthorized: false,
            },
            externalAction:
              result.outcome === "retrieved"
                ? "resend_received_email_read"
                : "none",
          });
      } catch (error) {
        if (providerReadAttempted) {
          const status =
            error instanceof ProspectOutreachRouteError
              ? error.status
              : error instanceof ProspectEmailReceivingError
                ? error.status
                : 503;
          const code =
            error instanceof ProspectOutreachRouteError ||
            error instanceof ProspectEmailReceivingError
              ? error.code
              : "PROSPECT_OUTREACH_STORAGE_UNAVAILABLE";
          const message =
            error instanceof Error
              ? error.message
              : "The received email content was read but not durably recorded.";
          return res.status(status).json({
            error: message,
            code,
            externalAction:
              "resend_received_email_read_attempted_without_durable_receipt",
          });
        }
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/email-replies/:reviewId/resolve",
    dashboardAuth,
    requireOperator,
    requireFullOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
          externalAction: "none",
        });
      }
      const reviewId = parseOpaqueApprovalId(req.params.reviewId);
      const parsed = resolveProspectInboundReplySchema.safeParse(
        req.body
      );
      if (!reviewId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid inbound-reply resolution.",
          code: "PROSPECT_INBOUND_REPLY_RESOLUTION_INVALID",
          issues: parsed.success ? [] : parsed.error.issues,
          externalAction: "none",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const reviewer = positiveOutcomeReviewerForRequest(req);
      const resolvedAt = now().toISOString();
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          await acquireProspectAcquisitionWorkspaceLock(
            tx,
            workspaceId
          );
          const rows = await tx<{
            id: number;
            provider_event_id: string;
            provider_message_id: string;
            event_type: string;
            payload_hash: string;
            process_status: string;
            details: unknown;
          }[]>`
            SELECT e.id, e.provider_event_id, e.provider_message_id,
                   e.event_type, e.payload_hash, e.process_status,
                   e.details
            FROM prospect_email_provider_events e
            WHERE e.workspace_id = ${workspaceId}
              AND e.provider = 'resend'
              AND e.event_type = 'email.received'
              AND e.details->'replyReview'->>'reviewId' = ${reviewId}
            LIMIT 1
            FOR UPDATE
          `;
          const row = rows[0];
          if (!row) {
            throw new ProspectOutreachRouteError(
              "Inbound-reply review not found.",
              404,
              "PROSPECT_INBOUND_REPLY_REVIEW_NOT_FOUND"
            );
          }
          const parsedDetails = parseInboundReplyReviewDetails(
            row.details
          );
          const payload = parsedDetails.payload;
          if (
            payload.reviewId !== reviewId ||
            payload.workspaceId !== workspaceId ||
            payload.providerEventId !== row.provider_event_id ||
            payload.inboundMessageId !== row.provider_message_id ||
            payload.webhookPayloadHash !== row.payload_hash ||
            row.event_type !== "email.received"
          ) {
            throw new ProspectOutreachRouteError(
              "The inbound-reply review failed its workspace or outreach binding.",
              409,
              "PROSPECT_INBOUND_REPLY_REVIEW_PAYLOAD_MISMATCH"
            );
          }
          if (parsed.data.payloadHash !== parsedDetails.payloadHash) {
            throw new ProspectOutreachRouteError(
              "The resolution does not match the reviewed inbound reply.",
              409,
              "PROSPECT_INBOUND_REPLY_REVIEW_HASH_MISMATCH"
            );
          }
          if (
            !parsedDetails.contentReceipt ||
            !parsedDetails.contentReceiptHash
          ) {
            throw new ProspectOutreachRouteError(
              "Retrieve and review the exact provider-backed plain text before classifying this inbound reply.",
              409,
              "PROSPECT_INBOUND_REPLY_CONTENT_REQUIRED"
            );
          }
          if (
            parsed.data.contentReceiptHash !==
            parsedDetails.contentReceiptHash
          ) {
            throw new ProspectOutreachRouteError(
              "The resolution does not match the retrieved inbound email content.",
              409,
              "PROSPECT_INBOUND_REPLY_CONTENT_HASH_MISMATCH"
            );
          }
          const requestHash =
            hashProspectInboundReplyResolutionRequest(parsed.data);
          if (row.process_status === "PROCESSED") {
            if (
              parsedDetails.receipt &&
              parsedDetails.requestHash === requestHash &&
              parsedDetails.receiptHash
            ) {
              return {
                outcome: "duplicate" as const,
                receipt: parsedDetails.receipt,
                receiptHash: parsedDetails.receiptHash,
                positiveReviewId: null,
              };
            }
            throw new ProspectOutreachRouteError(
              "This inbound reply was already resolved with a different decision.",
              409,
              "PROSPECT_INBOUND_REPLY_RESOLUTION_CONFLICT"
            );
          }
          if (
            row.process_status !== "REVIEW_REQUIRED" ||
            parsedDetails.receipt
          ) {
            throw new ProspectOutreachRouteError(
              "This inbound reply is not available for resolution.",
              409,
              "PROSPECT_INBOUND_REPLY_REVIEW_STATE_CONFLICT"
            );
          }

          const selectedCandidate =
            parsed.data.selectedOutreachApprovalId
              ? payload.candidates.find(
                  candidate =>
                    candidate.outreachApprovalId ===
                    parsed.data.selectedOutreachApprovalId
                )
              : undefined;
          if (
            (parsed.data.selectedOutreachApprovalId !== undefined &&
              !selectedCandidate) ||
            (parsed.data.resolution === "reply" &&
              !selectedCandidate) ||
            (parsed.data.resolution === "opt_out" &&
              payload.candidates.length > 0 &&
              !selectedCandidate)
          ) {
            throw new ProspectOutreachRouteError(
              "The selected outreach record is not an immutable candidate for this reply.",
              409,
              "PROSPECT_INBOUND_REPLY_CANDIDATE_MISMATCH"
            );
          }
          if (selectedCandidate) {
            const selectedRows = await tx<{
              id: number;
              lead_id: number;
              approval_id: string;
              recipient: string;
              state: string;
              channel: string;
              is_seed: boolean;
              sent_at: string | Date;
            }[]>`
              SELECT id, lead_id, approval_id, recipient, state,
                     channel, is_seed, sent_at
              FROM prospect_outreach_jobs
              WHERE id = ${selectedCandidate.outreachJobId}
                AND workspace_id = ${workspaceId}
                AND lead_id = ${selectedCandidate.prospectId}
                AND approval_id = ${selectedCandidate.outreachApprovalId}
              LIMIT 1
              FOR UPDATE
            `;
            const selectedRow = selectedRows[0];
            if (
              !selectedRow ||
              selectedRow.channel !== "email" ||
              selectedRow.state !== "SENT" ||
              selectedRow.is_seed ||
              String(selectedRow.recipient).toLowerCase() !==
                payload.sender ||
              new Date(selectedRow.sent_at).toISOString() !==
                selectedCandidate.sentAt
            ) {
              throw new ProspectOutreachRouteError(
                "The selected outreach record changed after reply review preparation.",
                409,
                "PROSPECT_INBOUND_REPLY_CANDIDATE_CHANGED"
              );
            }
          }

          let resultingOutcome: "replied" | "dnc" | null = null;
          let positiveReviewId: string | null = null;
          if (parsed.data.resolution === "opt_out") {
            await upsertProspectEmailSuppression(tx, {
              workspaceId,
              email: payload.sender,
              reason: "recipient_opt_out",
              source: "human_reviewed_inbound_reply",
              recordedBy: reviewer,
            });
            resultingOutcome = selectedCandidate ? "dnc" : null;
          } else if (parsed.data.resolution === "reply") {
            resultingOutcome = "replied";
          }

          if (resultingOutcome) {
            const outcomeResult =
              await recordProspectOutcomeTransaction(tx, {
                workspaceId,
                leadId: selectedCandidate!.prospectId,
                source: "resend_webhook",
                actor: reviewer,
                externalEventId:
                  inboundReplyOutcomeExternalEventId(
                    payload.providerEventId
                  ),
                outcome: resultingOutcome,
                occurredAt: payload.occurredAt,
                outreachApprovalId:
                  selectedCandidate!.outreachApprovalId,
                notes:
                  parsed.data.resolution === "opt_out"
                    ? `Human-verified recipient opt-out: ${parsed.data.notes}`
                    : `Human-verified inbound reply: ${parsed.data.notes}`,
              });
            positiveReviewId =
              "positiveReviewId" in outcomeResult
                ? outcomeResult.positiveReviewId
                : null;
          }

          const receipt =
            buildProspectInboundReplyResolutionReceipt({
              reviewId,
              resolution: parsed.data,
              resultingOutcome,
              suppressionRecorded:
                parsed.data.resolution === "opt_out",
              resolvedBy: reviewer,
              resolvedAt,
            });
          const receiptHash =
            hashProspectInboundReplyResolutionReceipt(receipt);
          const updated = await tx<{ id: number }[]>`
            UPDATE prospect_email_provider_events
            SET process_status = 'PROCESSED',
                outreach_job_id = COALESCE(
                  ${selectedCandidate?.outreachJobId || null},
                  outreach_job_id
                ),
                details = ${tx.json({
                  ...parsedDetails.record,
                  action: "inbound_reply_human_resolved",
                  replyResolutionRequestHash: requestHash,
                  replyResolutionReceipt: receipt,
                  replyResolutionReceiptHash: receiptHash,
                })},
                processed_at = ${resolvedAt},
                updated_at = NOW()
            WHERE id = ${row.id}
              AND workspace_id = ${workspaceId}
              AND process_status = 'REVIEW_REQUIRED'
              AND payload_hash = ${parsedDetails.payload.webhookPayloadHash}
              AND details->>'replyContentReceiptHash' =
                ${parsedDetails.contentReceiptHash}
            RETURNING id
          `;
          if (updated.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The inbound-reply resolution did not change the expected receipt.",
              409,
              "PROSPECT_INBOUND_REPLY_RESOLUTION_WRITE_FAILED"
            );
          }
          return {
            outcome: "resolved" as const,
            receipt,
            receiptHash,
            positiveReviewId,
          };
        });
        return res
          .status(result.outcome === "resolved" ? 201 : 200)
          .json({
            ok: true,
            ...result,
            reviewState: "RESOLVED",
            controls: {
              contactAuthorized: false,
              executionAuthorized: false,
              spendAuthorized: false,
              providerRequestAuthorized: false,
            },
            externalAction: "none",
          });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.get(
    "/api/prospecting/positive-outcomes",
    dashboardAuth,
    requireOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
          externalAction: "none",
        });
      }
      const parsedQuery =
        positiveOutcomeReviewListQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        return res.status(400).json({
          error: "Invalid positive-outcome review filter.",
          code: "PROSPECT_POSITIVE_OUTCOME_REVIEW_FILTER_INVALID",
          externalAction: "none",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const stateFilter =
        parsedQuery.data.state === "all"
          ? "ALL"
          : parsedQuery.data.state.toUpperCase();
      try {
        const rows = await sql<{
          review_id: string;
          state: "PENDING" | "ACKNOWLEDGED";
          payload: unknown;
          payload_hash: string;
          acknowledgment_receipt: unknown | null;
          acknowledgment_receipt_hash: string | null;
          acknowledged_by: string | null;
          acknowledged_at: string | Date | null;
          created_at: string | Date;
          updated_at: string | Date;
        }[]>`
          SELECT review_id, state, payload, payload_hash,
                 acknowledgment_receipt,
                 acknowledgment_receipt_hash, acknowledged_by,
                 acknowledged_at, created_at, updated_at
          FROM prospect_positive_outcome_reviews
          WHERE workspace_id = ${workspaceId}
            AND (
              ${stateFilter} = 'ALL' OR state = ${stateFilter}
            )
          ORDER BY
            CASE WHEN state = 'PENDING' THEN 0 ELSE 1 END,
            created_at ASC
          LIMIT 100
        `;
        const reviews = rows.map(row => {
          const payload =
            prospectPositiveOutcomeReviewPayloadSchema.safeParse(
              parseStoredJson(row.payload)
            );
          if (
            !payload.success ||
            payload.data.reviewId !== row.review_id ||
            payload.data.workspaceId !== workspaceId ||
            hashProspectPositiveOutcomeReviewPayload(
              payload.data
            ) !== row.payload_hash
          ) {
            throw new ProspectOutreachRouteError(
              "A positive-outcome review failed its immutable payload check.",
              503,
              "PROSPECT_POSITIVE_OUTCOME_REVIEW_CORRUPT"
            );
          }
          let acknowledgmentReceipt = null;
          if (row.state === "ACKNOWLEDGED") {
            const receipt =
              prospectPositiveOutcomeAcknowledgmentReceiptSchema.safeParse(
                parseStoredJson(row.acknowledgment_receipt)
              );
            if (
              !receipt.success ||
              receipt.data.reviewId !== row.review_id ||
              receipt.data.payloadHash !== row.payload_hash ||
              !row.acknowledgment_receipt_hash ||
              hashProspectPositiveOutcomeAcknowledgmentReceipt(
                receipt.data
              ) !== row.acknowledgment_receipt_hash
            ) {
              throw new ProspectOutreachRouteError(
                "A positive-outcome acknowledgment failed its receipt check.",
                503,
                "PROSPECT_POSITIVE_OUTCOME_ACKNOWLEDGMENT_CORRUPT"
              );
            }
            acknowledgmentReceipt = receipt.data;
          }
          return {
            reviewId: row.review_id,
            state: row.state,
            payload: payload.data,
            payloadHash: row.payload_hash,
            acknowledgmentReceipt,
            acknowledgedBy: row.acknowledged_by,
            acknowledgedAt: row.acknowledged_at
              ? new Date(row.acknowledged_at).toISOString()
              : null,
            createdAt: new Date(row.created_at).toISOString(),
            updatedAt: new Date(row.updated_at).toISOString(),
          };
        });
        return res.json({
          reviews,
          filter: parsedQuery.data.state,
          controls: {
            humanAcknowledgmentRequired: true,
            contactAuthorized: false,
            executionAuthorized: false,
            spendAuthorized: false,
            policyMutationAuthorized: false,
            providerRequestAuthorized: false,
          },
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/positive-outcomes/:reviewId/acknowledge",
    dashboardAuth,
    requireOperator,
    requireFullOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
          externalAction: "none",
        });
      }
      const reviewId = parseOpaqueApprovalId(req.params.reviewId);
      const parsed =
        acknowledgeProspectPositiveOutcomeSchema.safeParse(req.body);
      if (!reviewId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid positive-outcome acknowledgment.",
          code: "PROSPECT_POSITIVE_OUTCOME_ACKNOWLEDGMENT_INVALID",
          issues: parsed.success ? [] : parsed.error.issues,
          externalAction: "none",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const reviewer = positiveOutcomeReviewerForRequest(req);
      const acknowledgedAt = now().toISOString();
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          await acquireProspectAcquisitionWorkspaceLock(
            tx,
            workspaceId
          );
          const rows = await tx<{
            id: number;
            state: "PENDING" | "ACKNOWLEDGED";
            payload: unknown;
            payload_hash: string;
            acknowledgment_request_hash: string | null;
            acknowledgment_receipt: unknown | null;
            acknowledgment_receipt_hash: string | null;
          }[]>`
            SELECT id, state, payload, payload_hash,
                   acknowledgment_request_hash,
                   acknowledgment_receipt,
                   acknowledgment_receipt_hash
            FROM prospect_positive_outcome_reviews
            WHERE review_id = ${reviewId}
              AND workspace_id = ${workspaceId}
            LIMIT 1
            FOR UPDATE
          `;
          const row = rows[0];
          if (!row) {
            throw new ProspectOutreachRouteError(
              "Positive-outcome review not found.",
              404,
              "PROSPECT_POSITIVE_OUTCOME_REVIEW_NOT_FOUND"
            );
          }
          const payload =
            prospectPositiveOutcomeReviewPayloadSchema.safeParse(
              parseStoredJson(row.payload)
            );
          if (
            !payload.success ||
            payload.data.reviewId !== reviewId ||
            payload.data.workspaceId !== workspaceId ||
            hashProspectPositiveOutcomeReviewPayload(
              payload.data
            ) !== row.payload_hash
          ) {
            throw new ProspectOutreachRouteError(
              "The positive-outcome review failed its immutable payload check.",
              409,
              "PROSPECT_POSITIVE_OUTCOME_REVIEW_PAYLOAD_MISMATCH"
            );
          }
          if (parsed.data.payloadHash !== row.payload_hash) {
            throw new ProspectOutreachRouteError(
              "The acknowledgment does not match the reviewed outcome payload.",
              409,
              "PROSPECT_POSITIVE_OUTCOME_REVIEW_HASH_MISMATCH"
            );
          }
          const requestHash =
            hashProspectPositiveOutcomeAcknowledgmentRequest(
              parsed.data
            );
          if (row.state === "ACKNOWLEDGED") {
            const existing =
              prospectPositiveOutcomeAcknowledgmentReceiptSchema.safeParse(
                parseStoredJson(row.acknowledgment_receipt)
              );
            if (
              existing.success &&
              row.acknowledgment_request_hash === requestHash &&
              row.acknowledgment_receipt_hash &&
              hashProspectPositiveOutcomeAcknowledgmentReceipt(
                existing.data
              ) === row.acknowledgment_receipt_hash
            ) {
              return {
                outcome: "duplicate" as const,
                receipt: existing.data,
                receiptHash: row.acknowledgment_receipt_hash,
              };
            }
            throw new ProspectOutreachRouteError(
              "This positive outcome was already acknowledged with a different decision.",
              409,
              "PROSPECT_POSITIVE_OUTCOME_ACKNOWLEDGMENT_CONFLICT"
            );
          }
          const receipt =
            buildProspectPositiveOutcomeAcknowledgmentReceipt({
              reviewId,
              acknowledgment: parsed.data,
              acknowledgedBy: reviewer,
              acknowledgedAt,
            });
          const receiptHash =
            hashProspectPositiveOutcomeAcknowledgmentReceipt(
              receipt
            );
          const updated = await tx<{ id: number }[]>`
            UPDATE prospect_positive_outcome_reviews
            SET state = 'ACKNOWLEDGED',
                acknowledgment_request = ${tx.json(parsed.data)},
                acknowledgment_request_hash = ${requestHash},
                acknowledgment_receipt = ${tx.json(receipt)},
                acknowledgment_receipt_hash = ${receiptHash},
                acknowledged_by = ${reviewer},
                acknowledged_at = ${acknowledgedAt},
                updated_at = NOW()
            WHERE id = ${row.id}
              AND workspace_id = ${workspaceId}
              AND state = 'PENDING'
              AND payload_hash = ${parsed.data.payloadHash}
            RETURNING id
          `;
          if (updated.length !== 1) {
            throw new ProspectOutreachRouteError(
              "The positive-outcome acknowledgment did not change the expected row.",
              409,
              "PROSPECT_POSITIVE_OUTCOME_ACKNOWLEDGMENT_WRITE_FAILED"
            );
          }
          await appendPositiveOutcomeReviewEvent(tx, {
            workspaceId,
            reviewRowId: row.id,
            fromState: "PENDING",
            toState: "ACKNOWLEDGED",
            actor: reviewer,
            receiptHash,
            details: {
              resolution: parsed.data.resolution,
              externalAction: "none",
              contactAuthorized: false,
              executionAuthorized: false,
              spendAuthorized: false,
              policyMutationAuthorized: false,
              providerRequestAuthorized: false,
            },
          });
          return {
            outcome: "acknowledged" as const,
            receipt,
            receiptHash,
          };
        });
        return res
          .status(result.outcome === "acknowledged" ? 201 : 200)
          .json({
            ok: true,
            ...result,
            reviewState: "ACKNOWLEDGED",
            controls: {
              contactAuthorized: false,
              executionAuthorized: false,
              spendAuthorized: false,
              policyMutationAuthorized: false,
              providerRequestAuthorized: false,
            },
            externalAction: "none",
          });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/leads/:id/outcomes",
    dashboardAuth,
    requireOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
        });
      }
      const leadId = parsePositiveId(req.params.id);
      const parsed = prospectOutcomeSchema.safeParse(req.body);
      if (!leadId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid prospect outcome.",
          code: "PROSPECT_OUTCOME_INVALID",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = actorForRequest(req);
      try {
        const result = await sql.begin((tx: SqlClient) =>
          recordProspectOutcomeTransaction(tx, {
            workspaceId,
            leadId,
            source: "operator",
            actor,
            externalEventId: parsed.data.externalEventId,
            outcome: parsed.data.outcome,
            occurredAt: parsed.data.occurredAt,
            outreachApprovalId: parsed.data.outreachApprovalId,
            notes: parsed.data.notes,
          })
        );
        return res.status(result.outcome === "recorded" ? 201 : 200).json({
          ok: true,
          ...result,
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );
}
