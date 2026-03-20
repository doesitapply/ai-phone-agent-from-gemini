/**
 * Lead Upsert Integration Bus
 *
 * Single entry point for all lead capture events.
 * Validates input, upserts the lead record, then fans out to:
 *   - HubSpot contact upsert (if configured)
 *   - Google Calendar event creation (if booked + configured)
 *   - SMS confirmation to lead (if phone + Twilio configured)
 *   - Operator SMS alert (if configured)
 *
 * Funnel stages: captured → qualified → booked → follow_up_due → closed
 *
 * All side effects are fire-and-forget with graceful fallback logging.
 */

import { sql } from "./db.js";
import { hubspotUpsertContact, isHubSpotConfigured } from "./crm.js";
import { insertCalendarEvent, isCalendarConfigured } from "./gcal.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type FunnelStage = "captured" | "qualified" | "booked" | "follow_up_due" | "closed";

export interface LeadUpsertInput {
  // Identity (at least one required)
  phone?: string;
  email?: string;
  name?: string;

  // Lead info
  company?: string;
  title?: string;
  industry?: string;
  location?: string;
  serviceType?: string;       // e.g. "HVAC", "plumbing", "roofing"
  notes?: string;
  source?: string;            // "inbound_call" | "manual" | "campaign" | etc.
  callSid?: string;           // link to call record

  // Funnel progression
  funnelStage?: FunnelStage;
  qualifiedAt?: string;       // ISO timestamp
  bookedAt?: string;          // ISO timestamp
  followUpDueAt?: string;     // ISO timestamp

  // Appointment (for Calendar + SMS)
  appointmentTime?: string;   // ISO datetime e.g. "2026-03-25T10:00:00"
  appointmentTz?: string;     // IANA tz e.g. "America/Los_Angeles"
  appointmentDurationMins?: number; // default 60

  // Workspace
  workspaceId?: number;
}

export interface LeadUpsertResult {
  leadId: number;
  action: "created" | "updated";
  funnelStage: FunnelStage;
  hubspot?: { success: boolean; recordId?: string; error?: string };
  calendar?: { success: boolean; eventId?: string; eventUrl?: string; error?: string };
  sms?: { confirmation?: boolean; alert?: boolean; error?: string };
}

// ── Validation ────────────────────────────────────────────────────────────────

export function validateLeadInput(input: LeadUpsertInput): string | null {
  if (!input.phone && !input.email) {
    return "At least one of phone or email is required.";
  }
  if (input.phone && !/^\+?[\d\s\-().]{7,20}$/.test(input.phone)) {
    return `Invalid phone format: ${input.phone}`;
  }
  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    return `Invalid email format: ${input.email}`;
  }
  const validStages: FunnelStage[] = ["captured", "qualified", "booked", "follow_up_due", "closed"];
  if (input.funnelStage && !validStages.includes(input.funnelStage)) {
    return `Invalid funnel_stage: ${input.funnelStage}. Valid: ${validStages.join(", ")}`;
  }
  return null;
}

// ── Normalise phone to E.164 ──────────────────────────────────────────────────

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
  return `+${digits}`;
}

// ── Core upsert ───────────────────────────────────────────────────────────────

