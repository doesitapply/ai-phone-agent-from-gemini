/**
 * SMIRK Chat Agent
 * Persistent chat bubble backend — talks about calls, leads, tasks,
 * and can edit settings, agent prompts, team roster, tasks, and contacts
 * directly from the dashboard (all production-safe, DB-backed tools).
 */

import fs from "fs";
import path from "path";
import { sql } from "./db.js";
import { readEnvFile, writeEnvFile } from "./settings.js";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const USE_OPENAI = !!OPENAI_API_KEY && !process.env.OPENROUTER_API_KEY;
const MODEL = USE_OPENAI ? "gpt-4.1-mini" : "openai/gpt-4.1-mini";
const API_BASE = USE_OPENAI
  ? "https://api.openai.com/v1/chat/completions"
  : "https://openrouter.ai/api/v1/chat/completions";
const AUTH_KEY = USE_OPENAI ? OPENAI_API_KEY : OPENROUTER_API_KEY;

// ── Source-code root (only available in dev, not production) ──────────────────
const SRC_ROOT = path.resolve(process.cwd(), "src");
const SERVER_FILE = path.resolve(process.cwd(), "server.ts");
const SRC_AVAILABLE = fs.existsSync(SRC_ROOT);

function safeReadFile(filePath: string): { content: string; error?: string } {
  if (!SRC_AVAILABLE) {
    return { content: "", error: "Source files are not available in this environment (production build)." };
  }
  try {
    const abs = path.resolve(filePath);
    if (!abs.startsWith(SRC_ROOT) && abs !== SERVER_FILE) {
      return { content: "", error: "Access denied: only src/ files and server.ts are readable." };
    }
    if (!fs.existsSync(abs)) return { content: "", error: `File not found: ${filePath}` };
    const content = fs.readFileSync(abs, "utf8");
    return { content };
  } catch (e: any) {
    return { content: "", error: e.message };
  }
}

function safeWriteFile(filePath: string, content: string): { ok: boolean; error?: string } {
  if (!SRC_AVAILABLE) {
    return { ok: false, error: "Source files are not available in this environment (production build)." };
  }
  try {
    const abs = path.resolve(filePath);
    if (!abs.startsWith(SRC_ROOT) && abs !== SERVER_FILE) {
      return { ok: false, error: "Access denied: only src/ files and server.ts are writable." };
    }
    fs.writeFileSync(abs, content, "utf8");
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

function safePatchFile(filePath: string, find: string, replace: string): { ok: boolean; error?: string; replacements?: number } {
  if (!SRC_AVAILABLE) {
    return { ok: false, error: "Source files are not available in this environment (production build)." };
  }
  try {
    const abs = path.resolve(filePath);
    if (!abs.startsWith(SRC_ROOT) && abs !== SERVER_FILE) {
      return { ok: false, error: "Access denied." };
    }
    if (!fs.existsSync(abs)) return { ok: false, error: `File not found: ${filePath}` };
    const original = fs.readFileSync(abs, "utf8");
    const updated = original.split(find).join(replace);
    const count = (original.split(find).length - 1);
    if (count === 0) return { ok: false, error: "Pattern not found in file.", replacements: 0 };
    fs.writeFileSync(abs, updated, "utf8");
    return { ok: true, replacements: count };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

function listSrcFiles(): string[] {
  if (!SRC_AVAILABLE) return [];
  const results: string[] = [];
  function walk(dir: string) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          results.push(path.relative(process.cwd(), full));
        }
      }
    } catch (_) {}
  }
  walk(SRC_ROOT);
  if (fs.existsSync(SERVER_FILE)) results.push("server.ts");
  return results;
}

