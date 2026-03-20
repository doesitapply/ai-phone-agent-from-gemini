/**
 * Post-Call Intelligence Module — Postgres version
 *
 * After every call ends:
 * 1. Generates a structured summary using OpenRouter (primary) or Gemini (fallback)
 * 2. Classifies intent, outcome, and sentiment
 * 3. Assigns a resolution score (0.0–1.0)
 * 4. Extracts entities (name, email, phone, business, address, service, appointment details, notes)
 * 5. Persists everything to call_summaries, contact_custom_fields, contacts, tasks, and appointments
 */
import { sql } from "./db.js";
import { updateContactSummary, adjustOpenTasks } from "./contacts.js";
import { logEvent } from "./events.js";

export const INTENTS = [
  "appointment_booking", "appointment_reschedule", "appointment_cancel",
  "lead_capture", "support_issue", "billing_question", "emergency",
  "general_inquiry", "follow_up", "do_not_call_request", "unknown",
] as const;
export type Intent = (typeof INTENTS)[number];

export const OUTCOMES = [
  "resolved", "appointment_booked", "appointment_rescheduled", "appointment_cancelled",
  "lead_captured", "escalated", "callback_needed", "incomplete",
  "do_not_call", "voicemail", "spam",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type CallSummaryResult = {
  intent: Intent;
  summary: string;
  outcome: Outcome;
  next_action: string;
  sentiment: "positive" | "neutral" | "negative" | "frustrated";
  confidence: number;
  resolution_score: number;
  extracted_entities: Record<string, string>;
  entity_confidence?: Record<string, number>;
  entity_snippets?: Record<string, string>;
  appointment?: {
    date: string;        // ISO date string e.g. "2026-03-20"
    time: string;        // e.g. "2:00 PM"
    service: string;     // service type booked
    notes: string;       // any special notes
  } | null;
  tasks?: Array<{
    task_type: string;   // e.g. "follow_up", "send_quote", "callback", "confirm_appointment"
    notes: string;
    due_in_hours: number; // how many hours from now the task is due
  }>;
};

const SUMMARY_PROMPT = (transcript: string) => `You are an expert AI call analyst for a sales and appointment-booking phone agent. Analyze this phone call transcript and return a comprehensive structured JSON summary.

TRANSCRIPT:
${transcript}

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "intent": "<one of: appointment_booking, appointment_reschedule, appointment_cancel, lead_capture, support_issue, billing_question, emergency, general_inquiry, follow_up, do_not_call_request, unknown>",
  "summary": "<2-4 sentence plain English summary of what happened, what was agreed, and what needs to happen next>",
  "outcome": "<one of: resolved, appointment_booked, appointment_rescheduled, appointment_cancelled, lead_captured, escalated, callback_needed, incomplete, do_not_call, voicemail, spam>",
  "next_action": "<specific, actionable next step — be concrete, e.g. 'Call back Thursday at 2pm to confirm appointment' or 'Send quote for roof repair to john@example.com'>",
  "sentiment": "<one of: positive, neutral, negative, frustrated>",
  "confidence": <0.0 to 1.0 — how confident you are in this analysis>,
  "resolution_score": <0.0 to 1.0 — 1.0 means fully resolved, 0.0 means nothing accomplished>,
  "extracted_entities": {
    "caller_name": "<full name if mentioned, else empty string>",
    "first_name": "<first name only, else empty string>",
    "last_name": "<last name only, else empty string>",
    "business_name": "<business name if mentioned, else empty string>",
    "business_type": "<type of business e.g. 'restaurant', 'law firm', else empty string>",
    "address": "<full address if mentioned, else empty string>",
    "city": "<city if mentioned, else empty string>",
    "state": "<state if mentioned, else empty string>",
    "zip": "<zip code if mentioned, else empty string>",
    "service_type": "<specific service requested e.g. 'roof repair', 'tax consultation', else empty string>",
    "preferred_time": "<preferred appointment time as stated by caller, else empty string>",
    "appointment_date": "<confirmed appointment date in YYYY-MM-DD format if booked, else empty string>",
    "appointment_time": "<confirmed appointment time e.g. '2:00 PM' if booked, else empty string>",
    "phone_number": "<alternate or callback phone number if mentioned, else empty string>",
    "email": "<email address if mentioned, else empty string>",
    "website": "<website if mentioned, else empty string>",
    "urgency": "<one of: low, normal, high, emergency>",
    "budget": "<budget or price range if mentioned, else empty string>",
    "referral_source": "<how they heard about us if mentioned, else empty string>",
    "notes": "<any other important details, special requests, or context that doesn't fit above fields>"
  },
  "entity_confidence": {
    "caller_name": <0.0-1.0>,
    "email": <0.0-1.0>,
    "phone_number": <0.0-1.0>,
    "service_type": <0.0-1.0>,
    "appointment_date": <0.0-1.0>,
    "appointment_time": <0.0-1.0>,
    "address": <0.0-1.0>
  },
  "entity_snippets": {
    "caller_name": "<exact quote from transcript where name was mentioned, or empty>",
    "email": "<exact quote from transcript where email was mentioned, or empty>",
    "phone_number": "<exact quote from transcript where phone was mentioned, or empty>",
    "service_type": "<exact quote from transcript where service was mentioned, or empty>",
    "appointment_date": "<exact quote from transcript where date was mentioned, or empty>",
    "appointment_time": "<exact quote from transcript where time was mentioned, or empty>"
  },
  "appointment": ${"`"}${"`"}${"`"}if an appointment was booked or rescheduled, include this object, otherwise null${"`"}${"`"}${"`"} {
    "date": "<YYYY-MM-DD or empty if not confirmed>",
    "time": "<e.g. '2:00 PM' or empty if not confirmed>",
    "service": "<service being booked>",
    "notes": "<any special instructions or notes for the appointment>"
  },
  "tasks": [
    ${"`"}${"`"}${"`"}include one task object for each follow-up action needed. Common types: follow_up, send_quote, callback, confirm_appointment, send_contract, check_availability, escalate_to_human${"`"}${"`"}${"`"}
    {
      "task_type": "<task type>",
      "notes": "<specific details about what needs to be done>",
      "due_in_hours": <number of hours from now this should be done, e.g. 24 for tomorrow, 1 for urgent>
    }
  ]
}

IMPORTANT RULES:
- Extract EVERY piece of information mentioned in the call, even if the caller only mentioned it briefly
- If an appointment was booked, ALWAYS populate the appointment object and include a confirm_appointment task
- If the caller gave their name, ALWAYS extract it — even if they only said it once
- If the outcome is callback_needed, escalated, or incomplete, ALWAYS include at least one follow_up task
- If an email or phone was mentioned, extract it exactly as spoken
- tasks array should be empty [] only if the call was fully resolved with no follow-up needed`;

async function summarizeViaOpenRouter(prompt: string): Promise<CallSummaryResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
  const model = process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001";

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": process.env.APP_URL || "https://ai-phone-agent.railway.app",
      "X-Title": "AI Phone Agent",
    },
  });

  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2048,
    temperature: 0.1,
  });

  const raw = response.choices[0]?.message?.content?.trim() || "";
  const cleaned = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
  return JSON.parse(cleaned) as CallSummaryResult;
}

