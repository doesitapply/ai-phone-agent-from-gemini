import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PROSPECT_REVENUE_LOOP_CONTRACT_VERSION,
  type ProspectRevenueLoopStatus,
} from "./prospect-revenue-loop.js";

export const PROSPECT_REVENUE_LOOP_CHECKPOINT_CONTRACT_VERSION =
  "smirk.prospect-revenue-loop-checkpoint.v6" as const;
export const PROSPECT_REVENUE_LOOP_CHECKPOINT_CONFIRMATION =
  "write-one-local-checkpoint-v1" as const;

const nonnegativeInteger = z.number().int().nonnegative();

const revenueLoopCountsSchema = z
  .object({
    campaigns: nonnegativeInteger,
    discoveryPrepared: nonnegativeInteger,
    discoveryApproved: nonnegativeInteger,
    discoveryInFlight: nonnegativeInteger,
    discoveryReadyForImport: nonnegativeInteger,
    discoveryFailed: nonnegativeInteger,
    sourcePrepared: nonnegativeInteger,
    sourceApproved: nonnegativeInteger,
    sourceInFlight: nonnegativeInteger,
    pendingReviewLeads: nonnegativeInteger,
    qualifiedLeads: nonnegativeInteger,
    qualifiedEmailLeadsWithoutOutreach: nonnegativeInteger,
    qualifiedCallLeadsWithoutOutreach: nonnegativeInteger,
    outreachPrepared: nonnegativeInteger,
    outreachApprovedEmail: nonnegativeInteger,
    outreachApprovedCall: nonnegativeInteger,
    outreachSending: nonnegativeInteger,
    outreachSentWithoutOutcome: nonnegativeInteger,
    outcomeEvents: nonnegativeInteger,
    positiveOutcomeJobs: nonnegativeInteger,
    unreviewedPositiveOutcomeJobs: nonnegativeInteger,
    velvetCallbacksPrepared: nonnegativeInteger,
    velvetCallbacksSending: nonnegativeInteger,
    passingInboxTests: nonnegativeInteger,
    emailExperimentsPrepared: nonnegativeInteger,
    emailExperimentsPreparedWithMatchingInboxTest:
      nonnegativeInteger,
    emailExperimentsActive: nonnegativeInteger,
    emailExperimentsReadyToClose: nonnegativeInteger,
    emailExperimentUnenrolled: nonnegativeInteger,
    callExperimentsPrepared: nonnegativeInteger,
    callExperimentsActive: nonnegativeInteger,
    callExperimentsReadyToClose: nonnegativeInteger,
    callExperimentUnenrolled: nonnegativeInteger,
    closedExperiments: nonnegativeInteger,
    learningCandidatesPending: nonnegativeInteger,
    learningCandidatesApproved: nonnegativeInteger,
    learningCandidatesApprovedUnapplied: nonnegativeInteger,
  })
  .strict();

const connectionSchema = z
  .object({
    configured: z.boolean(),
    enabled: z.boolean(),
    availableForWorkspace: z.boolean(),
    missing: z.array(z.string().trim().min(1).max(160)).max(80),
  })
  .strict();

const nextActionCodeSchema = z.enum([
  "CONFIGURE_VELVET_DISCOVERY",
  "PREPARE_VELVET_DISCOVERY",
  "APPROVE_VELVET_DISCOVERY",
  "DISPATCH_VELVET_DISCOVERY",
  "REFRESH_VELVET_DISCOVERY",
  "REVIEW_VELVET_DISCOVERY_FAILURE",
  "PREPARE_DISCOVERY_IMPORT",
  "CONFIGURE_VELVET_SOURCE",
  "APPROVE_VELVET_SOURCE",
  "DISPATCH_VELVET_SOURCE",
  "RECONCILE_VELVET_SOURCE",
  "REVIEW_IMPORTED_PROSPECT",
  "CONFIGURE_INBOX_PLACEMENT",
  "RUN_INBOX_PLACEMENT",
  "PREPARE_EMAIL_EXPERIMENT",
  "ACTIVATE_EMAIL_EXPERIMENT",
  "PREPARE_CALL_EXPERIMENT",
  "ACTIVATE_CALL_EXPERIMENT",
  "PREPARE_EXPERIMENT_DRAFTS",
  "CLOSE_ACTIVE_EXPERIMENT",
  "RECONCILE_ACTIVE_EXPERIMENT",
  "REVIEW_RECIPIENT_OUTREACH",
  "CONFIGURE_EMAIL_PROVIDER",
  "SEND_ONE_APPROVED_EMAIL",
  "MANUALLY_DIAL_ONE_APPROVED_CALL",
  "RECONCILE_EMAIL_PROVIDER",
  "WAIT_FOR_MEASURED_OUTCOME",
  "REVIEW_POSITIVE_OUTCOME",
  "CONFIGURE_VELVET_OUTCOME",
  "DISPATCH_ONE_VELVET_OUTCOME",
  "RECONCILE_VELVET_OUTCOME",
  "REVIEW_LEARNING_CANDIDATE",
  "APPLY_MESSAGE_POLICY",
]);

