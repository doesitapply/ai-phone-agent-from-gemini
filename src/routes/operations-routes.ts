import type { Express, Request, RequestHandler, Response } from "express";

type OperationsRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  sql: any;
  dbEnabled: boolean;
  getWorkspaceId: (req: Request) => number;
};

export function registerOperationsRoutes(app: Express, deps: OperationsRouteDeps): void {
  const { dashboardAuth, requireOperator, sql, dbEnabled, getWorkspaceId } = deps;

  app.get("/api/handoffs", dashboardAuth, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.json({ handoffs: [] });
    const wsId = getWorkspaceId(req);
    const handoffs = await sql`
      SELECT
        h.id,
        h.call_sid,
        h.reason,
        h.urgency,
        h.status,
        h.notes,
        h.recommended_action,
        h.transcript_snippet,
        h.created_at,
        h.acknowledged_at,
        h.assigned_to_name,
        h.assigned_to_phone,
        h.assigned_to_email,
        co.name as contact_name,
        co.phone_number
      FROM handoffs h
      LEFT JOIN contacts co ON h.contact_id = co.id
      WHERE h.workspace_id = ${wsId}
      ORDER BY
        CASE WHEN h.status = 'pending' THEN 0 ELSE 1 END,
        h.created_at DESC
      LIMIT 50
    `;
    res.json({ handoffs });
  });

  app.post("/api/handoffs/:id/acknowledge", dashboardAuth, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Database is not connected in this local environment." });
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid handoff ID." });
    const wsId = getWorkspaceId(req);
    const handoffRows = await sql<{ call_sid: string; contact_id: number | null }[]>`
      UPDATE handoffs SET status = 'acknowledged', acknowledged_at = NOW()
      WHERE id = ${id} AND workspace_id = ${wsId}
      RETURNING call_sid, contact_id
    `;
    if (!handoffRows.length) return res.status(404).json({ error: "Handoff not found." });
    const handoff = handoffRows[0];
    const taskRows = await sql<{ id: number; contact_id: number | null }[]>`
      UPDATE tasks SET status = 'completed', completed_at = NOW()
      WHERE call_sid = ${handoff.call_sid}
        AND workspace_id = ${wsId}
        AND task_type = 'handoff'
        AND status IN ('open', 'in_progress')
      RETURNING id, contact_id
    `;
    const contactId = handoff.contact_id || taskRows[0]?.contact_id;
    if (contactId && taskRows.length > 0) {
      await sql`
        UPDATE contacts SET open_tasks = GREATEST(open_tasks - ${taskRows.length}, 0)
        WHERE id = ${contactId} AND workspace_id = ${wsId}
      `.catch(() => {});
    }
    res.json({ success: true, completedTasks: taskRows.length });
  });

  app.get("/api/summaries", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.json([]);
    const wsId = getWorkspaceId(req);
    const summaries = await sql`
      SELECT
        cs.id,
        cs.call_sid,
        cs.contact_id,
        cs.intent,
        cs.outcome,
        cs.summary,
        cs.next_action,
        cs.sentiment,
        cs.resolution_score,
        cs.extracted_entities,
        cs.created_at,
        co.name as contact_name
      FROM call_summaries cs
      LEFT JOIN contacts co ON cs.contact_id = co.id AND co.workspace_id = cs.workspace_id
      WHERE cs.workspace_id = ${wsId}
      ORDER BY cs.created_at DESC
      LIMIT 50
    `;
    res.json(summaries);
  });
}
