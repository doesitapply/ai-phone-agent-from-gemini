export type HumanTransferCandidate = {
  phone?: string | null;
  name?: string | null;
  source: "tool" | "handoff_record" | "env";
};

export type HumanTransferTarget = {
  phone: string;
  name: string | null;
  source: HumanTransferCandidate["source"];
};

export type ExplicitHumanTransferRequest = {
  reason: string;
  topic?: string;
  matchedPhrase: string;
};

export const normalizePhoneDigits10 = (value: string | null | undefined): string =>
  String(value || "").replace(/\D/g, "").slice(-10);

export const isSamePhoneNumber = (left: string | null | undefined, right: string | null | undefined): boolean => {
  const leftDigits = normalizePhoneDigits10(left);
  const rightDigits = normalizePhoneDigits10(right);
  return leftDigits.length === 10 && rightDigits.length === 10 && leftDigits === rightDigits;
};

export function chooseSafeHumanTransferTarget(
  candidates: HumanTransferCandidate[],
  blockedPhones: Array<string | null | undefined>
): HumanTransferTarget | null {
  for (const candidate of candidates) {
    const phone = String(candidate.phone || "").trim();
    if (normalizePhoneDigits10(phone).length !== 10) continue;
    if (blockedPhones.some((blocked) => isSamePhoneNumber(phone, blocked))) continue;
    return {
      phone,
      name: candidate.name || null,
      source: candidate.source,
    };
  }
  return null;
}

const TRANSFER_NEGATION_RE =
  /\b(?:do not|don't|dont|not|no need to|don't want to|dont want to|do not want to)\s+(?:transfer|connect|patch|put|send|speak|talk)\b/i;

const HUMAN_TOPIC_RE =
  /\b(?:human agent|live agent|real agent|human|person|representative|rep|operator|someone|somebody|team member|staff|manager|owner|supervisor|sales|support|billing|dispatch|dispatcher|technician|tech|receptionist|jesse|cameron)\b/i;

const PRODUCT_AGENT_RE = /\b(?:ai|phone|voice|virtual)\s+agent\b|\bagent\s+(?:platform|service|pricing|demo|plan)\b/i;

const NON_PERSON_TOPIC_WORDS = new Set([
  "app",
  "application",
  "bot",
  "demo",
  "details",
  "info",
  "information",
  "platform",
  "pricing",
  "product",
  "service",
  "services",
  "smirk",
  "software",
  "system",
  "website",
]);

const TRANSFER_PATTERNS: RegExp[] = [
  /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:transfer|connect|patch|put)\s+(?:me\s+)?(?:through\s+)?(?:to|with)\s+(?<topic>[^?.!,]{1,64})/i,
  /\b(?:please\s+)?(?:transfer|connect|patch|put)\s+(?:me\s+)?(?:through\s+)?(?:to|with)\s+(?<topic>[^?.!,]{1,64})/i,
  /\b(?:i|we)\s+(?:want|need|would like|have to|gotta)\s+(?:to\s+)?(?:speak|talk)\s+(?:to|with)\s+(?<topic>[^?.!,]{1,64})/i,
  /\b(?:i|we)\s+(?:want|need|would like|have to|gotta)\s+(?:to\s+)?(?:get|reach)?\s*(?:a|an|the|your)?\s*(?<topic>human agent|live agent|real agent|human|real person|live person|person|representative|rep|operator|manager|owner|sales|support|billing|dispatch|dispatcher|technician|tech|jesse|cameron)\b/i,
  /\b(?:get|give)\s+me\s+(?<topic>human agent|live agent|real agent|a human|a real person|a live person|a person|a representative|a rep|an operator|a manager|the owner|sales|support|billing|dispatch|a technician|jesse|cameron)\b/i,
  /\b(?:let me|lemme)\s+(?:speak|talk)\s+(?:to|with)\s+(?<topic>[^?.!,]{1,64})/i,
  /\b(?:speak|talk)\s+(?:to|with)\s+(?<topic>[^?.!,]{1,64})/i,
  /\b(?<topic>human|representative|operator|manager|owner|sales|support|billing|dispatch|technician|jesse|cameron)\s+please\b/i,
];

const cleanRoutingTopic = (raw: string): string => {
  const topic = raw
    .toLowerCase()
    .replace(/\b(?:a|an|the|your|our|real|live|actual|please|right now|if possible)\b/g, " ")
    .replace(/\b(?:who|that|because|about|for)\b.*$/g, " ")
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const knownMatch = topic.match(HUMAN_TOPIC_RE);
  return (knownMatch?.[0] || topic).trim();
};

const isHumanTransferTopic = (rawTopic: string): boolean => {
  const topic = cleanRoutingTopic(rawTopic);
  if (!topic) return false;
  if (PRODUCT_AGENT_RE.test(rawTopic) && !HUMAN_TOPIC_RE.test(rawTopic)) return false;
  if (HUMAN_TOPIC_RE.test(topic)) return true;

  const words = topic.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 3) return false;
  if (words.some((word) => NON_PERSON_TOPIC_WORDS.has(word))) return false;
  if (topic.startsWith("your ") || topic.startsWith("the ")) return false;

  // In a transfer/connect phrase, a short unknown topic is usually a person's name.
  return words.every((word) => /^[a-z][a-z'-]{2,}$/.test(word));
};

export function detectExplicitHumanTransferRequest(speechText: string | null | undefined): ExplicitHumanTransferRequest | null {
  const speech = String(speechText || "").trim();
  if (!speech) return null;
  if (TRANSFER_NEGATION_RE.test(speech)) return null;

  for (const pattern of TRANSFER_PATTERNS) {
    const match = speech.match(pattern);
    const topicRaw = match?.groups?.topic?.trim();
    if (!match || !topicRaw || !isHumanTransferTopic(topicRaw)) continue;

    const topic = cleanRoutingTopic(topicRaw);
    return {
      reason: `Caller explicitly requested a human transfer: "${speech.slice(0, 180)}"`,
      topic: topic || undefined,
      matchedPhrase: match[0],
    };
  }

  return null;
}