export const prospectRevenueLoopStatusSchema = z
  .object({
    contractVersion: z.literal(
      PROSPECT_REVENUE_LOOP_CONTRACT_VERSION
    ),
    mode: z.literal("guarded-human-approval"),
    counts: revenueLoopCountsSchema,
    connections: z
      .object({
        velvetDiscovery: connectionSchema,
        velvetSource: connectionSchema,
        emailProvider: connectionSchema,
        inboxPlacement: connectionSchema,
        velvetOutcome: connectionSchema,
      })
      .strict(),
    stages: z
      .array(
        z
          .object({
            id: z.enum([
              "source",
              "review",
              "experiment",
              "outreach",
              "feedback",
              "learning",
            ]),
            label: z.string().trim().min(1).max(80),
            state: z.enum([
              "WAITING",
              "ACTION_REQUIRED",
              "READY",
              "MEASURED",
            ]),
            count: nonnegativeInteger,
          })
          .strict()
      )
      .length(6),
    nextAction: z
      .object({
        code: nextActionCodeSchema,
        stage: z.enum([
          "source",
          "review",
          "experiment",
          "outreach",
          "feedback",
          "learning",
          "configuration",
        ]),
        title: z.string().trim().min(1).max(200),
        detail: z.string().trim().min(1).max(1_000),
        target: z.string().trim().min(1).max(160),
        requiresHumanApproval: z.literal(true),
        requiresSeparateExecutionConfirmation: z.boolean(),
        executionEffect: z.enum([
          "none",
          "one_velvet_request",
          "one_email",
          "one_manual_call",
          "one_velvet_callback",
        ]),
        focus: z
          .discriminatedUnion("kind", [
            z
              .object({
                kind: z.literal("prospect"),
                campaignId: z.number().int().positive(),
                leadId: z.number().int().positive(),
                approvalId: z.string().uuid().optional(),
              })
              .strict(),
            z
              .object({
                kind: z.literal("positive_outcome_review"),
                reviewId: z.string().uuid(),
              })
              .strict(),
            z
              .object({
                kind: z.literal("learning_candidate"),
                candidateId: z.number().int().positive(),
              })
              .strict(),
            z
              .object({
                kind: z.literal("velvet_outcome"),
                outboxId: z.number().int().positive(),
              })
              .strict(),
            z
              .object({
                kind: z.literal("velvet_source_request"),
                requestId: z.number().int().positive(),
              })
              .strict(),
            z
              .object({
                kind: z.literal("velvet_discovery_request"),
                requestId: z.number().int().positive(),
              })
              .strict(),
            z
              .object({
                kind: z.literal("message_experiment"),
                experimentId: z.string().uuid(),
                campaignId: z.number().int().positive(),
              })
              .strict(),
          ])
          .optional(),
      })
      .strict(),
    guardrails: z
      .object({
        smsAllowed: z.literal(false),
        bulkExecutionAllowed: z.literal(false),
        automatedProspectDialingAllowed: z.literal(false),
        qcMayAuthorizeContact: z.literal(false),
        learningMayMutateRuntimePolicy: z.literal(false),
      })
      .strict(),
    externalAction: z.literal("none"),
  })
  .strict();

