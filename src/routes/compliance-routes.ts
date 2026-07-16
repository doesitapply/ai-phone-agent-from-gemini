import type { Express, Request, RequestHandler, Response } from "express";
import {
  addToDNC,
  checkOutboundCompliance,
  getComplianceAudit,
  getDNCList,
  removeFromDNC,
} from "../compliance.js";

type ComplianceRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  sql: any;
  dbEnabled: boolean;
};

export function registerComplianceRoutes(app: Express, deps: ComplianceRouteDeps): void {
  const { dashboardAuth, requireOperator, sql, dbEnabled } = deps;

  app.get("/api/compliance/dnc", dashboardAuth, requireOperator, async (_req: Request, res: Response) => {
    if (!dbEnabled) return res.json({ dnc: [] });
    const list = await getDNCList();
    res.json({ dnc: list });
  });

  app.post("/api/compliance/dnc", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Database is not connected in this local environment." });
    const { phone, reason } = req.body;
    if (!phone) return res.status(400).json({ error: "phone required" });
    await addToDNC(phone, reason || "manual", "manual", "operator");
    res.json({ success: true });
  });

  app.delete("/api/compliance/dnc/:phone", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Database is not connected in this local environment." });
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "manual removal";
    await removeFromDNC(decodeURIComponent(req.params.phone), reason);
    res.json({ success: true });
  });

  app.get("/api/compliance/audit", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.json({ audit: [] });
    const limit = parseInt(String(req.query.limit)) || 100;
    const audit = await getComplianceAudit(limit);
    res.json({ audit });
  });

  app.post("/api/compliance/check", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.json({ allowed: true, reasons: ["Database is not connected in this local environment."] });
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "phone required" });
    const result = await checkOutboundCompliance(phone);
    res.json(result);
  });

  app.get("/api/analytics/agents", dashboardAuth, requireOperator, async (_req: Request, res: Response) => {
    if (!dbEnabled) return res.json({ agents: [] });
    const rows = await sql`
      SELECT
        c.agent_name,
        COUNT(*) as total_calls,
        ROUND(AVG(cs.resolution_score) * 100)::int as avg_score,
        ROUND(AVG(c.duration_seconds))::int as avg_duration,
        COUNT(CASE WHEN cs.sentiment = 'positive' THEN 1 END) as positive_count,
        COUNT(CASE WHEN cs.outcome IN ('appointment_booked','lead_captured') THEN 1 END) as converted,
        ROUND(COUNT(CASE WHEN cs.sentiment = 'positive' THEN 1 END)::numeric / NULLIF(COUNT(*), 0) * 100)::int as positive_pct
      FROM calls c
      LEFT JOIN call_summaries cs ON c.call_sid = cs.call_sid
      WHERE c.agent_name IS NOT NULL
      GROUP BY c.agent_name
      ORDER BY total_calls DESC
    `;
    res.json({ agents: rows });
  });
}
