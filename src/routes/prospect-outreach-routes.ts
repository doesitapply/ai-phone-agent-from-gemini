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
  prepareProspectOutreachSchema,
  prospectOutreachApprovalSchema,
  prospectOutreachPayloadSchema,
  prospectOutcomeSchema,
  selectCanonicalProspectOutcomeEvent,
  type ProspectOutcome,
} from "../prospect-outreach.js";
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
  VELVET_OUTCOME_DISPATCH_CONFIRMATION,
  buildVelvetOutcomePayload,
  buildVelvetOutcomeIdempotencyKey,
  dispatchVelvetOutcome,
  hashVelvetOutcomePayload,
  readVelvetOutcomeDispatchConfig,
  velvetOutcomePayloadSchema,
} from "../velvet-outcome.js";
import {
  buildProspectLearningScorecard,
  evaluateProspectLearningCandidate,
  learningOutcomeSchema,
  type LearningObservation,
} from "../prospect-learning.js";
import {
  PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION,
  buildProspectMessageContext,
  findMatchingProspectMessageVariant,
  getProspectMessageVariantDefinition,
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
  PROSPECT_MESSAGE_EXPERIMENT_STUDY_DESIGN,
  buildProspectMessageExperimentAssignment,
  buildProspectMessageExperimentDefinition,
  getProspectMessageExperimentCohortEntry,
  getProspectMessageExperimentStudyDesign,
  hashProspectMessageExperimentDefinition,
  prospectMessageExperimentAssignmentSchema,
  prospectMessageExperimentDefinitionSchema,
  verifyProspectMessageExperimentAssignment,
  type ProspectMessageExperimentDefinition,
} from "../prospect-message-experiments.js";
import { loadPassingProspectInboxPlacementProof } from "../prospect-inbox-placement-store.js";
import { SMIRK_INTERNAL_INBOX_SEED_SOURCE } from "../prospect-inbox-placement.js";

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
};

type ProspectMessageExperimentArmStats = {
  assigned: number;
  executed: number;
  measured: number;
  outcomeEvents: number;
};

type ProspectMessageExperimentEvidence = {
  observations: LearningObservation[];
  armStats: {
    control: ProspectMessageExperimentArmStats;
    challenger: ProspectMessageExperimentArmStats;
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
  })
  .passthrough();

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
  })
  .passthrough();

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

