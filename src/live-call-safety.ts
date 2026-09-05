export const VOICE_DASHBOARD_MUTATION_TOOLS = new Set([
  "complete_task",
  "complete_open_tasks",
  "update_task",
  "cancel_task",
  "acknowledge_handoff",
  "make_outbound_call",
]);

export const isVoiceDashboardMutation = (toolName: string): boolean => VOICE_DASHBOARD_MUTATION_TOOLS.has(toolName);

export const voiceDashboardMutationRefusal = (): string =>
  "For safety, task changes and third-party outbound calls require the authenticated dashboard. I can capture a callback request, create a new follow-up task, or request a screened human transfer.";

export const hasCallableVoiceNumber = (value: string | null | undefined): boolean => {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 10 && !/^0+$/.test(digits);
};

export const failedTransferRecovery = (callerPhone: string | null | undefined): {
  taskType: "callback" | "handoff";
  spokenText: string;
} => hasCallableVoiceNumber(callerPhone)
  ? {
      taskType: "callback",
      spokenText: "I couldn't connect you just now, but I have your number and have sent a callback request to the owner. You'll hear back as soon as they are available.",
    }
  : {
      taskType: "handoff",
      spokenText: "I couldn't connect you just now. I have alerted the owner. Please leave the best callback number after the tone so they can reach you.",
    };

export const SMIRK_IDENTITY = {
  product: "SMIRK AI",
  ownerAndBuilder: "Cameron Church",
  role: "missed-call recovery assistant for local businesses",
} as const;

export const smirkIdentityInstruction = (): string =>
  `SMIRK is a product of ${SMIRK_IDENTITY.product}, built and operated by ${SMIRK_IDENTITY.ownerAndBuilder}. ` +
  "Never say Google, Gemini, Twilio, OpenAI, or any other vendor created or owns SMIRK.";
