/**
 * SMIRK Chat Agent
 * Hardened version — uses native Gemini 1.5 Flash.
 * Persistent chat bubble backend — talks about calls, leads, tasks,
 * and can edit settings, agent prompts, team roster, tasks, and contacts.
 */

import fs from "fs";
import path from "path";
import { sql } from "./db.js";
import { readEnvFile, writeEnvFile } from "./settings.js";
import { GoogleGenAI, FunctionCallingConfigMode, Type } from "@google/genai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash-latest";
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

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

// ── Tool declarations for Gemini ──────────────────────────────────────────────
const TOOL_DECLARATIONS = [
  {
    name: "list_source_files",
    description: "List all TypeScript source files in the SMIRK app. Only available in development environments.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "read_file",
    description: "Read the content of a source file. Only src/ files and server.ts are accessible. Dev only.",
    parameters: {
      type: Type.OBJECT,
      required: ["path"],
      properties: {
        path: { type: Type.STRING, description: "Relative file path, e.g. src/intelligence.ts" },
      },
    },
  },
  {
    name: "patch_file",
    description: "Replace a specific string in a source file. Dev only.",
    parameters: {
      type: Type.OBJECT,
      required: ["path", "find", "replace"],
      properties: {
        path: { type: Type.STRING },
        find: { type: Type.STRING, description: "Exact string to find" },
        replace: { type: Type.STRING, description: "Replacement string" },
      },
    },
  },
  {
    name: "get_settings",
    description: "Read current platform settings (non-sensitive keys only).",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "update_setting",
    description: "Update a platform setting by key.",
    parameters: {
      type: Type.OBJECT,
      required: ["key", "value"],
      properties: {
        key: { type: Type.STRING, description: "Setting key name" },
        value: { type: Type.STRING, description: "New value" },
      },
    },
  },
  {
    name: "get_agent_prompt",
    description: "Get current system prompt and greeting for the active AI phone agent.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        agent_id: { type: Type.NUMBER, description: "Optional agent ID" },
      },
    },
  },
  {
    name: "update_agent_prompt",
    description: "Update system prompt or greeting for an AI phone agent.",
    parameters: {
      type: Type.OBJECT,
      required: ["agent_id"],
      properties: {
        agent_id: { type: Type.NUMBER },
        system_prompt: { type: Type.STRING },
        greeting: { type: Type.STRING },
        voice: { type: Type.STRING },
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
    name: "inject_briefing",
    description: "Inject a temporary briefing into the AI phone agent.",
    parameters: {
      type: Type.OBJECT,
      required: ["content"],
      properties: {
        content: { type: Type.STRING },
        category: { type: Type.STRING },
        expires_hours: { type: Type.NUMBER },
      },
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name: string, args: any, workspaceId: number): Promise<string> {
  if (name === "list_source_files") return JSON.stringify(listSrcFiles());
  if (name === "read_file") {
    const r = safeReadFile(args.path);
    return r.error ? `ERROR: ${r.error}` : r.content;
  }
  if (name === "patch_file") return JSON.stringify(safePatchFile(args.path, args.find, args.replace));
  
  if (name === "get_settings") {
    const env = readEnvFile();
    const safe: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      safe[k] = k.toUpperCase().includes("API_KEY") || k.toUpperCase().includes("TOKEN") ? "••••••••" : v;
    }
    return JSON.stringify(safe, null, 2);
  }

  if (name === "update_setting") {
    const PROTECTED = ["TWILIO_AUTH_TOKEN", "GEMINI_API_KEY", "OPENAI_API_KEY", "DASHBOARD_PASS"];
    if (PROTECTED.includes(args.key)) return `ERROR: Cannot update ${args.key} via chat.`;
    writeEnvFile({ [args.key]: args.value });
    return JSON.stringify({ ok: true, message: "Setting updated." });
  }

  if (name === "get_agent_prompt") {
    const rows = args.agent_id
      ? await sql`SELECT id, name, system_prompt, greeting, voice FROM agent_configs WHERE id = ${args.agent_id} AND workspace_id = ${workspaceId}`
      : await sql`SELECT id, name, system_prompt, greeting, voice FROM agent_configs WHERE workspace_id = ${workspaceId} AND is_active = true LIMIT 1`;
    return JSON.stringify(rows[0] || "No agent found.");
  }

  if (name === "update_agent_prompt") {
    await sql`
      UPDATE agent_configs SET
        system_prompt = COALESCE(${args.system_prompt ?? null}, system_prompt),
        greeting      = COALESCE(${args.greeting ?? null}, greeting),
        voice         = COALESCE(${args.voice ?? null}, voice),
        updated_at    = NOW()
      WHERE id = ${args.agent_id} AND workspace_id = ${workspaceId}
    `;
    return JSON.stringify({ ok: true, message: "Agent updated." });
  }

  if (name === "get_team") {
    const rows = await sql`SELECT id, name, role, on_call, phone FROM team_members WHERE workspace_id = ${workspaceId}`;
    return JSON.stringify(rows);
  }

  if (name === "get_contact") {
    const rows = args.phone
      ? await sql`SELECT id, name, phone FROM contacts WHERE workspace_id = ${workspaceId} AND phone ILIKE ${'%' + args.phone + '%'}`
      : await sql`SELECT id, name, phone FROM contacts WHERE workspace_id = ${workspaceId} AND name ILIKE ${'%' + args.name + '%'}`;
    return JSON.stringify(rows);
  }

  if (name === "inject_briefing") {
    const expiresAt = args.expires_hours ? new Date(Date.now() + args.expires_hours * 3600000).toISOString() : null;
    await sql`INSERT INTO temporary_context (workspace_id, content, category, expires_at) VALUES (${workspaceId}, ${args.content}, ${args.category || 'briefing'}, ${expiresAt})`;
    return JSON.stringify({ ok: true, message: "Briefing injected." });
  }

  return `Unknown tool: ${name}`;
}

// ── Main chat handler ─────────────────────────────────────────────────────────
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export async function handleSmirkChat(
  messages: ChatMessage[],
  workspaceId: number
): Promise<{ reply: string; toolsUsed: string[] }> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured for SMIRK Chat");

  const context = await loadChatContext(workspaceId);
  const systemInstruction = `You are SMIRK — the AI operational brain of the SMIRK phone-agent platform.
You have visibility into calls, leads, tasks, and team state.
You can update settings, prompts, and inject briefings.

--- LIVE CONTEXT ---
${context}
--- END CONTEXT ---`;

  const currentContents: any[] = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));

  const toolsUsed: string[] = [];
  let rounds = 0;

  while (rounds < 8) {
    rounds++;
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: currentContents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
        temperature: 0.5,
      },
    });

    const candidate = response.candidates?.[0];
    if (!candidate) throw new Error("Gemini returned no response");

    const parts = candidate.content?.parts || [];
    currentContents.push(candidate.content);

    const callParts = parts.filter((p: any) => p.functionCall);
    const textParts = parts.filter((p: any) => p.text);

    if (callParts.length > 0) {
      const toolResults: any[] = [];
      for (const cp of callParts) {
        const { name, args } = cp.functionCall;
        toolsUsed.push(name);
        const result = await executeTool(name, args, workspaceId);
        toolResults.push({
          functionResponse: { name, response: { result } }
        });
      }
      currentContents.push({ role: "model", parts: toolResults });
    } else {
      return { reply: textParts.map((p: any) => p.text).join("\n") || "", toolsUsed };
    }
  }

  return { reply: "Max rounds reached.", toolsUsed };
}
