import type { Express, Request, RequestHandler, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { activationIdentityForAuthMode } from "../activation-provenance.js";

type OutboundCallRouteDeps = {
  dashboardAuth: RequestHandler;
  callRateLimit: RequestHandler;
  requireTestCallSecret: RequestHandler;
  outboundCallSchema: {
    safeParse: (body: unknown) => {
      success: boolean;
      data?: {
        to: string;
        agentId?: number;
        reason?: string;
        notes?: string;
        source?: string;
      };
      error?: { issues: Array<{ message: string }> };
    };
  };
  env: {
    TWILIO_PHONE_NUMBER?: string;
  };
  sql: any;
  getWorkspaceId: (req: Request) => number;
  checkOutboundCompliance: (phone: string) => Promise<{
    allowed: boolean;
    reason?: string;
    blockedReason?: string;
    nextValidWindow?: Date | null;
  }>;
  getTwilioClient: () => any;
  getAppUrl: () => string;
  getActiveAgent: () => Promise<any>;
  resolveContact: (phone: string) => Promise<{ contact: any; isNew: boolean }>;
  sendOutboundCallConfirmationEmail: (input: {
    workspaceId: number;
    to: string;
    reason?: string;
    notes?: string;
    callSid: string;
    source: string;
  }) => Promise<{ sent: boolean; recipientCount: number }>;
  createActivationEvent: (data: {
    workspace_id?: number | null;
    provisioning_request_id?: number | null;
    event_type: string;
    status?: "open" | "blocked" | "complete" | "info";
    actor?: "customer" | "operator" | "system";
    detail?: Record<string, unknown>;
  }) => Promise<unknown>;
  logEvent: (callSid: string, eventType: string, payload?: Record<string, unknown>) => void;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

export function registerOutboundCallRoutes(app: Express, deps: OutboundCallRouteDeps): void {
  const {
    dashboardAuth,
    callRateLimit,
    requireTestCallSecret,
    outboundCallSchema,
    env,
    sql,
    getWorkspaceId,
    checkOutboundCompliance,
    getTwilioClient,
    getAppUrl,
    getActiveAgent,
    resolveContact,
    sendOutboundCallConfirmationEmail,
    createActivationEvent,
    logEvent,
    log,
  } = deps;

  app.post("/api/calls", dashboardAuth, callRateLimit, async (req: Request, res: Response) => {
    const requestId = (req as any).requestId;
    const parsed = outboundCallSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error?.issues[0]?.message || "Invalid request" });

    const { to, agentId, reason, notes, source } = parsed.data!;
    const from = env.TWILIO_PHONE_NUMBER;
    if (!from) return res.status(400).json({ error: "TWILIO_PHONE_NUMBER is not configured." });

    try {
      const outboundWsId = getWorkspaceId(req);
      const activationIdentity = activationIdentityForAuthMode((req as any).authMode);
      const provisioningRows = await sql<{ id: number }[]>`
        SELECT id
        FROM provisioning_requests
        WHERE workspace_id = ${outboundWsId}
          AND source = 'stripe_checkout_completed'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `;
      await createActivationEvent({
        workspace_id: outboundWsId,
        provisioning_request_id: Number(provisioningRows[0]?.id || 0) || null,
        event_type: "workspace_outbound_call_requested",
        status: "info",
        actor: activationIdentity.actor,
        detail: {
          auth_mode: activationIdentity.authMode,
          auth_provenance: activationIdentity.authProvenance,
          source: String(source || "dashboard").slice(0, 120),
        },
      });
      const normalizePhoneForBypass = (n: string) => n.replace(/\D/g, "");
      const bypassEnabled = process.env.DEV_OUTBOUND_BYPASS === "true";
      const bypassNumbers = (process.env.DEV_OUTBOUND_BYPASS_NUMBERS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(normalizePhoneForBypass);
      const isBypassNumber = bypassNumbers.includes(normalizePhoneForBypass(to));
      const shouldBypassCompliance = bypassEnabled && isBypassNumber;

      if (!shouldBypassCompliance) {
        const compliance = await checkOutboundCompliance(to);
        if (!compliance.allowed) {
          const nextWindow = compliance.nextValidWindow;
          log("warn", "Outbound call blocked by compliance gate", {
            requestId, to,
            reason: compliance.reason,
            blockedReason: compliance.blockedReason,
            nextValidWindow: nextWindow?.toISOString(),
          });
          return res.status(403).json({
            error: compliance.reason,
            blocked: true,
            blockedReason: compliance.blockedReason,
            nextValidWindow: nextWindow?.toISOString() ?? null,
            message: nextWindow
              ? `Call blocked. Next valid window opens at ${nextWindow.toISOString()} UTC.`
              : "Call blocked. Resolve timezone or DNC status before retrying.",
          });
        }
      } else {
        log("warn", "DEV outbound compliance bypass applied", { requestId, to });
      }

      const client = getTwilioClient();
      const appUrl = getAppUrl();
      const incomingParams = new URLSearchParams();
      if (agentId) incomingParams.set("agentId", String(agentId));
      if (reason) incomingParams.set("reason", reason);
      if (notes) incomingParams.set("notes", notes);
      const incomingQuery = incomingParams.toString();
      const incomingUrl = `${appUrl}/api/twilio/incoming${incomingQuery ? `?${incomingQuery}` : ""}`;
      const call = await client.calls.create({
        url: incomingUrl,
        to,
        from,
        statusCallback: `${appUrl}/api/twilio/status`,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        machineDetection: "DetectMessageEnd",
        asyncAmdStatusCallback: `${appUrl}/api/twilio/amd`,
        asyncAmdStatusCallbackMethod: "POST",
      });

      let agent = await getActiveAgent();
      if (agentId) {
        const rows = await sql`SELECT * FROM agent_configs WHERE id = ${agentId} LIMIT 1` as any[];
        if (rows[0]) agent = rows[0];
      }
      const { contact } = await resolveContact(to);

      await sql`
        INSERT INTO calls (call_sid, direction, to_number, from_number, status, agent_name, contact_id, workspace_id)
        VALUES (${call.sid}, 'outbound', ${to}, ${from}, 'initiated', ${process.env.AGENT_NAME || agent?.name || "SMIRK"}, ${contact.id}, ${outboundWsId})
        ON CONFLICT (call_sid) DO NOTHING
      `;

      if (reason || notes) {
        const ctx = [reason && `[CALL REASON] ${reason}`, notes && `[OPERATOR NOTES] ${notes}`].filter(Boolean).join("\n");
        await sql`INSERT INTO messages (call_sid, role, text) VALUES (${call.sid}, 'system', ${ctx})`;
      }

      let confirmation: { sent: boolean; recipientCount: number } = { sent: false, recipientCount: 0 };
      try {
        confirmation = await sendOutboundCallConfirmationEmail({
          workspaceId: outboundWsId,
          to,
          reason,
          notes,
          callSid: call.sid,
          source: source || "dashboard",
        });
      } catch (emailErr: unknown) {
        log("warn", "Outbound call confirmation email failed", {
          requestId,
          callSid: call.sid,
          error: emailErr instanceof Error ? emailErr.message : String(emailErr),
        });
      }

      logEvent(call.sid, "CALL_STARTED", { direction: "outbound", to, contactId: contact.id, agentId, reason, source: source || "dashboard", confirmation });
      log("info", "Outbound call initiated", { requestId, callSid: call.sid, to, agentId, reason, confirmation });
      res.json({ success: true, callSid: call.sid, confirmationEmailSent: confirmation.sent, confirmationRecipientCount: confirmation.recipientCount });

    } catch (error: any) {
      log("error", "Outbound call failed", { requestId, error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/test-call", requireTestCallSecret, async (req: Request, res: Response) => {
    const requestId = (req as any).requestId || uuidv4();
    const to = String(req.body?.to || process.env.OWNER_PHONE || "+17754204485");
    const from = env.TWILIO_PHONE_NUMBER;
    if (!from) return res.status(400).json({ ok: false, error: "TWILIO_PHONE_NUMBER not configured" });
    const client = getTwilioClient();
    if (!client) return res.status(503).json({ ok: false, error: "Twilio not configured" });
    const appUrl = getAppUrl();
    const smirkPitch = `[CALL REASON] This is an outbound demo call to sell SMIRK AI to the business owner.
[BUSINESS_NAME] SMIRK AI
[OPERATOR NOTES] You are SMIRK, a missed-call recovery assistant built for trades contractors. You are calling Cameron, the owner of SMIRK AI, to demonstrate your own capabilities live. Your goal is to:
1. Open with: "Hey, this is SMIRK — the missed-call recovery assistant. I'm calling to show you what I can do. Got 60 seconds?"
2. If he engages, deliver the pitch: "Imagine you're on a job site and your phone rings — a $4,000 HVAC job. You can't answer. That call goes to voicemail. They call your competitor. That's $4,000 gone. I answer that missed call, capture the lead details, email you the summary, and create the callback task — while you're still under the sink."
3. Ask: "Want me to show you how I'd handle a real lead right now?"
4. If yes, walk through a mock lead qualification for an HVAC service call.
5. Close by offering to send a follow-up email with pricing and a demo link.
6. Be direct and confident — you're proving you work by doing the thing you're selling.
CRITICAL: You already have the caller's phone number on file. Do NOT ask for it. If they ask how you got it, say you called them from the number on file.
[TEST_CALL] true`;
    try {
      const call = await client.calls.create({
        url: `${appUrl}/api/twilio/incoming`,
        to,
        from,
        statusCallback: `${appUrl}/api/twilio/status`,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        machineDetection: "DetectMessageEnd",
        asyncAmdStatusCallback: `${appUrl}/api/twilio/amd`,
        asyncAmdStatusCallbackMethod: "POST",
      });
      const { contact } = await resolveContact(to);
      const agent = await getActiveAgent();
      await sql`
        INSERT INTO calls (call_sid, direction, to_number, from_number, status, agent_name, contact_id, workspace_id)
        VALUES (${call.sid}, 'outbound', ${to}, ${from}, 'initiated', ${process.env.AGENT_NAME || agent?.name || "SMIRK"}, ${contact.id}, 1)
        ON CONFLICT (call_sid) DO NOTHING
      `;
      await sql`INSERT INTO messages (call_sid, role, text) VALUES (${call.sid}, 'system', ${smirkPitch})`;
      logEvent(call.sid, "TEST_CALL_STARTED", { to, requestId });
      log("info", "Test call initiated", { requestId, callSid: call.sid, to });
      res.json({ ok: true, callSid: call.sid, to, message: "SMIRK self-pitch call initiated" });
    } catch (err: any) {
      log("error", "Test call failed", { requestId, error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
