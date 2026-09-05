import { createHash } from "node:crypto";
import type { Express, Request, RequestHandler, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  VELVET_ACQUISITION_SOURCE,
  VELVET_EVIDENCE_INBOX_MODE,
  buildInitialAcquisitionReviewId,
  buildVelvetAcquisitionId,
  buildVelvetAcquisitionPayloadHash,
  buildVelvetAcquisitionReceiptId,
  constantTimeSecretEquals,
  readBearerToken,
  readVelvetAcquisitionConfig,
  validateVelvetAcquisitionEvidence,
  velvetAcquisitionPayloadSchema,
  type VelvetAcquisitionPayload,
} from "../velvet-acquisition.js";

export type VelvetAcquisitionStoreResult = {
  outcome: "created" | "duplicate";
  receiptId: string;
  acquisitionId: string;
  recordKind: "real" | "synthetic";
  contactPermission: "unverified" | "not_permitted";
  contactBasis: "not_evaluated" | "synthetic_fixture";
};

export interface VelvetAcquisitionStore {
  receive(input: VelvetAcquisitionPayload): Promise<VelvetAcquisitionStoreResult>;
}

export class VelvetAcquisitionStoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type SqlClient = any;

export function createPostgresVelvetAcquisitionStore(sql: SqlClient): VelvetAcquisitionStore {
  return {
    async receive(rawInput) {
      const validatedInput = velvetAcquisitionPayloadSchema.safeParse(rawInput);
      if (!validatedInput.success) {
        throw new VelvetAcquisitionStoreError(
          "Invalid Velvet Alchemy acquisition evidence.",
          "VELVET_ALCHEMY_ACQUISITION_INVALID_PAYLOAD",
          400,
        );
      }
      const input = validatedInput.data;
      const payloadHash = buildVelvetAcquisitionPayloadHash(input);
      const evidenceSafety = validateVelvetAcquisitionEvidence(input);
      if (!evidenceSafety.ok) {
        throw new VelvetAcquisitionStoreError(
          "The acquisition classification conflicts with its reserved evidence identifiers.",
          "VELVET_ALCHEMY_ACQUISITION_CLASSIFICATION_CONFLICT",
          409,
        );
      }

      const isSynthetic = input.recordKind === "synthetic";
      const contactPermission = isSynthetic ? "not_permitted" as const : "unverified" as const;
      const contactBasis = isSynthetic ? "synthetic_fixture" as const : "not_evaluated" as const;
      const reviewDecision = isSynthetic ? "not_contactable" : "observe_only";
      const acquisitionId = buildVelvetAcquisitionId(input.workspaceId, input.sourceRecordId);
      const receiptId = buildVelvetAcquisitionReceiptId(input.workspaceId, input.sourceEventId);
      const reviewId = buildInitialAcquisitionReviewId(acquisitionId, input.recordKind);
      const sourceSnapshot = {
        recordKind: input.recordKind,
        sourceRecordId: input.sourceRecordId,
        sourceEventId: input.sourceEventId,
        caller: input.caller,
        companyName: input.companyName || null,
        reason: input.reason,
        urgency: input.urgency,
        transcriptSnippet: input.transcriptSnippet || null,
        recommendedAction: input.recommendedAction || null,
        notes: input.notes || null,
      };

      return sql.begin(async (tx: SqlClient) => {
        const existingEventRows = await tx<{
          receipt_id: string;
          acquisition_id: string;
          payload_hash: string;
        }[]>`
          SELECT receipt_id, acquisition_id, payload_hash
          FROM acquisition_events
          WHERE workspace_id = ${input.workspaceId}
            AND source_system = ${VELVET_ACQUISITION_SOURCE}
            AND source_event_id = ${input.sourceEventId}
          LIMIT 1
        `;
        const existingEvent = existingEventRows[0];
        if (existingEvent) {
          if (existingEvent.payload_hash !== payloadHash
            || existingEvent.acquisition_id !== acquisitionId
            || existingEvent.receipt_id !== receiptId) {
            throw new VelvetAcquisitionStoreError(
              "This source event ID was already used for different evidence.",
              "VELVET_ALCHEMY_IDEMPOTENCY_CONFLICT",
              409,
            );
          }
          return {
            outcome: "duplicate" as const,
            receiptId: existingEvent.receipt_id,
            acquisitionId: existingEvent.acquisition_id,
            recordKind: input.recordKind,
            contactPermission,
            contactBasis,
          };
        }

        const workspaceRows = await tx<{ id: number }[]>`
          SELECT id FROM workspaces WHERE id = ${input.workspaceId} LIMIT 1
        `;
        if (!workspaceRows[0]) {
          throw new VelvetAcquisitionStoreError(
            "The configured SMIRK workspace was not found.",
            "VELVET_ALCHEMY_WORKSPACE_NOT_FOUND",
            404,
          );
        }

        await tx`
          INSERT INTO acquisition_records (
            acquisition_id, workspace_id, source_system, source_record_id,
            first_payload_hash, record_kind, contact_permission, contact_basis,
            route_decision, source_snapshot, source_observed_at
          ) VALUES (
            ${acquisitionId}, ${input.workspaceId}, ${VELVET_ACQUISITION_SOURCE}, ${input.sourceRecordId},
            ${payloadHash}, ${input.recordKind}, ${contactPermission}, ${contactBasis},
            'hold', ${tx.json(sourceSnapshot)}, ${input.occurredAt || null}
          )
          ON CONFLICT (workspace_id, source_system, source_record_id) DO NOTHING
        `;
        const rootRows = await tx<{
          acquisition_id: string;
          record_kind: string;
          contact_permission: string;
          contact_basis: string;
        }[]>`
          SELECT acquisition_id, record_kind, contact_permission, contact_basis
          FROM acquisition_records
          WHERE workspace_id = ${input.workspaceId}
            AND source_system = ${VELVET_ACQUISITION_SOURCE}
            AND source_record_id = ${input.sourceRecordId}
          LIMIT 1
        `;
        const root = rootRows[0];
        if (!root) {
          throw new VelvetAcquisitionStoreError(
            "The acquisition root could not be persisted.",
            "VELVET_ALCHEMY_ACQUISITION_WRITE_FAILED",
            500,
          );
        }
        if (root.acquisition_id !== acquisitionId
          || root.record_kind !== input.recordKind
          || root.contact_permission !== contactPermission
          || root.contact_basis !== contactBasis) {
          throw new VelvetAcquisitionStoreError(
            "The source record identity conflicts with existing acquisition evidence.",
            "VELVET_ALCHEMY_SOURCE_RECORD_CONFLICT",
            409,
          );
        }

        const eventRows = await tx<{ receipt_id: string }[]>`
          INSERT INTO acquisition_events (
            receipt_id, acquisition_id, workspace_id, source_system, source_event_id,
            event_type, payload_hash, status, payload_snapshot, source_observed_at
          ) VALUES (
            ${receiptId}, ${acquisitionId}, ${input.workspaceId}, ${VELVET_ACQUISITION_SOURCE}, ${input.sourceEventId},
            'source_received', ${payloadHash}, 'received', ${tx.json(sourceSnapshot)}, ${input.occurredAt || null}
          )
          ON CONFLICT (workspace_id, source_system, source_event_id) DO NOTHING
          RETURNING receipt_id
        `;
        if (!eventRows[0]) {
          const racedRows = await tx<{
            receipt_id: string;
            acquisition_id: string;
            payload_hash: string;
          }[]>`
            SELECT receipt_id, acquisition_id, payload_hash
            FROM acquisition_events
            WHERE workspace_id = ${input.workspaceId}
              AND source_system = ${VELVET_ACQUISITION_SOURCE}
              AND source_event_id = ${input.sourceEventId}
            LIMIT 1
          `;
          const raced = racedRows[0];
          if (!raced || raced.payload_hash !== payloadHash
            || raced.acquisition_id !== acquisitionId
            || raced.receipt_id !== receiptId) {
            throw new VelvetAcquisitionStoreError(
              "This source event ID was already used for different evidence.",
              "VELVET_ALCHEMY_IDEMPOTENCY_CONFLICT",
              409,
            );
          }
          return {
            outcome: "duplicate" as const,
            receiptId: raced.receipt_id,
            acquisitionId: raced.acquisition_id,
            recordKind: input.recordKind,
            contactPermission,
            contactBasis,
          };
        }

        await tx`
          INSERT INTO acquisition_reviews (
            review_id, acquisition_id, workspace_id, decision, candidate_channel,
            contact_basis, evidence_hash, evidence_ref, reviewed_by, observed_at
          ) VALUES (
            ${reviewId}, ${acquisitionId}, ${input.workspaceId}, ${reviewDecision}, 'none',
            ${contactBasis}, ${payloadHash}, ${receiptId}, 'system:velvet_acquisition_intake', NOW()
          )
          ON CONFLICT (review_id) DO NOTHING
        `;

        return {
          outcome: "created" as const,
          receiptId,
          acquisitionId,
          recordKind: input.recordKind,
          contactPermission,
          contactBasis,
        };
      });
    },
  };
}