export const prospectRevenueLoopCheckpointSchema = z
  .object({
    contractVersion: z.literal(
      PROSPECT_REVENUE_LOOP_CHECKPOINT_CONTRACT_VERSION
    ),
    checkpointId: z.string().regex(/^prlc_[a-f0-9]{24}$/),
    workspaceId: z.number().int().positive(),
    observedAt: z.string().datetime({ offset: true }),
    sourceOrigin: z.string().url().max(500),
    statusHash: z.string().regex(/^[a-f0-9]{64}$/),
    schedulerDecision: z.enum([
      "STOP_INTERACTION",
      "WAIT_CONFIGURATION",
      "WAIT_HUMAN",
      "WAIT_SIGNAL",
    ]),
    shouldScheduleNextCheck: z.boolean(),
    hardStop: z.enum(["interaction"]).nullable(),
    nextAction: prospectRevenueLoopStatusSchema.shape.nextAction,
    counts: revenueLoopCountsSchema,
    controls: z
      .object({
        checkpointOnly: z.literal(true),
        contactAuthorized: z.literal(false),
        executionAuthorized: z.literal(false),
        spendAuthorized: z.literal(false),
        policyMutationAuthorized: z.literal(false),
        providerRequestAuthorized: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type ProspectRevenueLoopCheckpoint = z.infer<
  typeof prospectRevenueLoopCheckpointSchema
>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

export function hashProspectRevenueLoopStatus(
  status: ProspectRevenueLoopStatus
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(status)))
    .digest("hex");
}

function schedulerDecision(
  status: ProspectRevenueLoopStatus
): Pick<
  ProspectRevenueLoopCheckpoint,
  "schedulerDecision" | "shouldScheduleNextCheck" | "hardStop"
> {
  if (
    status.nextAction.code === "REVIEW_POSITIVE_OUTCOME" ||
    status.counts.unreviewedPositiveOutcomeJobs > 0
  ) {
    return {
      schedulerDecision: "STOP_INTERACTION",
      shouldScheduleNextCheck: false,
      hardStop: "interaction",
    };
  }
  if (status.nextAction.stage === "configuration") {
    return {
      schedulerDecision: "WAIT_CONFIGURATION",
      shouldScheduleNextCheck: true,
      hardStop: null,
    };
  }
  if (status.nextAction.code === "WAIT_FOR_MEASURED_OUTCOME") {
    return {
      schedulerDecision: "WAIT_SIGNAL",
      shouldScheduleNextCheck: true,
      hardStop: null,
    };
  }
  return {
    schedulerDecision: "WAIT_HUMAN",
    shouldScheduleNextCheck: true,
    hardStop: null,
  };
}

export function buildProspectRevenueLoopCheckpoint(input: {
  workspaceId: number;
  observedAt: string;
  sourceOrigin: string;
  status: ProspectRevenueLoopStatus;
}): ProspectRevenueLoopCheckpoint {
  const workspaceId = z.number().int().positive().parse(
    input.workspaceId
  );
  const observedAt = z
    .string()
    .datetime({ offset: true })
    .parse(input.observedAt);
  const sourceOrigin = new URL(input.sourceOrigin).origin;
  const status = prospectRevenueLoopStatusSchema.parse(input.status);
  const statusHash = hashProspectRevenueLoopStatus(status);
  const decision = schedulerDecision(status);
  return prospectRevenueLoopCheckpointSchema.parse({
    contractVersion:
      PROSPECT_REVENUE_LOOP_CHECKPOINT_CONTRACT_VERSION,
    checkpointId: `prlc_${createHash("sha256")
      .update(
        JSON.stringify({
          workspaceId,
          observedAt,
          sourceOrigin,
          statusHash,
        })
      )
      .digest("hex")
      .slice(0, 24)}`,
    workspaceId,
    observedAt,
    sourceOrigin,
    statusHash,
    ...decision,
    nextAction: status.nextAction,
    counts: status.counts,
    controls: {
      checkpointOnly: true,
      contactAuthorized: false,
      executionAuthorized: false,
      spendAuthorized: false,
      policyMutationAuthorized: false,
      providerRequestAuthorized: false,
    },
  });
}
