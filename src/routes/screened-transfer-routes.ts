import type { Express, Request, Response } from "express";
import twilio from "twilio";
import {
  buildTransferScreenUrl,
  buildWhisperAnnouncement,
  buildTransferFallbackMessage,
  classifyTransferOutcome,
  isScreenAccepted,
  WHISPER_GATHER_TIMEOUT_SECONDS,
} from "../screened-transfer.js";

type ScreenedTransferRouteDeps = {
  sql: any;
  getAppUrl: () => string;
  logEvent: (callSid: string, eventType: string, payload?: Record<string, unknown>) => void;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

// Registered under /api/twilio/* so the shared twilioValidate signature
// middleware (src/routes/api-middleware.ts) protects every route here.
export function registerScreenedTransferRoutes(app: Express, deps: ScreenedTransferRouteDeps): void {
  const { sql, getAppUrl, logEvent, log } = deps;

  const loadWhisperContext = async (callSid: string) => {
    try {
      const handoffRows = await sql`
        SELECT reason, urgency FROM handoffs
        WHERE call_sid = ${callSid}
        ORDER BY id DESC
        LIMIT 1
      `;
      const callRows = await sql`
        SELECT from_number, to_number, direction, contact_id FROM calls
        WHERE call_sid = ${callSid}
        LIMIT 1
      `;
      const handoff = (handoffRows as any)[0] || {};
      const call = (callRows as any)[0] || {};
      const callerPhone = call.direction === "outbound" ? call.to_number : call.from_number;
      let callerName: string | null = null;
      if (call.contact_id) {
        const contactRows = await sql`SELECT name FROM contacts WHERE id = ${call.contact_id} LIMIT 1`.catch(() => []);
        callerName = (contactRows as any)[0]?.name || null;
      }
      return {
        reason: handoff.reason || null,
        urgency: handoff.urgency || null,
        callerName,
        callerPhone: callerPhone || null,
      };
    } catch {
      return { reason: null, urgency: null, callerName: null, callerPhone: null };
    }
  };

  // ── Callee leg: whisper before bridge ──────────────────────────────────────
  // Twilio requests this URL on the contractor's leg the moment they answer.
  // Nothing here is audible to the held caller.
  app.post("/api/twilio/transfer-whisper", async (req: Request, res: Response) => {
    const callSid = String(req.query.callSid || (req.body as any)?.callSid || "");
    const context = await loadWhisperContext(callSid);
    const announcement = buildWhisperAnnouncement(context);
    logEvent(callSid, "TRANSFER_WHISPER_PLAYED", { announcement });

    const t = new twilio.twiml.VoiceResponse();
    const g = t.gather({
      input: ["dtmf"] as any,
      numDigits: 1,
      timeout: WHISPER_GATHER_TIMEOUT_SECONDS,
      action: buildTransferScreenUrl(getAppUrl(), callSid),
      method: "POST",
    });
    g.say({ voice: "Polly.Matthew-Neural" as any }, announcement);
    // No DTMF within the window: carrier voicemail answered, or the human
    // didn't accept. End the callee leg so <Dial> reports no-answer and the
    // caller-side action URL takes over with the graceful fallback.
    t.hangup();
    res.type("text/xml");
    res.send(t.toString());
  });

  // ── Callee leg: DTMF gate ──────────────────────────────────────────────────
  // Digits === "1" → return empty TwiML, Twilio bridges the two legs.
  // Anything else (or voicemail noise) → hang up the callee leg.
  app.post("/api/twilio/transfer-screen", (req: Request, res: Response) => {
    const callSid = String(req.query.callSid || (req.body as any)?.callSid || "");
    const digits = (req.body as any)?.Digits;
    const t = new twilio.twiml.VoiceResponse();

    if (isScreenAccepted(digits)) {
      logEvent(callSid, "TRANSFER_SCREEN_ACCEPTED", { digits: String(digits) });
      sql`UPDATE handoffs SET status = 'transferred' WHERE call_sid = ${callSid} AND status IN ('pending', 'screening')`.catch(() => {});
      t.say({ voice: "Polly.Matthew-Neural" as any }, "Connecting you now.");
      // Empty-ending TwiML on the callee leg = accept the bridge.
    } else {
      logEvent(callSid, "TRANSFER_SCREEN_DECLINED", { digits: digits == null ? null : String(digits) });
      t.hangup();
    }
    res.type("text/xml");
    res.send(t.toString());
  });

  // ── Caller leg: dial outcome ───────────────────────────────────────────────
  // Fires on the CALLER's leg after <Dial> finishes. If the bridge happened and
  // the conversation ended, wrap up. Otherwise the contractor never accepted —
  // recover the caller with the fallback script and capture a callback number.
  app.post("/api/twilio/transfer-result", async (req: Request, res: Response) => {
    const callSid = String(req.query.callSid || (req.body as any)?.CallSid || "");
    const targetName = String(req.query.targetName || "");
    const { DialCallStatus, DialCallDuration } = req.body as any;
    const outcome = classifyTransferOutcome(DialCallStatus, DialCallDuration);
    const appUrl = getAppUrl();
    const t = new twilio.twiml.VoiceResponse();

    if (outcome === "bridged") {
      logEvent(callSid, "TRANSFER_BRIDGED", { DialCallStatus, DialCallDuration });
      t.say({ voice: "Polly.Matthew-Neural" as any }, "Thanks for calling. Goodbye.");
      t.hangup();
      res.type("text/xml");
      return res.send(t.toString());
    }

    logEvent(callSid, "TRANSFER_NOT_ACCEPTED", { DialCallStatus, DialCallDuration: DialCallDuration ?? null });
    await sql`UPDATE handoffs SET status = 'pending' WHERE call_sid = ${callSid} AND status = 'screening'`.catch(() => {});
    const fallbackMsg = buildTransferFallbackMessage(targetName);
    await sql`INSERT INTO messages (call_sid, role, text) VALUES (${callSid}, 'assistant', ${fallbackMsg})`.catch((e: any) =>
      log("warn", "Failed to persist transfer fallback message", { callSid, error: e?.message })
    );

    // A failed live transfer must create one durable callback obligation before
    // control returns to the caller. When Twilio supplied a caller number, no
    // further model decision is needed and no repeat transfer should occur.
    const callbackRows = await sql<{
      contact_id: number | null;
      workspace_id: number | null;
      caller_phone: string | null;
      existing_task_id: number | null;
    }[]>`
      SELECT
        c.contact_id,
        c.workspace_id,
        CASE WHEN c.direction = 'outbound' THEN c.to_number ELSE c.from_number END AS caller_phone,
        (
          SELECT t.id FROM tasks t
          WHERE t.call_sid = c.call_sid
            AND t.task_type = 'callback'
            AND t.status IN ('open', 'in_progress')
          ORDER BY t.id DESC
          LIMIT 1
        ) AS existing_task_id
      FROM calls c
      WHERE c.call_sid = ${callSid}
      LIMIT 1
    `.catch(() => [] as any[]);
    const callbackContext = callbackRows[0];
    const callbackDigits = String(callbackContext?.caller_phone || "").replace(/\D/g, "");
    const hasCallableNumber = callbackDigits.length >= 10 && !/^0+$/.test(callbackDigits);
    if (callbackContext?.existing_task_id) {
      logEvent(callSid, "TRANSFER_CALLBACK_TASK_EXISTS", { taskId: callbackContext.existing_task_id });
    } else if (callbackContext?.contact_id && callbackContext.workspace_id && hasCallableNumber) {
      const created = await sql<{ id: number }[]>`
        INSERT INTO tasks (contact_id, call_sid, workspace_id, task_type, status, notes)
        VALUES (
          ${callbackContext.contact_id}, ${callSid}, ${callbackContext.workspace_id}, 'callback', 'open',
          ${`Live transfer to ${targetName || "the requested person"} was not accepted. Return the caller's request promptly at ${callbackContext.caller_phone}.`}
        )
        RETURNING id
      `.catch((e: any) => {
        log("warn", "Failed to create deterministic transfer callback task", { callSid, error: e?.message });
        return [] as { id: number }[];
      });
      if (created[0]?.id) logEvent(callSid, "TRANSFER_CALLBACK_TASK_CREATED", { taskId: created[0].id, callerPhone: callbackContext.caller_phone });
    }

    if (hasCallableNumber) {
      const completeMsg = "I couldn't connect you just now, but I have your number and have sent a callback request to the owner. You'll hear back as soon as they are available.";
      await sql`INSERT INTO messages (call_sid, role, text) VALUES (${callSid}, 'assistant', ${completeMsg})`.catch(() => {});
      t.say({ voice: "Polly.Matthew-Neural" as any }, completeMsg);
      t.hangup();
      res.type("text/xml");
      return res.send(t.toString());
    }

    const g: any = t.gather({
      input: ["speech"],
      action: `${appUrl}/api/twilio/process`,
      method: "POST",
      timeout: 8,
      speechTimeout: "auto" as any,
      bargeIn: true as any,
      speechModel: "phone_call",
      enhanced: true,
    });
    g.say({ voice: "Polly.Matthew-Neural" as any }, fallbackMsg);
    t.redirect({ method: "POST" }, `${appUrl}/api/twilio/process`);
    res.type("text/xml");
    res.send(t.toString());
  });
}
