import type { Express, Request, RequestHandler, Response } from "express";
import {
  addLeads,
  createCampaign,
  getCampaignById,
  getCampaigns as getProspectingCampaigns,
  getLeads as getProspectLeads,
  parseLeadsCsv,
  updateCampaignStatus,
  updateLeadStatus,
} from "../prospector.js";
import {
  cancelLeadSequence,
  DEFAULT_SEQUENCES,
  getLeadSequenceSteps,
  getSequenceStats,
} from "../sequence-engine.js";

type SqlClient = <T = any>(strings: TemplateStringsArray, ...values: any[]) => Promise<T>;

type ProspectingRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  sql: SqlClient;
  dbEnabled: boolean;
  getWorkspaceId: (req: Request) => number;
};

const CAMPAIGN_STATUSES = new Set(["draft", "active", "paused", "completed"]);
const LEAD_STATUSES = new Set([
  "pending",
  "calling",
  "interested",
  "not_interested",
  "voicemail",
  "dnc",
  "no_answer",
  "callback",
  "contacted",
  "converted",
]);

const CONTACT_APPROVAL_REQUIRED = {
  error: "Prospect contact is disabled. Prepare a recipient-specific draft for human review.",
  code: "PROSPECTING_CONTACT_APPROVAL_REQUIRED",
  externalAction: "blocked",
};

const RESEARCH_APPROVAL_REQUIRED = {
  error: "Paid prospect research is disabled until a bounded spend approval is recorded.",
  code: "PROSPECTING_RESEARCH_APPROVAL_REQUIRED",
  externalAction: "blocked",
};

