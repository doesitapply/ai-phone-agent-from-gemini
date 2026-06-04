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
import { insertCalendarEvent, isCalendarConfigured, checkCalendarFreebusy } from "./gcal.js";
import { findBestTeamMember } from "./team-routing.js";

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
      ${sql.json(input as any)}, ${sql.json((result.data || {}) as any)},
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
      // Use raw unsafe for dynamic columns
      const setStr = sets.map(k => `${k} = $${k}`).join(", ");
      await sql.unsafe(
        `UPDATE contacts SET ${sets.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`,
        [contactId, ...sets.map((k) => vals[k] as any)]
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
    let calendarEventUrl: string | null = null;
    if (isCalendarConfigured()) {
      try {
        const contactRows = await sql`SELECT name, phone_number, email FROM contacts WHERE id = ${contactId}`;
        const contact = contactRows[0] as { name?: string; phone_number?: string; email?: string } | undefined;
        const endMs = new Date(input.scheduled_at).getTime() + (input.duration_minutes || 60) * 60_000;
        const cal = await insertCalendarEvent({
          summary: `${input.service_type} — ${contact?.name || contact?.phone_number || "Unknown"}`,
          description: `Booked via AI Phone Agent\nCall SID: ${callSid}\n${input.notes || ""}`.trim(),
          location: input.location,
          startIso: input.scheduled_at,
          endIso: new Date(endMs).toISOString(),
          attendeeEmail: contact?.email,
        });
        if (cal.success && cal.eventId) {
          calendarEventId = cal.eventId;
          calendarEventUrl = cal.htmlLink || null;
          await sql`UPDATE appointments SET calendar_event_id = ${calendarEventId} WHERE id = ${apptId}`;
        } else {
          await sql`UPDATE appointments SET status = 'calendar_failed' WHERE id = ${apptId}`.catch(() => {});
          const result: ToolResult = {
            success: false,
            message: "I captured the appointment request, but I could not put it on the calendar yet. Someone will follow up to confirm the exact time.",
            data: { appointmentId: apptId, scheduled_at: input.scheduled_at },
            error: cal.error || "Calendar event was not created.",
          };
          await logToolExecution(callSid, contactId, "book_appointment", input, result, Date.now() - start);
          return result;
        }
      } catch (err: any) {
        await sql`UPDATE appointments SET status = 'calendar_failed' WHERE id = ${apptId}`.catch(() => {});
        const result: ToolResult = {
          success: false,
          message: "I captured the appointment request, but I could not put it on the calendar yet. Someone will follow up to confirm the exact time.",
          data: { appointmentId: apptId, scheduled_at: input.scheduled_at },
          error: err?.message || "Calendar sync failed.",
        };
        await logToolExecution(callSid, contactId, "book_appointment", input, result, Date.now() - start);
        return result;
      }
    } else {
      await sql`UPDATE appointments SET status = 'calendar_pending' WHERE id = ${apptId}`.catch(() => {});
      const result: ToolResult = {
        success: false,
        message: "I captured the appointment request, but the calendar is not connected yet. Someone will follow up to confirm the exact time.",
        data: { appointmentId: apptId, scheduled_at: input.scheduled_at },
        error: "Google Calendar is not configured.",
      };
      await logToolExecution(callSid, contactId, "book_appointment", input, result, Date.now() - start);
      return result;
    }

    const result: ToolResult = {
      success: true,
      message: `I've booked your ${input.service_type} appointment for ${input.scheduled_at}. It's on the calendar now.`,
      data: { appointmentId: apptId, scheduled_at: input.scheduled_at, calendarEventId, calendarEventUrl },
    };
    await logToolExecution(callSid, contactId, "book_appointment", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I wasn't able to schedule that right now. Let me connect you with someone who can help.", error: err instanceof Error ? err.message : "unknown" };
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

// ── Deprecated: SMS follow-up is intentionally disabled for the no-SMS product path ──
export const sendSmsFollowup = async (
  callSid: string,
  contactId: number,
  toPhone: string,
  _fromPhone: string,
  message: string,
  _twilioClient: twilio.Twilio
): Promise<ToolResult> => {
  const start = Date.now();
  const input = { toPhone, message };
  const result: ToolResult = {
    success: false,
    message: "Text-message follow-up is disabled. I can arrange a callback or email follow-up instead.",
    error: "sms_disabled",
  };
  await logToolExecution(callSid, contactId, "send_sms_followup_disabled", input, result, Date.now() - start);
  return result;
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
    topic?: string;
  }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    // Look up workspace_id from the call record
    const callRows = await sql`SELECT workspace_id FROM calls WHERE call_sid = ${callSid} LIMIT 1`;
    const wsId: number = (callRows[0] as { workspace_id: number } | undefined)?.workspace_id ?? 1;

    // Smart team routing — find the best available team member
    const routed = await findBestTeamMember(wsId, input.reason, input.topic);

    await sql`
      INSERT INTO handoffs
        (call_sid, contact_id, reason, urgency, transcript_snippet, extracted_fields,
         recommended_action, status, workspace_id,
         assigned_to_id, assigned_to_name, assigned_to_phone, assigned_to_email)
      VALUES (
        ${callSid}, ${contactId}, ${input.reason},
        ${input.urgency || "normal"}, ${input.transcript_snippet || null},
        ${input.extracted_fields ? sql.json(input.extracted_fields) : null},
        ${input.recommended_action || null}, 'pending', ${wsId},
        ${routed?.id ?? null}, ${routed?.name ?? null},
        ${routed?.phone ?? null}, ${routed?.email ?? null}
      )
    `;

    logEvent(callSid, "HANDOFF_CREATED", {
      reason: input.reason,
      urgency: input.urgency || "normal",
      routed_to: routed?.name ?? "unassigned",
    });

    // Build a personalized message if we found someone
    let message: string;
    if (routed) {
      message = `I'm connecting you with ${routed.name}, our ${routed.role}, who can better assist you with this. Please hold for just a moment.`;
    } else {
      message = "I'm connecting you with a team member who can better assist you. Please hold for just a moment.";
    }

    const result: ToolResult = {
      success: true,
      message,
      data: {
        reason: input.reason,
        urgency: input.urgency,
        routed_to: routed ?? null,
        // Pass the phone number so the call handler can bridge immediately
        transfer_phone: routed?.phone ?? null,
        transfer_name: routed?.name ?? null,
        transfer_role: routed?.role ?? null,
      },
    };
    await logToolExecution(callSid, contactId, "escalate_to_human", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = {
      success: false,
      message: "I'm having trouble connecting you right now. Please call back and ask for a team member.",
      error: err instanceof Error ? err.message : "unknown",
    };
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
    // Fetch the contact's phone number so the callback executor can dial it directly
    const contactRows = await sql<{ phone_number?: string }[]>`SELECT phone_number FROM contacts WHERE id = ${contactId} LIMIT 1`;
    const phone = contactRows[0]?.phone_number || null;
    await sql`
      INSERT INTO tasks (contact_id, call_sid, task_type, status, notes, due_at, phone_number)
      VALUES (${contactId}, ${callSid}, 'callback', 'open', ${noteText || "Callback requested"},
        ${input.callback_at ? new Date(input.callback_at) : null}, ${phone})
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
  input: { date?: string; service_type?: string; time?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    let available = true;
    let conflictMessage = "";
    // If a specific date/time is requested, check for existing appointments in that window
    if (input.date) {
      const requestedDate = input.date.trim();
      // Parse the date — accept ISO strings or natural date strings
      let windowStart: Date | null = null;
      let windowEnd: Date | null = null;
      try {
        // Try to parse as ISO datetime first, then as date-only
        const parsed = new Date(requestedDate);
        if (!isNaN(parsed.getTime())) {
          windowStart = new Date(parsed.getTime() - 30 * 60_000); // 30 min buffer before
          windowEnd = new Date(parsed.getTime() + 90 * 60_000);   // 90 min buffer after
        }
      } catch { /* ignore parse errors */ }

      if (windowStart && windowEnd) {
        // 1. Check Google Calendar free/busy (authoritative if configured)
        if (isCalendarConfigured()) {
          try {
            const fbResult = await checkCalendarFreebusy(windowStart.toISOString(), windowEnd.toISOString());
            if (fbResult.success && fbResult.busy && fbResult.busy.length > 0) {
              available = false;
              const busyTimes = fbResult.busy
                .map((b) => new Date(b.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }))
                .join(", ");
              conflictMessage = `That time slot is already booked on the calendar (busy at ${busyTimes}). `;
            }
          } catch { /* fall through to DB check */ }
        }

        // 2. Also check SMIRK's internal appointments DB
        if (available) {
          const conflicts = await sql`
            SELECT id, scheduled_at, service_type, status
            FROM appointments
            WHERE status IN ('scheduled', 'confirmed')
              AND scheduled_at >= ${windowStart.toISOString()}
              AND scheduled_at <= ${windowEnd.toISOString()}
            LIMIT 3
          `;
          if (conflicts.length > 0) {
            available = false;
            const conflictRows = conflicts as unknown as { scheduled_at: string; service_type: string }[];
            const conflictTimes = conflictRows
              .map((c) => new Date(c.scheduled_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }))
              .join(", ");
            conflictMessage = `That time slot appears to be taken (existing bookings at ${conflictTimes}). `;
          }
        }
      }
    }

    const result: ToolResult = {
      success: true,
      message: available
        ? input.date
          ? `Great news — ${input.date} looks available! I can go ahead and book that for you. What's the best name and contact number to confirm?`
          : "I'll have our scheduling team reach out to confirm a time that works for you."
        : `${conflictMessage}Can I suggest a different time, or would you like me to check another day?`,
      data: { date: input.date, service_type: input.service_type, available, conflict: !available },
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

// ── Tool: list_open_tasks ─────────────────────────────────────────────────────
export const listOpenTasks = async (
  callSid: string,
  contactId: number,
  input: { status?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    const status = input.status || "open";
    const tasks = await sql`
      SELECT id, task_type, status, notes, due_at, assigned_to, created_at
      FROM tasks
      WHERE contact_id = ${contactId}
        AND status = ${status}
      ORDER BY due_at ASC NULLS LAST, created_at DESC
      LIMIT 10
    ` as { id: number; task_type: string; status: string; notes: string; due_at: string | null; assigned_to: string | null; created_at: string }[];
    const result: ToolResult = {
      success: true,
      message: tasks.length === 0
        ? `No ${status} tasks found for this caller.`
        : `Found ${tasks.length} ${status} task${tasks.length > 1 ? "s" : ""}: ${tasks.map((t) => `[${t.id}] ${t.task_type}${t.notes ? ` — ${t.notes.slice(0, 60)}` : ""}`).join("; ")}`,
      data: { tasks, count: tasks.length },
    };
    await logToolExecution(callSid, contactId, "list_open_tasks", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I wasn't able to retrieve the task list right now.", error: err instanceof Error ? err.message : "unknown" };
    await logToolExecution(callSid, contactId, "list_open_tasks", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: complete_task ───────────────────────────────────────────────────────
export const completeTask = async (
  callSid: string,
  contactId: number,
  input: { task_id: number; resolution_notes?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    const existing = await sql`SELECT id, task_type FROM tasks WHERE id = ${input.task_id} AND contact_id = ${contactId} LIMIT 1` as { id: number; task_type: string }[];
    if (!existing.length) {
      const result: ToolResult = { success: false, message: "I couldn't find that task.", error: "Task not found" };
      await logToolExecution(callSid, contactId, "complete_task", input, result, Date.now() - start);
      return result;
    }
    await sql`
      UPDATE tasks SET
        status = 'completed',
        completed_at = NOW(),
        notes = COALESCE(${input.resolution_notes ?? null}, notes)
      WHERE id = ${input.task_id}
    `;
    await adjustOpenTasks(contactId, -1);
    const result: ToolResult = {
      success: true,
      message: `Task ${input.task_id} (${existing[0].task_type}) marked as completed.`,
      data: { task_id: input.task_id, task_type: existing[0].task_type },
    };
    await logToolExecution(callSid, contactId, "complete_task", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I wasn't able to complete that task right now.", error: err instanceof Error ? err.message : "unknown" };
    await logToolExecution(callSid, contactId, "complete_task", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: update_task ─────────────────────────────────────────────────────────
export const updateTask = async (
  callSid: string,
  contactId: number,
  input: { task_id: number; status?: string; notes?: string; assigned_to?: string; due_at?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    const VALID = ["open", "in_progress", "completed", "cancelled"];
    if (input.status && !VALID.includes(input.status)) {
      const result: ToolResult = { success: false, message: `Invalid status. Use: ${VALID.join(", ")}`, error: "Invalid status" };
      await logToolExecution(callSid, contactId, "update_task", input, result, Date.now() - start);
      return result;
    }
    const existing = await sql`SELECT id, task_type FROM tasks WHERE id = ${input.task_id} AND contact_id = ${contactId} LIMIT 1` as { id: number; task_type: string }[];
    if (!existing.length) {
      const result: ToolResult = { success: false, message: "Task not found.", error: "Not found" };
      await logToolExecution(callSid, contactId, "update_task", input, result, Date.now() - start);
      return result;
    }
    await sql`
      UPDATE tasks SET
        status      = COALESCE(${input.status      ?? null}, status),
        notes       = COALESCE(${input.notes       ?? null}, notes),
        assigned_to = COALESCE(${input.assigned_to ?? null}, assigned_to),
        due_at      = COALESCE(${input.due_at      ?? null}, due_at),
        completed_at = CASE WHEN ${input.status ?? ''} = 'completed' THEN NOW() ELSE completed_at END
      WHERE id = ${input.task_id}
    `;
    const changes = [
      input.status && `status → ${input.status}`,
      input.notes && `notes updated`,
      input.assigned_to && `assigned to ${input.assigned_to}`,
      input.due_at && `due ${input.due_at}`,
    ].filter(Boolean).join(", ");
    const result: ToolResult = {
      success: true,
      message: `Task ${input.task_id} updated: ${changes || "no changes"}.`,
      data: { task_id: input.task_id, changes },
    };
    await logToolExecution(callSid, contactId, "update_task", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I wasn't able to update that task.", error: err instanceof Error ? err.message : "unknown" };
    await logToolExecution(callSid, contactId, "update_task", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: cancel_task ─────────────────────────────────────────────────────────
export const cancelTask = async (
  callSid: string,
  contactId: number,
  input: { task_id: number; reason?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    const existing = await sql`SELECT id, task_type FROM tasks WHERE id = ${input.task_id} AND contact_id = ${contactId} LIMIT 1` as { id: number; task_type: string }[];
    if (!existing.length) {
      const result: ToolResult = { success: false, message: "Task not found.", error: "Not found" };
      await logToolExecution(callSid, contactId, "cancel_task", input, result, Date.now() - start);
      return result;
    }
    await sql`UPDATE tasks SET status = 'cancelled' WHERE id = ${input.task_id}`;
    await adjustOpenTasks(contactId, -1);
    const result: ToolResult = {
      success: true,
      message: `Task ${input.task_id} (${existing[0].task_type}) cancelled.${input.reason ? ` Reason: ${input.reason}` : ""}`,
      data: { task_id: input.task_id },
    };
    await logToolExecution(callSid, contactId, "cancel_task", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I wasn't able to cancel that task.", error: err instanceof Error ? err.message : "unknown" };
    await logToolExecution(callSid, contactId, "cancel_task", input, result, Date.now() - start);
    return result;
  }
};

const requireOperator = async (
  callSid: string,
  contactId: number | null,
  toolName: string,
  input: Record<string, unknown>,
  isOperator: boolean | undefined,
  start: number
): Promise<ToolResult | null> => {
  if (isOperator) return null;
  const result: ToolResult = {
    success: false,
    message: "I can't make workspace-wide changes from this call.",
    error: "operator_required",
  };
  await logToolExecution(callSid, contactId, toolName, input, result, Date.now() - start);
  return result;
};

// ── Operator Tool: list_workspace_tasks ───────────────────────────────────────
export const listWorkspaceTasks = async (
  callSid: string,
  contactId: number,
  workspaceId: number,
  isOperator: boolean | undefined,
  input: { status?: string; limit?: number }
): Promise<ToolResult> => {
  const start = Date.now();
  const blocked = await requireOperator(callSid, contactId, "list_workspace_tasks", input, isOperator, start);
  if (blocked) return blocked;

  try {
    const status = input.status || "open";
    const limit = Math.max(1, Math.min(Number(input.limit || 20), 50));
    const tasks = await sql`
      SELECT t.id, t.task_type, t.title, t.status, t.priority, t.notes, t.assigned_to, t.due_at, t.created_at,
             c.name AS contact_name, c.phone_number
      FROM tasks t
      LEFT JOIN contacts c ON c.id = t.contact_id
      WHERE t.workspace_id = ${workspaceId} AND t.status = ${status}
      ORDER BY t.due_at ASC NULLS LAST, t.created_at DESC
      LIMIT ${limit}
    ` as {
      id: number; task_type: string; title: string | null; status: string; priority: string | null;
      notes: string | null; assigned_to: string | null; due_at: string | null; created_at: string;
      contact_name: string | null; phone_number: string | null;
    }[];
    const summary = tasks.map((t) => {
      const label = t.title || t.task_type;
      const owner = t.assigned_to ? ` assigned to ${t.assigned_to}` : "";
      const contact = t.contact_name ? ` for ${t.contact_name}` : "";
      return `[${t.id}] ${label}${contact}${owner}`;
    }).join("; ");
    const result: ToolResult = {
      success: true,
      message: tasks.length === 0 ? `No ${status} workspace tasks found.` : `Found ${tasks.length} ${status} workspace task${tasks.length === 1 ? "" : "s"}: ${summary}`,
      data: { tasks, count: tasks.length },
    };
    await logToolExecution(callSid, contactId, "list_workspace_tasks", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I wasn't able to retrieve workspace tasks right now.", error: err instanceof Error ? err.message : "unknown" };
    await logToolExecution(callSid, contactId, "list_workspace_tasks", input, result, Date.now() - start);
    return result;
  }
};

// ── Operator Tool: create_workspace_task ──────────────────────────────────────
export const createWorkspaceTask = async (
  callSid: string,
  contactId: number,
  workspaceId: number,
  isOperator: boolean | undefined,
  input: { title: string; notes?: string; assigned_to?: string; due_at?: string; priority?: string; task_type?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  const blocked = await requireOperator(callSid, contactId, "create_workspace_task", input, isOperator, start);
  if (blocked) return blocked;

  try {
    const title = String(input.title || "").trim();
    if (!title) {
      const result: ToolResult = { success: false, message: "I need a task title before I can create it.", error: "missing_title" };
      await logToolExecution(callSid, contactId, "create_workspace_task", input, result, Date.now() - start);
      return result;
    }
    const rows = await sql`
      INSERT INTO tasks (workspace_id, contact_id, call_sid, task_type, title, status, notes, assigned_to, due_at, priority)
      VALUES (
        ${workspaceId}, ${contactId || null}, ${callSid}, ${input.task_type || "operator_task"},
        ${title}, 'open', ${input.notes || null}, ${input.assigned_to || null},
        ${input.due_at || null}, ${input.priority || "medium"}
      )
      RETURNING id, title
    ` as { id: number; title: string }[];
    const result: ToolResult = {
      success: true,
      message: `Task ${rows[0]?.id} created: ${rows[0]?.title || title}.`,
      data: { task_id: rows[0]?.id, title: rows[0]?.title || title },
    };
    await logToolExecution(callSid, contactId, "create_workspace_task", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I wasn't able to create that workspace task.", error: err instanceof Error ? err.message : "unknown" };
    await logToolExecution(callSid, contactId, "create_workspace_task", input, result, Date.now() - start);
    return result;
  }
};

// ── Operator Tool: update_workspace_task ──────────────────────────────────────
export const updateWorkspaceTask = async (
  callSid: string,
  contactId: number,
  workspaceId: number,
  isOperator: boolean | undefined,
  input: { task_id: number; status?: string; notes?: string; assigned_to?: string; due_at?: string; title?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  const blocked = await requireOperator(callSid, contactId, "update_workspace_task", input, isOperator, start);
  if (blocked) return blocked;

  try {
    const VALID = ["open", "in_progress", "completed", "cancelled"];
    if (input.status && !VALID.includes(input.status)) {
      const result: ToolResult = { success: false, message: `Invalid status. Use: ${VALID.join(", ")}`, error: "invalid_status" };
      await logToolExecution(callSid, contactId, "update_workspace_task", input, result, Date.now() - start);
      return result;
    }
    const existing = await sql`
      SELECT id, title, task_type, status, notes, assigned_to, due_at
      FROM tasks WHERE id = ${input.task_id} AND workspace_id = ${workspaceId} LIMIT 1
    ` as { id: number; title: string | null; task_type: string; status: string; notes: string | null; assigned_to: string | null; due_at: string | null }[];
    if (!existing.length) {
      const result: ToolResult = { success: false, message: "I couldn't find that workspace task.", error: "task_not_found" };
      await logToolExecution(callSid, contactId, "update_workspace_task", input, result, Date.now() - start);
      return result;
    }
    await sql`
      UPDATE tasks SET
        title        = COALESCE(${input.title ?? null}, title),
        status       = COALESCE(${input.status ?? null}, status),
        notes        = COALESCE(${input.notes ?? null}, notes),
        assigned_to  = COALESCE(${input.assigned_to ?? null}, assigned_to),
        due_at       = COALESCE(${input.due_at ?? null}, due_at),
        completed_at = CASE WHEN ${input.status ?? ""} = 'completed' THEN NOW() ELSE completed_at END,
        updated_at   = NOW()
      WHERE id = ${input.task_id} AND workspace_id = ${workspaceId}
    `;
    const after = await sql`
      SELECT id, title, task_type, status, notes, assigned_to, due_at
      FROM tasks WHERE id = ${input.task_id} AND workspace_id = ${workspaceId} LIMIT 1
    ` as { id: number; title: string | null; task_type: string; status: string; notes: string | null; assigned_to: string | null; due_at: string | null }[];
    const result: ToolResult = {
      success: true,
      message: `Task ${input.task_id} updated.`,
      data: { task_id: input.task_id, before: existing[0], after: after[0] || null },
    };
    await logToolExecution(callSid, contactId, "update_workspace_task", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I wasn't able to update that workspace task.", error: err instanceof Error ? err.message : "unknown" };
    await logToolExecution(callSid, contactId, "update_workspace_task", input, result, Date.now() - start);
    return result;
  }
};

// ── Operator Tool: delete_workspace_task ──────────────────────────────────────
export const deleteWorkspaceTask = async (
  callSid: string,
  contactId: number,
  workspaceId: number,
  isOperator: boolean | undefined,
  input: { task_id: number; reason?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  const blocked = await requireOperator(callSid, contactId, "delete_workspace_task", input, isOperator, start);
  if (blocked) return blocked;

  try {
    const before = await sql`
      SELECT id, title, task_type, status, notes, assigned_to, due_at
      FROM tasks
      WHERE id = ${input.task_id} AND workspace_id = ${workspaceId}
      LIMIT 1
    ` as { id: number; title: string | null; task_type: string; status: string; notes: string | null; assigned_to: string | null; due_at: string | null }[];
    const rows = await sql`
      DELETE FROM tasks
      WHERE id = ${input.task_id} AND workspace_id = ${workspaceId}
      RETURNING id, title, task_type
    ` as { id: number; title: string | null; task_type: string }[];
    if (!rows.length) {
      const result: ToolResult = { success: false, message: "I couldn't find that workspace task to delete.", error: "task_not_found" };
      await logToolExecution(callSid, contactId, "delete_workspace_task", input, result, Date.now() - start);
      return result;
    }
    const result: ToolResult = {
      success: true,
      message: `Deleted task ${rows[0].id}: ${rows[0].title || rows[0].task_type}.`,
      data: { task_id: rows[0].id, deleted_task: before[0] || rows[0], reason: input.reason || null },
    };
    await logToolExecution(callSid, contactId, "delete_workspace_task", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I wasn't able to delete that workspace task.", error: err instanceof Error ? err.message : "unknown" };
    await logToolExecution(callSid, contactId, "delete_workspace_task", input, result, Date.now() - start);
    return result;
  }
};

// ── Operator Tool: complete_all_open_workspace_tasks ──────────────────────────
export const completeAllOpenWorkspaceTasks = async (
  callSid: string,
  contactId: number,
  workspaceId: number,
  isOperator: boolean | undefined,
  input: { resolution_notes?: string; assigned_to?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  const blocked = await requireOperator(callSid, contactId, "complete_all_open_workspace_tasks", input, isOperator, start);
  if (blocked) return blocked;

  try {
    const before = await sql`
      SELECT id, title, task_type, status, notes, assigned_to, due_at
      FROM tasks
      WHERE workspace_id = ${workspaceId}
        AND status IN ('open', 'in_progress')
        AND (${input.assigned_to ?? null}::text IS NULL OR assigned_to = ${input.assigned_to ?? null})
      ORDER BY created_at DESC
      LIMIT 200
    ` as { id: number; title: string | null; task_type: string; status: string; notes: string | null; assigned_to: string | null; due_at: string | null }[];
    const rows = await sql`
      UPDATE tasks SET
        status = 'completed',
        completed_at = NOW(),
        updated_at = NOW(),
        notes = COALESCE(${input.resolution_notes ?? null}, notes)
      WHERE workspace_id = ${workspaceId}
        AND status IN ('open', 'in_progress')
        AND (${input.assigned_to ?? null}::text IS NULL OR assigned_to = ${input.assigned_to ?? null})
      RETURNING id
    ` as { id: number }[];
    const result: ToolResult = {
      success: true,
      message: `Marked ${rows.length} open workspace task${rows.length === 1 ? "" : "s"} complete.`,
      data: { completed_count: rows.length, task_ids: rows.map((row) => row.id), before },
    };
    await logToolExecution(callSid, contactId, "complete_all_open_workspace_tasks", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I wasn't able to complete the workspace tasks.", error: err instanceof Error ? err.message : "unknown" };
    await logToolExecution(callSid, contactId, "complete_all_open_workspace_tasks", input, result, Date.now() - start);
    return result;
  }
};

// ── Operator Tool: list_handoff_targets ───────────────────────────────────────
export const listHandoffTargets = async (
  callSid: string,
  contactId: number,
  workspaceId: number,
  isOperator: boolean | undefined,
  input: { topic?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  const blocked = await requireOperator(callSid, contactId, "list_handoff_targets", input, isOperator, start);
  if (blocked) return blocked;

  try {
    const rows = await sql`
      SELECT id, name, display_name, role, department, phone, email, is_on_call, handles_topics, priority
      FROM team_members
      WHERE workspace_id = ${workspaceId} AND is_active = TRUE
      ORDER BY is_on_call DESC, priority DESC, name ASC
      LIMIT 20
    ` as {
      id: number; name: string; display_name: string | null; role: string; department: string | null;
      phone: string | null; email: string | null; is_on_call: boolean; handles_topics: string[] | null; priority: number;
    }[];
    const topic = String(input.topic || "").toLowerCase();
    const filtered = topic
      ? rows.filter((row) => (row.handles_topics || []).some((t) => topic.includes(String(t).toLowerCase())) || row.is_on_call)
      : rows;
    const targets = filtered.length ? filtered : rows;
    const summary = targets.map((row) => {
      const name = row.display_name || row.name;
      const onCall = row.is_on_call ? "on call" : "available";
      const contact = row.phone || row.email || "no direct contact set";
      return `${name}, ${row.role}, ${onCall}, ${contact}`;
    }).join("; ");
    const result: ToolResult = {
      success: true,
      message: targets.length === 0 ? "No active handoff targets are configured." : `Available handoff targets: ${summary}`,
      data: { targets, count: targets.length },
    };
    await logToolExecution(callSid, contactId, "list_handoff_targets", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I wasn't able to retrieve handoff availability.", error: err instanceof Error ? err.message : "unknown" };
    await logToolExecution(callSid, contactId, "list_handoff_targets", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: acknowledge_handoff ─────────────────────────────────────────────────
export const acknowledgeHandoff = async (
  callSid: string,
  contactId: number,
  input: { handoff_id: number; notes?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    const existing = await sql`SELECT id FROM handoffs WHERE id = ${input.handoff_id} AND contact_id = ${contactId} LIMIT 1` as { id: number }[];
    if (!existing.length) {
      const result: ToolResult = { success: false, message: "Handoff not found.", error: "Not found" };
      await logToolExecution(callSid, contactId, "acknowledge_handoff", input, result, Date.now() - start);
      return result;
    }
    await sql`UPDATE handoffs SET status = 'acknowledged' WHERE id = ${input.handoff_id}`;
    const result: ToolResult = {
      success: true,
      message: `Handoff ${input.handoff_id} acknowledged.`,
      data: { handoff_id: input.handoff_id },
    };
    await logToolExecution(callSid, contactId, "acknowledge_handoff", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = { success: false, message: "I wasn't able to acknowledge that handoff.", error: err instanceof Error ? err.message : "unknown" };
    await logToolExecution(callSid, contactId, "acknowledge_handoff", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: route_call ──────────────────────────────────────────────────────────
// Intelligent routing decision: AI decides whether to self-handle, schedule,
// transfer to human, or create a callback. This is the "operator brain" tool.
export const routeCall = async (
  callSid: string,
  contactId: number,
  input: {
    topic: string;           // What the call is about
    urgency: "low" | "normal" | "high" | "emergency";
    caller_intent: string;   // What the caller wants to accomplish
    complexity: "simple" | "moderate" | "complex";
    sentiment?: "positive" | "neutral" | "frustrated" | "angry";
    preferred_outcome?: string; // What the AI recommends
  }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    // Routing decision matrix
    // emergency → always transfer to human immediately
    // angry + complex → transfer to human
    // simple + low urgency → AI handles it
    // booking/scheduling → AI handles it (book_appointment)
    // billing/payment → create task + callback
    // technical/complaint → create support ticket
    // everything else → AI decides based on complexity

    let decision: "ai_handles" | "transfer_human" | "schedule_callback" | "create_ticket";
    let reasoning: string;
    let action_hint: string;

    if (input.urgency === "emergency") {
      decision = "transfer_human";
      reasoning = "Emergency situations require immediate human response.";
      action_hint = "Call escalate_to_human with urgency=emergency immediately.";
    } else if (input.sentiment === "angry" && input.complexity === "complex") {
      decision = "transfer_human";
      reasoning = "Angry caller with complex issue — human intervention reduces churn risk.";
      action_hint = "Call escalate_to_human with the reason and urgency=high.";
    } else if (input.urgency === "high" && input.complexity === "complex") {
      decision = "transfer_human";
      reasoning = "High urgency + complex issue exceeds AI resolution confidence.";
      action_hint = "Call escalate_to_human with urgency=high.";
    } else if (
      input.topic.toLowerCase().includes("billing") ||
      input.topic.toLowerCase().includes("payment") ||
      input.topic.toLowerCase().includes("invoice") ||
      input.topic.toLowerCase().includes("refund")
    ) {
      decision = "schedule_callback";
      reasoning = "Billing issues require human verification and secure handling.";
      action_hint = "Call set_callback with reason=billing and collect_payment_info if amount is mentioned.";
    } else if (
      input.topic.toLowerCase().includes("technical") ||
      input.topic.toLowerCase().includes("broken") ||
      input.topic.toLowerCase().includes("not working") ||
      input.topic.toLowerCase().includes("complaint")
    ) {
      decision = "create_ticket";
      reasoning = "Technical/complaint issues need tracked resolution.";
      action_hint = "Call create_support_ticket with the issue details.";
    } else if (input.complexity === "simple" || input.urgency === "low") {
      decision = "ai_handles";
      reasoning = "Simple or low-urgency request — AI can resolve without human involvement.";
      action_hint = "Continue the conversation and use appropriate tools (book_appointment, add_note, etc.).";
    } else {
      decision = "ai_handles";
      reasoning = "Moderate complexity — AI attempts resolution, escalates if stuck.";
      action_hint = "Attempt to resolve. If unable after 2 turns, call escalate_to_human.";
    }

    // Log the routing decision as an event
    await sql`
      INSERT INTO tasks (contact_id, call_sid, task_type, status, notes)
      VALUES (${contactId}, ${callSid}, 'routing_decision', 'completed',
        ${`[${decision}] ${input.topic} | ${input.urgency} urgency | ${input.complexity} complexity | ${reasoning}`})
    `.catch(() => {/* non-critical */});

    const result: ToolResult = {
      success: true,
      message: `Routing decision: ${decision}. ${reasoning} ${action_hint}`,
      data: {
        decision,
        reasoning,
        action_hint,
        topic: input.topic,
        urgency: input.urgency,
        complexity: input.complexity,
        sentiment: input.sentiment,
      },
    };
    await logToolExecution(callSid, contactId, "route_call", input, result, Date.now() - start);
    return result;
  } catch (err) {
    const result: ToolResult = {
      success: false,
      message: "I wasn't able to determine the best routing right now. I'll handle this directly.",
      error: err instanceof Error ? err.message : "unknown",
    };
    await logToolExecution(callSid, contactId, "route_call", input, result, Date.now() - start);
    return result;
  }
};

// ── Tool: make_outbound_call ──────────────────────────────────────────────────
export const makeOutboundCall = async (
  callSid: string,
  contactId: number,
  input: {
    to_number: string;
    reason: string;
    message?: string;
    from_number: string;
    app_url: string;
    twilio_client: any | null;
  }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    if (!input.twilio_client) {
      const result: ToolResult = { success: false, message: "Outbound calling is not configured right now.", error: "No Twilio client" };
      await logToolExecution(callSid, contactId, "make_outbound_call", input as any, result, Date.now() - start);
      return result;
    }
    const to = input.to_number.startsWith("+") ? input.to_number : `+1${input.to_number.replace(/\D/g, "")}`;
    const twimlMsg = input.message
      ? `<Response><Say voice="Polly.Joanna">${input.message.replace(/[<>&]/g, (c: string) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] || c))}</Say></Response>`
      : `<Response><Say voice="Polly.Joanna">Hello, this is SMIRK calling on behalf of your service team. Please hold.</Say></Response>`;
    const twimlUrl = `${input.app_url}/api/twiml/inline?xml=${encodeURIComponent(twimlMsg)}`;
    const call = await input.twilio_client.calls.create({
      to,
      from: input.from_number,
      url: twimlUrl,
      statusCallback: `${input.app_url}/api/twilio/status`,
    });
    await sql`
      INSERT INTO tasks (contact_id, call_sid, task_type, status, notes)
      VALUES (${contactId}, ${callSid}, 'outbound_call', 'completed',
        ${`Outbound call placed to ${to}. Reason: ${input.reason}. SID: ${call.sid}`})
    `.catch(() => {/* non-critical */});
    const result: ToolResult = {
      success: true,
      message: `Outbound call placed to ${to}. The call is connecting now.`,
      data: { to, call_sid: call.sid, reason: input.reason },
    };
    await logToolExecution(callSid, contactId, "make_outbound_call", input as any, result, Date.now() - start);
    return result;
  } catch (err: any) {
    const result: ToolResult = {
      success: false,
      message: "I wasn't able to place that call right now. Please try again or dial manually.",
      error: err.message,
    };
    await logToolExecution(callSid, contactId, "make_outbound_call", input as any, result, Date.now() - start);
    return result;
  }
};

// ── Tool: search_web ─────────────────────────────────────────────────────────
// Falls back through: Serper → Brave → DuckDuckGo (no key required)
export const searchWeb = async (
  callSid: string,
  contactId: number,
  input: { query: string; context?: string }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    const serperKey = process.env.SERPER_API_KEY;
    const braveKey = process.env.BRAVE_API_KEY;
    let snippets: string[] = [];

    if (serperKey) {
      const resp = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": serperKey, "Content-Type": "application/json" },
        body: JSON.stringify({ q: input.query, num: 3 }),
      });
      if (resp.ok) {
        const data: any = await resp.json();
        const organic = data.organic || [];
        snippets = organic.slice(0, 3).map((r: any) => `${r.title}: ${r.snippet || r.link}`);
        if (data.answerBox?.answer) snippets.unshift(data.answerBox.answer);
      }
    } else if (braveKey) {
      const resp = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(input.query)}&count=3`, {
        headers: { "Accept": "application/json", "X-Subscription-Token": braveKey },
      });
      if (resp.ok) {
        const data: any = await resp.json();
        snippets = (data.web?.results || []).slice(0, 3).map((r: any) => `${r.title}: ${r.description || r.url}`);
      }
    } else {
      // Keyless fallback: DuckDuckGo instant answers
      const resp = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(input.query)}&format=json&no_html=1&skip_disambig=1`);
      if (resp.ok) {
        const data: any = await resp.json();
        if (data.AbstractText) snippets.push(data.AbstractText);
        if (data.Answer) snippets.push(data.Answer);
        (data.RelatedTopics || []).slice(0, 2).forEach((t: any) => { if (t.Text) snippets.push(t.Text); });
      }
    }

    if (snippets.length === 0) {
      const result: ToolResult = { success: false, message: "I couldn't find current information on that right now.", error: "No results" };
      await logToolExecution(callSid, contactId, "search_web", input as any, result, Date.now() - start);
      return result;
    }

    const summary = snippets.slice(0, 3).join(" | ");
    const result: ToolResult = {
      success: true,
      message: `Here's what I found: ${summary}`,
      data: { query: input.query, snippets },
    };
    await logToolExecution(callSid, contactId, "search_web", input as any, result, Date.now() - start);
    return result;
  } catch (err: any) {
    const result: ToolResult = {
      success: false,
      message: "I wasn't able to search for that right now.",
      error: err.message,
    };
    await logToolExecution(callSid, contactId, "search_web", input as any, result, Date.now() - start);
    return result;
  }
};

// ── Tool: request_new_skill ───────────────────────────────────────────────────
// Agent uses this to flag capability gaps in real time.
// Stored in skill_requests table for human review + optional auto-scaffold.
export const requestNewSkill = async (
  callSid: string,
  contactId: number,
  input: {
    skill_name: string;
    description: string;
    caller_need: string;
    suggested_api?: string;
  }
): Promise<ToolResult> => {
  const start = Date.now();
  try {
    await sql`
      INSERT INTO skill_requests (skill_name, description, caller_need, suggested_api, call_sid, contact_id, request_count, status)
      VALUES (
        ${input.skill_name}, ${input.description}, ${input.caller_need},
        ${input.suggested_api || null}, ${callSid}, ${contactId}, 1, 'pending'
      )
      ON CONFLICT (skill_name) DO UPDATE SET
        request_count = skill_requests.request_count + 1,
        last_requested_at = NOW(),
        caller_need = EXCLUDED.caller_need,
        call_sid = EXCLUDED.call_sid
    `;
    const result: ToolResult = {
      success: true,
      message: `I've noted that I need the ability to ${input.description}. I'll let the team know so they can add this capability.`,
      data: { skill_name: input.skill_name, status: "pending_review" },
    };
    await logToolExecution(callSid, contactId, "request_new_skill", input as any, result, Date.now() - start);
    return result;
  } catch (err: any) {
    const result: ToolResult = {
      success: false,
      message: "I've made note of that capability gap.",
      error: err.message,
    };
    await logToolExecution(callSid, contactId, "request_new_skill", input as any, result, Date.now() - start);
    return result;
  }
};
