/**
 * Sequence Engine — Multi-step outbound follow-up automation
 *
 * After a prospecting call completes, this engine schedules and executes
 * a configurable sequence of follow-up steps:
 *
 *   Step 1: Call (handled by prospector.ts / dialNextLead)
 *   Step 2: SMS (auto-sent after voicemail or no-answer, delay configurable)
 *   Step 3: Callback call (if no reply to SMS, dial again after N days)
 *   Step 4: Final SMS (close-out message)
 *
 * The engine runs as a background job (called from a setInterval in server.ts)
 * and processes all due sequence steps across all active campaigns.
 *
 * Schema: prospect_sequence_steps table (created in initSequenceSchema)
 */

import { sql } from "./db.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type SequenceStepType = "sms" | "call" | "email";
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

export const DEFAULT_SEQUENCES: Record<string, SequenceTemplate> = {
  // Standard 4-touch sequence for home services
  home_services: {
    steps: [
      // Step 1 is the initial call — handled by dialNextLead, not here
      {
        step_number: 2,
        step_type: "sms",
        delay_hours: 0.5, // 30 min after voicemail/no-answer
        message_template:
          "Hi {{name}}, this is SMIRK AI calling on behalf of a local service company. We left you a voicemail about a quick way to never miss another customer call. Reply STOP to opt out, or call us back at {{from_number}}.",
      },
      {
        step_number: 3,
        step_type: "call",
        delay_hours: 48, // 2 days later
        message_template: "", // uses campaign pitch script
      },
      {
        step_number: 4,
        step_type: "sms",
        delay_hours: 72, // 3 days after step 3
        message_template:
          "Hi {{name}}, last follow-up from SMIRK AI. If you're ever losing jobs because you can't answer every call, we can fix that for less than $10/day. No pressure — just wanted to leave the door open. Reply STOP to opt out.",
      },
    ],
  },
  // Aggressive 2-touch for high-volume campaigns
  quick_touch: {
    steps: [
      {
        step_number: 2,
        step_type: "sms",
        delay_hours: 1,
        message_template:
          "Hi {{name}}, tried calling about an AI phone answering solution for {{company}}. Interested in a free 30-day trial? Reply YES or call {{from_number}}. Reply STOP to opt out.",
      },
    ],
  },
};

// ── Schema ─────────────────────────────────────────────────────────────────────

