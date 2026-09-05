import type { Express, Request, RequestHandler, Response } from "express";
import {
  activateWorkspaceKnowledgePack,
  buildWorkspaceKnowledgeContext,
  createWorkspaceKnowledgePack,
  deactivateWorkspaceKnowledgePacks,
  deleteWorkspaceKnowledgeSource,
  importWorkspaceKnowledge,
  listWorkspaceKnowledgePacks,
  listWorkspaceKnowledgeSources,
} from "../workspace-knowledge.js";
import { activationIdentityForAuthMode } from "../activation-provenance.js";

type WorkspaceKnowledgeRouteDeps = {
  dashboardAuth: RequestHandler;
  dbEnabled: boolean;
  sql: any;
  getWorkspaceId: (req: Request) => number;
  createActivationEvent: (data: {
    workspace_id?: number | null;
    provisioning_request_id?: number | null;
    event_type: string;
    status?: "open" | "blocked" | "complete" | "info";
    actor?: "customer" | "operator" | "system";
    detail?: Record<string, unknown>;
  }) => Promise<unknown>;
  log: (level: string, message: string, meta?: Record<string, unknown>) => void;
};

export function registerWorkspaceKnowledgeRoutes(app: Express, deps: WorkspaceKnowledgeRouteDeps): void {
  const { dashboardAuth, dbEnabled, sql, getWorkspaceId, createActivationEvent, log } = deps;

  const checkoutProvisioningRequestId = async (workspaceId: number): Promise<number | null> => {
    const rows = await sql<{ id: number }[]>`
      SELECT id
      FROM provisioning_requests
      WHERE workspace_id = ${workspaceId}
        AND source = 'stripe_checkout_completed'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `;
    const id = Number(rows[0]?.id || 0);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };

  app.get("/api/workspace/knowledge", dashboardAuth, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Business knowledge is unavailable because durable workspace storage is not connected.",
          code: "DURABLE_STORAGE_UNAVAILABLE",
        });
      }
      const wsId = getWorkspaceId(req);
      const workspaceAuth = (req as Request & { workspaceAuth?: { id?: number } }).workspaceAuth;
      const id = workspaceAuth?.id ?? wsId;
      const [sources, packs, agent_context] = await Promise.all([
        listWorkspaceKnowledgeSources(id),
        listWorkspaceKnowledgePacks(id),
        buildWorkspaceKnowledgeContext(id),
      ]);
      return res.json({ sources, packs, agent_context });
    } catch (err: any) {
      log("error", "GET /api/workspace/knowledge failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/workspace/knowledge/packs", dashboardAuth, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) return res.status(503).json({ error: "Connect Postgres before creating a Business Knowledge Pack." });
      const wsId = getWorkspaceId(req);
      const workspaceAuth = (req as Request & { workspaceAuth?: { id?: number } }).workspaceAuth;
      const id = workspaceAuth?.id ?? wsId;
      const pack = await createWorkspaceKnowledgePack(id, req.body || {});
      const activationIdentity = activationIdentityForAuthMode((req as any).authMode);
      await createActivationEvent({
        workspace_id: id,
        provisioning_request_id: await checkoutProvisioningRequestId(id),
        event_type: "business_knowledge_pack_drafted",
        status: "info",
        actor: activationIdentity.actor,
        detail: { pack_id: pack.id, source_count: pack.source_ids.length, quote_policy: pack.quote_policy },
      });
      return res.status(201).json({ pack });
    } catch (err: any) {
      log("error", "POST /api/workspace/knowledge/packs failed", { error: err.message });
      return res.status(/select|required|unavailable/i.test(err.message || "") ? 400 : 500).json({ error: err.message });
    }
  });

  app.post("/api/workspace/knowledge/packs/:id/activate", dashboardAuth, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) return res.status(503).json({ error: "Connect Postgres before activating a Business Knowledge Pack." });
      const packId = Number(req.params.id);
      if (!Number.isSafeInteger(packId) || packId < 1) return res.status(400).json({ error: "Invalid Business Knowledge Pack ID." });
      const wsId = getWorkspaceId(req);
      const workspaceAuth = (req as Request & { workspaceAuth?: { id?: number } }).workspaceAuth;
      const id = workspaceAuth?.id ?? wsId;
      const pack = await activateWorkspaceKnowledgePack(id, packId);
      const activationIdentity = activationIdentityForAuthMode((req as any).authMode);
      await createActivationEvent({
        workspace_id: id,
        provisioning_request_id: await checkoutProvisioningRequestId(id),
        event_type: "business_knowledge_pack_activated",
        status: "complete",
        actor: activationIdentity.actor,
        detail: { pack_id: pack.id, source_count: pack.source_ids.length, quote_policy: pack.quote_policy },
      });
      return res.json({ pack, agent_context: await buildWorkspaceKnowledgeContext(id) });
    } catch (err: any) {
      log("error", "POST /api/workspace/knowledge/packs/:id/activate failed", { error: err.message });
      return res.status(/not found|source set|review/i.test(err.message || "") ? 400 : 500).json({ error: err.message });
    }
  });

  app.post("/api/workspace/knowledge/packs/reset", dashboardAuth, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) return res.status(503).json({ error: "Connect Postgres before resetting Business Knowledge Pack context." });
      const wsId = getWorkspaceId(req);
      const workspaceAuth = (req as Request & { workspaceAuth?: { id?: number } }).workspaceAuth;
      const id = workspaceAuth?.id ?? wsId;
      const deactivated = await deactivateWorkspaceKnowledgePacks(id);
      const activationIdentity = activationIdentityForAuthMode((req as any).authMode);
      await createActivationEvent({
        workspace_id: id,
        provisioning_request_id: await checkoutProvisioningRequestId(id),
        event_type: "business_knowledge_pack_deactivated",
        status: "info",
        actor: activationIdentity.actor,
        detail: { deactivated },
      });
      return res.json({ ok: true, deactivated, agent_context: await buildWorkspaceKnowledgeContext(id) });
    } catch (err: any) {
      log("error", "POST /api/workspace/knowledge/packs/reset failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/workspace/knowledge/import", dashboardAuth, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) {
        return res.status(503).json({ error: "Connect Postgres before importing workspace knowledge or CRM files." });
      }
      const wsId = getWorkspaceId(req);
      const workspaceAuth = (req as Request & { workspaceAuth?: { id?: number } }).workspaceAuth;
      const id = workspaceAuth?.id ?? wsId;
      const activationIdentity = activationIdentityForAuthMode((req as any).authMode);
      const provisioningRequestId = await checkoutProvisioningRequestId(id);
      await createActivationEvent({
        workspace_id: id,
        provisioning_request_id: provisioningRequestId,
        event_type: "workspace_knowledge_import_requested",
        status: "info",
        actor: activationIdentity.actor,
        detail: {
          auth_mode: activationIdentity.authMode,
          auth_provenance: activationIdentity.authProvenance,
        },
      });
      const result = await importWorkspaceKnowledge(id, req.body || {});
      await createActivationEvent({
        workspace_id: id,
        provisioning_request_id: provisioningRequestId,
        event_type: "workspace_knowledge_imported",
        status: "complete",
        actor: activationIdentity.actor,
        detail: {
          auth_mode: activationIdentity.authMode,
          auth_provenance: activationIdentity.authProvenance,
          source_id: Number((result as any)?.source?.id || 0) || null,
        },
      });
      return res.status(201).json(result);
    } catch (err: any) {
      log("error", "POST /api/workspace/knowledge/import failed", { error: err.message });
      const status = /required|too large|JSON/i.test(err.message || "") ? 400 : 500;
      return res.status(status).json({ error: err.message });
    }
  });

  app.delete("/api/workspace/knowledge/:id", dashboardAuth, async (req: Request, res: Response) => {
    try {
      const wsId = getWorkspaceId(req);
      const workspaceAuth = (req as Request & { workspaceAuth?: { id?: number } }).workspaceAuth;
      const workspaceId = workspaceAuth?.id ?? wsId;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid knowledge source ID." });
      const activationIdentity = activationIdentityForAuthMode((req as any).authMode);
      const provisioningRequestId = await checkoutProvisioningRequestId(workspaceId);
      await createActivationEvent({
        workspace_id: workspaceId,
        provisioning_request_id: provisioningRequestId,
        event_type: "workspace_knowledge_delete_requested",
        status: "info",
        actor: activationIdentity.actor,
        detail: {
          auth_mode: activationIdentity.authMode,
          auth_provenance: activationIdentity.authProvenance,
          source_id: id,
        },
      });
      const deleted = await deleteWorkspaceKnowledgeSource(workspaceId, id);
      if (!deleted) return res.status(404).json({ error: "Knowledge source not found." });
      await createActivationEvent({
        workspace_id: workspaceId,
        provisioning_request_id: provisioningRequestId,
        event_type: "workspace_knowledge_deleted",
        status: "complete",
        actor: activationIdentity.actor,
        detail: {
          auth_mode: activationIdentity.authMode,
          auth_provenance: activationIdentity.authProvenance,
          source_id: id,
        },
      });
      return res.json({ ok: true });
    } catch (err: any) {
      log("error", "DELETE /api/workspace/knowledge/:id failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });
}
