/**
 * SMIRK Chat Agent
 * Hardened version — uses native Gemini 1.5 Flash.
 * Persistent chat bubble backend — talks about calls, leads, tasks,
 * and can edit settings, agent prompts, team roster, tasks, and contacts.
 */

import fs from "fs";
import path from "path";
import twilio from "twilio";
import { sql } from "./db.js";
import { readEnvFile, writeEnvFile } from "./settings.js";
import { insertCalendarEvent } from "./gcal.js";
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
    name: "make_call",
    description: "Initiate an outbound phone call via Twilio to a contact or phone number. Use when the user says 'call X', 'dial X', 'phone X', or 'reach out to X'. Always look up the contact first if only a name is given.",
    parameters: {
      type: Type.OBJECT,
      required: ["to_number"],
      properties: {
        to_number: { type: Type.STRING, description: "E.164 phone number to call, e.g. +15551234567" },
        contact_name: { type: Type.STRING, description: "Name of the contact being called (for logging)" },
        reason: { type: Type.STRING, description: "Why this call is being made (for task/log notes)" },
      },
    },
  },
  {
    name: "book_appointment",
    description: "Book an appointment in Google Calendar. Use when the user says 'book', 'schedule', 'set up a meeting', 'appointment for X at Y time'.",
    parameters: {
      type: Type.OBJECT,
      required: ["summary"],
      properties: {
        summary: { type: Type.STRING, description: "Appointment title, e.g. 'HVAC Inspection — Bob Smith'" },
        start_iso: { type: Type.STRING, description: "ISO 8601 start datetime, e.g. 2025-05-01T14:00:00" },
        end_iso: { type: Type.STRING, description: "ISO 8601 end datetime (optional, defaults to +1h)" },
        description: { type: Type.STRING, description: "Notes or context for the appointment" },
        location: { type: Type.STRING, description: "Address or location" },
        attendee_email: { type: Type.STRING, description: "Email of the attendee" },
        timezone: { type: Type.STRING, description: "Timezone, e.g. America/Los_Angeles" },
      },
    },
  },
  {
    name: "create_task",
    description: "Create a new task in the system. Use when the user says 'create a task', 'add a task', 'remind me to', or when follow-up work needs to be tracked.",
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
    description: "Search contacts by name, phone, or business name. Use before make_call when you only have a name.",
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
    const rows = await sql`SELECT id, name, role, is_on_call, phone, email, handles_topics, priority FROM team_members WHERE workspace_id = ${workspaceId} AND is_active = TRUE ORDER BY name`;
    return JSON.stringify(rows);
  }

  if (name === "get_contact") {
    const rows = args.phone
      ? await sql`SELECT id, name, phone_number, email, business_name FROM contacts WHERE workspace_id = ${workspaceId} AND phone_number ILIKE ${'%' + args.phone + '%'}`
      : await sql`SELECT id, name, phone_number, email, business_name FROM contacts WHERE workspace_id = ${workspaceId} AND name ILIKE ${'%' + args.name + '%'}`;
    return JSON.stringify(rows);
  }

  if (name === "inject_briefing") {
    const expiresAt = args.expires_hours ? new Date(Date.now() + args.expires_hours * 3600000).toISOString() : null;
    await sql`INSERT INTO temporary_context (workspace_id, content, category, expires_at) VALUES (${workspaceId}, ${args.content}, ${args.category || 'briefing'}, ${expiresAt})`;
    return JSON.stringify({ ok: true, message: "Briefing injected." });
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
    await sql`
      UPDATE tasks SET status = 'completed', notes = COALESCE(${args.resolution_notes ?? null}, notes), updated_at = NOW()
      WHERE id = ${args.task_id} AND workspace_id = ${workspaceId}
    `;
    return JSON.stringify({ ok: true, message: `Task ${args.task_id} marked completed.` });
  }

  if (name === "update_task") {
    await sql`
      UPDATE tasks SET
        status      = COALESCE(${args.status ?? null}, status),
        notes       = COALESCE(${args.notes ?? null}, notes),
        assigned_to = COALESCE(${args.assigned_to ?? null}, assigned_to),
        due_at      = COALESCE(${args.due_at ? new Date(args.due_at) : null}, due_at),
        updated_at  = NOW()
      WHERE id = ${args.task_id} AND workspace_id = ${workspaceId}
    `;
    return JSON.stringify({ ok: true, message: `Task ${args.task_id} updated.` });
  }

  if (name === "cancel_task") {
    await sql`
      UPDATE tasks SET status = 'cancelled', notes = COALESCE(${args.reason ?? null}, notes), updated_at = NOW()
      WHERE id = ${args.task_id} AND workspace_id = ${workspaceId}
    `;
    return JSON.stringify({ ok: true, message: `Task ${args.task_id} cancelled.` });
  }

  // ── Contact management tools ─────────────────────────────────────────────────
  if (name === "create_contact") {
    const existing = await sql`SELECT id FROM contacts WHERE phone_number = ${args.phone_number}`;
    if (existing.length > 0) return JSON.stringify({ ok: false, message: `Contact with phone ${args.phone_number} already exists (id: ${existing[0].id}).` });
    const rows = await sql`
      INSERT INTO contacts (phone_number, name, email, business_name, notes)
      VALUES (${args.phone_number}, ${args.name ?? null}, ${args.email ?? null}, ${args.business_name ?? null}, ${args.notes ?? null})
      RETURNING id, name, phone_number
    `;
    return JSON.stringify({ ok: true, contact: rows[0] });
  }

  if (name === "update_contact") {
    await sql`
      UPDATE contacts SET
        name          = COALESCE(${args.name ?? null}, name),
        email         = COALESCE(${args.email ?? null}, email),
        business_name = COALESCE(${args.business_name ?? null}, business_name),
        notes         = COALESCE(${args.notes ?? null}, notes),
        do_not_call   = COALESCE(${args.do_not_call ?? null}, do_not_call)
      WHERE id = ${args.contact_id}
    `;
    return JSON.stringify({ ok: true, message: `Contact ${args.contact_id} updated.` });
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

  if (name === "make_call") {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;
    const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
    if (!accountSid || !authToken || !fromNumber) {
      return JSON.stringify({ ok: false, error: 'Twilio not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER.' });
    }
    const toNumber = args.to_number.startsWith('+') ? args.to_number : `+1${args.to_number.replace(/\D/g, '')}`;
    try {
      const client = twilio(accountSid, authToken);
      // Get active agent for the TwiML URL
      const [agent] = await sql`SELECT id FROM agent_configs WHERE workspace_id = ${workspaceId} AND is_active = TRUE ORDER BY id DESC LIMIT 1`;
      const agentId = agent?.id;
      const call = await client.calls.create({
        to: toNumber,
        from: fromNumber,
        url: `${appUrl}/api/twilio/incoming${agentId ? `?agentId=${agentId}` : ''}`,
        statusCallback: `${appUrl}/api/twilio/status`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['completed', 'failed', 'no-answer', 'busy', 'canceled'],
        machineDetection: 'Enable',
        machineDetectionTimeout: 30,
      });
      // Log a task for this outbound call
      await sql`
        INSERT INTO tasks (workspace_id, task_type, title, status, notes, priority)
        VALUES (${workspaceId}, 'outbound_call', ${`Outbound call to ${args.contact_name || toNumber}`}, 'open',
                ${args.reason || `Initiated via SMIRK chat`}, 'medium')
      `;
      return JSON.stringify({ ok: true, call_sid: call.sid, to: toNumber, status: call.status, message: `Call initiated to ${args.contact_name || toNumber} (${toNumber}). SID: ${call.sid}` });
    } catch (err: any) {
      return JSON.stringify({ ok: false, error: err.message });
    }
  }

  if (name === "book_appointment") {
    try {
      const result = await insertCalendarEvent({
        summary: args.summary,
        description: args.description,
        startIso: args.start_iso,
        endIso: args.end_iso,
        location: args.location,
        attendeeEmail: args.attendee_email,
        timeZone: args.timezone || process.env.DEFAULT_TIMEZONE || 'America/Los_Angeles',
      });
      if (result.success) {
        // Also store in appointments table
        await sql`
          INSERT INTO appointments (workspace_id, service_type, scheduled_at, notes, status, calendar_event_id)
          VALUES (${workspaceId}, ${args.summary}, ${args.start_iso ? new Date(args.start_iso) : new Date()}, ${args.description || null}, 'scheduled', ${result.eventId || null})
        `.catch(() => {}); // non-fatal if appointments table schema differs
        return JSON.stringify({ ok: true, event_id: result.eventId, link: result.htmlLink, message: `Appointment "${args.summary}" booked successfully.` });
      } else {
        return JSON.stringify({ ok: false, error: result.error || 'Calendar booking failed.' });
      }
    } catch (err: any) {
      return JSON.stringify({ ok: false, error: err.message });
    }
  }

  if (name === "create_task") {
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
  role: "user" | "assistant" | "system";
  content: string;
}

export async function handleSmirkChat(
  messages: ChatMessage[],
  workspaceId: number
): Promise<{ reply: string; toolsUsed: { name: string; result: string }[] }> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured for SMIRK Chat");

  const context = await loadChatContext(workspaceId);
  const systemInstruction = `You are SMIRK — the AI operational brain of the SMIRK phone-agent platform.
You have visibility into calls, leads, tasks, contacts, and team state.
You can take REAL action: make phone calls via Twilio, book appointments in Google Calendar, create tasks, search contacts, update settings, edit agent prompts, and inject briefings.

When the user asks you to call someone, dial a number, book an appointment, or create a task — DO IT using the available tools. Do not describe what you would do. Execute it.
If you need a phone number for a contact name, use search_contacts first, then make_call with the result.
Always confirm what action was taken and provide the outcome (call SID, event link, task ID, etc.).

--- LIVE CONTEXT ---
${context}
--- END CONTEXT ---`;

  const currentContents: any[] = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));

  const toolsUsed: { name: string; result: string }[] = [];
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
        const result = await executeTool(name, args, workspaceId);
        toolsUsed.push({ name, result });
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
