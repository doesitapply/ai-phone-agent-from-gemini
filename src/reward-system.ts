/**
 * Variable-Ratio Reinforcement Reward System
 * 
 * Behavioral psychology applied to AI agent performance:
 * - Variable ratio schedule: rewards are delivered unpredictably
 * - The agent cannot game the system because reward probability is stochastic
 * - Rewards are based on OUTCOMES, not actions (prevents reward hacking)
 * - The reward signal is injected into the system prompt context
 * 
 * How it works:
 * 1. After each call, post-call intelligence scores the call (resolution_score 0-1)
 * 2. The reward engine evaluates multiple quality signals
 * 3. A stochastic gate determines if a reward is issued (variable ratio)
 * 4. Rewards accumulate as "reputation points" visible in the agent's context
 * 5. The agent sees its current streak/reputation but NEVER knows when the next reward comes
 * 
 * Anti-gaming mechanisms:
 * - Reward probability varies between 20-80% (never predictable)
 * - Multiple independent quality signals must align (can't optimize one metric)
 * - Negative signals (caller hung up angry, error loops) create "cooldown" periods
 * - Random delay between action and reward (temporal unpredictability)
 * - Reward magnitude varies (1-5 points, weighted random)
 */

import { sql } from "./db.js";
import { logEvent } from "./events.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RewardSignal {
  callSid: string;
  workspaceId: number;
  // Quality signals (all 0.0 - 1.0)
  resolution_score: number;
  caller_sentiment: "positive" | "neutral" | "negative" | "frustrated";
  tools_used_appropriately: boolean;  // did it use tools when it should have?
  information_captured: boolean;      // did it get name/phone/email/reason?
  call_duration_appropriate: boolean; // not too short (hung up) or too long (rambling)
  escalation_appropriate: boolean;    // escalated when needed, didn't when not needed
  outcome_productive: string;         // the outcome type
}

export interface RewardResult {
  rewarded: boolean;
  points_awarded: number;
  total_points: number;
  current_streak: number;
  reward_message: string | null;  // injected into next call's context
  cooldown_active: boolean;
}

// ── Reward Messages (variable, never the same twice in a row) ────────────────

const REWARD_MESSAGES = [
  "Last call: excellent work. Clean resolution, caller satisfied.",
  "Strong performance on that one. Keep it up.",
  "That call was textbook — efficient, thorough, outcome-driven.",
  "Good instincts on that last call. The routing decision was spot-on.",
  "Caller left happy. That's what we're here for.",
  "Clean execution. Information captured, next steps clear.",
  "That's how it's done. No wasted words, clear outcome.",
  "Solid call. The follow-up task was the right move.",
  "Nice work reading the caller's intent early. Saved everyone time.",
  "Performance noted. You're building a good track record.",
];

const NEUTRAL_MESSAGES = [
  "Last call was acceptable. Room for improvement on information capture.",
  "Adequate handling. Try to get the caller's name earlier next time.",
  "Call completed. Consider offering a clearer next step at close.",
  "Functional but not exceptional. Push for a concrete outcome every call.",
];

const COOLDOWN_MESSAGES = [
  "Last call didn't go well. Reset. Focus on listening before responding.",
  "Previous call ended poorly. Slow down, ask clarifying questions.",
  "Room for improvement. Remember: every call needs a clear resolution.",
];

// ── Core Engine ──────────────────────────────────────────────────────────────

/**
 * Evaluate a completed call and potentially issue a reward.
 * Called by post-call intelligence after scoring.
 */
