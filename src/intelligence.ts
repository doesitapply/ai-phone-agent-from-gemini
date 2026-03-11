/**
 * Post-Call Intelligence Module
 *
 * After every call ends, this module:
 * 1. Generates a structured summary using Gemini
 * 2. Classifies intent, outcome, and sentiment
 * 3. Assigns a resolution score (0.0–1.0)
 * 4. Determines the next best action
 * 5. Extracts entities (name, address, service type, etc.)
 * 6. Persists everything to call_summaries and updates the contact
 */
import { GoogleGenAI } from "@google/genai";
import { db } from "./db.js";
import { updateContactSummary, adjustOpenTasks } from "./contacts.js";
import { logEvent } from "./events.js";

// ── Intent categories ─────────────────────────────────────────────────────────
export const INTENTS = [
  "appointment_booking",
  "appointment_reschedule",
  "appointment_cancel",
  "lead_capture",
  "support_issue",
  "billing_question",
  "emergency",
  "general_inquiry",
  "follow_up",
  "do_not_call_request",
  "unknown",
] as const;
export type Intent = (typeof INTENTS)[number];

// ── Outcome categories ────────────────────────────────────────────────────────
export const OUTCOMES = [
  "resolved",
  "appointment_booked",
  "appointment_rescheduled",
  "appointment_cancelled",
  "lead_captured",
  "escalated",
  "callback_needed",
  "incomplete",
  "do_not_call",
  "voicemail",
  "spam",
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
};

/**
 * Generate a structured post-call summary using Gemini.
 * Returns a safe default if the AI call fails.
 */
export const generateCallSummary = async (
  callSid: string,
  apiKey: string
): Promise<CallSummaryResult> => {
  // Load the full transcript
  const messages = db
    .prepare(
      "SELECT role, text FROM messages WHERE call_sid = ? ORDER BY id ASC"
    )
    .all(callSid) as { role: string; text: string }[];

  if (messages.length === 0) {
    return buildDefaultSummary("No conversation recorded.");
  }

  const transcript = messages
    .map((m) => `${m.role === "user" ? "Caller" : "Agent"}: ${m.text}`)
    .join("\n");

  const prompt = `You are an AI call analyst. Analyze this phone call transcript and return a structured JSON summary.

TRANSCRIPT:
${transcript}

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "intent": "<one of: appointment_booking, appointment_reschedule, appointment_cancel, lead_capture, support_issue, billing_question, emergency, general_inquiry, follow_up, do_not_call_request, unknown>",
  "summary": "<2-3 sentence plain English summary of what happened>",
  "outcome": "<one of: resolved, appointment_booked, appointment_rescheduled, appointment_cancelled, lead_captured, escalated, callback_needed, incomplete, do_not_call, voicemail, spam>",
  "next_action": "<specific next step, e.g. 'Call back tomorrow at 9am to confirm technician availability' or 'No action needed'>",
  "sentiment": "<one of: positive, neutral, negative, frustrated>",
  "confidence": <0.0 to 1.0 — how confident you are in this classification>,
  "resolution_score": <0.0 to 1.0 — 1.0 means fully resolved, 0.0 means completely unresolved>,
  "extracted_entities": {
    "caller_name": "<name if mentioned, else empty string>",
    "address": "<address if mentioned, else empty string>",
    "service_type": "<type of service requested, else empty string>",
    "preferred_time": "<preferred appointment time if mentioned, else empty string>",
    "phone_number": "<alternate phone if mentioned, else empty string>",
    "email": "<email if mentioned, else empty string>",
    "urgency": "<low, normal, high, emergency — based on caller tone and content>"
  }
}`;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
      config: {
        temperature: 0.1, // Low temperature for structured output
        maxOutputTokens: 1024,
      },
    });

    const raw = response.text?.trim() || "";
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(cleaned) as CallSummaryResult;

    // Validate and clamp numeric fields
    parsed.confidence = Math.max(0, Math.min(1, parsed.confidence || 0.5));
    parsed.resolution_score = Math.max(0, Math.min(1, parsed.resolution_score || 0.5));

    return parsed;
  } catch (err) {
    // Non-fatal: return a safe default rather than crashing
    return buildDefaultSummary(
      `Summary generation failed: ${err instanceof Error ? err.message : "unknown error"}`
    );
  }
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
});

/**
 * Persist the summary to the database and update the contact record.
 * Also creates a follow-up task if the outcome requires one.
 */
export const persistCallSummary = (
  callSid: string,
  contactId: number | null,
  summary: CallSummaryResult
): void => {
  const entitiesJson = JSON.stringify(summary.extracted_entities || {});

  db.prepare(`
    INSERT INTO call_summaries
      (call_sid, contact_id, intent, summary, outcome, next_action, sentiment, confidence, resolution_score, extracted_entities)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    callSid,
    contactId,
    summary.intent,
    summary.summary,
    summary.outcome,
    summary.next_action,
    summary.sentiment,
    summary.confidence,
    summary.resolution_score,
    entitiesJson
  );

  // Update resolution score on the call record
  db.prepare("UPDATE calls SET resolution_score = ? WHERE call_sid = ?").run(
    summary.resolution_score,
    callSid
  );

  // Update the contact's last summary and outcome
  if (contactId) {
    updateContactSummary(contactId, summary.summary, summary.outcome);
  }

  // Auto-create a follow-up task for unresolved outcomes
  const needsFollowUp = [
    "callback_needed",
    "incomplete",
    "escalated",
  ].includes(summary.outcome);

  if (needsFollowUp && contactId) {
    db.prepare(`
      INSERT INTO tasks (contact_id, call_sid, task_type, status, notes, due_at)
      VALUES (?, ?, 'follow_up', 'open', ?, datetime('now', '+1 day'))
    `).run(contactId, callSid, summary.next_action);

    adjustOpenTasks(contactId, 1);
  }

  // Log the intelligence event
  logEvent(callSid, "SUMMARY_GENERATED", {
    intent: summary.intent,
    outcome: summary.outcome,
    resolution_score: summary.resolution_score,
    sentiment: summary.sentiment,
  });
};

/**
 * Run the full post-call intelligence pipeline.
 * Called after a call is marked completed.
 */
export const runPostCallIntelligence = async (
  callSid: string,
  contactId: number | null,
  apiKey: string
): Promise<void> => {
  const summary = await generateCallSummary(callSid, apiKey);
  persistCallSummary(callSid, contactId, summary);
};
