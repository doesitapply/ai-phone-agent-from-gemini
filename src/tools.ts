/**
 * Structured Action / Tool Layer — Postgres version
 *
 * Every AI action goes through a typed tool that:
 * 1. Validates input
 * 2. Executes the operation
 * 3. Logs the execution to tool_executions
 * 4. Returns a structured result
 * 5. Fails safely — never crashes the call
 */
import twilio from "twilio";
import { sql } from "./db.js";
import { adjustOpenTasks, markDoNotCall } from "./contacts.js";
import { logEvent } from "./events.js";
import { insertCalendarEvent, isCalendarConfigured } from "./gcal.js";

export type ToolResult = {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
  error?: string;
};

const logToolExecution = async (
  callSid: string,
  contactId: number | null,
  toolName: string,
  input: Record<string, unknown>,
  result: ToolResult,
  durationMs: number
): Promise<void> => {
  await sql`
    INSERT INTO tool_executions
      (call_sid, contact_id, tool_name, input_payload, output_payload, status, error_message, duration_ms)
    VALUES (
      ${callSid}, ${contactId}, ${toolName},
      ${sql.json(input)}, ${sql.json(result.data || {})},
      ${result.success ? "success" : "failed"},
      ${result.error || null}, ${durationMs}
    )
  `.catch(() => {/* non-critical */});

  logEvent(callSid, "TOOL_EXECUTED", { tool: toolName, success: result.success, durationMs });
};

