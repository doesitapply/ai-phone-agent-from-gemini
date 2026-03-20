/**
 * Lead Upsert Integration Bus  (v2 — hardened)
 *
 * Acceptance guarantees:
 *   1. Idempotent — same phone twice → update, never duplicate
 *   2. Validation — explicit 400-level errors for every bad field
 *   3. Timestamps — qualified_at / booked_at set exactly once, never cleared
 *   4. Side-effect writeback — hubspot_id, calendar_event_id, sms_sent_at,
 *      hubspot_synced_at, calendar_synced_at, integration_status, last_error
 *      all written to the lead row so ops can audit without reading logs
 *
 * Funnel stages (frozen set — do not add strings elsewhere):
 *   captured → qualified → booked → follow_up_due → closed
 *
 * Side-effect flags:
 *   HubSpot   — only if HUBSPOT_ACCESS_TOKEN is set
 *   Calendar  — only if GOOGLE_SERVICE_ACCOUNT_JSON + GOOGLE_CALENDAR_ID are set
 *   SMS       — only if TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_NUMBER are set
 */

import { sql } from "./db.js";
import { hubspotUpsertContact, isHubSpotConfigured } from "./crm.js";
import { insertCalendarEvent, isCalendarConfigured } from "./gcal.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type FunnelStage = "captured" | "qualified" | "booked" | "follow_up_due" | "closed";

/** Frozen valid stage list — single source of truth */
export const VALID_FUNNEL_STAGES: FunnelStage[] = [
  "captured", "qualified", "booked", "follow_up_due", "closed",
];

export interface LeadUpsertInput {
  // Identity — at least one of phone or email is required
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
  callSid?: string;           // spine: link back to call record

  // Funnel
  funnelStage?: FunnelStage;
  followUpDueAt?: string;     // ISO timestamp — caller sets explicitly if needed

  // Appointment (drives Calendar + SMS confirmation)
  appointmentTime?: string;   // ISO datetime e.g. "2026-03-25T10:00:00"
  appointmentTz?: string;     // IANA tz e.g. "America/Los_Angeles"
  appointmentDurationMins?: number; // default 60
}

export interface LeadUpsertResult {
  leadId: number;
  action: "created" | "updated";
  funnelStage: FunnelStage;
  hubspot?: { success: boolean; recordId?: string; error?: string };
  calendar?: { success: boolean; eventId?: string; eventUrl?: string; error?: string };
  sms?: { confirmation: boolean; alert: boolean; error?: string };
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateLeadInputDetailed(input: LeadUpsertInput): ValidationResult {
  const errors: string[] = [];

  // Identity check
  if (!input.phone && !input.email) {
    errors.push("At least one of 'phone' or 'email' is required.");
  }

  // Phone format
  if (input.phone) {
    const digits = input.phone.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) {
      errors.push(`'phone' must be 7–15 digits (got "${input.phone}").`);
    }
  }

