import { createHash, randomUUID } from "node:crypto";
import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import {
  PROSPECT_OUTREACH_CONTRACT_VERSION,
  assertRecordedExecutionWindow,
  assertProspectOutcomeMatchesChannel,
  assertProspectOutreachApprovalAttestations,
  buildProspectOutreachPayload,
  hashProspectOutreachPayload,
  isExactRecordedExecutionReplay,
  isExactProspectOutcomeReplay,
  isValidExecutionProofReference,
  normalizeProspectOutreachRecipient,
  outcomeToProspectStatus,
  prepareProspectOutreachSchema,
  prospectOutreachApprovalSchema,
  prospectOutcomeSchema,
} from "../prospect-outreach.js";
import {
  buildVelvetOutcomePayload,
  hashVelvetOutcomePayload,
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
  sql: SqlClient;
  dbEnabled: boolean;
  getWorkspaceId: (req: Request) => number;
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
    proofReference: z
      .string()
      .trim()
      .min(10)
      .max(500)
      .refine(isValidExecutionProofReference),
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

export function registerProspectOutreachRoutes(
  app: Express,
  deps: ProspectOutreachRouteDeps
): void {
  const {
    dashboardAuth,
    requireOperator,
    sql,
    dbEnabled,
    getWorkspaceId,
  } = deps;

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
          const evidenceHash = canonicalJsonHash(evidence);
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
               sent_at, execution_proof_reference, failure_code,
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
      return res.json({ jobs: rows, outcomes });
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
            SELECT id, state, payload_hash, approved_at, expires_at,
                   sent_at, execution_proof_reference
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
              "The execution record does not match the approved payload.",
              409,
              "PROSPECT_OUTREACH_PAYLOAD_MISMATCH"
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
    requireOperator,
    (_req: Request, res: Response) =>
      res.status(409).json({
        error:
          "Provider execution is disabled. This route cannot send email, SMS, or place a call.",
        code: "PROSPECT_OUTREACH_EXECUTION_DISABLED",
        externalAction: "blocked",
      })
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
               created_at, updated_at
        FROM velvet_outcome_outbox
        WHERE workspace_id = ${workspaceId}
        ORDER BY created_at DESC
        LIMIT 200
      `;
      return res.json({
        events: rows,
        dispatchEnabled: false,
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
      const rows = await sql`
        SELECT id, candidate_key, version, state, proposal, evidence,
               sample_size, generated_at, decided_by, decided_at
        FROM prospect_learning_candidates
        WHERE workspace_id = ${getWorkspaceId(req)}
        ORDER BY generated_at DESC
        LIMIT 100
      `;
      return res.json({ candidates: rows, policyChanged: false });
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
    }
  );

  app.post(
    "/api/prospecting/velvet-outcomes/:id/dispatch",
    dashboardAuth,
    requireOperator,
    (_req: Request, res: Response) =>
      res.status(409).json({
        error:
          "Velvet outcome dispatch is not activated. Review the outbox and approve the exact deployment/configuration gate first.",
        code: "VELVET_OUTCOME_DISPATCH_DISABLED",
        externalAction: "blocked",
      })
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
        const result = await sql.begin(async (tx: SqlClient) => {
          const lead = await requireProspect(tx, workspaceId, leadId, true);
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
          if (parsed.data.outreachApprovalId) {
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
              WHERE approval_id = ${parsed.data.outreachApprovalId}
                AND workspace_id = ${workspaceId}
                AND lead_id = ${leadId}
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
                parsed.data.outcome
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
              ${workspaceId}, ${lead.campaign_id}, ${leadId},
              ${outreachJobId}, 'operator',
              ${parsed.data.externalEventId}, ${parsed.data.outcome},
              ${parsed.data.occurredAt}, ${parsed.data.notes || null}, ${actor}
            )
            ON CONFLICT (workspace_id, source, external_event_id) DO NOTHING
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
              WHERE workspace_id = ${workspaceId}
                AND source = 'operator'
                AND external_event_id = ${parsed.data.externalEventId}
              LIMIT 1
            `;
            if (
              existingRows[0] &&
              isExactProspectOutcomeReplay(existingRows[0], {
                leadId,
                outreachJobId,
                outcome: parsed.data.outcome,
                occurredAt: parsed.data.occurredAt,
                notes: parsed.data.notes,
              })
            ) {
              return { outcome: "duplicate" as const };
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
                WHERE workspace_id = ${workspaceId}
                  AND outreach_job_id = ${outreachJobId}
                  AND outcome = ${parsed.data.outcome}
                LIMIT 1
              `;
              if (duplicateOutcomeRows[0]) {
                throw new ProspectOutreachRouteError(
                  "This outcome is already recorded for the outreach job.",
                  409,
                  "PROSPECT_OUTCOME_ALREADY_RECORDED"
                );
              }
            }
            throw new ProspectOutreachRouteError(
              "The outcome event conflicted with an existing record.",
              409,
              "PROSPECT_OUTCOME_WRITE_CONFLICT"
            );
          }
          const status = outcomeToProspectStatus(parsed.data.outcome);
          const updated = await tx<{ id: number }[]>`
            UPDATE prospect_leads
            SET status = ${status},
                called_at = CASE
                  WHEN ${parsed.data.outcome} IN (
                    'call_connected', 'voicemail', 'no_answer'
                  ) THEN ${parsed.data.occurredAt}
                  ELSE called_at
                END
            WHERE id = ${leadId}
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
              workspaceId,
              externalProspectId: lead.external_id,
              externalEventId: parsed.data.externalEventId,
              outreachApprovalId: outreachJob.approval_id,
              channel: outreachJob.channel,
              outcome: parsed.data.outcome,
              occurredAt: parsed.data.occurredAt,
              evidenceHash: outreachJob.evidence_hash,
              outreachPayloadHash: outreachJob.payload_hash,
              notes: parsed.data.notes,
            });
            const velvetPayloadHash =
              hashVelvetOutcomePayload(velvetPayload);
            const outboxRows = await tx<{ id: number }[]>`
              INSERT INTO velvet_outcome_outbox (
                workspace_id, lead_id, outcome_event_id, external_event_id,
                external_prospect_id, payload, payload_hash, state
              ) VALUES (
                ${workspaceId}, ${leadId}, ${inserted[0].id},
                ${parsed.data.externalEventId}, ${lead.external_id},
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
          };
        });
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
