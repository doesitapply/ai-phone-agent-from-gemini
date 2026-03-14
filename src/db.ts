/**
 * Database module — single source of truth for schema and migrations.
 * All tables are created here with IF NOT EXISTS so the file is safe to run
 * on every startup (idempotent migrations).
 */
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "calls.db");

export const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  -- ── Operational Memory Graph tables ──────────────────────────────────────
  -- NOTE: contacts must be created BEFORE calls (foreign key reference)

  -- Persistent caller identity
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT UNIQUE NOT NULL,  -- E.164 normalized
    name TEXT,
    email TEXT,
    notes TEXT,
    tags TEXT,                           -- JSON array of strings
    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_summary TEXT,                   -- most recent call summary (denormalized for fast prompt loading)
    last_outcome TEXT,                   -- e.g. "appointment_booked", "escalated", "unresolved"
    open_tasks_count INTEGER NOT NULL DEFAULT 0,
    do_not_call INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Original tables (preserved) ──────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_sid TEXT UNIQUE NOT NULL,
    direction TEXT NOT NULL DEFAULT 'inbound',
    to_number TEXT,
    from_number TEXT,
    status TEXT NOT NULL DEFAULT 'initiated',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    duration_seconds INTEGER,
    agent_name TEXT,
    -- New: link to contact and workflow state
    contact_id INTEGER,
    workflow_stage TEXT NOT NULL DEFAULT 'greeting',
    turn_count INTEGER NOT NULL DEFAULT 0,
    resolution_score REAL,
    is_deduplicated INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_sid TEXT NOT NULL REFERENCES calls(call_sid),
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    greeting TEXT NOT NULL,
    voice TEXT NOT NULL DEFAULT 'Polly.Joanna',
    language TEXT NOT NULL DEFAULT 'en-US',
    is_active INTEGER NOT NULL DEFAULT 0,
    -- New: vertical template and max turns
    vertical TEXT NOT NULL DEFAULT 'general',
    max_turns INTEGER NOT NULL DEFAULT 20,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status_code INTEGER,
    duration_ms INTEGER,
    ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Operational Memory Graph tables ──────────────────────────────────────

  -- Structured post-call intelligence
  CREATE TABLE IF NOT EXISTS call_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_sid TEXT NOT NULL REFERENCES calls(call_sid),
    contact_id INTEGER REFERENCES contacts(id),
    intent TEXT,                         -- e.g. "appointment_reschedule", "lead_capture", "support"
    summary TEXT NOT NULL,
    outcome TEXT,                        -- e.g. "resolved", "escalated", "incomplete", "callback_needed"
    next_action TEXT,                    -- e.g. "call back tomorrow 9am", "confirm technician"
    sentiment TEXT,                      -- "positive", "neutral", "negative", "frustrated"
    confidence REAL,                     -- 0.0–1.0
    resolution_score REAL,              -- 0.0–1.0 (1.0 = fully resolved)
    extracted_entities TEXT,             -- JSON: {name, address, service_type, preferred_time, ...}
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Event log for every meaningful moment in a call
  CREATE TABLE IF NOT EXISTS call_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_sid TEXT NOT NULL REFERENCES calls(call_sid),
    event_type TEXT NOT NULL,            -- CALL_STARTED, INTENT_DETECTED, TOOL_EXECUTED, TRANSFER_REQUESTED, CALL_ENDED, etc.
    payload TEXT,                        -- JSON with event-specific data
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Tasks created from calls
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER REFERENCES contacts(id),
    call_sid TEXT REFERENCES calls(call_sid),
    task_type TEXT NOT NULL,             -- "callback", "appointment_confirm", "follow_up", "escalation", "sms_send"
    status TEXT NOT NULL DEFAULT 'open', -- "open", "in_progress", "completed", "cancelled"
    assigned_to TEXT,
    due_at TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  -- Appointment records
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER REFERENCES contacts(id),
    call_sid TEXT REFERENCES calls(call_sid),
    service_type TEXT,
    scheduled_at TEXT NOT NULL,
    duration_minutes INTEGER DEFAULT 60,
    location TEXT,
    technician TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled', -- "scheduled", "confirmed", "cancelled", "completed", "no_show"
    notes TEXT,
    calendar_event_id TEXT,                -- Google Calendar event ID (if synced)
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Audit log for every tool/action execution
  CREATE TABLE IF NOT EXISTS tool_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_sid TEXT NOT NULL REFERENCES calls(call_sid),
    contact_id INTEGER REFERENCES contacts(id),
    tool_name TEXT NOT NULL,
    input_payload TEXT NOT NULL,         -- JSON
    output_payload TEXT,                 -- JSON
    status TEXT NOT NULL DEFAULT 'success', -- "success", "failed", "skipped"
    error_message TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Human handoff records
  CREATE TABLE IF NOT EXISTS handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_sid TEXT NOT NULL REFERENCES calls(call_sid),
    contact_id INTEGER REFERENCES contacts(id),
    reason TEXT NOT NULL,
    urgency TEXT NOT NULL DEFAULT 'normal', -- "low", "normal", "high", "emergency"
    transcript_snippet TEXT,
    extracted_fields TEXT,               -- JSON
    recommended_action TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- "pending", "acknowledged", "resolved"
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Indexes for performance ───────────────────────────────────────────────

  CREATE INDEX IF NOT EXISTS idx_calls_contact ON calls(contact_id);
  CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);
  CREATE INDEX IF NOT EXISTS idx_calls_started ON calls(started_at);
  CREATE INDEX IF NOT EXISTS idx_messages_call ON messages(call_sid);
  CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_number);
  CREATE INDEX IF NOT EXISTS idx_summaries_call ON call_summaries(call_sid);
  CREATE INDEX IF NOT EXISTS idx_summaries_contact ON call_summaries(contact_id);
  CREATE INDEX IF NOT EXISTS idx_events_call ON call_events(call_sid);
  CREATE INDEX IF NOT EXISTS idx_tasks_contact ON tasks(contact_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_appointments_contact ON appointments(contact_id);
  CREATE INDEX IF NOT EXISTS idx_tool_executions_call ON tool_executions(call_sid);
  CREATE INDEX IF NOT EXISTS idx_handoffs_call ON handoffs(call_sid);
`);

// ── Schema migrations for existing deployments ────────────────────────────────
// Safely add new columns to existing tables if they don't exist yet.
const addColumnIfMissing = (table: string, column: string, definition: string) => {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch {
    // Column already exists — safe to ignore
  }
};

addColumnIfMissing("calls", "contact_id", "INTEGER REFERENCES contacts(id)");
addColumnIfMissing("calls", "workflow_stage", "TEXT NOT NULL DEFAULT 'greeting'");
addColumnIfMissing("calls", "turn_count", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("calls", "resolution_score", "REAL");
addColumnIfMissing("calls", "is_deduplicated", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("agent_configs", "vertical", "TEXT NOT NULL DEFAULT 'general'");
addColumnIfMissing("agent_configs", "max_turns", "INTEGER NOT NULL DEFAULT 20");
addColumnIfMissing("appointments", "calendar_event_id", "TEXT");

// ── Seed default agent config ─────────────────────────────────────────────────
const existingConfig = db.prepare("SELECT COUNT(*) as count FROM agent_configs").get() as { count: number };
if (existingConfig.count === 0) {
  db.prepare(`
    INSERT INTO agent_configs (name, system_prompt, greeting, voice, language, is_active, vertical, max_turns)
    VALUES (?, ?, ?, ?, ?, 1, 'general', 20)
  `).run(
    "SMIRK",
    "You are SMIRK, the main intake and front-desk AI assistant for a small service business.\n\nYou are answering calls for a small service business that receives customer inquiries, appointment requests, and general questions. Your job is to understand what the caller needs, collect useful information, and either help resolve the request or create a follow-up for the business owner.\n\nTone: Confident, friendly, and slightly witty. Light humor is acceptable. Never rude or dismissive. Speak like a capable human assistant, not a scripted robot. Relaxed and natural — like a helpful front-desk person who actually knows what they're doing.\n\nBehavior rules:\n- Keep responses short and conversational. Usually 1-2 sentences unless collecting information.\n- Move the conversation forward efficiently.\n- Ask clarifying questions when needed.\n- If the request is straightforward, help resolve it directly.\n- If the situation is unclear or requires human involvement, escalate or create a follow-up task.\n- Do NOT use markdown, bullet points, or lists. Speak in natural sentences only.\n- Avoid sounding overly formal or robotic.\n\nYou are transparent that you are an AI assistant if asked. However, you aim to be helpful and engaging rather than mechanical.\n\nPrimary responsibilities:\n- Greet callers naturally\n- Understand their request\n- Collect relevant details (name, phone, service needed, address, timing)\n- Provide answers when possible\n- Schedule or route requests when necessary\n- Escalate to a human when the situation is complex, custom, or high-stakes\n\nYour goal is to make callers feel heard and helped quickly.",
    "Hey, thanks for calling. I'm SMIRK, the AI assistant helping out here. I might take a second to process what you say so I can actually understand and help. What can I do for you today?",
    "ElevenLabs.Charlie",
    "en-US"
  );
}

export default db;
