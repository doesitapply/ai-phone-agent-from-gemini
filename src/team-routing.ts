/**
 * Team Routing Engine
 * Finds the best team member to handle an escalation based on:
 * 1. On-call status (on-call members are always preferred)
 * 2. Topic matching (handles_topics vs. the call reason/topic)
 * 3. Priority score (higher priority = first in line)
 */
import { sql } from "./db.js";
import { scoreTeamMemberForEscalation, type RoutedMember, type TeamRoutingCandidate } from "./team-routing-score.js";
export type { RoutedMember, TeamRoutingCandidate } from "./team-routing-score.js";

/**
 * Find the best available team member for an escalation.
 * @param workspaceId  The workspace to search within
 * @param reason       The escalation reason (used for topic matching)
 * @param topic        Optional explicit topic hint from the AI
 */
export async function findBestTeamMember(
  workspaceId: number,
  reason: string,
  topic?: string
): Promise<RoutedMember | null> {
  try {
    // Fetch all active team members, on-call first, then by priority
    const members = await sql`
      SELECT id, name, role, phone, email, is_on_call, handles_topics, priority
      FROM team_members
      WHERE workspace_id = ${workspaceId}
        AND is_active = TRUE
      ORDER BY is_on_call DESC, priority DESC, name ASC
    ` as TeamRoutingCandidate[];

    if (!members.length) {
      // No team members configured — fall back to owner
      const ownerPhone = process.env.OWNER_PHONE;
      if (ownerPhone) {
        return {
          id: 0,
          name: process.env.OWNER_NAME || "Cameron",
          role: "Owner",
          phone: ownerPhone,
          email: null,
        };
      }
      return null;
    }

    // Build a search string from the reason + topic
    const searchText = [reason, topic].filter(Boolean).join(" ").toLowerCase();

    // Score each member
    const scored = members.map((m) => {
      return { ...m, score: scoreTeamMemberForEscalation(m, searchText) };
    });

    // Sort by score descending, pick the best
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    return {
      id: best.id,
      name: best.name,
      role: best.role,
      phone: best.phone,
      email: best.email,
    };
  } catch {
    // Fallback to owner phone if team routing fails entirely
    const ownerPhone = process.env.OWNER_PHONE;
    if (ownerPhone) {
      return {
        id: 0,
        name: process.env.OWNER_NAME || "Cameron",
        role: "Owner",
        phone: ownerPhone,
        email: null,
      };
    }
    return null;
  }
}