export function registerProspectingRoutes(app: Express, deps: ProspectingRouteDeps): void {
  const {
    dashboardAuth,
    requireOperator,
    sql,
    dbEnabled,
    getWorkspaceId,
  } = deps;

  app.get("/api/prospecting/campaigns", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.json({ campaigns: [] });
    }
    const campaigns = await getProspectingCampaigns(getWorkspaceId(req));
    res.json({ campaigns });
  });

  app.post("/api/prospecting/campaigns", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.status(503).json({ error: "Database is not connected in this local environment." });
    }
    const campaign = await createCampaign(req.body, getWorkspaceId(req));
    res.json({ campaign });
  });

  app.get("/api/prospecting/campaigns/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    if (!dbEnabled) return res.status(404).json({ error: "Campaign not found" });
    const workspaceId = getWorkspaceId(req);
    const campaign = await getCampaignById(id, workspaceId);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    const leads = await getProspectLeads(workspaceId, id);
    const funnelRows = await sql<{ status: string; count: string }[]>`
      SELECT status, COUNT(*) as count FROM prospect_leads
      WHERE campaign_id = ${id}
      GROUP BY status
    `;
    const funnelMap: Record<string, number> = {};
    for (const r of funnelRows) funnelMap[r.status] = parseInt(r.count);
    const funnel = {
      total: leads.length,
      pending: funnelMap["pending"] || 0,
      calling: funnelMap["calling"] || 0,
      dialed: (funnelMap["voicemail"] || 0) + (funnelMap["no_answer"] || 0) + (funnelMap["not_interested"] || 0) + (funnelMap["interested"] || 0) + (funnelMap["callback"] || 0) + (funnelMap["dnc"] || 0) + (funnelMap["contacted"] || 0),
      answered: (funnelMap["not_interested"] || 0) + (funnelMap["interested"] || 0) + (funnelMap["callback"] || 0),
      interested: funnelMap["interested"] || 0,
      voicemail: funnelMap["voicemail"] || 0,
      not_interested: funnelMap["not_interested"] || 0,
      callback: funnelMap["callback"] || 0,
      dnc: funnelMap["dnc"] || 0,
      converted: funnelMap["converted"] || 0,
    };
    res.json({ campaign, leads, funnel });
  });

  app.patch("/api/prospecting/campaigns/:id/status", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.status(503).json({ error: "Database is not connected in this local environment." });
    }
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const status = String(req.body?.status || "");
    if (!CAMPAIGN_STATUSES.has(status)) return res.status(400).json({ error: "Invalid campaign status" });
    const updated = await updateCampaignStatus(id, status as any, getWorkspaceId(req));
    if (!updated) return res.status(404).json({ error: "Campaign not found" });
    res.json({ success: true });
  });

  app.get("/api/prospecting/leads", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.json({ leads: [] });
    }
    const campaignId = req.query.campaign_id ? parseInt(req.query.campaign_id as string) : undefined;
    const status = req.query.status as string | undefined;
    if (campaignId !== undefined && isNaN(campaignId)) return res.status(400).json({ error: "Invalid campaign ID" });
    if (status && !LEAD_STATUSES.has(status)) return res.status(400).json({ error: "Invalid lead status" });
    const leads = await getProspectLeads(getWorkspaceId(req), campaignId, status);
    res.json({ leads });
  });

  app.post("/api/prospecting/campaigns/:id/leads", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.status(503).json({ error: "Database is not connected in this local environment." });
    }
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const { leads, csv } = req.body;
    if (leads !== undefined && !Array.isArray(leads)) {
      return res.status(400).json({ error: "leads must be an array" });
    }
    if (csv !== undefined && typeof csv !== "string") {
      return res.status(400).json({ error: "csv must be a string" });
    }
    if (typeof csv === "string" && csv.length > 250_000) {
      return res.status(413).json({ error: "CSV import is too large" });
    }
    let parsedLeads: any[] = leads || [];
    if (csv) parsedLeads = [...parsedLeads, ...parseLeadsCsv(csv)];
    if (parsedLeads.length > 200) {
      return res.status(413).json({ error: "A single research import is limited to 200 prospects" });
    }
    try {
      const added = await addLeads(id, parsedLeads, getWorkspaceId(req));
      res.json({ added });
    } catch (err: any) {
      if (err?.message === "Campaign not found") return res.status(404).json({ error: "Campaign not found" });
      throw err;
    }
  });

  app.post("/api/prospecting/campaigns/:id/search", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    if (!dbEnabled) return res.status(503).json({ error: "Database is not connected in this local environment." });
    const campaign = await getCampaignById(id, getWorkspaceId(req));
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    return res.status(409).json(RESEARCH_APPROVAL_REQUIRED);
  });

  app.patch("/api/prospecting/leads/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.status(503).json({ error: "Database is not connected in this local environment." });
    }
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const status = String(req.body?.status || "");
    if (!LEAD_STATUSES.has(status)) return res.status(400).json({ error: "Invalid lead status" });
    const updated = await updateLeadStatus(
      id,
      status as any,
      getWorkspaceId(req),
      req.body?.call_sid,
      req.body?.notes
    );
    if (!updated) return res.status(404).json({ error: "Lead not found" });
    res.json({ success: true, externalActions: "not_scheduled" });
  });

  app.post("/api/prospecting/campaigns/:id/dial-next", dashboardAuth, requireOperator, (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    return res.status(409).json(CONTACT_APPROVAL_REQUIRED);
  });

  app.post("/api/prospecting/campaigns/:id/auto-dial/start", dashboardAuth, requireOperator, (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    return res.status(409).json(CONTACT_APPROVAL_REQUIRED);
  });

  app.post("/api/prospecting/campaigns/:id/auto-dial/stop", dashboardAuth, requireOperator, (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    res.json({ success: true, active: false, callsThisSession: 0 });
  });

  app.get("/api/prospecting/campaigns/:id/auto-dial/status", dashboardAuth, requireOperator, (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    res.json({ active: false, callsThisSession: 0, lastCallAt: null, code: "PROSPECTING_CONTACT_DISABLED" });
  });

  app.get("/api/prospecting/sequences/stats", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.json({ total: 0, pending: 0, sent: 0, failed: 0, skipped: 0 });
    }
    const campaignId = req.query.campaign_id ? parseInt(req.query.campaign_id as string) : undefined;
    if (campaignId !== undefined && isNaN(campaignId)) return res.status(400).json({ error: "Invalid campaign ID" });
    const stats = await getSequenceStats(getWorkspaceId(req), campaignId);
    res.json(stats);
  });

  app.get("/api/prospecting/leads/:id/sequence", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.json({ steps: [] });
    }
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const steps = await getLeadSequenceSteps(id, getWorkspaceId(req));
    res.json({ steps });
  });

  app.delete("/api/prospecting/leads/:id/sequence", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.status(503).json({ error: "Database is not connected in this local environment." });
    }
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const cancelled = await cancelLeadSequence(id, getWorkspaceId(req));
    res.json({ success: true, cancelled });
  });

  app.get("/api/prospecting/sequence-templates", dashboardAuth, requireOperator, (_req: Request, res: Response) => {
    const templates = Object.entries(DEFAULT_SEQUENCES).map(([key, template]) => ({
      key,
      stepCount: template.steps.length,
      steps: template.steps.map((step) => ({ step_number: step.step_number, step_type: step.step_type, delay_hours: step.delay_hours })),
    }));
    res.json({ templates });
  });
}
