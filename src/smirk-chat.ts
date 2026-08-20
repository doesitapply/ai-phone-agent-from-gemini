/**
 * SMIRK Chat Agent
 * Persistent dashboard assistant for calls, leads, tasks, and contacts.
 * OpenRouter is preferred when configured, with Gemini as the bounded fallback.
 * Provider-spend and live-configuration actions stay in guarded workflows.
 */

import { sql } from "./db.js";
import { readEnvFile } from "./settings.js";
import { buildWorkspaceKnowledgeContext } from "./workspace-knowledge.js";
import { GoogleGenAI, FunctionCallingConfigMode, Type } from "@google/genai";
import { loadOpenRouterConfig } from "./openrouter.js";
import {
  buildWorkspaceOpenRouterConfig,
  resolveWorkspaceAiKeys,
} from "./workspace-ai-keys.js";
import {
  chatToolDeclarationsForAccessMode,
  chatToolPolicyText,
  isChatToolAllowed,
  type ChatAccessMode,
} from "./smirk-chat-policy.js";
import {
  runSmirkChatProviderChain,
  type SmirkChatProviderName,
} from "./smirk-chat-provider.js";

// ── Context loader ────────────────────────────────────────────────────────────
export async function loadChatContext(workspaceId: number): Promise<string> {
  try {
    const [callRows, leadRows, taskRows, countRows, teamRows, agentRows, knowledgeContext] = await Promise.all([
      sql`SELECT c.call_sid, c.direction, c.from_number, c.to_number, c.status, c.duration_seconds,
                 c.started_at, cs.intent, cs.outcome, cs.summary AS call_summary,
                 cs.sentiment, cs.resolution_score
          FROM calls c
          LEFT JOIN call_summaries cs ON cs.call_sid = c.call_sid
          WHERE c.workspace_id = ${workspaceId}
          ORDER BY c.started_at DESC LIMIT 10`,
      sql`SELECT id, name, phone, funnel_stage, service_type, appointment_time,
                 integration_status, last_error, booked_at, qualified_at, created_at
          FROM leads WHERE workspace_id = ${workspaceId}
          ORDER BY updated_at DESC LIMIT 20`,
      sql`SELECT id, task_type, status, notes, due_at, created_at
          FROM tasks WHERE workspace_id = ${workspaceId} AND status != 'completed'
          ORDER BY due_at ASC LIMIT 10`,
      sql`SELECT funnel_stage, COUNT(*) as count
          FROM leads WHERE workspace_id = ${workspaceId}
          GROUP BY funnel_stage`,
      sql`SELECT id, name, role, department, phone, email,
                 is_on_call AS on_call, is_active AS active, handles_topics
          FROM team_members WHERE workspace_id = ${workspaceId} AND is_active = true
          ORDER BY priority DESC`,
      sql`SELECT id, name, display_name, greeting, voice, is_active, max_turns
          FROM agent_configs WHERE workspace_id = ${workspaceId}
          ORDER BY is_active DESC LIMIT 5`,
      buildWorkspaceKnowledgeContext(workspaceId),
    ]);

    return `
${knowledgeContext}

=== LEAD FUNNEL SUMMARY ===
${JSON.stringify(countRows, null, 2)}

=== RECENT LEADS (last 20) ===
${JSON.stringify(leadRows, null, 2)}

=== RECENT CALLS (last 10) ===
${JSON.stringify(callRows, null, 2)}

=== OPEN TASKS ===
${JSON.stringify(taskRows, null, 2)}

=== TEAM ROSTER ===
${JSON.stringify(teamRows, null, 2)}

=== ACTIVE AGENTS ===
${JSON.stringify(agentRows, null, 2)}

`.trim();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn("[smirk-chat] context load failed", { workspaceId, error: message });
    return "[Context temporarily unavailable.]";
  }
}

