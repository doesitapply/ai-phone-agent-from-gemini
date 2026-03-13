/**
 * Post-Call Intelligence Module
 *
 * After every call ends, this module:
 * 1. Generates a structured summary using OpenRouter (primary) or Gemini (fallback)
 * 2. Classifies intent, outcome, and sentiment
 * 3. Assigns a resolution score (0.0–1.0)
 * 4. Determines the next best action
 * 5. Extracts entities (name, address, service type, etc.)
 * 6. Persists everything to call_summaries and updates the contact
 *
 * AI Priority: OpenRouter → Gemini → safe default (no crash)
 */
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

const SUMMARY_PROMPT = (transcript: string) => `You are an AI call analyst. Analyze this phone call transcript and return a structured JSON summary.

TRANSCRIPT:
${transcript}

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "intent": "<one of: appointment_booking, appointment_reschedule, appointment_cancel, lead_capture, support_issue, billing_question, emergency, general_inquiry, follow_up, do_not_call_request, unknown>",
  "summary": "<2-3 sentence plain English summary of what happened>",
  "outcome": "<one of: resolved, appointment_booked, appointment_rescheduled, appointment_cancelled, lead_captured, escalated, callback_needed, incomplete, do_not_call, voicemail, spam>",
  "next_action": "<specific next step, e.g. 'Call back tomorrow at 9am to confirm technician availability' or 'No action needed'>",
  "sentiment": "<one of: positive, neutral, negative, frustrated>",
  "confidence": <0.0 to 1.0>,
  "resolution_score": <0.0 to 1.0>,
  "extracted_entities": {
    "caller_name": "<name if mentioned, else empty string>",
    "address": "<address if mentioned, else empty string>",
    "service_type": "<type of service requested, else empty string>",
    "preferred_time": "<preferred appointment time if mentioned, else empty string>",
    "phone_number": "<alternate phone if mentioned, else empty string>",
    "email": "<email if mentioned, else empty string>",
    "urgency": "<low, normal, high, emergency>"
  }
}`;

/** Try OpenRouter for post-call analysis */
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
    max_tokens: 1024,
    temperature: 0.1,
  });

  const raw = response.choices[0]?.message?.content?.trim() || "";
  const cleaned = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
  return JSON.parse(cleaned) as CallSummaryResult;
}

/** Try Gemini for post-call analysis (optional fallback) */
async function summarizeViaGemini(prompt: string, apiKey: string): Promise<CallSummaryResult> {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: prompt,
    config: { temperature: 0.1, maxOutputTokens: 1024 },
  });
  const raw = response.text?.trim() || "";
  const cleaned = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
  return JSON.parse(cleaned) as CallSummaryResult;
}

/**
 * Generate a structured post-call summary.
 * Tries OpenRouter first, then Gemini if available, then returns a safe default.
 */
export const generateCallSummary = async (
  callSid: string,
  geminiApiKey?: string
): Promise<CallSummaryResult> => {
  const messages = db
    .prepare("SELECT role, text FROM messages WHERE call_sid = ? ORDER BY id ASC")
    .all(callSid) as { role: string; text: string }[];

  if (messages.length === 0) {
    return buildDefaultSummary("No conversation recorded.");
  }

  const transcript = messages
    .map((m) => `${m.role === "user" ? "Caller" : "Agent"}: ${m.text}`)
    .join("\n");

  const prompt = SUMMARY_PROMPT(transcript);

  // 1. Try OpenRouter (primary)
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const result = await summarizeViaOpenRouter(prompt);
      result.confidence = Math.max(0, Math.min(1, result.confidence || 0.5));
      result.resolution_score = Math.max(0, Math.min(1, result.resolution_score || 0.5));
      return result;
    } catch (err) {
      // fall through to Gemini
    }
  }

  // 2. Try Gemini (optional fallback)
  if (geminiApiKey) {
    try {
      const result = await summarizeViaGemini(prompt, geminiApiKey);
      result.confidence = Math.max(0, Math.min(1, result.confidence || 0.5));
      result.resolution_score = Math.max(0, Math.min(1, result.resolution_score || 0.5));
      return result;
    } catch (err) {
      // fall through to default
    }
  }

  // 3. Safe default — never crash
  return buildDefaultSummary("No AI configured for post-call analysis. Add OPENROUTER_API_KEY to enable.");
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

  db.prepare("UPDATE calls SET resolution_score = ? WHERE call_sid = ?").run(
    summary.resolution_score,
    callSid
  );

  if (contactId) {
    updateContactSummary(contactId, summary.summary, summary.outcome);
  }

  const needsFollowUp = ["callback_needed", "incomplete", "escalated"].includes(summary.outcome);
  if (needsFollowUp && contactId) {
    db.prepare(`
      INSERT INTO tasks (contact_id, call_sid, task_type, status, notes, due_at)
      VALUES (?, ?, 'follow_up', 'open', ?, datetime('now', '+1 day'))
    `).run(contactId, callSid, summary.next_action);
    adjustOpenTasks(contactId, 1);
  }

  logEvent(callSid, "SUMMARY_GENERATED", {
    intent: summary.intent,
    outcome: summary.outcome,
    resolution_score: summary.resolution_score,
    sentiment: summary.sentiment,
  });
};

/**
 * Run the full post-call intelligence pipeline.
 * geminiApiKey is optional — OpenRouter will be used if available.
 */
export const runPostCallIntelligence = async (
  callSid: string,
  contactId: number | null,
  geminiApiKey?: string
): Promise<void> => {
  const summary = await generateCallSummary(callSid, geminiApiKey);
  persistCallSummary(callSid, contactId, summary);
};
