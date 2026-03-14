/**
 * Post-Call Intelligence Module — Postgres version
 *
 * After every call ends:
 * 1. Generates a structured summary using OpenRouter (primary) or Gemini (fallback)
 * 2. Classifies intent, outcome, and sentiment
 * 3. Assigns a resolution score (0.0–1.0)
 * 4. Extracts entities (name, business, service type, etc.)
 * 5. Persists everything to call_summaries and updates the contact
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
};

const SUMMARY_PROMPT = (transcript: string) => `You are an AI call analyst. Analyze this phone call transcript and return a structured JSON summary.

TRANSCRIPT:
${transcript}

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "intent": "<one of: appointment_booking, appointment_reschedule, appointment_cancel, lead_capture, support_issue, billing_question, emergency, general_inquiry, follow_up, do_not_call_request, unknown>",
  "summary": "<2-3 sentence plain English summary of what happened>",
  "outcome": "<one of: resolved, appointment_booked, appointment_rescheduled, appointment_cancelled, lead_captured, escalated, callback_needed, incomplete, do_not_call, voicemail, spam>",
  "next_action": "<specific next step or 'No action needed'>",
  "sentiment": "<one of: positive, neutral, negative, frustrated>",
  "confidence": <0.0 to 1.0>,
  "resolution_score": <0.0 to 1.0>,
  "extracted_entities": {
    "caller_name": "<name if mentioned, else empty string>",
    "business_name": "<business name if mentioned, else empty string>",
    "business_type": "<type of business, else empty string>",
    "address": "<address if mentioned, else empty string>",
    "service_type": "<type of service requested, else empty string>",
    "preferred_time": "<preferred appointment time if mentioned, else empty string>",
    "phone_number": "<alternate phone if mentioned, else empty string>",
    "email": "<email if mentioned, else empty string>",
    "website": "<website if mentioned, else empty string>",
    "urgency": "<low, normal, high, emergency>"
  }
}`;

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
    } catch { /* fall through */ }
  }

  if (geminiApiKey) {
    try {
      const result = await summarizeViaGemini(prompt, geminiApiKey);
      result.confidence = Math.max(0, Math.min(1, result.confidence || 0.5));
      result.resolution_score = Math.max(0, Math.min(1, result.resolution_score || 0.5));
      return result;
    } catch { /* fall through */ }
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
});

export const persistCallSummary = async (
  callSid: string,
  contactId: number | null,
  summary: CallSummaryResult
): Promise<void> => {
  await sql`
    INSERT INTO call_summaries
      (call_sid, contact_id, intent, summary, outcome, next_action, sentiment, confidence, resolution_score, extracted_entities)
    VALUES (
      ${callSid}, ${contactId}, ${summary.intent}, ${summary.summary},
      ${summary.outcome}, ${summary.next_action}, ${summary.sentiment},
      ${summary.confidence}, ${summary.resolution_score},
      ${sql.json(summary.extracted_entities || {})}
    )
  `;

  await sql`UPDATE calls SET resolution_score = ${summary.resolution_score} WHERE call_sid = ${callSid}`;

  if (contactId) {
    await updateContactSummary(contactId, summary.summary, summary.outcome);
  }

  const needsFollowUp = ["callback_needed", "incomplete", "escalated"].includes(summary.outcome);
  if (needsFollowUp && contactId) {
    await sql`
      INSERT INTO tasks (contact_id, call_sid, task_type, status, notes, due_at)
      VALUES (${contactId}, ${callSid}, 'follow_up', 'open', ${summary.next_action}, NOW() + INTERVAL '1 day')
    `;
    await adjustOpenTasks(contactId, 1);
  }

  logEvent(callSid, "SUMMARY_GENERATED", {
    intent: summary.intent,
    outcome: summary.outcome,
    resolution_score: summary.resolution_score,
    sentiment: summary.sentiment,
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
