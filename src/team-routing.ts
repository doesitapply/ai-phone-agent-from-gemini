/**
 * Team Routing Engine
 * Finds the best team member to handle an escalation based on:
 * 1. On-call status (on-call members are always preferred)
 * 2. Topic matching (handles_topics vs. the call reason/topic)
 * 3. Priority score (higher priority = first in line)
 */
import { sql } from "./db.js";

export type RoutedMember = {
  id: number;
  name: string;
  role: string;
  phone: string | null;
  email: string | null;
};

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
    ` as {
      id: number;
      name: string;
      role: string;
      phone: string | null;
      email: string | null;
      is_on_call: boolean;
      handles_topics: string[] | null;
      priority: number;
    }[];

    if (!members.length) return null;

    // Build a search string from the reason + topic
    const searchText = [reason, topic].filter(Boolean).join(" ").toLowerCase();

    // Score each member
    const scored = members.map((m) => {
      let score = m.priority;
      if (m.is_on_call) score += 1000; // on-call is a massive boost

      // Topic match scoring
      const topics = (m.handles_topics || []).map((t) => t.toLowerCase());
      for (const t of topics) {
        if (searchText.includes(t)) score += 50;
        // Partial word match
        const words = t.split(/\s+/);
        for (const w of words) {
          if (w.length > 3 && searchText.includes(w)) score += 10;
        }
      }

      return { ...m, score };
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
    return null;
  }
}