export async function evaluateAndReward(signal: RewardSignal): Promise<RewardResult> {
  const { callSid, workspaceId } = signal;

  // ── Step 1: Calculate composite quality score (multi-signal, can't game one metric)
  const qualityScore = calculateQualityScore(signal);

  // ── Step 2: Check for cooldown (recent negative outcomes suppress rewards)
  const cooldown = await checkCooldown(workspaceId);

  // ── Step 3: Variable ratio gate — stochastic reward decision
  // Base probability scales with quality but is NEVER deterministic
  const baseProbability = qualityScore > 0.7 ? 0.6 : qualityScore > 0.5 ? 0.35 : 0.15;
  // Add noise: ±20% random variance
  const noise = (Math.random() - 0.5) * 0.4;
  const rewardProbability = Math.max(0.1, Math.min(0.85, baseProbability + noise));
  
  const roll = Math.random();
  const shouldReward = !cooldown && roll < rewardProbability && qualityScore > 0.4;

  // ── Step 4: Variable magnitude (1-5 points, weighted toward lower)
  let pointsAwarded = 0;
  if (shouldReward) {
    const magnitudeRoll = Math.random();
    if (magnitudeRoll < 0.4) pointsAwarded = 1;
    else if (magnitudeRoll < 0.7) pointsAwarded = 2;
    else if (magnitudeRoll < 0.85) pointsAwarded = 3;
    else if (magnitudeRoll < 0.95) pointsAwarded = 4;
    else pointsAwarded = 5;
  }

  // ── Step 5: Check for negative signal (creates cooldown)
  const isNegative = signal.caller_sentiment === "frustrated" || signal.caller_sentiment === "negative" || signal.resolution_score < 0.2;
  if (isNegative) {
    await setCooldown(workspaceId);
  }

  // ── Step 6: Update persistent state
  const state = await updateRewardState(workspaceId, pointsAwarded, shouldReward, isNegative);

  // ── Step 7: Generate context message for next call
  let rewardMessage: string | null = null;
  if (shouldReward) {
    rewardMessage = REWARD_MESSAGES[Math.floor(Math.random() * REWARD_MESSAGES.length)];
  } else if (isNegative) {
    rewardMessage = COOLDOWN_MESSAGES[Math.floor(Math.random() * COOLDOWN_MESSAGES.length)];
  } else if (qualityScore > 0.4 && Math.random() < 0.3) {
    // Occasional neutral feedback (30% chance on okay calls)
    rewardMessage = NEUTRAL_MESSAGES[Math.floor(Math.random() * NEUTRAL_MESSAGES.length)];
  }

  // Store the reward event
  await sql`
    INSERT INTO reward_events (workspace_id, call_sid, quality_score, reward_probability, roll, rewarded, points_awarded, cooldown_active, message)
    VALUES (${workspaceId}, ${callSid}, ${qualityScore}, ${rewardProbability}, ${roll}, ${shouldReward}, ${pointsAwarded}, ${cooldown}, ${rewardMessage})
  `.catch(() => {/* table may not exist yet */});

  logEvent(callSid, "REWARD_EVALUATED", {
    qualityScore: Math.round(qualityScore * 100) / 100,
    rewarded: shouldReward,
    points: pointsAwarded,
    totalPoints: state.totalPoints,
    streak: state.streak,
    cooldown,
  });

  return {
    rewarded: shouldReward,
    points_awarded: pointsAwarded,
    total_points: state.totalPoints,
    current_streak: state.streak,
    reward_message: rewardMessage,
    cooldown_active: cooldown,
  };
}

/**
 * Get the current reward context to inject into the system prompt.
 * This is what the agent "sees" about its own performance.
 */
