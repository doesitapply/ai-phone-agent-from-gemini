/**
 * Call Events Module
 *
 * Every meaningful moment in a call is recorded as a structured event.
 * This enables:
 * - Call replay and debugging
 * - AI decision auditing
 * - Training data collection
 * - Analytics on specific moments
 */
import { db } from "./db.js";

export const EVENT_TYPES = [
  "CALL_STARTED",
  "CALLER_IDENTIFIED",
  "CALLER_NEW",
  "INTENT_DETECTED",
  "SPEECH_RECEIVED",
  "AI_RESPONSE_GENERATED",
  "TOOL_EXECUTED",
  "WORKFLOW_STAGE_CHANGED",
  "TRANSFER_REQUESTED",
  "HANDOFF_CREATED",
  "MAX_TURNS_REACHED",
  "DEAD_AIR_DETECTED",
  "CALL_ENDED",
  "SUMMARY_GENERATED",
  "TASK_CREATED",
  "APPOINTMENT_BOOKED",
  "APPOINTMENT_RESCHEDULED",
  "APPOINTMENT_CANCELLED",
  "SMS_SENT",
  "DO_NOT_CALL_SET",
  "DUPLICATE_WEBHOOK",
  "AI_ERROR",
  "AI_RETRY",
  // OpenClaw integration events
  "OPENCLAW_RESPONSE",
  "OPENCLAW_FALLBACK",
  "INJECTED_MESSAGE_DELIVERED",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Log a structured event for a call.
 * Non-blocking — errors are swallowed to avoid disrupting call flow.
 */
export const logEvent = (
  callSid: string,
  eventType: EventType,
  payload?: Record<string, unknown>
): void => {
  try {
    db.prepare(`
      INSERT INTO call_events (call_sid, event_type, payload)
      VALUES (?, ?, ?)
    `).run(callSid, eventType, payload ? JSON.stringify(payload) : null);
  } catch {
    // Non-critical — never crash a call because of event logging
  }
};

/**
 * Get all events for a call, ordered chronologically.
 */
export const getCallEvents = (
  callSid: string
): { id: number; event_type: string; payload: string | null; created_at: string }[] => {
  return db
    .prepare(
      "SELECT id, event_type, payload, created_at FROM call_events WHERE call_sid = ? ORDER BY id ASC"
    )
    .all(callSid) as { id: number; event_type: string; payload: string | null; created_at: string }[];
};
