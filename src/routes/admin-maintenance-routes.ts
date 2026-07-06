import type { Express, NextFunction, Request, RequestHandler, Response } from "express";

type AdminMaintenanceRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: (req: Request, res: Response, next: NextFunction) => void;
  requireProvisioningSecret: (req: Request, res: Response, next: NextFunction) => void;
  sql: any;
  dbEnabled: boolean;
  resetMonthlyUsage: () => Promise<void>;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

export function registerAdminMaintenanceRoutes(app: Express, deps: AdminMaintenanceRouteDeps): void {
  const {
    dashboardAuth,
    requireOperator,
    requireProvisioningSecret,
    sql,
    dbEnabled,
    resetMonthlyUsage,
    log,
  } = deps;

  app.get("/api/system-health/public", async (_req: Request, res: Response) => {
    res.setHeader("x-smirk-readiness", "1");

    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      service: "SMIRK",
    });
  });

  app.post("/api/admin/run-migrations", dashboardAuth, requireOperator, async (_req: Request, res: Response) => {
    const results: Record<string, string> = {};
    try {
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_custom_fields_contact_key ON contact_custom_fields(contact_id, field_key)`;
      results.contact_custom_fields_unique = "ok";
    } catch (e: any) {
      results.contact_custom_fields_unique = `error: ${e.message}`;
    }
    try {
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_workspace_phone ON contacts(workspace_id, phone_number) WHERE phone_number IS NOT NULL`;
      results.contacts_workspace_phone = "ok";
    } catch (e: any) {
      results.contacts_workspace_phone = `error: ${e.message}`;
    }
    try {
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_workspace_phone ON leads(workspace_id, phone) WHERE phone IS NOT NULL`;
      results.leads_workspace_phone = "ok";
    } catch (e: any) {
      results.leads_workspace_phone = `error: ${e.message}`;
    }
    try {
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_call_unique ON call_summaries(call_sid)`;
      results.call_summaries_call_sid = "ok";
    } catch (e: any) {
      results.call_summaries_call_sid = `error: ${e.message}`;
    }

    try {
      await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS missed_text_sent_at TIMESTAMPTZ`;
      await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS recovery_windows_sent_at TIMESTAMPTZ`;
      await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS recovery_call_back_started_at TIMESTAMPTZ`;
      await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS recovery_closed_at TIMESTAMPTZ`;
      await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS recovery_status TEXT NOT NULL DEFAULT 'open'`;
      results.recovery_calls_columns = "ok";
    } catch (e: any) {
      results.recovery_calls_columns = `error: ${e.message}`;
    }

    try {
      await sql`ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS workspace_id INTEGER NOT NULL DEFAULT 1`;
      results.sms_messages_workspace_id = "ok";
    } catch (e: any) {
      results.sms_messages_workspace_id = `error: ${e.message}`;
    }

    res.json({ status: "done", results });
  });

  app.get("/api/admin/db-check", dashboardAuth, requireOperator, async (_req: Request, res: Response) => {
    const indexes = await sql`
      SELECT indexname, tablename, indexdef
      FROM pg_indexes
      WHERE tablename IN ('contacts','contact_custom_fields','leads')
      AND indexname NOT LIKE 'pg_%'
      ORDER BY tablename, indexname
    `;
    res.json({ indexes });
  });

  app.get("/api/admin/webhook-buffer-lag", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ ok: false, error: "Database is disabled" });

    const thresholdMinutes = Math.max(1, Math.min(1440, Number(req.query.thresholdMinutes || 5)));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
    try {
      const [summary] = await sql<{
        pending_count: number;
        stale_count: number;
        oldest_pending_received_at: Date | null;
      }[]>`
        SELECT
          COUNT(*)::int AS pending_count,
          COUNT(*) FILTER (
            WHERE received_at < NOW() - (${thresholdMinutes} * INTERVAL '1 minute')
          )::int AS stale_count,
          MIN(received_at) AS oldest_pending_received_at
        FROM webhook_event_buffer
        WHERE process_status IN ('received', 'retry')
      `;

      const staleRows = await sql<{
        id: number;
        call_sid: string;
        webhook_type: string;
        workspace_id: number | null;
        process_status: string;
        error: string | null;
        received_at: Date | null;
      }[]>`
        SELECT id, call_sid, webhook_type, workspace_id, process_status, error, received_at
        FROM webhook_event_buffer
        WHERE process_status IN ('received', 'retry')
          AND received_at < NOW() - (${thresholdMinutes} * INTERVAL '1 minute')
        ORDER BY received_at ASC
        LIMIT ${limit}
      `;

      const staleCount = Number(summary?.stale_count || 0);
      res.json({
        ok: staleCount === 0,
        checkedAt: new Date().toISOString(),
        thresholdMinutes,
        pendingCount: Number(summary?.pending_count || 0),
        staleCount,
        oldestPendingReceivedAt: summary?.oldest_pending_received_at
          ? new Date(summary.oldest_pending_received_at).toISOString()
          : null,
        staleRows: staleRows.map((row) => ({
          id: row.id,
          callSid: row.call_sid,
          webhookType: row.webhook_type,
          workspaceId: row.workspace_id,
          processStatus: row.process_status,
          error: row.error,
          receivedAt: row.received_at ? new Date(row.received_at).toISOString() : null,
        })),
        code: staleCount === 0 ? "WEBHOOK_BUFFER_LAG_OK" : "WEBHOOK_BUFFER_LAG_STALE",
        message: staleCount === 0
          ? "No stale received/retry webhook buffer rows found."
          : "Stale webhook buffer rows need replay or operator review.",
      });
    } catch (err: any) {
      log("error", "Webhook buffer lag check failed", { error: err?.message || String(err) });
      res.status(500).json({
        ok: false,
        error: "webhook-buffer-lag-check-failed",
        message: err?.message || String(err),
      });
    }
  });

  app.post("/api/admin/reset-monthly-usage", dashboardAuth, requireOperator, async (_req: Request, res: Response) => {
    try {
      await resetMonthlyUsage();
      log("info", "Monthly usage reset completed (manual trigger)", {});
      res.json({ ok: true, message: "Monthly usage counters reset for all workspaces" });
    } catch (err: any) {
      log("error", "Monthly usage reset failed", { error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/admin/cleanup-smoke-workspaces", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ ok: false, error: "Database is disabled" });

    const apply = Boolean((req.body as any)?.apply);
    const smokeWorkspaceRows = await sql<{ id: number; name: string; owner_email: string | null }[]>`
      SELECT id, name, owner_email
      FROM workspaces
      WHERE (
        name = 'SMIRK Smoke Test'
        AND owner_email = 'smoke+buyer@example.com'
      ) OR (
        name = 'SMIRK Stripe Webhook Smoke'
        AND owner_email LIKE 'smoke+stripe-%@example.com'
      )
      ORDER BY id
    `;
    const smokeRequestRows = await sql<{ id: number; workspace_id: number | null; business_name: string; owner_email: string }[]>`
      SELECT id, workspace_id, business_name, owner_email
      FROM provisioning_requests
      WHERE (
        business_name = 'SMIRK Smoke Test'
        AND owner_email = 'smoke+buyer@example.com'
      ) OR (
        business_name = 'SMIRK Stripe Webhook Smoke'
        AND owner_email LIKE 'smoke+stripe-%@example.com'
      )
      ORDER BY id
    `;

    if (!apply) {
      return res.json({
        ok: true,
        dry_run: true,
        matched_workspaces: smokeWorkspaceRows.length,
        matched_provisioning_requests: smokeRequestRows.length,
        workspace_ids: smokeWorkspaceRows.map((row) => row.id),
        provisioning_request_ids: smokeRequestRows.map((row) => row.id),
      });
    }

    const deletedWorkspaces = await sql<{ id: number }[]>`
      DELETE FROM workspaces
      WHERE (
        name = 'SMIRK Smoke Test'
        AND owner_email = 'smoke+buyer@example.com'
      ) OR (
        name = 'SMIRK Stripe Webhook Smoke'
        AND owner_email LIKE 'smoke+stripe-%@example.com'
      )
      RETURNING id
    `;
    const deletedRequests = await sql<{ id: number }[]>`
      DELETE FROM provisioning_requests
      WHERE (
        business_name = 'SMIRK Smoke Test'
        AND owner_email = 'smoke+buyer@example.com'
      ) OR (
        business_name = 'SMIRK Stripe Webhook Smoke'
        AND owner_email LIKE 'smoke+stripe-%@example.com'
      )
      RETURNING id
    `;

    res.json({
      ok: true,
      dry_run: false,
      deleted_workspaces: deletedWorkspaces.length,
      deleted_provisioning_requests: deletedRequests.length,
      workspace_ids: deletedWorkspaces.map((row) => row.id),
      provisioning_request_ids: deletedRequests.map((row) => row.id),
    });
  });

  app.post("/api/scheduled/monthly-usage-reset", requireProvisioningSecret, async (_req: Request, res: Response) => {
    try {
      await resetMonthlyUsage();
      log("info", "Monthly usage reset completed (scheduled cron)", {});
      res.json({ ok: true, message: "Monthly usage counters reset", timestamp: new Date().toISOString() });
    } catch (err: any) {
      log("error", "Monthly usage reset cron failed", { error: err.message });
      res.status(500).json({ ok: false, error: err.message, timestamp: new Date().toISOString() });
    }
  });
}