// ── Context loader ────────────────────────────────────────────────────────────
export async function loadChatContext(workspaceId: number): Promise<string> {
  try {
    const [callRows, leadRows, taskRows, countRows, teamRows, agentRows] = await Promise.all([
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
      sql`SELECT id, name, role, department, phone, email, on_call, active, handles_topics
          FROM team_members WHERE workspace_id = ${workspaceId} AND active = true
          ORDER BY priority DESC`,
      sql`SELECT id, name, display_name, greeting, voice, is_active, max_turns
          FROM agent_configs WHERE workspace_id = ${workspaceId}
          ORDER BY is_active DESC LIMIT 5`,
    ]);

    return `
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

=== ENVIRONMENT ===
Source code available: ${SRC_AVAILABLE}
Working directory: ${process.cwd()}
`.trim();
  } catch (e: any) {
    return `[Context load failed: ${e.message}]`;
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  // ── Code tools (dev only) ──────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "list_source_files",
      description: "List all TypeScript source files in the SMIRK app. Only available in development environments.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the content of a source file. Only src/ files and server.ts are accessible. Dev only.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "Relative file path, e.g. src/intelligence.ts" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "patch_file",
      description: "Replace a specific string in a source file. Dev only.",
      parameters: {
        type: "object",
        required: ["path", "find", "replace"],
        properties: {
          path: { type: "string" },
          find: { type: "string", description: "Exact string to find" },
          replace: { type: "string", description: "Replacement string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Overwrite a source file with new content. Dev only.",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string", description: "Full new file content" },
        },
      },
    },
  },
  // ── Settings tools (production-safe) ──────────────────────────────────────
  {
    type: "function",
    function: {
      name: "get_settings",
      description: "Read current platform settings (non-sensitive keys only — API keys are masked). Use this to check current configuration before making changes.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "update_setting",
      description: "Update a platform setting by key. Works in production. Use for things like MISSED_CALL_TEXT_BACK, REVIEW_SMS_ENABLED, BOOKING_LINK, REVIEW_LINK, MISSED_CALL_TEXT_MESSAGE, REVIEW_SMS_MESSAGE, BUSINESS_TIMEZONE, GOOGLE_TTS_VOICE, OPENROUTER_MODEL, etc.",
      parameters: {
        type: "object",
        required: ["key", "value"],
        properties: {
          key: { type: "string", description: "The setting key name, e.g. MISSED_CALL_TEXT_BACK" },
          value: { type: "string", description: "The new value to set" },
        },
      },
    },
  },
  // ── Agent prompt tools (production-safe) ──────────────────────────────────
  {
    type: "function",
    function: {
      name: "get_agent_prompt",
      description: "Get the current system prompt and greeting for the active AI phone agent. Use this before editing.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "number", description: "Agent ID (optional — defaults to the active agent)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_agent_prompt",
      description: "Update the system prompt or greeting for an AI phone agent. Works in production. Changes take effect on the next call.",
      parameters: {
        type: "object",
        required: ["agent_id"],
        properties: {
          agent_id: { type: "number", description: "Agent ID to update" },
          system_prompt: { type: "string", description: "New system prompt (leave undefined to keep current)" },
          greeting: { type: "string", description: "New greeting message (leave undefined to keep current)" },
          voice: { type: "string", description: "New voice name (leave undefined to keep current)" },
        },
      },
    },
  },
  // ── Team roster tools (production-safe) ───────────────────────────────────
  {
    type: "function",
    function: {
      name: "get_team",
      description: "Get the full team roster including who is currently on-call.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "update_team_member",
      description: "Update a team member's info, on-call status, or topics. Works in production.",
      parameters: {
        type: "object",
        required: ["member_id"],
        properties: {
          member_id: { type: "number", description: "Team member ID" },
          on_call: { type: "boolean", description: "Set on-call status" },
          phone: { type: "string", description: "Update phone number" },
          email: { type: "string", description: "Update email" },
          role: { type: "string", description: "Update role title" },
          handles_topics: { type: "array", items: { type: "string" }, description: "Topics this person handles (e.g. ['billing','pricing'])" },
          notes: { type: "string", description: "Update notes" },
        },
      },
    },
  },
  // ── Task tools (production-safe) ──────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "update_task",
      description: "Update a task's status, notes, or due date. Works in production.",
      parameters: {
        type: "object",
        required: ["task_id"],
        properties: {
          task_id: { type: "number", description: "Task ID" },
          status: { type: "string", enum: ["pending", "completed", "cancelled"], description: "New status" },
          notes: { type: "string", description: "Updated notes" },
          due_at: { type: "string", description: "New due date in ISO format" },
        },
      },
    },
  },
  // ── Contact tools (production-safe) ───────────────────────────────────────
  {
    type: "function",
    function: {
      name: "get_contact",
      description: "Look up a contact by name or phone number.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Contact name to search for" },
          phone: { type: "string", description: "Phone number to search for" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_contact",
      description: "Update a contact's information. Works in production.",
      parameters: {
        type: "object",
        required: ["contact_id"],
        properties: {
          contact_id: { type: "number", description: "Contact ID" },
          name: { type: "string", description: "Updated name" },
          email: { type: "string", description: "Updated email" },
          notes: { type: "string", description: "Updated notes" },
          tags: { type: "string", description: "Updated tags (comma-separated)" },
        },
      },
    },
  },
  // ── Boss Mode briefing tools (production-safe) ────────────────────────────
  {
    type: "function",
    function: {
      name: "inject_briefing",
      description: "Inject a temporary briefing into the AI phone agent. The agent will use this knowledge on all calls until it expires. Works in production.",
      parameters: {
        type: "object",
        required: ["content"],
        properties: {
          content: { type: "string", description: "The briefing text to inject" },
          category: { type: "string", enum: ["briefing", "pricing", "promo", "closure", "policy", "emergency", "other"], description: "Category of the briefing" },
          expires_hours: { type: "number", description: "Hours until this briefing expires (default 24, use 0 for permanent)" },
          priority: { type: "number", description: "Priority 1-100 (higher = more important, default 20)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clear_briefing",
      description: "Remove an active briefing from the AI phone agent by ID.",
      parameters: {
        type: "object",
        required: ["briefing_id"],
        properties: {
          briefing_id: { type: "number", description: "The briefing ID to remove" },
        },
      },
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name: string, args: any, workspaceId: number): Promise<string> {
  // Code tools (dev only)
  if (name === "list_source_files") {
    const files = listSrcFiles();
    if (files.length === 0) return "Source files not available in this environment.";
    return JSON.stringify(files);
  }
  if (name === "read_file") {
    const r = safeReadFile(args.path);
    return r.error ? `ERROR: ${r.error}` : r.content;
  }
  if (name === "patch_file") {
    const r = safePatchFile(args.path, args.find, args.replace);
    return JSON.stringify(r);
  }
  if (name === "write_file") {
    const r = safeWriteFile(args.path, args.content);
    return JSON.stringify(r);
  }

  // Settings tools
  if (name === "get_settings") {
    try {
      const env = readEnvFile();
      const SENSITIVE = ["API_KEY", "AUTH_TOKEN", "SECRET", "PASSWORD", "PASS", "SERVICE_ACCOUNT"];
      const safe: Record<string, string> = {};
      for (const [k, v] of Object.entries(env)) {
        const isSensitive = SENSITIVE.some((s) => k.toUpperCase().includes(s));
        safe[k] = isSensitive ? "••••••••" : v;
      }
      return JSON.stringify(safe, null, 2);
    } catch (e: any) {
      return `ERROR: ${e.message}`;
    }
  }
  if (name === "update_setting") {
    try {
      const PROTECTED = ["TWILIO_AUTH_TOKEN", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON", "DASHBOARD_PASS"];
      if (PROTECTED.includes(args.key)) return `ERROR: Cannot update ${args.key} via chat for security reasons. Use the Settings page.`;
      writeEnvFile({ [args.key]: args.value });
      return JSON.stringify({ ok: true, key: args.key, value: args.value, message: "Setting updated. Changes take effect immediately (no restart needed for most settings)." });
    } catch (e: any) {
      return `ERROR: ${e.message}`;
    }
  }

  // Agent prompt tools
  if (name === "get_agent_prompt") {
    try {
      const rows = args.agent_id
        ? await sql`SELECT id, name, display_name, system_prompt, greeting, voice, is_active FROM agent_configs WHERE id = ${args.agent_id} AND workspace_id = ${workspaceId}`
        : await sql`SELECT id, name, display_name, system_prompt, greeting, voice, is_active FROM agent_configs WHERE workspace_id = ${workspaceId} AND is_active = true LIMIT 1`;
      if (!rows.length) return "No agent found.";
      return JSON.stringify(rows[0], null, 2);
    } catch (e: any) {
      return `ERROR: ${e.message}`;
    }
  }
  if (name === "update_agent_prompt") {
    try {
      const updates: string[] = [];
      if (args.system_prompt !== undefined) updates.push("system_prompt");
      if (args.greeting !== undefined) updates.push("greeting");
      if (args.voice !== undefined) updates.push("voice");
      if (!updates.length) return "ERROR: No fields to update provided.";

      await sql`
        UPDATE agent_configs SET
          system_prompt = COALESCE(${args.system_prompt ?? null}, system_prompt),
          greeting      = COALESCE(${args.greeting ?? null}, greeting),
          voice         = COALESCE(${args.voice ?? null}, voice),
          updated_at    = NOW()
        WHERE id = ${args.agent_id} AND workspace_id = ${workspaceId}
      `;
      return JSON.stringify({ ok: true, updated: updates, message: "Agent updated. Changes take effect on the next call." });
    } catch (e: any) {
      return `ERROR: ${e.message}`;
    }
  }

  // Team tools
  if (name === "get_team") {
    try {
      const rows = await sql`SELECT id, name, role, department, phone, email, on_call, active, handles_topics, priority, notes FROM team_members WHERE workspace_id = ${workspaceId} ORDER BY priority DESC`;
      return JSON.stringify(rows, null, 2);
    } catch (e: any) {
      return `ERROR: ${e.message}`;
    }
  }
  if (name === "update_team_member") {
    try {
      await sql`
        UPDATE team_members SET
          on_call        = COALESCE(${args.on_call ?? null}, on_call),
          phone          = COALESCE(${args.phone ?? null}, phone),
          email          = COALESCE(${args.email ?? null}, email),
          role           = COALESCE(${args.role ?? null}, role),
          handles_topics = COALESCE(${args.handles_topics ? JSON.stringify(args.handles_topics) : null}::jsonb, handles_topics),
          notes          = COALESCE(${args.notes ?? null}, notes),
          updated_at     = NOW()
        WHERE id = ${args.member_id} AND workspace_id = ${workspaceId}
      `;
      return JSON.stringify({ ok: true, member_id: args.member_id, message: "Team member updated." });
    } catch (e: any) {
      return `ERROR: ${e.message}`;
    }
  }

  // Task tools
  if (name === "update_task") {
    try {
      await sql`
        UPDATE tasks SET
          status   = COALESCE(${args.status ?? null}, status),
          notes    = COALESCE(${args.notes ?? null}, notes),
          due_at   = COALESCE(${args.due_at ?? null}::timestamptz, due_at),
          updated_at = NOW()
        WHERE id = ${args.task_id} AND workspace_id = ${workspaceId}
      `;
      return JSON.stringify({ ok: true, task_id: args.task_id, message: `Task ${args.status ? `marked ${args.status}` : "updated"}.` });
    } catch (e: any) {
      return `ERROR: ${e.message}`;
    }
  }

  // Contact tools
  if (name === "get_contact") {
    try {
      const rows = args.phone
        ? await sql`SELECT id, name, phone, email, notes, tags, created_at FROM contacts WHERE workspace_id = ${workspaceId} AND phone ILIKE ${'%' + (args.phone || '') + '%'} LIMIT 5`
        : await sql`SELECT id, name, phone, email, notes, tags, created_at FROM contacts WHERE workspace_id = ${workspaceId} AND name ILIKE ${'%' + (args.name || '') + '%'} LIMIT 5`;
      return JSON.stringify(rows, null, 2);
    } catch (e: any) {
      return `ERROR: ${e.message}`;
    }
  }
  if (name === "update_contact") {
    try {
      await sql`
        UPDATE contacts SET
          name  = COALESCE(${args.name ?? null}, name),
          email = COALESCE(${args.email ?? null}, email),
          notes = COALESCE(${args.notes ?? null}, notes),
          tags  = COALESCE(${args.tags ?? null}, tags),
          updated_at = NOW()
        WHERE id = ${args.contact_id} AND workspace_id = ${workspaceId}
      `;
      return JSON.stringify({ ok: true, contact_id: args.contact_id, message: "Contact updated." });
    } catch (e: any) {
      return `ERROR: ${e.message}`;
    }
  }

  // Boss Mode briefing tools
  if (name === "inject_briefing") {
    try {
      const expiresHours = args.expires_hours ?? 24;
      const expiresAt = expiresHours > 0
        ? new Date(Date.now() + expiresHours * 3600000).toISOString()
        : null;
      const rows = await sql`
        INSERT INTO temporary_context (workspace_id, content, category, priority, expires_at, created_by)
        VALUES (${workspaceId}, ${args.content}, ${args.category || 'briefing'}, ${args.priority || 20}, ${expiresAt}, 'smirk_chat')
        RETURNING id
      `;
      const id = (rows as any[])[0]?.id;
      return JSON.stringify({ ok: true, briefing_id: id, expires_at: expiresAt, message: `Briefing injected (ID: ${id}). The AI will use this on all calls${expiresAt ? ` until ${new Date(expiresAt).toLocaleString()}` : " permanently"}.` });
    } catch (e: any) {
      return `ERROR: ${e.message}`;
    }
  }
  if (name === "clear_briefing") {
    try {
      await sql`DELETE FROM temporary_context WHERE id = ${args.briefing_id} AND workspace_id = ${workspaceId}`;
      return JSON.stringify({ ok: true, message: `Briefing ${args.briefing_id} removed.` });
    } catch (e: any) {
      return `ERROR: ${e.message}`;
    }
  }

  return `Unknown tool: ${name}`;
}

// ── Main chat handler (agentic loop, up to 8 tool rounds) ─────────────────────
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export async function handleSmirkChat(
  messages: ChatMessage[],
  workspaceId: number
): Promise<{ reply: string; toolsUsed: string[] }> {
  const context = await loadChatContext(workspaceId);

  const systemPrompt = `You are SMIRK — an AI operations agent embedded in the SMIRK phone-agent platform.
You have full visibility into the platform's calls, leads, tasks, team roster, and agents (provided below as live context).
You can also make real changes to the platform using the tools provided — all tools work in production.

CAPABILITIES:
- Answer questions about leads, calls, tasks, and team status using the live context
- Update platform settings (toggle features, change messages, update links)
- Edit the AI phone agent's system prompt and greeting
- Manage the team roster (on-call status, topics, contact info)
- Update tasks (complete, cancel, edit notes)
- Look up and update contacts
- Inject or remove Boss Mode briefings (temporary knowledge for the phone agent)
${SRC_AVAILABLE ? "- Read and edit TypeScript source code (development mode)" : ""}

RULES:
- Always read current state before making changes (use get_ tools first)
- When updating the agent prompt, read it first, make targeted changes, and confirm what changed
- Never expose API keys or passwords — they are masked in get_settings output
- After making any change, confirm what was done and what the effect will be
- Be direct and concise — you're talking to the operator who built this system

--- LIVE PLATFORM CONTEXT ---
${context}
--- END CONTEXT ---`;

  const apiMessages: any[] = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  const toolsUsed: string[] = [];
  let rounds = 0;

  while (rounds < 8) {
    rounds++;
    const resp = await fetch(API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AUTH_KEY}`,
        "HTTP-Referer": "https://smirk.app",
        "X-Title": "SMIRK Chat",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: apiMessages,
        tools: TOOLS,
        tool_choice: "auto",
        max_tokens: 4096,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`LLM error ${resp.status}: ${err.slice(0, 200)}`);
    }

    const data = await resp.json() as any;
    const choice = data.choices?.[0];
    const msg = choice?.message;

    if (!msg) throw new Error("No message in LLM response");

    apiMessages.push(msg);

    // No tool calls — final answer
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { reply: msg.content || "", toolsUsed };
    }

    // Execute tool calls
    for (const tc of msg.tool_calls) {
      const toolName = tc.function?.name;
      let args: any = {};
      try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
      toolsUsed.push(toolName);
      const result = await executeTool(toolName, args, workspaceId);
      apiMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result,
      });
    }
  }

  // Fallback after max rounds
  const lastMsg = apiMessages[apiMessages.length - 1];
  return {
    reply: typeof lastMsg.content === "string" ? lastMsg.content : "Max tool rounds reached.",
    toolsUsed,
  };
}
