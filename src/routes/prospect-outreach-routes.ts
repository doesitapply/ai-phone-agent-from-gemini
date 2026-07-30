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
    candidateKey: z
      .string()
      .trim()
      .min(3)
      .max(120)
      .regex(/^[A-Za-z0-9:_-]+$/),
    channel: z.enum(["email", "call"]),
    currentVariant: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[A-Za-z0-9:_-]+$/),
    challengerVariant: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[A-Za-z0-9:_-]+$/),
  })
  .strict()
  .refine((value) => value.currentVariant !== value.challengerVariant, {
    message: "Current and challenger variants must be different.",
  });

const learningDecisionSchema = z
  .object({
    decision: z.enum(["APPROVED", "REJECTED"]),
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
    SELECT l.id, l.campaign_id, l.email, l.email_verification, l.phone,
           l.phone_contact_mode, l.status, l.review_state,
           l.research_evidence, l.external_id, l.source
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
    }[]>`
      SELECT id, state, approval_id, channel, evidence_hash, payload_hash
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

  const status = outcomeToProspectStatus(input.outcome);
  const updated = await tx<{ id: number }[]>`
    UPDATE prospect_leads
    SET status = ${status},
        called_at = CASE
          WHEN ${input.outcome} IN (
            'call_connected', 'voicemail', 'no_answer'
          ) THEN ${input.occurredAt}
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
            }[]>`
              SELECT id, lead_id, approval_id, recipient, state
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
          }[]>`
            SELECT id, lead_id, approval_id
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
          const payload = buildProspectOutreachPayload({
            workspaceId,
            campaignId: lead.campaign_id,
            prospectId: lead.id,
            recipient,
            evidenceHash,
            preparedAt: new Date().toISOString(),
            draft: parsed.data,
          });
          const payloadHash = hashProspectOutreachPayload(payload);
          const draftFingerprint = canonicalJsonHash({
            workspaceId,
            prospectId: lead.id,
            channel: payload.channel,
            recipient: payload.recipient,
            subject: payload.subject || null,
            content: payload.content,
            variantKey: payload.variantKey,
            evidenceHash,
            maxCostCents: payload.maxCostCents,
          });

          const existingRows = await tx<{
            approval_id: string;
            state: string;
            payload_hash: string;
          }[]>`
            SELECT approval_id, state, payload_hash
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
            details: { externalAction: "none" },
          });
          return {
            outcome: "created" as const,
            approvalId,
            state: "PREPARED",
            payloadHash,
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
      const rows = await sql`
        SELECT approval_id, channel, state, recipient, subject, content,
               variant_key,
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
            SELECT id, state, channel, payload_hash, expires_at
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
              parsed.data
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
        SELECT id, lead_id, external_event_id, external_prospect_id,
               payload_hash, state, attempts, last_error, dispatched_at,
               dispatch_idempotency_key, dispatch_requested_at,
               dispatch_response_at, remote_event_id,
               created_at, updated_at
        FROM velvet_outcome_outbox
        WHERE workspace_id = ${workspaceId}
        ORDER BY created_at DESC
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
      channel: "email" | "call";
      variant_key: string;
      outcome: string;
    }[]>`
      SELECT j.channel, j.variant_key, e.outcome
      FROM prospect_outcome_events e
      JOIN prospect_outreach_jobs j ON j.id = e.outreach_job_id
      WHERE e.workspace_id = ${workspaceId}
        AND j.workspace_id = ${workspaceId}
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
      return [
        {
          channel: row.channel,
          variantKey: row.variant_key,
          outcome: outcome.data,
        },
      ];
    });
  };

  app.get(
    "/api/prospecting/learning/scorecard",
    dashboardAuth,
    requireOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) return res.json({ variants: [], sampleSize: 0 });
      try {
        const observations = await loadLearningObservations(
          getWorkspaceId(req)
        );
        return res.json({
          variants: buildProspectLearningScorecard(observations),
          sampleSize: observations.length,
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
          SELECT id, candidate_key, version, state, proposal, evidence,
                 sample_size, generated_at, decided_by, decided_at
          FROM prospect_learning_candidates
          WHERE workspace_id = ${getWorkspaceId(req)}
          ORDER BY generated_at DESC
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
        const observations = await loadLearningObservations(workspaceId);
        const evaluation = evaluateProspectLearningCandidate({
          channel: parsed.data.channel,
          currentVariant: parsed.data.currentVariant,
          challengerVariant: parsed.data.challengerVariant,
          observations,
        });
        if (evaluation.ready === false) {
          return res.status(409).json({
            error:
              evaluation.code === "INSUFFICIENT_SAMPLE"
                ? "Both variants need at least 10 linked outcomes."
                : "The challenger has no measured positive lift.",
            code: `PROSPECT_LEARNING_${evaluation.code}`,
            sampleSize: evaluation.sampleSize,
            policyChanged: false,
          });
        }
        const result = await sql.begin(async (tx: SqlClient) => {
          const versionRows = await tx<{ version: number }[]>`
            SELECT COALESCE(MAX(version), 0) + 1 AS version
            FROM prospect_learning_candidates
            WHERE workspace_id = ${workspaceId}
              AND candidate_key = ${parsed.data.candidateKey}
          `;
          const version = Number(versionRows[0]?.version || 1);
          const rows = await tx<{ id: number }[]>`
            INSERT INTO prospect_learning_candidates (
              workspace_id, candidate_key, version, state, proposal,
              evidence, sample_size
            ) VALUES (
              ${workspaceId}, ${parsed.data.candidateKey}, ${version},
              'CANDIDATE', ${tx.json(evaluation.proposal)},
              ${tx.json(evaluation.evidence)}, ${evaluation.sampleSize}
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
          return { id: rows[0].id, version };
        });
        return res.status(201).json({
          ok: true,
          state: "CANDIDATE",
          ...result,
          sampleSize: evaluation.sampleSize,
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
    requireOperator,
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
        const rows = await sql<{ id: number }[]>`
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
            SELECT id, state, payload, payload_hash, attempts, last_error,
                   dispatch_idempotency_key, dispatch_requested_at,
                   dispatch_response_at, remote_event_id, dispatched_at
            FROM velvet_outcome_outbox
            WHERE id = ${outboxId}
              AND workspace_id = ${workspaceId}
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
