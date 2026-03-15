/**
 * Outbound Webhook System
 *
 * Fires structured call data to any configured URL after every call ends.
 * Supports Zapier, Make (Integromat), HubSpot, Slack, custom CRMs, etc.
 *
 * Configuration (env vars or Settings page):
 *   WEBHOOK_URL          — primary endpoint (required to enable)
 *   WEBHOOK_SECRET       — optional HMAC-SHA256 signing secret
 *   WEBHOOK_EVENTS       — comma-separated list of events to fire (default: all)
 *                          Options: call_completed, lead_captured, appointment_booked,
 *                                   handoff_created, task_created
 *   WEBHOOK_RETRY_COUNT  — number of retries on failure (default: 3)
 *
 * Payload shape (same for all events, event-specific fields added):
 * {
 *   event: "call_completed",
 *   timestamp: "2026-03-15T12:00:00Z",
 *   call: { sid, from, to, direction, duration_seconds, started_at, ended_at, agent_name },
 *   contact: { id, name, phone, email, company, tags, notes },
 *   summary: { intent, outcome, sentiment, resolution_score, next_action, summary },
 *   extracted: { name, email, phone, business_name, service_type, ... },
 *   transcript_url: "https://your-app.railway.app/api/calls/{sid}/transcript",
 *   appointments: [...],
 *   tasks: [...],
 * }
 */

import crypto from "crypto";
import { sql } from "./db.js";
import { logEvent } from "./events.js";

export interface WebhookConfig {
  url: string;
  secret?: string;
  events: string[];
  retryCount: number;
  enabled: boolean;
}

export interface WebhookPayload {
  event: string;
  timestamp: string;
  call: {
    sid: string;
    from: string;
    to: string;
    direction: string;
    duration_seconds: number | null;
    started_at: string;
    ended_at: string | null;
    agent_name: string | null;
    recording_url: string | null;
  };
  contact: {
    id: number | null;
    name: string | null;
    phone: string | null;
    email: string | null;
    company: string | null;
    tags: string[];
    notes: string | null;
    total_calls: number;
    first_seen: string | null;
  };
  summary: {
    intent: string | null;
    outcome: string | null;
    sentiment: string | null;
    resolution_score: number | null;
    next_action: string | null;
    summary: string | null;
  };
  extracted: Record<string, string>;
  transcript_url: string;
  appointments: Array<{
    id: number;
    service_type: string | null;
    scheduled_at: string;
    duration_minutes: number;
    location: string | null;
    status: string;
  }>;
  tasks: Array<{
    id: number;
    task_type: string;
    status: string;
    notes: string | null;
    due_at: string | null;
  }>;
  handoffs: Array<{
    id: number;
    reason: string;
    urgency: string;
    status: string;
  }>;
}

export function loadWebhookConfig(): WebhookConfig | null {
  const url = process.env.WEBHOOK_URL;
  if (!url) return null;

  const eventsRaw = process.env.WEBHOOK_EVENTS || "call_completed,lead_captured,appointment_booked,handoff_created,task_created";
  return {
    url,
    secret: process.env.WEBHOOK_SECRET,
    events: eventsRaw.split(",").map((e) => e.trim()).filter(Boolean),
    retryCount: parseInt(process.env.WEBHOOK_RETRY_COUNT || "3", 10),
    enabled: true,
  };
}

