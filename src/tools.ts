/**
 * Structured Action / Tool Layer
 *
 * The AI does NOT freestyle business operations.
 * Every action goes through a typed tool that:
 * 1. Validates input
 * 2. Executes the operation
 * 3. Logs the execution to tool_executions
 * 4. Returns a structured result
 * 5. Fails safely — never crashes the call
 *
 * Tools available:
 * - create_lead
 * - update_contact
 * - book_appointment
 * - reschedule_appointment
 * - cancel_appointment
 * - send_sms_followup
 * - escalate_to_human
 * - create_support_ticket
 * - mark_do_not_call
 */
import twilio from "twilio";
import { db } from "./db.js";
import { adjustOpenTasks, markDoNotCall } from "./contacts.js";
import { logEvent } from "./events.js";

// ── Tool result type ──────────────────────────────────────────────────────────
export type ToolResult = {
  success: boolean;
  message: string; // Human-readable result for the AI to relay to the caller
  data?: Record<string, unknown>;
  error?: string;
};

// ── Tool execution logger ─────────────────────────────────────────────────────
const logToolExecution = (
  callSid: string,
  contactId: number | null,
  toolName: string,
  input: Record<string, unknown>,
  result: ToolResult,
  durationMs: number
): void => {
  db.prepare(`
    INSERT INTO tool_executions
      (call_sid, contact_id, tool_name, input_payload, output_payload, status, error_message, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    callSid,
    contactId,
    toolName,
    JSON.stringify(input),
    JSON.stringify(result.data || {}),
    result.success ? "success" : "failed",
    result.error || null,
    durationMs
  );

  logEvent(callSid, "TOOL_EXECUTED", {
    tool: toolName,
    success: result.success,
    durationMs,
  });
};

// ── Tool: create_lead ─────────────────────────────────────────────────────────
export const createLead = (
  callSid: string,
  contactId: number,
  input: { name?: string; email?: string; service_type?: string; notes?: string }
): ToolResult => {
  const start = Date.now();
  try {
    const updates: string[] = [];
    const values: unknown[] = [];

    if (input.name) { updates.push("name = ?"); values.push(input.name); }
    if (input.email) { updates.push("email = ?"); values.push(input.email); }
    if (input.notes) { updates.push("notes = ?"); values.push(input.notes); }

    if (updates.length > 0) {
      values.push(contactId);
      db.prepare(`UPDATE contacts SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    }

    // Create a lead task
    db.prepare(`
      INSERT INTO tasks (contact_id, call_sid, task_type, status, notes)
      VALUES (?, ?, 'lead_follow_up', 'open', ?)
    `).run(contactId, callSid, `Lead: ${input.service_type || "general inquiry"}. ${input.notes || ""}`);

    adjustOpenTasks(contactId, 1);

    const result: ToolResult = {
      success: true,
      message: "I've captured your information and created a lead record. Someone from our team will follow up with you soon.",
      data: { contactId, service_type: input.service_type },
    };
    logToolExecution(callSid, contactId, "create_lead", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = {
      success: false,
      message: "I was unable to save your information right now. Please call back or we can try again.",
      error: err instanceof Error ? err.message : "unknown",
    };
    logToolExecution(callSid, contactId, "create_lead", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: update_contact ──────────────────────────────────────────────────────
export const updateContact = (
  callSid: string,
  contactId: number,
  input: { name?: string; email?: string; notes?: string }
): ToolResult => {
  const start = Date.now();
  try {
    const updates: string[] = [];
    const values: unknown[] = [];

    if (input.name) { updates.push("name = ?"); values.push(input.name); }
    if (input.email) { updates.push("email = ?"); values.push(input.email); }
    if (input.notes) { updates.push("notes = ?"); values.push(input.notes); }

    if (updates.length > 0) {
      values.push(contactId);
      db.prepare(`UPDATE contacts SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    }

    const result: ToolResult = {
      success: true,
      message: "I've updated your contact information.",
      data: { contactId },
    };
    logToolExecution(callSid, contactId, "update_contact", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = {
      success: false,
      message: "I wasn't able to update your information right now.",
      error: err instanceof Error ? err.message : "unknown",
    };
    logToolExecution(callSid, contactId, "update_contact", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: book_appointment ────────────────────────────────────────────────────
export const bookAppointment = (
  callSid: string,
  contactId: number,
  input: {
    service_type: string;
    scheduled_at: string; // ISO datetime string
    duration_minutes?: number;
    location?: string;
    technician?: string;
    notes?: string;
  }
): ToolResult => {
  const start = Date.now();
  try {
    const result_db = db.prepare(`
      INSERT INTO appointments
        (contact_id, call_sid, service_type, scheduled_at, duration_minutes, location, technician, notes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')
    `).run(
      contactId,
      callSid,
      input.service_type,
      input.scheduled_at,
      input.duration_minutes || 60,
      input.location || null,
      input.technician || null,
      input.notes || null
    );

    logEvent(callSid, "APPOINTMENT_BOOKED", {
      appointmentId: result_db.lastInsertRowid,
      service_type: input.service_type,
      scheduled_at: input.scheduled_at,
    });

    const result: ToolResult = {
      success: true,
      message: `I've booked your ${input.service_type} appointment for ${input.scheduled_at}. You'll receive a confirmation shortly.`,
      data: { appointmentId: result_db.lastInsertRowid, scheduled_at: input.scheduled_at },
    };
    logToolExecution(callSid, contactId, "book_appointment", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = {
      success: false,
      message: "I wasn't able to book the appointment right now. Let me connect you with someone who can help.",
      error: err instanceof Error ? err.message : "unknown",
    };
    logToolExecution(callSid, contactId, "book_appointment", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: reschedule_appointment ──────────────────────────────────────────────
export const rescheduleAppointment = (
  callSid: string,
  contactId: number,
  input: { appointment_id?: number; new_scheduled_at: string; reason?: string }
): ToolResult => {
  const start = Date.now();
  try {
    // Find most recent scheduled appointment for this contact if no ID given
    const appt = input.appointment_id
      ? (db.prepare("SELECT * FROM appointments WHERE id = ? AND contact_id = ?").get(input.appointment_id, contactId) as any)
      : (db.prepare("SELECT * FROM appointments WHERE contact_id = ? AND status = 'scheduled' ORDER BY scheduled_at DESC LIMIT 1").get(contactId) as any);

    if (!appt) {
      return {
        success: false,
        message: "I couldn't find an existing appointment to reschedule. Would you like to book a new one?",
      };
    }

    db.prepare(
      "UPDATE appointments SET scheduled_at = ?, status = 'scheduled', notes = ? WHERE id = ?"
    ).run(input.new_scheduled_at, input.reason || appt.notes, appt.id);

    logEvent(callSid, "APPOINTMENT_RESCHEDULED", {
      appointmentId: appt.id,
      old_time: appt.scheduled_at,
      new_time: input.new_scheduled_at,
    });

    const result: ToolResult = {
      success: true,
      message: `I've rescheduled your appointment to ${input.new_scheduled_at}. Is there anything else I can help you with?`,
      data: { appointmentId: appt.id, new_scheduled_at: input.new_scheduled_at },
    };
    logToolExecution(callSid, contactId, "reschedule_appointment", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = {
      success: false,
      message: "I wasn't able to reschedule right now. Let me get someone to help you.",
      error: err instanceof Error ? err.message : "unknown",
    };
    logToolExecution(callSid, contactId, "reschedule_appointment", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: cancel_appointment ──────────────────────────────────────────────────
export const cancelAppointment = (
  callSid: string,
  contactId: number,
  input: { appointment_id?: number; reason?: string }
): ToolResult => {
  const start = Date.now();
  try {
    const appt = input.appointment_id
      ? (db.prepare("SELECT * FROM appointments WHERE id = ? AND contact_id = ?").get(input.appointment_id, contactId) as any)
      : (db.prepare("SELECT * FROM appointments WHERE contact_id = ? AND status = 'scheduled' ORDER BY scheduled_at DESC LIMIT 1").get(contactId) as any);

    if (!appt) {
      return {
        success: false,
        message: "I couldn't find an appointment to cancel. Can you give me more details?",
      };
    }

    db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(appt.id);

    logEvent(callSid, "APPOINTMENT_CANCELLED", {
      appointmentId: appt.id,
      reason: input.reason,
    });

    const result: ToolResult = {
      success: true,
      message: "I've cancelled your appointment. Would you like to schedule a new time?",
      data: { appointmentId: appt.id },
    };
    logToolExecution(callSid, contactId, "cancel_appointment", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = {
      success: false,
      message: "I wasn't able to cancel right now. Please call back and we'll take care of it.",
      error: err instanceof Error ? err.message : "unknown",
    };
    logToolExecution(callSid, contactId, "cancel_appointment", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: send_sms_followup ───────────────────────────────────────────────────
export const sendSmsFollowup = async (
  callSid: string,
  contactId: number,
  toPhone: string,
  fromPhone: string,
  message: string,
  twilioClient: twilio.Twilio
): Promise<ToolResult> => {
  const start = Date.now();
  const input = { toPhone, message };
  try {
    await twilioClient.messages.create({
      body: message,
      to: toPhone,
      from: fromPhone,
    });

    logEvent(callSid, "SMS_SENT", { to: toPhone, messageLength: message.length });

    const result: ToolResult = {
      success: true,
      message: "I've sent you a text message with the details.",
      data: { to: toPhone },
    };
    logToolExecution(callSid, contactId, "send_sms_followup", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = {
      success: false,
      message: "I wasn't able to send the text message right now.",
      error: err instanceof Error ? err.message : "unknown",
    };
    logToolExecution(callSid, contactId, "send_sms_followup", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: escalate_to_human ───────────────────────────────────────────────────
export const escalateToHuman = (
  callSid: string,
  contactId: number | null,
  input: {
    reason: string;
    urgency?: "low" | "normal" | "high" | "emergency";
    transcript_snippet?: string;
    extracted_fields?: Record<string, string>;
    recommended_action?: string;
  }
): ToolResult => {
  const start = Date.now();
  try {
    db.prepare(`
      INSERT INTO handoffs
        (call_sid, contact_id, reason, urgency, transcript_snippet, extracted_fields, recommended_action, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      callSid,
      contactId,
      input.reason,
      input.urgency || "normal",
      input.transcript_snippet || null,
      input.extracted_fields ? JSON.stringify(input.extracted_fields) : null,
      input.recommended_action || null
    );

    logEvent(callSid, "HANDOFF_CREATED", {
      reason: input.reason,
      urgency: input.urgency || "normal",
    });

    const result: ToolResult = {
      success: true,
      message: "I'm connecting you with a team member who can better assist you. Please hold for just a moment.",
      data: { reason: input.reason, urgency: input.urgency },
    };
    logToolExecution(callSid, contactId, "escalate_to_human", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = {
      success: false,
      message: "I'm having trouble connecting you right now. Please call back and ask for a team member.",
      error: err instanceof Error ? err.message : "unknown",
    };
    logToolExecution(callSid, contactId, "escalate_to_human", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: create_support_ticket ───────────────────────────────────────────────
export const createSupportTicket = (
  callSid: string,
  contactId: number,
  input: { issue: string; priority?: "low" | "normal" | "high"; details?: string }
): ToolResult => {
  const start = Date.now();
  try {
    db.prepare(`
      INSERT INTO tasks (contact_id, call_sid, task_type, status, notes)
      VALUES (?, ?, 'support_ticket', 'open', ?)
    `).run(
      contactId,
      callSid,
      `[${input.priority || "normal"}] ${input.issue}${input.details ? ` — ${input.details}` : ""}`
    );

    adjustOpenTasks(contactId, 1);

    const result: ToolResult = {
      success: true,
      message: "I've created a support ticket for your issue. Our team will follow up with you shortly.",
      data: { issue: input.issue, priority: input.priority },
    };
    logToolExecution(callSid, contactId, "create_support_ticket", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = {
      success: false,
      message: "I wasn't able to create a ticket right now. Please call back and we'll sort it out.",
      error: err instanceof Error ? err.message : "unknown",
    };
    logToolExecution(callSid, contactId, "create_support_ticket", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: mark_do_not_call ────────────────────────────────────────────────────
export const markDoNotCallTool = (
  callSid: string,
  contactId: number
): ToolResult => {
  const start = Date.now();
  const input = { contactId };
  try {
    markDoNotCall(contactId);
    logEvent(callSid, "DO_NOT_CALL_SET", { contactId });

    const result: ToolResult = {
      success: true,
      message: "I've added you to our do-not-call list. We won't contact you again. Have a good day.",
      data: { contactId },
    };
    logToolExecution(callSid, contactId, "mark_do_not_call", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = {
      success: false,
      message: "I wasn't able to process that request right now.",
      error: err instanceof Error ? err.message : "unknown",
    };
    logToolExecution(callSid, contactId, "mark_do_not_call", input, result, Date.now() - start);
    return result;
  }
};