function actorForRequest(req: Request): string {
  return (req as any).authMode === "operator"
    ? "dashboard_operator"
    : "unknown_operator";
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

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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

function emptyExperimentArmStats(): ProspectMessageExperimentArmStats {
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
      "The experiment cohort contains an invalid outcome timestamp.",
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
        };
      }
    }
    throw new ProspectOutreachRouteError(
      "The outcome event conflicted with an existing record.",
      409,
      "PROSPECT_OUTCOME_WRITE_CONFLICT"
    );
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
      const externalEventId = `resend:${createHash("sha256")
        .update(verified.eventId)
        .digest("hex")
        .slice(0, 32)}`;

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
          }[]>`
            SELECT id, lead_id, approval_id, is_seed
            FROM prospect_outreach_jobs
            WHERE workspace_id = ${workspaceId}
              AND channel = 'email'
              AND provider_name = 'resend'
              AND state = 'SENT'
              AND LOWER(recipient) = ${classification.sender}
              AND sent_at >= ${replyWindowStart}
              AND sent_at <= ${classification.occurredAt}
            ORDER BY sent_at DESC
            LIMIT 2
            FOR UPDATE
          `;
          if (jobRows.length !== 1) {
            await updateReceipt({
              status: "REVIEW_REQUIRED",
              details: {
                reason:
                  jobRows.length === 0
                    ? "no_unique_recent_outreach"
                    : "ambiguous_recent_outreach",
                candidateCount: jobRows.length,
              },
            });
            return {
              outcome: "review_required" as const,
              status: "REVIEW_REQUIRED" as const,
            };
          }
          const job = jobRows[0];
          if (job.is_seed) {
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
          const outcomeResult = await recordProspectOutcomeTransaction(
            tx,
            {
              workspaceId,
              leadId: job.lead_id,
              source: "resend_webhook",
              actor: "resend_webhook",
              externalEventId,
              outcome: "replied",
              occurredAt: classification.occurredAt,
              outreachApprovalId: job.approval_id,
              notes: "Signed Resend inbound reply event.",
            }
          );
          await updateReceipt({
            status: "PROCESSED",
            jobId: job.id,
            details: {
              action: "reply_recorded",
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
          SELECT id, experiment_id, workspace_id, campaign_id, channel,
                 state, control_variant_key, challenger_variant_key,
                 allocation_basis_points, definition, definition_hash,
                 prepared_by, activated_by, activated_at, closed_by,
                 closed_at, inbox_placement_test_id,
                 inbox_placement_receipt_hash, created_at, updated_at
          FROM prospect_message_experiments
          WHERE workspace_id = ${workspaceId}
          ORDER BY created_at DESC
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
    "/api/prospecting/learning/experiments/:experimentId/close",
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
          const pendingRows = await tx<{ pending_count: number | string }[]>`
            SELECT COUNT(*)::int AS pending_count
            FROM prospect_outreach_jobs
            WHERE workspace_id = ${workspaceId}
              AND payload->'experimentAssignment'->>'experimentId'
                = ${row.experiment_id}
              AND state IN ('PREPARED', 'APPROVED', 'SENDING')
          `;
          const pendingCount = Number(
            pendingRows[0]?.pending_count || 0
          );
          if (!Number.isSafeInteger(pendingCount) || pendingCount > 0) {
            throw new ProspectOutreachRouteError(
              "Resolve or cancel every prepared, approved, or sending experiment job before closure.",
              409,
              "PROSPECT_MESSAGE_EXPERIMENT_JOBS_NOT_TERMINAL"
            );
          }
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
              externalAction: "none",
              contactAuthorized: false,
              spendAuthorized: false,
            },
          });
          return { outcome: "closed" as const, row };
        });
        return res.json({
          ok: true,
          outcome: result.outcome,
          state: "CLOSED",
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
      const actor = actorForRequest(req);
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          const lead = await requireProspect(tx, workspaceId, leadId, true);
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
            parsed.data.channel === "email" &&
            lead.email_verification !== "verified_owner_email"
          ) {
            throw new ProspectOutreachRouteError(
              "A Velvet-verified owner email is required before email outreach can be prepared.",
              409,
              "PROSPECT_OUTREACH_VERIFIED_EMAIL_REQUIRED"
            );
          }
          if (
            parsed.data.channel === "call" &&
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
              parsed.data.channel,
              parsed.data.channel === "email" ? lead.email : lead.phone
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
            parsed.data.channel === "email"
              ? parsed.data.body
              : parsed.data.callBrief;
          const matchedVariant = findMatchingProspectMessageVariant({
            channel: parsed.data.channel,
            subject:
              parsed.data.channel === "email"
                ? parsed.data.subject
                : undefined,
            content: draftContent,
            context: messageContext,
          });
          const attributedVariantKey =
            matchedVariant?.key ||
            `operator-custom-${canonicalJsonHash({
              channel: parsed.data.channel,
              subject:
                parsed.data.channel === "email"
                  ? parsed.data.subject.trim()
                  : null,
              content: draftContent.trim(),
            }).slice(0, 16)}`;
          const attributedDraft = {
            ...parsed.data,
            variantKey: attributedVariantKey,
          };
          const activeExperiment = await loadActiveMessageExperiment(tx, {
            workspaceId,
            campaignId: lead.campaign_id,
            channel: parsed.data.channel,
          });
          const reservedByOtherChannel =
            (
              await loadActiveFrozenCohortReservations(tx, {
                workspaceId,
                campaignId: lead.campaign_id,
              })
            ).find(
              reservation =>
                reservation.definition.channel !==
                  parsed.data.channel &&
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
              assignedDefinition.channel !== parsed.data.channel
            ) {
              throw new ProspectOutreachRouteError(
                "The active experiment references a strategy that is no longer registered for this channel.",
                409,
                "PROSPECT_MESSAGE_EXPERIMENT_VARIANT_INVALID"
              );
            }
          }
          let payload;
          try {
            payload = buildProspectOutreachPayload({
              workspaceId,
              campaignId: lead.campaign_id,
              prospectId: lead.id,
              recipient,
              evidenceHash,
              preparedAt: new Date().toISOString(),
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
            workspaceId,
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
              approval_id: string;
              state: string;
              payload_hash: string;
              variant_key: string;
              payload: unknown;
            }[]>`
              SELECT approval_id, state, payload_hash, variant_key, payload
              FROM prospect_outreach_jobs
              WHERE workspace_id = ${workspaceId}
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
              return {
                outcome: "duplicate" as const,
                approvalId: enrollmentRows[0].approval_id,
                state: enrollmentRows[0].state,
                payloadHash: enrollmentRows[0].payload_hash,
                variantKey: enrollmentRows[0].variant_key,
                experimentAssignment: storedAssignment,
              };
            }
          }

          const existingRows = await tx<{
            approval_id: string;
            state: string;
            payload_hash: string;
            variant_key: string;
          }[]>`
            SELECT approval_id, state, payload_hash, variant_key
            FROM prospect_outreach_jobs
            WHERE workspace_id = ${workspaceId}
              AND lead_id = ${lead.id}
              AND draft_fingerprint = ${draftFingerprint}
              AND state IN ('PREPARED', 'APPROVED', 'SENDING')
            LIMIT 1
            FOR UPDATE
          `;
          if (existingRows[0]) {
            return {
              outcome: "duplicate" as const,
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
              ${approvalId}, ${workspaceId}, ${lead.campaign_id}, ${lead.id},
              ${payload.channel}, 'PREPARED', ${payload.recipient},
              ${payload.subject || null}, ${payload.content},
              ${PROSPECT_OUTREACH_CONTRACT_VERSION}, ${evidenceHash},
              ${payload.variantKey}, ${draftFingerprint}, ${tx.json(payload)}, ${payloadHash},
              ${payload.maxCostCents}, ${actor}, ${payload.expiresAt}
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
            workspaceId,
            jobId: rows[0].id,
            fromState: null,
            toState: "PREPARED",
            actor,
            payloadHash,
            details: {
              externalAction: "none",
              requestedVariantKey: parsed.data.variantKey,
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
          return {
            outcome: "created" as const,
            approvalId,
            state: "PREPARED",
            payloadHash,
            variantKey: payload.variantKey,
            experimentAssignment,
          };
        });
        return res.status(result.outcome === "created" ? 201 : 200).json({
          ok: true,
          ...result,
          externalAction: "none",
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
      if (!dbEnabled) return res.json({ jobs: [], outcomes: [] });
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
                 sent_at, provider_name, provider_idempotency_key,
                 provider_message_id, provider_cost_cents,
                 provider_requested_at, provider_response_at,
                 provider_attempts, execution_proof_reference, failure_code,
                 created_at, updated_at
          FROM prospect_outreach_jobs
          WHERE workspace_id = ${workspaceId} AND lead_id = ${leadId}
          ORDER BY created_at DESC
        `;
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
        return res.json({
          jobs: rows,
          outcomes,
          experimentAssignments,
          emailProvider: publicEmailProviderConfig(
            readProspectEmailProviderConfig(env),
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
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          const rows = await tx<any[]>`
            SELECT id, state, channel, payload, payload_hash, expires_at
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
          try {
            assertProspectOutreachApprovalAttestations(
              job.channel,
              parsed.data,
              storedPayload.data.qcReceipt
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
          if (new Date(job.expires_at).getTime() <= Date.now()) {
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
          const updated = await tx<{ id: number }[]>`
            UPDATE prospect_outreach_jobs
            SET state = 'APPROVED', approved_by = ${actor},
                approved_at = NOW(),
                approval_attestations = ${tx.json(parsed.data.attestations)},
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
            details: { attestations: parsed.data.attestations },
          });
          return { outcome: "approved" as const, state: "APPROVED" };
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
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          const rows = await tx<any[]>`
            SELECT j.id, j.state, j.channel, j.recipient, j.payload_hash,
                   j.approved_at, j.approval_attestations, j.expires_at,
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
          let currentPhone: string;
          try {
            currentPhone = normalizeProspectOutreachRecipient(
              "call",
              job.current_phone
            );
            const storedApproval = prospectOutreachApprovalSchema.parse({
              payloadHash: job.payload_hash,
              attestations: job.approval_attestations,
            });
            assertProspectOutreachApprovalAttestations(
              "call",
              storedApproval
            );
          } catch {
            throw new ProspectOutreachRouteError(
              "The manual call recipient or persisted call attestations are invalid.",
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
            },
          });
          return { outcome: "recorded" as const, state: "SENT" };
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
          // Serialize cap reservations across different jobs in this workspace.
          await tx`
            SELECT pg_advisory_xact_lock(
              1953655115,
              ${workspaceId}
            )
          `;
          const rows = await tx<any[]>`
            SELECT j.id, j.state, j.channel, j.lead_id, j.recipient,
                   j.payload, j.payload_hash, j.max_cost_cents,
                   j.approved_at, j.approval_attestations, j.expires_at,
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
            parsedPayload.data.channel !== "email" ||
            parsedPayload.data.workspaceId !== workspaceId ||
            parsedPayload.data.prospectId !== job.lead_id ||
            parsedPayload.data.recipient !== job.recipient ||
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
          if (!["APPROVED", "SENDING"].includes(job.state)) {
            throw new ProspectOutreachRouteError(
              `A ${job.state} outreach job cannot execute through the email provider.`,
              409,
              "PROSPECT_OUTREACH_STATE_CONFLICT"
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
              storedApproval
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
              AND c.proposal->>'channel' = e.channel
              AND c.proposal->>'replaceVariant' =
                e.control_variant_key
              AND c.proposal->>'promoteVariant' =
                e.challenger_variant_key
              AND c.evidence->'current'->>'variantKey' =
                e.control_variant_key
              AND c.evidence->'challenger'->>'variantKey' =
                e.challenger_variant_key
              AND c.evidence->>'executedProtocolDeviationCount' = '0'
            ) AS recommendation_eligible
          FROM prospect_learning_candidates c
          LEFT JOIN prospect_message_experiments e
            ON e.workspace_id = c.workspace_id
           AND e.experiment_id = c.proposal->>'experimentId'
          WHERE c.workspace_id = ${getWorkspaceId(req)}
          ORDER BY c.generated_at DESC
          LIMIT 100
        `;
        return res.json({ candidates: rows, policyChanged: false });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/learning/candidates",
    dashboardAuth,
    requireOperator,
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
          const evaluation = evaluateProspectLearningCandidate({
            channel: definition.channel,
            currentVariant: definition.controlVariantKey,
            challengerVariant: definition.challengerVariantKey,
            observations: cohort.observations,
          });
          if (evaluation.ready === false) {
            throw new ProspectOutreachRouteError(
              evaluation.code === "INSUFFICIENT_SAMPLE"
                ? "Both assigned arms need at least 10 executed, protocol-compliant outreach jobs with measured outcomes."
                : "The assigned challenger cohort has no measured positive lift.",
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
                ? "Frozen operator-qualified population with deterministic balanced cohort selection and assignment. Per-recipient approval and execution attrition remain human-controlled, so this is a recommendation, not an autonomous policy change or a fully randomized market estimate."
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
            "Decision recorded. Runtime outreach policy is unchanged until a separately reviewed code/config release.",
          externalAction: "none",
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
