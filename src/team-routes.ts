/**
 * Team Members API Routes
 * CRUD for the employee roster — used by the Handoffs page and escalation routing.
 */
import type { Express, Request, Response } from "express";
import { sql } from "./db.js";

function getWsId(req: Request): number {
  return parseInt((req as any).workspaceId || "1") || 1;
}

export function registerTeamRoutes(app: Express): void {
  // GET /api/team — list all team members for workspace
  app.get("/api/team", async (req: Request, res: Response) => {
    try {
      const wsId = getWsId(req);
      const members = await sql`
        SELECT * FROM team_members
        WHERE workspace_id = ${wsId}
        ORDER BY priority DESC, name ASC
      `;
      res.json({ members });
    } catch (err) {
      res.status(500).json({ error: "Failed to load team members" });
    }
  });

  // POST /api/team — create a new team member
  app.post("/api/team", async (req: Request, res: Response) => {
    try {
      const wsId = getWsId(req);
      const {
        name, display_name, role, department,
        phone, email, avatar_color, is_active, is_on_call,
        handles_topics, availability, notes, priority,
      } = req.body as {
        name: string; display_name?: string; role: string; department?: string;
        phone?: string; email?: string; avatar_color?: string;
        is_active?: boolean; is_on_call?: boolean;
        handles_topics?: string[]; availability?: Record<string, unknown>;
        notes?: string; priority?: number;
      };
      if (!name || !role) return res.status(400).json({ error: "name and role are required" });

      // Auto-generate initials from name
      const initials = name.split(" ").map((w: string) => w[0]).join("").toUpperCase().slice(0, 2);

      const rows = await sql`
        INSERT INTO team_members (
          workspace_id, name, display_name, role, department,
          phone, email, avatar_initials, avatar_color,
          is_active, is_on_call, handles_topics, availability, notes, priority
        ) VALUES (
          ${wsId}, ${name}, ${display_name || null}, ${role}, ${department || null},
          ${phone || null}, ${email || null}, ${initials}, ${avatar_color || "#6366f1"},
          ${is_active !== false}, ${is_on_call || false},
          ${handles_topics ? sql.array(handles_topics) : sql.array([])},
          ${availability ? sql.json(availability as any) : null},
          ${notes || null}, ${priority || 0}
        )
        RETURNING *
      `;
      res.json({ member: rows[0] });
    } catch (err) {
      console.error("POST /api/team error:", err);
      res.status(500).json({ error: "Failed to create team member" });
    }
  });

  // PATCH /api/team/:id — update a team member
  app.patch("/api/team/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const wsId = getWsId(req);
      const {
        name, display_name, role, department,
        phone, email, avatar_color, is_active, is_on_call,
        handles_topics, availability, notes, priority,
      } = req.body as {
        name?: string; display_name?: string; role?: string; department?: string;
        phone?: string; email?: string; avatar_color?: string;
        is_active?: boolean; is_on_call?: boolean;
        handles_topics?: string[]; availability?: Record<string, unknown>;
        notes?: string; priority?: number;
      };

      // Build initials if name changed
      const initials = name ? name.split(" ").map((w: string) => w[0]).join("").toUpperCase().slice(0, 2) : undefined;

      await sql`
        UPDATE team_members SET
          name            = COALESCE(${name ?? null}, name),
          display_name    = COALESCE(${display_name ?? null}, display_name),
          role            = COALESCE(${role ?? null}, role),
          department      = COALESCE(${department ?? null}, department),
          phone           = COALESCE(${phone ?? null}, phone),
          email           = COALESCE(${email ?? null}, email),
          avatar_initials = COALESCE(${initials ?? null}, avatar_initials),
          avatar_color    = COALESCE(${avatar_color ?? null}, avatar_color),
          is_active       = COALESCE(${is_active ?? null}, is_active),
          is_on_call      = COALESCE(${is_on_call ?? null}, is_on_call),
          handles_topics  = COALESCE(${handles_topics ? sql.array(handles_topics) : null}, handles_topics),
          availability    = COALESCE(${availability ? sql.json(availability as any) : null}, availability),
          notes           = COALESCE(${notes ?? null}, notes),
          priority        = COALESCE(${priority ?? null}, priority),
          updated_at      = NOW()
        WHERE id = ${id} AND workspace_id = ${wsId}
      `;
      const rows = await sql`SELECT * FROM team_members WHERE id = ${id}`;
      res.json({ member: rows[0] });
    } catch (err) {
      console.error("PATCH /api/team/:id error:", err);
      res.status(500).json({ error: "Failed to update team member" });
    }
  });

  // DELETE /api/team/:id — remove a team member
  app.delete("/api/team/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const wsId = getWsId(req);
      await sql`DELETE FROM team_members WHERE id = ${id} AND workspace_id = ${wsId}`;
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete team member" });
    }
  });

  // PATCH /api/team/:id/oncall — toggle on-call status
  app.patch("/api/team/:id/oncall", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const { is_on_call } = req.body as { is_on_call: boolean };
      await sql`UPDATE team_members SET is_on_call = ${is_on_call}, updated_at = NOW() WHERE id = ${id}`;
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to update on-call status" });
    }
  });
}
