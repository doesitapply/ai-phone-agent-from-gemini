import type { Express, Request, RequestHandler, Response } from "express";

type TaskRouteDeps = {
  dashboardAuth: RequestHandler;
  sql: any;
  dbEnabled: boolean;
  getWorkspaceId: (req: Request) => number;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

export function registerTaskRoutes(app: Express, deps: TaskRouteDeps): void {
  const { dashboardAuth, sql, dbEnabled, getWorkspaceId, log } = deps;

  app.get("/api/tasks", dashboardAuth, async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    if (!dbEnabled) return res.json({ tasks: [] });
    const wsId = getWorkspaceId(req);
    const status = req.query.status as string || "all";
    const tasks = status === "all"
      ? await sql`
          SELECT
            t.id,
            t.contact_id,
            t.call_sid,
            t.task_type,
            t.title,
            t.description,
            t.priority,
            t.status,
            t.notes,
            t.due_at,
            t.created_at,
            t.assigned_to,
            co.name as contact_name,
            co.phone_number
          FROM tasks t
          LEFT JOIN contacts co ON t.contact_id = co.id
          WHERE t.workspace_id = ${wsId}
          ORDER BY t.status ASC, t.due_at ASC NULLS LAST, t.created_at DESC
          LIMIT 200
        `
      : await sql`
          SELECT
            t.id,
            t.contact_id,
            t.call_sid,
            t.task_type,
            t.title,
            t.description,
            t.priority,
            t.status,
            t.notes,
            t.due_at,
            t.created_at,
            t.assigned_to,
            co.name as contact_name,
            co.phone_number
          FROM tasks t
          LEFT JOIN contacts co ON t.contact_id = co.id
          WHERE t.status = ${status} AND t.workspace_id = ${wsId}
          ORDER BY t.due_at ASC NULLS LAST, t.created_at DESC
          LIMIT 100
        `;
    res.json({ tasks });
  });

  const handleTaskUpdate = async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Database is not connected in this environment." });
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid task ID." });
    const wsId = getWorkspaceId(req);
    const { status, notes, assigned_to, due_at } = req.body;
    const VALID_TASK_STATUSES = ["open", "in_progress", "completed", "cancelled"];
    if (status && !VALID_TASK_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_TASK_STATUSES.join(", ")}` });
    }
    const existing = await sql`SELECT id FROM tasks WHERE id = ${id} AND workspace_id = ${wsId} LIMIT 1`;
    if (!existing.length) return res.status(404).json({ error: "Task not found." });
    await sql`
      UPDATE tasks SET
        status       = COALESCE(${status      ?? null}, status),
        notes        = COALESCE(${notes       ?? null}, notes),
        assigned_to  = COALESCE(${assigned_to ?? null}, assigned_to),
        due_at       = COALESCE(${due_at      ?? null}, due_at),
        completed_at = CASE WHEN ${status ?? ''} = 'completed' THEN NOW() ELSE completed_at END
      WHERE id = ${id} AND workspace_id = ${wsId}
    `;
    res.json({ success: true });
  };

  app.put("/api/tasks/:id", dashboardAuth, handleTaskUpdate);
  app.patch("/api/tasks/:id", dashboardAuth, handleTaskUpdate);

  app.post("/api/tasks/:id/complete", dashboardAuth, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Database is not connected in this environment." });
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid task ID." });
    const wsId = getWorkspaceId(req);
    const note = typeof req.body?.resolution_notes === "string" ? req.body.resolution_notes.trim() : "";
    const updated = await sql<{ id: number; contact_id: number | null }[]>`
      UPDATE tasks SET
        status = 'completed',
        completed_at = NOW(),
        notes = CASE
          WHEN ${note || null} IS NULL THEN notes
          ELSE CONCAT(COALESCE(notes, ''), CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE E'\n' END, ${note})
        END
      WHERE id = ${id}
        AND workspace_id = ${wsId}
        AND status != 'completed'
      RETURNING id, contact_id
    `;
    if (!updated.length) return res.status(404).json({ error: "Open task not found." });
    const contactId = updated[0]?.contact_id;
    if (contactId) {
      await sql`
        UPDATE contacts SET open_tasks = GREATEST(open_tasks - 1, 0)
        WHERE id = ${contactId} AND workspace_id = ${wsId}
      `.catch(() => {});
    }
    res.json({ success: true, completed: 1, taskIds: [id] });
  });

  app.post("/api/tasks/bulk-complete", dashboardAuth, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) return res.status(503).json({ error: "Database is not connected in this environment." });
      const wsId = getWorkspaceId(req);
      const ids = Array.isArray(req.body?.ids)
        ? req.body.ids.map((id: unknown) => Number(id)).filter((id: number) => Number.isInteger(id) && id > 0)
        : [];
      const status = typeof req.body?.status === "string" ? req.body.status : "open";
      const allowedStatuses = new Set(["open", "in_progress", "all"]);
      if (!allowedStatuses.has(status)) return res.status(400).json({ error: "Invalid status. Use open, in_progress, or all." });
      const note = typeof req.body?.resolution_notes === "string" && req.body.resolution_notes.trim()
        ? req.body.resolution_notes.trim()
        : "Bulk cleared from dashboard.";

      const updated = ids.length > 0
        ? await sql<{ id: number; contact_id: number | null }[]>`
            UPDATE tasks SET
              status = 'completed',
              completed_at = NOW(),
              notes = CONCAT(COALESCE(notes, ''), CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE E'\n' END, ${note}::text)
            WHERE workspace_id = ${wsId}
              AND id IN ${sql(ids)}
              AND status IN ('open', 'in_progress')
            RETURNING id, contact_id
          `
        : status === "all"
          ? await sql<{ id: number; contact_id: number | null }[]>`
              UPDATE tasks SET
                status = 'completed',
                completed_at = NOW(),
                notes = CONCAT(COALESCE(notes, ''), CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE E'\n' END, ${note}::text)
              WHERE workspace_id = ${wsId}
                AND status IN ('open', 'in_progress')
              RETURNING id, contact_id
            `
          : await sql<{ id: number; contact_id: number | null }[]>`
              UPDATE tasks SET
                status = 'completed',
                completed_at = NOW(),
                notes = CONCAT(COALESCE(notes, ''), CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE E'\n' END, ${note}::text)
              WHERE workspace_id = ${wsId}
                AND status = ${status}
              RETURNING id, contact_id
            `;

      const countsByContact = new Map<number, number>();
      for (const task of updated) {
        if (task.contact_id) countsByContact.set(task.contact_id, (countsByContact.get(task.contact_id) || 0) + 1);
      }
      await Promise.all(Array.from(countsByContact.entries()).map(([contactId, count]) =>
        sql`
          UPDATE contacts SET open_tasks = GREATEST(open_tasks - ${count}, 0)
          WHERE id = ${contactId} AND workspace_id = ${wsId}
        `.catch(() => {})
      ));

      res.json({ success: true, completed: updated.length, taskIds: updated.map((task) => task.id) });
    } catch (err: any) {
      log("error", "Bulk task completion failed", { requestId: (req as any).requestId, error: err?.message || String(err) });
      res.status(500).json({ error: "Failed to clear tasks.", detail: err?.message || String(err) });
    }
  });
}
