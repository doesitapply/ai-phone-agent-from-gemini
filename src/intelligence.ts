/**
 * Post-Call Intelligence Module — Postgres version
 *
 * After every call ends:
 * 1. Generates a structured summary using OpenRouter (primary) or Gemini (fallback)
 * 2. Classifies intent, outcome, and sentiment
 * 3. Assigns a resolution score (0.0–1.0)
 * 4. Extracts entities (name, email, phone, business, address, service, callback window, notes)
 * 5. Persists everything to call_summaries, contact_custom_fields, contacts, and callback tasks
 */
import { sql } from "./db.js";
import { createHash } from "node:crypto";
import { updateContactSummary } from "./contacts.js";
import { logEvent } from "./events.js";
import { upsertLead, type FunnelStage } from "./leads-upsert.js";
import { runMandatoryPostCallArtifactPipeline } from "./post-call-durability.js";

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

const SUMMARY_PROMPT = (transcript: string) => `You are an expert call analyst for a missed-call recovery workflow. Analyze this phone call transcript and return a comprehensive structured JSON summary.

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
    ${"`"}${"`"}${"`"}include one task object only for real follow-up obligations. Common types: callback, send_quote, confirm_appointment, send_contract, check_availability, escalate_to_human${"`"}${"`"}${"`"}
    {
      "task_type": "<task type>",
      "notes": "<specific details about what needs to be done>",
      "due_in_hours": <number of hours from now this should be done, e.g. 24 for tomorrow, 1 for urgent>
    }
  ]
}

IMPORTANT RULES:
- Extract EVERY piece of information mentioned in the call, even if the caller only mentioned it briefly
- SMIRK's first-dollar workflow does not book, reschedule, cancel, or confirm field-service appointments. Treat requested dates/times as callback preferences for owner review.
- Never set outcome to appointment_booked, appointment_rescheduled, or appointment_cancelled for this workflow; use callback_needed, lead_captured, escalated, incomplete, or resolved instead.
- Always set appointment to null. If the caller requested a time, capture it in preferred_time and create a callback or check_availability task for the owner.
- If the caller gave their name, ALWAYS extract it — even if they only said it once
- If the outcome is callback_needed or escalated, include a specific callback or escalation task
- If the outcome is incomplete, create a task only when the business still owes the caller a concrete action; otherwise use next_action to explain the missing information
- If an email or phone was mentioned, extract it exactly as spoken
- Do not create generic FYI, review, summary, "check dashboard", or vague follow_up tasks
- tasks array should be empty [] when there is no clear owner obligation after the call`;

async function summarizeViaOpenRouter(prompt: string): Promise<CallSummaryResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
  const model = process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash";

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": process.env.APP_URL || "https://ai-phone-agent.railway.app",
      "X-Title": "SMIRK Missed-Call Recovery",
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
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
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
      return normalizeFirstDollarSummary(result);
    } catch (err) {
      console.error("[intelligence] OpenRouter summarize failed:", err);
    }
  }

  if (geminiApiKey) {
    try {
      const result = await summarizeViaGemini(prompt, geminiApiKey);
      result.confidence = Math.max(0, Math.min(1, result.confidence || 0.5));
      result.resolution_score = Math.max(0, Math.min(1, result.resolution_score || 0.5));
      return normalizeFirstDollarSummary(result);
    } catch (err) {
      console.error("[intelligence] Gemini summarize failed:", err);
    }
  }

  return normalizeFirstDollarSummary(buildDefaultSummary("No AI configured for post-call analysis."));
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

