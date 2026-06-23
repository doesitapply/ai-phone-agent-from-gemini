import type { Express, NextFunction, Request, Response } from "express";

type DemoRouteDeps = {
  requirePhoneAgentApiKey: (req: Request, res: Response, next: NextFunction) => void;
  sql: any;
  env: {
    TWILIO_ACCOUNT_SID?: string;
    TWILIO_AUTH_TOKEN?: string;
    TWILIO_PHONE_NUMBER?: string;
  };
  getTwilioClient: () => any;
  getAppUrl: () => string;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

const demoLastByPhone = new Map<string, number>();
const demoLastByIp = new Map<string, number>();

function normalizeE164Loose(input: string): string | null {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (/^\+\d{10,15}$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function registerDemoRoutes(app: Express, deps: DemoRouteDeps): void {
  const {
    requirePhoneAgentApiKey,
    sql,
    env,
    getTwilioClient,
    getAppUrl,
    log,
  } = deps;

  app.post("/api/demo/outbound-call", requirePhoneAgentApiKey, async (req: Request, res: Response) => {
    try {
      const to = String((req.body as any)?.to || "").trim();
      const name = ((req.body as any)?.name || null) as string | null;
      if (!/^\+\d{10,15}$/.test(to)) return res.status(400).json({ ok: false, error: "Invalid 'to' (must be E.164 +15551234567)" });

      const demoMode = (process.env.DEMO_MODE || "false") === "true";
      if (demoMode) {
        log("info", "[DEMO_MODE] outbound demo call requested", { to, name });
        return res.json({ ok: true, sid: "DRY_RUN" });
      }

      const client = getTwilioClient();
      const from = env.TWILIO_PHONE_NUMBER;
      if (!from) return res.status(503).json({ ok: false, error: "TWILIO_PHONE_NUMBER not configured" });

      const appUrl = getAppUrl();
      const reason = encodeURIComponent("SMIRK Demo: Missed Call Recovery");
      const notes = encodeURIComponent(name ? `Demo for ${name}` : "Demo request");
      const url = `${appUrl}/api/twilio/incoming?reason=${reason}&notes=${notes}`;

      const call = await client.calls.create({ to, from, url, statusCallback: `${appUrl}/api/twilio/status` });
      return res.json({ ok: true, sid: call.sid });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || "Call failed" });
    }
  });

  app.post("/api/demo/sample-hot-lead", requirePhoneAgentApiKey, async (_req: Request, res: Response) => {
    return res.status(410).json({ ok: false, error: "Texting is disabled for now.", code: "TEXTING_DISABLED" });
  });

  app.post("/api/demo", async (req: Request, res: Response) => {
    try {
      const ip = String((req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")).split(",")[0].trim();
      const name = String((req.body as any)?.name || "").trim() || null;
      const phone = normalizeE164Loose(String((req.body as any)?.phone || ""));
      if (!phone) return res.status(400).json({ ok: false, error: "Invalid phone. Use +15551234567 (E.164) or a 10-digit US number." });

      const now = Date.now();
      const lastPhone = demoLastByPhone.get(phone) || 0;
      const lastIp = demoLastByIp.get(ip) || 0;
      if (now - lastPhone < 10 * 60 * 1000) {
        return res.status(429).json({ ok: false, error: "Please wait a bit before requesting another demo call to the same number." });
      }
      if (now - lastIp < 15 * 1000) {
        return res.status(429).json({ ok: false, error: "Slow down and try again." });
      }
      demoLastByPhone.set(phone, now);
      demoLastByIp.set(ip, now);

      const demoMode = (process.env.DEMO_MODE || "false") === "true";
      log("info", "demo_submission", { name, phone, ip, demoMode });

      try {
        await sql`
          INSERT INTO contacts (phone, name, workspace_id, created_at, updated_at)
          VALUES (${phone}, ${name || "Demo Lead"}, 1, NOW(), NOW())
          ON DUPLICATE KEY UPDATE
            name = COALESCE(NULLIF(${name || ""}, ""), name),
            updated_at = NOW()
        `;
      } catch (dbErr: any) {
        log("warn", "demo_lead_upsert_failed", { error: dbErr?.message });
      }

      log("info", "demo_lead_captured", { name: name || "(not provided)", phone, ip });

      let callSid: string | null = null;
      let callStatus: "placed" | "queued" | "dry_run" = "queued";

      if (demoMode) {
        callSid = "DRY_RUN";
        callStatus = "dry_run";
      } else {
        const twilioConfigured = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER);
        if (twilioConfigured) {
          try {
            const client = getTwilioClient();
            const from = env.TWILIO_PHONE_NUMBER!;
            const appUrl = getAppUrl();
            const reason = encodeURIComponent("SMIRK Demo: Live Call");
            const notes = encodeURIComponent(name ? `Demo for ${name}` : "Demo request");
            const url = `${appUrl}/api/twilio/incoming?reason=${reason}&notes=${notes}`;
            const call = await client.calls.create({ to: phone, from, url, statusCallback: `${appUrl}/api/twilio/status` });
            callSid = call.sid;
            callStatus = "placed";
          } catch (callErr: any) {
            log("error", "demo_call_failed", { error: callErr?.message, phone });
          }
        }
      }

      const message = callStatus === "placed"
        ? "You should receive a call from SMIRK shortly."
        : callStatus === "dry_run"
          ? "Dry run: payload accepted (no call placed)."
          : "Demo request received. We'll follow up shortly.";

      return res.json({ ok: true, message, callSid, callStatus });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || "Demo failed" });
    }
  });
}
