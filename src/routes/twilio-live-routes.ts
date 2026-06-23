import type { Express, Request, Response } from "express";
import twilio from "twilio";

type PendingResponseEntry = {
  twiml: string;
  ready: boolean;
  expires: number;
  resolve?: () => void;
};

type TwilioLiveRouteDeps = {
  sql: any;
  env: {
    RESEND_API_KEY?: string;
    FROM_EMAIL?: string;
  };
  pendingResponses: Map<string, PendingResponseEntry>;
  getPendingTwimlDb: (callSid: string) => Promise<{ ready: boolean; twiml: string } | null>;
  getAppUrl: () => string;
  getOwnerAlertRecipients: (workspaceId: number) => Promise<string[]>;
  formatSenderEmail: (fromEmail: string, fromName?: string) => string;
  logEvent: (callSid: string, eventType: string, payload?: Record<string, unknown>) => void;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

export function registerTwilioLiveRoutes(app: Express, deps: TwilioLiveRouteDeps): void {
  const {
    sql,
    env,
    pendingResponses,
    getPendingTwimlDb,
    getAppUrl,
    getOwnerAlertRecipients,
    formatSenderEmail,
    logEvent,
    log,
  } = deps;

  app.post("/api/twilio/response", async (req: Request, res: Response) => {
    const { CallSid } = req.body;
    const appUrl = getAppUrl();

    const maxWaitMs = 25_000;
    const pollIntervalMs = 200;
    const startWait = Date.now();

    const waitForResponse = (): Promise<string | null> =>
      new Promise((resolve) => {
        const entry = pendingResponses.get(CallSid);
        if (entry?.ready) { resolve(entry.twiml); return; }

        if (entry) {
          entry.resolve = () => {
            const e = pendingResponses.get(CallSid);
            resolve(e?.twiml || null);
          };
        }

        const poll = setInterval(() => {
          const e = pendingResponses.get(CallSid);
          if (e?.ready) {
            clearInterval(poll);
            resolve(e.twiml);
            return;
          }

          getPendingTwimlDb(CallSid).then((r) => {
            if (r?.ready && r.twiml) {
              clearInterval(poll);
              resolve(r.twiml);
            }
          }).catch(() => {/* ignore */});

          if (Date.now() - startWait > maxWaitMs) {
            clearInterval(poll);
            resolve(null);
          }
        }, pollIntervalMs);
      });

    const twimlStr = await waitForResponse();
    pendingResponses.delete(CallSid);

    if (twimlStr) {
      res.type("text/xml");
      return res.send(twimlStr);
    }

    log("warn", "AI response timed out — asking caller to repeat", { callSid: CallSid });
    const t = new twilio.twiml.VoiceResponse();
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
    g.say({ voice: "Polly.Matthew-Neural" as any }, "Sorry about that, I had a brief delay. Could you say that again?");
    t.redirect({ method: "POST" }, `${appUrl}/api/twilio/process`);
    res.type("text/xml");
    res.send(t.toString());
  });

  app.post("/api/twilio/voicemail", async (req: Request, res: Response) => {
    const { CallSid, RecordingUrl, RecordingDuration } = req.body as any;
    try {
      logEvent(CallSid, "VOICEMAIL_RECORDED", { RecordingDuration, RecordingUrl });
      try {
        await sql`UPDATE calls SET recording_url = COALESCE(recording_url, ${RecordingUrl}) WHERE call_sid = ${CallSid}`;
      } catch { /* ignore if column not present */ }

      const callRows = await sql`SELECT from_number, to_number, direction, contact_id, workspace_id FROM calls WHERE call_sid = ${CallSid} LIMIT 1`.catch(() => []);
      const callRow = (callRows as any)[0];
      const vmWorkspaceId = Number(callRow?.workspace_id || 1);
      const callerNumber = callRow?.direction === 'outbound' ? callRow?.to_number : callRow?.from_number || 'Unknown';
      let callerName = callerNumber;
      if (callRow?.contact_id) {
        const contactRows = await sql`SELECT name FROM contacts WHERE id = ${callRow.contact_id} LIMIT 1`.catch(() => []);
        const cName = (contactRows as any)[0]?.name;
        if (cName) callerName = cName + ' (' + callerNumber + ')';
      }

      try {
        const vmDesc = 'Voicemail from ' + callerName + '. Duration: ' + (RecordingDuration || '?') + 's.';
        await sql`
          INSERT INTO tasks (call_sid, contact_id, task_type, description, status, priority, workspace_id)
          VALUES (${CallSid}, ${callRow?.contact_id || null}, 'callback', ${vmDesc}, 'open', 'high', ${vmWorkspaceId})
        `;
        logEvent(CallSid, "VOICEMAIL_TASK_CREATED", { callerName });
      } catch (taskErr: any) { log('warn', 'Failed to create voicemail task', { error: taskErr.message }); }

      const vmOwnerRecipients = await getOwnerAlertRecipients(vmWorkspaceId);
      const vmResendKey = (env as any).RESEND_API_KEY || process.env.RESEND_API_KEY || '';
      const vmFromEmail = (env as any).FROM_EMAIL || process.env.FROM_EMAIL || '';
      if (vmOwnerRecipients.length > 0 && vmResendKey && vmFromEmail) {
        try {
          const durationStr = RecordingDuration ? RecordingDuration + ' seconds' : 'unknown duration';
          const recordingLink = RecordingUrl ? '<p><a href="' + RecordingUrl + '">Listen to recording (requires Twilio login)</a></p>' : '';
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + vmResendKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: formatSenderEmail(vmFromEmail),
              to: vmOwnerRecipients,
              subject: 'Voicemail from ' + callerName,
              html: '<p><strong>Voicemail received</strong> from <strong>' + callerName + '</strong></p><p>Duration: ' + durationStr + '</p>' + recordingLink + '<p>A callback task has been created in your SMIRK dashboard.</p>',
            }),
          });
          logEvent(CallSid, "VOICEMAIL_EMAIL_SENT", { to: vmOwnerRecipients });
        } catch (emailErr: any) { log('warn', 'Voicemail email failed', { error: emailErr.message }); }
      } else {
        log('warn', 'Voicemail email skipped - owner recipients, RESEND_API_KEY, or FROM_EMAIL not configured', { CallSid, recipientCount: vmOwnerRecipients.length });
      }
    } catch (e: any) {
      log("error", "Twilio voicemail handler failed", { CallSid, error: e?.message || String(e) });
    }
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: "Polly.Matthew-Neural" as any }, "Thanks for leaving a message. We'll call you back shortly.");
    twiml.hangup();
    res.type("text/xml");
    return res.send(twiml.toString());
  });
}