async function upsertLeadRecord(
  input: LeadUpsertInput,
  workspaceId: number
): Promise<{ leadId: number; action: "created" | "updated"; funnelStage: FunnelStage }> {
  const phone = input.phone ? normalizePhone(input.phone) : null;
  const stage = input.funnelStage ?? "captured";
  const now = new Date().toISOString();

  // Determine timestamp fields based on stage
  const qualifiedAt = input.qualifiedAt
    ?? (["qualified", "booked", "follow_up_due", "closed"].includes(stage) ? now : null);
  const bookedAt = input.bookedAt
    ?? (["booked", "closed"].includes(stage) ? now : null);
  const followUpDueAt = input.followUpDueAt ?? null;

  if (phone) {
    // Upsert by (workspace_id, phone) — never create duplicate phone entries
    const rows = await sql`
      INSERT INTO leads (
        workspace_id, name, phone, email, company, title, industry,
        location, service_type, notes, source, call_sid,
        funnel_stage, qualified_at, booked_at, follow_up_due_at,
        appointment_time, appointment_tz, updated_at
      ) VALUES (
        ${workspaceId},
        ${input.name ?? null},
        ${phone},
        ${input.email ?? null},
        ${input.company ?? null},
        ${input.title ?? null},
        ${input.industry ?? null},
        ${input.location ?? null},
        ${input.serviceType ?? null},
        ${input.notes ?? null},
        ${input.source ?? "inbound_call"},
        ${input.callSid ?? null},
        ${stage},
        ${qualifiedAt},
        ${bookedAt},
        ${followUpDueAt},
        ${input.appointmentTime ?? null},
        ${input.appointmentTz ?? "America/Los_Angeles"},
        ${now}
      )
      ON CONFLICT (workspace_id, phone) WHERE phone IS NOT NULL DO UPDATE SET
        name             = COALESCE(NULLIF(EXCLUDED.name, ''),          leads.name),
        email            = COALESCE(NULLIF(EXCLUDED.email, ''),         leads.email),
        company          = COALESCE(NULLIF(EXCLUDED.company, ''),       leads.company),
        title            = COALESCE(NULLIF(EXCLUDED.title, ''),         leads.title),
        industry         = COALESCE(NULLIF(EXCLUDED.industry, ''),      leads.industry),
        location         = COALESCE(NULLIF(EXCLUDED.location, ''),      leads.location),
        service_type     = COALESCE(NULLIF(EXCLUDED.service_type, ''),  leads.service_type),
        notes            = COALESCE(NULLIF(EXCLUDED.notes, ''),         leads.notes),
        call_sid         = COALESCE(NULLIF(EXCLUDED.call_sid, ''),      leads.call_sid),
        funnel_stage     = CASE
          WHEN leads.funnel_stage = 'closed' THEN leads.funnel_stage
          WHEN EXCLUDED.funnel_stage = 'captured' THEN leads.funnel_stage
          ELSE EXCLUDED.funnel_stage
        END,
        qualified_at     = COALESCE(leads.qualified_at, EXCLUDED.qualified_at),
        booked_at        = COALESCE(leads.booked_at, EXCLUDED.booked_at),
        follow_up_due_at = COALESCE(EXCLUDED.follow_up_due_at, leads.follow_up_due_at),
        appointment_time = COALESCE(NULLIF(EXCLUDED.appointment_time, ''), leads.appointment_time),
        appointment_tz   = COALESCE(NULLIF(EXCLUDED.appointment_tz, ''), leads.appointment_tz),
        updated_at       = ${now}
      RETURNING id, funnel_stage, xmax
    `;
    const row = rows[0] as { id: number; funnel_stage: string; xmax: number };
    return {
      leadId: row.id,
      action: row.xmax === 0 ? "created" : "updated",
      funnelStage: row.funnel_stage as FunnelStage,
    };
  } else {
    // Email-only lead — no composite unique index, just insert
    const rows = await sql`
      INSERT INTO leads (
        workspace_id, name, phone, email, company, title, industry,
        location, service_type, notes, source, call_sid,
        funnel_stage, qualified_at, booked_at, follow_up_due_at,
        appointment_time, appointment_tz, updated_at
      ) VALUES (
        ${workspaceId},
        ${input.name ?? null},
        NULL,
        ${input.email ?? null},
        ${input.company ?? null},
        ${input.title ?? null},
        ${input.industry ?? null},
        ${input.location ?? null},
        ${input.serviceType ?? null},
        ${input.notes ?? null},
        ${input.source ?? "inbound_call"},
        ${input.callSid ?? null},
        ${stage},
        ${qualifiedAt},
        ${bookedAt},
        ${followUpDueAt},
        ${input.appointmentTime ?? null},
        ${input.appointmentTz ?? "America/Los_Angeles"},
        ${now}
      )
      RETURNING id, funnel_stage
    `;
    const row = rows[0] as { id: number; funnel_stage: string };
    return { leadId: row.id, action: "created", funnelStage: row.funnel_stage as FunnelStage };
  }
}

// ── HubSpot side effect ───────────────────────────────────────────────────────

