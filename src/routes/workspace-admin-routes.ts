import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import {
  checkUsageLimits,
  createActivationEvent,
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
import { getMockWorkspaces } from "../mock-db.js";
import { resolveTrustedProductionAppOrigin } from "../public-url-safety.js";
import { hasWorkspaceBillingEntitlement } from "../billing-safety.js";

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

function redactWorkspaceMember(member: any): any {
  const { invite_token: _inviteToken, ...safeMember } = member || {};
  return safeMember;
}

export function registerWorkspaceAdminRoutes(app: Express, deps: WorkspaceAdminRouteDeps): void {
  const { dashboardAuth, requireOperator, dbEnabled, provisionWorkspaceTelephony, getAppUrl, log } = deps;
  const trustedInviteOrigin = () => resolveTrustedProductionAppOrigin(process.env.APP_URL, getAppUrl());
  const auditOperatorWorkspaceAction = async (req: Request, workspaceId: number, eventType: string, detail: Record<string, unknown> = {}) => {
    await createActivationEvent({
      workspace_id: workspaceId,
      event_type: eventType,
      status: "info",
      actor: "operator",
      detail: {
        auth_mode: String((req as any).authMode || "operator"),
        auth_provenance: "operator_api_key",
        request_id: String((req as any).requestId || "") || null,
        ...detail,
      },
    });
  };

  app.get("/api/workspaces", dashboardAuth, async (req: Request, res: Response) => {
    const isOperatorAccess = (req as any).authMode === "operator" || (req as any).authMode === "demo_operator";
    if (!dbEnabled) {
      const workspaces = getMockWorkspaces().map(maskWorkspaceSecrets);
      return res.json({
        workspaces,
        plans: PLAN_LIMITS,
        currentWorkspaceId: workspaces[0]?.id || null,
        customerMode: !isOperatorAccess,
        noDbDemo: true,
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

    if (!isOperatorAccess) {
      return res.status(403).json({ error: "Forbidden. Operator access required." });
    }

    const workspaces = await getWorkspaces();
    res.json({ workspaces: workspaces.map(maskWorkspaceSecrets), plans: PLAN_LIMITS });
  });

  app.post("/api/workspaces", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.status(503).json({ error: "Database is not connected in this local environment." });
    }
    const { name, owner_email, plan, slug, mode, phone } = req.body;
    if (!name || !owner_email) return res.status(400).json({ error: "name and owner_email required" });
    const { workspace, ownerInvite } = await provisionWorkspace({ name, owner_email, plan, slug, mode });
    const shouldProvisionPhone = !!String(phone || "").trim();
    const telephony = shouldProvisionPhone
      ? await provisionWorkspaceTelephony(workspace.id, workspace.name, phone)
      : { phoneNumber: null, subaccountSid: null, phoneNumberSid: null };
    res.json({
      workspace: maskWorkspaceSecrets({
        ...workspace,
        phone_number: telephony.phoneNumber,
        twilio_subaccount_sid: telephony.subaccountSid,
        phone_number_sid: telephony.phoneNumberSid,
      }),
      invite_link: `${trustedInviteOrigin()}/invite/${ownerInvite.invite_token}`,
      provisioned_phone_number: telephony.phoneNumber,
    });
  });

  app.get("/api/workspaces/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      if (!dbEnabled) {
        const workspace = getMockWorkspaces().find((item) => Number(item.id) === id) as any;
        if (!workspace) return res.status(404).json({ error: "Workspace not found" });
        return res.json({
          workspace: maskWorkspaceSecrets(workspace),
          stats: {
            totalCalls: 0,
            callsThisMonth: workspace.calls_this_month || 0,
            minutesThisMonth: workspace.minutes_this_month || 0,
            totalContacts: 0,
            openTasks: 0,
            upcomingAppointments: 0,
            recentCalls: [],
          },
          members: [],
          noDbDemo: true,
        });
      }
      const workspace = await getWorkspaceById(id);
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });
      const stats = await getWorkspaceStats(id);
      const members = await getWorkspaceMembers(id);
      return res.json({
        workspace: maskWorkspaceSecrets(workspace),
        stats,
        members: members.map(redactWorkspaceMember),
      });
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
    if (!dbEnabled) {
      return res.status(503).json({ error: "Database is not connected in this local environment." });
    }
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    await auditOperatorWorkspaceAction(req, id, "operator_workspace_update_requested", {
      changed_fields: Object.keys(req.body || {}).sort(),
    });
    await updateWorkspace(id, req.body);
    res.json({ success: true });
  });

  app.delete("/api/workspaces/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.status(503).json({ error: "Database is not connected in this local environment." });
    }
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    await deleteWorkspace(id);
    res.json({ success: true });
  });

  app.post("/api/workspaces/:id/invite", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.status(503).json({ error: "Database is not connected in this local environment." });
    }
    const id = parseInt(req.params.id);
    const { email, role } = req.body;
    if (!email) return res.status(400).json({ error: "email required" });
    await auditOperatorWorkspaceAction(req, id, "operator_workspace_invite_requested", {
      invited_role: String(role || "viewer"),
    });
    const member = await inviteMember(id, email, role || "viewer");
    res.json({ member: redactWorkspaceMember(member), invite_link: `${trustedInviteOrigin()}/invite/${member.invite_token}` });
  });

  app.get("/api/workspaces/:id/members", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      if (!dbEnabled) {
        return res.json({ members: [] });
      }
      const members = await getWorkspaceMembers(id);
      return res.json({ members: members.map(redactWorkspaceMember) });
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
    if (!dbEnabled) {
      return res.status(503).json({ error: "Database is not connected in this local environment." });
    }
    const id = parseInt(req.params.id);
    await auditOperatorWorkspaceAction(req, id, "operator_workspace_member_removal_requested");
    await removeMember(id, decodeURIComponent(req.params.email));
    res.json({ success: true });
  });

  app.get("/api/workspaces/:id/usage", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      if (!dbEnabled) {
        const workspace = getMockWorkspaces().find((item) => Number(item.id) === id) as any;
        if (!workspace) return res.status(404).json({ error: "Workspace not found" });
        return res.json({
          allowed: true,
          calls_this_month: workspace.calls_this_month || 0,
          monthly_call_limit: workspace.monthly_call_limit || 0,
          minutes_this_month: workspace.minutes_this_month || 0,
          monthly_minute_limit: workspace.monthly_minute_limit || 0,
          callsUsed: workspace.calls_this_month || 0,
          callsLimit: workspace.monthly_call_limit || 0,
          minutesUsed: workspace.minutes_this_month || 0,
          minutesLimit: workspace.monthly_minute_limit || 0,
          noDbDemo: true,
        });
      }
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

  app.get("/api/workspaces/:id/entitlement-probe", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const workspace = dbEnabled
        ? await getWorkspaceById(id)
        : getMockWorkspaces().find((item) => Number(item.id) === id) as any;
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });
      const normalizedPlan = String(workspace.plan || "").trim().toLowerCase();
      const expectedTier = ["pro", "enterprise", "agency"].includes(normalizedPlan) ? "pro" : "basic";
      const billingEntitled = hasWorkspaceBillingEntitlement(workspace.plan, workspace.subscription_status);
      const basicStatus = billingEntitled ? 200 : 402;
      const proStatus = billingEntitled ? (expectedTier === "pro" ? 200 : 403) : 402;
      return res.json({
        ok: true,
        workspace: {
          id: workspace.id,
          slug: workspace.slug || null,
          plan: workspace.plan || null,
          subscription_status: workspace.subscription_status || null,
          mode: workspace.mode || null,
        },
        expected_tier: expectedTier,
        billing_entitled: billingEntitled,
        route_access: {
          "/api/calls": basicStatus,
          "/api/contacts": basicStatus,
          "/api/tasks": basicStatus,
          "/api/stats": proStatus,
          "/api/workspace-overview": proStatus,
          "/api/recovery/queue": proStatus,
          "/api/handoffs": proStatus,
        },
        credential_revealed: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", "GET /api/workspaces/:id/entitlement-probe failed", {
        requestId: (req as any).requestId,
        workspaceId: req.params.id,
        error: message,
      });
      return res.status(500).json({ error: "Workspace entitlement probe unavailable." });
    }
  });

  app.get("/api/workspaces/:id/apikey", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      if (!dbEnabled) {
        return res.status(503).json({ error: "Workspace API key reveal requires durable audit storage." });
      }
      const workspace = await getWorkspaceById(id);
      if (!workspace) return res.status(404).json({ error: "Not found" });
      await auditOperatorWorkspaceAction(req, id, "workspace_api_key_revealed_by_operator", {
        support_reason: String(req.headers["x-smirk-support-reason"] || "").trim().slice(0, 240) || null,
      });
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
