/**
 * Call Classifier — Professional vs Personal vs Spam
 * 
 * Classifies inbound calls based on:
 * 1. Caller identity (known contact with tags/history)
 * 2. First utterance content analysis
 * 3. Time of day / day of week patterns
 * 4. Caller phone number patterns (toll-free = likely business, etc.)
 * 
 * Classification drives routing:
 * - PERSONAL → warm transfer to Cameron if available, else take message
 * - PROFESSIONAL → full SMIRK agent handling (qualify, book, route)
 * - VIP → immediate forward attempt to Cameron
 * - SPAM → polite hangup
 * - UNKNOWN → default to professional handling, classify after first exchange
 */

import { sql } from "./db.js";
import { logEvent } from "./events.js";

export type CallClass = "personal" | "professional" | "vip" | "spam" | "unknown";

export interface ClassificationResult {
  classification: CallClass;
  confidence: number;       // 0.0 - 1.0
  reason: string;
  should_forward: boolean;  // true = attempt live transfer to Cameron
  forward_urgency: "immediate" | "after_screening" | "never";
  routing_hint: string;     // instruction for the agent
}

// Known spam patterns
const SPAM_INDICATORS = [
  "your car warranty",
  "you've been selected",
  "press 1",
  "this is not a sales call",
  "lower your interest rate",
  "duct cleaning",
  "solar panel",
  "student loan forgiveness",
  "free vacation",
  "medicare",
  "health insurance marketplace",
];

// Personal call indicators (first utterance)
const PERSONAL_INDICATORS = [
  "hey cam",
  "is cameron there",
  "is cam there",
  "tell cameron",
  "tell cam",
  "it's me",
  "calling for cameron",
  "calling for cam",
  "this is his",
  "his friend",
  "his brother",
  "his mom",
  "his dad",
  "family",
  "personal matter",
  "not a business call",
];

// Professional call indicators
const PROFESSIONAL_INDICATORS = [
  "ai phone",
  "smirk",
  "phone agent",
  "demo",
  "pricing",
  "interested in",
  "your service",
  "how much",
  "appointment",
  "schedule",
  "business",
  "company",
  "partnership",
  "integrate",
  "api",
  "calling about your product",
  "saw your website",
  "referred by",
];

/**
 * Classify a call based on available signals at call start.
 * Called BEFORE the first AI response to determine routing posture.
 */
export async function classifyCallAtStart(
  callSid: string,
  callerPhone: string,
  contact: { id: number; name: string | null; tags: string[] | null; business_name: string | null; notes: string | null } | null,
  isNew: boolean,
  workspaceId: number = 1
): Promise<ClassificationResult> {
  // ── Signal 1: Known VIP contacts (tagged)
  if (contact?.tags?.includes("vip") || contact?.tags?.includes("personal") || contact?.tags?.includes("friend") || contact?.tags?.includes("family")) {
    const result: ClassificationResult = {
      classification: "vip",
      confidence: 0.95,
      reason: `Known VIP/personal contact: ${contact.name || callerPhone}`,
      should_forward: true,
      forward_urgency: "immediate",
      routing_hint: "This is a VIP or personal contact. Greet warmly by name, ask if they'd like to be connected to Cameron directly. If Cameron is unavailable, take a detailed message.",
    };
    logEvent(callSid, "CALL_CLASSIFIED", { classification: "vip", reason: result.reason });
    return result;
  }

  // ── Signal 2: Owner's own phone calling in (Cameron calling his own line)
  const ownerPhone = process.env.OWNER_PHONE || process.env.HUMAN_TRANSFER_NUMBER || "";
  if (ownerPhone && callerPhone.replace(/\D/g, "").endsWith(ownerPhone.replace(/\D/g, "").slice(-10))) {
    const result: ClassificationResult = {
      classification: "vip",
      confidence: 1.0,
      reason: "Owner calling own line",
      should_forward: false,
      forward_urgency: "never",
      routing_hint: "This is Cameron calling his own line. Ask what he needs — voicemail check, call someone, update settings, etc.",
    };
    logEvent(callSid, "CALL_CLASSIFIED", { classification: "vip", reason: result.reason });
    return result;
  }

  // ── Signal 3: Known contact with business context = professional
  if (!isNew && contact?.business_name) {
    const result: ClassificationResult = {
      classification: "professional",
      confidence: 0.8,
      reason: `Returning caller with business context: ${contact.business_name}`,
      should_forward: false,
      forward_urgency: "after_screening",
      routing_hint: "Returning professional contact. Handle their request directly. Escalate to Cameron only if they explicitly ask or the matter requires his direct involvement.",
    };
    logEvent(callSid, "CALL_CLASSIFIED", { classification: "professional", reason: result.reason });
    return result;
  }

  // ── Signal 4: Toll-free numbers are almost always robocalls or B2B
  const digits = callerPhone.replace(/\D/g, "");
  if (digits.startsWith("1800") || digits.startsWith("1888") || digits.startsWith("1877") || digits.startsWith("1866") || digits.startsWith("1855")) {
    const result: ClassificationResult = {
      classification: "spam",
      confidence: 0.7,
      reason: "Toll-free number — likely automated/spam",
      should_forward: false,
      forward_urgency: "never",
      routing_hint: "Likely spam or automated call from toll-free number. Be brief. If they can't identify themselves or state a clear purpose within 2 exchanges, end the call politely.",
    };
    logEvent(callSid, "CALL_CLASSIFIED", { classification: "spam", reason: result.reason });
    return result;
  }

  // ── Signal 5: New caller — classify as unknown, will refine after first utterance
  const result: ClassificationResult = {
    classification: "unknown",
    confidence: 0.5,
    reason: isNew ? "New caller, no history" : "Returning caller without clear classification",
    should_forward: false,
    forward_urgency: "after_screening",
    routing_hint: "Unknown caller type. Screen professionally. Determine if this is personal (for Cameron directly) or professional (about SMIRK AI services). Route accordingly after the first exchange.",
  };
  logEvent(callSid, "CALL_CLASSIFIED", { classification: "unknown", reason: result.reason });
  return result;
}

/**
 * Refine classification based on the caller's first utterance.
 * Called after the first speech input is received.
 */
export function classifyFromUtterance(utterance: string): { classification: CallClass; confidence: number; reason: string } {
  const lower = utterance.toLowerCase();

  // Check spam
  for (const indicator of SPAM_INDICATORS) {
    if (lower.includes(indicator)) {
      return { classification: "spam", confidence: 0.9, reason: `Spam indicator detected: "${indicator}"` };
    }
  }

  // Check personal
  for (const indicator of PERSONAL_INDICATORS) {
    if (lower.includes(indicator)) {
      return { classification: "personal", confidence: 0.85, reason: `Personal call indicator: "${indicator}"` };
    }
  }

  // Check professional
  for (const indicator of PROFESSIONAL_INDICATORS) {
    if (lower.includes(indicator)) {
      return { classification: "professional", confidence: 0.8, reason: `Professional indicator: "${indicator}"` };
    }
  }

  return { classification: "unknown", confidence: 0.4, reason: "No clear indicators in first utterance" };
}

/**
 * Store classification result on the call record for post-call analytics.
 */
export async function storeClassification(callSid: string, classification: CallClass, confidence: number): Promise<void> {
  await sql`
    UPDATE calls SET 
      call_class = ${classification},
      call_class_confidence = ${confidence}
    WHERE call_sid = ${callSid}
  `.catch(() => {/* column may not exist yet — non-critical */});
}
