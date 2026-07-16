import type { Express, Request, RequestHandler, Response } from "express";
import type { Lead } from "../lead-hunter.js";
import { aiQualifyLeads, SCORE_GATE_SAVE } from "../lead-hunter.js";
import {
  addLeads,
  createCampaign,
  dialNextLead,
  findBusinessesViaPlaces,
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
  scheduleFollowUpSteps,
} from "../sequence-engine.js";

type SqlClient = <T = any>(strings: TemplateStringsArray, ...values: any[]) => Promise<T>;

type ProspectingRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  sql: SqlClient;
  dbEnabled: boolean;
  env: {
    CALENDLY_URL?: string;
    TWILIO_PHONE_NUMBER?: string;
  };
  log: (level: string, message: string, meta?: Record<string, unknown>) => void;
  getTwilioClient: () => any;
  getAppUrl: () => string;
};

const autoDialState = new Map<number, { active: boolean; callsThisSession: number; lastCallAt: number }>();

export function registerProspectingRoutes(app: Express, deps: ProspectingRouteDeps): void {
  const {
    dashboardAuth,
    requireOperator,
    sql,
    dbEnabled,
    env,
    log,
    getTwilioClient,
    getAppUrl,
  } = deps;

  app.get("/api/prospecting/campaigns", dashboardAuth, requireOperator, async (_req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.json({ campaigns: [] });
    }
    const campaigns = await getProspectingCampaigns();
    res.json({ campaigns });
  });

  app.post("/api/prospecting/campaigns", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.status(503).json({ error: "Database is not connected in this local environment." });
    }
    const campaign = await createCampaign(req.body);
    res.json({ campaign });
  });

  app.get("/api/prospecting/campaigns/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    if (!dbEnabled) return res.status(404).json({ error: "Campaign not found" });
    const campaign = await getCampaignById(id);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    const leads = await getProspectLeads(id);
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
    const { status } = req.body;
    await updateCampaignStatus(id, status);
    res.json({ success: true });
  });

  app.get("/api/prospecting/leads", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.json({ leads: [] });
    }
    const campaignId = req.query.campaign_id ? parseInt(req.query.campaign_id as string) : undefined;
    const status = req.query.status as string | undefined;
    const leads = await getProspectLeads(campaignId, status);
    res.json({ leads });
  });

  app.post("/api/prospecting/campaigns/:id/leads", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.status(503).json({ error: "Database is not connected in this local environment." });
    }
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const { leads, csv } = req.body;
    let parsedLeads: any[] = leads || [];
    if (csv) parsedLeads = [...parsedLeads, ...parseLeadsCsv(csv)];
    const added = await addLeads(id, parsedLeads);
    res.json({ added });
  });

  app.post("/api/prospecting/campaigns/:id/search", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.status(503).json({ error: "Database is not connected in this local environment." });
    }
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const { query, location, radius, maxResults } = req.body;
    if (!query) return res.status(400).json({ error: "query required (e.g. 'plumbers in Miami FL')" });
    try {
      const rawFound = await findBusinessesViaPlaces({ query, location, radius, maxResults });
      const leadsForQualification: Lead[] = rawFound.map((lead) => ({
        name: lead.contact_name || lead.business_name,
        company: lead.business_name,
        phone: lead.phone,
        email: undefined,
        title: lead.contact_title || "Owner",
        industry: lead.industry || undefined,
        location: [lead.city, lead.state].filter(Boolean).join(", ") || lead.address || undefined,
        website: lead.website || undefined,
        score: (lead as any).score,
        source: "google_maps" as const,
      }));
      const qualified = await aiQualifyLeads(leadsForQualification, SCORE_GATE_SAVE);
      const enrichedLeads = rawFound
        .map((lead) => {
          const qualifiedLead = qualified.find((item) => item.phone === lead.phone);
          if (!qualifiedLead) return null;
          return { ...lead, score: qualifiedLead.score, personalized_hook: qualifiedLead.personalizedHook };
        })
        .filter(Boolean) as typeof rawFound;
      const added = await addLeads(id, enrichedLeads);
      res.json({ found: rawFound.length, qualified: enrichedLeads.length, added, leads: enrichedLeads });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/prospecting/leads/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.status(503).json({ error: "Database is not connected in this local environment." });
    }
    const id = parseInt(req.params.id);
    const { status, call_sid, notes } = req.body;
    await updateLeadStatus(id, status, call_sid, notes);
    if (dbEnabled && ["voicemail", "no_answer", "callback"].includes(status)) {
      try {
        const [lead] = await sql<{ campaign_id: number }[]>`SELECT campaign_id FROM prospect_leads WHERE id = ${id}`;
        if (lead?.campaign_id) {
          const scheduled = await scheduleFollowUpSteps(lead.campaign_id, id, status);
          log("info", "Sequence steps scheduled", { leadId: id, status, scheduled });
        }
      } catch (err: any) {
        log("warn", "Failed to schedule follow-up steps", { leadId: id, error: err.message });
      }
    }

    if (dbEnabled && status === "interested") {
      try {
        const [lead] = await sql<{ phone: string; email: string | null; business_name: string; contact_name: string | null; personalized_hook: string | null; campaign_id: number }[]>`
          SELECT phone, email, business_name, contact_name, personalized_hook, campaign_id FROM prospect_leads WHERE id = ${id}
        `;
        if (lead) {
          const setupHelpLink = process.env.BOOKING_LINK || env.CALENDLY_URL || process.env.CALENDLY_URL || "https://calendly.com/smirk-demo";
          const name = lead.contact_name || lead.business_name || "there";
          const company = lead.business_name || "your business";
          const fromName = process.env.FROM_NAME || "SMIRK AI";
          const resendKey = process.env.RESEND_API_KEY;
          const fromEmail = process.env.FROM_EMAIL;
          if (resendKey && fromEmail && lead.email) {
            const subject = `Great talking with you, ${name} - here's your setup-help link`;
            const body = `Hi ${name},\n\nThanks for chatting with us today! You mentioned ${company} could use a hand with missed calls - that's exactly what SMIRK was built for.\n\nHere's the setup-help link so we can confirm the right next step:\n${setupHelpLink}\n\nWe'll show you how SMIRK answers missed calls, captures caller details, emails you callback-ready leads, and creates callback tasks so good jobs do not disappear into voicemail.\n\nTalk soon,\n${fromName}`;
            const resp = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                from: `${fromName} <${fromEmail}>`,
                to: [lead.email],
                subject,
                text: body,
                html: body.split("\n").map((line: string) => line ? `<p>${line}</p>` : "<br>").join(""),
              }),
            });
            if (resp.ok) {
              log("info", "Interested lead setup-help email sent", { leadId: id, email: lead.email });
            } else {
              const error = await resp.text();
              log("warn", "Interested lead setup-help email failed", { leadId: id, error });
            }
          } else if (!lead.email) {
            log("info", "Interested lead has no email - scheduling follow-up call", { leadId: id });
          }
          if (lead.campaign_id) {
            await sql`
              INSERT INTO prospect_sequence_steps (campaign_id, lead_id, step_number, step_type, delay_hours, status, scheduled_at, created_at)
              VALUES (${lead.campaign_id}, ${id}, 99, 'call', 24, 'pending',
                NOW() + INTERVAL '24 hours', NOW())
              ON CONFLICT DO NOTHING
            `;
            log("info", "Follow-up call scheduled in 24h for interested lead", { leadId: id });
          }
        }
      } catch (err: any) {
            log("warn", "Interested lead setup-help automation failed", { leadId: id, error: err.message });
      }
    }

    res.json({ success: true });
  });

  app.post("/api/prospecting/campaigns/:id/dial-next", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.status(503).json({ error: "Database is not connected in this local environment." });
    }
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    const twilioClient = getTwilioClient();
    if (!twilioClient) return res.status(400).json({ error: "Twilio not configured" });
    if (!env.TWILIO_PHONE_NUMBER) return res.status(400).json({ error: "TWILIO_PHONE_NUMBER not configured" });

    try {
      const result = await dialNextLead(id, twilioClient, env.TWILIO_PHONE_NUMBER, getAppUrl());
      if ("blocked" in result) {
        return res.status(403).json({ error: result.reason, blocked: true });
      }
      res.json({ success: true, call_sid: result.callSid, lead: result.lead, pitch: (result as any).pitch });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/prospecting/campaigns/:id/auto-dial/start", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.status(503).json({ error: "Database is not connected in this local environment." });
    }
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const twilioClient = getTwilioClient();
    if (!twilioClient) return res.status(400).json({ error: "Twilio not configured" });
    if (!env.TWILIO_PHONE_NUMBER) return res.status(400).json({ error: "TWILIO_PHONE_NUMBER not configured" });
    if (autoDialState.get(id)?.active) return res.json({ success: true, message: "Auto-dial already running" });

    autoDialState.set(id, { active: true, callsThisSession: 0, lastCallAt: 0 });
    res.json({ success: true, message: "Auto-dial started" });

    (async () => {
      const interCallDelayMs = 35_000;
      const maxCallsPerSession = 100;
      let consecutiveBlocks = 0;
      while (true) {
        const state = autoDialState.get(id);
        if (!state?.active) break;
        if (state.callsThisSession >= maxCallsPerSession) {
          log("info", "Auto-dial session limit reached", { campaignId: id });
          break;
        }
        try {
          const result = await dialNextLead(id, twilioClient, env.TWILIO_PHONE_NUMBER!, getAppUrl());
          if ("blocked" in result) {
            consecutiveBlocks++;
            if (consecutiveBlocks >= 3) {
              log("info", "Auto-dial: 3 consecutive blocks, stopping", { campaignId: id });
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 60_000));
            continue;
          }
          consecutiveBlocks = 0;
          state.callsThisSession++;
          state.lastCallAt = Date.now();
          log("info", "Auto-dial: call placed", { campaignId: id, leadId: result.lead.id, callSid: result.callSid });
          await new Promise((resolve) => setTimeout(resolve, interCallDelayMs));
        } catch (err: any) {
          if (err.message === "No pending leads in this campaign") {
            log("info", "Auto-dial: no more leads", { campaignId: id });
            break;
          }
          log("error", "Auto-dial error", { campaignId: id, error: err.message });
          await new Promise((resolve) => setTimeout(resolve, 10_000));
        }
      }
      const state = autoDialState.get(id);
      if (state) state.active = false;
      log("info", "Auto-dial loop ended", { campaignId: id, totalCalls: state?.callsThisSession });
    })();
  });

  app.post("/api/prospecting/campaigns/:id/auto-dial/stop", dashboardAuth, requireOperator, (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const state = autoDialState.get(id);
    if (state) state.active = false;
    res.json({ success: true, callsThisSession: state?.callsThisSession ?? 0 });
  });

  app.get("/api/prospecting/campaigns/:id/auto-dial/status", dashboardAuth, requireOperator, (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const state = autoDialState.get(id);
    res.json({ active: state?.active ?? false, callsThisSession: state?.callsThisSession ?? 0, lastCallAt: state?.lastCallAt ? new Date(state.lastCallAt).toISOString() : null });
  });

  app.get("/api/prospecting/sequences/stats", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.json({ total: 0, pending: 0, sent: 0, failed: 0, skipped: 0 });
    }
    const campaignId = req.query.campaign_id ? parseInt(req.query.campaign_id as string) : undefined;
    const stats = await getSequenceStats(campaignId);
    res.json(stats);
  });

  app.get("/api/prospecting/leads/:id/sequence", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.json({ steps: [] });
    }
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const steps = await getLeadSequenceSteps(id);
    res.json({ steps });
  });

  app.delete("/api/prospecting/leads/:id/sequence", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.status(503).json({ error: "Database is not connected in this local environment." });
    }
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    await cancelLeadSequence(id);
    res.json({ success: true });
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