export async function initSequenceSchema(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS prospect_sequence_steps (
      id               SERIAL PRIMARY KEY,
      campaign_id      INTEGER NOT NULL REFERENCES prospecting_campaigns(id) ON DELETE CASCADE,
      lead_id          INTEGER NOT NULL REFERENCES prospect_leads(id) ON DELETE CASCADE,
      step_number      INTEGER NOT NULL DEFAULT 2,
      step_type        TEXT NOT NULL DEFAULT 'sms',
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
  await sql`ALTER TABLE prospecting_campaigns ADD COLUMN IF NOT EXISTS sequence_enabled BOOLEAN NOT NULL DEFAULT TRUE`;
}

// ── Schedule steps after a call outcome ───────────────────────────────────────

/**
 * Called after a prospect call completes with a terminal outcome.
 * Schedules the appropriate follow-up steps based on the campaign's sequence template.
 */
export async function scheduleFollowUpSteps(
  campaignId: number,
  leadId: number,
  callOutcome: "voicemail" | "no_answer" | "interested" | "not_interested" | "callback"
): Promise<number> {
  // Don't schedule follow-ups for terminal outcomes
  if (callOutcome === "not_interested") return 0;
  if (callOutcome === "interested") return 0; // already converting, no spam

  // Get campaign to find sequence template
  const [campaign] = await sql<{ sequence_template: string; sequence_enabled: boolean; name: string }[]>`
    SELECT sequence_template, sequence_enabled, name FROM prospecting_campaigns WHERE id = ${campaignId}
  `;
  if (!campaign || !campaign.sequence_enabled) return 0;

  const template = DEFAULT_SEQUENCES[campaign.sequence_template] || DEFAULT_SEQUENCES.home_services;

  // Get lead info for message personalization
  const [lead] = await sql<{ business_name: string; phone: string; contact_name?: string }[]>`
    SELECT business_name, phone, contact_name FROM prospect_leads WHERE id = ${leadId}
  `;
  if (!lead) return 0;

  // Check if steps already scheduled for this lead (avoid duplicates)
  const existing = await sql<{ count: string }[]>`
    SELECT COUNT(*) as count FROM prospect_sequence_steps
    WHERE lead_id = ${leadId} AND status = 'pending'
  `;
  if (parseInt(existing[0]?.count || "0") > 0) return 0;

  let scheduled = 0;
  const now = new Date();

  for (const step of template.steps) {
    // For voicemail, start from step 2. For no_answer, start from step 2 as well.
    // For callback, start from step 3 (already had one SMS).
    if (callOutcome === "callback" && step.step_number <= 2) continue;

    const scheduledAt = new Date(now.getTime() + step.delay_hours * 60 * 60 * 1000);

    await sql`
      INSERT INTO prospect_sequence_steps
        (campaign_id, lead_id, step_number, step_type, message_template, delay_hours, scheduled_at)
      VALUES
        (${campaignId}, ${leadId}, ${step.step_number}, ${step.step_type},
         ${step.message_template || null}, ${step.delay_hours}, ${scheduledAt.toISOString()})
    `;
    scheduled++;
  }

  return scheduled;
}

// ── Execute due steps ──────────────────────────────────────────────────────────

/**
 * Background job: find and execute all sequence steps that are due.
 * Call this from a setInterval every 60 seconds.
 */
export async function executeDueSequenceSteps(
  twilioClient: any,
  fromNumber: string,
  webhookBase: string
): Promise<{ executed: number; failed: number }> {
  const dueSteps = await sql<SequenceStep[]>`
    SELECT s.*, l.business_name, l.phone, l.contact_name, l.status as lead_status,
           c.pitch_script, c.agent_name, c.name as campaign_name, c.call_window_start, c.call_window_end
    FROM prospect_sequence_steps s
    JOIN prospect_leads l ON l.id = s.lead_id
    JOIN prospecting_campaigns c ON c.id = s.campaign_id
    WHERE s.status = 'pending'
      AND s.scheduled_at <= NOW()
      AND l.status NOT IN ('not_interested', 'dnc', 'converted')
      AND c.status = 'active'
    ORDER BY s.scheduled_at ASC
    LIMIT 50
  ` as any[];

  let executed = 0;
  let failed = 0;

  for (const step of dueSteps) {
    try {
      await executeSequenceStep(step, twilioClient, fromNumber, webhookBase);
      await sql`
        UPDATE prospect_sequence_steps
        SET status = 'sent', executed_at = NOW(), result = 'executed'
        WHERE id = ${step.id}
      `;
      executed++;
    } catch (err: any) {
      await sql`
        UPDATE prospect_sequence_steps
        SET status = 'failed', executed_at = NOW(), result = ${err.message || "unknown error"}
        WHERE id = ${step.id}
      `;
      failed++;
    }
  }

  return { executed, failed };
}

async function executeSequenceStep(
  step: any,
  twilioClient: any,
  fromNumber: string,
  webhookBase: string
): Promise<void> {
  const phone = step.phone?.startsWith("+") ? step.phone : `+1${step.phone}`;
  const name = step.contact_name || step.business_name || "there";
  const company = step.business_name || "your business";

  if (step.step_type === "sms") {
    const body = (step.message_template || "")
      .replace(/\{\{name\}\}/g, name)
      .replace(/\{\{company\}\}/g, company)
      .replace(/\{\{from_number\}\}/g, fromNumber);

    await twilioClient.messages.create({
      to: phone,
      from: fromNumber,
      body,
    });

    // Update lead status to 'contacted' if still 'pending'
    await sql`
      UPDATE prospect_leads SET status = 'contacted', called_at = NOW()
      WHERE id = ${step.lead_id} AND status IN ('pending', 'voicemail', 'no_answer')
    `;
  } else if (step.step_type === "call") {
    // Re-dial using the campaign pitch
    const systemPrompt = step.pitch_script || buildDefaultPitch(step.campaign_name, step.agent_name);

    const call = await twilioClient.calls.create({
      to: phone,
      from: fromNumber,
      url: `${webhookBase}/twilio/inbound?agent=${encodeURIComponent(step.agent_name || "FORGE")}&prospectLeadId=${step.lead_id}&campaignId=${step.campaign_id}&systemPromptOverride=${encodeURIComponent(systemPrompt)}`,
      statusCallback: `${webhookBase}/twilio/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["completed", "failed", "no-answer", "busy"],
      machineDetection: "DetectMessageEnd",
      asyncAmdStatusCallback: `${webhookBase}/api/twilio/amd`,
    });

    await sql`UPDATE prospect_leads SET call_sid = ${call.sid}, status = 'calling' WHERE id = ${step.lead_id}`;
  }
}

function buildDefaultPitch(campaignName: string, agentName: string): string {
  return `You are ${agentName || "FORGE"}, an AI sales agent following up on a previous call attempt.

Campaign: ${campaignName}

This is a follow-up call. The person didn't answer or we left a voicemail previously.
Be brief: "Hi, this is ${agentName || "FORGE"} following up — I called earlier about an AI phone answering service that helps businesses never miss a customer call. Do you have 60 seconds?"

If interested: explain SMIRK briefly and offer a free 30-day trial.
If not interested: thank them and mark as not_interested.
If they ask to stop: use mark_do_not_call tool immediately.
Keep it under 60 seconds.`;
}

// ── Sequence stats ─────────────────────────────────────────────────────────────

export async function getSequenceStats(campaignId?: number): Promise<{
  total: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
}> {
  const rows = await sql<{ status: string; count: string }[]>`
    SELECT status, COUNT(*) as count
    FROM prospect_sequence_steps
    ${campaignId ? sql`WHERE campaign_id = ${campaignId}` : sql``}
    GROUP BY status
  `;

  const stats = { total: 0, pending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    const count = parseInt(row.count);
    stats.total += count;
    if (row.status in stats) (stats as any)[row.status] = count;
  }
  return stats;
}

export async function getLeadSequenceSteps(leadId: number): Promise<SequenceStep[]> {
  return sql<SequenceStep[]>`
    SELECT * FROM prospect_sequence_steps
    WHERE lead_id = ${leadId}
    ORDER BY step_number ASC
  `;
}

export async function cancelLeadSequence(leadId: number): Promise<void> {
  await sql`
    UPDATE prospect_sequence_steps
    SET status = 'skipped', executed_at = NOW(), result = 'cancelled by operator'
    WHERE lead_id = ${leadId} AND status = 'pending'
  `;
}