  // Email format
  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    errors.push(`'email' format is invalid (got "${input.email}").`);
  }

  // Funnel stage
  if (input.funnelStage && !VALID_FUNNEL_STAGES.includes(input.funnelStage)) {
    errors.push(
      `'funnelStage' must be one of: ${VALID_FUNNEL_STAGES.join(", ")} (got "${input.funnelStage}").`
    );
  }

  // Appointment time — if provided must parse as a valid date
  if (input.appointmentTime) {
    const d = new Date(input.appointmentTime);
    if (isNaN(d.getTime())) {
      errors.push(`'appointmentTime' is not a valid ISO datetime (got "${input.appointmentTime}").`);
    }
  }

  // Duration sanity
  if (input.appointmentDurationMins !== undefined) {
    if (
      !Number.isInteger(input.appointmentDurationMins) ||
      input.appointmentDurationMins < 5 ||
      input.appointmentDurationMins > 480
    ) {
      errors.push(`'appointmentDurationMins' must be an integer between 5 and 480.`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Legacy single-string form used by the HTTP handler for 400 responses */
export function validateLeadInput(input: LeadUpsertInput): string | null {
  const { valid, errors } = validateLeadInputDetailed(input);
  return valid ? null : errors.join(" | ");
}

// ── Phone normalisation ───────────────────────────────────────────────────────

export function normalizePhone(phone: string): string {
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

  // Timestamps: set exactly once when the stage is first reached — never cleared.
  // COALESCE(existing, new) in the ON CONFLICT block handles the "set once" rule.
  const qualifiedAt =
    ["qualified", "booked", "follow_up_due", "closed"].includes(stage) ? now : null;
  const bookedAt =
    ["booked", "closed"].includes(stage) ? now : null;
  const followUpDueAt = input.followUpDueAt ?? null;

  if (phone) {
    // ── Phone-keyed upsert (idempotent by workspace_id + phone) ──────────────
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
        name             = COALESCE(NULLIF(EXCLUDED.name, ''),         leads.name),
        email            = COALESCE(NULLIF(EXCLUDED.email, ''),        leads.email),
        company          = COALESCE(NULLIF(EXCLUDED.company, ''),      leads.company),
        title            = COALESCE(NULLIF(EXCLUDED.title, ''),        leads.title),
        industry         = COALESCE(NULLIF(EXCLUDED.industry, ''),     leads.industry),
        location         = COALESCE(NULLIF(EXCLUDED.location, ''),     leads.location),
        service_type     = COALESCE(NULLIF(EXCLUDED.service_type, ''), leads.service_type),
        notes            = COALESCE(NULLIF(EXCLUDED.notes, ''),        leads.notes),
        call_sid         = COALESCE(NULLIF(EXCLUDED.call_sid, ''),     leads.call_sid),
        appointment_time = COALESCE(NULLIF(EXCLUDED.appointment_time, ''), leads.appointment_time),
        appointment_tz   = COALESCE(NULLIF(EXCLUDED.appointment_tz, ''),  leads.appointment_tz),
        funnel_stage     = CASE
          WHEN (CASE leads.funnel_stage
                  WHEN 'captured'      THEN 0
                  WHEN 'qualified'     THEN 1
                  WHEN 'booked'        THEN 2
                  WHEN 'follow_up_due' THEN 3
                  WHEN 'closed'        THEN 4
                  ELSE 0 END)
               >= (CASE EXCLUDED.funnel_stage
                     WHEN 'captured'      THEN 0
                     WHEN 'qualified'     THEN 1
                     WHEN 'booked'        THEN 2
                     WHEN 'follow_up_due' THEN 3
                     WHEN 'closed'        THEN 4
                     ELSE 0 END)
          THEN leads.funnel_stage
          ELSE EXCLUDED.funnel_stage
        END,
        qualified_at     = COALESCE(leads.qualified_at,     EXCLUDED.qualified_at),
        booked_at        = COALESCE(leads.booked_at,        EXCLUDED.booked_at),
        follow_up_due_at = COALESCE(EXCLUDED.follow_up_due_at, leads.follow_up_due_at),
        updated_at       = ${now}
      RETURNING id, funnel_stage, created_at, updated_at
    `;
    const row = rows[0] as { id: number; funnel_stage: string; created_at: string; updated_at: string };
    const createdMs  = new Date(row.created_at).getTime();
    const updatedMs  = new Date(row.updated_at).getTime();
    const isInsert   = Math.abs(createdMs - updatedMs) < 2000;
    return {
      leadId: row.id,
      action: isInsert ? "created" : "updated",
      funnelStage: row.funnel_stage as FunnelStage,
    };
  } else {
    // ── Email-only upsert (idempotent by workspace_id + email) ───────────────
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
      ON CONFLICT (workspace_id, email) WHERE email IS NOT NULL AND phone IS NULL DO UPDATE SET
        name             = COALESCE(NULLIF(EXCLUDED.name, ''),         leads.name),
        company          = COALESCE(NULLIF(EXCLUDED.company, ''),      leads.company),
        service_type     = COALESCE(NULLIF(EXCLUDED.service_type, ''), leads.service_type),
        notes            = COALESCE(NULLIF(EXCLUDED.notes, ''),        leads.notes),
        call_sid         = COALESCE(NULLIF(EXCLUDED.call_sid, ''),     leads.call_sid),
        appointment_time = COALESCE(NULLIF(EXCLUDED.appointment_time, ''), leads.appointment_time),
        appointment_tz   = COALESCE(NULLIF(EXCLUDED.appointment_tz, ''),  leads.appointment_tz),
        funnel_stage     = CASE
          WHEN (CASE leads.funnel_stage
                  WHEN 'captured'      THEN 0
                  WHEN 'qualified'     THEN 1
                  WHEN 'booked'        THEN 2
                  WHEN 'follow_up_due' THEN 3
                  WHEN 'closed'        THEN 4
                  ELSE 0 END)
               >= (CASE EXCLUDED.funnel_stage
                     WHEN 'captured'      THEN 0
                     WHEN 'qualified'     THEN 1
                     WHEN 'booked'        THEN 2
                     WHEN 'follow_up_due' THEN 3
                     WHEN 'closed'        THEN 4
                     ELSE 0 END)
          THEN leads.funnel_stage
          ELSE EXCLUDED.funnel_stage
        END,
        qualified_at     = COALESCE(leads.qualified_at, EXCLUDED.qualified_at),
        booked_at        = COALESCE(leads.booked_at,    EXCLUDED.booked_at),
        follow_up_due_at = COALESCE(EXCLUDED.follow_up_due_at, leads.follow_up_due_at),
        updated_at       = ${now}
      RETURNING id, funnel_stage, created_at, updated_at
    `;
    const row = rows[0] as { id: number; funnel_stage: string; created_at: string; updated_at: string };
    const createdMs  = new Date(row.created_at).getTime();
    const updatedMs  = new Date(row.updated_at).getTime();
    const isInsert   = Math.abs(createdMs - updatedMs) < 2000;
    return {
      leadId: row.id,
      action: isInsert ? "created" : "updated",
      funnelStage: row.funnel_stage as FunnelStage,
    };
  }
}

// ── Side-effect writeback helper ──────────────────────────────────────────────

async function writeIntegrationStatus(
  leadId: number,
  status: { hubspot?: string; calendar?: string; sms?: string },
  lastError?: string
): Promise<void> {
  try {
    await sql`
      UPDATE leads
      SET integration_status = ${JSON.stringify(status)}::jsonb,
          last_error         = ${lastError ?? null},
          updated_at         = NOW()
      WHERE id = ${leadId}
    `;
  } catch { /* never block on writeback failure */ }
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
      funnelStage,
      smirkLeadId: leadId,
      notes: [
        input.serviceType ? `Service: ${input.serviceType}` : "",
        input.notes ?? "",
      ].filter(Boolean).join("\n") || undefined,
    });
    if (result.success && result.recordId) {
      await sql`
        UPDATE leads
        SET hubspot_id        = ${result.recordId},
            hubspot_synced_at = NOW()
        WHERE id = ${leadId}
      `;
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
    if (isNaN(startDt.getTime())) return { success: false, error: "invalid_appointment_time" };
    const endDt = new Date(startDt.getTime() + durationMins * 60_000);
    const result = await insertCalendarEvent({
      summary: `${input.serviceType ?? "Service"} Appointment — ${input.name ?? input.phone ?? "Lead"}`,
      description: [
        input.name        ? `Name: ${input.name}`           : "",
        input.phone       ? `Phone: ${input.phone}`         : "",
        input.email       ? `Email: ${input.email}`         : "",
        input.serviceType ? `Service: ${input.serviceType}` : "",
        input.notes       ? `Notes: ${input.notes}`         : "",
        `SMIRK Lead ID: ${leadId}`,
      ].filter(Boolean).join("\n"),
      startIso: startDt.toISOString(),
      endIso:   endDt.toISOString(),
      attendeeEmail: input.email,
      timeZone: input.appointmentTz ?? "America/Los_Angeles",
    });
    if (result.success && result.eventId) {
      await sql`
        UPDATE leads
        SET calendar_event_id  = ${result.eventId},
            calendar_event_url = ${result.htmlLink ?? null},
            calendar_synced_at = NOW()
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
  leadId: number,
  funnelStage: FunnelStage
): Promise<{ confirmation: boolean; alert: boolean; error?: string }> {
  const accountSid  = process.env.TWILIO_ACCOUNT_SID;
  const authToken   = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber  = process.env.TWILIO_PHONE_NUMBER;
  const alertNumber = process.env.OPERATOR_ALERT_NUMBER ?? process.env.HUMAN_TRANSFER_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    return { confirmation: false, alert: false, error: "twilio_not_configured" };
  }

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const sendSms = async (to: string, body: string): Promise<boolean> => {
    try {
      const r = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ To: to, From: fromNumber, Body: body }).toString(),
        }
      );
      return r.ok;
    } catch { return false; }
  };

  let confirmationSent = false;
  let alertSent = false;

  // Appointment confirmation to lead (only when booked + appointment time present)
  if (input.phone && funnelStage === "booked" && input.appointmentTime) {
    const apptDate = new Date(input.appointmentTime).toLocaleString("en-US", {
      timeZone: input.appointmentTz ?? "America/Los_Angeles",
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
    const body = `Hi ${input.name ?? "there"}! Your ${input.serviceType ?? "service"} appointment is confirmed for ${apptDate}. Reply STOP to opt out.`;
    confirmationSent = await sendSms(normalizePhone(input.phone), body);
    if (confirmationSent) {
      await sql`UPDATE leads SET sms_sent_at = NOW() WHERE id = ${leadId}`;
    }
  }

  // Operator alert for qualified or booked leads
  if (alertNumber && (funnelStage === "booked" || funnelStage === "qualified")) {
    const body = [
      `SMIRK LEAD: ${input.name ?? "Unknown"}`,
      input.phone ?? input.email,
      input.serviceType ?? "service",
      `Stage: ${funnelStage}`,
      input.appointmentTime ? `Appt: ${input.appointmentTime}` : "",
    ].filter(Boolean).join(" | ");
    alertSent = await sendSms(alertNumber, body);
  }

  return { confirmation: confirmationSent, alert: alertSent };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function upsertLead(
  input: LeadUpsertInput,
  workspaceId: number = 1
): Promise<LeadUpsertResult> {
  // Validate first — throw so callers get a clean error message
  const { valid, errors } = validateLeadInputDetailed(input);
  if (!valid) throw new Error(errors.join(" | "));

  // 1. Core upsert — always succeeds or throws (never swallowed)
  const { leadId, action, funnelStage } = await upsertLeadRecord(input, workspaceId);

  // 2. Fan out side effects in parallel — each is independently guarded
  const [hubspotResult, calendarResult, smsResult] = await Promise.allSettled([
    syncToHubSpot(input, leadId, funnelStage),
    funnelStage === "booked"
      ? syncToCalendar(input, leadId)
      : Promise.resolve({ success: false, error: "not_booked" }),
    sendSmsConfirmation(input, leadId, funnelStage),
  ]);

  const hubspot  = hubspotResult.status  === "fulfilled" ? hubspotResult.value  : { success: false, error: String((hubspotResult  as any).reason) };
  const calendar = calendarResult.status === "fulfilled" ? calendarResult.value : { success: false, error: String((calendarResult as any).reason) };
  const sms      = smsResult.status      === "fulfilled" ? smsResult.value      : { confirmation: false, alert: false, error: String((smsResult as any).reason) };

  // 3. Write integration status back to the lead row (ops visibility without log diving)
  const integrationStatus = {
    hubspot:  hubspot.success  ? "ok" : (hubspot.error  === "not_configured" ? "skip" : "error"),
    calendar: calendar.success ? "ok" : (calendar.error === "not_configured" || calendar.error === "not_booked" ? "skip" : "error"),
    sms:      sms.confirmation ? "ok" : (sms.error === "twilio_not_configured" ? "skip" : "error"),
  };
  const errors2 = [
    !hubspot.success  && hubspot.error  && hubspot.error  !== "not_configured" && hubspot.error  !== "not_booked"  ? `hubspot: ${hubspot.error}`   : "",
    !calendar.success && calendar.error && calendar.error !== "not_configured" && calendar.error !== "not_booked"  ? `calendar: ${calendar.error}` : "",
    !sms.confirmation && sms.error      && sms.error      !== "twilio_not_configured"                              ? `sms: ${sms.error}`           : "",
  ].filter(Boolean).join("; ");

  await writeIntegrationStatus(leadId, integrationStatus, errors2 || null);

  return { leadId, action, funnelStage, hubspot, calendar, sms };
}
