import type { Express, Request, RequestHandler, Response } from "express";
import {
  SMS_LIVE_CONFIRMATION,
  getSmsSafetyConfigForDisplay,
  handleIncomingSms,
  normalizeSmsPhone,
  sendGuardedSms,
} from "../sms-guardrails.js";
import { storeSms } from "../sms.js";

type SmsRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  validateTwilio: RequestHandler;
  sql: any;
  dbEnabled: boolean;
  env: {
    TWILIO_PHONE_NUMBER?: string;
  };
  getWorkspaceId: (req: Request) => number;
  getWorkspaceIdByToNumber: (toNumber: string) => Promise<number | null>;
  getTwilioClient: () => any;
  getAppUrl: () => string;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

export function registerSmsRoutes(app: Express, deps: SmsRouteDeps): void {
  const {
    dashboardAuth,
    requireOperator,
    validateTwilio,
    sql,
    dbEnabled,
    env,
    getWorkspaceId,
    getWorkspaceIdByToNumber,
    getTwilioClient,
    getAppUrl,
    log,
  } = deps;

  app.get("/api/sms/safety", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const workspaceId = getWorkspaceId(req);
    const safety = getSmsSafetyConfigForDisplay();
    if (!dbEnabled) {
      return res.json({
        ...safety,
        dbEnabled: false,
        recent: { outbound24h: 0, blocked24h: 0, dryRun24h: 0 },
      });
    }

    const rows = await sql<{ outbound24h: string; blocked24h: string; dryRun24h: string }[]>`
      SELECT
        COUNT(*) FILTER (WHERE direction = 'outbound' AND created_at >= NOW() - INTERVAL '24 hours')::text as outbound24h,
        COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'blocked' AND created_at >= NOW() - INTERVAL '24 hours')::text as blocked24h,
        COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'dry_run' AND created_at >= NOW() - INTERVAL '24 hours')::text as dryRun24h
      FROM sms_messages
      WHERE workspace_id = ${workspaceId}
    `;

    return res.json({
      ...safety,
      dbEnabled: true,
      recent: {
        outbound24h: Number(rows[0]?.outbound24h || 0),
        blocked24h: Number(rows[0]?.blocked24h || 0),
        dryRun24h: Number(rows[0]?.dryRun24h || 0),
      },
    });
  });

  app.post("/api/sms/test", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.status(503).json({ error: "Database is required before SMS can be tested or enabled." });
    }
    const workspaceId = getWorkspaceId(req);
    const to = String(req.body?.to || "").trim();
    const body = String(req.body?.body || "").trim();
    const from = String(req.body?.from || env.TWILIO_PHONE_NUMBER || "").trim();
    const confirmedLive = String(req.body?.confirm || "").trim() === SMS_LIVE_CONFIRMATION;

    try {
      const result = await sendGuardedSms({
        sql,
        twilioClient: getTwilioClient(),
        workspaceId,
        from,
        to,
        body,
        appUrl: getAppUrl(),
        purpose: String(req.body?.purpose || "manual_test"),
        contactId: req.body?.contactId ? Number(req.body.contactId) : null,
        confirmedLive,
      });
      return res.status(result.mode === "blocked" ? 400 : 200).json(result);
    } catch (err: any) {
      log("error", "Guarded SMS test failed", { error: err?.message || String(err) });
      return res.status(500).json({ error: err?.message || "Guarded SMS failed." });
    }
  });

  app.post("/api/sms/incoming", validateTwilio, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      res.type("text/xml");
      return res.send("<Response></Response>");
    }

    const from = String(req.body?.From || req.body?.from || "");
    const to = String(req.body?.To || req.body?.to || "");
    const body = String(req.body?.Body || req.body?.body || "");
    const messageSid = String(req.body?.MessageSid || req.body?.SmsSid || "");
    const workspaceId = await getWorkspaceIdByToNumber(to).catch(() => null);
    const reply = await handleIncomingSms(sql, { from, to, body, messageSid, workspaceId });

    res.type("text/xml");
    if (!reply) return res.send("<Response></Response>");
    return res.send(`<Response><Message>${escapeXml(reply)}</Message></Response>`);
  });

  app.post("/api/sms/status", validateTwilio, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.sendStatus(204);

    const messageSid = String(req.body?.MessageSid || req.body?.SmsSid || "");
    const status = String(req.body?.MessageStatus || req.body?.SmsStatus || "");
    if (!messageSid) return res.sendStatus(204);

    await storeSms(sql, {
      messageSid,
      direction: "outbound",
      from: normalizeSmsPhone(String(req.body?.From || "")),
      to: normalizeSmsPhone(String(req.body?.To || "")),
      body: "",
      status: status || null,
      errorCode: req.body?.ErrorCode ? String(req.body.ErrorCode) : null,
      errorMessage: req.body?.ErrorMessage ? String(req.body.ErrorMessage) : null,
    });
    return res.sendStatus(204);
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
