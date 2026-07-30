/**
 * Workspace-scoped prospect research storage.
 *
 * This module stores campaigns and prospect records for human review. It does
 * not send email, SMS, or place calls. External contact remains behind a
 * separate, recipient-specific approval workflow.
 */

import { sql } from "./db.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ProspectingCampaign {
  id: number;
  workspace_id: number;
  name: string;
  description?: string;
  status: "draft" | "active" | "paused" | "completed";
  agent_name: string;           // legacy campaign label; not execution authority
  pitch_script?: string;        // custom pitch override
  target_industry?: string;     // e.g. "plumbing", "dental", "restaurant"
  target_location?: string;     // e.g. "Miami, FL" or "33101"
  max_calls_per_day: number;
  call_window_start: string;    // HH:MM in workspace timezone
  call_window_end: string;
  total_leads: number;
  called: number;
  interested: number;
  not_interested: number;
  voicemails: number;
  created_at: string;
}

export interface ProspectLead {
  id: number;
  campaign_id: number;
  business_name: string;
  phone?: string;
  phone_contact_mode?: "operator_review_only";
  email?: string;
  email_verification?: "verified_owner_email";
  website?: string;
  industry?: string;
  address?: string;
  city?: string;
  state?: string;
  contact_name?: string;
  contact_title?: string;
  source: "google_places" | "manual" | "csv" | "linkedin" | "velvet_alchemy_research";
  status:
    | "pending"
    | "calling"
    | "interested"
    | "not_interested"
    | "voicemail"
    | "dnc"
    | "no_answer"
    | "callback"
    | "contacted"
    | "converted";
  review_state: "pending_review" | "qualified" | "rejected";
  call_sid?: string;
  notes?: string;
  callback_at?: string;
  called_at?: string;
  created_at: string;
}

// ── DB Schema ──────────────────────────────────────────────────────────────────

