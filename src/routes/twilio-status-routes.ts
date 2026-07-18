import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import {
  runCheckpointedCrmSync,
  type CrmCheckpointAction,
} from "../post-call-durability.js";

const POST_CALL_STAGES = [
  "summary",
  "opt_out",
  "call_webhook",
  "crm_sync",
  "owner_webhook",
  "owner_alert",
] as const;
const POST_CALL_LEASE_MINUTES = 5;
const POST_CALL_SWEEP_INTERVAL_MS = 30_000;

type PostCallStage = (typeof POST_CALL_STAGES)[number];
type PostCallStageOutcome = "completed" | "skipped";
type PostCallJob = {
  call_sid: string;
  workspace_id: number;
  attempts: number;
  lease_token: string;
};

const postCallErrorMessage = (error: unknown): string =>
  String((error as any)?.message || error || "Unknown post-call processing error").slice(0, 2_000);

const escapeHtml = (value: unknown): string => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#039;");

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
  recordWorkspaceCallUsage: (callSid: string, workspaceId: number, durationSeconds: number) => Promise<boolean>;
  resolveWorkspaceAiKeys: (workspaceId: number, fallback: {
    geminiApiKey?: string;
    openrouterApiKey?: string;
    elevenLabsApiKey?: string;
  }) => Promise<{ geminiApiKey?: string | null }>;
  runPostCallIntelligence: (callSid: string, contactId: number | null, geminiApiKey?: string | null) => Promise<unknown>;
  detectOptOut: (transcript: string, phone: string) => Promise<boolean>;
  fireCallWebhooks: (callSid: string, appUrl: string, eventType: string) => Promise<{ status: "delivered" | "skipped"; reason?: string } | unknown>;
  getConfiguredCrms: () => string[];
  getCrmProviderActions: (provider: string) => readonly CrmCheckpointAction[];
  syncCrmAction: (provider: string, action: CrmCheckpointAction, contact: any, log: any, contactRecordId?: string) => Promise<{
    platform: string;
    success: boolean;
    recordId?: string;
    action?: string;
    error?: string;
  }>;
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
    terminalCallStatuses,
    deadAirCounts,
    activeCallTimers,
    finalizeCallBySid,
    recordWorkspaceCallUsage,
    resolveWorkspaceAiKeys,
    runPostCallIntelligence,
    detectOptOut,
    fireCallWebhooks,
    getConfiguredCrms,
    getCrmProviderActions,
    syncCrmAction,
    cleanOwnerEmail,
    getOwnerAlertRecipients,
    formatSenderEmail,
    getAppUrl,
    logEvent,
    log,
  } = deps;

  const requireBoundCall = async (callSid: string, workspaceId: number) => {
    const rows = await sql<{
      contact_id: number | null;
      workspace_id: number | null;
      from_number: string | null;
      to_number: string | null;
      direction: string;
      duration_seconds: number | null;
      started_at: Date | string | null;
      agent_name: string | null;
    }[]>`
      SELECT contact_id, workspace_id, from_number, to_number, direction,
             duration_seconds, started_at, agent_name
      FROM calls
      WHERE call_sid = ${callSid}
        AND workspace_id = ${workspaceId}
      LIMIT 1
    `;
    if (!rows[0]) throw new Error(`Post-call job ${callSid} lost its workspace-bound call record`);
    return rows[0];
  };

  const enqueuePostCallJob = async (callSid: string, workspaceId: number): Promise<void> => {
    const rows = await sql<{ call_sid: string }[]>`
      WITH job AS (
        INSERT INTO post_call_processing_jobs (call_sid, workspace_id, status, available_at, updated_at)
        VALUES (${callSid}, ${workspaceId}, 'pending', NOW(), NOW())
        ON CONFLICT (call_sid) DO UPDATE SET
          updated_at = NOW(),
          status = CASE
            WHEN post_call_processing_jobs.status = 'failed' THEN 'pending'
            ELSE post_call_processing_jobs.status
          END,
          available_at = CASE
            WHEN post_call_processing_jobs.status = 'failed' THEN NOW()
            ELSE post_call_processing_jobs.available_at
          END,
          last_error = CASE
            WHEN post_call_processing_jobs.status = 'failed' THEN NULL
            ELSE post_call_processing_jobs.last_error
          END
        WHERE post_call_processing_jobs.workspace_id = EXCLUDED.workspace_id
        RETURNING call_sid
      ), inserted_stages AS (
        INSERT INTO post_call_processing_stages (call_sid, stage)
        SELECT job.call_sid, stages.stage
        FROM job
        CROSS JOIN UNNEST(${[...POST_CALL_STAGES]}::text[]) AS stages(stage)
        ON CONFLICT (call_sid, stage) DO NOTHING
        RETURNING call_sid
      )
      SELECT call_sid FROM job
    `;
    if (!rows[0]) throw new Error(`Refused to rebind post-call job ${callSid} to workspace ${workspaceId}`);
  };

  const claimPostCallJob = async (callSid: string): Promise<PostCallJob | null> => {
    const leaseToken = randomUUID();
    const rows = await sql<PostCallJob[]>`
      UPDATE post_call_processing_jobs
      SET status = 'running',
          attempts = attempts + 1,
          locked_at = NOW(),
          lease_token = ${leaseToken},
          last_error = NULL,
          updated_at = NOW()
      WHERE call_sid = ${callSid}
        AND completed_at IS NULL
        AND available_at <= NOW()
        AND (
          status IN ('pending', 'failed')
          OR (status = 'running' AND locked_at < NOW() - (${POST_CALL_LEASE_MINUTES} * INTERVAL '1 minute'))
        )
      RETURNING call_sid, workspace_id, attempts, lease_token
    `;
    return rows[0] || null;
  };

  const runPostCallStage = async (
    job: PostCallJob,
    stage: PostCallStage,
    handler: () => Promise<PostCallStageOutcome>,
  ): Promise<void> => {
    const stageRows = await sql<{ status: string }[]>`
      SELECT status
      FROM post_call_processing_stages
      WHERE call_sid = ${job.call_sid} AND stage = ${stage}
      LIMIT 1
    `;
    if (!stageRows[0]) throw new Error(`Post-call stage ${stage} was not enqueued for ${job.call_sid}`);
    if (["completed", "skipped"].includes(stageRows[0].status)) return;

    const leaseRows = await sql<{ call_sid: string }[]>`
      UPDATE post_call_processing_jobs
      SET locked_at = NOW(), updated_at = NOW()
      WHERE call_sid = ${job.call_sid}
        AND lease_token = ${job.lease_token}
        AND status = 'running'
      RETURNING call_sid
    `;
    if (!leaseRows[0]) throw new Error(`Post-call job lease was lost for ${job.call_sid}`);

    const runningRows = await sql<{ stage: string }[]>`
      UPDATE post_call_processing_stages
      SET status = 'running',
          attempts = attempts + 1,
          locked_at = NOW(),
          last_error = NULL,
          updated_at = NOW()
      WHERE call_sid = ${job.call_sid}
        AND stage = ${stage}
        AND EXISTS (
          SELECT 1 FROM post_call_processing_jobs
          WHERE call_sid = ${job.call_sid}
            AND lease_token = ${job.lease_token}
            AND status = 'running'
        )
      RETURNING stage
    `;
    if (!runningRows[0]) throw new Error(`Could not claim post-call stage ${stage} for ${job.call_sid}`);

    try {
      const outcome = await handler();
      const completedRows = await sql<{ stage: string }[]>`
        UPDATE post_call_processing_stages
        SET status = ${outcome},
            completed_at = NOW(),
            locked_at = NULL,
            last_error = NULL,
            updated_at = NOW()
        WHERE call_sid = ${job.call_sid}
          AND stage = ${stage}
          AND EXISTS (
            SELECT 1 FROM post_call_processing_jobs
            WHERE call_sid = ${job.call_sid}
              AND lease_token = ${job.lease_token}
              AND status = 'running'
          )
        RETURNING stage
      `;
      if (!completedRows[0]) throw new Error(`Post-call job lease expired while completing ${stage} for ${job.call_sid}`);
    } catch (error) {
      const message = postCallErrorMessage(error);
      await sql`
        UPDATE post_call_processing_stages
        SET status = 'failed', locked_at = NULL, last_error = ${message}, updated_at = NOW()
        WHERE call_sid = ${job.call_sid}
          AND stage = ${stage}
          AND EXISTS (
            SELECT 1 FROM post_call_processing_jobs
            WHERE call_sid = ${job.call_sid} AND lease_token = ${job.lease_token}
          )
      `;
      throw error;
    }
  };

  const loadOwnerNotification = async (callSid: string, workspaceId: number) => {
    const callRecord = await requireBoundCall(callSid, workspaceId);
    const [summaryRows, ownerContactRows, callbackTaskRows, proofSignalRows] = await Promise.all([
      sql<{ outcome: string; intent: string; summary: string; extracted_entities: any }[]>`
        SELECT outcome, intent, summary, extracted_entities
        FROM call_summaries
        WHERE call_sid = ${callSid} AND workspace_id = ${workspaceId}
        LIMIT 1`,
      sql<{ name: string | null; phone_number: string | null }[]>`
        SELECT name, phone_number
        FROM contacts
        WHERE id = ${callRecord.contact_id || 0} AND workspace_id = ${workspaceId}
        LIMIT 1`,
      sql<{ exists: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM tasks
          WHERE call_sid = ${callSid} AND task_type = 'callback' AND workspace_id = ${workspaceId}
        ) AS exists`,
      sql<{ is_proof_call: boolean }[]>`
        SELECT (
          EXISTS(
            SELECT 1 FROM messages
            WHERE call_sid = ${callSid}
              AND role = 'system'
              AND text ILIKE '%[TEST_CALL] true%'
          )
          OR EXISTS(
            SELECT 1 FROM call_events
            WHERE call_sid = ${callSid}
              AND event_type = 'TEST_CALL_STARTED'
          )
        ) AS is_proof_call`,
    ]);
    const summaryRow = summaryRows[0];
    if (!summaryRow) throw new Error(`Owner notification summary is unavailable for ${callSid}`);
    const ownerContactRow = ownerContactRows[0];
    const highValueOutcomes = ["appointment_booked", "lead_captured", "qualified_lead", "callback_needed", "escalation_requested"];
    const isHighValue = highValueOutcomes.includes(summaryRow.outcome);
    const hasCallbackTask = callbackTaskRows[0]?.exists === true;
    const isProofCall = proofSignalRows[0]?.is_proof_call === true;
    const ownerEmailAlways = Boolean(cleanOwnerEmail(env.OWNER_EMAIL));
    if (!(isHighValue || hasCallbackTask || isProofCall || ownerEmailAlways)) return null;

    const callerLabel = ownerContactRow?.name || ownerContactRow?.phone_number || "Unknown caller";
    const outcomeLabels: Record<string, string> = {
      appointment_booked: "Appointment booked",
      lead_captured: "New lead captured",
      qualified_lead: "Qualified lead",
      callback_needed: "Callback requested",
      escalation_requested: "Escalation requested",
    };
    const title = `${outcomeLabels[summaryRow.outcome] || summaryRow.outcome} — ${callerLabel}`;
    const body = [
      summaryRow.summary,
      summaryRow.extracted_entities?.service_type ? `Service: ${summaryRow.extracted_entities.service_type}` : null,
      ownerContactRow?.phone_number ? `Caller phone: ${ownerContactRow.phone_number}` : null,
      `View: ${getAppUrl()}/dashboard`,
    ].filter(Boolean).join("\n");
    return { summaryRow, ownerContactRow, hasCallbackTask, isProofCall, title, body };
  };

  const stageHandlers = (job: PostCallJob): Record<PostCallStage, () => Promise<PostCallStageOutcome>> => ({
    summary: async () => {
      const callRecord = await requireBoundCall(job.call_sid, job.workspace_id);
      const existing = await sql<{ complete: boolean; has_plan: boolean }[]>`
        SELECT artifacts_completed_at IS NOT NULL AS complete,
               artifact_plan IS NOT NULL AS has_plan
        FROM call_summaries
        WHERE call_sid = ${job.call_sid} AND workspace_id = ${job.workspace_id}
        LIMIT 1
      `;
      if (existing[0]?.complete === true) return "completed";
      let geminiApiKey: string | null | undefined;
      if (existing[0]?.has_plan !== true) {
        const keys = await resolveWorkspaceAiKeys(job.workspace_id, {
          geminiApiKey: env.GEMINI_API_KEY,
          openrouterApiKey: env.OPENROUTER_API_KEY,
          elevenLabsApiKey: env.ELEVENLABS_API_KEY,
        });
        geminiApiKey = keys.geminiApiKey;
      }
      await runPostCallIntelligence(job.call_sid, callRecord.contact_id || null, geminiApiKey);
      const persisted = await sql<{ complete: boolean }[]>`
        SELECT artifacts_completed_at IS NOT NULL AS complete
        FROM call_summaries
        WHERE call_sid = ${job.call_sid} AND workspace_id = ${job.workspace_id}
        LIMIT 1
      `;
      if (persisted[0]?.complete !== true) {
        throw new Error(`Mandatory post-call summary artifacts did not complete for ${job.call_sid}`);
      }
      log("info", "Post-call intelligence complete", { callSid: job.call_sid, workspaceId: job.workspace_id });
      return "completed";
    },
    opt_out: async () => {
      const callRecord = await requireBoundCall(job.call_sid, job.workspace_id);
      const messages = await sql<{ text: string }[]>`
        SELECT text FROM messages
        WHERE call_sid = ${job.call_sid} AND role = 'user'
        ORDER BY created_at ASC
      `;
      const transcript = messages.map((message) => message.text).join(" ");
      const callerPhone = callRecord.direction === "inbound" ? callRecord.from_number : callRecord.to_number;
      if (!transcript || !callerPhone) return "skipped";
      const optedOut = await detectOptOut(transcript, callerPhone);
      if (optedOut) log("info", "Auto-DNC triggered from transcript", { callSid: job.call_sid, phone: callerPhone });
      return "completed";
    },
    call_webhook: async () => {
      const result = await fireCallWebhooks(job.call_sid, getAppUrl(), "call_completed") as any;
      return result?.status === "skipped" ? "skipped" : "completed";
    },
    crm_sync: async () => {
      const configuredCrms = getConfiguredCrms();
      if (configuredCrms.length === 0) return "skipped";
      const callRecord = await requireBoundCall(job.call_sid, job.workspace_id);
      const [summaryRows, contactRows] = await Promise.all([
        sql<any[]>`
          SELECT * FROM call_summaries
          WHERE call_sid = ${job.call_sid} AND workspace_id = ${job.workspace_id}
          LIMIT 1`,
        sql<any[]>`
          SELECT * FROM contacts
          WHERE id = ${callRecord.contact_id || 0} AND workspace_id = ${job.workspace_id}
          LIMIT 1`,
      ]);
      const summary = summaryRows[0];
      const contact = contactRows[0];
      if (!summary) throw new Error(`CRM summary is unavailable for ${job.call_sid}`);
      if (!contact) return "skipped";
      const crmContact = {
        phone: contact.phone_number
          || (callRecord.direction === "inbound" ? callRecord.from_number : callRecord.to_number)
          || "",
        name: contact.name || undefined,
        email: contact.email || undefined,
        company: contact.company || contact.company_name || undefined,
      };
      const crmLog = {
        callSid: job.call_sid,
        duration: callRecord.duration_seconds || 0,
        summary: summary.summary || "Call completed.",
        outcome: summary.outcome || "completed",
        sentiment: summary.sentiment || "neutral",
        calledAt: callRecord.started_at || new Date().toISOString(),
        agentName: callRecord.agent_name || "SMIRK",
      };

      const ensureCheckpoint = async (provider: string, action: CrmCheckpointAction) => {
        await sql`
          INSERT INTO post_call_crm_checkpoints (call_sid, provider, action)
          VALUES (${job.call_sid}, ${provider}, ${action})
          ON CONFLICT (call_sid, provider, action) DO NOTHING
        `;
      };

      await runCheckpointedCrmSync({
        providers: configuredCrms,
        actionsForProvider: getCrmProviderActions,
        isActionComplete: async (provider, action) => {
          await ensureCheckpoint(provider, action);
          const rows = await sql<{ status: string }[]>`
            SELECT status FROM post_call_crm_checkpoints
            WHERE call_sid = ${job.call_sid} AND provider = ${provider} AND action = ${action}
            LIMIT 1
          `;
          return rows[0]?.status === "completed";
        },
        executeAction: async (provider, action) => {
          const activeLease = await sql<{ call_sid: string }[]>`
            UPDATE post_call_processing_jobs
            SET locked_at = NOW(), updated_at = NOW()
            WHERE call_sid = ${job.call_sid}
              AND lease_token = ${job.lease_token}
              AND status = 'running'
            RETURNING call_sid
          `;
          if (!activeLease[0]) throw new Error(`Post-call job lease was lost before ${provider}/${action}`);

          await ensureCheckpoint(provider, action);
          const claimed = await sql<{ action: string }[]>`
            UPDATE post_call_crm_checkpoints
            SET status = 'running', attempts = attempts + 1, locked_at = NOW(),
                last_error = NULL, updated_at = NOW()
            WHERE call_sid = ${job.call_sid} AND provider = ${provider} AND action = ${action}
              AND status <> 'completed'
            RETURNING action
          `;
          if (!claimed[0]) return;

          try {
            let contactRecordId: string | undefined;
            if (action === "call_log" && provider !== "airtable") {
              const contactCheckpoint = await sql<{ external_record_id: string | null }[]>`
                SELECT external_record_id
                FROM post_call_crm_checkpoints
                WHERE call_sid = ${job.call_sid}
                  AND provider = ${provider}
                  AND action = 'contact_upsert'
                  AND status = 'completed'
                LIMIT 1
              `;
              contactRecordId = contactCheckpoint[0]?.external_record_id || undefined;
              if (!contactRecordId) throw new Error(`Missing completed contact checkpoint for ${provider}`);
            }

            const result = await syncCrmAction(provider, action, crmContact, crmLog, contactRecordId);
            if (!result.success) throw new Error(result.error || "provider action failed");
            if (action === "contact_upsert" && getCrmProviderActions(provider).includes("call_log") && !result.recordId) {
              throw new Error("provider returned no contact record ID");
            }
            const completed = await sql<{ action: string }[]>`
              UPDATE post_call_crm_checkpoints
              SET status = 'completed', external_record_id = ${result.recordId || null},
                  completed_at = NOW(), locked_at = NULL, last_error = NULL, updated_at = NOW()
              WHERE call_sid = ${job.call_sid} AND provider = ${provider} AND action = ${action}
              RETURNING action
            `;
            if (!completed[0]) throw new Error(`CRM checkpoint could not complete for ${provider}/${action}`);
          } catch (error) {
            const message = postCallErrorMessage(error);
            await sql`
              UPDATE post_call_crm_checkpoints
              SET status = 'failed', locked_at = NULL, last_error = ${message}, updated_at = NOW()
              WHERE call_sid = ${job.call_sid} AND provider = ${provider} AND action = ${action}
            `;
            throw error;
          }
        },
      });
      log("info", "CRM sync complete", {
        callSid: job.call_sid,
        crms: configuredCrms,
      });
      return "completed";
    },
    owner_webhook: async () => {
      const notification = await loadOwnerNotification(job.call_sid, job.workspace_id);
      if (!notification) return "skipped";
      const webhookUrl = env.OUTBOUND_WEBHOOK_URL || env.WEBHOOK_URL;
      if (!webhookUrl) return "skipped";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-SMIRK-Idempotency-Key": `owner_notification:${job.call_sid}`,
          },
          body: JSON.stringify({
            type: "owner_notification",
            title: notification.title,
            body: notification.body,
            outcome: notification.summaryRow.outcome,
            callSid: job.call_sid,
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Owner notification webhook returned HTTP ${response.status}`);
      } finally {
        clearTimeout(timeout);
      }
      return "completed";
    },
    owner_alert: async () => {
      const notification = await loadOwnerNotification(job.call_sid, job.workspace_id);
      if (!notification) return "skipped";
      const recipients = await getOwnerAlertRecipients(job.workspace_id);
      const resendKey = env.RESEND_API_KEY;
      const fromEmail = env.FROM_EMAIL;
      const fromName = env.FROM_NAME || "SMIRK";
      if (recipients.length === 0 || !resendKey || !fromEmail) {
        logEvent(job.call_sid, "OWNER_EMAIL_ALERT_SKIPPED", {
          recipientCount: recipients.length,
          hasResendKey: Boolean(resendKey),
          hasFromEmail: Boolean(fromEmail),
          workspaceId: job.workspace_id,
          isProofCall: notification.isProofCall,
          hasCallbackTask: notification.hasCallbackTask,
        });
        return "skipped";
      }

      logEvent(job.call_sid, "OWNER_EMAIL_ALERT_QUEUED", {
        to: recipients,
        outcome: notification.summaryRow.outcome,
        isProofCall: notification.isProofCall,
        hasCallbackTask: notification.hasCallbackTask,
      });
      const emailText = [notification.title, "", notification.body, "", `Call SID: ${job.call_sid}`].join("\n");
      const emailHtml = [
        `<h2>${escapeHtml(notification.title)}</h2>`,
        `<p>${escapeHtml(notification.summaryRow.summary || "Call completed.")}</p>`,
        notification.summaryRow.extracted_entities?.service_type
          ? `<p><strong>Service:</strong> ${escapeHtml(notification.summaryRow.extracted_entities.service_type)}</p>`
          : "",
        notification.ownerContactRow?.phone_number
          ? `<p><strong>Caller phone:</strong> ${escapeHtml(notification.ownerContactRow.phone_number)}</p>`
          : "",
        `<p><a href="${escapeHtml(getAppUrl())}/dashboard">Open dashboard</a></p>`,
        `<p style="color:#666;font-size:12px">Call SID: ${escapeHtml(job.call_sid)}</p>`,
      ].filter(Boolean).join("");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      let response: globalThis.Response;
      try {
        response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${resendKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `smirk-owner-alert/${job.call_sid}`,
          },
          body: JSON.stringify({
            from: formatSenderEmail(fromEmail, fromName),
            to: recipients,
            subject: notification.title,
            text: emailText,
            html: emailHtml,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        logEvent(job.call_sid, "OWNER_EMAIL_ALERT_FAILED", {
          error: postCallErrorMessage(error),
          workspaceId: job.workspace_id,
        });
        throw error;
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        const errorBody = (await response.text()).slice(0, 500);
        logEvent(job.call_sid, "OWNER_EMAIL_ALERT_FAILED", { error: errorBody, workspaceId: job.workspace_id });
        throw new Error(`Owner email alert returned HTTP ${response.status}: ${errorBody}`);
      }
      logEvent(job.call_sid, "OWNER_EMAIL_ALERT_SENT", {
        to: recipients,
        outcome: notification.summaryRow.outcome,
        isProofCall: notification.isProofCall,
        hasCallbackTask: notification.hasCallbackTask,
      });
      if (env.OWNER_PHONE) log("info", "Owner SMS fallback skipped because texting is disabled", { workspaceId: job.workspace_id });
      return "completed";
    },
  });

  const processPostCallJob = async (callSid: string): Promise<void> => {
    const job = await claimPostCallJob(callSid);
    if (!job) return;
    try {
      const handlers = stageHandlers(job);
      // Summary is the only prerequisite for the downstream payloads. Once it
      // is durable, attempt every independent stage even if one fails so a bad
      // CRM or webhook cannot suppress opt-out handling or the owner alert.
      await runPostCallStage(job, "summary", handlers.summary);
      const stageFailures: Array<{ stage: PostCallStage; error: string }> = [];
      for (const stage of POST_CALL_STAGES.slice(1)) {
        try {
          await runPostCallStage(job, stage, handlers[stage]);
        } catch (error) {
          stageFailures.push({ stage, error: postCallErrorMessage(error) });
        }
      }
      if (stageFailures.length > 0) {
        throw new Error(`Post-call stages incomplete: ${stageFailures.map(({ stage, error }) => `${stage}: ${error}`).join("; ")}`);
      }
      const completed = await sql<{ call_sid: string }[]>`
        UPDATE post_call_processing_jobs
        SET status = 'completed',
            completed_at = NOW(),
            locked_at = NULL,
            lease_token = NULL,
            last_error = NULL,
            updated_at = NOW()
        WHERE call_sid = ${job.call_sid}
          AND lease_token = ${job.lease_token}
          AND NOT EXISTS (
            SELECT 1 FROM post_call_processing_stages
            WHERE call_sid = ${job.call_sid}
              AND status NOT IN ('completed', 'skipped')
          )
        RETURNING call_sid
      `;
      if (!completed[0]) throw new Error(`Post-call job ${job.call_sid} could not be marked complete`);
      log("info", "Durable post-call processing complete", { callSid: job.call_sid, workspaceId: job.workspace_id });
    } catch (error) {
      const message = postCallErrorMessage(error);
      const retryDelayMs = Math.min(15 * 60_000, 15_000 * (2 ** Math.min(Math.max(job.attempts - 1, 0), 6)));
      const availableAt = new Date(Date.now() + retryDelayMs).toISOString();
      await sql`
        UPDATE post_call_processing_jobs
        SET status = 'failed',
            available_at = ${availableAt},
            locked_at = NULL,
            lease_token = NULL,
            last_error = ${message},
            updated_at = NOW()
        WHERE call_sid = ${job.call_sid} AND lease_token = ${job.lease_token}
      `;
      log("warn", "Durable post-call processing will retry", {
        callSid: job.call_sid,
        workspaceId: job.workspace_id,
        attempt: job.attempts,
        retryDelayMs,
        error: message,
      });
    }
  };

  let sweepRunning = false;
  const drainDuePostCallJobs = async (): Promise<void> => {
    if (sweepRunning) return;
    sweepRunning = true;
    try {
      const dueJobs = await sql<{ call_sid: string }[]>`
        SELECT call_sid
        FROM post_call_processing_jobs
        WHERE completed_at IS NULL
          AND available_at <= NOW()
          AND (
            status IN ('pending', 'failed')
            OR (status = 'running' AND locked_at < NOW() - (${POST_CALL_LEASE_MINUTES} * INTERVAL '1 minute'))
          )
        ORDER BY available_at ASC
        LIMIT 10
      `;
      await Promise.allSettled(dueJobs.map((job) => processPostCallJob(job.call_sid)));
    } catch (error) {
      log("debug", "Durable post-call sweep unavailable", { error: postCallErrorMessage(error) });
    } finally {
      sweepRunning = false;
    }
  };

  const sweepInterval = setInterval(() => { void drainDuePostCallJobs(); }, POST_CALL_SWEEP_INTERVAL_MS);
  (sweepInterval as any).unref?.();
  const startupSweep = setTimeout(() => { void drainDuePostCallJobs(); }, 5_000);
  (startupSweep as any).unref?.();

  app.post("/api/twilio/status", async (req: Request, res: Response) => {
    const { CallSid, CallStatus, CallDuration } = req.body;

    const terminalResult = await finalizeCallBySid(
      CallSid,
      CallStatus,
      CallDuration ? parseInt(CallDuration, 10) : null,
    );

    if (terminalCallStatuses.has(CallStatus)) {
      deadAirCounts.delete(CallSid);
      const timer = activeCallTimers.get(CallSid);
      if (timer) { clearTimeout(timer); activeCallTimers.delete(CallSid); }

      if (CallStatus === "completed") {
        const statusCallRows = await sql<{ contact_id: number | null; workspace_id: number | null }[]>`SELECT contact_id, workspace_id FROM calls WHERE call_sid = ${CallSid}`;
        const callRecord = statusCallRows[0];
        const callWorkspaceId = Number(callRecord?.workspace_id);
        if (!Number.isSafeInteger(callWorkspaceId) || callWorkspaceId <= 0) {
          log("error", "Cannot record completed-call usage because call workspace was unavailable", {
            callSid: CallSid,
            workspaceId: callRecord?.workspace_id ?? null,
          });
          return res.status(503).send("Call usage accounting unavailable");
        }
        try {
          const parsedDuration = Number.parseInt(String(CallDuration || ""), 10);
          const durationSeconds = Number.isFinite(parsedDuration) && parsedDuration >= 0 ? parsedDuration : 60;
          await recordWorkspaceCallUsage(CallSid, callWorkspaceId, durationSeconds);
        } catch (usageErr: any) {
          log("error", "Failed to atomically record completed-call usage; requesting Twilio retry", { callSid: CallSid, workspaceId: callWorkspaceId, error: usageErr.message });
          return res.status(503).send("Call usage accounting retry required");
        }
        try {
          await enqueuePostCallJob(CallSid, callWorkspaceId);
        } catch (postCallEnqueueError) {
          log("error", "Failed to durably enqueue post-call processing; requesting Twilio retry", {
            callSid: CallSid,
            workspaceId: callWorkspaceId,
            error: postCallErrorMessage(postCallEnqueueError),
          });
          return res.status(503).send("Post-call processing enqueue retry required");
        }
        // The job and every stage are durable before the 2xx below. This kick is
        // only a latency optimization; the lease-based sweeper is authoritative.
        setImmediate(() => {
          void processPostCallJob(CallSid).catch((error) => {
            log("warn", "Immediate post-call worker failed before scheduling retry", {
              callSid: CallSid,
              error: postCallErrorMessage(error),
            });
          });
        });
      }

      if (terminalResult.finalized && ["no-answer", "busy", "failed"].includes(CallStatus)) {
        setImmediate(async () => {
          try {
            const [callRow] = await sql<{ contact_id: number | null; direction: string; to_number: string; agent_name: string; workspace_id: number | null }[]>`
              SELECT contact_id, direction, to_number, agent_name, workspace_id FROM calls WHERE call_sid = ${CallSid}
            `;
            if (callRow?.direction === "outbound" && callRow?.contact_id) {
              const taskWorkspaceId = Number(callRow.workspace_id);
              if (!Number.isSafeInteger(taskWorkspaceId) || taskWorkspaceId <= 0) {
                log("warn", "Skipped outbound follow-up task because call workspace was unavailable", { callSid: CallSid });
                return;
              }
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
                  ${taskWorkspaceId}
                )
              `;
              log("info", "Auto-follow-up task created for missed outbound call", { callSid: CallSid, status: CallStatus, contactId: callRow.contact_id, workspaceId: taskWorkspaceId });
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
