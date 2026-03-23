/**
 * SMIRK Chat Agent
 * Persistent chat bubble backend — talks about calls, leads, tasks,
 * and can read + edit app source code.
 */

import fs from "fs";
import path from "path";
import { sql } from "./db.js";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || "";
const MODEL = "google/gemini-2.0-flash-001";

// ── Source-code root (only files under src/ and server.ts are editable) ──────
const SRC_ROOT = path.resolve(process.cwd(), "src");
const SERVER_FILE = path.resolve(process.cwd(), "server.ts");

function safeReadFile(filePath: string): { content: string; error?: string } {
  try {
    const abs = path.resolve(filePath);
    // Only allow reading inside src/ or server.ts
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

function safePatchFile(
  filePath: string,
  find: string,
  replace: string
): { ok: boolean; error?: string; replacements?: number } {
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
  const results: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        results.push(path.relative(process.cwd(), full));
      }
    }
  }
  walk(SRC_ROOT);
  results.push("server.ts");
  return results;
}

// ── Context loader — pulls recent calls, leads, tasks ─────────────────────────
async function loadContext(workspaceId: number): Promise<string> {
  try {
    const [callRows, leadRows, taskRows] = await Promise.all([
      sql`SELECT call_sid, direction, from_number, to_number, status, duration_seconds,
                 intent, outcome, call_summary, sentiment, resolution_score, started_at
          FROM calls WHERE workspace_id = ${workspaceId}
          ORDER BY started_at DESC LIMIT 10`,
      sql`SELECT id, name, phone, funnel_stage, service_type, appointment_time,
                 integration_status, last_error, booked_at, qualified_at, created_at
          FROM leads WHERE workspace_id = ${workspaceId}
          ORDER BY updated_at DESC LIMIT 10`,
      sql`SELECT id, task_type, status, notes, due_at, created_at
          FROM tasks WHERE workspace_id = ${workspaceId} AND status != 'completed'
          ORDER BY due_at ASC LIMIT 10`,
    ]);

    return `
=== RECENT CALLS (last 10) ===
${JSON.stringify(callRows, null, 2)}

=== RECENT LEADS (last 10) ===
${JSON.stringify(leadRows, null, 2)}

=== OPEN TASKS ===
${JSON.stringify(taskRows, null, 2)}
`.trim();
  } catch (e: any) {
    return `[Context load failed: ${e.message}]`;
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_source_files",
      description: "List all TypeScript source files in the SMIRK app (src/ and server.ts).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the content of a source file. Only src/ files and server.ts are accessible.",
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
      description: "Replace a specific string in a source file. Use for targeted edits. All occurrences of `find` are replaced.",
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
      description: "Overwrite a source file with new content. Use for large rewrites.",
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
];

// ── Tool executor ─────────────────────────────────────────────────────────────
function executeTool(name: string, args: any): string {
  if (name === "list_source_files") {
    return JSON.stringify(listSrcFiles());
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
  return `Unknown tool: ${name}`;
}

// ── Main chat handler (agentic loop, up to 5 tool rounds) ─────────────────────
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export async function handleSmirkChat(
  messages: ChatMessage[],
  workspaceId: number
): Promise<{ reply: string; toolsUsed: string[] }> {
  const context = await loadContext(workspaceId);

  const systemPrompt = `You are SMIRK — an AI operations agent embedded in the SMIRK phone-agent platform.
You have full visibility into the platform's calls, leads, and tasks (provided below as live context).
You can also read and edit the app's TypeScript source code using the tools provided.

When editing code:
1. Always read the file first to understand the current state.
2. Use patch_file for targeted changes; use write_file only for full rewrites.
3. After editing, tell the user what changed and that they need to rebuild + redeploy.

Be direct, concise, and technically precise. You are talking to the operator who built this system.

--- LIVE PLATFORM CONTEXT ---
${context}
--- END CONTEXT ---`;

  const apiMessages: any[] = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  const toolsUsed: string[] = [];
  let rounds = 0;

  while (rounds < 5) {
    rounds++;
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
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

    // No tool calls — we have the final answer
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { reply: msg.content || "", toolsUsed };
    }

    // Execute tool calls
    for (const tc of msg.tool_calls) {
      const name = tc.function?.name;
      let args: any = {};
      try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
      toolsUsed.push(name);
      const result = executeTool(name, args);
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
