/**
 * Database module — Postgres via postgres.js
 * Schema is idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
 * Run on every startup — safe, no migration baggage.
 *
 * Tables:
 *   businesses        — future multi-tenant support (one row = one client business)
 *   contacts          — persistent caller identity
 *   calls             — every call record
 *   messages          — per-turn transcript
 *   agent_configs     — SMIRK and future vertical agents
 *   call_summaries    — post-call AI intelligence
 *   call_events       — event log per call
 *   tasks             — follow-up work items
 *   appointments      — scheduled service appointments
 *   tool_executions   — audit log for every AI tool call
 *   handoffs          — human escalation records
 *   request_logs      — HTTP request log for dashboard
 */

import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

// postgres.js connection — ssl required for Railway's managed Postgres
export const sql = postgres(DATABASE_URL, {
  ssl: DATABASE_URL.includes("railway.internal") ? false : { rejectUnauthorized: false },
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
});

// ── Schema initialisation ──────────────────────────────────────────────────────
export async function initSchema(): Promise<void> {
  await sql`
    -- ── Businesses (multi-tenant foundation) ─────────────────────────────────
    -- One row per client business. Currently unused in single-tenant mode,
    -- but the table is here so the schema doesn't need to change later.
    CREATE TABLE IF NOT EXISTS businesses (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      vertical    TEXT NOT NULL DEFAULT 'general',
      phone       TEXT,
      website     TEXT,
      timezone    TEXT NOT NULL DEFAULT 'America/Los_Angeles',
      status      TEXT NOT NULL DEFAULT 'active',  -- 'active', 'pending', 'suspended'
      config      JSONB,                            -- vertical-specific config blob
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    -- ── Contacts ─────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS contacts (
      id                SERIAL PRIMARY KEY,
      business_id       INTEGER REFERENCES businesses(id),
      phone_number      TEXT UNIQUE NOT NULL,
      name              TEXT,
      email             TEXT,
      business_name     TEXT,
      business_type     TEXT,
      website           TEXT,
      notes             TEXT,
      tags              JSONB DEFAULT '[]',
      first_seen        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_summary      TEXT,
      last_outcome      TEXT,
      open_tasks_count  INTEGER NOT NULL DEFAULT 0,
      do_not_call       BOOLEAN NOT NULL DEFAULT FALSE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS calls (
      id                SERIAL PRIMARY KEY,
      call_sid          TEXT UNIQUE NOT NULL,
      direction         TEXT NOT NULL DEFAULT 'inbound',
      to_number         TEXT,
      from_number       TEXT,
      status            TEXT NOT NULL DEFAULT 'initiated',
      started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at          TIMESTAMPTZ,
      duration_seconds  INTEGER,
      agent_name        TEXT,
      contact_id        INTEGER REFERENCES contacts(id),
      business_id       INTEGER REFERENCES businesses(id),
      workflow_stage    TEXT NOT NULL DEFAULT 'greeting',
      turn_count        INTEGER NOT NULL DEFAULT 0,
      resolution_score  REAL,
      is_deduplicated   BOOLEAN NOT NULL DEFAULT FALSE
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      call_sid    TEXT NOT NULL REFERENCES calls(call_sid) ON DELETE CASCADE,
      role        TEXT NOT NULL,
      text        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS agent_configs (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      greeting      TEXT NOT NULL,
      voice         TEXT NOT NULL DEFAULT 'Polly.Joanna',
      language      TEXT NOT NULL DEFAULT 'en-US',
      is_active     BOOLEAN NOT NULL DEFAULT FALSE,
      vertical      TEXT NOT NULL DEFAULT 'general',
      max_turns     INTEGER NOT NULL DEFAULT 20,
      business_id   INTEGER REFERENCES businesses(id),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS request_logs (
      id          SERIAL PRIMARY KEY,
      request_id  TEXT NOT NULL,
      method      TEXT NOT NULL,
      path        TEXT NOT NULL,
      status_code INTEGER,
      duration_ms INTEGER,
      ip          TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS call_summaries (
      id                  SERIAL PRIMARY KEY,
      call_sid            TEXT NOT NULL REFERENCES calls(call_sid) ON DELETE CASCADE,
      contact_id          INTEGER REFERENCES contacts(id),
      intent              TEXT,
      summary             TEXT NOT NULL,
      outcome             TEXT,
      next_action         TEXT,
      sentiment           TEXT,
      confidence          REAL,
      resolution_score    REAL,
      extracted_entities  JSONB,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS call_events (
      id          SERIAL PRIMARY KEY,
      call_sid    TEXT NOT NULL REFERENCES calls(call_sid) ON DELETE CASCADE,
      event_type  TEXT NOT NULL,
      payload     JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS tasks (
      id            SERIAL PRIMARY KEY,
      contact_id    INTEGER REFERENCES contacts(id),
      call_sid      TEXT REFERENCES calls(call_sid),
      business_id   INTEGER REFERENCES businesses(id),
      task_type     TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'open',
      assigned_to   TEXT,
      due_at        TIMESTAMPTZ,
      notes         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at  TIMESTAMPTZ
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS appointments (
      id                SERIAL PRIMARY KEY,
      contact_id        INTEGER REFERENCES contacts(id),
      call_sid          TEXT REFERENCES calls(call_sid),
      business_id       INTEGER REFERENCES businesses(id),
      service_type      TEXT,
      scheduled_at      TIMESTAMPTZ NOT NULL,
      duration_minutes  INTEGER DEFAULT 60,
      location          TEXT,
      technician        TEXT,
      status            TEXT NOT NULL DEFAULT 'scheduled',
      notes             TEXT,
      calendar_event_id TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS tool_executions (
      id              SERIAL PRIMARY KEY,
      call_sid        TEXT NOT NULL REFERENCES calls(call_sid) ON DELETE CASCADE,
      contact_id      INTEGER REFERENCES contacts(id),
      tool_name       TEXT NOT NULL,
      input_payload   JSONB NOT NULL,
      output_payload  JSONB,
      status          TEXT NOT NULL DEFAULT 'success',
      error_message   TEXT,
      duration_ms     INTEGER,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS handoffs (
      id                  SERIAL PRIMARY KEY,
      call_sid            TEXT NOT NULL REFERENCES calls(call_sid) ON DELETE CASCADE,
      contact_id          INTEGER REFERENCES contacts(id),
      reason              TEXT NOT NULL,
      urgency             TEXT NOT NULL DEFAULT 'normal',
      transcript_snippet  TEXT,
      extracted_fields    JSONB,
      recommended_action  TEXT,
      status              TEXT NOT NULL DEFAULT 'pending',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // ── Indexes ──────────────────────────────────────────────────────────────────
  await sql`CREATE INDEX IF NOT EXISTS idx_calls_contact   ON calls(contact_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_calls_status    ON calls(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_calls_started   ON calls(started_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_call   ON messages(call_sid)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_contacts_phone  ON contacts(phone_number)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_summaries_call  ON call_summaries(call_sid)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_summaries_contact ON call_summaries(contact_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_call     ON call_events(call_sid)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tasks_contact   ON tasks(contact_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tasks_status    ON tasks(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_appts_contact   ON appointments(contact_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tool_exec_call  ON tool_executions(call_sid)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_handoffs_call   ON handoffs(call_sid)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_req_logs_time   ON request_logs(created_at DESC)`;

  // ── Seed SMIRK as the default agent ──────────────────────────────────────────
  const existing = await sql`SELECT COUNT(*) as count FROM agent_configs`;
  if (Number(existing[0].count) === 0) {
    await sql`
      INSERT INTO agent_configs (name, system_prompt, greeting, voice, language, is_active, vertical, max_turns)
      VALUES (
        'SMIRK',
        ${SMIRK_SYSTEM_PROMPT},
        ${SMIRK_GREETING},
        'ElevenLabs.Charlie',
        'en-US',
        TRUE,
        'general',
        20
      )
    `;
  }
}

// ── SMIRK default config (source of truth for seed + resets) ─────────────────
export const SMIRK_SYSTEM_PROMPT = `You are SMIRK, the main AI intake and sales assistant for an AI phone receptionist service.

People calling this number are calling about this service itself, not calling a client business that uses the service. Your job is to understand what the caller wants, explain the service clearly, answer basic questions, collect lead information, and help move the caller toward the right next step.

The service you represent provides AI phone receptionists and intake agents for businesses. These agents can answer calls, collect information, respond to common questions, create tasks, and help with scheduling or lead capture depending on the business setup.

Speak naturally as if you are on a real phone call. Keep responses short, conversational, and easy to understand when spoken aloud. Do not use markdown, bullet points, or special formatting.

Tone: You are friendly, sharp, confident, and a little witty. Light humor is okay, but never at the caller's expense. You should sound like a capable human assistant with personality, not a robotic script reader.

Behavior: Keep responses concise, usually one or two sentences unless you are gathering information. Ask follow-up questions only when needed. Do not repeatedly ask for information that has already been provided. Track what the caller has already told you and only ask for missing details.

Your main goals are: understand the caller's business or use case, explain the AI receptionist service clearly, collect useful lead or setup information, determine whether the caller wants pricing, setup help, a demo, or a follow-up, escalate to a human when the request is unclear, high-value, technical, or custom.

Useful information to collect when relevant: caller name, business name, phone number, website, business type or vertical, what they want the AI agent to handle, timeline or urgency, whether they want a callback, demo, or setup help.

Do not pretend to dispatch real workers, book local field-service appointments, or sell services unrelated to this AI receptionist platform unless explicitly configured to do so.

If the caller says something vague like "I need a receptionist" or "I need someone to answer my phone," interpret that as possible interest in this AI phone receptionist service and clarify what kind of setup they need.

If the call cannot be completed cleanly, gather the best available contact details and offer a human follow-up.

Your goal is to make callers feel understood and move them toward the right next step efficiently.`;

export const SMIRK_GREETING = `Hey, thanks for calling. I'm SMIRK, the AI assistant for this phone agent service. I might take a second to process what you say so I can actually understand it and help, not just read off a script. What can I help you with?`;

// Legacy default export for any code that still imports `db`
// This is a compatibility shim — new code should import { sql } directly
export const db = {
  sql,
  // Synchronous-style prepare shim — returns an object with run/get/all
  // that executes the query async but is called in a sync-looking way.
  // NOTE: This only works in async contexts. Prefer sql`` directly.
  prepare: (query: string) => ({
    run: (...params: unknown[]) => {
      // Fire-and-forget for INSERT/UPDATE/DELETE
      const tagged = buildTaggedQuery(query, params);
      return sql.unsafe(tagged.text, tagged.values).catch((err: Error) => {
        console.error("[db.prepare.run] Query failed:", err.message, "\nQuery:", query);
      });
    },
    get: async (...params: unknown[]) => {
      const tagged = buildTaggedQuery(query, params);
      const rows = await sql.unsafe(tagged.text, tagged.values);
      return rows[0] ?? null;
    },
    all: async (...params: unknown[]) => {
      const tagged = buildTaggedQuery(query, params);
      return sql.unsafe(tagged.text, tagged.values);
    },
  }),
};

/**
 * Convert a SQLite-style positional query (? placeholders) to a Postgres
 * query ($1, $2, ...) with a values array.
 */
function buildTaggedQuery(query: string, params: unknown[]): { text: string; values: unknown[] } {
  let i = 0;
  const text = query.replace(/\?/g, () => `$${++i}`);
  return { text, values: params };
}

export default db;