async function syncToHubSpot(
  input: LeadUpsertInput,
  leadId: number,
  funnelStage: FunnelStage
): Promise<{ success: boolean; recordId?: string; error?: string }> {
  if (!isHubSpotConfigured()) return { success: false, error: "not_configured" };
  try {
    const result = await hubspotUpsertContact({
      phone: input.phone ?? "",
      name: input.name,
      email: input.email,
      company: input.company,
      notes: [
        input.serviceType ? `Service: ${input.serviceType}` : "",
        input.notes ?? "",
        `SMIRK Lead ID: ${leadId}`,
        `Funnel Stage: ${funnelStage}`,
      ].filter(Boolean).join("\n"),
    });
    // Write back hubspot_id
    if (result.success && result.recordId) {
      await sql`UPDATE leads SET hubspot_id = ${result.recordId} WHERE id = ${leadId}`;
    }
    return { success: result.success, recordId: result.recordId, error: result.error };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── Google Calendar side effect ───────────────────────────────────────────────

async function syncToCalendar(
  input: LeadUpsertInput,
  leadId: number
): Promise<{ success: boolean; eventId?: string; eventUrl?: string; error?: string }> {
  if (!isCalendarConfigured()) return { success: false, error: "not_configured" };
  if (!input.appointmentTime) return { success: false, error: "no_appointment_time" };
  try {
    const durationMins = input.appointmentDurationMins ?? 60;
    const startDt = new Date(input.appointmentTime);
    const endDt = new Date(startDt.getTime() + durationMins * 60_000);
    const result = await insertCalendarEvent({
      summary: `${input.serviceType ?? "Service"} Appointment — ${input.name ?? input.phone ?? "Lead"}`,
      description: [
        input.name ? `Name: ${input.name}` : "",
        input.phone ? `Phone: ${input.phone}` : "",
        input.email ? `Email: ${input.email}` : "",
        input.serviceType ? `Service: ${input.serviceType}` : "",
        input.notes ? `Notes: ${input.notes}` : "",
        `SMIRK Lead ID: ${leadId}`,
      ].filter(Boolean).join("\n"),
      startIso: startDt.toISOString(),
      endIso: endDt.toISOString(),
      attendeeEmail: input.email,
      timeZone: input.appointmentTz ?? "America/Los_Angeles",
    });
    if (result.success && result.eventId) {
      await sql`
        UPDATE leads
        SET calendar_event_id = ${result.eventId},
            calendar_event_url = ${result.htmlLink ?? null}
        WHERE id = ${leadId}
      `;
    }
    return { success: result.success, eventId: result.eventId, eventUrl: result.htmlLink, error: result.error };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── SMS side effects ──────────────────────────────────────────────────────────

async function sendSmsConfirmation(
  input: LeadUpsertInput,
  funnelStage: FunnelStage
): Promise<{ confirmation: boolean; alert: boolean; error?: string }> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  const alertNumber = process.env.OPERATOR_ALERT_NUMBER ?? process.env.HUMAN_TRANSFER_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    return { confirmation: false, alert: false, error: "twilio_not_configured" };
  }

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const sendSms = async (to: string, body: string): Promise<boolean> => {
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: to, From: fromNumber, Body: body }).toString(),
      });
      return r.ok;
    } catch { return false; }
  };

  let confirmationSent = false;
  let alertSent = false;

  // Lead confirmation SMS
  if (input.phone && funnelStage === "booked" && input.appointmentTime) {
    const apptDate = new Date(input.appointmentTime).toLocaleString("en-US", {
      timeZone: input.appointmentTz ?? "America/Los_Angeles",
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
    const body = `Hi ${input.name ?? "there"}! Your ${input.serviceType ?? "service"} appointment is confirmed for ${apptDate}. Reply STOP to opt out.`;
    confirmationSent = await sendSms(normalizePhone(input.phone), body);
    if (confirmationSent) {
      await sql`UPDATE leads SET sms_sent_at = NOW() WHERE phone = ${normalizePhone(input.phone)}`;
    }
  }

  // Operator alert SMS
  if (alertNumber && (funnelStage === "booked" || funnelStage === "qualified")) {
    const body = `SMIRK LEAD: ${input.name ?? "Unknown"} | ${input.phone ?? input.email} | ${input.serviceType ?? "service"} | Stage: ${funnelStage}${input.appointmentTime ? ` | Appt: ${input.appointmentTime}` : ""}`;
    alertSent = await sendSms(alertNumber, body);
  }

  return { confirmation: confirmationSent, alert: alertSent };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function upsertLead(
  input: LeadUpsertInput,
  workspaceId: number = 1
): Promise<LeadUpsertResult> {
  const validationError = validateLeadInput(input);
  if (validationError) throw new Error(validationError);

  // 1. Core upsert
  const { leadId, action, funnelStage } = await upsertLeadRecord(input, workspaceId);

  // 2. Fan out side effects (fire-and-forget — never block the response)
  const [hubspot, calendar, sms] = await Promise.allSettled([
    syncToHubSpot(input, leadId, funnelStage),
    funnelStage === "booked" ? syncToCalendar(input, leadId) : Promise.resolve({ success: false, error: "not_booked" }),
    sendSmsConfirmation(input, funnelStage),
  ]);

  return {
    leadId,
    action,
    funnelStage,
    hubspot:  hubspot.status  === "fulfilled" ? hubspot.value  : { success: false, error: String((hubspot as any).reason) },
    calendar: calendar.status === "fulfilled" ? calendar.value : { success: false, error: String((calendar as any).reason) },
    sms:      sms.status      === "fulfilled" ? sms.value      : { confirmation: false, alert: false, error: String((sms as any).reason) },
  };
}