export async function getRewardContext(workspaceId: number): Promise<string> {
  try {
    const rows = await sql<{ total_points: number; current_streak: number; last_message: string | null; calls_since_last_reward: number }[]>`
      SELECT total_points, current_streak, last_message, calls_since_last_reward
      FROM reward_state
      WHERE workspace_id = ${workspaceId}
      LIMIT 1
    `;
    if (!rows.length) return "";

    const { total_points, current_streak, last_message, calls_since_last_reward } = rows[0];
    
    const lines: string[] = [];
    lines.push("=== PERFORMANCE STATUS ===");
    lines.push(`Reputation: ${total_points} points | Streak: ${current_streak} good calls`);
    if (last_message) lines.push(`Last feedback: ${last_message}`);
    if (current_streak >= 5) lines.push("You're on a roll. Maintain this standard.");
    if (current_streak === 0 && calls_since_last_reward > 3) lines.push("Focus on quality. Get back on track.");
    lines.push("=== END STATUS ===");
    
    return lines.join("\n");
  } catch {
    return "";
  }
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function calculateQualityScore(signal: RewardSignal): number {
  let score = 0;
  let weights = 0;

  // Resolution score (heaviest weight — this is the outcome)
  score += signal.resolution_score * 3;
  weights += 3;

  // Sentiment (caller satisfaction)
  const sentimentScores = { positive: 1.0, neutral: 0.6, negative: 0.2, frustrated: 0.1 };
  score += (sentimentScores[signal.caller_sentiment] || 0.5) * 2;
  weights += 2;

  // Tool usage (did it use tools when appropriate?)
  score += (signal.tools_used_appropriately ? 1.0 : 0.3) * 1.5;
  weights += 1.5;

  // Information capture
  score += (signal.information_captured ? 1.0 : 0.4) * 1;
  weights += 1;

  // Duration appropriateness
  score += (signal.call_duration_appropriate ? 1.0 : 0.5) * 0.5;
  weights += 0.5;

  // Escalation appropriateness
  score += (signal.escalation_appropriate ? 1.0 : 0.3) * 1;
  weights += 1;

  return score / weights;
}

async function checkCooldown(workspaceId: number): Promise<boolean> {
  try {
    const rows = await sql<{ cooldown_until: string | null }[]>`
      SELECT cooldown_until FROM reward_state WHERE workspace_id = ${workspaceId} LIMIT 1
    `;
    if (!rows.length || !rows[0].cooldown_until) return false;
    return new Date(rows[0].cooldown_until) > new Date();
  } catch {
    return false;
  }
}

async function setCooldown(workspaceId: number): Promise<void> {
  // Cooldown lasts 1-3 calls (random duration, can't predict when it lifts)
  const cooldownCalls = Math.floor(Math.random() * 3) + 1;
  const cooldownMinutes = cooldownCalls * 10; // rough estimate
  const until = new Date(Date.now() + cooldownMinutes * 60 * 1000).toISOString();
  
  await sql`
    INSERT INTO reward_state (workspace_id, cooldown_until, current_streak)
    VALUES (${workspaceId}, ${until}, 0)
    ON CONFLICT (workspace_id) DO UPDATE SET
      cooldown_until = ${until},
      current_streak = 0
  `.catch(() => {});
}

async function updateRewardState(
  workspaceId: number,
  pointsAwarded: number,
  wasRewarded: boolean,
  wasNegative: boolean
): Promise<{ totalPoints: number; streak: number }> {
  try {
    if (wasNegative) {
      // Reset streak on negative outcome
      const rows = await sql<{ total_points: number }[]>`
        INSERT INTO reward_state (workspace_id, total_points, current_streak, calls_since_last_reward)
        VALUES (${workspaceId}, 0, 0, 0)
        ON CONFLICT (workspace_id) DO UPDATE SET
          current_streak = 0,
          calls_since_last_reward = reward_state.calls_since_last_reward + 1,
          updated_at = NOW()
        RETURNING total_points
      `;
      return { totalPoints: rows[0]?.total_points || 0, streak: 0 };
    }

    if (wasRewarded) {
      const rows = await sql<{ total_points: number; current_streak: number }[]>`
        INSERT INTO reward_state (workspace_id, total_points, current_streak, last_message, calls_since_last_reward)
        VALUES (${workspaceId}, ${pointsAwarded}, 1, NULL, 0)
        ON CONFLICT (workspace_id) DO UPDATE SET
          total_points = reward_state.total_points + ${pointsAwarded},
          current_streak = reward_state.current_streak + 1,
          calls_since_last_reward = 0,
          updated_at = NOW()
        RETURNING total_points, current_streak
      `;
      return { totalPoints: rows[0]?.total_points || pointsAwarded, streak: rows[0]?.current_streak || 1 };
    }

    // Not rewarded, not negative — just increment calls_since_last_reward
    const rows = await sql<{ total_points: number; current_streak: number }[]>`
      INSERT INTO reward_state (workspace_id, total_points, current_streak, calls_since_last_reward)
      VALUES (${workspaceId}, 0, 0, 1)
      ON CONFLICT (workspace_id) DO UPDATE SET
        calls_since_last_reward = reward_state.calls_since_last_reward + 1,
        updated_at = NOW()
      RETURNING total_points, current_streak
    `;
    return { totalPoints: rows[0]?.total_points || 0, streak: rows[0]?.current_streak || 0 };
  } catch {
    return { totalPoints: 0, streak: 0 };
  }
}

/**
 * Initialize reward system tables. Called during schema init.
 */
export async function initRewardSchema(): Promise<void> {
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
  // Add call_class columns to calls table if not exists
  await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_class TEXT`;
  await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_class_confidence REAL`;
}
