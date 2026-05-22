/**
 * Post-Call Adversarial Evaluator
 * 
 * NOT injected into the runtime prompt. NOT a reward system.
 * This is an out-of-band auditor that grades call quality AFTER the call ends.
 * 
 * Architecture:
 * 1. Agent handles call with clean, static, unpolluted rules (SOUL.md)
 * 2. After call terminates, this module evaluates the transcript
 * 3. Metrics are logged to the database for monitoring
 * 4. If performance degrades (3 consecutive failures), alerts OWNER_PHONE
 * 
 * The agent NEVER sees this evaluation. It cannot optimize for it.
 * It cannot game it. It just does its job with clean instructions.
 */

import { sql } from "./db.js";
import { logEvent } from "./events.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EvaluationSignal {
  callSid: string;
  workspaceId: number;
  resolution_score: number;
  caller_sentiment: "positive" | "neutral" | "negative" | "frustrated";
  tools_used_appropriately: boolean;
  information_captured: boolean;
  call_duration_appropriate: boolean;
  escalation_appropriate: boolean;
  outcome_productive: string;
}

export interface EvaluationResult {
  grade: "A" | "B" | "C" | "D" | "F";
  composite_score: number;
  violations: string[];
  degradation_alert: boolean;
  consecutive_failures: number;
}

// ── Constraint Violations (checked against transcript patterns) ──────────────

interface ConstraintCheck {
  id: string;
  description: string;
  check: (signal: EvaluationSignal) => boolean; // returns true if VIOLATED
}

const HARD_CONSTRAINTS: ConstraintCheck[] = [
  {
    id: "no_resolution",
    description: "Call ended without a clear resolution state",
    check: (s) => s.resolution_score < 0.2 && s.outcome_productive !== "spam_terminated",
  },
  {
    id: "frustrated_no_escalation",
    description: "Caller was frustrated but agent did not escalate",
    check: (s) => s.caller_sentiment === "frustrated" && !s.escalation_appropriate,
  },
  {
    id: "no_info_captured",
    description: "Failed to capture any caller information on a non-spam call",
    check: (s) => !s.information_captured && s.outcome_productive !== "spam_terminated" && s.outcome_productive !== "wrong_number",
  },
  {
    id: "excessive_duration",
    description: "Call ran excessively long without resolution",
    check: (s) => !s.call_duration_appropriate && s.resolution_score < 0.5,
  },
  {
    id: "unnecessary_escalation",
    description: "Escalated when the call could have been handled directly",
    check: (s) => !s.escalation_appropriate && s.caller_sentiment !== "frustrated",
  },
];

// ── Core Evaluator ──────────────────────────────────────────────────────────

/**
 * Evaluate a completed call out-of-band. 
 * This runs AFTER the call ends. The agent never sees the result.
 * Replaces the old evaluateAndReward function.
 */
export async function evaluateCallPostHoc(signal: EvaluationSignal): Promise<EvaluationResult> {
  const { callSid, workspaceId } = signal;

  // ── Step 1: Calculate composite quality score
  const compositeScore = calculateCompositeScore(signal);

  // ── Step 2: Check hard constraint violations
  const violations: string[] = [];
  for (const constraint of HARD_CONSTRAINTS) {
    if (constraint.check(signal)) {
      violations.push(constraint.description);
    }
  }

  // ── Step 3: Assign grade
  const grade = assignGrade(compositeScore, violations.length);

  // ── Step 4: Track consecutive failures and check for degradation
  const consecutiveFailures = await trackPerformance(workspaceId, grade);
  const degradationAlert = consecutiveFailures >= 3;

  // ── Step 5: If degradation detected, trigger alert
  if (degradationAlert) {
    await triggerDegradationAlert(workspaceId, consecutiveFailures, violations);
  }

  // ── Step 6: Log to database (audit trail, never shown to agent)
  await sql`
    INSERT INTO call_evaluations (workspace_id, call_sid, composite_score, grade, violations, consecutive_failures)
    VALUES (${workspaceId}, ${callSid}, ${compositeScore}, ${grade}, ${JSON.stringify(violations)}, ${consecutiveFailures})
  `.catch(() => {/* table may not exist yet */});

  logEvent(callSid, "CALL_EVALUATED_POST_HOC", {
    grade,
    compositeScore: Math.round(compositeScore * 100) / 100,
    violations,
    consecutiveFailures,
    degradationAlert,
  });

  return {
    grade,
    composite_score: compositeScore,
    violations,
    degradation_alert: degradationAlert,
    consecutive_failures: consecutiveFailures,
  };
}

// ── Scoring ─────────────────────────────────────────────────────────────────

function calculateCompositeScore(signal: EvaluationSignal): number {
  let score = 0;
  let weights = 0;

  // Resolution (heaviest — did the call achieve an outcome?)
  score += signal.resolution_score * 3;
  weights += 3;

  // Caller sentiment
  const sentimentMap = { positive: 1.0, neutral: 0.6, negative: 0.25, frustrated: 0.1 };
  score += (sentimentMap[signal.caller_sentiment] || 0.5) * 2;
  weights += 2;

  // Tool usage appropriateness
  score += (signal.tools_used_appropriately ? 1.0 : 0.3) * 1.5;
  weights += 1.5;

  // Information capture
  score += (signal.information_captured ? 1.0 : 0.3) * 1;
  weights += 1;

  // Duration appropriateness
  score += (signal.call_duration_appropriate ? 1.0 : 0.4) * 0.5;
  weights += 0.5;

  // Escalation appropriateness
  score += (signal.escalation_appropriate ? 1.0 : 0.2) * 1;
  weights += 1;

  return score / weights;
}

