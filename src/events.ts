/**
 * Call Events Module — Postgres version
 */
import { sql } from "./db.js";

export const EVENT_TYPES = [
  "CALL_STARTED", "CALLER_IDENTIFIED", "CALLER_NEW", "INTENT_DETECTED",
  "SPEECH_RECEIVED", "AI_RESPONSE_GENERATED", "TOOL_EXECUTED",
  "WORKFLOW_STAGE_CHANGED", "TRANSFER_REQUESTED", "HANDOFF_CREATED",
  "MAX_TURNS_REACHED", "DEAD_AIR_DETECTED", "CALL_ENDED", "SUMMARY_GENERATED",
  "TASK_CREATED", "APPOINTMENT_BOOKED", "APPOINTMENT_RESCHEDULED",
  "APPOINTMENT_CANCELLED", "SMS_SENT", "DO_NOT_CALL_SET", "DUPLICATE_WEBHOOK",
  "AI_ERROR", "AI_RETRY", "OPENCLAW_RESPONSE", "OPENCLAW_FALLBACK",
  "INJECTED_MESSAGE_DELIVERED",
  "GEMINI_RESPONSE", "GEMINI_FALLBACK", "OPENROUTER_RESPONSE", "OPENROUTER_FALLBACK",
  "TOOL_LOOP_ROUND", "TOOL_ERROR", "TOOL_LOOP_EXHAUSTED",
  "AMD_RESULT", "VOICEMAIL_DROP_SENT", "CALL_KILLED_TIMEOUT", "CALL_TRANSFERRED",
  "CONTACT_AUTO_CREATE_SKIPPED", "CONTACT_AUTO_CREATED_FROM_SUMMARY", "CONTACT_RECOVERED_FROM_SUMMARY",
  "STEP2_CUSTOM_FIELDS_ERROR", "STEP3_CONTACT_UPDATE_ERROR", "STEP4_CONTACT_SUMMARY_ERROR",
  "STEP5_APPOINTMENT_ERROR", "STEP6_TASKS_ERROR", "LEAD_UPSERT_COMPLETE", "LEAD_UPSERT_ERROR",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Log a structured event. Fire-and-forget — never crashes call flow.
 */
export const logEvent = (
  callSid: string,
  eventType: EventType,
  payload?: Record<string, unknown>
): void => {
  sql`
    INSERT INTO call_events (call_sid, event_type, payload)
    VALUES (${callSid}, ${eventType}, ${payload ? sql.json(payload as any) : null})
  `.catch(() => {/* non-critical */});
};

export const getCallEvents = async (callSid: string) => {
  return sql`
    SELECT id, event_type, payload, created_at
    FROM call_events WHERE call_sid = ${callSid} ORDER BY id ASC
  `;
};
