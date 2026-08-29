import type { Express, Request, RequestHandler, Response } from "express";

type OperationsRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  sql: any;
  dbEnabled: boolean;
  getWorkspaceId: (req: Request) => number;
  velvet: {
    receiverConfigured: boolean;
    workspaceId: string | null;
    portalUrl: string | null;
  };
};

export function registerOperationsRoutes(app: Express, deps: OperationsRouteDeps): void {
  const { dashboardAuth, requireOperator, sql, dbEnabled, getWorkspaceId, velvet } = deps;

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
        h.last_action,
        h.last_action_at,
        h.resolution_notes,
        h.resolved_at,
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

  app.get("/api/velvet/portal", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.json({
        receiverConfigured: velvet.receiverConfigured,
        workspaceId: velvet.workspaceId,
        portalUrl: velvet.portalUrl,
        sourceAttributionAvailable: false,
        pendingCount: 0,
        recentHandoffs: [],
      });
    }
    const wsId = getWorkspaceId(req);
    const [countRows, handoffs] = await Promise.all([
      sql<{ count: string }[]>`SELECT COUNT(*)::TEXT AS count FROM handoffs WHERE workspace_id = ${wsId} AND status = 'pending'`,
      sql`
        SELECT h.id, h.call_sid, h.reason, h.urgency, h.status, h.notes, h.recommended_action,
               h.transcript_snippet, h.created_at, h.acknowledged_at, h.assigned_to_name,
               h.assigned_to_phone, h.assigned_to_email, co.name AS contact_name, co.phone_number
        FROM handoffs h
        LEFT JOIN contacts co ON h.contact_id = co.id
        WHERE h.workspace_id = ${wsId}
        ORDER BY h.created_at DESC
        LIMIT 20
      `,
    ]);
    res.json({
      receiverConfigured: velvet.receiverConfigured,
      workspaceId: velvet.workspaceId,
      portalUrl: velvet.portalUrl,
      sourceAttributionAvailable: false,
      pendingCount: Number(countRows[0]?.count || 0),
      recentHandoffs: handoffs,
    });
  });

  app.post("/api/handoffs/:id/acknowledge", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Database is not connected in this local environment." });
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid handoff ID." });
    const wsId = getWorkspaceId(req);
    const handoffRows = await sql<{ id: number }[]>`
      UPDATE handoffs
      SET status = CASE WHEN status = 'pending' THEN 'acknowledged' ELSE status END,
          acknowledged_at = COALESCE(acknowledged_at, NOW()),
          last_action = 'acknowledged',
          last_action_at = NOW()
      WHERE id = ${id} AND workspace_id = ${wsId}
      RETURNING id
    `;
    if (!handoffRows.length) return res.status(404).json({ error: "Handoff not found." });
    res.json({ success: true, status: "acknowledged" });
  });

  app.post("/api/handoffs/:id/action", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Database is not connected in this local environment." });
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid handoff ID." });
    const action = String(req.body?.action || "").trim();
    const resolutionNotes = String(req.body?.resolution_notes || "").trim();
    if (!["queue_callback", "complete", "reopen"].includes(action)) {
      return res.status(400).json({ error: "Choose queue_callback, complete, or reopen." });
    }
    if (action === "complete" && !resolutionNotes) {
      return res.status(400).json({ error: "A completion note is required so the outcome remains auditable." });
    }
    const wsId = getWorkspaceId(req);
    const handoffs = await sql<{ call_sid: string; contact_id: number | null }[]>`
      SELECT call_sid, contact_id FROM handoffs WHERE id = ${id} AND workspace_id = ${wsId} LIMIT 1
    `;
    const handoff = handoffs[0];
    if (!handoff) return res.status(404).json({ error: "Handoff not found." });

    if (action === "queue_callback" && handoff.contact_id) {
      await sql`
        INSERT INTO tasks (contact_id, call_sid, task_type, status, notes, workspace_id, post_call_artifact_key)
        SELECT ${handoff.contact_id}, ${handoff.call_sid}, 'callback', 'open',
          ${resolutionNotes || "Callback requested from Handoffs"}, ${wsId}, ${`handoff_${id}_callback`}
        WHERE NOT EXISTS (
          SELECT 1 FROM tasks
          WHERE call_sid = ${handoff.call_sid} AND workspace_id = ${wsId}
            AND task_type = 'callback' AND status IN ('open', 'in_progress')
        )
        ON CONFLICT (call_sid, post_call_artifact_key) WHERE call_sid IS NOT NULL AND post_call_artifact_key IS NOT NULL DO NOTHING
      `;
    }

    const status = action === "complete" ? "completed" : action === "reopen" ? "pending" : "in_progress";
    const updated = await sql`
      UPDATE handoffs
      SET status = ${status},
          acknowledged_at = COALESCE(acknowledged_at, NOW()),
          last_action = ${action},
          last_action_at = NOW(),
          resolution_notes = CASE WHEN ${!!resolutionNotes} THEN ${resolutionNotes} ELSE resolution_notes END,
          resolved_at = CASE WHEN ${action === "complete"} THEN NOW() ELSE NULL END
      WHERE id = ${id} AND workspace_id = ${wsId}
      RETURNING id, status, last_action, last_action_at, resolution_notes, resolved_at
    `;
    if (action === "complete") {
      await sql`
        UPDATE tasks SET status = 'completed', completed_at = NOW()
        WHERE call_sid = ${handoff.call_sid} AND workspace_id = ${wsId}
          AND task_type = 'handoff' AND status IN ('open', 'in_progress')
      `;
    }
    res.json({ success: true, handoff: updated[0] });
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