async function summarizeViaGemini(prompt: string, apiKey: string): Promise<CallSummaryResult> {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: prompt,
    config: { temperature: 0.1, maxOutputTokens: 2048 },
  });
  const raw = response.text?.trim() || "";
  const cleaned = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
  return JSON.parse(cleaned) as CallSummaryResult;
}

export const generateCallSummary = async (
  callSid: string,
  geminiApiKey?: string
): Promise<CallSummaryResult> => {
  const messages = await sql<{ role: string; text: string }[]>`
    SELECT role, text FROM messages WHERE call_sid = ${callSid} ORDER BY id ASC
  `;

  if (messages.length === 0) return buildDefaultSummary("No conversation recorded.");

  const transcript = messages
    .map((m) => `${m.role === "user" ? "Caller" : "Agent"}: ${m.text}`)
    .join("\n");

  const prompt = SUMMARY_PROMPT(transcript);

  if (process.env.OPENROUTER_API_KEY) {
    try {
      const result = await summarizeViaOpenRouter(prompt);
      result.confidence = Math.max(0, Math.min(1, result.confidence || 0.5));
      result.resolution_score = Math.max(0, Math.min(1, result.resolution_score || 0.5));
      return result;
    } catch (err) {
      console.error("[intelligence] OpenRouter summarize failed:", err);
    }
  }

  if (geminiApiKey) {
    try {
      const result = await summarizeViaGemini(prompt, geminiApiKey);
      result.confidence = Math.max(0, Math.min(1, result.confidence || 0.5));
      result.resolution_score = Math.max(0, Math.min(1, result.resolution_score || 0.5));
      return result;
    } catch (err) {
      console.error("[intelligence] Gemini summarize failed:", err);
    }
  }

  return buildDefaultSummary("No AI configured for post-call analysis.");
};