/** Sign payload with HMAC-SHA256 for webhook verification */
function signPayload(payload: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/** Fire a single webhook with retry logic */
async function fireWebhook(
  config: WebhookConfig,
  payload: WebhookPayload,
  attempt = 1
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "SMIRK-AI-Phone-Agent/1.0",
    "X-SMIRK-Event": payload.event,
    "X-SMIRK-Call-SID": payload.call.sid,
    "X-SMIRK-Timestamp": payload.timestamp,
    "X-SMIRK-Delivery-Attempt": String(attempt),
  };

  if (config.secret) {
    headers["X-SMIRK-Signature"] = signPayload(body, config.secret);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(config.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (res.ok) {
      return { success: true, statusCode: res.status };
    }

    // Retry on 5xx
    if (res.status >= 500 && attempt < config.retryCount) {
      await new Promise((r) => setTimeout(r, attempt * 1000)); // exponential backoff
      return fireWebhook(config, payload, attempt + 1);
    }

    return { success: false, statusCode: res.status, error: `HTTP ${res.status}` };
  } catch (err: any) {
    if (attempt < config.retryCount) {
      await new Promise((r) => setTimeout(r, attempt * 1000));
      return fireWebhook(config, payload, attempt + 1);
    }
    return { success: false, error: err.message };
  }
}

/** Build the full webhook payload from DB for a completed call */
export async function buildCallPayload(callSid: string, appUrl: string): Promise<WebhookPayload | null> {
  // Load call
  const callRows = await sql<any[]>`
    SELECT c.*, a.name as agent_name
    FROM calls c
    LEFT JOIN agent_configs a ON c.agent_id = a.id
    WHERE c.call_sid = ${callSid}
    LIMIT 1
  `;
  if (!callRows.length) return null;
  const call = callRows[0];

  // Load contact
  let contact: WebhookPayload["contact"] = {
    id: null, name: null, phone: null, email: null,
    company: null, tags: [], notes: null, total_calls: 0, first_seen: null,
  };
  if (call.contact_id) {
    const contactRows = await sql<any[]>`SELECT * FROM contacts WHERE id = ${call.contact_id} LIMIT 1`;
    if (contactRows.length) {
      const c = contactRows[0];
      contact = {
        id: c.id,
        name: c.name,
        phone: c.phone_number,
        email: c.email,
        company: c.company,
        tags: c.tags || [],
        notes: c.notes,
        total_calls: c.total_calls || 0,
        first_seen: c.first_seen?.toISOString?.() || c.first_seen,
      };
    }
  }

  // Load summary + extracted entities
  const summaryRows = await sql<any[]>`
    SELECT * FROM call_summaries WHERE call_sid = ${callSid} ORDER BY created_at DESC LIMIT 1
  `;
  const summaryRow = summaryRows[0];
  const summary: WebhookPayload["summary"] = {
    intent: summaryRow?.intent || null,
    outcome: summaryRow?.outcome || null,
    sentiment: summaryRow?.sentiment || null,
    resolution_score: summaryRow?.resolution_score || null,
    next_action: summaryRow?.next_action || null,
    summary: summaryRow?.summary || null,
  };
  const extracted: Record<string, string> = summaryRow?.extracted_entities || {};

  // If contact has email/name not in extracted, add them
  if (contact.name && !extracted.name) extracted.name = contact.name;
  if (contact.email && !extracted.email) extracted.email = contact.email;
  if (contact.phone && !extracted.phone_number) extracted.phone_number = contact.phone;
  if (contact.company && !extracted.business_name) extracted.business_name = contact.company;

  // Load appointments
  const apptRows = await sql<any[]>`
    SELECT id, service_type, scheduled_at, duration_minutes, location, status
    FROM appointments WHERE call_sid = ${callSid}
  `;
  const appointments = apptRows.map((a) => ({
    id: a.id,
    service_type: a.service_type,
    scheduled_at: a.scheduled_at?.toISOString?.() || a.scheduled_at,
    duration_minutes: a.duration_minutes,
    location: a.location,
    status: a.status,
  }));

  // Load tasks
  const taskRows = await sql<any[]>`
    SELECT id, task_type, status, notes, due_at FROM tasks WHERE call_sid = ${callSid}
  `;
  const tasks = taskRows.map((t) => ({
    id: t.id,
    task_type: t.task_type,
    status: t.status,
    notes: t.notes,
    due_at: t.due_at?.toISOString?.() || t.due_at,
  }));

  // Load handoffs
  const handoffRows = await sql<any[]>`
    SELECT id, reason, urgency, status FROM handoffs WHERE call_sid = ${callSid}
  `;
  const handoffs = handoffRows.map((h) => ({
    id: h.id,
    reason: h.reason,
    urgency: h.urgency,
    status: h.status,
  }));

  return {
    event: "call_completed",
    timestamp: new Date().toISOString(),
    call: {
      sid: call.call_sid,
      from: call.from_number,
      to: call.to_number,
      direction: call.direction,
      duration_seconds: call.duration_seconds,
      started_at: call.started_at?.toISOString?.() || call.started_at,
      ended_at: call.ended_at?.toISOString?.() || call.ended_at,
      agent_name: call.agent_name,
      recording_url: call.recording_url || null,
    },
    contact,
    summary,
    extracted,
    transcript_url: `${appUrl}/api/calls/${callSid}/transcript`,
    appointments,
    tasks,
    handoffs,
  };
}

/** Persist webhook delivery attempt to DB */
async function logWebhookDelivery(
  callSid: string,
  event: string,
  url: string,
  success: boolean,
  statusCode: number | undefined,
  error: string | undefined,
  durationMs: number
): Promise<void> {
  try {
    await sql`
      INSERT INTO webhook_deliveries (call_sid, event, url, success, status_code, error_message, duration_ms)
      VALUES (${callSid}, ${event}, ${url}, ${success}, ${statusCode || null}, ${error || null}, ${durationMs})
    `;
  } catch {
    // Don't let logging failure break anything
  }
}

/** Main entry point: fire all configured webhooks for a call */
export async function fireCallWebhooks(
  callSid: string,
  appUrl: string,
  event = "call_completed"
): Promise<void> {
  const config = loadWebhookConfig();
  if (!config) return;
  if (!config.events.includes(event) && !config.events.includes("*")) return;

  const payload = await buildCallPayload(callSid, appUrl);
  if (!payload) return;

  payload.event = event;
  const start = Date.now();
  const result = await fireWebhook(config, payload);
  const durationMs = Date.now() - start;

  await logWebhookDelivery(callSid, event, config.url, result.success, result.statusCode, result.error, durationMs);
  logEvent(callSid, "WEBHOOK_FIRED", { event, url: config.url, success: result.success, statusCode: result.statusCode, durationMs });

  if (!result.success) {
    console.error(`[Webhook] Delivery failed for ${callSid}: ${result.error}`);
  }
}

/** Fire a test webhook with sample data */
export async function fireTestWebhook(url: string, secret?: string): Promise<{ success: boolean; statusCode?: number; error?: string; durationMs: number }> {
  const config: WebhookConfig = { url, secret, events: ["*"], retryCount: 1, enabled: true };
  const testPayload: WebhookPayload = {
    event: "test",
    timestamp: new Date().toISOString(),
    call: {
      sid: "CA_TEST_" + Date.now(),
      from: "+15551234567",
      to: "+15559876543",
      direction: "inbound",
      duration_seconds: 87,
      started_at: new Date(Date.now() - 90_000).toISOString(),
      ended_at: new Date().toISOString(),
      agent_name: "SMIRK",
      recording_url: null,
    },
    contact: {
      id: 1,
      name: "Jane Smith",
      phone: "+15551234567",
      email: "jane@example.com",
      company: "Acme HVAC",
      tags: ["lead", "hvac"],
      notes: null,
      total_calls: 1,
      first_seen: new Date().toISOString(),
    },
    summary: {
      intent: "book_appointment",
      outcome: "appointment_booked",
      sentiment: "positive",
      resolution_score: 0.92,
      next_action: "Send confirmation SMS",
      summary: "Caller requested AC tune-up appointment for next Tuesday morning.",
    },
    extracted: {
      name: "Jane Smith",
      email: "jane@example.com",
      phone_number: "+15551234567",
      business_name: "Acme HVAC",
      service_type: "AC tune-up",
      preferred_time: "Tuesday morning",
    },
    transcript_url: `${url}/api/calls/CA_TEST/transcript`,
    appointments: [{
      id: 1,
      service_type: "AC tune-up",
      scheduled_at: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      duration_minutes: 60,
      location: "123 Main St",
      status: "scheduled",
    }],
    tasks: [],
    handoffs: [],
  };

  const start = Date.now();
  const result = await fireWebhook(config, testPayload);
  return { ...result, durationMs: Date.now() - start };
}