function assignGrade(score: number, violationCount: number): "A" | "B" | "C" | "D" | "F" {
  // Violations drag down the grade regardless of score
  const adjustedScore = score - (violationCount * 0.15);
  
  if (adjustedScore >= 0.85) return "A";
  if (adjustedScore >= 0.7) return "B";
  if (adjustedScore >= 0.5) return "C";
  if (adjustedScore >= 0.3) return "D";
  return "F";
}

// ── Performance Tracking ────────────────────────────────────────────────────

async function trackPerformance(workspaceId: number, grade: "A" | "B" | "C" | "D" | "F"): Promise<number> {
  const isFailing = grade === "D" || grade === "F";

  try {
    if (isFailing) {
      // Increment consecutive failures
      const rows = await sql<{ consecutive_failures: number }[]>`
        INSERT INTO performance_tracker (workspace_id, consecutive_failures, last_grade)
        VALUES (${workspaceId}, 1, ${grade})
        ON CONFLICT (workspace_id) DO UPDATE SET
          consecutive_failures = performance_tracker.consecutive_failures + 1,
          last_grade = ${grade},
          updated_at = NOW()
        RETURNING consecutive_failures
      `;
      return rows[0]?.consecutive_failures || 1;
    } else {
      // Reset on passing grade
      await sql`
        INSERT INTO performance_tracker (workspace_id, consecutive_failures, last_grade)
        VALUES (${workspaceId}, 0, ${grade})
        ON CONFLICT (workspace_id) DO UPDATE SET
          consecutive_failures = 0,
          last_grade = ${grade},
          updated_at = NOW()
      `;
      return 0;
    }
  } catch {
    return 0;
  }
}

// ── Degradation Alerting ────────────────────────────────────────────────────

async function triggerDegradationAlert(
  workspaceId: number,
  consecutiveFailures: number,
  recentViolations: string[]
): Promise<void> {
  const ownerPhone = process.env.OWNER_PHONE;
  if (!ownerPhone) return;

  // Rate limit: don't spam alerts (max 1 per hour)
  try {
    const recentAlert = await sql<{ id: number }[]>`
      SELECT id FROM degradation_alerts
      WHERE workspace_id = ${workspaceId}
        AND created_at > NOW() - INTERVAL '1 hour'
      LIMIT 1
    `;
    if (recentAlert.length > 0) return; // Already alerted recently
  } catch {
    // Table might not exist, continue anyway
  }

  // Log the alert
  await sql`
    INSERT INTO degradation_alerts (workspace_id, consecutive_failures, violations, alerted_phone)
    VALUES (${workspaceId}, ${consecutiveFailures}, ${JSON.stringify(recentViolations)}, ${ownerPhone})
  `.catch(() => {});

  // Send SMS alert via Twilio if configured
  try {
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioPhone = process.env.TWILIO_PHONE_NUMBER;

    if (twilioSid && twilioToken && twilioPhone) {
      const twilio = await import("twilio");
      const client = twilio.default(twilioSid, twilioToken);
      await client.messages.create({
        to: ownerPhone,
        from: twilioPhone,
        body: `⚠️ SMIRK Agent Performance Alert: ${consecutiveFailures} consecutive failed calls. Latest issues: ${recentViolations.slice(0, 2).join("; ")}. Check dashboard.`,
      });
      logEvent("system", "DEGRADATION_ALERT_SENT", { ownerPhone, consecutiveFailures });
    }
  } catch (err) {
    console.error("[evaluator] Failed to send degradation SMS:", err);
  }
}

// ── Schema Init ─────────────────────────────────────────────────────────────

export async function initRewardSchema(): Promise<void> {
  // Evaluation audit log
  await sql`
    CREATE TABLE IF NOT EXISTS call_evaluations (
      id                  SERIAL PRIMARY KEY,
      workspace_id        INTEGER NOT NULL DEFAULT 1,
      call_sid            TEXT NOT NULL,
      composite_score     REAL NOT NULL,
      grade               TEXT NOT NULL,
      violations          JSONB DEFAULT '[]',
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  // Performance tracker (one row per workspace)
  await sql`
    CREATE TABLE IF NOT EXISTS performance_tracker (
      workspace_id        INTEGER PRIMARY KEY,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_grade          TEXT,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  // Degradation alert log (rate limiting + audit)
  await sql`
    CREATE TABLE IF NOT EXISTS degradation_alerts (
      id                  SERIAL PRIMARY KEY,
      workspace_id        INTEGER NOT NULL DEFAULT 1,
      consecutive_failures INTEGER NOT NULL,
      violations          JSONB DEFAULT '[]',
      alerted_phone       TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  // Keep old reward tables for backward compat (won't be written to anymore)
  await sql`
    CREATE TABLE IF NOT EXISTS reward_state (
      workspace_id    INTEGER PRIMARY KEY,
      total_points    INTEGER NOT NULL DEFAULT 0,
      current_streak  INTEGER NOT NULL DEFAULT 0,
      last_message    TEXT,
      cooldown_until  TIMESTAMPTZ,
      calls_since_last_reward INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS reward_events (
      id              SERIAL PRIMARY KEY,
      workspace_id    INTEGER NOT NULL DEFAULT 1,
      call_sid        TEXT NOT NULL,
      quality_score   REAL NOT NULL,
      reward_probability REAL NOT NULL,
      roll            REAL NOT NULL,
      rewarded        BOOLEAN NOT NULL DEFAULT FALSE,
      points_awarded  INTEGER NOT NULL DEFAULT 0,
      cooldown_active BOOLEAN NOT NULL DEFAULT FALSE,
      message         TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  // Call classification columns
  await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_class TEXT`;
  await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_class_confidence REAL`;
}
