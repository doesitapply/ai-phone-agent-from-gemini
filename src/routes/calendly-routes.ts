import express, { type Express, type Request, type RequestHandler, type Response } from "express";

type CalendlyRouteDeps = {
  dashboardAuth: RequestHandler;
  sql: any;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

export function registerCalendlyRoutes(app: Express, deps: CalendlyRouteDeps): void {
  const { dashboardAuth, sql, log } = deps;

  app.post("/api/calendly/webhook", express.raw({ type: "*/*", limit: "64kb" }), async (req: Request, res: Response) => {
    const signingSecret = process.env.CALENDLY_SIGNING_SECRET || "";
    if (!signingSecret) {
      log("warn", "[calendly] CALENDLY_SIGNING_SECRET not set — rejecting webhook");
      return res.status(503).json({ error: "Calendly webhook not configured" });
    }

    const rawBody = req.body as Buffer;
    const signature = req.headers["calendly-webhook-signature"] as string || "";
    if (!signature) {
      log("warn", "[calendly] Missing Calendly-Webhook-Signature header");
      return res.status(401).json({ error: "Missing signature" });
    }

    const parts: Record<string, string> = {};
    for (const part of signature.split(",")) {
      const [k, v] = part.split("=", 2);
      if (k && v) parts[k] = v;
    }
    const ts = parts["t"];
    const v1 = parts["v1"];
    if (!ts || !v1) {
      log("warn", "[calendly] Malformed signature header", { signature });
      return res.status(401).json({ error: "Malformed signature" });
    }

    const tsDiff = Math.abs(Date.now() - parseInt(ts, 10) * 1000);
    if (tsDiff > 5 * 60 * 1000) {
      log("warn", "[calendly] Webhook timestamp too old", { tsDiff });
      return res.status(401).json({ error: "Timestamp too old" });
    }

    const { createHmac } = await import("crypto");
    const expected = createHmac("sha256", signingSecret)
      .update(`${ts}.${rawBody.toString()}`, "utf8")
      .digest("hex");

    if (expected !== v1) {
      log("warn", "[calendly] Signature mismatch — possible spoofed webhook");
      return res.status(401).json({ error: "Invalid signature" });
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString());
    } catch {
      log("error", "[calendly] Failed to parse webhook body");
      return res.status(400).json({ error: "Invalid JSON" });
    }

    const event = payload?.event as string;
    log("info", `[calendly] Received event: ${event}`);

    if (event !== "invitee.created") {
      return res.status(200).json({ ok: true, skipped: true, event });
    }

    const invitee = payload?.payload?.invitee || {};
    const eventObj = payload?.payload?.event || {};
    const eventType = payload?.payload?.event_type || {};

    const calendlyEventUri: string = typeof eventObj === "string" ? eventObj : (eventObj?.uri || "");
    const calendlyInviteeUri: string = invitee?.uri || "";
    const inviteeName: string = invitee?.name || "";
    const inviteeEmail: string = invitee?.email || "";
    const eventTypeName: string = typeof eventType === "string" ? eventType : (eventType?.name || "SMIRK Demo");
    const startTime: string = invitee?.scheduled_event?.start_time || payload?.payload?.scheduled_event?.start_time || "";
    const endTime: string = invitee?.scheduled_event?.end_time || payload?.payload?.scheduled_event?.end_time || "";

    if (!calendlyEventUri) {
      log("error", "[calendly] Missing event URI in payload", { payload });
      return res.status(400).json({ error: "Missing event URI" });
    }

    if (!startTime) {
      log("error", "[calendly] Missing start_time in payload", { payload });
      return res.status(400).json({ error: "Missing start_time" });
    }

    try {
      const existing = await sql<any[]>`
        SELECT id FROM appointments WHERE calendly_event_uri = ${calendlyEventUri} LIMIT 1
      `;
      if (existing.length > 0) {
        log("info", `[calendly] Duplicate event — skipping (uri=${calendlyEventUri})`);
        return res.status(200).json({ ok: true, duplicate: true });
      }

      const durationMinutes = startTime && endTime
        ? Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / 60000)
        : 30;

      await sql`
        INSERT INTO appointments (
          scheduled_at, duration_minutes, status,
          service_type, notes,
          source, calendly_event_uri, calendly_invitee_uri,
          invitee_name, invitee_email, event_type_name
        ) VALUES (
          ${startTime}, ${durationMinutes}, 'scheduled',
          ${eventTypeName}, ${`Booked via Calendly by ${inviteeName} (${inviteeEmail})`},
          'calendly', ${calendlyEventUri}, ${calendlyInviteeUri},
          ${inviteeName}, ${inviteeEmail}, ${eventTypeName}
        )
      `;

      log("info", `[calendly] Appointment stored: ${inviteeName} (${inviteeEmail}) at ${startTime}`);
      res.status(200).json({ ok: true, stored: true });
    } catch (err: any) {
      log("error", "[calendly] DB insert failed", { error: err.message });
      res.status(500).json({ error: "DB error" });
    }
  });

  app.get("/api/calendly/config", dashboardAuth, (_req: Request, res: Response) => {
    const url = process.env.CALENDLY_URL || "";
    const configured = !!url;
    res.json({ configured, url });
  });
}
