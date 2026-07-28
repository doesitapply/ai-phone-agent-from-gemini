import type { Express, Request, RequestHandler, Response } from "express";
import { createHash } from "node:crypto";
import rateLimit from "express-rate-limit";
import {
  VELVET_HANDOFF_SOURCE,
  buildVelvetHandoffCallSid,
  buildVelvetHandoffPayloadHash,
  constantTimeSecretEquals,
  readBearerToken,
  readVelvetHandoffConfig,
  velvetHandoffPayloadSchema,
  type VelvetHandoffPayload,
} from "../velvet-handoff.js";

type SqlClient = any;

export type VelvetHandoffStoreResult = {
  outcome: "created" | "duplicate";
  handoffId: number;
  taskId: number | null;
};

export interface VelvetHandoffStore {
  receive(input: VelvetHandoffPayload & { payloadHash: string }): Promise<VelvetHandoffStoreResult>;
}

export class VelvetHandoffStoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type VelvetHandoffRouteDeps = {
  dbEnabled: boolean;
  env: Record<string, string | undefined>;
  store: VelvetHandoffStore;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

const velvetHandoffRateLimit = rateLimit({
  windowMs: 60 * 60_000,
  max: 30,
  message: {
    error: "Too many Velvet Alchemy handoffs. Please slow down.",
    code: "VELVET_ALCHEMY_HANDOFF_RATE_LIMITED",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const safeExternalReference = (externalId: string) => `evt_${createHash("sha256").update(externalId).digest("hex").slice(0, 12)}`;

export function createPostgresVelvetHandoffStore(sql: SqlClient): VelvetHandoffStore {
  return {
    async receive(input) {
      return sql.begin(async (tx: SqlClient) => {
        const workspaceRows = await tx<{ id: number }[]>`
          SELECT id FROM workspaces WHERE id = ${input.workspaceId} LIMIT 1
        `;
        if (!workspaceRows[0]) {
          throw new VelvetHandoffStoreError("The configured SMIRK workspace was not found.", "VELVET_ALCHEMY_WORKSPACE_NOT_FOUND", 404);
        }

        const receiptRows = await tx<{ id: number }[]>`
          INSERT INTO velvet_alchemy_handoff_receipts (
            workspace_id, source, external_id, payload_hash, status
          ) VALUES (
            ${input.workspaceId}, ${VELVET_HANDOFF_SOURCE}, ${input.externalId}, ${input.payloadHash}, 'processing'
          )
          ON CONFLICT (workspace_id, source, external_id) DO NOTHING
          RETURNING id
        `;

        if (!receiptRows[0]) {
          const existingRows = await tx<{ status: string; payload_hash: string; handoff_id: number | null; task_id: number | null }[]>`
            SELECT status, payload_hash, handoff_id, task_id
            FROM velvet_alchemy_handoff_receipts
            WHERE workspace_id = ${input.workspaceId}
              AND source = ${VELVET_HANDOFF_SOURCE}
              AND external_id = ${input.externalId}
            LIMIT 1
          `;
          const existing = existingRows[0];
          if (existing && existing.payload_hash !== input.payloadHash) {
            throw new VelvetHandoffStoreError(
              "This external handoff ID was already used for a different payload.",
              "VELVET_ALCHEMY_IDEMPOTENCY_CONFLICT",
              409,
            );
          }
          if (existing?.status === "received" && existing.handoff_id) {
            return {
              outcome: "duplicate" as const,
              handoffId: Number(existing.handoff_id),
              taskId: existing.task_id ? Number(existing.task_id) : null,
            };
          }
          throw new VelvetHandoffStoreError("This handoff is already being processed.", "VELVET_ALCHEMY_HANDOFF_IN_PROGRESS", 409);
        }

        const contactRows = await tx<{ id: number; workspace_id: number }[]>`
          INSERT INTO contacts (
            phone_number, name, email, company_name, notes, workspace_id, last_seen, status
          ) VALUES (
            ${input.caller.phone}, ${input.caller.name || null}, ${input.caller.email || null},
            ${input.companyName || null}, ${"Received through the Velvet Alchemy handoff integration."},
            ${input.workspaceId}, NOW(), 'active'
          )
          ON CONFLICT (phone_number) DO UPDATE
          SET
            name = COALESCE(EXCLUDED.name, contacts.name),
            email = COALESCE(EXCLUDED.email, contacts.email),
            company_name = COALESCE(EXCLUDED.company_name, contacts.company_name),
            last_seen = NOW(),
            updated_at = NOW()
          WHERE contacts.workspace_id = ${input.workspaceId}
          RETURNING id, workspace_id
        `;
        const contact = contactRows[0];
        if (!contact) {
          throw new VelvetHandoffStoreError(
            "The caller phone number is already isolated to another workspace.",
            "VELVET_ALCHEMY_CONTACT_SCOPE_CONFLICT",
            409,
          );
        }

        const callSid = buildVelvetHandoffCallSid(input.workspaceId, input.externalId);
        const callRows = await tx<{ call_sid: string }[]>`
          INSERT INTO calls (
            call_sid, direction, from_number, status, agent_name, contact_id, workspace_id, workflow_stage, started_at, ended_at
          ) VALUES (
            ${callSid}, 'external_handoff', ${input.caller.phone}, 'completed', 'Velvet Alchemy',
            ${contact.id}, ${input.workspaceId}, 'handoff', NOW(), NOW()
          )
          ON CONFLICT (call_sid) DO UPDATE
          SET contact_id = EXCLUDED.contact_id, workspace_id = EXCLUDED.workspace_id
          RETURNING call_sid
        `;
        if (!callRows[0]?.call_sid) {
          throw new VelvetHandoffStoreError("The handoff call record could not be created.", "VELVET_ALCHEMY_CALL_WRITE_FAILED", 500);
        }

        const handoffRows = await tx<{ id: number }[]>`
          INSERT INTO handoffs (
            call_sid, contact_id, reason, urgency, transcript_snippet, extracted_fields,
            recommended_action, notes, status, workspace_id
          ) VALUES (
            ${callSid}, ${contact.id}, ${input.reason}, ${input.urgency}, ${input.transcriptSnippet || null},
            ${tx.json({
              source: VELVET_HANDOFF_SOURCE,
              external_id: input.externalId,
              payload_hash: input.payloadHash,
            })},
            ${input.recommendedAction || null}, ${input.notes || null}, 'pending', ${input.workspaceId}
          )
          RETURNING id
        `;
        const handoffId = Number(handoffRows[0]?.id || 0);
        if (!handoffId) {
          throw new VelvetHandoffStoreError("The handoff queue record could not be created.", "VELVET_ALCHEMY_HANDOFF_WRITE_FAILED", 500);
        }

        const taskRows = await tx<{ id: number }[]>`
          INSERT INTO tasks (
            contact_id, call_sid, task_type, status, priority, notes, workspace_id
          ) VALUES (
            ${contact.id}, ${callSid}, 'handoff', 'open',
            ${input.urgency === "high" || input.urgency === "emergency" ? "high" : "normal"},
            ${[input.reason, input.recommendedAction && `Next action: ${input.recommendedAction}`].filter(Boolean).join(". ")},
            ${input.workspaceId}
          )
          RETURNING id
        `;
        const taskId = taskRows[0]?.id ? Number(taskRows[0].id) : null;

        if (taskId) {
          await tx`
            UPDATE contacts
            SET open_tasks_count = GREATEST(open_tasks_count + 1, 0), updated_at = NOW()
            WHERE id = ${contact.id} AND workspace_id = ${input.workspaceId}
          `;
        }

        await tx`
          INSERT INTO call_events (call_sid, event_type, payload)
          VALUES (
            ${callSid}, 'VELVET_ALCHEMY_HANDOFF_RECEIVED',
            ${tx.json({ external_id: input.externalId, payload_hash: input.payloadHash, handoff_id: handoffId })}
          )
        `;

        const updatedReceipt = await tx<{ id: number }[]>`
          UPDATE velvet_alchemy_handoff_receipts
          SET status = 'received', handoff_id = ${handoffId}, task_id = ${taskId}, updated_at = NOW()
          WHERE id = ${receiptRows[0].id} AND status = 'processing'
          RETURNING id
        `;
        if (!updatedReceipt[0]) {
          throw new VelvetHandoffStoreError("The handoff receipt could not be finalized.", "VELVET_ALCHEMY_RECEIPT_WRITE_FAILED", 500);
        }

        return { outcome: "created" as const, handoffId, taskId };
      });
    },
  };
}

export function createVelvetHandoffHandler(deps: VelvetHandoffRouteDeps): RequestHandler {
  return async (req: Request, res: Response) => {
    const config = readVelvetHandoffConfig(deps.env);
    if (!config.configured || !config.workspaceId) {
      return res.status(503).json({
        error: "Velvet Alchemy handoff is not configured.",
        code: "VELVET_ALCHEMY_HANDOFF_NOT_CONFIGURED",
        missing: config.missing,
      });
    }
    if (!deps.dbEnabled) {
      return res.status(503).json({
        error: "Velvet Alchemy handoff requires durable SMIRK storage.",
        code: "VELVET_ALCHEMY_HANDOFF_STORAGE_REQUIRED",
      });
    }

    const token = readBearerToken(req.headers.authorization);
    if (!constantTimeSecretEquals(token, config.apiKey)) {
      deps.log("warn", "Rejected Velvet Alchemy handoff authentication", {
        requestId: (req as any).requestId,
        ip: req.ip,
      });
      return res.status(401).json({ error: "Unauthorized", code: "VELVET_ALCHEMY_HANDOFF_UNAUTHORIZED" });
    }

    const parsed = velvetHandoffPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid Velvet Alchemy handoff payload.",
        code: "VELVET_ALCHEMY_HANDOFF_INVALID_PAYLOAD",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    if (parsed.data.workspaceId !== config.workspaceId) {
      deps.log("warn", "Rejected Velvet Alchemy handoff for the wrong workspace", {
        requestId: (req as any).requestId,
        configuredWorkspaceId: config.workspaceId,
        requestedWorkspaceId: parsed.data.workspaceId,
        externalRef: safeExternalReference(parsed.data.externalId),
      });
      return res.status(403).json({ error: "Workspace is not authorized for this integration.", code: "VELVET_ALCHEMY_WORKSPACE_MISMATCH" });
    }

    const payloadHash = buildVelvetHandoffPayloadHash(parsed.data);
    try {
      const result = await deps.store.receive({ ...parsed.data, payloadHash });
      deps.log("info", "Velvet Alchemy handoff persisted", {
        requestId: (req as any).requestId,
        workspaceId: parsed.data.workspaceId,
        handoffId: result.handoffId,
        outcome: result.outcome,
        externalRef: safeExternalReference(parsed.data.externalId),
      });
      return res.status(result.outcome === "created" ? 201 : 200).json({
        ok: true,
        state: result.outcome === "created" ? "RECEIVED" : "DUPLICATE",
        handoffId: result.handoffId,
        taskId: result.taskId,
      });
    } catch (error) {
      if (error instanceof VelvetHandoffStoreError) {
        deps.log("warn", "Velvet Alchemy handoff rejected by persistence safeguards", {
          requestId: (req as any).requestId,
          code: error.code,
          status: error.status,
          externalRef: safeExternalReference(parsed.data.externalId),
        });
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      deps.log("error", "Velvet Alchemy handoff persistence failed", {
        requestId: (req as any).requestId,
        externalRef: safeExternalReference(parsed.data.externalId),
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(503).json({
        error: "Velvet Alchemy handoff storage is temporarily unavailable.",
        code: "VELVET_ALCHEMY_HANDOFF_STORAGE_UNAVAILABLE",
      });
    }
  };
}

export function registerVelvetHandoffRoutes(app: Express, deps: VelvetHandoffRouteDeps): void {
  app.post("/api/integrations/velvet/handoffs", velvetHandoffRateLimit, createVelvetHandoffHandler(deps));
}