const normalizeFirstDollarSummary = (summary: CallSummaryResult): CallSummaryResult => {
  const appointmentLike =
    summary.intent === "appointment_booking" ||
    summary.intent === "appointment_reschedule" ||
    summary.intent === "appointment_cancel" ||
    summary.outcome === "appointment_booked" ||
    summary.outcome === "appointment_rescheduled" ||
    summary.outcome === "appointment_cancelled" ||
    !!summary.appointment;

  if (!appointmentLike) return summary;

  const entities = summary.extracted_entities || {};
  const requestedWindow = [
    entities.preferred_time,
    entities.appointment_date,
    entities.appointment_time,
  ].filter(Boolean).join(" ").trim();
  const taskNotes = requestedWindow
    ? `Call back to confirm the requested window: ${requestedWindow}`
    : summary.next_action || "Call back to confirm availability and next steps";

  return {
    ...summary,
    intent: summary.intent === "appointment_cancel" ? "follow_up" : "lead_capture",
    outcome: "callback_needed",
    appointment: null,
    next_action: taskNotes,
    tasks: (summary.tasks || [])
      .filter((task) => !["confirm_appointment", "reschedule_appointment", "cancel_appointment"].includes(task.task_type))
      .concat({
        task_type: "callback",
        notes: taskNotes,
        due_in_hours: /urgent|emergency|today|asap/i.test(`${summary.summary} ${summary.next_action} ${taskNotes}`) ? 1 : 24,
      }),
  };
};

