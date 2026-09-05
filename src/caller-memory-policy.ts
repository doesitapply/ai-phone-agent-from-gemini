export type CallerMemoryPromotionReason =
  | "service_request"
  | "estimate_request"
  | "callback_commitment"
  | "appointment_request"
  | "active_customer_issue"
  | "human_handoff"
  | "buyer_onboarding"
  | "compliance_request"
  | "owner_saved";

const TOOL_PROMOTION_REASONS: Record<string, CallerMemoryPromotionReason> = {
  create_lead: "service_request",
  create_client_onboarding_intake: "buyer_onboarding",
  book_appointment: "appointment_request",
  schedule_callback_confirmation: "callback_commitment",
  set_callback: "callback_commitment",
  escalate_to_human: "human_handoff",
  create_support_ticket: "active_customer_issue",
  mark_do_not_call: "compliance_request",
  collect_payment_info: "active_customer_issue",
};

export const getToolMemoryPromotionReason = (
  toolName: string,
  args: Record<string, unknown> = {},
): CallerMemoryPromotionReason | null => {
  if (toolName === "qualify_lead") {
    return args.qualified === true ? "service_request" : null;
  }
  return TOOL_PROMOTION_REASONS[toolName] || null;
};

export const hasReusableCallerPhone = (value: string | null | undefined): boolean => {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 10 && !/^0+$/.test(digits);
};

export type CallerMemorySummarySignal = {
  intent?: string | null;
  outcome?: string | null;
  extracted_entities?: Record<string, string> | null;
  tasks?: Array<{ task_type?: string | null }> | null;
};

export const getSummaryMemoryPromotionReason = (
  summary: CallerMemorySummarySignal,
): CallerMemoryPromotionReason | null => {
  const intent = String(summary.intent || "").toLowerCase();
  const outcome = String(summary.outcome || "").toLowerCase();
  const serviceType = String(summary.extracted_entities?.service_type || "").trim();
  const taskTypes = new Set((summary.tasks || []).map((task) => String(task.task_type || "").toLowerCase()));

  if (intent === "do_not_call_request" || outcome === "do_not_call") return "compliance_request";
  if (outcome === "escalated" || taskTypes.has("escalate_to_human") || taskTypes.has("handoff")) return "human_handoff";
  if (outcome === "callback_needed" || taskTypes.has("callback") || taskTypes.has("confirm_appointment")) return "callback_commitment";
  if (taskTypes.has("check_availability") || intent.startsWith("appointment_")) return "appointment_request";
  if (intent === "support_issue" || intent === "billing_question") return "active_customer_issue";
  if ((intent === "lead_capture" || outcome === "lead_captured" || taskTypes.has("send_quote")) && serviceType) {
    return taskTypes.has("send_quote") ? "estimate_request" : "service_request";
  }
  return null;
};

export const shouldBlockToolWithoutDurableContact = (toolName: string): boolean =>
  toolName === "update_contact" || toolName === "add_note" || toolName === "qualify_lead";

export type QualificationTrade =
  | "plumbing"
  | "hvac"
  | "electrical"
  | "roofing"
  | "auto_repair"
  | "landscaping"
  | "general";

export const normalizeQualificationTrade = (value: string | null | undefined): QualificationTrade => {
  const normalized = String(value || "").toLowerCase();
  if (/plumb|drain|sewer|water heater/.test(normalized)) return "plumbing";
  if (/hvac|heating|cooling|air condition|furnace/.test(normalized)) return "hvac";
  if (/electric|panel|circuit|power/.test(normalized)) return "electrical";
  if (/roof|gutter/.test(normalized)) return "roofing";
  if (/auto|mechanic|vehicle|car repair/.test(normalized)) return "auto_repair";
  if (/landscap|lawn|yard|tree service/.test(normalized)) return "landscaping";
  return "general";
};

const TRADE_QUESTIONS: Record<QualificationTrade, string[]> = {
  plumbing: [
    "which fixture or plumbing system is involved",
    "whether water is actively leaking now",
    "the property location and any access constraints",
  ],
  hvac: [
    "whether the problem is heating or cooling",
    "the system type if the caller knows it",
    "whether service is completely out or only degraded",
  ],
  electrical: [
    "which device, circuit, or panel is involved",
    "whether power is fully out or intermittent",
    "whether there is visible smoke, sparking, or a burning smell",
  ],
  roofing: [
    "whether this is an active leak, inspection, or estimate request",
    "whether water is currently entering the property",
    "the affected roof area if the caller knows it",
  ],
  auto_repair: [
    "the vehicle year, make, and model if known",
    "whether the vehicle is drivable",
    "the warning indicator or requested service",
  ],
  landscaping: [
    "the requested service and property type",
    "the approximate area if known",
    "whether the caller wants one-time or recurring service",
  ],
  general: [
    "the service or result the caller needs",
    "the location where help is needed",
    "the timing and access details the owner needs to know",
  ],
};

export const buildQualificationInstruction = (businessType: string | null | undefined): string => {
  const trade = normalizeQualificationTrade(businessType);
  const tradeQuestions = TRADE_QUESTIONS[trade].map((question) => `- Ask ${question} when relevant.`).join("\n");

  return `=== CONTROLLED QUALIFICATION ===
First establish a legitimate business purpose. Then ask one question at a time and stop when there is enough context for the next human action.
Capture: requested service/result, location when relevant, urgency, preferred timing, useful access/context, then the caller's name and callback method.
For this business type:
${tradeQuestions}
Do not diagnose the work, promise dispatch or availability, interpret a warranty, or quote a price unless the active approved business knowledge explicitly authorizes it.
If there is immediate danger, direct the caller to emergency services and capture only the minimum callback information needed for owner follow-up.
If the inquiry is answered with no legitimate follow-up need, do not manufacture a lead, contact memory, callback, or task.`;
};
