import type { Express, Request, RequestHandler, Response } from "express";
import {
  buildWorkspaceKnowledgeContext,
  deleteWorkspaceKnowledgeSource,
  importWorkspaceKnowledge,
  listWorkspaceKnowledgeSources,
} from "../workspace-knowledge.js";

type WorkspaceKnowledgeRouteDeps = {
  dashboardAuth: RequestHandler;
  dbEnabled: boolean;
  getWorkspaceId: (req: Request) => number;
  log: (level: string, message: string, meta?: Record<string, unknown>) => void;
};

export function registerWorkspaceKnowledgeRoutes(app: Express, deps: WorkspaceKnowledgeRouteDeps): void {
  const { dashboardAuth, dbEnabled, getWorkspaceId, log } = deps;

  app.get("/api/workspace/knowledge", dashboardAuth, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) {
        return res.json({
          sources: [],
          agent_context: "Database is not connected yet. Add Postgres before importing workspace knowledge.",
        });
      }
      const wsId = getWorkspaceId(req);
      const workspaceAuth = (req as Request & { workspaceAuth?: { id?: number } }).workspaceAuth;
      const id = workspaceAuth?.id ?? wsId;
      const sources = await listWorkspaceKnowledgeSources(id);
      const agent_context = await buildWorkspaceKnowledgeContext(id);
      return res.json({ sources, agent_context });
    } catch (err: any) {
      log("error", "GET /api/workspace/knowledge failed", { error: err.message });
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
      const result = await importWorkspaceKnowledge(id, req.body || {});
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
      const deleted = await deleteWorkspaceKnowledgeSource(workspaceId, id);
      if (!deleted) return res.status(404).json({ error: "Knowledge source not found." });
      return res.json({ ok: true });
    } catch (err: any) {
      log("error", "DELETE /api/workspace/knowledge/:id failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });
}
