import type { Express, Request, Response, RequestHandler } from "express";

type RecoveryRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  sql: any;
  getWorkspaceId: (req: Request) => number;
  isOnDNC: (phoneNumber: string) => Promise<boolean>;
  getTwilioClient: () => any;
  env: {
    TWILIO_PHONE_NUMBER?: string;
  };
  getActiveAgent: () => Promise<{ id?: number | string } | null | undefined>;
  getAppUrl: () => string;
  logEvent: (callSid: string, eventType: string, payload: Record<string, unknown>) => void;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

export function registerRecoveryRoutes(app: Express, deps: RecoveryRouteDeps) {
  const {
    dashboardAuth,
    requireOperator,
    sql,
    getWorkspaceId,
    isOnDNC,
    getTwilioClient,
    env,
    getActiveAgent,
    getAppUrl,
    logEvent,
    log,
  } = deps;

  app.get("/api/recovery/queue", dashboardAuth, async (req: Request, res: Response) => {
    try {
      const wsId = getWorkspaceId(req);
      const days = Math.max(1, Math.min(90, parseInt(String(req.query.days || "30"), 10) || 30));

      const rows = await sql`
        SELECT
          c.call_sid,
          c.from_number,
          c.started_at,
          c.duration_seconds,
          c.turn_count,
          c.contact_id,
          co.name as contact_name,
          c.recovery_call_back_started_at,
          c.recovery_closed_at
        FROM calls c
        LEFT JOIN contacts co ON co.id = c.contact_id
        WHERE c.workspace_id = ${wsId}
          AND c.direction = 'inbound'
          AND COALESCE(c.turn_count, 0) <= 1
          AND COALESCE(c.duration_seconds, 0) <= 30
          AND c.started_at >= NOW() - make_interval(days => ${days})
          AND c.recovery_closed_at IS NULL
        ORDER BY c.started_at DESC
        LIMIT 200
      `;

      const items = await Promise.all(rows.map(async (r: any) => {
        let contactId: number | null = r.contact_id || null;
        let contactName: string | null = r.contact_name || null;
        if (!contactId && r.from_number) {
          try {
            const existing = await sql<{ id: number; name: string | null }[]>`
              SELECT id, name
              FROM contacts
              WHERE workspace_id = ${wsId} AND phone_number = ${r.from_number}
              ORDER BY updated_at DESC, id DESC
              LIMIT 1
            `;
            if (existing?.[0]?.id) {
              contactId = existing[0].id;
              contactName = existing[0].name || contactName;
            } else {
              const inserted = await sql<{ id: number }[]>`
                INSERT INTO contacts (phone_number, name, workspace_id)
                VALUES (${r.from_number}, NULL, ${wsId})
                RETURNING id
              `;
              contactId = inserted?.[0]?.id || null;
            }

            if (contactId && !r.contact_id) {
              await sql`
                UPDATE calls
                SET contact_id = ${contactId}
                WHERE call_sid = ${r.call_sid} AND workspace_id = ${wsId} AND contact_id IS NULL
              `;
            }
          } catch {}
        }

        const priority = r.recovery_call_back_started_at ? "medium" : "high";
        const status = r.recovery_closed_at ? "closed" : (r.recovery_call_back_started_at ? "callback_started" : "needs_callback");
        const reason = r.recovery_call_back_started_at
          ? "Missed inbound call (callback follow-up already started)"
          : "Missed inbound call (needs callback follow-up)";

        return {
          id: r.call_sid,
          call_sid: r.call_sid,
          contact_id: contactId || 0,
          name: contactName,
          phone_number: r.from_number,
          reason,
          priority,
          last_touch_at: r.started_at,
          status,
        };
      }));

      res.json({ days, items });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/recovery/:callSid/call-back", dashboardAuth, async (req: Request, res: Response) => {
    const { callSid } = req.params;
    const wsId = getWorkspaceId(req);

    try {
      const [row] = await sql<any[]>`
        SELECT call_sid, from_number, recovery_call_back_started_at, recovery_closed_at
        FROM calls
        WHERE call_sid = ${callSid} AND workspace_id = ${wsId}
        LIMIT 1
      `;
      if (!row) return res.status(404).json({ error: "Call not found" });
      if (row.recovery_closed_at) return res.json({ ok: true, skipped: true, reason: "closed" });
      if (row.recovery_call_back_started_at) return res.json({ ok: true, skipped: true, reason: "already_started" });
      if (!row.from_number) return res.status(400).json({ error: "Missing from_number" });
      if (await isOnDNC(row.from_number)) return res.json({ ok: true, skipped: true, reason: "dnc" });

      const twilioClient = getTwilioClient();
      const fromPhone = env.TWILIO_PHONE_NUMBER;
      if (!twilioClient || !fromPhone) return res.status(400).json({ error: "Twilio not configured" });

      const agent = await getActiveAgent();
      const agentId = agent?.id || undefined;
      const appUrl = getAppUrl();

      const call = await twilioClient.calls.create({
        to: row.from_number,
        from: fromPhone,
        url: `${appUrl}/api/twilio/incoming${agentId ? `?agentId=${agentId}` : ""}`,
        statusCallback: `${appUrl}/api/twilio/status`,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["completed", "failed", "no-answer", "busy", "canceled"],
        machineDetection: "Enable",
        machineDetectionTimeout: 30,
      });

      await sql`UPDATE calls SET recovery_call_back_started_at = NOW() WHERE call_sid = ${callSid} AND workspace_id = ${wsId} AND recovery_call_back_started_at IS NULL`;
      logEvent(callSid, "RECOVERY_CALL_BACK_STARTED", { to: row.from_number, outboundCallSid: call.sid });
      res.json({ ok: true, outboundCallSid: call.sid });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/recovery/:callSid/close", dashboardAuth, async (req: Request, res: Response) => {
    const { callSid } = req.params;
    const wsId = getWorkspaceId(req);

    try {
      const result = await sql`
        UPDATE calls
        SET recovery_closed_at = COALESCE(recovery_closed_at, NOW()),
            recovery_status = 'closed'
        WHERE call_sid = ${callSid} AND workspace_id = ${wsId}
        RETURNING call_sid, recovery_closed_at
      `;
      if (!result.length) return res.status(404).json({ error: "Call not found" });
      logEvent(callSid, "RECOVERY_CLOSED", {});
      res.json({ ok: true, closedAt: result[0].recovery_closed_at });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/recovery/direct-dial", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const { phone_number, contact_id } = req.body as { phone_number: string; contact_id?: number };
    if (!phone_number) return res.status(400).json({ error: "phone_number required" });
    const twilioClient = getTwilioClient();
    const fromPhone = env.TWILIO_PHONE_NUMBER;
    if (!twilioClient || !fromPhone) return res.status(400).json({ error: "Twilio not configured" });
    try {
      if (await isOnDNC(phone_number)) return res.status(400).json({ error: "Number is on DNC list" });
      const agent = await getActiveAgent();
      const agentId = agent?.id;
      const appUrl = getAppUrl();
      const call = await twilioClient.calls.create({
        to: phone_number.startsWith("+") ? phone_number : `+1${phone_number.replace(/\D/g, "")}`,
        from: fromPhone,
        url: `${appUrl}/api/twilio/incoming${agentId ? `?agentId=${agentId}` : ""}`,
        statusCallback: `${appUrl}/api/twilio/status`,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["completed", "failed", "no-answer", "busy", "canceled"],
        machineDetection: "Enable",
        machineDetectionTimeout: 30,
      });
      log("info", "Recovery direct-dial initiated", { to: phone_number, contactId: contact_id, callSid: call.sid });
      res.json({ ok: true, callSid: call.sid });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/recovery/stats", dashboardAuth, async (req: Request, res: Response) => {
    try {
      const wsId = getWorkspaceId(req);
      const [totals] = await sql<any[]>`
        SELECT
          COUNT(*) FILTER (WHERE recovery_closed_at IS NULL AND COALESCE(turn_count, 0) <= 1 AND COALESCE(duration_seconds, 0) <= 30) AS open_count,
          COUNT(*) FILTER (WHERE recovery_call_back_started_at IS NOT NULL AND recovery_closed_at IS NULL) AS callbacks_started,
          COUNT(*) FILTER (WHERE recovery_closed_at IS NOT NULL AND recovery_closed_at >= NOW() - INTERVAL '7 days') AS closed_7d
        FROM calls
        WHERE workspace_id = ${wsId}
          AND direction = 'inbound'
          AND started_at >= NOW() - INTERVAL '90 days'
      `;
      res.json({ stats: totals || {} });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