export async function initProspectorSchema(): Promise<void> {
  console.log("[prospector] Initializing prospector schema...");
  await sql`
    CREATE TABLE IF NOT EXISTS prospecting_campaigns (
      id                  SERIAL PRIMARY KEY,
      name                TEXT NOT NULL,
      description         TEXT,
      status              TEXT NOT NULL DEFAULT 'draft',
      agent_name          TEXT NOT NULL DEFAULT 'FORGE',
      pitch_script        TEXT,
      target_industry     TEXT,
      target_location     TEXT,
      max_calls_per_day   INTEGER NOT NULL DEFAULT 50,
      call_window_start   TEXT NOT NULL DEFAULT '09:00',
      call_window_end     TEXT NOT NULL DEFAULT '17:00',
      total_leads         INTEGER NOT NULL DEFAULT 0,
      called              INTEGER NOT NULL DEFAULT 0,
      interested          INTEGER NOT NULL DEFAULT 0,
      not_interested      INTEGER NOT NULL DEFAULT 0,
      voicemails          INTEGER NOT NULL DEFAULT 0,
      workspace_id        INTEGER NOT NULL DEFAULT 1,
      external_source     TEXT,
      external_id         TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS prospect_leads (
      id             SERIAL PRIMARY KEY,
      campaign_id    INTEGER NOT NULL REFERENCES prospecting_campaigns(id) ON DELETE CASCADE,
      business_name  TEXT NOT NULL,
      phone          TEXT,
      email          TEXT,
      email_verification TEXT,
      phone_contact_mode TEXT,
      website        TEXT,
      industry       TEXT,
      address        TEXT,
      city           TEXT,
      state          TEXT,
      contact_name   TEXT,
      contact_title  TEXT,
      source         TEXT NOT NULL DEFAULT 'manual',
      external_id    TEXT,
      payload_hash   TEXT,
      research_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
      status         TEXT NOT NULL DEFAULT 'pending',
      call_sid       TEXT,
      notes          TEXT,
      callback_at    TIMESTAMPTZ,
      called_at      TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE prospect_leads ADD COLUMN IF NOT EXISTS score INTEGER`;
  await sql`ALTER TABLE prospect_leads ADD COLUMN IF NOT EXISTS personalized_hook TEXT`;
  await sql`ALTER TABLE prospect_leads ALTER COLUMN phone DROP NOT NULL`;
  await sql`ALTER TABLE prospect_leads ADD COLUMN IF NOT EXISTS email TEXT`;
  await sql`ALTER TABLE prospect_leads ADD COLUMN IF NOT EXISTS email_verification TEXT`;
  await sql`ALTER TABLE prospect_leads ADD COLUMN IF NOT EXISTS phone_contact_mode TEXT`;
  await sql`ALTER TABLE prospect_leads ADD COLUMN IF NOT EXISTS external_id TEXT`;
  await sql`ALTER TABLE prospect_leads ADD COLUMN IF NOT EXISTS payload_hash TEXT`;
  await sql`ALTER TABLE prospect_leads ADD COLUMN IF NOT EXISTS research_evidence JSONB NOT NULL DEFAULT '[]'::jsonb`;
  await sql`ALTER TABLE prospect_leads ADD COLUMN IF NOT EXISTS review_state TEXT NOT NULL DEFAULT 'pending_review'`;
  await sql`ALTER TABLE prospect_leads ADD COLUMN IF NOT EXISTS reviewed_by TEXT`;
  await sql`ALTER TABLE prospect_leads ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`;
  await sql`ALTER TABLE prospecting_campaigns ADD COLUMN IF NOT EXISTS workspace_id INTEGER NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE prospecting_campaigns ADD COLUMN IF NOT EXISTS external_source TEXT`;
  await sql`ALTER TABLE prospecting_campaigns ADD COLUMN IF NOT EXISTS external_id TEXT`;
  await sql`ALTER TABLE prospecting_campaigns ALTER COLUMN workspace_id DROP DEFAULT`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prospecting_campaigns_external
    ON prospecting_campaigns(workspace_id, external_source, external_id)
    WHERE external_source IS NOT NULL AND external_id IS NOT NULL
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prospect_leads_external
    ON prospect_leads(campaign_id, source, external_id)
    WHERE external_id IS NOT NULL
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS velvet_alchemy_research_receipts (
      id            SERIAL PRIMARY KEY,
      workspace_id  INTEGER NOT NULL,
      source        TEXT NOT NULL DEFAULT 'velvet_alchemy_research',
      external_id   TEXT NOT NULL,
      payload_hash  TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'processing'
        CHECK (status IN ('processing', 'received')),
      campaign_id   INTEGER REFERENCES prospecting_campaigns(id) ON DELETE SET NULL,
      prospect_id   INTEGER REFERENCES prospect_leads(id) ON DELETE SET NULL,
      received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (workspace_id, source, external_id)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_velvet_alchemy_research_receipts_workspace
    ON velvet_alchemy_research_receipts(workspace_id, received_at DESC)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS velvet_lead_source_requests (
      id                    SERIAL PRIMARY KEY,
      request_id            TEXT NOT NULL UNIQUE,
      workspace_id          INTEGER NOT NULL,
      state                 TEXT NOT NULL DEFAULT 'PREPARED'
        CHECK (state IN (
          'PREPARED', 'APPROVED', 'SENDING', 'PARTIAL', 'COMPLETED',
          'EMPTY', 'FAILED', 'CANCELLED', 'EXPIRED'
        )),
      criteria              JSONB NOT NULL,
      request_payload       JSONB NOT NULL,
      request_payload_hash  TEXT NOT NULL,
      prepared_by           TEXT NOT NULL,
      approved_by           TEXT,
      approved_at           TIMESTAMPTZ,
      approval_attestations JSONB,
      expires_at            TIMESTAMPTZ NOT NULL,
      attempts              INTEGER NOT NULL DEFAULT 0,
      remote_batch_id       INTEGER,
      remote_original_state TEXT,
      remote_response       JSONB,
      remote_response_hash  TEXT,
      applied_learning_candidate JSONB,
      imported_count        INTEGER NOT NULL DEFAULT 0,
      failed_count          INTEGER NOT NULL DEFAULT 0,
      last_error            TEXT,
      dispatch_requested_by TEXT,
      dispatch_requested_at TIMESTAMPTZ,
      dispatch_response_at  TIMESTAMPTZ,
      completed_at          TIMESTAMPTZ,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_velvet_lead_source_requests_workspace
    ON velvet_lead_source_requests(workspace_id, created_at DESC)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS velvet_lead_source_request_items (
      id                    SERIAL PRIMARY KEY,
      request_row_id        INTEGER NOT NULL
        REFERENCES velvet_lead_source_requests(id) ON DELETE CASCADE,
      workspace_id          INTEGER NOT NULL,
      external_id           TEXT NOT NULL,
      prospect_payload_hash TEXT NOT NULL,
      import_state          TEXT NOT NULL
        CHECK (import_state IN ('IMPORTED', 'DUPLICATE', 'FAILED')),
      campaign_id           INTEGER,
      prospect_id           INTEGER,
      error_code            TEXT,
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (request_row_id, external_id)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_velvet_lead_source_items_request
    ON velvet_lead_source_request_items(
      workspace_id, request_row_id, created_at
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS velvet_lead_source_request_events (
      id             SERIAL PRIMARY KEY,
      event_id       TEXT NOT NULL UNIQUE,
      workspace_id   INTEGER NOT NULL,
      request_row_id INTEGER NOT NULL
        REFERENCES velvet_lead_source_requests(id) ON DELETE CASCADE,
      from_state     TEXT,
      to_state       TEXT NOT NULL,
      actor          TEXT NOT NULL,
      payload_hash   TEXT NOT NULL,
      details        JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_velvet_lead_source_events_request
    ON velvet_lead_source_request_events(
      workspace_id, request_row_id, occurred_at
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS prospect_outreach_jobs (
      id                  SERIAL PRIMARY KEY,
      approval_id         TEXT NOT NULL UNIQUE,
      workspace_id        INTEGER NOT NULL,
      campaign_id         INTEGER NOT NULL REFERENCES prospecting_campaigns(id) ON DELETE CASCADE,
      lead_id             INTEGER NOT NULL REFERENCES prospect_leads(id) ON DELETE CASCADE,
      channel             TEXT NOT NULL CHECK (channel IN ('email', 'call')),
      state               TEXT NOT NULL DEFAULT 'PREPARED'
        CHECK (state IN (
          'PREPARED', 'APPROVED', 'SENDING', 'SENT', 'FAILED',
          'REJECTED', 'EXPIRED', 'CANCELLED'
        )),
      recipient           TEXT NOT NULL,
      subject             TEXT,
      content             TEXT NOT NULL,
      variant_key         TEXT NOT NULL DEFAULT 'operator-v1',
      contract_version    TEXT NOT NULL,
      evidence_hash       TEXT NOT NULL,
      draft_fingerprint   TEXT NOT NULL,
      payload             JSONB NOT NULL,
      payload_hash        TEXT NOT NULL,
      max_cost_cents      INTEGER NOT NULL CHECK (max_cost_cents >= 0),
      prepared_by         TEXT NOT NULL,
      approved_by         TEXT,
      approved_at         TIMESTAMPTZ,
      approval_attestations JSONB,
      expires_at          TIMESTAMPTZ NOT NULL,
      sent_at             TIMESTAMPTZ,
      provider_name       TEXT,
      provider_idempotency_key TEXT,
      provider_message_id TEXT,
      provider_cost_cents INTEGER,
      provider_requested_at TIMESTAMPTZ,
      provider_response_at TIMESTAMPTZ,
      provider_attempts   INTEGER NOT NULL DEFAULT 0,
      execution_proof_reference TEXT,
      failure_code        TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prospect_outreach_active_fingerprint
    ON prospect_outreach_jobs(workspace_id, lead_id, draft_fingerprint)
    WHERE state IN ('PREPARED', 'APPROVED', 'SENDING')
  `;
  await sql`ALTER TABLE prospect_outreach_jobs ADD COLUMN IF NOT EXISTS variant_key TEXT NOT NULL DEFAULT 'operator-v1'`;
  await sql`ALTER TABLE prospect_outreach_jobs ADD COLUMN IF NOT EXISTS approval_attestations JSONB`;
  await sql`ALTER TABLE prospect_outreach_jobs ADD COLUMN IF NOT EXISTS execution_proof_reference TEXT`;
  await sql`ALTER TABLE prospect_outreach_jobs ADD COLUMN IF NOT EXISTS provider_name TEXT`;
  await sql`ALTER TABLE prospect_outreach_jobs ADD COLUMN IF NOT EXISTS provider_idempotency_key TEXT`;
  await sql`ALTER TABLE prospect_outreach_jobs ADD COLUMN IF NOT EXISTS provider_message_id TEXT`;
  await sql`ALTER TABLE prospect_outreach_jobs ADD COLUMN IF NOT EXISTS provider_cost_cents INTEGER`;
  await sql`ALTER TABLE prospect_outreach_jobs ADD COLUMN IF NOT EXISTS provider_requested_at TIMESTAMPTZ`;
  await sql`ALTER TABLE prospect_outreach_jobs ADD COLUMN IF NOT EXISTS provider_response_at TIMESTAMPTZ`;
  await sql`ALTER TABLE prospect_outreach_jobs ADD COLUMN IF NOT EXISTS provider_attempts INTEGER NOT NULL DEFAULT 0`;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_prospect_outreach_jobs_workspace
    ON prospect_outreach_jobs(workspace_id, created_at DESC)
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prospect_outreach_provider_message
    ON prospect_outreach_jobs(provider_name, provider_message_id)
    WHERE provider_name IS NOT NULL AND provider_message_id IS NOT NULL
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS prospect_email_suppressions (
      id            SERIAL PRIMARY KEY,
      workspace_id  INTEGER NOT NULL,
      email         TEXT NOT NULL,
      reason        TEXT NOT NULL,
      source        TEXT NOT NULL,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      recorded_by   TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (workspace_id, email)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_prospect_email_suppressions_active
    ON prospect_email_suppressions(workspace_id, email)
    WHERE active = TRUE
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS prospect_email_provider_events (
      id                  SERIAL PRIMARY KEY,
      workspace_id        INTEGER NOT NULL,
      provider            TEXT NOT NULL,
      provider_event_id   TEXT NOT NULL,
      provider_message_id TEXT,
      event_type          TEXT NOT NULL,
      payload_hash        TEXT NOT NULL,
      process_status      TEXT NOT NULL DEFAULT 'RECEIVED'
        CHECK (process_status IN (
          'RECEIVED', 'PROCESSED', 'IGNORED', 'RETRY', 'REVIEW_REQUIRED'
        )),
      outreach_job_id     INTEGER REFERENCES prospect_outreach_jobs(id) ON DELETE SET NULL,
      details             JSONB NOT NULL DEFAULT '{}'::jsonb,
      received_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at        TIMESTAMPTZ,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (provider, provider_event_id)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_prospect_email_provider_events_workspace
    ON prospect_email_provider_events(workspace_id, received_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_prospect_email_provider_events_retry
    ON prospect_email_provider_events(workspace_id, updated_at)
    WHERE process_status IN ('RETRY', 'REVIEW_REQUIRED')
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS prospect_outreach_events (
      id            SERIAL PRIMARY KEY,
      event_id      TEXT NOT NULL UNIQUE,
      workspace_id  INTEGER NOT NULL,
      outreach_job_id INTEGER NOT NULL REFERENCES prospect_outreach_jobs(id) ON DELETE CASCADE,
      from_state    TEXT,
      to_state      TEXT NOT NULL,
      actor         TEXT NOT NULL,
      payload_hash  TEXT NOT NULL,
      details       JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_prospect_outreach_events_job
    ON prospect_outreach_events(workspace_id, outreach_job_id, occurred_at)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS prospect_outcome_events (
      id                  SERIAL PRIMARY KEY,
      workspace_id        INTEGER NOT NULL,
      campaign_id         INTEGER NOT NULL REFERENCES prospecting_campaigns(id) ON DELETE CASCADE,
      lead_id             INTEGER NOT NULL REFERENCES prospect_leads(id) ON DELETE CASCADE,
      outreach_job_id     INTEGER REFERENCES prospect_outreach_jobs(id) ON DELETE SET NULL,
      source              TEXT NOT NULL,
      external_event_id   TEXT NOT NULL,
      outcome             TEXT NOT NULL,
      occurred_at         TIMESTAMPTZ NOT NULL,
      notes               TEXT,
      recorded_by         TEXT NOT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (workspace_id, source, external_event_id)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_prospect_outcome_events_lead
    ON prospect_outcome_events(workspace_id, lead_id, occurred_at DESC)
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prospect_outcome_job_state
    ON prospect_outcome_events(workspace_id, outreach_job_id, outcome)
    WHERE outreach_job_id IS NOT NULL
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS velvet_outcome_outbox (
      id                    SERIAL PRIMARY KEY,
      workspace_id          INTEGER NOT NULL,
      lead_id               INTEGER NOT NULL REFERENCES prospect_leads(id) ON DELETE CASCADE,
      outcome_event_id      INTEGER NOT NULL REFERENCES prospect_outcome_events(id) ON DELETE CASCADE,
      external_event_id     TEXT NOT NULL,
      external_prospect_id  TEXT NOT NULL,
      payload               JSONB NOT NULL,
      payload_hash          TEXT NOT NULL,
      state                 TEXT NOT NULL DEFAULT 'PREPARED'
        CHECK (state IN (
          'PREPARED', 'SENDING', 'DISPATCHED', 'FAILED', 'CANCELLED'
        )),
      attempts              INTEGER NOT NULL DEFAULT 0,
      last_error            TEXT,
      dispatch_idempotency_key TEXT,
      dispatch_requested_by  TEXT,
      dispatch_requested_at TIMESTAMPTZ,
      dispatch_response_at  TIMESTAMPTZ,
      remote_event_id       INTEGER,
      dispatched_at         TIMESTAMPTZ,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (workspace_id, external_event_id)
    )
  `;
  await sql`
    ALTER TABLE velvet_outcome_outbox
    ADD COLUMN IF NOT EXISTS dispatch_idempotency_key TEXT
  `;
  await sql`
    ALTER TABLE velvet_outcome_outbox
    ADD COLUMN IF NOT EXISTS dispatch_requested_by TEXT
  `;
  await sql`
    ALTER TABLE velvet_outcome_outbox
    ADD COLUMN IF NOT EXISTS dispatch_requested_at TIMESTAMPTZ
  `;
  await sql`
    ALTER TABLE velvet_outcome_outbox
    ADD COLUMN IF NOT EXISTS dispatch_response_at TIMESTAMPTZ
  `;
  await sql`
    ALTER TABLE velvet_outcome_outbox
    ADD COLUMN IF NOT EXISTS remote_event_id INTEGER
  `;
  await sql`
    DO $$
    DECLARE
      state_constraint TEXT;
    BEGIN
      SELECT pg_get_constraintdef(oid)
      INTO state_constraint
      FROM pg_constraint
      WHERE conrelid = 'velvet_outcome_outbox'::regclass
        AND conname = 'velvet_outcome_outbox_state_check';

      IF state_constraint IS NULL OR
         POSITION('SENDING' IN state_constraint) = 0 THEN
        ALTER TABLE velvet_outcome_outbox
        DROP CONSTRAINT IF EXISTS velvet_outcome_outbox_state_check;
        ALTER TABLE velvet_outcome_outbox
        ADD CONSTRAINT velvet_outcome_outbox_state_check
        CHECK (state IN (
          'PREPARED', 'SENDING', 'DISPATCHED', 'FAILED', 'CANCELLED'
        ));
      END IF;
    END
    $$
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_velvet_outcome_outbox_pending
    ON velvet_outcome_outbox(workspace_id, created_at)
    WHERE state = 'PREPARED'
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS velvet_outcome_dispatch_events (
      id                  SERIAL PRIMARY KEY,
      event_id            TEXT NOT NULL UNIQUE,
      workspace_id        INTEGER NOT NULL,
      outbox_id           INTEGER NOT NULL REFERENCES velvet_outcome_outbox(id) ON DELETE CASCADE,
      from_state          TEXT,
      to_state            TEXT NOT NULL,
      actor               TEXT NOT NULL,
      payload_hash        TEXT NOT NULL,
      details             JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_velvet_outcome_dispatch_events_outbox
    ON velvet_outcome_dispatch_events(workspace_id, outbox_id, occurred_at)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS prospect_learning_candidates (
      id              SERIAL PRIMARY KEY,
      workspace_id    INTEGER NOT NULL,
      candidate_key   TEXT NOT NULL,
      version         INTEGER NOT NULL,
      state           TEXT NOT NULL DEFAULT 'CANDIDATE'
        CHECK (state IN ('CANDIDATE', 'APPROVED', 'REJECTED')),
      proposal        JSONB NOT NULL,
      evidence        JSONB NOT NULL,
      sample_size     INTEGER NOT NULL CHECK (sample_size >= 0),
      generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_by      TEXT,
      decided_at      TIMESTAMPTZ,
      UNIQUE (workspace_id, candidate_key, version)
    )
  `;
  console.log("[prospector] Prospector schema OK.");
}

// ── Campaign CRUD ──────────────────────────────────────────────────────────────

export async function getCampaigns(workspaceId: number): Promise<ProspectingCampaign[]> {
  return sql<ProspectingCampaign[]>`
    SELECT * FROM prospecting_campaigns
    WHERE workspace_id = ${workspaceId}
    ORDER BY created_at DESC
  `;
}

export async function getCampaignById(id: number, workspaceId: number): Promise<ProspectingCampaign | null> {
  const rows = await sql<ProspectingCampaign[]>`
    SELECT * FROM prospecting_campaigns
    WHERE id = ${id} AND workspace_id = ${workspaceId}
  `;
  return rows[0] || null;
}

export async function createCampaign(data: Partial<ProspectingCampaign>, workspaceId: number): Promise<ProspectingCampaign> {
  const rows = await sql<ProspectingCampaign[]>`
    INSERT INTO prospecting_campaigns (
      name,
      description,
      agent_name,
      pitch_script,
      target_industry,
      target_location,
      max_calls_per_day,
      call_window_start,
      call_window_end,
      workspace_id
    )
    VALUES (
      ${data.name || "New Campaign"},
      ${data.description || null},
      ${data.agent_name || "FORGE"},
      ${data.pitch_script || null},
      ${data.target_industry || null},
      ${data.target_location || null},
      ${data.max_calls_per_day || 50},
      ${data.call_window_start || "09:00"},
      ${data.call_window_end || "17:00"},
      ${workspaceId}
    )
    RETURNING *
  `;
  return rows[0];
}

export async function updateCampaignStatus(
  id: number,
  status: ProspectingCampaign["status"],
  workspaceId: number
): Promise<boolean> {
  const rows = await sql<{ id: number }[]>`
    UPDATE prospecting_campaigns
    SET status = ${status}
    WHERE id = ${id} AND workspace_id = ${workspaceId}
    RETURNING id
  `;
  return rows.length === 1;
}

// ── Lead Management ────────────────────────────────────────────────────────────

export async function getLeads(
  workspaceId: number,
  campaignId?: number,
  status?: string
): Promise<ProspectLead[]> {
  if (campaignId && status) {
    return sql<ProspectLead[]>`
      SELECT l.* FROM prospect_leads l
      JOIN prospecting_campaigns c ON c.id = l.campaign_id
      WHERE c.workspace_id = ${workspaceId}
        AND l.campaign_id = ${campaignId}
        AND l.status = ${status}
      ORDER BY l.created_at DESC
    `;
  }
  if (campaignId) {
    return sql<ProspectLead[]>`
      SELECT l.* FROM prospect_leads l
      JOIN prospecting_campaigns c ON c.id = l.campaign_id
      WHERE c.workspace_id = ${workspaceId}
        AND l.campaign_id = ${campaignId}
      ORDER BY l.created_at DESC
    `;
  }
  return sql<ProspectLead[]>`
    SELECT l.* FROM prospect_leads l
    JOIN prospecting_campaigns c ON c.id = l.campaign_id
    WHERE c.workspace_id = ${workspaceId}
      ${status ? sql`AND l.status = ${status}` : sql``}
    ORDER BY l.created_at DESC
    LIMIT 200
  `;
}

export async function addLeads(
  campaignId: number,
  leads: Partial<ProspectLead & { score?: number; personalized_hook?: string }>[],
  workspaceId: number
): Promise<number> {
  const campaign = await getCampaignById(campaignId, workspaceId);
  if (!campaign) throw new Error("Campaign not found");

  let added = 0;
  for (const lead of leads) {
    if (!lead.business_name || (!lead.phone && !lead.email && !lead.website)) continue;
    const score = (lead as any).score ?? null;
    const hook = (lead as any).personalized_hook ?? (lead as any).personalizedHook ?? null;
    const inserted = await sql<{ id: number }[]>`
      INSERT INTO prospect_leads (campaign_id, business_name, phone, email, website, industry, address, city, state, contact_name, contact_title, source, score, personalized_hook)
      VALUES (${campaignId}, ${lead.business_name}, ${lead.phone || null}, ${lead.email || null}, ${lead.website || null}, ${lead.industry || null},
              ${lead.address || null}, ${lead.city || null}, ${lead.state || null},
              ${lead.contact_name || null}, ${lead.contact_title || null}, ${lead.source || "manual"},
              ${score}, ${hook})
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    added += inserted.length;
  }
  await sql`
    UPDATE prospecting_campaigns
    SET total_leads = (SELECT COUNT(*) FROM prospect_leads WHERE campaign_id = ${campaignId})
    WHERE id = ${campaignId} AND workspace_id = ${workspaceId}
  `;
  return added;
}

export async function updateLeadStatus(
  leadId: number,
  status: ProspectLead["status"],
  workspaceId: number,
  callSid?: string,
  notes?: string
): Promise<boolean> {
  const updated = await sql<{ campaign_id: number }[]>`
    UPDATE prospect_leads SET
      status = ${status},
      call_sid = COALESCE(${callSid || null}, call_sid),
      notes = COALESCE(${notes || null}, notes),
      called_at = CASE WHEN ${status !== "pending"} THEN NOW() ELSE called_at END
    WHERE id = ${leadId}
      AND EXISTS (
        SELECT 1
        FROM prospecting_campaigns c
        WHERE c.id = prospect_leads.campaign_id
          AND c.workspace_id = ${workspaceId}
      )
    RETURNING campaign_id
  `;

  if (updated[0]) {
    const cid = updated[0].campaign_id;
    await sql`
      UPDATE prospecting_campaigns SET
        called = (SELECT COUNT(*) FROM prospect_leads WHERE campaign_id = ${cid} AND status != 'pending'),
        interested = (SELECT COUNT(*) FROM prospect_leads WHERE campaign_id = ${cid} AND status = 'interested'),
        not_interested = (SELECT COUNT(*) FROM prospect_leads WHERE campaign_id = ${cid} AND status = 'not_interested'),
        voicemails = (SELECT COUNT(*) FROM prospect_leads WHERE campaign_id = ${cid} AND status = 'voicemail')
      WHERE id = ${cid} AND workspace_id = ${workspaceId}
    `;
  }
  return updated.length === 1;
}

// ── CSV Parser ─────────────────────────────────────────────────────────────────

export function parseLeadsCsv(csvText: string): Partial<ProspectLead>[] {
  const lines = csvText.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/[^a-z_]/g, "_"));
  const leads: Partial<ProspectLead>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map(v => v.trim().replace(/^"|"$/g, ""));
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ""; });

    const phone = (row.phone || row.phone_number || row.tel || "").replace(/\D/g, "").replace(/^1/, "");
    const name = row.business_name || row.company || row.name || row.business || "";
    if (!phone || phone.length < 10 || !name) continue;

    leads.push({
      business_name: name,
      phone,
      website: row.website || row.url || undefined,
      industry: row.industry || row.type || undefined,
      address: row.address || undefined,
      city: row.city || undefined,
      state: row.state || undefined,
      contact_name: row.contact || row.contact_name || row.owner || undefined,
      contact_title: row.title || row.contact_title || undefined,
      source: "csv",
    });
  }

  return leads;
}
