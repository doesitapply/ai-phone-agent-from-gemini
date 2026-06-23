import type { Express, Request, Response } from "express";

type TerminalResult = {
  finalized: boolean;
  status: string;
};

type TwilioStatusRouteDeps = {
  sql: any;
  env: {
    GEMINI_API_KEY?: string;
    OPENROUTER_API_KEY?: string;
    ELEVENLABS_API_KEY?: string;
    WEBHOOK_URL?: string;
    OUTBOUND_WEBHOOK_URL?: string;
    RESEND_API_KEY?: string;
    FROM_EMAIL?: string;
    FROM_NAME?: string;
    OWNER_EMAIL?: string;
    OWNER_PHONE?: string;
  };
  getWorkspaceId: (req: Request) => number;
  getWorkspaceMode: (workspaceId: number) => Promise<string>;
  terminalCallStatuses: Set<string>;
  deadAirCounts: Map<string, number>;
  activeCallTimers: Map<string, ReturnType<typeof setTimeout>>;
  finalizeCallBySid: (callSid: string, status: string, durationSeconds?: number | null) => Promise<TerminalResult>;
  incrementWorkspaceUsage: (workspaceId: number, durationSeconds: number) => Promise<unknown>;
  resolveWorkspaceAiKeys: (workspaceId: number, fallback: {
    geminiApiKey?: string;
    openrouterApiKey?: string;
    elevenLabsApiKey?: string;
  }) => Promise<{ geminiApiKey?: string | null }>;
  runPostCallIntelligence: (callSid: string, contactId: number | null, geminiApiKey?: string | null) => Promise<unknown>;
  detectOptOut: (transcript: string, phone: string) => Promise<boolean>;
  fireCallWebhooks: (callSid: string, appUrl: string, eventType: string) => Promise<unknown>;
  getConfiguredCrms: () => string[];
  syncAllCrms: (contact: any, log: any) => Promise<Array<{ platform: string; success: boolean; action?: string }>>;
  cleanOwnerEmail: (value?: string | null) => string | null;
  getOwnerAlertRecipients: (workspaceId: number) => Promise<string[]>;
  formatSenderEmail: (fromEmail: string, fromName?: string) => string;
  getAppUrl: () => string;
  logEvent: (callSid: string, eventType: string, payload?: Record<string, unknown>) => void;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

export function registerTwilioStatusRoutes(app: Express, deps: TwilioStatusRouteDeps): void {
  const {
    sql,
    env,
    getWorkspaceId,
    getWorkspaceMode,
    terminalCallStatuses,
    deadAirCounts,
    activeCallTimers,
    finalizeCallBySid,
    incrementWorkspaceUsage,
    resolveWorkspaceAiKeys,
    runPostCallIntelligence,
    detectOptOut,
    fireCallWebhooks,
    getConfiguredCrms,
    syncAllCrms,
    cleanOwnerEmail,
    getOwnerAlertRecipients,
    formatSenderEmail,
    getAppUrl,
    logEvent,
    log,
  } = deps;

  app.post("/api/twilio/status", async (req: Request, res: Response) => {
    const { CallSid, CallStatus, CallDuration } = req.body;

    const terminalResult = await finalizeCallBySid(
      CallSid,
      CallStatus,
      CallDuration ? parseInt(CallDuration, 10) : null,
    );

    const wsId = getWorkspaceId(req) || 1;
    const workspaceMode = await getWorkspaceMode(wsId);
    void workspaceMode;

    if (terminalCallStatuses.has(CallStatus)) {
      deadAirCounts.delete(CallSid);
      const timer = activeCallTimers.get(CallSid);
      if (timer) { clearTimeout(timer); activeCallTimers.delete(CallSid); }

      if (terminalResult.finalized && CallStatus === "completed") {
        const statusCallRows = await sql<{ contact_id: number | null; workspace_id: number | null }[]>`SELECT contact_id, workspace_id FROM calls WHERE call_sid = ${CallSid}`;
        const callRecord = statusCallRows[0];
        try {
          const durationSeconds = CallDuration ? parseInt(CallDuration, 10) : 60;
          await incrementWorkspaceUsage(wsId, durationSeconds);
        } catch (usageErr: any) {
          log("warn", "Failed to increment workspace usage", { workspaceId: wsId, error: usageErr.message });
        }
        setImmediate(async () => {
          try {
            const postCallWsId = (callRecord?.workspace_id as number) || wsId || 1;
            const postCallKeys = await resolveWorkspaceAiKeys(postCallWsId, {
              geminiApiKey: env.GEMINI_API_KEY,
              openrouterApiKey: env.OPENROUTER_API_KEY,
              elevenLabsApiKey: env.ELEVENLABS_API_KEY,
            });
            await runPostCallIntelligence(CallSid, callRecord?.contact_id || null, postCallKeys.geminiApiKey);
            log("info", "Post-call intelligence complete", { callSid: CallSid, workspaceId: postCallWsId });
            try {
              const msgRows = await sql`SELECT text FROM messages WHERE call_sid = ${CallSid} AND role = 'user' ORDER BY created_at ASC`;
              const fullTranscript = msgRows.map((m: any) => m.text).join(" ");
              const [callRow] = await sql`SELECT from_number, to_number, direction FROM calls WHERE call_sid = ${CallSid}`;
              const callerPhone = callRow?.direction === "inbound" ? callRow?.from_number : callRow?.to_number;
              if (fullTranscript && callerPhone) {
                const optedOut = await detectOptOut(fullTranscript, callerPhone);
                if (optedOut) log("info", "Auto-DNC triggered from transcript", { callSid: CallSid, phone: callerPhone });
              }
            } catch (e: any) { log("warn", "Opt-out detection failed", { error: e.message }); }
          } catch (err: any) {
            log("error", "Post-call intelligence failed", { callSid: CallSid, error: err.message });
          }
          try {
            await fireCallWebhooks(CallSid, getAppUrl(), "call_completed");
          } catch (err: any) {
            log("warn", "Webhook delivery failed", { callSid: CallSid, error: err.message });
          }
          try {
            const configuredCrms = getConfiguredCrms();
            if (configuredCrms.length > 0) {
              const [callRows, summaryRows, contactRows] = await Promise.all([
                sql`SELECT * FROM calls WHERE call_sid = ${CallSid}`,
                sql`SELECT * FROM call_summaries WHERE call_sid = ${CallSid} LIMIT 1`,
                sql`SELECT * FROM contacts WHERE id = ${callRecord?.contact_id || 0}`,
              ]);
              const call = callRows[0];
              const summary = summaryRows[0];
              const contact = contactRows[0];
              if (call && contact) {
                const crmContact = {
                  phone: contact.phone_number,
                  name: contact.name || undefined,
                  email: contact.email || undefined,
                  company: contact.company || undefined,
                };
                const crmLog = {
                  callSid: CallSid,
                  duration: call.duration_seconds || 0,
                  summary: summary?.summary || "Call completed.",
                  outcome: summary?.outcome || "completed",
                  sentiment: summary?.sentiment || "neutral",
                  calledAt: call.started_at || new Date().toISOString(),
                  agentName: call.agent_name || "SMIRK",
                };
                const crmResults = await syncAllCrms(crmContact, crmLog);
                log("info", "CRM sync complete", { callSid: CallSid, crms: configuredCrms, results: crmResults.map((r) => ({ platform: r.platform, success: r.success, action: r.action })) });
              }
            }
          } catch (err: any) {
            log("warn", "CRM sync failed", { callSid: CallSid, error: err.message });
          }

          try {
            const [
              summaryRows,
              ownerContactRows,
              callbackTaskRows,
              proofSignalRows,
            ] = await Promise.all([
              sql<{ outcome: string; intent: string; summary: string; extracted_entities: any }[]>`
                SELECT outcome, intent, summary, extracted_entities FROM call_summaries WHERE call_sid = ${CallSid} LIMIT 1`,
              sql<{ name: string | null; phone_number: string | null }[]>`
                SELECT name, phone_number FROM contacts WHERE id = ${callRecord?.contact_id || 0} LIMIT 1`,
              sql<{ exists: boolean }[]>`
                SELECT EXISTS(
                  SELECT 1 FROM tasks WHERE call_sid = ${CallSid} AND task_type = 'callback'
                ) AS exists`,
              sql<{ is_proof_call: boolean }[]>`
                SELECT (
                  EXISTS(
                    SELECT 1 FROM messages
                    WHERE call_sid = ${CallSid}
                      AND role = 'system'
                      AND text ILIKE '%[TEST_CALL] true%'
                  )
                  OR EXISTS(
                    SELECT 1 FROM call_events
                    WHERE call_sid = ${CallSid}
                      AND event_type = 'TEST_CALL_STARTED'
                  )
                ) AS is_proof_call`,
            ]);
            const summaryRow = summaryRows[0];
            const ownerContactRow = ownerContactRows[0];
            const HIGH_VALUE_OUTCOMES = ["appointment_booked", "lead_captured", "qualified_lead", "callback_needed", "escalation_requested"];
            const isHighValue = summaryRow && HIGH_VALUE_OUTCOMES.includes(summaryRow.outcome);
            const hasCallbackTask = callbackTaskRows[0]?.exists === true;
            const isProofCall = proofSignalRows[0]?.is_proof_call === true;
            const ownerEmailAlways = Boolean(cleanOwnerEmail(env.OWNER_EMAIL));
            const shouldNotifyOwner = Boolean(summaryRow && (isHighValue || hasCallbackTask || isProofCall || ownerEmailAlways));
            if (summaryRow && shouldNotifyOwner) {
              const callerLabel = ownerContactRow?.name || ownerContactRow?.phone_number || "Unknown caller";
              const outcomeLabels: Record<string, string> = {
                appointment_booked: "Appointment booked",
                lead_captured: "New lead captured",
                qualified_lead: "Qualified lead",
                callback_needed: "Callback requested",
                escalation_requested: "Escalation requested",
              };
              const notifTitle = `${outcomeLabels[summaryRow.outcome] || summaryRow.outcome} — ${callerLabel}`;
              const notifBody = [
                summaryRow.summary,
                (summaryRow.extracted_entities as any)?.service_type ? `Service: ${(summaryRow.extracted_entities as any).service_type}` : null,
                ownerContactRow?.phone_number ? `Caller phone: ${ownerContactRow.phone_number}` : null,
                `View: ${getAppUrl()}/dashboard`,
              ].filter(Boolean).join("\n");
              const webhookUrl = env.OUTBOUND_WEBHOOK_URL || env.WEBHOOK_URL;
              if (webhookUrl) {
                await fetch(webhookUrl, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ type: "owner_notification", title: notifTitle, body: notifBody, outcome: summaryRow.outcome, callSid: CallSid }),
                }).catch((e: any) => log("warn", "Owner notification webhook failed", { error: e.message }));
              }

              const workspaceIdForAlert = callRecord?.workspace_id || wsId || 1;
              const ownerRecipients = await getOwnerAlertRecipients(workspaceIdForAlert);
              const resendKey = env.RESEND_API_KEY;
              const fromEmail = env.FROM_EMAIL;
              const fromName = env.FROM_NAME || "SMIRK";
              if (ownerRecipients.length > 0 && resendKey && fromEmail) {
                logEvent(CallSid, "OWNER_EMAIL_ALERT_QUEUED", { to: ownerRecipients, outcome: summaryRow.outcome, isProofCall, hasCallbackTask });
                const emailText = [
                  notifTitle,
                  "",
                  notifBody,
                  "",
                  `Call SID: ${CallSid}`,
                ].join("\n");
                const emailHtml = [
                  `<h2>${notifTitle}</h2>`,
                  `<p>${(summaryRow.summary || "Call completed.").replace(/</g, "&lt;")}</p>`,
                  (summaryRow.extracted_entities as any)?.service_type ? `<p><strong>Service:</strong> ${(summaryRow.extracted_entities as any).service_type}</p>` : "",
                  ownerContactRow?.phone_number ? `<p><strong>Caller phone:</strong> ${ownerContactRow.phone_number}</p>` : "",
                  `<p><a href="${getAppUrl()}/dashboard">Open dashboard</a></p>`,
                  `<p style="color:#666;font-size:12px">Call SID: ${CallSid}</p>`,
                ].filter(Boolean).join("");
                await fetch("https://api.resend.com/emails", {
                  method: "POST",
                  headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    from: formatSenderEmail(fromEmail, fromName),
                    to: ownerRecipients,
                    subject: notifTitle,
                    text: emailText,
                    html: emailHtml,
                  }),
                }).then(async (resp) => {
                  if (!resp.ok) throw new Error(await resp.text());
                  logEvent(CallSid, "OWNER_EMAIL_ALERT_SENT", { to: ownerRecipients, outcome: summaryRow.outcome, isProofCall, hasCallbackTask });
                }).catch((e: any) => {
                  logEvent(CallSid, "OWNER_EMAIL_ALERT_FAILED", { error: e.message, workspaceId: workspaceIdForAlert });
                  log("warn", "Owner email notification failed", { error: e.message, workspaceId: workspaceIdForAlert });
                });
              } else {
                logEvent(CallSid, "OWNER_EMAIL_ALERT_SKIPPED", {
                  recipientCount: ownerRecipients.length,
                  hasResendKey: Boolean(resendKey),
                  hasFromEmail: Boolean(fromEmail),
                  workspaceId: workspaceIdForAlert,
                  isProofCall,
                  hasCallbackTask,
                });
              }

              if (env.OWNER_PHONE) {
                log("info", "Owner SMS fallback skipped because texting is disabled", { workspaceId: workspaceIdForAlert });
              }
            }
          } catch (notifErr: any) {
            log("warn", "Owner notification block failed", { error: notifErr.message });
          }
        });
      }

      if (terminalResult.finalized && ["no-answer", "busy", "failed"].includes(CallStatus)) {
        setImmediate(async () => {
          try {
            const [callRow] = await sql<{ contact_id: number | null; direction: string; to_number: string; agent_name: string }[]>`
              SELECT contact_id, direction, to_number, agent_name FROM calls WHERE call_sid = ${CallSid}
            `;
            if (callRow?.direction === "outbound" && callRow?.contact_id) {
              const ctxRows = await sql<{ text: string }[]>`
                SELECT text FROM messages WHERE call_sid = ${CallSid} AND role = 'system' LIMIT 1
              `;
              const storedCtx = ctxRows[0]?.text || "";
              const reasonMatch = storedCtx.match(/\[CALL REASON\]\s*(.+)/)?.[1]?.trim();
              const taskTitle = reasonMatch
                ? `Follow up: ${reasonMatch} (${CallStatus})`
                : `Follow up outbound call to ${callRow.to_number} (${CallStatus})`;
              const dueAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
              await sql`
                INSERT INTO tasks (title, description, status, priority, due_at, contact_id, call_sid, task_type, workspace_id)
                VALUES (
                  ${taskTitle},
                  ${`Outbound call to ${callRow.to_number} ended with status: ${CallStatus}. Original reason: ${reasonMatch || "not specified"}. Retry the call.`},
                  'open',
                  ${CallStatus === "no-answer" ? "medium" : "high"},
                  ${dueAt},
                  ${callRow.contact_id},
                  ${CallSid},
                  'callback',
                  1
                )
              `;
              log("info", "Auto-follow-up task created for missed outbound call", { callSid: CallSid, status: CallStatus, contactId: callRow.contact_id });
            }
          } catch (err: any) {
            log("warn", "Auto-follow-up task creation failed", { callSid: CallSid, error: err.message });
          }
        });
      }

      if (terminalResult.finalized) {
        logEvent(CallSid, "CALL_ENDED", { status: CallStatus, duration: CallDuration });
      }
    }

    log("info", "Call status updated", { callSid: CallSid, status: CallStatus, finalized: terminalResult.finalized });
    res.sendStatus(200);
  });
}