// ── Tool declarations for Gemini ──────────────────────────────────────────────
const TOOL_DECLARATIONS = [
  {
    name: "get_settings",
    description:
      "Read configuration status and a small allowlist of non-sensitive operational values. Secret values are never returned.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_agent_prompt",
    description: "Get current system prompt and greeting for the active missed-call recovery assistant.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        agent_id: { type: Type.NUMBER, description: "Optional agent ID" },
      },
    },
  },
  {
    name: "get_team",
    description: "Get the full team roster.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_contact",
    description: "Look up a contact by name or phone number.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        phone: { type: Type.STRING },
      },
    },
  },
  {
    name: "list_tasks",
    description: "List open or filtered tasks. Use to check what work is pending.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: { type: Type.STRING, description: "Filter by status: open, in_progress, completed, cancelled. Omit for all open." },
        contact_phone: { type: Type.STRING, description: "Filter by caller phone number" },
        limit: { type: Type.NUMBER, description: "Max results, default 20" },
      },
    },
  },
  {
    name: "complete_task",
    description: "Mark a task as completed. Use after an issue is resolved.",
    parameters: {
      type: Type.OBJECT,
      required: ["task_id"],
      properties: {
        task_id: { type: Type.NUMBER },
        resolution_notes: { type: Type.STRING },
      },
    },
  },
  {
    name: "update_task",
    description: "Update a task's status, notes, assignee, or due date.",
    parameters: {
      type: Type.OBJECT,
      required: ["task_id"],
      properties: {
        task_id: { type: Type.NUMBER },
        status: { type: Type.STRING },
        notes: { type: Type.STRING },
        assigned_to: { type: Type.STRING },
        due_at: { type: Type.STRING },
      },
    },
  },
  {
    name: "cancel_task",
    description: "Cancel a task with a reason.",
    parameters: {
      type: Type.OBJECT,
      required: ["task_id"],
      properties: {
        task_id: { type: Type.NUMBER },
        reason: { type: Type.STRING },
      },
    },
  },
  {
    name: "create_contact",
    description: "Add a new contact to the system.",
    parameters: {
      type: Type.OBJECT,
      required: ["phone_number"],
      properties: {
        phone_number: { type: Type.STRING },
        name: { type: Type.STRING },
        email: { type: Type.STRING },
        business_name: { type: Type.STRING },
        notes: { type: Type.STRING },
      },
    },
  },
  {
    name: "update_contact",
    description: "Update an existing contact's details.",
    parameters: {
      type: Type.OBJECT,
      required: ["contact_id"],
      properties: {
        contact_id: { type: Type.NUMBER },
        name: { type: Type.STRING },
        email: { type: Type.STRING },
        business_name: { type: Type.STRING },
        notes: { type: Type.STRING },
        do_not_call: { type: Type.BOOLEAN },
      },
    },
  },
  {
    name: "list_calls",
    description: "List recent calls with optional filters.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: { type: Type.NUMBER },
        status: { type: Type.STRING },
        direction: { type: Type.STRING },
      },
    },
  },
  {
    name: "create_task",
    description: "Create a new task only for concrete follow-up work somebody must do. Use when the user says 'create a task', 'add a task', 'remind me to', or when there is a real callback, confirmation, quote, payment, onboarding, or escalation obligation. Do not create tasks for FYI notes, generic review, or information already captured in a summary.",
    parameters: {
      type: Type.OBJECT,
      required: ["title", "task_type"],
      properties: {
        title: { type: Type.STRING, description: "Short task title" },
        task_type: { type: Type.STRING, description: "Type: follow_up, callback, booking, general, etc." },
        notes: { type: Type.STRING, description: "Additional context or instructions" },
        assigned_to: { type: Type.STRING, description: "Team member name or email to assign to" },
        due_at: { type: Type.STRING, description: "ISO 8601 due date/time" },
        priority: { type: Type.STRING, description: "low, medium, high" },
        contact_id: { type: Type.NUMBER, description: "Contact ID to link this task to" },
      },
    },
  },
  {
    name: "search_contacts",
    description: "Search contacts by name, phone, or business name.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Name, phone fragment, or business name to search" },
        limit: { type: Type.NUMBER, description: "Max results, default 5" },
      },
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name: string, args: any, workspaceId: number): Promise<string> {
  if (name === "get_settings") {
    const env = readEnvFile();
    const valueAllowlist = new Set([
      "AGENT_NAME",
      "BUSINESS_NAME",
      "BUSINESS_TIMEZONE",
      "DEFAULT_TIMEZONE",
      "GEMINI_MODEL",
      "OPENROUTER_ENABLED",
      "OPENROUTER_MODEL",
    ]);
    const safe: Record<
      string,
      { configured: boolean; value?: string }
    > = {};
    for (const [k, v] of Object.entries(env)) {
      safe[k] = {
        configured: Boolean(String(v || "").trim()),
        ...(valueAllowlist.has(k) && String(v || "").trim()
          ? { value: String(v).trim() }
          : {}),
      };
    }
    return JSON.stringify(safe, null, 2);
  }

  if (name === "get_agent_prompt") {
    const rows = args.agent_id
      ? await sql`SELECT id, name, system_prompt, greeting, voice FROM agent_configs WHERE id = ${args.agent_id} AND workspace_id = ${workspaceId}`
      : await sql`SELECT id, name, system_prompt, greeting, voice FROM agent_configs WHERE workspace_id = ${workspaceId} AND is_active = true LIMIT 1`;
    return JSON.stringify(rows[0] || "No agent found.");
  }

  if (name === "get_team") {
    const rows = await sql`SELECT id, name, role, is_on_call, phone, email, handles_topics, priority FROM team_members WHERE workspace_id = ${workspaceId} AND is_active = TRUE ORDER BY name`;
    return JSON.stringify(rows);
  }

  if (name === "get_contact") {
    if (!args.phone && !args.name) {
      return JSON.stringify({
        ok: false,
        error: "Provide a contact name or phone number.",
      });
    }
    const rows = args.phone
      ? await sql`SELECT id, name, phone_number, email, business_name FROM contacts WHERE workspace_id = ${workspaceId} AND phone_number ILIKE ${'%' + args.phone + '%'}`
      : await sql`SELECT id, name, phone_number, email, business_name FROM contacts WHERE workspace_id = ${workspaceId} AND name ILIKE ${'%' + args.name + '%'}`;
    return JSON.stringify(rows);
  }

  // ── Task management tools ────────────────────────────────────────────────────
  if (name === "list_tasks") {
    const status = args.status || 'open';
    const lim = args.limit || 20;
    let rows;
    if (args.contact_phone) {
      rows = await sql`
        SELECT t.id, t.title, t.status, t.priority, t.assigned_to, t.due_at, t.notes, c.name as contact_name, c.phone_number
        FROM tasks t LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.workspace_id = ${workspaceId} AND t.status = ${status}
          AND c.phone_number ILIKE ${'%' + args.contact_phone + '%'}
        ORDER BY t.created_at DESC LIMIT ${lim}
      `;
    } else {
      rows = await sql`
        SELECT t.id, t.title, t.status, t.priority, t.assigned_to, t.due_at, t.notes, c.name as contact_name, c.phone_number
        FROM tasks t LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.workspace_id = ${workspaceId} AND t.status = ${status}
        ORDER BY t.created_at DESC LIMIT ${lim}
      `;
    }
    return JSON.stringify(rows);
  }

  if (name === "complete_task") {
    const rows = await sql`
      UPDATE tasks SET status = 'completed', notes = COALESCE(${args.resolution_notes ?? null}, notes), updated_at = NOW()
      WHERE id = ${args.task_id} AND workspace_id = ${workspaceId}
      RETURNING id
    `;
    return rows.length === 1
      ? JSON.stringify({
          ok: true,
          message: `Task ${args.task_id} marked completed.`,
        })
      : JSON.stringify({
          ok: false,
          code: "TASK_NOT_FOUND_OR_FORBIDDEN",
          error: "No task changed in this workspace.",
        });
  }

  if (name === "update_task") {
    const rows = await sql`
      UPDATE tasks SET
        status      = COALESCE(${args.status ?? null}, status),
        notes       = COALESCE(${args.notes ?? null}, notes),
        assigned_to = COALESCE(${args.assigned_to ?? null}, assigned_to),
        due_at      = COALESCE(${args.due_at ? new Date(args.due_at) : null}, due_at),
        updated_at  = NOW()
      WHERE id = ${args.task_id} AND workspace_id = ${workspaceId}
      RETURNING id
    `;
    return rows.length === 1
      ? JSON.stringify({
          ok: true,
          message: `Task ${args.task_id} updated.`,
        })
      : JSON.stringify({
          ok: false,
          code: "TASK_NOT_FOUND_OR_FORBIDDEN",
          error: "No task changed in this workspace.",
        });
  }

  if (name === "cancel_task") {
    const rows = await sql`
      UPDATE tasks SET status = 'cancelled', notes = COALESCE(${args.reason ?? null}, notes), updated_at = NOW()
      WHERE id = ${args.task_id} AND workspace_id = ${workspaceId}
      RETURNING id
    `;
    return rows.length === 1
      ? JSON.stringify({
          ok: true,
          message: `Task ${args.task_id} cancelled.`,
        })
      : JSON.stringify({
          ok: false,
          code: "TASK_NOT_FOUND_OR_FORBIDDEN",
          error: "No task changed in this workspace.",
        });
  }

  // ── Contact management tools ─────────────────────────────────────────────────
  if (name === "create_contact") {
    const existing = await sql`
      SELECT id
      FROM contacts
      WHERE workspace_id = ${workspaceId}
        AND phone_number = ${args.phone_number}
      LIMIT 1
    `;
    if (existing.length > 0) return JSON.stringify({ ok: false, message: `Contact with phone ${args.phone_number} already exists (id: ${existing[0].id}).` });
    const rows = await sql`
      INSERT INTO contacts (workspace_id, phone_number, name, email, business_name, notes)
      VALUES (${workspaceId}, ${args.phone_number}, ${args.name ?? null}, ${args.email ?? null}, ${args.business_name ?? null}, ${args.notes ?? null})
      RETURNING id, name, phone_number
    `;
    return JSON.stringify({ ok: true, contact: rows[0] });
  }

  if (name === "update_contact") {
    const rows = await sql`
      UPDATE contacts SET
        name          = COALESCE(${args.name ?? null}, name),
        email         = COALESCE(${args.email ?? null}, email),
        business_name = COALESCE(${args.business_name ?? null}, business_name),
        notes         = COALESCE(${args.notes ?? null}, notes),
        do_not_call   = COALESCE(${args.do_not_call ?? null}, do_not_call)
      WHERE id = ${args.contact_id}
        AND workspace_id = ${workspaceId}
      RETURNING id
    `;
    return rows.length === 1
      ? JSON.stringify({
          ok: true,
          message: `Contact ${args.contact_id} updated.`,
        })
      : JSON.stringify({
          ok: false,
          code: "CONTACT_NOT_FOUND_OR_FORBIDDEN",
          error: "No contact changed in this workspace.",
        });
  }

  // ── Action tools ────────────────────────────────────────────────────────────
  if (name === "search_contacts") {
    const q = args.query || '';
    const lim = args.limit || 5;
    const rows = await sql`
      SELECT id, name, phone_number, email, business_name
      FROM contacts
      WHERE workspace_id = ${workspaceId}
        AND (name ILIKE ${'%' + q + '%'} OR phone_number ILIKE ${'%' + q + '%'} OR business_name ILIKE ${'%' + q + '%'})
      ORDER BY name LIMIT ${lim}
    `;
    return JSON.stringify(rows);
  }

  if (name === "create_task") {
    if (args.contact_id != null) {
      const contacts = await sql`
        SELECT id
        FROM contacts
        WHERE id = ${args.contact_id}
          AND workspace_id = ${workspaceId}
        LIMIT 1
      `;
      if (contacts.length !== 1) {
        return JSON.stringify({
          ok: false,
          code: "CONTACT_NOT_FOUND_OR_FORBIDDEN",
          error: "The selected contact is not available in this workspace.",
        });
      }
    }
    const rows = await sql`
      INSERT INTO tasks (workspace_id, task_type, title, status, notes, assigned_to, due_at, priority, contact_id)
      VALUES (
        ${workspaceId},
        ${args.task_type},
        ${args.title},
        'open',
        ${args.notes ?? null},
        ${args.assigned_to ?? null},
        ${args.due_at ? new Date(args.due_at) : null},
        ${args.priority ?? 'medium'},
        ${args.contact_id ?? null}
      )
      RETURNING id, title, status
    `;
    return JSON.stringify({ ok: true, task: rows[0], message: `Task "${args.title}" created (id: ${rows[0]?.id}).` });
  }

  if (name === "list_calls") {
    const lim = args.limit || 10;
    const rows = await sql`
      SELECT c.call_sid, c.direction, c.from_number, c.to_number, c.status, c.duration_seconds, c.started_at,
             ct.name as contact_name
      FROM calls c LEFT JOIN contacts ct ON c.contact_id = ct.id
      WHERE c.workspace_id = ${workspaceId}
        ${args.status ? sql`AND c.status = ${args.status}` : sql``}
        ${args.direction ? sql`AND c.direction = ${args.direction}` : sql``}
      ORDER BY c.started_at DESC LIMIT ${lim}
    `;
    return JSON.stringify(rows);
  }

  return `Unknown tool: ${name}`;
}

