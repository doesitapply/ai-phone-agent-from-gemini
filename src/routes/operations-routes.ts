import type { Express, Request, RequestHandler, Response } from "express";

type OperationsRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  sql: any;
  dbEnabled: boolean;
  getWorkspaceId: (req: Request) => number;
  velvet: {
    receiverConfigured: boolean;
    isAcquisitionSchemaReady?: () => boolean;
    workspaceId: string | null;
    portalUrl: string | null;
  };
};

export function registerOperationsRoutes(app: Express, deps: OperationsRouteDeps): void {
  const { dashboardAuth, requireOperator, sql, dbEnabled, getWorkspaceId, velvet } = deps;

  app.get("/api/handoffs", dashboardAuth, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Live handoff data is unavailable because durable storage is not connected.", code: "DURABLE_STORAGE_UNAVAILABLE" });
    const wsId = getWorkspaceId(req);
    const acquisitionSchemaReady = velvet.isAcquisitionSchemaReady?.() ?? false;
    const handoffs = acquisitionSchemaReady
      ? await sql`
          SELECT h.id, h.call_sid, h.acquisition_id, h.reason, h.urgency, h.status,
                 h.notes, h.recommended_action, h.transcript_snippet, h.created_at,
                 h.acknowledged_at, h.last_action, h.last_action_at,
                 h.resolution_notes, h.resolved_at, h.assigned_to_name,
                 h.assigned_to_phone, h.assigned_to_email,
                 co.name as contact_name, co.phone_number
          FROM handoffs h
          LEFT JOIN contacts co ON h.contact_id = co.id
          WHERE h.workspace_id = ${wsId}
          ORDER BY CASE WHEN h.status = 'pending' THEN 0 ELSE 1 END, h.created_at DESC
          LIMIT 50
        `
      : await sql`
          SELECT h.id, h.call_sid, NULL::TEXT AS acquisition_id, h.reason, h.urgency, h.status,
                 h.notes, h.recommended_action, h.transcript_snippet, h.created_at,
                 h.acknowledged_at, h.last_action, h.last_action_at,
                 h.resolution_notes, h.resolved_at, h.assigned_to_name,
                 h.assigned_to_phone, h.assigned_to_email,
                 co.name as contact_name, co.phone_number
          FROM handoffs h
          LEFT JOIN contacts co ON h.contact_id = co.id
          WHERE h.workspace_id = ${wsId}
          ORDER BY CASE WHEN h.status = 'pending' THEN 0 ELSE 1 END, h.created_at DESC
          LIMIT 50
        `;
    res.json({ handoffs });
  });

  app.get("/api/velvet/portal", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const wsId = getWorkspaceId(req);
    const requestedWorkspaceId = String(wsId);
    const receiverConfigured = velvet.receiverConfigured && velvet.workspaceId === requestedWorkspaceId;
    if (!dbEnabled) {
      return res.status(503).json({
        error: "Velvet handoff data is unavailable because durable storage is not connected.",
        code: "DURABLE_STORAGE_UNAVAILABLE",
        receiverConfigured,
        receiverReady: false,
        workspaceId: requestedWorkspaceId,
        receiverWorkspaceId: velvet.workspaceId,
        portalUrl: velvet.portalUrl,
        sourceAttributionAvailable: false,
        acquisitionInboxAvailable: false,
        acquisitionSchemaReady: false,
        pendingCount: 0,
        acquisitionCounts: { real: 0, synthetic: 0, quarantined: 0 },
        recentAcquisitions: [],
        recentHandoffs: [],
      });
    }
    const acquisitionSchemaReady = velvet.isAcquisitionSchemaReady?.() ?? false;
    const handoffsPromise = acquisitionSchemaReady
      ? sql`
          SELECT h.id, h.call_sid, h.acquisition_id, h.reason, h.urgency, h.status, h.notes, h.recommended_action,
                 h.transcript_snippet, h.created_at, h.acknowledged_at, h.assigned_to_name,
                 h.assigned_to_phone, h.assigned_to_email, h.last_action, h.last_action_at,
                 h.resolution_notes, h.resolved_at, co.name AS contact_name, co.phone_number
          FROM handoffs h
          LEFT JOIN contacts co ON h.contact_id = co.id
          WHERE h.workspace_id = ${wsId}
          ORDER BY h.created_at DESC
          LIMIT 20
        `
      : sql`
          SELECT h.id, h.call_sid, NULL::TEXT AS acquisition_id, h.reason, h.urgency, h.status, h.notes, h.recommended_action,
                 h.transcript_snippet, h.created_at, h.acknowledged_at, h.assigned_to_name,
                 h.assigned_to_phone, h.assigned_to_email, h.last_action, h.last_action_at,
                 h.resolution_notes, h.resolved_at, co.name AS contact_name, co.phone_number
          FROM handoffs h
          LEFT JOIN contacts co ON h.contact_id = co.id
          WHERE h.workspace_id = ${wsId}
          ORDER BY h.created_at DESC
          LIMIT 20
        `;
    const [countRows, handoffs, acquisitionCountRows, acquisitions, receiverWorkspaceRows] = await Promise.all([
      sql<{ count: string }[]>`SELECT COUNT(*)::TEXT AS count FROM handoffs WHERE workspace_id = ${wsId} AND status = 'pending'`,
      handoffsPromise,
      acquisitionSchemaReady
        ? sql<{
            real_count: string;
            synthetic_count: string;
            quarantined_count: string;
          }[]>`
            SELECT
              COUNT(*) FILTER (WHERE record_kind = 'real')::TEXT AS real_count,
              COUNT(*) FILTER (WHERE record_kind = 'synthetic')::TEXT AS synthetic_count,
              COUNT(*) FILTER (WHERE record_kind = 'quarantined')::TEXT AS quarantined_count
            FROM acquisition_records
            WHERE workspace_id = ${wsId}
          `
        : Promise.resolve([]),
      acquisitionSchemaReady
        ? sql`
            SELECT acquisition_id, source_system, source_record_id, first_payload_hash,
                   record_kind, contact_permission, contact_basis, route_decision,
                   source_observed_at, first_received_at
            FROM acquisition_records
            WHERE workspace_id = ${wsId}
            ORDER BY first_received_at DESC
            LIMIT 20
          `
        : Promise.resolve([]),
      receiverConfigured && acquisitionSchemaReady
        ? sql<{ workspace_exists: boolean }[]>`
            SELECT EXISTS(
              SELECT 1 FROM workspaces WHERE id = ${wsId}
            ) AS workspace_exists
          `
        : Promise.resolve([]),
    ]);
    const acquisitionCounts = acquisitionCountRows[0];
    const receiverReady = Boolean(receiverWorkspaceRows[0]?.workspace_exists);
    res.json({
      receiverConfigured,
      receiverReady,
      workspaceId: requestedWorkspaceId,
      receiverWorkspaceId: velvet.workspaceId,
      portalUrl: velvet.portalUrl,
      sourceAttributionAvailable: false,
      acquisitionInboxAvailable: receiverReady && acquisitionSchemaReady,
      acquisitionSchemaReady,
      pendingCount: Number(countRows[0]?.count || 0),
      acquisitionCounts: {
        real: Number(acquisitionCounts?.real_count || 0),
        synthetic: Number(acquisitionCounts?.synthetic_count || 0),
        quarantined: Number(acquisitionCounts?.quarantined_count || 0),
      },
      recentAcquisitions: acquisitions,
      recentHandoffs: handoffs,
    });
  });

  app.get("/api/acquisitions", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.status(503).json({ error: "Acquisition evidence requires durable storage.", code: "ACQUISITION_STORAGE_REQUIRED" });
    }
    if (!(velvet.isAcquisitionSchemaReady?.() ?? false)) {
      return res.status(503).json({ error: "Acquisition evidence schema is not ready.", code: "ACQUISITION_SCHEMA_NOT_READY" });
    }
    const wsId = getWorkspaceId(req);
    const requestedKind = String(req.query.kind || "").trim().toLowerCase();
    const allowedKinds = ["real", "synthetic", "quarantined"];
    if (requestedKind && !allowedKinds.includes(requestedKind)) {
      return res.status(400).json({
        error: "Invalid acquisition kind filter.",
        code: "INVALID_ACQUISITION_KIND",
      });
    }
    const recordKind = requestedKind || null;
    const acquisitions = await sql`
      SELECT acquisition_id, source_system, source_record_id, first_payload_hash,
             record_kind, contact_permission, contact_basis, route_decision,
             source_observed_at, first_received_at
      FROM acquisition_records
      WHERE workspace_id = ${wsId}
        AND (${recordKind}::TEXT IS NULL OR record_kind = ${recordKind})
      ORDER BY first_received_at DESC
      LIMIT 100
    `;
    return res.json({ acquisitions });
  });

  app.get("/api/acquisitions/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.status(503).json({ error: "Acquisition evidence requires durable storage.", code: "ACQUISITION_STORAGE_REQUIRED" });
    }
    if (!(velvet.isAcquisitionSchemaReady?.() ?? false)) {
      return res.status(503).json({ error: "Acquisition evidence schema is not ready.", code: "ACQUISITION_SCHEMA_NOT_READY" });
    }
    const acquisitionId = String(req.params.id || "").trim();
    if (!/^acq_[0-9a-f]{40}$/.test(acquisitionId)) {
      return res.status(400).json({ error: "Invalid acquisition ID.", code: "INVALID_ACQUISITION_ID" });
    }
    const wsId = getWorkspaceId(req);
    const [recordRows, events, reviews] = await Promise.all([
      sql`
        SELECT acquisition_id, source_system, source_record_id, first_payload_hash,
               record_kind, contact_permission, contact_basis, route_decision,
               source_observed_at, first_received_at
        FROM acquisition_records
        WHERE acquisition_id = ${acquisitionId} AND workspace_id = ${wsId}
        LIMIT 1
      `,
      sql`
        SELECT receipt_id, source_system, source_event_id, event_type, payload_hash,
               status, source_observed_at, received_at
        FROM acquisition_events
        WHERE acquisition_id = ${acquisitionId} AND workspace_id = ${wsId}
        ORDER BY received_at ASC
      `,
      sql`
        SELECT review_id, decision, candidate_channel, contact_basis, evidence_hash,
               evidence_ref, reviewed_by, observed_at, expires_at, created_at
        FROM acquisition_reviews
        WHERE acquisition_id = ${acquisitionId} AND workspace_id = ${wsId}
        ORDER BY created_at ASC
      `,
    ]);
    if (!recordRows[0]) {
      return res.status(404).json({ error: "Acquisition not found.", code: "ACQUISITION_NOT_FOUND" });
    }
    return res.json({ acquisition: recordRows[0], events, reviews });
  });

  app.post("/api/handoffs/:id/acknowledge", dashboardAuth, async (req: Request, res: Response) => {
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

  app.post("/api/handoffs/:id/action", dashboardAuth, async (req: Request, res: Response) => {
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
    if (!dbEnabled) return res.status(503).json({ error: "Live call summaries are unavailable because durable storage is not connected.", code: "DURABLE_STORAGE_UNAVAILABLE" });
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
