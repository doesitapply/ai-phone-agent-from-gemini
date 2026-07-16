import type { Express, Request, RequestHandler, Response } from "express";
import {
  generatePersonalizedPitch,
  getLeads,
  saveCampaign,
  saveLead,
  searchLeadsApollo,
  searchLeadsGoogleMaps,
  type LeadSearchParams,
} from "../lead-hunter.js";
import { upsertLead, validateLeadInput, type LeadUpsertInput } from "../leads-upsert.js";
import { getCampaigns as getProspectingCampaigns } from "../prospector.js";
import { checkOutboundCompliance } from "../compliance.js";
import { handleSmirkChat, loadChatContext, type ChatMessage } from "../smirk-chat.js";

type LeadRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  sql: any;
  dbEnabled: boolean;
  getWorkspaceId: (req: Request) => number;
  getTwilioClient: () => any;
  getActiveAgent: () => Promise<{ id: number; name: string; system_prompt: string; greeting: string; voice: string; language: string; max_turns: number } | undefined>;
  getAppUrl: () => string;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

export function registerLeadRoutes(app: Express, deps: LeadRouteDeps): void {
  const {
    dashboardAuth,
    requireOperator,
    sql,
    dbEnabled,
    getWorkspaceId,
    getTwilioClient,
    getActiveAgent,
    getAppUrl,
    log,
  } = deps;

  app.post("/api/leads/search/apollo", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const params: LeadSearchParams = req.body;
      const leads = await searchLeadsApollo(params);
      res.json({ leads, count: leads.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/leads/search/maps", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const { query, location, radiusMiles, limit } = req.body;
      if (!query || !location) return res.status(400).json({ error: "query and location required" });
      const leads = await searchLeadsGoogleMaps(query, location, radiusMiles, limit);
      res.json({ leads, count: leads.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/leads", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) {
        return res.status(503).json({ error: "Database is not connected in this local environment." });
      }
      const workspaceId = getWorkspaceId(req);
      const { leads } = req.body as { leads: Parameters<typeof saveLead>[0][] };
      const ids: number[] = [];
      for (const lead of leads) {
        const id = await saveLead(lead, workspaceId);
        ids.push(id);
      }
      res.json({ saved: ids.length, ids });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/leads", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) {
        return res.json({ leads: [] });
      }
      const workspaceId = getWorkspaceId(req);
      const limit = parseInt(req.query.limit as string) || 100;
      const leads = await getLeads(workspaceId, limit);
      res.json({ leads });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/leads/upsert", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) {
        return res.status(503).json({ error: "Database is not connected in this local environment." });
      }
      const workspaceId = getWorkspaceId(req);
      const input: LeadUpsertInput = req.body;
      const validationError = validateLeadInput(input);
      if (validationError) return res.status(400).json({ error: validationError });
      const result = await upsertLead(input, workspaceId);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/leads/funnel", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) {
        const { isHubSpotConfigured } = await import("../crm.js");
        const { isCalendarConfigured } = await import("../gcal.js");
        const fromEmail = process.env.FROM_EMAIL || process.env.RESEND_FROM_EMAIL || "";
        const ownerEmail = process.env.OWNER_ALERT_EMAIL || process.env.OWNER_EMAIL || "";
        return res.json({
          funnel: {
            captured: 0,
            qualified: 0,
            booked: 0,
            follow_up_due: 0,
            closed: 0,
            total: 0,
            total_booked: 0,
            total_qualified: 0,
            hubspot_synced: 0,
            calendar_synced: 0,
            overdue_follow_ups: 0,
            captured_rate: 100,
            qualified_rate: 0,
            booked_rate: 0,
          },
          integrations: {
            hubspot: { configured: isHubSpotConfigured(), env_var: "HUBSPOT_ACCESS_TOKEN" },
            calendar: { configured: isCalendarConfigured(), env_var: "GOOGLE_SERVICE_ACCOUNT_JSON + GOOGLE_CALENDAR_ID" },
            notification: { configured: !!(process.env.RESEND_API_KEY && fromEmail && ownerEmail), env_var: "RESEND_API_KEY + FROM_EMAIL + OWNER_ALERT_EMAIL" },
          },
          noDbDemo: true,
        });
      }
      const workspaceId = getWorkspaceId(req);
      const rows = await sql`
        SELECT
          COUNT(*) FILTER (WHERE funnel_stage = 'captured')       AS captured,
          COUNT(*) FILTER (WHERE funnel_stage = 'qualified')      AS qualified,
          COUNT(*) FILTER (WHERE funnel_stage = 'booked')         AS booked,
          COUNT(*) FILTER (WHERE funnel_stage = 'follow_up_due')  AS follow_up_due,
          COUNT(*) FILTER (WHERE funnel_stage = 'closed')         AS closed,
          COUNT(*)                                                 AS total,
          COUNT(*) FILTER (WHERE booked_at IS NOT NULL)           AS total_booked,
          COUNT(*) FILTER (WHERE qualified_at IS NOT NULL)        AS total_qualified,
          COUNT(*) FILTER (WHERE hubspot_id IS NOT NULL)          AS hubspot_synced,
          COUNT(*) FILTER (WHERE calendar_event_id IS NOT NULL)   AS calendar_synced,
          COUNT(*) FILTER (WHERE follow_up_due_at IS NOT NULL
                             AND follow_up_due_at <= NOW()
                             AND funnel_stage != 'closed')        AS overdue_follow_ups
        FROM leads
        WHERE workspace_id = ${workspaceId}
      `;
      const kpi = rows[0] as Record<string, string>;
      const funnel = Object.fromEntries(
        Object.entries(kpi).map(([k, v]) => [k, Number(v)])
      );
      const total = funnel.total || 1;
      funnel.captured_rate = 100;
      funnel.qualified_rate = Math.round((funnel.total_qualified / total) * 100);
      funnel.booked_rate = Math.round((funnel.total_booked / total) * 100);
      const { isHubSpotConfigured } = await import("../crm.js");
      const { isCalendarConfigured } = await import("../gcal.js");
      const fromEmail = process.env.FROM_EMAIL || process.env.RESEND_FROM_EMAIL || "";
      const ownerEmail = process.env.OWNER_ALERT_EMAIL || process.env.OWNER_EMAIL || "";
      res.json({
        funnel,
        integrations: {
          hubspot: { configured: isHubSpotConfigured(), env_var: "HUBSPOT_ACCESS_TOKEN" },
          calendar: { configured: isCalendarConfigured(), env_var: "GOOGLE_SERVICE_ACCOUNT_JSON + GOOGLE_CALENDAR_ID" },
          notification: { configured: !!(process.env.RESEND_API_KEY && fromEmail && ownerEmail), env_var: "RESEND_API_KEY + FROM_EMAIL + OWNER_ALERT_EMAIL" },
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/leads/scoreboard", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const workspaceId = getWorkspaceId(req);
      const weeks = Math.min(Math.max(Number(req.query.weeks) || 1, 1), 52);
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - weeks * 7);
      const since = sinceDate.toISOString();
      if (!dbEnabled) {
        return res.json({
          period: { weeks, since },
          funnel: {
            captured: 0,
            qualified: 0,
            booked: 0,
            follow_up_due: 0,
            closed: 0,
            total: 0,
            total_booked: 0,
            overdue_follow_ups: 0,
            booked_rate: 0,
          },
          integrations: {
            hubspot: { configured: !!process.env.HUBSPOT_ACCESS_TOKEN, ok: 0, error: 0, skip: 0, error_rate_pct: 0 },
            calendar: { configured: !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_CALENDAR_ID), ok: 0, error: 0, skip: 0, error_rate_pct: 0 },
            notification: {
              configured: !!(process.env.RESEND_API_KEY && (process.env.FROM_EMAIL || process.env.RESEND_FROM_EMAIL) && (process.env.OWNER_ALERT_EMAIL || process.env.OWNER_EMAIL)),
              ok: 0,
              error: 0,
              skip: 0,
              error_rate_pct: 0,
            },
            rows_with_errors: 0,
          },
          recent_errors: [],
          generated_at: new Date().toISOString(),
          noDbDemo: true,
        });
      }

      const funnelRows = await sql`
        SELECT
          COUNT(*) FILTER (WHERE funnel_stage = 'captured')       AS captured,
          COUNT(*) FILTER (WHERE funnel_stage = 'qualified')      AS qualified,
          COUNT(*) FILTER (WHERE funnel_stage = 'booked')         AS booked,
          COUNT(*) FILTER (WHERE funnel_stage = 'follow_up_due')  AS follow_up_due,
          COUNT(*) FILTER (WHERE funnel_stage = 'closed')         AS closed,
          COUNT(*)                                                 AS total,
          COUNT(*) FILTER (WHERE booked_at IS NOT NULL)           AS total_booked,
          COUNT(*) FILTER (WHERE follow_up_due_at IS NOT NULL
                             AND follow_up_due_at <= NOW()
                             AND funnel_stage != 'closed')        AS overdue_follow_ups
        FROM leads
        WHERE workspace_id = ${workspaceId}
          AND created_at >= ${since}::timestamptz
      `;
      const kpi = funnelRows[0] as Record<string, string>;
      const funnel = Object.fromEntries(Object.entries(kpi).map(([k, v]) => [k, Number(v)]));
      const total = funnel.total || 1;
      funnel.booked_rate = Math.round((funnel.total_booked / total) * 100);

      const integRows = await sql`
        SELECT
          COUNT(*) FILTER (WHERE integration_status->>'hubspot'  = 'ok')    AS hs_ok,
          COUNT(*) FILTER (WHERE integration_status->>'hubspot'  = 'error') AS hs_error,
          COUNT(*) FILTER (WHERE integration_status->>'hubspot'  = 'skip')  AS hs_skip,
          COUNT(*) FILTER (WHERE integration_status->>'calendar' = 'ok')    AS cal_ok,
          COUNT(*) FILTER (WHERE integration_status->>'calendar' = 'error') AS cal_error,
          COUNT(*) FILTER (WHERE integration_status->>'calendar' = 'skip')  AS cal_skip,
          COUNT(*) FILTER (WHERE integration_status->>'notification'      = 'ok')    AS notification_ok,
          COUNT(*) FILTER (WHERE integration_status->>'notification'      = 'error') AS notification_error,
          COUNT(*) FILTER (WHERE integration_status->>'notification'      = 'skip')  AS notification_skip,
          COUNT(*) FILTER (WHERE last_error IS NOT NULL)                     AS rows_with_errors
        FROM leads
        WHERE workspace_id = ${workspaceId}
      `;
      const ir = integRows[0] as Record<string, string>;
      const n = (k: string) => Number(ir[k] ?? 0);

      const errorRate = (ok: number, err: number): number => {
        const attempts = ok + err;
        return attempts === 0 ? 0 : Math.round((err / attempts) * 100);
      };

      const integrations = {
        hubspot: {
          configured: !!(process.env.HUBSPOT_ACCESS_TOKEN),
          ok: n("hs_ok"), error: n("hs_error"), skip: n("hs_skip"),
          error_rate_pct: errorRate(n("hs_ok"), n("hs_error")),
        },
        calendar: {
          configured: !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_CALENDAR_ID),
          ok: n("cal_ok"), error: n("cal_error"), skip: n("cal_skip"),
          error_rate_pct: errorRate(n("cal_ok"), n("cal_error")),
        },
        notification: {
          configured: !!(process.env.RESEND_API_KEY && (process.env.FROM_EMAIL || process.env.RESEND_FROM_EMAIL) && (process.env.OWNER_ALERT_EMAIL || process.env.OWNER_EMAIL)),
          ok: n("notification_ok"), error: n("notification_error"), skip: n("notification_skip"),
          error_rate_pct: errorRate(n("notification_ok"), n("notification_error")),
        },
        rows_with_errors: n("rows_with_errors"),
      };

      const recentErrors = await sql`
        SELECT id, phone, name, funnel_stage, last_error, updated_at
        FROM leads
        WHERE workspace_id = ${workspaceId}
          AND last_error IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 10
      `;

      res.json({
        period: { weeks, since },
        funnel,
        integrations,
        recent_errors: recentErrors,
        generated_at: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/leads/personalize", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const { lead, campaignContext, agentName } = req.body;
      const pitch = await generatePersonalizedPitch(lead, campaignContext, agentName || "SMIRK");
      res.json({ pitch });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/leads/alerts", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) {
        return res.json({
          status: "ok",
          alert_count: 0,
          alerts: [],
          checked_at: new Date().toISOString(),
          window_hours: 24,
          noDbDemo: true,
        });
      }
      const workspaceId = getWorkspaceId(req);
      const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const alerts: Array<{ sev: string; code: string; message: string; count?: number }> = [];

      const notificationFailRows = await sql`
        SELECT COUNT(*) AS cnt
        FROM leads
        WHERE workspace_id = ${workspaceId}
          AND updated_at >= ${since24h}::timestamptz
          AND integration_status->>'notification' = 'error'
          AND last_error IS NOT NULL
      `;
      const notificationFailCount = Number((notificationFailRows[0] as any)?.cnt ?? 0);
      if (notificationFailCount > 0) {
        alerts.push({
          sev: "SEV1",
          code: "OWNER_NOTIFICATION_DELIVERY_FAILURE",
          message: `${notificationFailCount} lead(s) had owner notification failures in the last 24h. Check last_error for the failed owner email path.`,
          count: notificationFailCount,
        });
      }

      const orphanCallRows = await sql`
        SELECT COUNT(*) AS cnt
        FROM calls c
        WHERE c.workspace_id = ${workspaceId}
          AND c.status = 'completed'
          AND c.direction = 'inbound'
          AND c.contact_id IS NOT NULL
          AND c.started_at >= ${since24h}::timestamptz
          AND EXISTS (
            SELECT 1 FROM call_summaries s
            WHERE s.call_sid = c.call_sid
              AND s.extracted_entities->>'caller_name' IS NOT NULL
              AND s.extracted_entities->>'caller_name' != ''
          )
          AND NOT EXISTS (
            SELECT 1 FROM leads l
            WHERE l.workspace_id = c.workspace_id
              AND l.call_sid = c.call_sid
          )
      `;
      const orphanCount = Number((orphanCallRows[0] as any)?.cnt ?? 0);
      if (orphanCount > 0) {
        alerts.push({
          sev: "SEV1",
          code: "CALL_NO_LEAD_ROW",
          message: `${orphanCount} completed inbound call(s) in last 24h have no lead row. Post-call intelligence may have failed.`,
          count: orphanCount,
        });
      }

      const errThreshold = Number(req.query.error_threshold_pct ?? 10);
      const integRows = await sql`
        SELECT
          COUNT(*) FILTER (WHERE integration_status->>'notification' = 'ok')    AS notification_ok,
          COUNT(*) FILTER (WHERE integration_status->>'notification' = 'error') AS notification_error
        FROM leads
        WHERE workspace_id = ${workspaceId}
          AND updated_at >= ${since24h}::timestamptz
      `;
      const ir = integRows[0] as Record<string, string>;
      const notificationOk = Number(ir?.notification_ok ?? 0);
      const notificationErr = Number(ir?.notification_error ?? 0);
      const notificationAttempts = notificationOk + notificationErr;
      const notificationErrRate = notificationAttempts > 0 ? Math.round((notificationErr / notificationAttempts) * 100) : 0;
      if (notificationErrRate > errThreshold) {
        alerts.push({
          sev: "SEV1",
          code: "OWNER_NOTIFICATION_ERROR_RATE_HIGH",
          message: `Owner notification error rate ${notificationErrRate}% exceeds threshold ${errThreshold}% in last 24h.`,
          count: notificationErr,
        });
      }

      const overdueRows = await sql`
        SELECT COUNT(*) AS cnt
        FROM leads
        WHERE workspace_id = ${workspaceId}
          AND funnel_stage = 'follow_up_due'
          AND follow_up_due_at IS NOT NULL
          AND follow_up_due_at <= NOW() - INTERVAL '24 hours'
      `;
      const overdueCount = Number((overdueRows[0] as any)?.cnt ?? 0);
      if (overdueCount > 0) {
        alerts.push({
          sev: "SEV2",
          code: "FOLLOW_UP_OVERDUE",
          message: `${overdueCount} lead(s) have overdue follow-ups (>24h past due_at).`,
          count: overdueCount,
        });
      }

      const status = alerts.some(a => a.sev === "SEV1") ? "firing" :
        alerts.some(a => a.sev === "SEV2") ? "warning" : "ok";

      res.json({
        status,
        alert_count: alerts.length,
        alerts,
        checked_at: new Date().toISOString(),
        window_hours: 24,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/chat", dashboardAuth, async (req: Request, res: Response) => {
    try {
      const authMode = (req as any).authMode === "operator" ? "operator" : (req as any).authMode === "workspace" ? "workspace" : null;
      if (!authMode) {
        return res.status(401).json({ error: "Authentication required." });
      }
      const { messages, workspaceId } = req.body as { messages: ChatMessage[]; workspaceId?: number };
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "messages array required" });
      }
      const wsId = workspaceId || getWorkspaceId(req) || 1;
      const result = await handleSmirkChat(messages, wsId, { accessMode: authMode });
      res.json(result);
    } catch (err: any) {
      log("error", "SMIRK Chat failed", { error: err.message, stack: err.stack });
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/chat/debug-context", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const wsId = getWorkspaceId(req) || 1;
      const context = await loadChatContext(wsId);
      res.json({ workspaceId: wsId, context });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/campaigns", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) {
        return res.json({ campaigns: [] });
      }
      const campaigns = await getProspectingCampaigns();
      res.json({ campaigns });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", "GET /api/campaigns failed", {
        requestId: (req as any).requestId,
        error: message,
      });
      res.status(500).json({ error: "Campaigns unavailable." });
    }
  });

  app.post("/api/campaigns", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) {
        return res.status(503).json({ error: "Database is not connected in this local environment." });
      }
      const workspaceId = getWorkspaceId(req);
      const id = await saveCampaign(req.body, workspaceId);
      res.json({ id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", "POST /api/campaigns failed", {
        requestId: (req as any).requestId,
        error: message,
      });
      res.status(500).json({ error: "Campaign could not be saved." });
    }
  });

  app.post("/api/campaigns/:id/launch", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) {
        return res.status(503).json({ error: "Database is not connected in this local environment." });
      }
      const workspaceId = getWorkspaceId(req);
      const campaignId = parseInt(req.params.id);
      const [campaign] = await sql`SELECT * FROM campaigns WHERE id = ${campaignId} AND workspace_id = ${workspaceId}`;
      if (!campaign) return res.status(404).json({ error: "Campaign not found" });

      const leads = await sql`SELECT * FROM leads WHERE campaign_id = ${campaignId} AND workspace_id = ${workspaceId} AND phone IS NOT NULL AND status = 'new'`;

      if (!leads.length) return res.status(400).json({ error: "No callable leads in this campaign" });

      await sql`UPDATE campaigns SET status = 'active', updated_at = NOW() WHERE id = ${campaignId}`;

      res.json({ launched: true, leadsQueued: leads.length });

      (async () => {
        const twilioClient = getTwilioClient();
        for (const lead of leads) {
          if (!lead.phone) continue;
          try {
            const compliance = await checkOutboundCompliance(lead.phone);
            if (!compliance.allowed) {
              log("warn", "Campaign lead skipped by compliance gate", {
                leadId: lead.id,
                phone: lead.phone,
                reason: compliance.reason,
                blockedReason: compliance.blockedReason,
                nextValidWindow: compliance.nextValidWindow?.toISOString(),
              });
              if (compliance.nextValidWindow) {
                await sql`
                  UPDATE leads
                  SET status = 'queued',
                      notes = COALESCE(notes, '') || ${`\n[BLOCKED ${new Date().toISOString()}] ${compliance.reason} - retry after ${compliance.nextValidWindow.toISOString()}`}
                  WHERE id = ${lead.id}
                `;
              }
              continue;
            }

            const pitch = await generatePersonalizedPitch(
              { name: lead.name, company: lead.company, title: lead.title, industry: lead.industry, location: lead.location, source: "apollo" },
              campaign.pitch_template,
              "SMIRK"
            );

            const agent = campaign.agent_id
              ? (await sql`SELECT name FROM agent_configs WHERE id = ${campaign.agent_id}`)[0]
              : await getActiveAgent();
            void agent;

            await twilioClient.calls.create({
              to: lead.phone,
              from: process.env.TWILIO_PHONE_NUMBER!,
              url: `${getAppUrl()}/api/twilio/incoming?agentId=${campaign.agent_id || ""}&reason=${encodeURIComponent(campaign.call_reason)}&notes=${encodeURIComponent(pitch)}`,
              statusCallback: `${getAppUrl()}/api/twilio/status`,
              statusCallbackMethod: "POST",
            });

            await sql`UPDATE leads SET status = 'contacted', last_contacted = NOW() WHERE id = ${lead.id}`;

            await new Promise(resolve => setTimeout(resolve, 30_000));
          } catch (err: any) {
            log("error", "Campaign call failed", { leadId: lead.id, error: err.message });
          }
        }
        await sql`UPDATE campaigns SET status = 'completed', updated_at = NOW() WHERE id = ${campaignId}`;
      })();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", "POST /api/campaigns/:id/launch failed", {
        requestId: (req as any).requestId,
        campaignId: req.params.id,
        error: message,
      });
      res.status(500).json({ error: "Campaign could not be launched." });
    }
  });
}