// ── Tool: create_lead ─────────────────────────────────────────────────────────
export const createLead = async (
  callSid: string,
  contactId: number,
  input: { name?: string; email?: string; business_name?: string; business_type?: string; website?: string; service_type?: string; notes?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    const sets: string[] = [];
    const vals: Record<string, unknown> = {};

    if (input.name) { sets.push("name"); vals.name = input.name; }
    if (input.email) { sets.push("email"); vals.email = input.email; }
    if (input.business_name) { sets.push("business_name"); vals.business_name = input.business_name; }
    if (input.business_type) { sets.push("business_type"); vals.business_type = input.business_type; }
    if (input.website) { sets.push("website"); vals.website = input.website; }
    if (input.notes) { sets.push("notes"); vals.notes = input.notes; }

    if (sets.length > 0) {
      // Build dynamic UPDATE safely
      const setClauses = sets.map(k => `${k} = ${sql([`${k}`] as unknown as TemplateStringsArray)}`);
      // Use raw unsafe for dynamic columns
      const setStr = sets.map(k => `${k} = $${k}`).join(", ");
      await sql.unsafe(
        `UPDATE contacts SET ${sets.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`,
        [contactId, ...sets.map(k => vals[k])]
      );
    }

    await sql`
      INSERT INTO tasks (contact_id, call_sid, task_type, status, notes)
      VALUES (${contactId}, ${callSid}, 'lead_follow_up', 'open',
        ${`Lead: ${input.service_type || "general inquiry"}. ${input.notes || ""}`.trim()})
    `;
    await adjustOpenTasks(contactId, 1);

    const result: ToolResult = {
      success: true,
      message: "I've captured your information and created a lead record. Someone will follow up with you soon.",
      data: { contactId, service_type: input.service_type },
    };
    await logToolExecution(callSid, contactId, "create_lead", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = {
      success: false,
      message: "I was unable to save your information right now. Please call back or we can try again.",
      error: err instanceof Error ? err.message : "unknown",
    };
    await logToolExecution(callSid, contactId, "create_lead", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: update_contact ──────────────────────────────────────────────────────
export const updateContact = async (
  callSid: string,
  contactId: number,
  input: { name?: string; email?: string; notes?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    const sets = Object.entries(input).filter(([, v]) => v !== undefined);
    if (sets.length > 0) {
      await sql.unsafe(
        `UPDATE contacts SET ${sets.map(([k], i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`,
        [contactId, ...sets.map(([, v]) => v)]
      );
    }
    const result: ToolResult = { success: true, message: "I've updated your contact information.", data: { contactId } };
    await logToolExecution(callSid, contactId, "update_contact", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I wasn't able to update your information right now.", error: err instanceof Error ? err.message : "unknown" };
    await logToolExecution(callSid, contactId, "update_contact", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: book_appointment ────────────────────────────────────────────────────
export const bookAppointment = async (
  callSid: string,
  contactId: number,
  input: {
    service_type: string;
    scheduled_at: string;
    duration_minutes?: number;
    location?: string;
    technician?: string;
    notes?: string;
  }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    const apptRows = await sql`
      INSERT INTO appointments
        (contact_id, call_sid, service_type, scheduled_at, duration_minutes, location, technician, notes, status)
      VALUES (
        ${contactId}, ${callSid}, ${input.service_type}, ${input.scheduled_at},
        ${input.duration_minutes || 60}, ${input.location || null},
        ${input.technician || null}, ${input.notes || null}, 'scheduled'
      )
      RETURNING id
    `;
    const apptId = apptRows[0].id;

    logEvent(callSid, "APPOINTMENT_BOOKED", { appointmentId: apptId, service_type: input.service_type, scheduled_at: input.scheduled_at });

    let calendarEventId: string | null = null;
    if (isCalendarConfigured()) {
      try {
        const contactRows = await sql`SELECT name, phone_number, email FROM contacts WHERE id = ${contactId}`;
        const contact = contactRows[0] as { name?: string; phone_number?: string; email?: string } | undefined;
        const endMs = new Date(input.scheduled_at).getTime() + (input.duration_minutes || 60) * 60_000;
        calendarEventId = await insertCalendarEvent({
          summary: `${input.service_type} — ${contact?.name || contact?.phone_number || "Unknown"}`,
          description: `Booked via AI Phone Agent\nCall SID: ${callSid}\n${input.notes || ""}`.trim(),
          location: input.location,
          startIso: input.scheduled_at,
          endIso: new Date(endMs).toISOString(),
          attendeeEmail: contact?.email,
        });
        if (calendarEventId) {
          await sql`UPDATE appointments SET calendar_event_id = ${calendarEventId} WHERE id = ${apptId}`;
        }
      } catch { /* calendar sync failure must never fail the booking */ }
    }

    const result: ToolResult = {
      success: true,
      message: `I've booked your ${input.service_type} appointment for ${input.scheduled_at}. You'll receive a confirmation shortly.`,
      data: { appointmentId: apptId, scheduled_at: input.scheduled_at, calendarEventId },
    };
    await logToolExecution(callSid, contactId, "book_appointment", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I wasn't able to book the appointment right now. Let me connect you with someone who can help.", error: err instanceof Error ? err.message : "unknown" };
    await logToolExecution(callSid, contactId, "book_appointment", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: reschedule_appointment ──────────────────────────────────────────────
export const rescheduleAppointment = async (
  callSid: string,
  contactId: number,
  input: { appointment_id?: number; new_scheduled_at: string; reason?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    const apptRows = input.appointment_id
      ? await sql`SELECT * FROM appointments WHERE id = ${input.appointment_id} AND contact_id = ${contactId}`
      : await sql`SELECT * FROM appointments WHERE contact_id = ${contactId} AND status = 'scheduled' ORDER BY scheduled_at DESC LIMIT 1`;

    if (!apptRows.length) {
      return { success: false, message: "I couldn't find an existing appointment to reschedule. Would you like to book a new one?" };
    }
    const appt = apptRows[0] as { id: number; scheduled_at: string; notes: string };

    await sql`UPDATE appointments SET scheduled_at = ${input.new_scheduled_at}, status = 'scheduled', notes = ${input.reason || appt.notes} WHERE id = ${appt.id}`;
    logEvent(callSid, "APPOINTMENT_RESCHEDULED", { appointmentId: appt.id, old_time: appt.scheduled_at, new_time: input.new_scheduled_at });

    const result: ToolResult = { success: true, message: `I've rescheduled your appointment to ${input.new_scheduled_at}. Is there anything else I can help you with?`, data: { appointmentId: appt.id, new_scheduled_at: input.new_scheduled_at } };
    await logToolExecution(callSid, contactId, "reschedule_appointment", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I wasn't able to reschedule right now. Let me get someone to help you.", error: err instanceof Error ? err.message : "unknown" };
    await logToolExecution(callSid, contactId, "reschedule_appointment", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: cancel_appointment ──────────────────────────────────────────────────
export const cancelAppointment = async (
  callSid: string,
  contactId: number,
  input: { appointment_id?: number; reason?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    const apptRows = input.appointment_id
      ? await sql`SELECT * FROM appointments WHERE id = ${input.appointment_id} AND contact_id = ${contactId}`
      : await sql`SELECT * FROM appointments WHERE contact_id = ${contactId} AND status = 'scheduled' ORDER BY scheduled_at DESC LIMIT 1`;

    if (!apptRows.length) {
      return { success: false, message: "I couldn't find an appointment to cancel. Can you give me more details?" };
    }
    const appt = apptRows[0] as { id: number };

    await sql`UPDATE appointments SET status = 'cancelled' WHERE id = ${appt.id}`;
    logEvent(callSid, "APPOINTMENT_CANCELLED", { appointmentId: appt.id, reason: input.reason });

    const result: ToolResult = { success: true, message: "I've cancelled your appointment. Would you like to schedule a new time?", data: { appointmentId: appt.id } };
    await logToolExecution(callSid, contactId, "cancel_appointment", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I wasn't able to cancel right now. Please call back and we'll take care of it.", error: err instanceof Error ? err.message : "unknown" };
    await logToolExecution(callSid, contactId, "cancel_appointment", input, result, Date.now() - start);
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
    await twilioClient.messages.create({ body: message, to: toPhone, from: fromPhone });
    logEvent(callSid, "SMS_SENT", { to: toPhone, messageLength: message.length });
    const result: ToolResult = { success: true, message: "I've sent you a text message with the details.", data: { to: toPhone } };
    await logToolExecution(callSid, contactId, "send_sms_followup", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I wasn't able to send the text message right now.", error: err instanceof Error ? err.message : "unknown" };
    await logToolExecution(callSid, contactId, "send_sms_followup", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: escalate_to_human ───────────────────────────────────────────────────
export const escalateToHuman = async (
  callSid: string,
  contactId: number | null,
  input: {
    reason: string;
    urgency?: "low" | "normal" | "high" | "emergency";
    transcript_snippet?: string;
    extracted_fields?: Record<string, string>;
    recommended_action?: string;
  }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    await sql`
      INSERT INTO handoffs
        (call_sid, contact_id, reason, urgency, transcript_snippet, extracted_fields, recommended_action, status)
      VALUES (
        ${callSid}, ${contactId}, ${input.reason},
        ${input.urgency || "normal"}, ${input.transcript_snippet || null},
        ${input.extracted_fields ? sql.json(input.extracted_fields) : null},
        ${input.recommended_action || null}, 'pending'
      )
    `;
    logEvent(callSid, "HANDOFF_CREATED", { reason: input.reason, urgency: input.urgency || "normal" });
    const result: ToolResult = { success: true, message: "I'm connecting you with a team member who can better assist you. Please hold for just a moment.", data: { reason: input.reason, urgency: input.urgency } };
    await logToolExecution(callSid, contactId, "escalate_to_human", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I'm having trouble connecting you right now. Please call back and ask for a team member.", error: err instanceof Error ? err.message : "unknown" };
    await logToolExecution(callSid, contactId, "escalate_to_human", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: create_support_ticket ───────────────────────────────────────────────
export const createSupportTicket = async (
  callSid: string,
  contactId: number,
  input: { issue: string; priority?: "low" | "normal" | "high"; details?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    await sql`
      INSERT INTO tasks (contact_id, call_sid, task_type, status, notes)
      VALUES (${contactId}, ${callSid}, 'support_ticket', 'open',
        ${`[${input.priority || "normal"}] ${input.issue}${input.details ? ` — ${input.details}` : ""}`})
    `;
    await adjustOpenTasks(contactId, 1);
    const result: ToolResult = { success: true, message: "I've created a support ticket for your issue. Our team will follow up with you shortly.", data: { issue: input.issue, priority: input.priority } };
    await logToolExecution(callSid, contactId, "create_support_ticket", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I wasn't able to create a ticket right now. Please call back and we'll sort it out.", error: err instanceof Error ? err.message : "unknown" };
    await logToolExecution(callSid, contactId, "create_support_ticket", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: mark_do_not_call ────────────────────────────────────────────────────
export const markDoNotCallTool = async (
  callSid: string,
  contactId: number
): Promise<ToolResult> => {
  const start = Date.now();
  const input = { contactId };
  try {
    await markDoNotCall(contactId);
    logEvent(callSid, "DO_NOT_CALL_SET", { contactId });
    const result: ToolResult = { success: true, message: "I've added you to our do-not-call list. We won't contact you again. Have a good day.", data: { contactId } };
    await logToolExecution(callSid, contactId, "mark_do_not_call", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I wasn't able to process that request right now.", error: err instanceof Error ? err.message : "unknown" };
    await logToolExecution(callSid, contactId, "mark_do_not_call", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: add_note ────────────────────────────────────────────────────────────
export const addNote = async (
  callSid: string,
  contactId: number,
  input: { note: string; category?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    const category = input.category || "general";
    await sql`
      INSERT INTO tasks (contact_id, call_sid, task_type, status, notes)
      VALUES (${contactId}, ${callSid}, ${"note_" + category}, 'open', ${input.note})
    `;
    const result: ToolResult = {
      success: true,
      message: "Got it, I've noted that down.",
      data: { note: input.note, category },
    };
    await logToolExecution(callSid, contactId, "add_note", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = {
      success: false,
      message: "I wasn't able to save that note right now.",
      error: err instanceof Error ? err.message : "unknown",
    };
    await logToolExecution(callSid, contactId, "add_note", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: lookup_contact ──────────────────────────────────────────────────────
export const lookupContact = async (
  callSid: string,
  contactId: number
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    const rows = await sql`
      SELECT c.name, c.email, c.business_name, c.business_type, c.website, c.notes,
             c.open_tasks, c.do_not_call, c.created_at,
             COUNT(ca.id) AS total_calls,
             MAX(ca.started_at) AS last_call
      FROM contacts c
      LEFT JOIN calls ca ON ca.contact_id = c.id
      WHERE c.id = ${contactId}
      GROUP BY c.id
    ` as any[];
    const contact = rows[0];
    if (!contact) {
      return { success: false, message: "No contact record found.", error: "not_found" };
    }
    const summary = [
      contact.name && `Name: ${contact.name}`,
      contact.email && `Email: ${contact.email}`,
      contact.business_name && `Business: ${contact.business_name}`,
      contact.notes && `Notes: ${contact.notes}`,
      `Total calls: ${contact.total_calls}`,
      contact.last_call && `Last call: ${new Date(contact.last_call).toLocaleDateString()}`,
      contact.open_tasks > 0 && `Open tasks: ${contact.open_tasks}`,
    ].filter(Boolean).join(". ");
    const result: ToolResult = {
      success: true,
      message: summary || "Contact found but no details on file.",
      data: contact,
    };
    await logToolExecution(callSid, contactId, "lookup_contact", {}, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = {
      success: false,
      message: "I couldn't retrieve the contact record right now.",
      error: err instanceof Error ? err.message : "unknown",
    };
    await logToolExecution(callSid, contactId, "lookup_contact", {}, result, Date.now() - start);
    return result;
  }
};

// ── Tool: set_callback ────────────────────────────────────────────────────────
export const setCallback = async (
  callSid: string,
  contactId: number,
  input: { callback_at?: string; reason?: string; notes?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    const noteText = [
      input.reason && `Reason: ${input.reason}`,
      input.callback_at && `Requested time: ${input.callback_at}`,
      input.notes,
    ].filter(Boolean).join(". ");
    await sql`
      INSERT INTO tasks (contact_id, call_sid, task_type, status, notes, due_at)
      VALUES (${contactId}, ${callSid}, 'callback', 'open', ${noteText || "Callback requested"},
        ${input.callback_at ? new Date(input.callback_at) : null})
    `;
    await adjustOpenTasks(contactId, 1);
    const result: ToolResult = {
      success: true,
      message: input.callback_at
        ? `Perfect, I've scheduled a callback for ${input.callback_at}. Someone will reach out then.`
        : "I've created a callback request. Our team will be in touch soon.",
      data: { contactId, callback_at: input.callback_at, reason: input.reason },
    };
    await logToolExecution(callSid, contactId, "set_callback", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = {
      success: false,
      message: "I wasn't able to schedule that callback right now.",
      error: err instanceof Error ? err.message : "unknown",
    };
    await logToolExecution(callSid, contactId, "set_callback", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: qualify_lead ────────────────────────────────────────────────────────
export const qualifyLead = async (
  callSid: string,
  contactId: number,
  input: { qualified: boolean; score?: number; reason?: string; budget?: string; timeline?: string; decision_maker?: boolean }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    const status = input.qualified ? "qualified" : "disqualified";
    const noteText = [
      `Lead ${status}`,
      input.score != null && `Score: ${input.score}/10`,
      input.reason && `Reason: ${input.reason}`,
      input.budget && `Budget: ${input.budget}`,
      input.timeline && `Timeline: ${input.timeline}`,
      input.decision_maker != null && `Decision maker: ${input.decision_maker ? "yes" : "no"}`,
    ].filter(Boolean).join(". ");
    await sql`UPDATE contacts SET notes = COALESCE(notes || E'\n', '') || ${noteText} WHERE id = ${contactId}`;
    await sql`
      INSERT INTO tasks (contact_id, call_sid, task_type, status, notes)
      VALUES (${contactId}, ${callSid}, ${status}, 'open', ${noteText})
    `;
    if (input.qualified) await adjustOpenTasks(contactId, 1);
    const result: ToolResult = {
      success: true,
      message: input.qualified
        ? "Great, I've marked this as a qualified lead and flagged it for follow-up."
        : "Understood, I've noted that this lead wasn't a fit at this time.",
      data: { status, score: input.score, reason: input.reason },
    };
    await logToolExecution(callSid, contactId, "qualify_lead", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = {
      success: false,
      message: "I wasn't able to update the lead status right now.",
      error: err instanceof Error ? err.message : "unknown",
    };
    await logToolExecution(callSid, contactId, "qualify_lead", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: check_availability ─────────────────────────────────────────────────
export const checkAvailability = async (
  callSid: string,
  contactId: number,
  input: { date?: string; service_type?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    const result: ToolResult = {
      success: true,
      message: input.date
        ? `I'll check our calendar for ${input.date} and have someone confirm the slot with you shortly.`
        : "I'll have our scheduling team reach out to confirm a time that works for you.",
      data: { date: input.date, service_type: input.service_type },
    };
    await logToolExecution(callSid, contactId, "check_availability", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = {
      success: false,
      message: "I wasn't able to check availability right now. Someone will follow up to confirm.",
      error: err instanceof Error ? err.message : "unknown",
    };
    await logToolExecution(callSid, contactId, "check_availability", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: collect_payment_info ────────────────────────────────────────────────
export const collectPaymentInfo = async (
  callSid: string,
  contactId: number,
  input: { amount?: number; currency?: string; description?: string; payment_method?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    const noteText = [
      "Payment intent captured",
      input.amount && `Amount: ${input.currency || "USD"} ${input.amount}`,
      input.description && `For: ${input.description}`,
      input.payment_method && `Method: ${input.payment_method}`,
    ].filter(Boolean).join(". ");
    await sql`
      INSERT INTO tasks (contact_id, call_sid, task_type, status, notes)
      VALUES (${contactId}, ${callSid}, 'payment_follow_up', 'open', ${noteText})
    `;
    await adjustOpenTasks(contactId, 1);
    const result: ToolResult = {
      success: true,
      message: "I've noted the payment details and flagged this for our billing team to process securely.",
      data: { amount: input.amount, currency: input.currency, description: input.description },
    };
    await logToolExecution(callSid, contactId, "collect_payment_info", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = {
      success: false,
      message: "I wasn't able to process that right now. Our team will follow up.",
      error: err instanceof Error ? err.message : "unknown",
    };
    await logToolExecution(callSid, contactId, "collect_payment_info", input, result, Date.now() - start);
    return result;
  }
};
