import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import {
  checkUsageLimits,
  deleteWorkspace,
  getWorkspaceById,
  getWorkspaceMembers,
  getWorkspaces,
  getWorkspaceStats,
  inviteMember,
  PLAN_LIMITS,
  provisionWorkspace,
  removeMember,
  updateWorkspace,
} from "../saas.js";

type WorkspaceAdminRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: (req: Request, res: Response, next: NextFunction) => void;
  dbEnabled: boolean;
  provisionWorkspaceTelephony: (workspaceId: number, businessName: string, ownerPhone?: string | null) => Promise<{
    phoneNumber?: string | null;
    subaccountSid?: string | null;
    phoneNumberSid?: string | null;
  }>;
  getAppUrl: () => string;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

function maskWorkspaceSecrets(workspace: any): any {
  return {
    ...workspace,
    api_key: workspace.api_key ? "***" : null,
    twilio_auth_token: workspace.twilio_auth_token ? "***" : null,
    openrouter_api_key: workspace.openrouter_api_key ? "***" : null,
    elevenlabs_api_key: workspace.elevenlabs_api_key ? "***" : null,
    gemini_api_key: workspace.gemini_api_key ? "***" : null,
  };
}

export function registerWorkspaceAdminRoutes(app: Express, deps: WorkspaceAdminRouteDeps): void {
  const { dashboardAuth, requireOperator, dbEnabled, provisionWorkspaceTelephony, getAppUrl, log } = deps;

  app.get("/api/workspaces", dashboardAuth, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.json({
        workspaces: [],
        plans: PLAN_LIMITS,
        currentWorkspaceId: null,
        customerMode: (req as any).authMode !== "operator",
      });
    }
    const workspaceAuth = (req as any).workspaceAuth;
    if (workspaceAuth) {
      const workspace = await getWorkspaceById(workspaceAuth.id);
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });
      return res.json({
        workspaces: [maskWorkspaceSecrets(workspace)],
        plans: PLAN_LIMITS,
        currentWorkspaceId: workspace.id,
        customerMode: true,
      });
    }

    if ((req as any).authMode !== "operator") {
      return res.status(403).json({ error: "Forbidden. Operator access required." });
    }

    const workspaces = await getWorkspaces();
    res.json({ workspaces: workspaces.map(maskWorkspaceSecrets), plans: PLAN_LIMITS });
  });

  app.post("/api/workspaces", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const { name, owner_email, plan, slug, mode, phone } = req.body;
    if (!name || !owner_email) return res.status(400).json({ error: "name and owner_email required" });
    const { workspace, ownerInvite } = await provisionWorkspace({ name, owner_email, plan, slug, mode });
    const shouldProvisionPhone = !!String(phone || "").trim();
    const telephony = shouldProvisionPhone
      ? await provisionWorkspaceTelephony(workspace.id, workspace.name, phone)
      : { phoneNumber: null, subaccountSid: null, phoneNumberSid: null };
    res.json({
      workspace: {
        ...workspace,
        phone_number: telephony.phoneNumber,
        twilio_subaccount_sid: telephony.subaccountSid,
        phone_number_sid: telephony.phoneNumberSid,
      },
      invite_link: `${getAppUrl()}/invite/${ownerInvite.invite_token}`,
      provisioned_phone_number: telephony.phoneNumber,
    });
  });

  app.get("/api/workspaces/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const workspace = await getWorkspaceById(id);
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });
      const stats = await getWorkspaceStats(id);
      const members = await getWorkspaceMembers(id);
      return res.json({ workspace, stats, members });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", "GET /api/workspaces/:id failed", {
        requestId: (req as any).requestId,
        workspaceId: req.params.id,
        error: message,
      });
      return res.status(500).json({ error: "Workspace details unavailable." });
    }
  });

  app.patch("/api/workspaces/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    await updateWorkspace(id, req.body);
    res.json({ success: true });
  });

  app.delete("/api/workspaces/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    await deleteWorkspace(id);
    res.json({ success: true });
  });

  app.post("/api/workspaces/:id/invite", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const { email, role } = req.body;
    if (!email) return res.status(400).json({ error: "email required" });
    const member = await inviteMember(id, email, role || "viewer");
    res.json({ member, invite_link: `${getAppUrl()}/invite/${member.invite_token}` });
  });

  app.get("/api/workspaces/:id/members", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const members = await getWorkspaceMembers(id);
      return res.json({ members });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", "GET /api/workspaces/:id/members failed", {
        requestId: (req as any).requestId,
        workspaceId: req.params.id,
        error: message,
      });
      return res.status(500).json({ error: "Workspace members unavailable." });
    }
  });

  app.delete("/api/workspaces/:id/members/:email", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    await removeMember(id, decodeURIComponent(req.params.email));
    res.json({ success: true });
  });

  app.get("/api/workspaces/:id/usage", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const limits = await checkUsageLimits(id);
      return res.json(limits);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", "GET /api/workspaces/:id/usage failed", {
        requestId: (req as any).requestId,
        workspaceId: req.params.id,
        error: message,
      });
      return res.status(500).json({ error: "Workspace usage unavailable." });
    }
  });

  app.get("/api/workspaces/:id/apikey", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const workspace = await getWorkspaceById(id);
      if (!workspace) return res.status(404).json({ error: "Not found" });
      return res.json({ id: workspace.id, api_key: workspace.api_key, slug: workspace.slug, owner_email: workspace.owner_email });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", "GET /api/workspaces/:id/apikey failed", {
        requestId: (req as any).requestId,
        workspaceId: req.params.id,
        error: message,
      });
      return res.status(500).json({ error: "Workspace API key unavailable." });
    }
  });
}