type VelvetAcquisitionRouteDeps = {
  dbEnabled: boolean;
  isSchemaReady: () => boolean;
  env: Record<string, string | undefined>;
  store: VelvetAcquisitionStore;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

const safeExternalReference = (externalId: string) => (
  `evt_${createHash("sha256").update(externalId).digest("hex").slice(0, 12)}`
);

const velvetAcquisitionRateLimit = rateLimit({
  windowMs: 60 * 60_000,
  max: 30,
  message: {
    error: "Too many Velvet Alchemy acquisition receipts. Please slow down.",
    code: "VELVET_ALCHEMY_ACQUISITION_RATE_LIMITED",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export function createVelvetAcquisitionHandler(
  deps: VelvetAcquisitionRouteDeps,
): RequestHandler {
  return async (req: Request, res: Response) => {
    const config = readVelvetAcquisitionConfig(deps.env);
    const hasUsableKey = !config.missing.includes("VELVET_ALCHEMY_ACQUISITION_API_KEY");
    if (!hasUsableKey) {
      return res.status(503).json({
        error: "Velvet Alchemy acquisition intake is unavailable.",
        code: "VELVET_ALCHEMY_ACQUISITION_NOT_CONFIGURED",
      });
    }
    const token = readBearerToken(req.headers.authorization);
    if (!constantTimeSecretEquals(token, config.apiKey)) {
      deps.log("warn", "Rejected Velvet Alchemy acquisition authentication", {
        requestId: (req as any).requestId,
        ip: req.ip,
      });
      return res.status(401).json({
        error: "Unauthorized",
        code: "VELVET_ALCHEMY_ACQUISITION_UNAUTHORIZED",
      });
    }
    if (!config.configured || !config.workspaceId) {
      return res.status(503).json({
        error: "Velvet Alchemy acquisition intake is unavailable.",
        code: "VELVET_ALCHEMY_ACQUISITION_NOT_CONFIGURED",
      });
    }
    if (!deps.dbEnabled) {
      return res.status(503).json({
        error: "Velvet Alchemy acquisition intake requires durable SMIRK storage.",
        code: "VELVET_ALCHEMY_ACQUISITION_STORAGE_REQUIRED",
      });
    }
    if (!deps.isSchemaReady()) {
      return res.status(503).json({
        error: "Velvet Alchemy acquisition schema is not ready.",
        code: "VELVET_ALCHEMY_ACQUISITION_SCHEMA_NOT_READY",
      });
    }

    const rawParsed = velvetAcquisitionPayloadSchema.safeParse(req.body);
    if (!rawParsed.success) {
      return res.status(400).json({
        error: "Invalid Velvet Alchemy acquisition payload.",
        code: "VELVET_ALCHEMY_ACQUISITION_INVALID_PAYLOAD",
        issues: rawParsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    const parsed: VelvetAcquisitionPayload = velvetAcquisitionPayloadSchema.parse(req.body);
    if (parsed.workspaceId !== config.workspaceId) {
      return res.status(403).json({
        error: "Workspace is not authorized for this integration.",
        code: "VELVET_ALCHEMY_WORKSPACE_MISMATCH",
      });
    }

    if (parsed.recordKind === "real" && config.mode !== VELVET_EVIDENCE_INBOX_MODE) {
      return res.status(409).json({
        error: "Real acquisition evidence requires explicit evidence-inbox mode.",
        code: "VELVET_ALCHEMY_EVIDENCE_INBOX_MODE_REQUIRED",
        externalAction: "none",
      });
    }
    const evidenceSafety = validateVelvetAcquisitionEvidence(parsed);
    if (!evidenceSafety.ok) {
      deps.log("warn", "Rejected misclassified Velvet acquisition evidence", {
        requestId: (req as any).requestId,
        workspaceId: parsed.workspaceId,
        externalRef: safeExternalReference(parsed.sourceEventId),
        violations: evidenceSafety.violations,
      });
      return res.status(409).json({
        error: "The acquisition classification conflicts with its reserved evidence identifiers.",
        code: "VELVET_ALCHEMY_ACQUISITION_CLASSIFICATION_CONFLICT",
        externalAction: "none",
      });
    }

    try {
      const result = await deps.store.receive(parsed);
      return res.status(result.outcome === "created" ? 201 : 200).json({
        ok: true,
        state: result.outcome === "created" ? "RECEIVED" : "DUPLICATE",
        receiptId: result.receiptId,
        acquisitionId: result.acquisitionId,
        recordKind: result.recordKind,
        contactPermission: result.contactPermission,
        contactBasis: result.contactBasis,
        externalAction: "none",
        handoffId: null,
        taskId: null,
        feedbackIdentity: {
          acquisitionId: result.acquisitionId,
          sourceSystem: VELVET_ACQUISITION_SOURCE,
          sourceRecordId: parsed.sourceRecordId,
        },
      });
    } catch (error) {
      if (error instanceof VelvetAcquisitionStoreError) {
        deps.log("warn", "Velvet Alchemy acquisition rejected by persistence safeguards", {
          requestId: (req as any).requestId,
          externalRef: safeExternalReference(parsed.sourceEventId),
          code: error.code,
          status: error.status,
        });
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      deps.log("error", "Velvet Alchemy acquisition persistence failed", {
        requestId: (req as any).requestId,
        externalRef: safeExternalReference(parsed.sourceEventId),
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(503).json({
        error: "Velvet Alchemy acquisition storage is temporarily unavailable.",
        code: "VELVET_ALCHEMY_ACQUISITION_STORAGE_UNAVAILABLE",
      });
    }
  };
}

export function registerVelvetAcquisitionRoutes(app: Express, deps: VelvetAcquisitionRouteDeps): void {
  app.post("/api/integrations/velvet/acquisitions", velvetAcquisitionRateLimit, createVelvetAcquisitionHandler(deps));
}