// ── Main chat handler ─────────────────────────────────────────────────────────
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type { ChatAccessMode } from "./smirk-chat-policy.js";

type ChatToolUse = { name: string; result: string };
type SmirkChatResult = {
  reply: string;
  toolsUsed: ChatToolUse[];
  provider: SmirkChatProviderName;
};

const CHAT_PROVIDER_MAX_ROUNDS = 4;
const CHAT_PROVIDER_MAX_OUTPUT_TOKENS = 400;

function chatToolDenied(name: string, accessMode: ChatAccessMode): string {
  return JSON.stringify({
    ok: false,
    code: "CHAT_TOOL_REQUIRES_GUARDED_WORKFLOW",
    error: `${name} is not available from ${accessMode} chat. Use the dedicated guarded dashboard workflow.`,
  });
}

async function executeAllowedChatTool(input: {
  name: string;
  args: unknown;
  accessMode: ChatAccessMode;
  workspaceId: number;
  toolsUsed: ChatToolUse[];
  onExecutionAttempt: () => void;
}): Promise<string> {
  if (!isChatToolAllowed(input.accessMode, input.name)) {
    const denied = chatToolDenied(input.name, input.accessMode);
    input.toolsUsed.push({ name: input.name, result: denied });
    return denied;
  }

  input.onExecutionAttempt();
  const result = await executeTool(
    input.name,
    input.args && typeof input.args === "object" ? input.args : {},
    input.workspaceId
  );
  input.toolsUsed.push({ name: input.name, result });
  return result;
}

function toOpenRouterSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toOpenRouterSchema);
  if (!value || typeof value !== "object") {
    return typeof value === "string" &&
      ["OBJECT", "ARRAY", "STRING", "NUMBER", "INTEGER", "BOOLEAN", "NULL"].includes(
        value
      )
      ? value.toLowerCase()
      : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      toOpenRouterSchema(child),
    ])
  );
}

function parseOpenRouterToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

async function fetchOpenRouterChat(input: {
  apiKey: string;
  model: string;
  timeoutMs: number;
  messages: unknown[];
  tools: unknown[];
}): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1_000, Math.min(30_000, input.timeoutMs))
  );
  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer":
            process.env.APP_URL || "https://smirkcalls.com",
          "X-Title": "SMIRK Dashboard Chat",
        },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          tools: input.tools,
          tool_choice: input.tools.length > 0 ? "auto" : undefined,
          temperature: 0.3,
          max_tokens: CHAT_PROVIDER_MAX_OUTPUT_TOKENS,
        }),
      }
    );
    if (!response.ok) {
      throw new Error(`OpenRouter HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function runOpenRouterChat(input: {
  apiKey: string;
  model: string;
  timeoutMs: number;
  messages: ChatMessage[];
  systemInstruction: string;
  accessMode: ChatAccessMode;
  workspaceId: number;
  toolsUsed: ChatToolUse[];
  onExecutionAttempt: () => void;
}): Promise<Omit<SmirkChatResult, "provider">> {
  const declarations = chatToolDeclarationsForAccessMode(
    TOOL_DECLARATIONS,
    input.accessMode
  );
  const tools = declarations.map((declaration) => ({
    type: "function",
    function: toOpenRouterSchema(declaration),
  }));
  const providerMessages: any[] = [
    { role: "system", content: input.systemInstruction },
    ...input.messages.map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    })),
  ];

  for (let round = 0; round < CHAT_PROVIDER_MAX_ROUNDS; round += 1) {
    const data = await fetchOpenRouterChat({
      apiKey: input.apiKey,
      model: input.model,
      timeoutMs: input.timeoutMs,
      messages: providerMessages,
      tools,
    });
    const message = data?.choices?.[0]?.message;
    if (!message) throw new Error("OpenRouter returned no assistant message");

    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];
    if (toolCalls.length === 0) {
      return {
        reply:
          typeof message.content === "string" && message.content.trim()
            ? message.content.trim()
            : "I could not produce a response. Please try again.",
        toolsUsed: input.toolsUsed,
      };
    }

    providerMessages.push({
      role: "assistant",
      content: typeof message.content === "string" ? message.content : null,
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      const name = String(toolCall?.function?.name || "");
      const args = parseOpenRouterToolArguments(
        toolCall?.function?.arguments
      );
      const result = await executeAllowedChatTool({
        name,
        args,
        accessMode: input.accessMode,
        workspaceId: input.workspaceId,
        toolsUsed: input.toolsUsed,
        onExecutionAttempt: input.onExecutionAttempt,
      });
      providerMessages.push({
        role: "tool",
        tool_call_id: String(toolCall?.id || `tool-${round}`),
        content: result,
      });
    }
  }

  return {
    reply:
      "I reached the chat action limit. Review the recorded tool results before trying again.",
    toolsUsed: input.toolsUsed,
  };
}

async function runGeminiChat(input: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  systemInstruction: string;
  accessMode: ChatAccessMode;
  workspaceId: number;
  toolsUsed: ChatToolUse[];
  onExecutionAttempt: () => void;
}): Promise<Omit<SmirkChatResult, "provider">> {
  const ai = new GoogleGenAI({ apiKey: input.apiKey });
  const currentContents: any[] = input.messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));
  const declarations = chatToolDeclarationsForAccessMode(
    TOOL_DECLARATIONS,
    input.accessMode
  );

  for (let round = 0; round < CHAT_PROVIDER_MAX_ROUNDS; round += 1) {
    const response = await ai.models.generateContent({
      model: input.model,
      contents: currentContents,
      config: {
        systemInstruction: input.systemInstruction,
        tools: [{ functionDeclarations: declarations }],
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.AUTO,
          },
        },
        temperature: 0.3,
        maxOutputTokens: CHAT_PROVIDER_MAX_OUTPUT_TOKENS,
      },
    });

    const candidate = response.candidates?.[0];
    if (!candidate?.content) {
      throw new Error("Gemini returned no assistant message");
    }

    const parts = candidate.content.parts || [];
    currentContents.push(candidate.content);
    const toolCalls = parts.filter((part: any) => part.functionCall);
    if (toolCalls.length === 0) {
      const reply = parts
        .filter((part: any) => typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n")
        .trim();
      return {
        reply:
          reply || "I could not produce a response. Please try again.",
        toolsUsed: input.toolsUsed,
      };
    }

    const toolResults: any[] = [];
    for (const part of toolCalls) {
      const name = String(part.functionCall?.name || "");
      const result = await executeAllowedChatTool({
        name,
        args: part.functionCall?.args,
        accessMode: input.accessMode,
        workspaceId: input.workspaceId,
        toolsUsed: input.toolsUsed,
        onExecutionAttempt: input.onExecutionAttempt,
      });
      toolResults.push({
        functionResponse: { name, response: { result } },
      });
    }
    currentContents.push({ role: "user", parts: toolResults });
  }

  return {
    reply:
      "I reached the chat action limit. Review the recorded tool results before trying again.",
    toolsUsed: input.toolsUsed,
  };
}

export async function handleSmirkChat(
  messages: ChatMessage[],
  workspaceId: number,
  options: { accessMode?: ChatAccessMode } = {}
): Promise<SmirkChatResult> {
  const accessMode = options.accessMode || "operator";
  const context = await loadChatContext(workspaceId);
  const systemInstruction = `You are SMIRK — the operational brain of the SMIRK missed-call recovery service.
You have visibility into calls, leads, tasks, contacts, and team state.
${chatToolPolicyText(accessMode)}
For permitted local CRM and task actions, confirm the action and provide its persisted identifier. For restricted actions, identify the exact guarded dashboard workflow instead of pretending the action ran.

--- LIVE CONTEXT ---
${context}
--- END CONTEXT ---`;
  const workspaceKeys = await resolveWorkspaceAiKeys(workspaceId, {
    geminiApiKey: process.env.GEMINI_API_KEY,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
  });
  const baseOpenRouterConfig = loadOpenRouterConfig();
  const openRouterConfig = workspaceKeys.openrouterIsWorkspaceKey
    ? buildWorkspaceOpenRouterConfig(
        workspaceKeys,
        baseOpenRouterConfig
      )
    : baseOpenRouterConfig;
  const geminiApiKey = workspaceKeys.geminiApiKey;
  const geminiModel =
    process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const toolsUsed: ChatToolUse[] = [];
  let toolExecutionAttempts = 0;

  const selected = await runSmirkChatProviderChain({
    providers: [
      {
        name: "openrouter",
        configured: Boolean(openRouterConfig?.enabled),
        stopOnAuthenticationFailure:
          workspaceKeys.openrouterIsWorkspaceKey,
        run: () =>
          runOpenRouterChat({
            apiKey: openRouterConfig!.apiKey,
            model: openRouterConfig!.model,
            timeoutMs: openRouterConfig!.timeoutMs,
            messages,
            systemInstruction,
            accessMode,
            workspaceId,
            toolsUsed,
            onExecutionAttempt: () => {
              toolExecutionAttempts += 1;
            },
          }),
      },
      {
        name: "gemini",
        configured: Boolean(geminiApiKey),
        stopOnAuthenticationFailure: workspaceKeys.geminiIsWorkspaceKey,
        run: () =>
          runGeminiChat({
            apiKey: geminiApiKey!,
            model: geminiModel,
            messages,
            systemInstruction,
            accessMode,
            workspaceId,
            toolsUsed,
            onExecutionAttempt: () => {
              toolExecutionAttempts += 1;
            },
          }),
      },
    ],
    canFailover: () => toolExecutionAttempts === 0,
    onFailure: (attempt) => {
      console.warn("[smirk-chat] provider attempt failed", {
        workspaceId,
        provider: attempt.provider,
        failureKind: attempt.failureKind,
        toolExecutionAttempts,
      });
    },
  });

  return {
    ...selected.value,
    provider: selected.provider,
  };
}