const buildDefaultSummary = (reason: string): CallSummaryResult => ({
  intent: "unknown",
  summary: reason,
  outcome: "incomplete",
  next_action: "Review call manually",
  sentiment: "neutral",
  confidence: 0.0,
  resolution_score: 0.0,
  extracted_entities: {},
  tasks: [],
});

export const persistCallSummary = async (
  callSid: string,
  contactId: number | null,
  summary: CallSummaryResult
): Promise<void> => {
  const callRows = await sql<{ workspace_id: number | null }[]>`
    SELECT workspace_id FROM calls WHERE call_sid = ${callSid} LIMIT 1
  `;
  const workspaceId = Number(callRows[0]?.workspace_id || 1);

  // ── 1. Save call summary ──────────────────────────────────────────────────
  await sql`
    INSERT INTO call_summaries
      (call_sid, contact_id, intent, summary, outcome, next_action, sentiment, confidence, resolution_score, extracted_entities, workspace_id)
    VALUES (
      ${callSid}, ${contactId}, ${summary.intent}, ${summary.summary},
      ${summary.outcome}, ${summary.next_action}, ${summary.sentiment},
      ${summary.confidence}, ${summary.resolution_score},
      ${sql.json(summary.extracted_entities || {})}, ${workspaceId}
    )
    ON CONFLICT (call_sid) DO UPDATE SET
      intent = EXCLUDED.intent,
      summary = EXCLUDED.summary,
      outcome = EXCLUDED.outcome,
      next_action = EXCLUDED.next_action,
      sentiment = EXCLUDED.sentiment,
      confidence = EXCLUDED.confidence,
      resolution_score = EXCLUDED.resolution_score,
      extracted_entities = EXCLUDED.extracted_entities,
      workspace_id = EXCLUDED.workspace_id
  `;

  await sql`UPDATE calls SET resolution_score = ${summary.resolution_score} WHERE call_sid = ${callSid} AND workspace_id = ${workspaceId}`;

  // ── 2. Write ALL extracted entities into contact_custom_fields ────────────
  if (contactId && summary.extracted_entities) {
    const entityMap: Record<string, string> = {
      caller_name:      "caller_name",
      first_name:       "first_name",
      last_name:        "last_name",
      business_name:    "business_name",
      business_type:    "business_type",
      address:          "address",
      city:             "city",
      state:            "state",
      zip:              "zip",
      service_type:     "service_type",
      preferred_time:   "preferred_time",
      appointment_date: "appointment_date",
      appointment_time: "appointment_time",
      phone_number:     "alt_phone",
      email:            "email",
      website:          "website",
      urgency:          "urgency",
      budget:           "budget",
      referral_source:  "referral_source",
      notes:            "call_notes",
    };

    for (const [entityKey, fieldKey] of Object.entries(entityMap)) {
      const value = (summary.extracted_entities as any)[entityKey];
      if (value && String(value).trim()) {
        const conf = summary.entity_confidence?.[entityKey] ?? null;
        const snippet = summary.entity_snippets?.[entityKey] ?? null;
        await sql`
          INSERT INTO contact_custom_fields (contact_id, field_key, field_value, source, confidence, transcript_snippet, call_sid, updated_at, workspace_id)
          VALUES (${contactId}, ${fieldKey}, ${String(value).trim()}, 'ai_extracted', ${conf}, ${snippet}, ${callSid}, NOW(), ${workspaceId})
          ON CONFLICT (contact_id, field_key) DO UPDATE
          SET field_value = EXCLUDED.field_value, source = 'ai_extracted',
              confidence = EXCLUDED.confidence, transcript_snippet = EXCLUDED.transcript_snippet,
              call_sid = EXCLUDED.call_sid, updated_at = NOW(), workspace_id = EXCLUDED.workspace_id
        `;
      }
    }

    // ── 3. Update core contacts table with all captured fields ──────────────
    const e = summary.extracted_entities as any;
    const name = e.caller_name || (e.first_name && e.last_name ? `${e.first_name} ${e.last_name}` : e.first_name || e.last_name) || null;
    const email = e.email || null;
    const address = e.address || null;
    const city = e.city || null;
    const state = e.state || null;
    const zip = e.zip || null;
    const businessName = e.business_name || null;

    // Build a dynamic update that only overwrites empty/null fields
    await sql`
      UPDATE contacts SET
        name         = CASE WHEN (name IS NULL OR name = '') AND ${!!name}         THEN ${name || ''}         ELSE name END,
        email        = CASE WHEN (email IS NULL OR email = '') AND ${!!email}       THEN ${email || ''}       ELSE email END,
        address      = CASE WHEN (address IS NULL OR address = '') AND ${!!address} THEN ${address || ''}     ELSE address END,
        city         = CASE WHEN (city IS NULL OR city = '') AND ${!!city}          THEN ${city || ''}        ELSE city END,
        state        = CASE WHEN (state IS NULL OR state = '') AND ${!!state}       THEN ${state || ''}       ELSE state END,
        zip          = CASE WHEN (zip IS NULL OR zip = '') AND ${!!zip}             THEN ${zip || ''}         ELSE zip END,
        business_name = CASE WHEN (business_name IS NULL OR business_name = '') AND ${!!businessName} THEN ${businessName || ''} ELSE business_name END,
        company_name = CASE WHEN (company_name IS NULL OR company_name = '') AND ${!!businessName} THEN ${businessName || ''} ELSE company_name END,
        updated_at   = NOW()
      WHERE id = ${contactId} AND workspace_id = ${workspaceId}
    `;
  }

  // ── 4. Update contact summary text ───────────────────────────────────────
  if (contactId) {
    await updateContactSummary(contactId, summary.summary, summary.outcome);
  }

  // ── 5. Save appointment record if one was booked ─────────────────────────────
  if (contactId && summary.appointment && summary.outcome === "appointment_booked") {
    const appt = summary.appointment;
    const scheduledAt = appt.date && appt.time
      ? new Date(`${appt.date} ${appt.time}`)
      : null;
    if (scheduledAt && !isNaN(scheduledAt.getTime())) {
      // Check if an appointment for this call already exists before inserting
      const existing = await sql`SELECT id FROM appointments WHERE call_sid = ${callSid} LIMIT 1`;
      if (existing.length === 0) {
        await sql`
          INSERT INTO appointments (contact_id, call_sid, scheduled_at, service_type, notes, status, workspace_id)
          VALUES (${contactId}, ${callSid}, ${scheduledAt.toISOString()}, ${appt.service || null}, ${appt.notes || null}, 'scheduled', ${workspaceId})
        `;
      }
    }
  }

  // ── 6. Generate tasks from the AI's task list ─────────────────────────────
  const aiTasks = summary.tasks || [];

  // Always create a follow_up task for outcomes that need attention
  const alwaysFollowUp = ["callback_needed", "incomplete", "escalated"].includes(summary.outcome);
  const hasFollowUp = aiTasks.some(t => t.task_type === "follow_up");

  if (alwaysFollowUp && !hasFollowUp && contactId) {
    aiTasks.push({
      task_type: "follow_up",
      notes: summary.next_action || "Review and follow up on this call",
      due_in_hours: 24,
    });
  }

  // Always create a confirm_appointment task when an appointment is booked
  if (summary.outcome === "appointment_booked" && contactId) {
    const hasConfirm = aiTasks.some(t => t.task_type === "confirm_appointment");
    if (!hasConfirm) {
      aiTasks.push({
        task_type: "confirm_appointment",
        notes: summary.appointment
          ? `Confirm appointment for ${summary.appointment.service} on ${summary.appointment.date} at ${summary.appointment.time}`
          : summary.next_action || "Confirm the booked appointment",
        due_in_hours: 2,
      });
    }
  }

  if (contactId && aiTasks.length > 0) {
    for (const task of aiTasks) {
      const dueAt = new Date(Date.now() + (task.due_in_hours || 24) * 3600 * 1000);
      await sql`
        INSERT INTO tasks (contact_id, call_sid, task_type, status, notes, due_at, workspace_id)
        VALUES (${contactId}, ${callSid}, ${task.task_type}, 'open', ${task.notes || null}, ${dueAt.toISOString()}, ${workspaceId})
      `;
      await adjustOpenTasks(contactId, 1);
    }
  }

  logEvent(callSid, "SUMMARY_GENERATED", {
    intent: summary.intent,
    outcome: summary.outcome,
    resolution_score: summary.resolution_score,
    sentiment: summary.sentiment,
    tasks_created: aiTasks.length,
    entities_extracted: Object.keys(summary.extracted_entities || {}).filter(k => (summary.extracted_entities as any)[k]).length,
  });
};

export const runPostCallIntelligence = async (
  callSid: string,
  contactId: number | null,
  geminiApiKey?: string
): Promise<void> => {
  const summary = await generateCallSummary(callSid, geminiApiKey);
  await persistCallSummary(callSid, contactId, summary);
};
