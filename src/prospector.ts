/**
 * Workspace-scoped prospect research storage.
 *
 * This module stores campaigns and prospect records for human review. It does
 * not send email, SMS, or place calls. External contact remains behind a
 * separate, recipient-specific approval workflow.
 */

import { randomUUID } from "node:crypto";
import { sql } from "./db.js";
import { SMIRK_INTERNAL_INBOX_SEED_SOURCE } from "./prospect-inbox-placement.js";
import {
  buildProspectPositiveOutcomeReviewPayload,
  hashProspectPositiveOutcomeReviewPayload,
} from "./prospect-positive-outcome-review.js";
import { acquireProspectAcquisitionWorkspaceLock } from "./prospect-positive-outcome-pause.js";

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

const POSITIVE_OUTCOME_REVIEW_BACKFILL_LIMIT = 10_000;

async function backfillPositiveOutcomeReviews(): Promise<void> {
  const rows = await sql<{
    outcome_event_id: number;
    workspace_id: number;
    campaign_id: number;
    lead_id: number;
    business_name: string;
    outreach_job_id: number;
    approval_id: string;
    channel: "email" | "call";
    source: string;
    external_event_id: string;
    outcome: "replied" | "qualified" | "demo_booked" | "converted";
    occurred_at: string | Date;
    notes: string | null;
    recorded_by: string;
  }[]>`
    SELECT o.id AS outcome_event_id, o.workspace_id, o.campaign_id,
           o.lead_id, l.business_name, o.outreach_job_id,
           j.approval_id, j.channel, o.source, o.external_event_id,
           o.outcome, o.occurred_at, o.notes, o.recorded_by
    FROM prospect_outcome_events o
    JOIN prospect_outreach_jobs j
      ON j.id = o.outreach_job_id
     AND j.workspace_id = o.workspace_id
    JOIN prospect_leads l ON l.id = o.lead_id
    WHERE o.outcome IN (
      'replied', 'qualified', 'demo_booked', 'converted'
    )
      AND j.is_seed = FALSE
      AND NOT EXISTS (
        SELECT 1
        FROM prospect_positive_outcome_reviews r
        WHERE r.workspace_id = o.workspace_id
          AND r.outcome_event_id = o.id
      )
    ORDER BY o.id
    LIMIT ${POSITIVE_OUTCOME_REVIEW_BACKFILL_LIMIT + 1}
  `;
  if (rows.length > POSITIVE_OUTCOME_REVIEW_BACKFILL_LIMIT) {
    throw new Error(
      "Positive-outcome review backfill exceeds the 10,000-row safety limit."
    );
  }
  for (const row of rows) {
    const reviewId = randomUUID();
    const payload = buildProspectPositiveOutcomeReviewPayload({
      reviewId,
      workspaceId: row.workspace_id,
      campaignId: row.campaign_id,
      prospectId: row.lead_id,
      businessName: row.business_name,
      outreachJobId: row.outreach_job_id,
      outreachApprovalId: row.approval_id,
      channel: row.channel,
      outcomeEventId: row.outcome_event_id,
      outcome: row.outcome,
      eventSource: row.source,
      externalEventId: row.external_event_id,
      occurredAt: row.occurred_at,
      recordedBy: row.recorded_by,
      notes: row.notes,
    });
    const payloadHash =
      hashProspectPositiveOutcomeReviewPayload(payload);
    await sql.begin(async (tx: any) => {
      await acquireProspectAcquisitionWorkspaceLock(
        tx,
        row.workspace_id
      );
      const inserted = await tx<{ id: number }[]>`
        INSERT INTO prospect_positive_outcome_reviews (
          review_id, workspace_id, campaign_id, lead_id,
          outreach_job_id, outcome_event_id, payload, payload_hash,
          state
        ) VALUES (
          ${reviewId}, ${row.workspace_id}, ${row.campaign_id},
          ${row.lead_id}, ${row.outreach_job_id},
          ${row.outcome_event_id}, ${tx.json(payload)}, ${payloadHash},
          'PENDING'
        )
        ON CONFLICT (workspace_id, outcome_event_id) DO NOTHING
        RETURNING id
      `;
      if (inserted.length === 0) return;
      if (inserted.length !== 1) {
        throw new Error(
          "Positive-outcome review backfill changed an unexpected row count."
        );
      }
      const audit = await tx<{ id: number }[]>`
        INSERT INTO prospect_positive_outcome_review_events (
          event_id, workspace_id, review_row_id, from_state,
          to_state, actor, receipt_hash, details
        ) VALUES (
          ${randomUUID()}, ${row.workspace_id}, ${inserted[0].id},
          NULL, 'PENDING', 'schema_backfill', ${payloadHash},
          ${tx.json({
            outcomeEventId: row.outcome_event_id,
            externalAction: "none",
          })}
        )
        RETURNING id
      `;
      if (audit.length !== 1) {
        throw new Error(
          "Positive-outcome review backfill audit was not recorded."
        );
      }
    });
  }
}

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
    CREATE TABLE IF NOT EXISTS velvet_discovery_requests (
      id                    SERIAL PRIMARY KEY,
      request_id            TEXT NOT NULL UNIQUE,
      workspace_id          INTEGER NOT NULL,
      state                 TEXT NOT NULL DEFAULT 'PREPARED'
        CHECK (state IN (
          'PREPARED', 'APPROVED', 'SENDING', 'SUBMITTED',
          'FAILED', 'CANCELLED', 'EXPIRED'
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
      remote_discovery_id   INTEGER,
      remote_state          TEXT
        CHECK (
          remote_state IS NULL OR remote_state IN (
            'PREPARED', 'APPROVED', 'QUEUED', 'RUNNING',
            'COMPLETED', 'EMPTY', 'PARTIAL', 'FAILED',
            'REJECTED', 'CANCELLED', 'EXPIRED'
          )
        ),
      remote_prepared_response JSONB,
      remote_prepared_hash  TEXT,
      remote_status_response JSONB,
      remote_status_hash    TEXT,
      quote_payload         JSONB,
      quote_payload_hash    TEXT,
      effective_criteria    JSONB,
      created_lead_count    INTEGER NOT NULL DEFAULT 0,
      ready_lead_count      INTEGER NOT NULL DEFAULT 0,
      skipped_lead_count    INTEGER NOT NULL DEFAULT 0,
      failed_lead_count     INTEGER NOT NULL DEFAULT 0,
      provider_requests     INTEGER NOT NULL DEFAULT 0,
      approved_max_spend_cents INTEGER,
      last_error            TEXT,
      dispatch_requested_by TEXT,
      dispatch_requested_at TIMESTAMPTZ,
      dispatch_response_at  TIMESTAMPTZ,
      status_checked_by     TEXT,
      status_checked_at     TIMESTAMPTZ,
      completed_at          TIMESTAMPTZ,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_velvet_discovery_requests_workspace
    ON velvet_discovery_requests(workspace_id, created_at DESC)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS velvet_discovery_request_events (
      id             SERIAL PRIMARY KEY,
      event_id       TEXT NOT NULL UNIQUE,
      workspace_id   INTEGER NOT NULL,
      request_row_id INTEGER NOT NULL
        REFERENCES velvet_discovery_requests(id) ON DELETE CASCADE,
      from_state     TEXT,
      to_state       TEXT NOT NULL,
      actor          TEXT NOT NULL,
      payload_hash   TEXT NOT NULL,
      details        JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_velvet_discovery_events_request
    ON velvet_discovery_request_events(
      workspace_id, request_row_id, occurred_at
    )
  `;
  await sql`
    ALTER TABLE velvet_lead_source_requests
    ADD COLUMN IF NOT EXISTS discovery_request_id INTEGER
      REFERENCES velvet_discovery_requests(id) ON DELETE SET NULL
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_velvet_source_discovery_unique
    ON velvet_lead_source_requests(workspace_id, discovery_request_id)
    WHERE discovery_request_id IS NOT NULL
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
      is_seed             BOOLEAN NOT NULL DEFAULT FALSE,
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
  await sql`ALTER TABLE prospect_outreach_jobs ADD COLUMN IF NOT EXISTS is_seed BOOLEAN NOT NULL DEFAULT FALSE`;
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
    CREATE TABLE IF NOT EXISTS prospect_inbox_placement_tests (
      id                     SERIAL PRIMARY KEY,
      test_id                TEXT NOT NULL UNIQUE,
      workspace_id           INTEGER NOT NULL,
      target_campaign_id     INTEGER NOT NULL
        REFERENCES prospecting_campaigns(id) ON DELETE CASCADE,
      state                  TEXT NOT NULL DEFAULT 'PREPARED'
        CHECK (state IN (
          'PREPARED', 'PASSED', 'FAILED', 'CANCELLED', 'EXPIRED'
        )),
      control_variant_key    TEXT NOT NULL,
      challenger_variant_key TEXT NOT NULL,
      definition             JSONB NOT NULL,
      definition_hash        TEXT NOT NULL,
      receipt                JSONB,
      receipt_hash           TEXT,
      prepared_by            TEXT NOT NULL,
      finalized_by           TEXT,
      finalized_at           TIMESTAMPTZ,
      valid_until            TIMESTAMPTZ,
      expires_at             TIMESTAMPTZ NOT NULL,
      cancel_reason          TEXT,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (control_variant_key <> challenger_variant_key),
      CHECK (
        (state IN ('PASSED', 'FAILED') AND receipt IS NOT NULL
          AND receipt_hash IS NOT NULL AND finalized_at IS NOT NULL)
        OR
        (state NOT IN ('PASSED', 'FAILED') AND receipt IS NULL
          AND receipt_hash IS NULL)
      )
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_prospect_inbox_placement_tests_workspace
    ON prospect_inbox_placement_tests(
      workspace_id, target_campaign_id, created_at DESC
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_prospect_inbox_placement_tests_pass
    ON prospect_inbox_placement_tests(
      workspace_id, target_campaign_id, valid_until DESC
    )
    WHERE state = 'PASSED'
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS prospect_inbox_placement_items (
      id                  SERIAL PRIMARY KEY,
      workspace_id        INTEGER NOT NULL,
      test_row_id         INTEGER NOT NULL
        REFERENCES prospect_inbox_placement_tests(id) ON DELETE CASCADE,
      slot                INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 5),
      mailbox_label       TEXT NOT NULL,
      provider            TEXT NOT NULL
        CHECK (provider IN (
          'google_workspace', 'microsoft_365', 'yahoo_aol'
        )),
      recipient_hash      TEXT NOT NULL,
      assigned_variant_key TEXT NOT NULL,
      outreach_job_id     INTEGER NOT NULL
        REFERENCES prospect_outreach_jobs(id) ON DELETE RESTRICT,
      inspection          JSONB,
      inspection_hash     TEXT,
      inspected_by        TEXT,
      inspected_at        TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (test_row_id, slot),
      UNIQUE (test_row_id, outreach_job_id),
      CHECK (
        (inspection IS NULL AND inspection_hash IS NULL
          AND inspected_by IS NULL AND inspected_at IS NULL)
        OR
        (inspection IS NOT NULL AND inspection_hash IS NOT NULL
          AND inspected_by IS NOT NULL AND inspected_at IS NOT NULL)
      )
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_prospect_inbox_placement_items_test
    ON prospect_inbox_placement_items(
      workspace_id, test_row_id, slot
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS prospect_inbox_placement_events (
      id              SERIAL PRIMARY KEY,
      event_id        TEXT NOT NULL UNIQUE,
      workspace_id    INTEGER NOT NULL,
      test_row_id     INTEGER NOT NULL
        REFERENCES prospect_inbox_placement_tests(id) ON DELETE CASCADE,
      from_state      TEXT,
      to_state        TEXT NOT NULL,
      actor           TEXT NOT NULL,
      definition_hash TEXT NOT NULL,
      details         JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_prospect_inbox_placement_events_test
    ON prospect_inbox_placement_events(
      workspace_id, test_row_id, occurred_at
    )
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
    CREATE TABLE IF NOT EXISTS prospect_positive_outcome_reviews (
      id                          SERIAL PRIMARY KEY,
      review_id                   TEXT NOT NULL UNIQUE,
      workspace_id                INTEGER NOT NULL,
      campaign_id                 INTEGER NOT NULL
        REFERENCES prospecting_campaigns(id) ON DELETE CASCADE,
      lead_id                     INTEGER NOT NULL
        REFERENCES prospect_leads(id) ON DELETE CASCADE,
      outreach_job_id             INTEGER NOT NULL
        REFERENCES prospect_outreach_jobs(id) ON DELETE RESTRICT,
      outcome_event_id            INTEGER NOT NULL
        REFERENCES prospect_outcome_events(id) ON DELETE CASCADE,
      payload                     JSONB NOT NULL,
      payload_hash                TEXT NOT NULL,
      state                       TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (state IN ('PENDING', 'ACKNOWLEDGED')),
      acknowledgment_request      JSONB,
      acknowledgment_request_hash TEXT,
      acknowledgment_receipt      JSONB,
      acknowledgment_receipt_hash TEXT,
      acknowledged_by             TEXT,
      acknowledged_at             TIMESTAMPTZ,
      created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (workspace_id, outcome_event_id),
      CHECK (
        (
          state = 'PENDING'
          AND acknowledgment_request IS NULL
          AND acknowledgment_request_hash IS NULL
          AND acknowledgment_receipt IS NULL
          AND acknowledgment_receipt_hash IS NULL
          AND acknowledged_by IS NULL
          AND acknowledged_at IS NULL
        )
        OR
        (
          state = 'ACKNOWLEDGED'
          AND acknowledgment_request IS NOT NULL
          AND acknowledgment_request_hash IS NOT NULL
          AND acknowledgment_receipt IS NOT NULL
          AND acknowledgment_receipt_hash IS NOT NULL
          AND acknowledged_by IS NOT NULL
          AND acknowledged_at IS NOT NULL
        )
      )
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_positive_outcome_reviews_pending
    ON prospect_positive_outcome_reviews(
      workspace_id, created_at, review_id
    )
    WHERE state = 'PENDING'
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS prospect_positive_outcome_review_events (
      id              SERIAL PRIMARY KEY,
      event_id        TEXT NOT NULL UNIQUE,
      workspace_id    INTEGER NOT NULL,
      review_row_id   INTEGER NOT NULL
        REFERENCES prospect_positive_outcome_reviews(id) ON DELETE CASCADE,
      from_state      TEXT,
      to_state        TEXT NOT NULL,
      actor           TEXT NOT NULL,
      receipt_hash    TEXT NOT NULL,
      details         JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_positive_outcome_review_events
    ON prospect_positive_outcome_review_events(
      workspace_id, review_row_id, occurred_at
    )
  `;
  await backfillPositiveOutcomeReviews();
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
    CREATE TABLE IF NOT EXISTS prospect_message_experiments (
      id                      SERIAL PRIMARY KEY,
      experiment_id           TEXT NOT NULL UNIQUE,
      workspace_id            INTEGER NOT NULL,
      campaign_id             INTEGER NOT NULL
        REFERENCES prospecting_campaigns(id) ON DELETE CASCADE,
      channel                 TEXT NOT NULL CHECK (channel IN ('email', 'call')),
      state                   TEXT NOT NULL DEFAULT 'PREPARED'
        CHECK (state IN ('PREPARED', 'ACTIVE', 'CLOSED', 'CANCELLED')),
      control_variant_key     TEXT NOT NULL,
      challenger_variant_key  TEXT NOT NULL,
      allocation_basis_points INTEGER NOT NULL DEFAULT 5000
        CHECK (allocation_basis_points = 5000),
      definition              JSONB NOT NULL,
      definition_hash         TEXT NOT NULL,
      prepared_by             TEXT NOT NULL,
      activated_by            TEXT,
      activated_at            TIMESTAMPTZ,
      closed_by               TEXT,
      closed_at               TIMESTAMPTZ,
      inbox_placement_test_id  TEXT,
      inbox_placement_receipt_hash TEXT,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (control_variant_key <> challenger_variant_key)
    )
  `;
  await sql`ALTER TABLE prospect_message_experiments ADD COLUMN IF NOT EXISTS inbox_placement_test_id TEXT`;
  await sql`ALTER TABLE prospect_message_experiments ADD COLUMN IF NOT EXISTS inbox_placement_receipt_hash TEXT`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prospect_message_experiment_active
    ON prospect_message_experiments(workspace_id, campaign_id, channel)
    WHERE state = 'ACTIVE'
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prospect_message_experiment_enrollment
    ON prospect_outreach_jobs(
      workspace_id,
      lead_id,
      ((payload->'experimentAssignment'->>'experimentId'))
    )
    WHERE payload->'experimentAssignment'->>'experimentId' IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_prospect_message_experiments_workspace
    ON prospect_message_experiments(workspace_id, created_at DESC)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS prospect_message_experiment_events (
      id                  SERIAL PRIMARY KEY,
      event_id            TEXT NOT NULL UNIQUE,
      workspace_id        INTEGER NOT NULL,
      experiment_row_id   INTEGER NOT NULL
        REFERENCES prospect_message_experiments(id) ON DELETE CASCADE,
      from_state          TEXT,
      to_state            TEXT NOT NULL,
      actor               TEXT NOT NULL,
      definition_hash     TEXT NOT NULL,
      details             JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_prospect_message_experiment_events
    ON prospect_message_experiment_events(
      workspace_id, experiment_row_id, occurred_at
    )
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
  await sql`
    CREATE TABLE IF NOT EXISTS prospect_message_policy_releases (
      id                    SERIAL PRIMARY KEY,
      release_id            TEXT NOT NULL UNIQUE,
      workspace_id          INTEGER NOT NULL,
      campaign_id           INTEGER NOT NULL
        REFERENCES prospecting_campaigns(id) ON DELETE RESTRICT,
      channel               TEXT NOT NULL
        CHECK (channel IN ('email', 'call')),
      version               INTEGER NOT NULL CHECK (version > 0),
      action                TEXT NOT NULL
        CHECK (action IN ('PROMOTE', 'ROLLBACK')),
      champion_variant_key  TEXT NOT NULL,
      previous_champion_variant_key TEXT NOT NULL,
      source_candidate_id   INTEGER
        REFERENCES prospect_learning_candidates(id) ON DELETE RESTRICT,
      rollback_of_release_id TEXT,
      release               JSONB NOT NULL,
      release_hash          TEXT NOT NULL,
      applied_by            TEXT NOT NULL,
      applied_at            TIMESTAMPTZ NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (workspace_id, campaign_id, channel, version),
      CHECK (champion_variant_key <> previous_champion_variant_key),
      CHECK (
        (action = 'PROMOTE' AND source_candidate_id IS NOT NULL
          AND rollback_of_release_id IS NULL)
        OR
        (action = 'ROLLBACK' AND source_candidate_id IS NULL
          AND rollback_of_release_id IS NOT NULL)
      )
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prospect_message_policy_candidate
    ON prospect_message_policy_releases(
      workspace_id, source_candidate_id
    )
    WHERE action = 'PROMOTE' AND source_candidate_id IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_prospect_message_policy_current
    ON prospect_message_policy_releases(
      workspace_id, campaign_id, channel, version DESC
    )
  `;
  console.log("[prospector] Prospector schema OK.");
}

// ── Campaign CRUD ──────────────────────────────────────────────────────────────

export async function getCampaigns(workspaceId: number): Promise<ProspectingCampaign[]> {
  return sql<ProspectingCampaign[]>`
    SELECT
      c.*,
      COUNT(l.id)::int AS total_leads,
      COUNT(l.id) FILTER (WHERE l.status != 'pending')::int AS called,
      COUNT(l.id) FILTER (WHERE l.status = 'interested')::int AS interested,
      COUNT(l.id) FILTER (WHERE l.status = 'not_interested')::int
        AS not_interested,
      COUNT(l.id) FILTER (WHERE l.status = 'voicemail')::int AS voicemails
    FROM prospecting_campaigns c
    LEFT JOIN prospect_leads l ON l.campaign_id = c.id
    WHERE c.workspace_id = ${workspaceId}
      AND c.external_source IS DISTINCT FROM ${SMIRK_INTERNAL_INBOX_SEED_SOURCE}
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `;
}

export async function getCampaignById(id: number, workspaceId: number): Promise<ProspectingCampaign | null> {
  const rows = await sql<ProspectingCampaign[]>`
    SELECT
      c.*,
      COUNT(l.id)::int AS total_leads,
      COUNT(l.id) FILTER (WHERE l.status != 'pending')::int AS called,
      COUNT(l.id) FILTER (WHERE l.status = 'interested')::int AS interested,
      COUNT(l.id) FILTER (WHERE l.status = 'not_interested')::int
        AS not_interested,
      COUNT(l.id) FILTER (WHERE l.status = 'voicemail')::int AS voicemails
    FROM prospecting_campaigns c
    LEFT JOIN prospect_leads l ON l.campaign_id = c.id
    WHERE c.id = ${id} AND c.workspace_id = ${workspaceId}
      AND c.external_source IS DISTINCT FROM ${SMIRK_INTERNAL_INBOX_SEED_SOURCE}
    GROUP BY c.id
  `;
  return rows[0] || null;
}

export async function createCampaign(
  data: Partial<ProspectingCampaign>,
  workspaceId: number,
  db: any = sql
): Promise<ProspectingCampaign> {
  const rows = (await db`
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
  `) as ProspectingCampaign[];
  return rows[0];
}

export async function updateCampaignStatus(
  id: number,
  status: ProspectingCampaign["status"],
  workspaceId: number,
  db: any = sql
): Promise<boolean> {
  const rows = (await db`
    UPDATE prospecting_campaigns
    SET status = ${status}
    WHERE id = ${id} AND workspace_id = ${workspaceId}
    RETURNING id
  `) as Array<{ id: number }>;
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
        AND c.external_source IS DISTINCT FROM ${SMIRK_INTERNAL_INBOX_SEED_SOURCE}
      ORDER BY l.created_at DESC
    `;
  }
  if (campaignId) {
    return sql<ProspectLead[]>`
      SELECT l.* FROM prospect_leads l
      JOIN prospecting_campaigns c ON c.id = l.campaign_id
      WHERE c.workspace_id = ${workspaceId}
        AND l.campaign_id = ${campaignId}
        AND c.external_source IS DISTINCT FROM ${SMIRK_INTERNAL_INBOX_SEED_SOURCE}
      ORDER BY l.created_at DESC
    `;
  }
  return sql<ProspectLead[]>`
    SELECT l.* FROM prospect_leads l
    JOIN prospecting_campaigns c ON c.id = l.campaign_id
    WHERE c.workspace_id = ${workspaceId}
      AND c.external_source IS DISTINCT FROM ${SMIRK_INTERNAL_INBOX_SEED_SOURCE}
      ${status ? sql`AND l.status = ${status}` : sql``}
    ORDER BY l.created_at DESC
    LIMIT 200
  `;
}

export async function addLeads(
  campaignId: number,
  leads: Partial<ProspectLead & { score?: number; personalized_hook?: string }>[],
  workspaceId: number,
  db: any = sql
): Promise<number> {
  const campaignRows = (await db`
    SELECT id
    FROM prospecting_campaigns
    WHERE id = ${campaignId}
      AND workspace_id = ${workspaceId}
      AND external_source IS DISTINCT FROM ${SMIRK_INTERNAL_INBOX_SEED_SOURCE}
    LIMIT 1
  `) as Array<{ id: number }>;
  if (!campaignRows[0]) throw new Error("Campaign not found");

  let added = 0;
  for (const lead of leads) {
    if (!lead.business_name || (!lead.phone && !lead.email && !lead.website)) continue;
    const score = (lead as any).score ?? null;
    const hook = (lead as any).personalized_hook ?? (lead as any).personalizedHook ?? null;
    const inserted = (await db`
      INSERT INTO prospect_leads (campaign_id, business_name, phone, email, website, industry, address, city, state, contact_name, contact_title, source, score, personalized_hook)
      VALUES (${campaignId}, ${lead.business_name}, ${lead.phone || null}, ${lead.email || null}, ${lead.website || null}, ${lead.industry || null},
              ${lead.address || null}, ${lead.city || null}, ${lead.state || null},
              ${lead.contact_name || null}, ${lead.contact_title || null}, ${lead.source || "manual"},
              ${score}, ${hook})
      ON CONFLICT DO NOTHING
      RETURNING id
    `) as Array<{ id: number }>;
    added += inserted.length;
  }
  await db`
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
