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
    VALUES (${callSid}, ${eventType}, ${payload ? sql.json(payload) : null})
  `.catch(() => {/* non-critical */});
};

export const getCallEvents = async (callSid: string) => {
  return sql`
    SELECT id, event_type, payload, created_at
    FROM call_events WHERE call_sid = ${callSid} ORDER BY id ASC
  `;
};
