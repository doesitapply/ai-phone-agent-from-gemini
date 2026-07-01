import type { Express, Request, RequestHandler, Response } from "express";

type ProofRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  sql: any;
  dbEnabled: boolean;
  getWorkspaceId: (req: Request) => number;
  buildProofFreshness: (latestAt: string | Date | null | undefined, completeProofCalls: number) => unknown;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

export function registerProofRoutes(app: Express, deps: ProofRouteDeps): void {
  const {
    dashboardAuth,
    requireOperator,
    sql,
    dbEnabled,
    getWorkspaceId,
    buildProofFreshness,
    log,
  } = deps;

  app.get("/api/events", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const wsId = getWorkspaceId(req);
    const { call_sid, limit = "100", event_type } = req.query as Record<string, string>;
    if (call_sid && !/^CA[a-f0-9]{32}$/i.test(call_sid)) return res.status(400).json({ error: "Invalid call SID format." });
    const lim = Math.min(parseInt(limit) || 100, 500);
    let rows;
    if (call_sid && event_type) {
      rows = await sql`
        SELECT ce.id, ce.call_sid, ce.event_type, ce.payload, ce.created_at
        FROM call_events ce
        JOIN calls c ON ce.call_sid = c.call_sid
        WHERE c.workspace_id = ${wsId} AND ce.call_sid = ${call_sid} AND ce.event_type = ${event_type}
        ORDER BY ce.created_at DESC LIMIT ${lim}
      `;
    } else if (call_sid) {
      rows = await sql`
        SELECT ce.id, ce.call_sid, ce.event_type, ce.payload, ce.created_at
        FROM call_events ce
        JOIN calls c ON ce.call_sid = c.call_sid
        WHERE c.workspace_id = ${wsId} AND ce.call_sid = ${call_sid}
        ORDER BY ce.created_at DESC LIMIT ${lim}
      `;
    } else {
      rows = await sql`
        SELECT ce.id, ce.call_sid, ce.event_type, ce.payload, ce.created_at
        FROM call_events ce
        JOIN calls c ON ce.call_sid = c.call_sid
        WHERE c.workspace_id = ${wsId}
        ORDER BY ce.created_at DESC LIMIT ${lim}
      `;
    }
    res.json({ events: rows, total: rows.length });
  });

  app.get("/api/public-proof-snapshot", async (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!dbEnabled) {
        return res.json({
          totalCalls: 0,
          callsThisMonth: 0,
          summariesGenerated: 0,
          callbackTasksCreated: 0,
          ownerEmailAlertsSent: 0,
          completeProofCalls: 0,
          transferredHandoffs: 0,
          summaryCoverage: 0,
          proofFreshness: buildProofFreshness(null, 0),
          updatedAt: new Date().toISOString(),
        });
      }

      const publicWorkspaceId = Number(process.env.PUBLIC_PROOF_WORKSPACE_ID || process.env.DEFAULT_WORKSPACE_ID || 1);
      const [
        totalCallsR,
        callsMonthR,
        summariesGeneratedR,
        callbackTasksCreatedR,
        ownerEmailAlertsSentR,
        completeProofCallsR,
        transferredHandoffsR,
        latestCompleteProofCallR,
      ] = await Promise.all([
        sql`SELECT COUNT(*) as count FROM calls WHERE workspace_id = ${publicWorkspaceId}`,
        sql`SELECT COUNT(*) as count FROM calls WHERE workspace_id = ${publicWorkspaceId} AND started_at >= NOW() - INTERVAL '30 days'`,
        sql`SELECT COUNT(*) as count FROM call_summaries WHERE workspace_id = ${publicWorkspaceId}`,
        sql`SELECT COUNT(*) as count FROM tasks WHERE workspace_id = ${publicWorkspaceId} AND task_type IN ('callback', 'follow_up')`,
        sql`
          SELECT COUNT(*) as count
          FROM call_events ce
          JOIN calls c ON c.call_sid = ce.call_sid
          WHERE c.workspace_id = ${publicWorkspaceId}
            AND ce.event_type IN ('OWNER_EMAIL_ALERT_SENT', 'VOICEMAIL_EMAIL_SENT')
        `,
        sql`
          SELECT COUNT(DISTINCT c.call_sid) as count
          FROM calls c
          JOIN call_summaries cs ON cs.call_sid = c.call_sid
          JOIN tasks t ON t.call_sid = c.call_sid
            AND t.task_type IN ('callback', 'follow_up', 'handoff', 'escalate_to_human')
          JOIN call_events ce ON ce.call_sid = c.call_sid
            AND ce.event_type IN ('OWNER_EMAIL_ALERT_SENT', 'VOICEMAIL_EMAIL_SENT')
          WHERE c.workspace_id = ${publicWorkspaceId}
        `,
        sql`SELECT COUNT(*) as count FROM handoffs WHERE workspace_id = ${publicWorkspaceId} AND status = 'transferred'`,
        sql`
          SELECT MAX(c.started_at) as latest_at
          FROM calls c
          JOIN call_summaries cs ON cs.call_sid = c.call_sid
          JOIN tasks t ON t.call_sid = c.call_sid
            AND t.task_type IN ('callback', 'follow_up', 'handoff', 'escalate_to_human')
          JOIN call_events ce ON ce.call_sid = c.call_sid
            AND ce.event_type IN ('OWNER_EMAIL_ALERT_SENT', 'VOICEMAIL_EMAIL_SENT')
          WHERE c.workspace_id = ${publicWorkspaceId}
        `,
      ]);

      const totalCalls = Number(totalCallsR[0]?.count || 0);
      const summariesGenerated = Number(summariesGeneratedR[0]?.count || 0);
      const completeProofCalls = Number(completeProofCallsR[0]?.count || 0);
      res.json({
        totalCalls,
        callsThisMonth: Number(callsMonthR[0]?.count || 0),
        summariesGenerated,
        callbackTasksCreated: Number(callbackTasksCreatedR[0]?.count || 0),
        ownerEmailAlertsSent: Number(ownerEmailAlertsSentR[0]?.count || 0),
        completeProofCalls,
        transferredHandoffs: Number(transferredHandoffsR[0]?.count || 0),
        summaryCoverage: totalCalls > 0 ? Math.round((summariesGenerated / totalCalls) * 100) : 0,
        proofFreshness: buildProofFreshness((latestCompleteProofCallR[0] as { latest_at?: string | Date | null } | undefined)?.latest_at, completeProofCalls),
        updatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      log("error", "Public proof snapshot failed", { error: err?.message || String(err) });
      res.status(500).json({ error: "Failed to load public proof snapshot" });
    }
  });
}
