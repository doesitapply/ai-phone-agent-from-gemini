/**
 * Historical prospect-sequence storage.
 *
 * Automatic prospect contact is disabled. Existing rows remain readable and
 * cancellable for audit purposes, but this module never schedules or executes
 * email, SMS, or phone delivery.
 */

import { sql } from "./db.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type SequenceStepType = "call" | "email";
export type SequenceStepStatus = "pending" | "sent" | "failed" | "skipped";

export interface SequenceStep {
  id: number;
  campaign_id: number;
  lead_id: number;
  step_number: number;
  step_type: SequenceStepType;
  message_template?: string;
  delay_hours: number;
  scheduled_at: string;
  executed_at?: string;
  status: SequenceStepStatus;
  result?: string;
  created_at: string;
}

export interface SequenceTemplate {
  steps: {
    step_number: number;
    step_type: SequenceStepType;
    delay_hours: number;
    message_template: string;
  }[];
}

// ── Default sequence templates ─────────────────────────────────────────────────

export const PROSPECT_SEQUENCE_AUTOMATION_ENABLED = false;

export const DEFAULT_SEQUENCES: Record<string, SequenceTemplate> = {
  home_services: { steps: [] },
  quick_touch: { steps: [] },
};

// ── Schema ─────────────────────────────────────────────────────────────────────

export async function initSequenceSchema(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS prospect_sequence_steps (
      id               SERIAL PRIMARY KEY,
      campaign_id      INTEGER NOT NULL REFERENCES prospecting_campaigns(id) ON DELETE CASCADE,
      lead_id          INTEGER NOT NULL REFERENCES prospect_leads(id) ON DELETE CASCADE,
      step_number      INTEGER NOT NULL DEFAULT 2,
      step_type        TEXT NOT NULL DEFAULT 'email',
      message_template TEXT,
      delay_hours      NUMERIC NOT NULL DEFAULT 0,
      scheduled_at     TIMESTAMPTZ NOT NULL,
      executed_at      TIMESTAMPTZ,
      status           TEXT NOT NULL DEFAULT 'pending',
      result           TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_seq_steps_scheduled ON prospect_sequence_steps(scheduled_at) WHERE status = 'pending'`;
  await sql`CREATE INDEX IF NOT EXISTS idx_seq_steps_lead ON prospect_sequence_steps(lead_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_seq_steps_campaign ON prospect_sequence_steps(campaign_id)`;
  // Add sequence_template column to prospecting_campaigns
  await sql`ALTER TABLE prospecting_campaigns ADD COLUMN IF NOT EXISTS sequence_template TEXT NOT NULL DEFAULT 'home_services'`;
  await sql`ALTER TABLE prospecting_campaigns ADD COLUMN IF NOT EXISTS sequence_enabled BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE prospecting_campaigns ALTER COLUMN sequence_enabled SET DEFAULT FALSE`;
  await sql`UPDATE prospecting_campaigns SET sequence_enabled = FALSE WHERE sequence_enabled IS DISTINCT FROM FALSE`;
}

// ── Schedule steps after a call outcome ───────────────────────────────────────

/**
 * Called after a prospect call completes with a terminal outcome.
 * Schedules the appropriate follow-up steps based on the campaign's sequence template.
 */
export async function scheduleFollowUpSteps(
  _campaignId: number,
  _leadId: number,
  _callOutcome: "voicemail" | "no_answer" | "interested" | "not_interested" | "callback"
): Promise<number> {
  return 0;
}

// ── Execute due steps ──────────────────────────────────────────────────────────

/**
 * Background job: find and execute all sequence steps that are due.
 * Call this from a setInterval every 60 seconds.
 */
export async function executeDueSequenceSteps(
  _twilioClient?: any,
  _fromNumber?: string,
  _webhookBase?: string
): Promise<{ executed: number; failed: number }> {
  return { executed: 0, failed: 0 };
}

// ── Sequence stats ─────────────────────────────────────────────────────────────

export async function getSequenceStats(workspaceId: number, campaignId?: number): Promise<{
  total: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
}> {
  const rows = await sql<{ status: string; count: string }[]>`
    SELECT s.status AS status, COUNT(*) as count
    FROM prospect_sequence_steps s
    JOIN prospecting_campaigns c ON c.id = s.campaign_id
    WHERE c.workspace_id = ${workspaceId}
      ${campaignId ? sql`AND s.campaign_id = ${campaignId}` : sql``}
    GROUP BY s.status
  `;

  const stats = { total: 0, pending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    const count = parseInt(row.count);
    stats.total += count;
    if (row.status in stats) (stats as any)[row.status] = count;
  }
  return stats;
}

export async function getLeadSequenceSteps(leadId: number, workspaceId: number): Promise<SequenceStep[]> {
  return sql<SequenceStep[]>`
    SELECT s.* FROM prospect_sequence_steps s
    JOIN prospecting_campaigns c ON c.id = s.campaign_id
    WHERE s.lead_id = ${leadId}
      AND c.workspace_id = ${workspaceId}
    ORDER BY s.step_number ASC
  `;
}

export async function cancelLeadSequence(leadId: number, workspaceId: number): Promise<boolean> {
  const rows = await sql<{ id: number }[]>`
    UPDATE prospect_sequence_steps s
    SET status = 'skipped', executed_at = NOW(), result = 'cancelled by operator'
    WHERE s.lead_id = ${leadId}
      AND s.status = 'pending'
      AND EXISTS (
        SELECT 1
        FROM prospecting_campaigns c
        WHERE c.id = s.campaign_id
          AND c.workspace_id = ${workspaceId}
      )
    RETURNING s.id
  `;
  return rows.length > 0;
}
