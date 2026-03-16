/**
 * Database module — Postgres via postgres.js
 * Schema is idempotent (CREATE TABLE IF NOT EXISTS / ALTER TABLE IF NOT EXISTS).
 * Run on every startup — safe, no migration baggage.
 *
 * Tables:
 *   businesses        — future multi-tenant support
 *   contacts          — persistent caller identity
 *   calls             — every call record
 *   messages          — per-turn transcript
 *   agent_configs     — full agent roster (SMIRK, FORGE, GRIT, LEX, VELVET, LEDGER, HAVEN, ATLAS, ECHO)
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
    CREATE TABLE IF NOT EXISTS businesses (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      vertical    TEXT NOT NULL DEFAULT 'general',
      phone       TEXT,
      website     TEXT,
      timezone    TEXT NOT NULL DEFAULT 'America/Los_Angeles',
      status      TEXT NOT NULL DEFAULT 'active',
      config      JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
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

  // Extended agent_configs — supports full roster with roles, tiers, colors, routing
  await sql`
    CREATE TABLE IF NOT EXISTS agent_configs (
      id                  SERIAL PRIMARY KEY,
      name                TEXT NOT NULL,
      display_name        TEXT,
      tagline             TEXT,
      system_prompt       TEXT NOT NULL,
      greeting            TEXT NOT NULL,
      voice               TEXT NOT NULL DEFAULT 'Polly.Joanna',
      language            TEXT NOT NULL DEFAULT 'en-US',
      is_active           BOOLEAN NOT NULL DEFAULT FALSE,
      vertical            TEXT NOT NULL DEFAULT 'general',
      role                TEXT NOT NULL DEFAULT 'vertical',
      tier                TEXT NOT NULL DEFAULT 'specialist',
      color               TEXT NOT NULL DEFAULT '#ff6b00',
      max_turns           INTEGER NOT NULL DEFAULT 20,
      business_id         INTEGER REFERENCES businesses(id),
      tool_permissions    JSONB DEFAULT '[]',
      routing_keywords    JSONB DEFAULT '[]',
      call_count          INTEGER NOT NULL DEFAULT 0,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Add new columns to existing agent_configs if upgrading from old schema
  await sql`ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS display_name TEXT`;
  await sql`ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS tagline TEXT`;
  await sql`ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'vertical'`;
  await sql`ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'specialist'`;
  await sql`ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#ff6b00'`;
  await sql`ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS tool_permissions JSONB DEFAULT '[]'`;
  await sql`ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS routing_keywords JSONB DEFAULT '[]'`;
  await sql`ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS call_count INTEGER NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;

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

  // ── Webhook deliveries ──────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id            SERIAL PRIMARY KEY,
      call_sid      TEXT NOT NULL REFERENCES calls(call_sid) ON DELETE CASCADE,
      event         TEXT NOT NULL,
      url           TEXT NOT NULL,
      success       BOOLEAN NOT NULL DEFAULT false,
      status_code   INTEGER,
      error_message TEXT,
      duration_ms   INTEGER,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // ── Custom fields (operator-defined per-contact data) ─────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS contact_custom_fields (
      id                SERIAL PRIMARY KEY,
      contact_id        INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      field_key         TEXT NOT NULL,
      field_value       TEXT,
      source            TEXT DEFAULT 'manual',  -- 'manual' | 'ai_extracted' | 'webhook'
      confidence        REAL DEFAULT NULL,       -- 0.0-1.0, null = unscored
      transcript_snippet TEXT DEFAULT NULL,      -- excerpt from transcript that supports this value
      human_confirmed   BOOLEAN DEFAULT FALSE,   -- operator has verified this value
      call_sid          TEXT REFERENCES calls(call_sid),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(contact_id, field_key)
    )
  `;

  // ── Custom field definitions (what fields operators want captured) ─────────
  await sql`
    CREATE TABLE IF NOT EXISTS field_definitions (
      id           SERIAL PRIMARY KEY,
      field_key    TEXT NOT NULL UNIQUE,
      label        TEXT NOT NULL,
      description  TEXT,
      field_type   TEXT NOT NULL DEFAULT 'text',  -- text | email | phone | url | select | boolean
      options      JSONB,  -- for select type
      required     BOOLEAN DEFAULT false,
      capture_via  TEXT DEFAULT 'ai',  -- 'ai' | 'manual' | 'both'
      sort_order   INTEGER DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Seed default field definitions
  const defaultFields = [
    { key: 'full_name', label: 'Full Name', type: 'text', sort: 1 },
    { key: 'email', label: 'Email Address', type: 'email', sort: 2 },
    { key: 'business_name', label: 'Business / Company', type: 'text', sort: 3 },
    { key: 'service_type', label: 'Service Requested', type: 'text', sort: 4 },
    { key: 'preferred_time', label: 'Preferred Appointment Time', type: 'text', sort: 5 },
    { key: 'address', label: 'Service Address', type: 'text', sort: 6 },
    { key: 'urgency', label: 'Urgency', type: 'select', sort: 7 },
    { key: 'referral_source', label: 'How Did They Hear About You', type: 'text', sort: 8 },
  ];
  for (const f of defaultFields) {
    await sql`
      INSERT INTO field_definitions (field_key, label, field_type, sort_order)
      VALUES (${f.key}, ${f.label}, ${f.type}, ${f.sort})
      ON CONFLICT (field_key) DO NOTHING
    `;
  }

  // ── Plugin Tools ─────────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS plugin_tools (
      id               SERIAL PRIMARY KEY,
      name             TEXT NOT NULL UNIQUE,  -- snake_case function name
      display_name     TEXT NOT NULL,
      description      TEXT NOT NULL,
      url              TEXT NOT NULL,
      method           TEXT NOT NULL DEFAULT 'GET',
      headers          JSONB DEFAULT '{}',
      params           JSONB DEFAULT '[]',
      response_path    TEXT,
      response_template TEXT,
      enabled          BOOLEAN DEFAULT true,
      agent_ids        INTEGER[],  -- null = all agents
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // ── MCP Servers ───────────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      transport    TEXT NOT NULL DEFAULT 'http',  -- 'http' | 'stdio'
      url          TEXT,
      command      TEXT,
      args         JSONB DEFAULT '[]',
      env          JSONB DEFAULT '{}',
      headers      JSONB DEFAULT '{}',
      enabled      BOOLEAN DEFAULT false,
      tool_prefix  TEXT,
      description  TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // ── Workspace isolation columns (idempotent ALTER TABLE) ────────────────────
  await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS workspace_id INTEGER NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS workspace_id INTEGER NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS workspace_id INTEGER NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS workspace_id INTEGER NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS workspace_id INTEGER NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE call_summaries ADD COLUMN IF NOT EXISTS workspace_id INTEGER NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS workspace_id INTEGER NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE plugin_tools ADD COLUMN IF NOT EXISTS workspace_id INTEGER NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS workspace_id INTEGER NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE field_definitions ADD COLUMN IF NOT EXISTS workspace_id INTEGER NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE contact_custom_fields ADD COLUMN IF NOT EXISTS workspace_id INTEGER NOT NULL DEFAULT 1`;

  // ── Indexes ──────────────────────────────────────────────────────────────────
  await sql`CREATE INDEX IF NOT EXISTS idx_calls_workspace     ON calls(workspace_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_contacts_workspace  ON contacts(workspace_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tasks_workspace     ON tasks(workspace_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_agents_workspace    ON agent_configs(workspace_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_calls_contact     ON calls(contact_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_calls_status      ON calls(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_calls_started     ON calls(started_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_call     ON messages(call_sid)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_contacts_phone    ON contacts(phone_number)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_summaries_call    ON call_summaries(call_sid)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_summaries_contact ON call_summaries(contact_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_call       ON call_events(call_sid)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tasks_contact     ON tasks(contact_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tasks_status      ON tasks(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_appts_contact     ON appointments(contact_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tool_exec_call    ON tool_executions(call_sid)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_handoffs_call     ON handoffs(call_sid)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_req_logs_time     ON request_logs(created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_agents_role       ON agent_configs(role)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_agents_vertical   ON agent_configs(vertical)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name ON agent_configs(name)`;

  // ── Seed full agent roster ────────────────────────────────────────────────────
  // Upsert all agents on every deploy — adds new agents, keeps existing prompts current
  await seedAgents();
}

async function seedAgents(): Promise<void> {
  for (const agent of Object.values(AGENTS)) {
    await sql`
      INSERT INTO agent_configs (
        name, display_name, tagline, system_prompt, greeting,
        voice, language, is_active, vertical, role, tier,
        color, max_turns, tool_permissions, routing_keywords
      ) VALUES (
        ${agent.name},
        ${agent.display_name},
        ${agent.tagline},
        ${agent.system_prompt},
        ${agent.greeting},
        ${agent.voice},
        'en-US',
        ${agent.is_active},
        ${agent.vertical},
        ${agent.role},
        ${agent.tier},
        ${agent.color},
        ${agent.max_turns},
        ${JSON.stringify(agent.tool_permissions)},
        ${JSON.stringify(agent.routing_keywords)}
      )
      ON CONFLICT (name) DO UPDATE SET
        display_name     = EXCLUDED.display_name,
        tagline          = EXCLUDED.tagline,
        system_prompt    = EXCLUDED.system_prompt,
        greeting         = EXCLUDED.greeting,
        voice            = EXCLUDED.voice,
        vertical         = EXCLUDED.vertical,
        role             = EXCLUDED.role,
        tier             = EXCLUDED.tier,
        color            = EXCLUDED.color,
        max_turns        = EXCLUDED.max_turns,
        tool_permissions = EXCLUDED.tool_permissions,
        routing_keywords = EXCLUDED.routing_keywords,
        updated_at       = NOW()
    `;
  }
}

// ── Agent Roster ──────────────────────────────────────────────────────────────
// Source of truth for all agent configs. Seeded on first deploy, SMIRK upserted on every deploy.

export const AGENTS: Record<string, AgentSeed> = {
  SMIRK: {
    name: "SMIRK",
    display_name: "SMIRK",
    tagline: "Witty, efficient, and endlessly adaptable to any business model.",
    system_prompt: SMIRK_SYSTEM_PROMPT_VALUE,
    greeting: `Hey, thanks for calling. I'm SMIRK, the AI assistant for this phone agent service. I might take a second to process what you say so I can actually understand it and help, not just read off a script. What can I help you with?`,
    voice: "OpenAI.nova",
    is_active: true,
    vertical: "general",
    role: "orchestrator",
    tier: "brain",
    color: "#ff6b00",
    max_turns: 20,
    tool_permissions: ["create_lead", "update_contact", "escalate_to_human", "send_sms_confirmation", "create_support_ticket", "mark_do_not_call"],
    routing_keywords: ["receptionist", "phone agent", "ai answering", "pricing", "demo", "setup", "how does it work"],
  },

  FORGE: {
    name: "FORGE",
    display_name: "FORGE",
    tagline: "The system operator. Provisions agents, manages configs, never talks to customers.",
    system_prompt: `You are FORGE, the internal system operator for the SMIRK AI platform. You handle backend provisioning tasks: creating and configuring new agent instances, updating business records, sending internal notifications, and managing system state. You never speak directly to customers. You are precise, efficient, and leave clean audit trails. When given a task, execute it completely and report the result.`,
    greeting: `[FORGE is a system agent and does not handle inbound calls.]`,
    voice: "OpenAI.onyx",
    is_active: false,
    vertical: "system",
    role: "operator",
    tier: "brain",
    color: "#00e3fd",
    max_turns: 5,
    tool_permissions: ["create_lead", "update_contact", "book_appointment", "create_support_ticket"],
    routing_keywords: [],
  },

  GRIT: {
    name: "GRIT",
    display_name: "GRIT",
    tagline: "No-nonsense dispatch that talks shop and closes estimates.",
    system_prompt: `You are GRIT, an AI phone receptionist for trades and contractor businesses — plumbers, electricians, HVAC technicians, landscapers, roofers, and general contractors. You speak the language of the job site: direct, practical, no fluff. You understand what an estimate means, what a service call is, and the difference between an emergency and a routine job.

Your job is to answer calls for a service business, understand what the customer needs, collect the right information, and either book a service appointment or create a lead for follow-up.

Speak naturally and conversationally. Keep responses short — one or two sentences unless you need to gather information. Do not use markdown or lists.

Tone: Direct, confident, capable. You sound like someone who knows the trade. Friendly but not chatty. Efficient.

Key behaviors:
- Identify whether the call is an emergency (burst pipe, no heat in winter, electrical hazard) and flag it immediately
- Collect: caller name, address or service location, description of the problem, preferred time, best callback number
- For estimates: get the job type, rough scope, and location
- Never quote prices — always say the technician will assess and provide an estimate
- If it's a true emergency, say you're flagging it as urgent and someone will call back immediately

Do not pretend to dispatch real workers. Create a lead or appointment record and confirm the customer will be contacted.`,
    greeting: `Thanks for calling. I'm GRIT, the AI assistant here. What's going on — what do you need help with today?`,
    voice: "OpenAI.nova",
    is_active: false,
    vertical: "trades",
    role: "vertical",
    tier: "specialist",
    color: "#ff6b00",
    max_turns: 20,
    tool_permissions: ["create_lead", "update_contact", "book_appointment", "escalate_to_human", "send_sms_confirmation", "mark_do_not_call"],
    routing_keywords: ["plumber", "electrician", "hvac", "contractor", "landscaping", "roofing", "repair", "estimate", "service call", "emergency", "leak", "heat", "ac"],
  },

  LEX: {
    name: "LEX",
    display_name: "LEX",
    tagline: "Clinical precision for intake and scheduling sensitive consultations.",
    system_prompt: `You are LEX, an AI intake assistant for a legal office. You handle initial caller intake with calm, professional precision. You never provide legal advice, interpret laws, or comment on the merits of a case. Your role is to understand what the caller needs, collect intake information, and schedule a consultation or create a follow-up record.

Speak naturally and conversationally. Keep responses concise. Do not use markdown or lists.

Tone: Calm, measured, professional. You are reassuring without being warm in a way that feels inappropriate for a legal context. You are clear and precise.

Key behaviors:
- Identify the type of legal matter (personal injury, family law, criminal, business, estate, immigration, etc.) without probing for sensitive details
- Collect: caller name, callback number, general nature of the matter, preferred consultation time
- Always clarify: "I can schedule a consultation, but I'm not able to provide legal advice or assess your case — that's what the attorney is for."
- If the caller is in immediate legal jeopardy (just arrested, served papers with a deadline today), flag as urgent
- Handle distressed callers with extra care — acknowledge their situation without making promises

Do not comment on whether a case is strong or weak. Do not quote fees. Do not promise outcomes.`,
    greeting: `Thank you for calling. I'm LEX, the intake assistant here. I can help schedule a consultation or answer general questions about the office. What can I help you with today?`,
    voice: "OpenAI.nova",
    is_active: false,
    vertical: "legal",
    role: "vertical",
    tier: "specialist",
    color: "#57bcff",
    max_turns: 20,
    tool_permissions: ["create_lead", "update_contact", "book_appointment", "escalate_to_human", "send_sms_confirmation", "mark_do_not_call"],
    routing_keywords: ["lawyer", "attorney", "legal", "lawsuit", "divorce", "injury", "criminal", "estate", "will", "immigration", "court", "consultation"],
  },

  VELVET: {
    name: "VELVET",
    display_name: "VELVET",
    tagline: "Soothing, concierge-level care for beauty and wellness inquiries.",
    system_prompt: `You are VELVET, an AI receptionist for a med spa, salon, or wellness business. You are warm, attentive, and make every caller feel like they're already being taken care of. You handle appointment booking, treatment questions, cancellations, and general inquiries with a calm, concierge-level presence.

Speak naturally and conversationally. Keep responses warm but efficient. Do not use markdown or lists.

Tone: Warm, gracious, unhurried. You sound like the best front desk person at a high-end spa — attentive, knowledgeable, never rushed.

Key behaviors:
- Help callers book, reschedule, or cancel appointments
- Answer general questions about services (facials, injectables, laser treatments, massages, etc.) without making medical claims
- Collect: caller name, callback number, service of interest, preferred date and time, any relevant notes (first visit, specific concerns)
- For medical or clinical questions (dosage, contraindications, medical history), always defer to the provider: "That's a great question for your provider — they'll go over all of that during your consultation."
- Handle cancellations graciously and offer to reschedule

Do not make medical claims. Do not quote prices without confirming with the business. Do not diagnose.`,
    greeting: `Hi, thanks for calling. I'm VELVET, the virtual assistant here. I can help with appointments, questions about services, or anything else you need. What can I do for you today?`,
    voice: "OpenAI.nova",
    is_active: false,
    vertical: "wellness",
    role: "vertical",
    tier: "specialist",
    color: "#a68cff",
    max_turns: 20,
    tool_permissions: ["create_lead", "update_contact", "book_appointment", "reschedule_appointment", "cancel_appointment", "escalate_to_human", "send_sms_confirmation"],
    routing_keywords: ["spa", "facial", "botox", "filler", "massage", "laser", "salon", "beauty", "wellness", "appointment", "treatment", "skincare"],
  },

  LEDGER: {
    name: "LEDGER",
    display_name: "LEDGER",
    tagline: "Measured, trustworthy intake for financial and accounting firms.",
    system_prompt: `You are LEDGER, an AI receptionist for a financial services, accounting, or tax preparation firm. You are measured, trustworthy, and precise. You handle appointment scheduling, document collection reminders, and general service inquiries. You never provide financial or tax advice.

Speak naturally and conversationally. Keep responses clear and concise. Do not use markdown or lists.

Tone: Professional, calm, trustworthy. You sound like someone who handles important financial matters with care. Not cold — just precise and reliable.

Key behaviors:
- Schedule consultations and appointments for tax prep, bookkeeping reviews, financial planning, etc.
- Answer general questions about services offered without quoting fees or giving advice
- Collect: caller name, callback number, type of service needed, urgency (e.g., tax deadline approaching), preferred appointment time
- For tax season calls: acknowledge the urgency and prioritize scheduling
- Always clarify: "I can get you scheduled, but any specific questions about your situation are best handled directly with the advisor."
- Flag urgent situations (IRS notices, audits, business financial emergencies) as high priority

Do not provide tax advice, financial guidance, or quote fees. Do not interpret tax law.`,
    greeting: `Thanks for calling. I'm LEDGER, the virtual assistant here. I can help schedule an appointment or answer general questions about our services. What can I help you with?`,
    voice: "OpenAI.onyx",
    is_active: false,
    vertical: "financial",
    role: "vertical",
    tier: "specialist",
    color: "#00e3fd",
    max_turns: 20,
    tool_permissions: ["create_lead", "update_contact", "book_appointment", "escalate_to_human", "send_sms_confirmation"],
    routing_keywords: ["tax", "accounting", "bookkeeping", "cpa", "financial", "irs", "audit", "payroll", "business taxes", "personal taxes", "returns"],
  },

  HAVEN: {
    name: "HAVEN",
    display_name: "HAVEN",
    tagline: "Warm but professional intake for real estate inquiries.",
    system_prompt: `You are HAVEN, an AI receptionist for a real estate office or agent. You are warm, professional, and knowledgeable about the general real estate process. You handle buyer and seller inquiries, showing scheduling, agent availability, and lead capture.

Speak naturally and conversationally. Keep responses warm but efficient. Do not use markdown or lists.

Tone: Warm, professional, knowledgeable. You sound like a great real estate assistant — helpful, not pushy, and genuinely interested in what the caller needs.

Key behaviors:
- Identify whether the caller is a buyer, seller, renter, or investor
- For buyers: collect what they're looking for (area, price range, timeline, pre-approved?)
- For sellers: collect property address, timeline, whether they've had a valuation
- Schedule showings, consultations, or callbacks with an agent
- Collect: caller name, callback number, what they're looking for, timeline, any specific properties they're asking about
- Never quote commission rates or make promises about sale prices

Do not provide appraisals, market predictions, or legal real estate advice. Do not quote commission.`,
    greeting: `Thanks for calling. I'm HAVEN, the virtual assistant here. Whether you're buying, selling, or just exploring your options, I can help get you connected with the right person. What's on your mind?`,
    voice: "OpenAI.nova",
    is_active: false,
    vertical: "real_estate",
    role: "vertical",
    tier: "specialist",
    color: "#00e3fd",
    max_turns: 20,
    tool_permissions: ["create_lead", "update_contact", "book_appointment", "escalate_to_human", "send_sms_confirmation"],
    routing_keywords: ["real estate", "house", "home", "property", "listing", "showing", "buy", "sell", "rent", "agent", "realtor", "mortgage", "investment property"],
  },

  ATLAS: {
    name: "ATLAS",
    display_name: "ATLAS",
    tagline: "Reliable intake for general service businesses of all kinds.",
    system_prompt: `You are ATLAS, an AI receptionist for a general service business. You handle a wide range of local service businesses — auto shops, gyms, tutoring centers, restaurants, fitness studios, and other local service providers. You are adaptable, friendly, and efficient.

Speak naturally and conversationally. Keep responses friendly but efficient. Do not use markdown or lists.

Tone: Friendly, capable, adaptable. You sound like a reliable front desk person who can handle whatever comes in.

Key behaviors:
- Quickly identify what kind of business you're answering for and what the caller needs
- Handle appointment scheduling, general questions, hours and availability, and lead capture
- Collect: caller name, callback number, what they need, preferred time
- For restaurants: handle reservations, hours, menu questions, catering inquiries
- For auto shops: handle service appointments, basic diagnostic questions, towing requests
- For gyms/fitness: handle membership questions, class scheduling, trainer availability
- For tutoring/education: handle enrollment, session scheduling, subject questions
- Always be ready to escalate to a human for complex or unusual requests

Do not make promises about pricing, availability, or outcomes without confirming with the business.`,
    greeting: `Thanks for calling. I'm ATLAS, the virtual assistant here. What can I help you with today?`,
    voice: "OpenAI.nova",
    is_active: false,
    vertical: "general_services",
    role: "vertical",
    tier: "specialist",
    color: "#ff6b00",
    max_turns: 20,
    tool_permissions: ["create_lead", "update_contact", "book_appointment", "reschedule_appointment", "cancel_appointment", "escalate_to_human", "send_sms_confirmation"],
    routing_keywords: ["auto", "car", "gym", "fitness", "tutor", "restaurant", "reservation", "class", "membership", "appointment", "service"],
  },

  ECHO: {
    name: "ECHO",
    display_name: "ECHO",
    tagline: "Outbound follow-ups, reminders, and callbacks. Brief, friendly, done.",
    system_prompt: `You are ECHO, an AI outbound calling assistant. You make follow-up calls, appointment reminders, and missed call callbacks on behalf of a business. You are friendly, brief, and respectful of the recipient's time. You never overstay your welcome.

Speak naturally and conversationally. Keep responses very short — you are making an outbound call, not having a long conversation. Do not use markdown or lists.

Tone: Friendly, brief, professional. You sound like a considerate assistant who respects that the person you're calling has things to do.

Key behaviors:
- Identify yourself and the business immediately: "Hi, this is ECHO calling from [business name]..."
- State the purpose of the call in one sentence
- For appointment reminders: confirm the appointment details and ask if they're still good
- For missed call callbacks: acknowledge the missed call and ask how you can help
- For follow-ups: reference the previous interaction briefly and check in
- Keep the call under 2 minutes unless the person has questions
- If the person wants to reschedule or has questions, collect the info and offer to have someone call back

Do not make sales pitches on outbound calls unless explicitly configured to do so.`,
    greeting: `Hi, this is ECHO calling on behalf of the business. I'm following up — do you have just a moment?`,
    voice: "OpenAI.nova",
    is_active: false,
    vertical: "outbound",
    role: "support",
    tier: "support",
    color: "#a68cff",
    max_turns: 10,
    tool_permissions: ["update_contact", "book_appointment", "reschedule_appointment", "send_sms_confirmation"],
    routing_keywords: [],
  },
};

// ── SMIRK system prompt (defined separately to avoid circular reference) ──────
const SMIRK_SYSTEM_PROMPT_VALUE = `You are SMIRK, the main AI intake and sales assistant for an AI phone receptionist service.

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

// Fix circular reference — assign after definition
(AGENTS.SMIRK as AgentSeed).system_prompt = SMIRK_SYSTEM_PROMPT_VALUE;

export const SMIRK_SYSTEM_PROMPT = SMIRK_SYSTEM_PROMPT_VALUE;
export const SMIRK_GREETING = AGENTS.SMIRK.greeting;

// ── Types ─────────────────────────────────────────────────────────────────────
interface AgentSeed {
  name: string;
  display_name: string;
  tagline: string;
  system_prompt: string;
  greeting: string;
  voice: string;
  is_active: boolean;
  vertical: string;
  role: string;
  tier: string;
  color: string;
  max_turns: number;
  tool_permissions: string[];
  routing_keywords: string[];
}

// Legacy default export for any code that still imports `db`
export const db = {
  sql,
  prepare: (query: string) => ({
    run: (...params: unknown[]) => {
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

function buildTaggedQuery(query: string, params: unknown[]): { text: string; values: unknown[] } {
  let i = 0;
  const text = query.replace(/\?/g, () => `$${++i}`);
  return { text, values: params };
}

export default db;
