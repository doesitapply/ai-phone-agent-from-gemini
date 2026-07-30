export type ChatAccessMode = "operator" | "workspace" | "demo_operator";
export type ChatRequestMessage = {
  role: "user" | "assistant";
  content: string;
};

export const CHAT_REQUEST_MAX_MESSAGES = 20;
export const CHAT_REQUEST_MAX_MESSAGE_CHARS = 2_000;
export const CHAT_REQUEST_MAX_TOTAL_CHARS = 12_000;

export type ChatRequestValidation =
  | { ok: true; messages: ChatRequestMessage[] }
  | {
      ok: false;
      code: "INVALID_CHAT_MESSAGES";
      error: string;
    };

export function validateChatRequestMessages(
  value: unknown
): ChatRequestValidation {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > CHAT_REQUEST_MAX_MESSAGES
  ) {
    return {
      ok: false,
      code: "INVALID_CHAT_MESSAGES",
      error: `Provide 1-${CHAT_REQUEST_MAX_MESSAGES} chat messages.`,
    };
  }

  const messages: ChatRequestMessage[] = [];
  let totalChars = 0;
  for (const item of value) {
    if (!item || typeof item !== "object") {
      return {
        ok: false,
        code: "INVALID_CHAT_MESSAGES",
        error: "Every chat message must be an object.",
      };
    }
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (
      (role !== "user" && role !== "assistant") ||
      typeof content !== "string"
    ) {
      return {
        ok: false,
        code: "INVALID_CHAT_MESSAGES",
        error: "Chat messages require a user or assistant role and text content.",
      };
    }
    const normalizedContent = content.trim();
    if (
      normalizedContent.length === 0 ||
      normalizedContent.length > CHAT_REQUEST_MAX_MESSAGE_CHARS
    ) {
      return {
        ok: false,
        code: "INVALID_CHAT_MESSAGES",
        error: `Each chat message must contain 1-${CHAT_REQUEST_MAX_MESSAGE_CHARS} characters.`,
      };
    }
    totalChars += normalizedContent.length;
    if (totalChars > CHAT_REQUEST_MAX_TOTAL_CHARS) {
      return {
        ok: false,
        code: "INVALID_CHAT_MESSAGES",
        error: `Chat history may contain at most ${CHAT_REQUEST_MAX_TOTAL_CHARS} characters.`,
      };
    }
    messages.push({ role, content: normalizedContent });
  }

  if (messages.at(-1)?.role !== "user") {
    return {
      ok: false,
      code: "INVALID_CHAT_MESSAGES",
      error: "The final chat message must be from the user.",
    };
  }

  return { ok: true, messages };
}

const DEMO_OPERATOR_ALLOWED_TOOLS = new Set([
  "get_team",
  "get_contact",
  "list_tasks",
  "list_calls",
  "search_contacts",
]);

const WORKSPACE_ALLOWED_TOOLS = new Set([
  ...DEMO_OPERATOR_ALLOWED_TOOLS,
  "complete_task",
  "update_task",
  "cancel_task",
  "create_contact",
  "update_contact",
  "create_task",
]);

const OPERATOR_ALLOWED_TOOLS = new Set([
  ...WORKSPACE_ALLOWED_TOOLS,
  "get_settings",
  "get_agent_prompt",
]);

export const CHAT_GUARDED_WORKFLOW_TOOLS = Object.freeze([
  "make_call",
  "book_appointment",
  "update_setting",
  "update_agent_prompt",
  "inject_briefing",
] as const);

export function isChatToolAllowed(
  accessMode: ChatAccessMode,
  toolName: string
): boolean {
  if (accessMode === "operator") return OPERATOR_ALLOWED_TOOLS.has(toolName);
  if (accessMode === "workspace") return WORKSPACE_ALLOWED_TOOLS.has(toolName);
  return DEMO_OPERATOR_ALLOWED_TOOLS.has(toolName);
}

export function chatToolDeclarationsForAccessMode<
  T extends { name: string },
>(declarations: readonly T[], accessMode: ChatAccessMode): T[] {
  return declarations.filter((tool) =>
    isChatToolAllowed(accessMode, tool.name)
  );
}

export function chatToolPolicyText(accessMode: ChatAccessMode): string {
  const guarded =
    "Outbound calls, messages, calendar writes, settings changes, prompt edits, and live briefing injection must use their dedicated guarded dashboard workflows. Never claim one of those actions was completed from chat.";

  if (accessMode === "operator") {
    return `You may inspect calls, contacts, tasks, team state, settings, and the active agent. You may create or update local CRM contacts and tasks. ${guarded}`;
  }
  if (accessMode === "workspace") {
    return `You may inspect calls, contacts, tasks, and team state, and may create or update local CRM contacts and tasks inside the authenticated workspace. ${guarded}`;
  }
  return `You are in read-only demo mode. You may inspect calls, contacts, tasks, and team context only. Do not create, update, delete, send, dial, book, or change live configuration. ${guarded}`;
}
