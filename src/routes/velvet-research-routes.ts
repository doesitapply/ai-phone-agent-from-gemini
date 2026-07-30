import { createHash } from "node:crypto";
import type { Express, Request, RequestHandler, Response } from "express";
import rateLimit from "express-rate-limit";
import { constantTimeSecretEquals, readBearerToken } from "../velvet-handoff.js";
import {
  VELVET_RESEARCH_SOURCE,
  buildVelvetResearchPayloadHash,
  readVelvetResearchConfig,
  velvetResearchPayloadSchema,
  type VelvetResearchPayload,
} from "../velvet-research.js";

type SqlClient = any;

export type VelvetResearchStoreResult = {
  outcome: "created" | "duplicate";
  campaignId: number;
  prospectId: number;
};

export interface VelvetResearchStore {
  receive(input: VelvetResearchPayload & { payloadHash: string }): Promise<VelvetResearchStoreResult>;
}

export class VelvetResearchStoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type VelvetResearchRouteDeps = {
  dbEnabled: boolean;
  env: Record<string, string | undefined>;
  store: VelvetResearchStore;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

const velvetResearchRateLimit = rateLimit({
  windowMs: 60 * 60_000,
  max: 100,
  message: {
    error: "Too many Velvet Alchemy research imports. Please slow down.",
    code: "VELVET_ALCHEMY_RESEARCH_RATE_LIMITED",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const safeExternalReference = (externalId: string) => (
  `prospect_${createHash("sha256").update(externalId).digest("hex").slice(0, 12)}`
);

export function createPostgresVelvetResearchStore(sql: SqlClient): VelvetResearchStore {
  return {
    async receive(input) {
      return sql.begin(async (tx: SqlClient) => {
        const workspaceRows = await tx<{ id: number }[]>`
          SELECT id FROM workspaces WHERE id = ${input.workspaceId} LIMIT 1
        `;
        if (!workspaceRows[0]) {
          throw new VelvetResearchStoreError(
            "The configured SMIRK workspace was not found.",
            "VELVET_ALCHEMY_RESEARCH_WORKSPACE_NOT_FOUND",
            404,
          );
        }

        const receiptRows = await tx<{ id: number }[]>`
          INSERT INTO velvet_alchemy_research_receipts (
            workspace_id, source, external_id, payload_hash, status
          ) VALUES (
            ${input.workspaceId}, ${VELVET_RESEARCH_SOURCE}, ${input.externalId},
            ${input.payloadHash}, 'processing'
          )
          ON CONFLICT (workspace_id, source, external_id) DO NOTHING
          RETURNING id
        `;

        if (!receiptRows[0]) {
          const existingRows = await tx<{
            status: string;
            payload_hash: string;
            campaign_id: number | null;
            prospect_id: number | null;
          }[]>`
            SELECT status, payload_hash, campaign_id, prospect_id
            FROM velvet_alchemy_research_receipts
            WHERE workspace_id = ${input.workspaceId}
              AND source = ${VELVET_RESEARCH_SOURCE}
              AND external_id = ${input.externalId}
            LIMIT 1
          `;
          const existing = existingRows[0];
          if (existing && existing.payload_hash !== input.payloadHash) {
            throw new VelvetResearchStoreError(
              "This external prospect ID was already used for a different payload.",
              "VELVET_ALCHEMY_RESEARCH_IDEMPOTENCY_CONFLICT",
              409,
            );
          }
          if (existing?.status === "received" && existing.campaign_id && existing.prospect_id) {
            return {
              outcome: "duplicate",
              campaignId: Number(existing.campaign_id),
              prospectId: Number(existing.prospect_id),
            };
          }
          throw new VelvetResearchStoreError(
            "This prospect import is already being processed.",
            "VELVET_ALCHEMY_RESEARCH_IN_PROGRESS",
            409,
          );
        }

        const campaignRows = await tx<{ id: number }[]>`
          INSERT INTO prospecting_campaigns (
            workspace_id, name, description, status, agent_name, target_industry,
            target_location, max_calls_per_day, external_source, external_id
          ) VALUES (
            ${input.workspaceId}, ${input.batch.name},
            ${"Research-only records imported from Velvet Alchemy. External contact is not approved."},
            'draft', 'SMIRK', ${input.batch.targetIndustry || null},
            ${input.batch.targetLocation || null}, 0, ${VELVET_RESEARCH_SOURCE},
            ${input.batch.externalId}
          )
          ON CONFLICT (workspace_id, external_source, external_id)
            WHERE external_source IS NOT NULL AND external_id IS NOT NULL
          DO UPDATE SET
            name = EXCLUDED.name,
            target_industry = COALESCE(EXCLUDED.target_industry, prospecting_campaigns.target_industry),
            target_location = COALESCE(EXCLUDED.target_location, prospecting_campaigns.target_location)
          RETURNING id
        `;
        const campaignId = Number(campaignRows[0]?.id || 0);
        if (!campaignId) {
          throw new VelvetResearchStoreError(
            "The Velvet research batch could not be persisted.",
            "VELVET_ALCHEMY_RESEARCH_CAMPAIGN_WRITE_FAILED",
            500,
          );
        }

        const prospect = input.prospect;
        const prospectRows = await tx<{ id: number }[]>`
          INSERT INTO prospect_leads (
            campaign_id, business_name, phone, phone_contact_mode, email,
            email_verification, website, industry, address,
            city, state, contact_name, contact_title, source, status, score,
            external_id, payload_hash, research_evidence, notes
          ) VALUES (
            ${campaignId}, ${prospect.companyName}, ${prospect.phone || null},
            ${prospect.phoneContactMode || null}, ${prospect.email || null},
            ${prospect.emailVerification || null}, ${prospect.website || null},
            ${prospect.industry || input.batch.targetIndustry || null},
            ${prospect.address || null}, ${prospect.city || null}, ${prospect.state || null},
            ${prospect.contactName || null}, ${prospect.contactTitle || null},
            ${VELVET_RESEARCH_SOURCE}, 'pending', ${prospect.score ?? null},
            ${input.externalId}, ${input.payloadHash}, ${tx.json(prospect.evidence)},
            ${prospect.notes || null}
          )
          ON CONFLICT (campaign_id, source, external_id)
            WHERE external_id IS NOT NULL
          DO NOTHING
          RETURNING id
        `;
        let prospectId = Number(prospectRows[0]?.id || 0);
        if (!prospectId) {
          const existingProspectRows = await tx<{ id: number; payload_hash: string | null }[]>`
            SELECT id, payload_hash
            FROM prospect_leads
            WHERE campaign_id = ${campaignId}
              AND source = ${VELVET_RESEARCH_SOURCE}
              AND external_id = ${input.externalId}
            LIMIT 1
          `;
          const existingProspect = existingProspectRows[0];
          if (!existingProspect || existingProspect.payload_hash !== input.payloadHash) {
            throw new VelvetResearchStoreError(
              "The prospect already exists with different research data.",
              "VELVET_ALCHEMY_RESEARCH_PROSPECT_CONFLICT",
              409,
            );
          }
          prospectId = Number(existingProspect.id);
        }

        await tx`
          UPDATE prospecting_campaigns
          SET total_leads = (
            SELECT COUNT(*) FROM prospect_leads WHERE campaign_id = ${campaignId}
          )
          WHERE id = ${campaignId} AND workspace_id = ${input.workspaceId}
        `;

        const updatedReceipt = await tx<{ id: number }[]>`
          UPDATE velvet_alchemy_research_receipts
          SET status = 'received', campaign_id = ${campaignId}, prospect_id = ${prospectId},
              updated_at = NOW()
          WHERE id = ${receiptRows[0].id} AND status = 'processing'
          RETURNING id
        `;
        if (!updatedReceipt[0]) {
          throw new VelvetResearchStoreError(
            "The Velvet research receipt could not be finalized.",
            "VELVET_ALCHEMY_RESEARCH_RECEIPT_WRITE_FAILED",
            500,
          );
        }

        return { outcome: "created", campaignId, prospectId };
      });
    },
  };
}

export function createVelvetResearchHandler(deps: VelvetResearchRouteDeps): RequestHandler {
  return async (req: Request, res: Response) => {
    const config = readVelvetResearchConfig(deps.env);
    if (!config.configured || !config.workspaceId) {
      return res.status(503).json({
        error: "Velvet Alchemy research intake is not configured.",
        code: "VELVET_ALCHEMY_RESEARCH_NOT_CONFIGURED",
        missing: config.missing,
      });
    }
    if (!deps.dbEnabled) {
      return res.status(503).json({
        error: "Velvet Alchemy research intake requires durable SMIRK storage.",
        code: "VELVET_ALCHEMY_RESEARCH_STORAGE_REQUIRED",
      });
    }

    const token = readBearerToken(req.headers.authorization);
    if (!constantTimeSecretEquals(token, config.apiKey)) {
      deps.log("warn", "Rejected Velvet Alchemy research authentication", {
        requestId: (req as any).requestId,
        ip: req.ip,
      });
      return res.status(401).json({
        error: "Unauthorized",
        code: "VELVET_ALCHEMY_RESEARCH_UNAUTHORIZED",
      });
    }

    const parsed = velvetResearchPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid Velvet Alchemy research payload.",
        code: "VELVET_ALCHEMY_RESEARCH_INVALID_PAYLOAD",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    if (parsed.data.workspaceId !== config.workspaceId) {
      deps.log("warn", "Rejected Velvet Alchemy research for the wrong workspace", {
        requestId: (req as any).requestId,
        configuredWorkspaceId: config.workspaceId,
        requestedWorkspaceId: parsed.data.workspaceId,
        externalRef: safeExternalReference(parsed.data.externalId),
      });
      return res.status(403).json({
        error: "Workspace is not authorized for this integration.",
        code: "VELVET_ALCHEMY_RESEARCH_WORKSPACE_MISMATCH",
      });
    }

    const payloadHash = buildVelvetResearchPayloadHash(parsed.data);
    try {
      const result = await deps.store.receive({ ...parsed.data, payloadHash });
      deps.log("info", "Velvet Alchemy prospect imported for review", {
        requestId: (req as any).requestId,
        workspaceId: parsed.data.workspaceId,
        campaignId: result.campaignId,
        prospectId: result.prospectId,
        outcome: result.outcome,
        externalRef: safeExternalReference(parsed.data.externalId),
      });
      return res.status(result.outcome === "created" ? 201 : 200).json({
        ok: true,
        state: result.outcome === "created" ? "IMPORTED" : "DUPLICATE",
        campaignId: result.campaignId,
        prospectId: result.prospectId,
        externalAction: "none",
      });
    } catch (error) {
      if (error instanceof VelvetResearchStoreError) {
        deps.log("warn", "Velvet Alchemy research rejected by persistence safeguards", {
          requestId: (req as any).requestId,
          code: error.code,
          status: error.status,
          externalRef: safeExternalReference(parsed.data.externalId),
        });
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      deps.log("error", "Velvet Alchemy research persistence failed", {
        requestId: (req as any).requestId,
        externalRef: safeExternalReference(parsed.data.externalId),
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(503).json({
        error: "Velvet Alchemy research storage is temporarily unavailable.",
        code: "VELVET_ALCHEMY_RESEARCH_STORAGE_UNAVAILABLE",
      });
    }
  };
}

export function registerVelvetResearchRoutes(app: Express, deps: VelvetResearchRouteDeps): void {
  app.post("/api/integrations/velvet/prospects", velvetResearchRateLimit, createVelvetResearchHandler(deps));
}