export const persistCallSummary = async (
  callSid: string,
  contactId: number | null,
  summary: CallSummaryResult
): Promise<void> => {
  const callRows = await sql<{ workspace_id: number | null }[]>`
    SELECT workspace_id FROM calls WHERE call_sid = ${callSid} LIMIT 1
  `;
  const workspaceId = Number(callRows[0]?.workspace_id || 1);
  const alreadyComplete = await sql<{ complete: boolean }[]>`
    SELECT artifacts_completed_at IS NOT NULL AS complete
    FROM call_summaries
    WHERE call_sid = ${callSid} AND workspace_id = ${workspaceId}
    LIMIT 1
  `;
  if (alreadyComplete[0]?.complete === true) return;

  let durableSummary = summary;
  let tasksCreated = 0;

  await runMandatoryPostCallArtifactPipeline({
    persistSummaryRow: async () => {
      // The full model output is the durable artifact plan. If a later write
      // fails, a retry reuses this exact plan instead of asking the model again.
      await sql`
        INSERT INTO call_summaries
          (call_sid, contact_id, intent, summary, outcome, next_action, sentiment,
           confidence, resolution_score, extracted_entities, workspace_id, artifact_plan)
        VALUES (
          ${callSid}, ${contactId}, ${summary.intent}, ${summary.summary},
          ${summary.outcome}, ${summary.next_action}, ${summary.sentiment},
          ${summary.confidence}, ${summary.resolution_score},
          ${sql.json(summary.extracted_entities || {})}, ${workspaceId}, ${sql.json(summary as any)}
        )
        ON CONFLICT (call_sid) DO UPDATE SET
          artifact_plan = COALESCE(call_summaries.artifact_plan, EXCLUDED.artifact_plan)
      `;

      const planRows = await sql<{ artifact_plan: CallSummaryResult | string | null; contact_id: number | null }[]>`
        SELECT artifact_plan, contact_id
        FROM call_summaries
        WHERE call_sid = ${callSid} AND workspace_id = ${workspaceId}
        LIMIT 1
      `;
      if (!planRows[0]?.artifact_plan) throw new Error(`Durable post-call artifact plan is unavailable for ${callSid}`);
      durableSummary = (typeof planRows[0].artifact_plan === "string"
        ? JSON.parse(planRows[0].artifact_plan)
        : planRows[0].artifact_plan) as CallSummaryResult;
      contactId = contactId || planRows[0].contact_id || null;

      await sql`
        UPDATE call_summaries SET
          contact_id = COALESCE(${contactId}, contact_id),
          intent = ${durableSummary.intent},
          summary = ${durableSummary.summary},
          outcome = ${durableSummary.outcome},
          next_action = ${durableSummary.next_action},
          sentiment = ${durableSummary.sentiment},
          confidence = ${durableSummary.confidence},
          resolution_score = ${durableSummary.resolution_score},
          extracted_entities = ${sql.json(durableSummary.extracted_entities || {})},
          workspace_id = ${workspaceId}
        WHERE call_sid = ${callSid} AND workspace_id = ${workspaceId}
      `;
      await sql`
        UPDATE calls SET resolution_score = ${durableSummary.resolution_score}
        WHERE call_sid = ${callSid} AND workspace_id = ${workspaceId}
      `;

      if (!contactId && durableSummary.extracted_entities) {
        const entities = durableSummary.extracted_entities as any;
        const autoName: string | null = entities.caller_name
          || (entities.first_name
            ? `${entities.first_name}${entities.last_name ? ` ${entities.last_name}` : ""}`.trim()
            : null)
          || null;
        if (!autoName) {
          logEvent(callSid, "CONTACT_AUTO_CREATE_SKIPPED", {
            reason: "no_name_extracted",
            note: "Caller did not provide a name — contact not created to avoid junk records.",
          });
        } else {
          const boundCalls = await sql<any[]>`
            SELECT workspace_id, from_number, to_number, direction
            FROM calls WHERE call_sid = ${callSid} AND workspace_id = ${workspaceId} LIMIT 1
          `;
          const callRecord = boundCalls[0];
          if (callRecord) {
            const extractedPhone = (entities.phone_number && String(entities.phone_number).trim()) || null;
            const legPhone = callRecord.direction === "inbound" ? callRecord.from_number : callRecord.to_number;
            const resolvedPhone = extractedPhone || legPhone || null;
            let autoCreated = false;
            if (resolvedPhone) {
              const upserted = await sql<any[]>`
                INSERT INTO contacts
                  (workspace_id, phone_number, name, email, company_name, source, created_at, updated_at)
                VALUES
                  (${workspaceId}, ${resolvedPhone}, ${autoName},
                   ${(entities.email && String(entities.email).trim()) || null},
                   ${(entities.business_name && String(entities.business_name).trim()) || null},
                   'inbound_call', NOW(), NOW())
                ON CONFLICT (workspace_id, phone_number) WHERE phone_number IS NOT NULL
                DO UPDATE SET
                  name = CASE WHEN contacts.name IS NULL OR contacts.name = '' THEN EXCLUDED.name ELSE contacts.name END,
                  email = CASE WHEN contacts.email IS NULL OR contacts.email = '' THEN EXCLUDED.email ELSE contacts.email END,
                  company_name = CASE WHEN contacts.company_name IS NULL OR contacts.company_name = '' THEN EXCLUDED.company_name ELSE contacts.company_name END,
                  updated_at = NOW()
                RETURNING id, (xmax = 0) AS was_inserted
              `;
              contactId = upserted[0]?.id ?? null;
              autoCreated = upserted[0]?.was_inserted === true;
            } else {
              const linked = await sql<any[]>`
                SELECT c.id
                FROM calls source_call
                JOIN contacts c ON c.id = source_call.contact_id AND c.workspace_id = source_call.workspace_id
                WHERE source_call.call_sid = ${callSid} AND source_call.workspace_id = ${workspaceId}
                LIMIT 1
              `;
              if (linked[0]?.id) {
                contactId = linked[0].id;
              } else {
                const inserted = await sql<any[]>`
                  INSERT INTO contacts
                    (workspace_id, name, email, company_name, source, created_at, updated_at)
                  VALUES
                    (${workspaceId}, ${autoName},
                     ${(entities.email && String(entities.email).trim()) || null},
                     ${(entities.business_name && String(entities.business_name).trim()) || null},
                     'inbound_call', NOW(), NOW())
                  RETURNING id
                `;
                contactId = inserted[0]?.id ?? null;
                autoCreated = true;
              }
            }
            if (contactId) {
              await sql`UPDATE calls SET contact_id = ${contactId} WHERE call_sid = ${callSid} AND workspace_id = ${workspaceId}`;
              await sql`UPDATE call_summaries SET contact_id = ${contactId} WHERE call_sid = ${callSid} AND workspace_id = ${workspaceId}`;
              logEvent(callSid, autoCreated ? "CONTACT_AUTO_CREATED_FROM_SUMMARY" : "CONTACT_RECOVERED_FROM_SUMMARY", {
                contactId,
                resolvedPhone,
                autoName,
                source: extractedPhone ? "extracted_phone" : "leg_phone",
              });
            }
          }
        }
      }

      // Enrichment remains advisory. Mandatory appointment/task/lead writes
      // below are deliberately not swallowed.
      if (contactId && durableSummary.extracted_entities) {
        try {
          const entityMap: Record<string, string> = {
            caller_name: "caller_name", first_name: "first_name", last_name: "last_name",
            business_name: "business_name", business_type: "business_type", address: "address",
            city: "city", state: "state", zip: "zip", service_type: "service_type",
            preferred_time: "preferred_time", appointment_date: "appointment_date",
            appointment_time: "appointment_time", phone_number: "alt_phone", email: "email",
            website: "website", urgency: "urgency", budget: "budget",
            referral_source: "referral_source", notes: "call_notes",
          };
          for (const [entityKey, fieldKey] of Object.entries(entityMap)) {
            const value = (durableSummary.extracted_entities as any)[entityKey];
            if (!value || !String(value).trim()) continue;
            const confidence = durableSummary.entity_confidence?.[entityKey] ?? null;
            const snippet = durableSummary.entity_snippets?.[entityKey] ?? null;
            const updated = await sql`
              UPDATE contact_custom_fields
              SET field_value = ${String(value).trim()}, source = 'ai_extracted',
                  confidence = ${confidence}, transcript_snippet = ${snippet}, call_sid = ${callSid},
                  updated_at = NOW(), workspace_id = ${workspaceId}
              WHERE contact_id = ${contactId} AND field_key = ${fieldKey}
            `;
            if (updated.count === 0) {
              await sql`
                INSERT INTO contact_custom_fields
                  (contact_id, field_key, field_value, source, confidence, transcript_snippet, call_sid, updated_at, workspace_id)
                VALUES
                  (${contactId}, ${fieldKey}, ${String(value).trim()}, 'ai_extracted', ${confidence}, ${snippet}, ${callSid}, NOW(), ${workspaceId})
                ON CONFLICT DO NOTHING
              `;
            }
          }
        } catch (error: any) {
          logEvent(callSid, "STEP2_CUSTOM_FIELDS_ERROR", { error: error.message });
        }

        try {
          const entities = durableSummary.extracted_entities as any;
          const name = entities.caller_name
            || (entities.first_name && entities.last_name ? `${entities.first_name} ${entities.last_name}` : entities.first_name || entities.last_name)
            || null;
          const businessName = entities.business_name || null;
          await sql`
            UPDATE contacts SET
              name = CASE WHEN (name IS NULL OR name = '') AND ${!!name} THEN ${name || ''} ELSE name END,
              email = CASE WHEN (email IS NULL OR email = '') AND ${!!entities.email} THEN ${entities.email || ''} ELSE email END,
              address = CASE WHEN (address IS NULL OR address = '') AND ${!!entities.address} THEN ${entities.address || ''} ELSE address END,
              city = CASE WHEN (city IS NULL OR city = '') AND ${!!entities.city} THEN ${entities.city || ''} ELSE city END,
              state = CASE WHEN (state IS NULL OR state = '') AND ${!!entities.state} THEN ${entities.state || ''} ELSE state END,
              zip = CASE WHEN (zip IS NULL OR zip = '') AND ${!!entities.zip} THEN ${entities.zip || ''} ELSE zip END,
              business_name = CASE WHEN (business_name IS NULL OR business_name = '') AND ${!!businessName} THEN ${businessName || ''} ELSE business_name END,
              company_name = CASE WHEN (company_name IS NULL OR company_name = '') AND ${!!businessName} THEN ${businessName || ''} ELSE company_name END,
              updated_at = NOW()
            WHERE id = ${contactId} AND workspace_id = ${workspaceId}
          `;
        } catch (error: any) {
          logEvent(callSid, "STEP3_CONTACT_UPDATE_ERROR", { error: error.message });
        }
        try {
          await updateContactSummary(contactId, durableSummary.summary, durableSummary.outcome);
        } catch (error: any) {
          logEvent(callSid, "STEP4_CONTACT_SUMMARY_ERROR", { error: error.message });
        }
      }
    },

    persistAppointment: async () => {
      if (!durableSummary.appointment || durableSummary.outcome !== "appointment_booked") return;
      const appointment = durableSummary.appointment;
      const scheduledAt = appointment.date && appointment.time
        ? new Date(`${appointment.date} ${appointment.time}`)
        : null;
      if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) {
        throw new Error(`Mandatory appointment artifact is invalid for ${callSid}`);
      }
      await sql`
        INSERT INTO appointments
          (contact_id, call_sid, scheduled_at, service_type, notes, status, workspace_id, post_call_artifact_key)
        SELECT
          ${contactId}, ${callSid}, ${scheduledAt.toISOString()}, ${appointment.service || null},
          ${appointment.notes || null}, 'scheduled', ${workspaceId}, 'booked_appointment'
        WHERE NOT EXISTS (
          SELECT 1 FROM appointments
          WHERE call_sid = ${callSid} AND workspace_id = ${workspaceId}
        )
        ON CONFLICT (call_sid, post_call_artifact_key)
          WHERE call_sid IS NOT NULL AND post_call_artifact_key IS NOT NULL
        DO NOTHING
      `;
    },

    persistTasks: async () => {
      const plannedTasks = [...(durableSummary.tasks || [])];
      const requiresCallbackTask = durableSummary.outcome === "callback_needed";
      if (requiresCallbackTask && !plannedTasks.some((task) => task.task_type === "callback")) {
        plannedTasks.push({
          task_type: "callback",
          notes: durableSummary.next_action || "Call this customer back",
          due_in_hours: 24,
        });
      }
      const nextActionText = String(durableSummary.next_action || "").toLowerCase();
      const hasConcreteFollowUp = /(call|callback|email|send|quote|invoice|contract|confirm|schedule|reschedule|cancel|refund|dispatch|handoff|escalat|payment|deposit|availability|owner|human)/i
        .test(durableSummary.next_action || "");
      const requiresFollowUp = durableSummary.outcome === "escalated"
        || (durableSummary.outcome === "incomplete"
          && hasConcreteFollowUp
          && !/(no follow|none|n\/a|not needed|no action)/i.test(nextActionText));
      if (requiresFollowUp && !plannedTasks.some((task) => ["follow_up", "callback", "handoff", "escalate_to_human"].includes(task.task_type))) {
        plannedTasks.push({
          task_type: durableSummary.outcome === "escalated" ? "handoff" : "follow_up",
          notes: durableSummary.next_action || "Review and follow up on this call",
          due_in_hours: 24,
        });
      }
      const appointmentNeedsConfirmation = durableSummary.outcome === "appointment_booked"
        && /(confirm|requested|tentative|availability|owner|human|call back|callback|email)/i
          .test(`${durableSummary.next_action || ""} ${durableSummary.appointment?.notes || ""}`);
      if (appointmentNeedsConfirmation && !plannedTasks.some((task) => task.task_type === "confirm_appointment")) {
        plannedTasks.push({
          task_type: "confirm_appointment",
          notes: durableSummary.appointment
            ? `Confirm appointment for ${durableSummary.appointment.service} on ${durableSummary.appointment.date} at ${durableSummary.appointment.time}`
            : durableSummary.next_action || "Confirm the booked appointment",
          due_in_hours: 2,
        });
      }

      // Duplicate callback obligations from the model collapse into one stable
      // artifact; other exact duplicate tasks collapse by their content hash.
      type DurableTask = NonNullable<CallSummaryResult["tasks"]>[number] & { artifactKey: string };
      const uniqueTasks: DurableTask[] = [];
      const seenKeys = new Set<string>();
      let callbackSeen = false;
      for (const task of plannedTasks) {
        if (task.task_type === "callback") {
          if (callbackSeen) continue;
          callbackSeen = true;
        }
        const artifactKey = `task_${createHash("sha256")
          .update(JSON.stringify([task.task_type, task.notes || "", task.due_in_hours || 24]))
          .digest("hex")
          .slice(0, 32)}`;
        if (seenKeys.has(artifactKey)) continue;
        seenKeys.add(artifactKey);
        uniqueTasks.push({ ...task, artifactKey });
      }
      tasksCreated = uniqueTasks.length;

      for (const task of uniqueTasks) {
        const dueAt = new Date(Date.now() + (task.due_in_hours || 24) * 3_600_000).toISOString();
        await sql<any[]>`
          INSERT INTO tasks
            (contact_id, call_sid, task_type, status, notes, due_at, workspace_id, post_call_artifact_key)
          SELECT
            ${contactId}, ${callSid}, ${task.task_type}, 'open', ${task.notes || null},
            ${dueAt}, ${workspaceId}, ${task.artifactKey}
          WHERE NOT EXISTS (
            SELECT 1 FROM tasks
            WHERE call_sid = ${callSid}
              AND workspace_id = ${workspaceId}
              AND task_type = ${task.task_type}
              AND COALESCE(notes, '') = ${task.notes || ''}
          )
          ON CONFLICT (call_sid, post_call_artifact_key)
            WHERE call_sid IS NOT NULL AND post_call_artifact_key IS NOT NULL
          DO NOTHING
          RETURNING id
        `;
      }
      if (contactId) {
        await sql`
          UPDATE contacts
          SET open_tasks_count = (
            SELECT COUNT(*)::int FROM tasks
            WHERE contact_id = ${contactId} AND workspace_id = ${workspaceId} AND status = 'open'
          )
          WHERE id = ${contactId} AND workspace_id = ${workspaceId}
        `;
      }
    },

    persistLeadFanout: async () => {
      const entities = durableSummary.extracted_entities as any;
      const leadName = entities?.caller_name
        || (entities?.first_name ? `${entities.first_name}${entities.last_name ? ` ${entities.last_name}` : ""}`.trim() : null);
      const [boundCalls, contacts] = await Promise.all([
        sql<any[]>`
          SELECT from_number, to_number, direction
          FROM calls WHERE call_sid = ${callSid} AND workspace_id = ${workspaceId} LIMIT 1
        `,
        contactId
          ? sql<any[]>`SELECT name, phone_number, email FROM contacts WHERE id = ${contactId} AND workspace_id = ${workspaceId} LIMIT 1`
          : Promise.resolve([] as any[]),
      ]);
      const boundCall = boundCalls[0];
      const contact = contacts[0];
      const resolvedLeadPhone = entities?.phone_number || contact?.phone_number
        || (boundCall?.direction === "inbound" ? boundCall?.from_number : boundCall?.to_number)
        || undefined;
      const resolvedLeadEmail = entities?.email || contact?.email || undefined;
      const resolvedLeadName = leadName || contact?.name || undefined;
      if (!resolvedLeadPhone && !resolvedLeadEmail) {
        logEvent(callSid, "LEAD_UPSERT_SKIPPED", { reason: "no_phone_or_email_after_fallback" });
        return;
      }

      const stageMap: Record<string, FunnelStage> = {
        appointment_booked: "booked",
        appointment_rescheduled: "booked",
        lead_captured: "qualified",
        resolved: "qualified",
        callback_needed: "follow_up_due",
        incomplete: "follow_up_due",
        escalated: "follow_up_due",
      };
      const funnelStage = stageMap[durableSummary.outcome] ?? "captured";
      let appointmentTime: string | undefined;
      if (durableSummary.appointment?.date && durableSummary.appointment?.time) {
        const rawTime = durableSummary.appointment.time.trim();
        const dateParts = durableSummary.appointment.date.trim().split("-");
        const timeMatch = rawTime.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?$/i);
        if (timeMatch) {
          let hours = Number.parseInt(timeMatch[1], 10);
          const minutes = Number.parseInt(timeMatch[2], 10);
          const ampm = (timeMatch[4] || "").toUpperCase();
          if (ampm === "PM" && hours < 12) hours += 12;
          if (ampm === "AM" && hours === 12) hours = 0;
          const currentYear = new Date().getFullYear();
          if (dateParts.length === 3 && Number.parseInt(dateParts[0], 10) < currentYear) dateParts[0] = String(currentYear);
          appointmentTime = `${dateParts.join("-")}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;
        }
      }

      // This await is mandatory: a transient core lead-write failure leaves the
      // durable summary stage failed so its exact artifact plan is resumed.
      const result = await upsertLead({
        name: resolvedLeadName,
        phone: resolvedLeadPhone,
        email: resolvedLeadEmail,
        company: entities?.business_name || undefined,
        serviceType: entities?.service_type || durableSummary.appointment?.service || undefined,
        notes: durableSummary.summary,
        source: "inbound_call",
        callSid,
        funnelStage,
        appointmentTime,
        appointmentTz: "America/Los_Angeles",
      }, workspaceId);
      logEvent(callSid, "LEAD_UPSERT_COMPLETE", {
        leadId: result.leadId,
        action: result.action,
        funnelStage: result.funnelStage,
        hubspot: result.hubspot?.success ? "ok" : (result.hubspot?.error ?? "skipped"),
        calendar: result.calendar?.success ? "ok" : (result.calendar?.error ?? "skipped"),
        notification: result.notification?.email ? "sent" : "skipped",
      });
    },

    markArtifactsComplete: async () => {
      const completed = await sql<any[]>`
        UPDATE call_summaries
        SET artifacts_completed_at = COALESCE(artifacts_completed_at, NOW())
        WHERE call_sid = ${callSid} AND workspace_id = ${workspaceId}
        RETURNING call_sid
      `;
      if (!completed[0]) throw new Error(`Mandatory post-call artifacts could not be completed for ${callSid}`);
      logEvent(callSid, "SUMMARY_GENERATED", {
        intent: durableSummary.intent,
        outcome: durableSummary.outcome,
        resolution_score: durableSummary.resolution_score,
        sentiment: durableSummary.sentiment,
        tasks_created: tasksCreated,
        entities_extracted: Object.keys(durableSummary.extracted_entities || {})
          .filter((key) => (durableSummary.extracted_entities as any)[key]).length,
      });
    },
  });
};

export const runPostCallIntelligence = async (
  callSid: string,
  contactId: number | null,
  geminiApiKey?: string
): Promise<void> => {
  const persistedPlans = await sql<{ artifact_plan: CallSummaryResult | string | null }[]>`
    SELECT artifact_plan FROM call_summaries WHERE call_sid = ${callSid} LIMIT 1
  `;
  const persistedPlan = persistedPlans[0]?.artifact_plan;
  const summary = persistedPlan
    ? (typeof persistedPlan === "string" ? JSON.parse(persistedPlan) : persistedPlan) as CallSummaryResult
    : await generateCallSummary(callSid, geminiApiKey);
  await persistCallSummary(callSid, contactId, summary);

  // ── Post-Call Adversarial Evaluator (out-of-band, agent never sees this) ──
  try {
    const { evaluateCallPostHoc } = await import("./reward-system.js");
    const callRows = await sql<{ workspace_id: number; duration: number | null; direction: string }[]>`
      SELECT workspace_id, duration, direction FROM calls WHERE call_sid = ${callSid} LIMIT 1
    `;
    const wsId = callRows[0]?.workspace_id || 1;
    const duration = callRows[0]?.duration || 0;

    // Check if tools were used during this call
    const toolRows = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int as count FROM tool_executions WHERE call_sid = ${callSid}
    `;
    const toolsUsed = (toolRows[0]?.count || 0) > 0;

    // Determine if duration was appropriate (10s-600s for inbound, 15s-300s for outbound)
    const isInbound = callRows[0]?.direction === 'inbound';
    const durationOk = isInbound
      ? (duration > 10 && duration < 600)
      : (duration > 15 && duration < 300);

    // Check if escalation was appropriate (if used)
    const escalationRows = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int as count FROM tool_executions
      WHERE call_sid = ${callSid} AND tool_name = 'escalate_to_human'
    `;
    const escalated = (escalationRows[0]?.count || 0) > 0;
    const escalationAppropriate = escalated
      ? (summary.sentiment === 'frustrated' || summary.sentiment === 'negative' || summary.outcome === 'escalated')
      : true;

    // Check if key info was captured
    const entities = summary.extracted_entities || {};
    const infoCaptured = !!(entities.caller_name || entities.email || entities.phone_number || entities.service_type);

    await evaluateCallPostHoc({
      callSid,
      workspaceId: wsId,
      resolution_score: summary.resolution_score,
      caller_sentiment: summary.sentiment,
      tools_used_appropriately: toolsUsed || summary.outcome === 'resolved',
      information_captured: infoCaptured,
      call_duration_appropriate: durationOk,
      escalation_appropriate: escalationAppropriate,
      outcome_productive: summary.outcome,
    });
  } catch (err) {
    // Evaluator is non-critical — never block post-call processing
    console.error('[intelligence] Post-call evaluation failed (non-critical):', err);
  }
};
