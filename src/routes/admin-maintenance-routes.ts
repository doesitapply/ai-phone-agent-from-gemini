import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import {
  WEBHOOK_BUFFER_REPLAY_APPROVAL_PREFIX,
  WEBHOOK_BUFFER_REPLAY_CONTRACT,
  buildWebhookBufferReplayPlan,
  evaluateWebhookBufferReplayApproval,
  normalizeWebhookBufferReplayIds,
  publicWebhookBufferReplayPlan,
  webhookBufferReplayApprovalHash,
} from "../webhook-buffer-replay-contract.mjs";

type AdminMaintenanceRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: (req: Request, res: Response, next: NextFunction) => void;
  requireFullOperator: (req: Request, res: Response, next: NextFunction) => void;
  requireProvisioningSecret: (req: Request, res: Response, next: NextFunction) => void;
  sql: any;
  dbEnabled: boolean;
  deployVersion: string;
  resetMonthlyUsage: () => Promise<void>;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

type WebhookBufferReplayRow = {
  id: number;
  call_sid: string | null;
  webhook_type: string;
  workspace_id: number | null;
  from_number: string | null;
  to_number: string | null;
  direction: string | null;
  payload: Record<string, unknown> | null;
  process_status: string;
  received_at: Date | null;
};

class WebhookBufferReplayRefusal extends Error {
  status: number;
  code: string;
  blockers: string[];

  constructor(status: number, code: string, blockers: string[] = []) {
    super(code);
    this.name = "WebhookBufferReplayRefusal";
    this.status = status;
    this.code = code;
    this.blockers = blockers;
  }
}

function boundedPositiveInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function publicWebhookReplayReceiptResult(
  result: Record<string, unknown> | null | undefined
) {
  const processedCount = Number(result?.processedCount);
  const callRecordsCreatedOrReconciled = Number(
    result?.callRecordsCreatedOrReconciled
  );
  return {
    processedCount: Number.isInteger(processedCount) && processedCount >= 0
      ? processedCount
      : null,
    callRecordsCreatedOrReconciled:
      Number.isInteger(callRecordsCreatedOrReconciled) &&
        callRecordsCreatedOrReconciled >= 0
        ? callRecordsCreatedOrReconciled
        : null,
    outboundContactPerformed:
      result?.outboundContactPerformed === false ? false : null,
    smsSent: result?.smsSent === false ? false : null,
    deploymentPerformed: result?.deploymentPerformed === false ? false : null,
    deletionPerformed: result?.deletionPerformed === false ? false : null,
  };
}

export function registerAdminMaintenanceRoutes(app: Express, deps: AdminMaintenanceRouteDeps): void {
  const {
    dashboardAuth,
    requireOperator,
    requireFullOperator,
    requireProvisioningSecret,
    sql,
    dbEnabled,
    deployVersion,
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

  app.get("/api/admin/webhook-buffer-lag", dashboardAuth, requireFullOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ ok: false, error: "Database is disabled" });

    const thresholdMinutes = boundedPositiveInteger(
      req.query.thresholdMinutes,
      5,
      1440
    );
    const limit = boundedPositiveInteger(req.query.limit, 20, 100);
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
          callSidSuffix: row.call_sid ? String(row.call_sid).slice(-6) : null,
          webhookType: row.webhook_type,
          workspaceId: row.workspace_id,
          processStatus: row.process_status,
          hasError: Boolean(row.error),
          receivedAt: row.received_at ? new Date(row.received_at).toISOString() : null,
        })),
        code: staleCount === 0 ? "WEBHOOK_BUFFER_LAG_OK" : "WEBHOOK_BUFFER_LAG_STALE",
        message: staleCount === 0
          ? "No stale received/retry webhook buffer rows found."
          : "Stale webhook buffer rows need replay or operator review.",
      });
    } catch (error) {
      log("error", "Webhook buffer lag check failed", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
      return res.status(500).json({
        ok: false,
        error: "webhook-buffer-lag-check-failed",
        message: "Webhook buffer lag telemetry is unavailable.",
      });
    }
  });

  app.get("/api/admin/webhook-buffer-replay/audit", dashboardAuth, requireFullOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ ok: false, error: "Database is disabled" });
    const limit = boundedPositiveInteger(req.query.limit, 20, 50);
    try {
      const rows = await sql<{
        id: number;
        contract_version: string;
        request_digest: string;
        actor_auth_mode: string;
        workspace_ids: number[];
        target_ids: number[];
        intended_action: string;
        result: Record<string, unknown> | null;
        created_at: Date;
      }[]>`
        SELECT id, contract_version, request_digest, actor_auth_mode,
               workspace_ids, target_ids, intended_action, result, created_at
        FROM admin_maintenance_action_audit
        WHERE action_type = 'webhook_buffer_replay'
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      return res.json({
        ok: true,
        contractVersion: WEBHOOK_BUFFER_REPLAY_CONTRACT,
        receipts: rows.map((row) => ({
          id: row.id,
          contractVersion: row.contract_version,
          requestDigest: row.request_digest,
          actorAuthMode: row.actor_auth_mode,
          workspaceIds: row.workspace_ids,
          targetIds: row.target_ids,
          intendedAction: row.intended_action,
          result: publicWebhookReplayReceiptResult(row.result),
          appliedAt: new Date(row.created_at).toISOString(),
        })),
        payloadsExposed: false,
        phoneNumbersExposed: false,
      });
    } catch (error) {
      log("error", "Webhook replay audit read failed", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
      return res.status(500).json({
        ok: false,
        error: "webhook-buffer-replay-audit-unavailable",
      });
    }
  });

  app.post("/api/admin/webhook-buffer-replay", dashboardAuth, requireFullOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ ok: false, error: "Database is disabled" });

    const body = req.body && typeof req.body === "object" ? req.body as any : {};
    if (typeof body.apply !== "boolean") {
      return res.status(400).json({
        ok: false,
        contractVersion: WEBHOOK_BUFFER_REPLAY_CONTRACT,
        error: "explicit-boolean-apply-required",
        productionWritePerformed: false,
      });
    }
    const apply = body.apply;
    const providedApproval = typeof body.approval === "string"
      ? body.approval
      : "";
    const providedRequestDigest = typeof body.requestDigest === "string"
      ? body.requestDigest
      : "";
    const defaultWorkspaceId = body.defaultWorkspaceId === undefined ||
      body.defaultWorkspaceId === null
      ? 0
      : Number(body.defaultWorkspaceId);
    if (
      body.defaultWorkspaceId !== undefined &&
      body.defaultWorkspaceId !== null &&
      (!Number.isInteger(defaultWorkspaceId) || defaultWorkspaceId <= 0)
    ) {
      return res.status(400).json({
        ok: false,
        contractVersion: WEBHOOK_BUFFER_REPLAY_CONTRACT,
        error: "invalid-default-workspace-id",
        productionWritePerformed: false,
      });
    }
    const requestedIdValues = Array.isArray(body.selectedIds)
      ? body.selectedIds
      : [];
    const selection = normalizeWebhookBufferReplayIds(requestedIdValues);
    if (!selection.ok) {
      return res.status(400).json({
        ok: false,
        contractVersion: WEBHOOK_BUFFER_REPLAY_CONTRACT,
        error: "invalid-replay-selection",
        blockers: selection.blockers,
        maximumRows: 20,
        apply,
      });
    }
    const selectedIds = selection.ids;
    if (apply && (
      !/^[a-f0-9]{64}$/i.test(providedRequestDigest) ||
      !providedApproval ||
      providedApproval.length > 512 ||
      !providedApproval.startsWith(
        `${WEBHOOK_BUFFER_REPLAY_APPROVAL_PREFIX}:`
      )
    )) {
      return res.status(400).json({
        ok: false,
        contractVersion: WEBHOOK_BUFFER_REPLAY_CONTRACT,
        error: "exact-replay-approval-required",
        blockers: [
          ...(!/^[a-f0-9]{64}$/i.test(providedRequestDigest)
            ? ["WEBHOOK_REPLAY_REQUEST_DIGEST_MISSING"]
            : []),
          ...(!providedApproval ||
            providedApproval.length > 512 ||
            !providedApproval.startsWith(
              `${WEBHOOK_BUFFER_REPLAY_APPROVAL_PREFIX}:`
            )
            ? ["WEBHOOK_REPLAY_EXACT_APPROVAL_MISSING"]
            : []),
        ],
        apply,
      });
    }

    try {
      if (!apply) {
        const rows = await sql<WebhookBufferReplayRow[]>`
          SELECT id, call_sid, webhook_type, workspace_id, from_number, to_number, direction, payload, received_at
                 , process_status
          FROM webhook_event_buffer
          WHERE process_status IN ('received', 'retry')
            AND id = ANY(${selectedIds}::int[])
          ORDER BY id ASC
        `;
        const plan = buildWebhookBufferReplayPlan({
          requestedIds: selectedIds,
          rows,
          defaultWorkspaceId,
          runtimeCommit: deployVersion,
        });
        return res.status(plan.ok ? 200 : 409).json({
          ...publicWebhookBufferReplayPlan(plan),
          apply: false,
          mode: "dry-run",
          source: "live-admin-api",
          productionWritePerformed: false,
          outboundContactPerformed: false,
          smsSent: false,
          deploymentPerformed: false,
          deletionPerformed: false,
        });
      }

      const applied = await sql.begin(async (tx: any) => {
        const priorRows = await tx<{
          id: number;
          contract_version: string;
          approval_hash: string;
          workspace_ids: number[];
          target_ids: number[];
          intended_action: string;
          result: Record<string, unknown> | null;
          created_at: Date;
        }[]>`
          SELECT id, contract_version, approval_hash, workspace_ids, target_ids,
                 intended_action, result, created_at
          FROM admin_maintenance_action_audit
          WHERE action_type = 'webhook_buffer_replay'
            AND request_digest = ${providedRequestDigest}
          FOR UPDATE
        `;
        const prior = priorRows[0];
        if (prior) {
          if (
            prior.contract_version !== WEBHOOK_BUFFER_REPLAY_CONTRACT ||
            prior.intended_action !== "replay-buffered-inbound-calls-only"
          ) {
            throw new WebhookBufferReplayRefusal(
              409,
              "WEBHOOK_REPLAY_PRIOR_RECEIPT_CONTRACT_MISMATCH"
            );
          }
          const priorTargetIds = [...prior.target_ids]
            .map(Number)
            .sort((left, right) => left - right);
          if (JSON.stringify(priorTargetIds) !== JSON.stringify(selectedIds)) {
            throw new WebhookBufferReplayRefusal(
              409,
              "WEBHOOK_REPLAY_PRIOR_SELECTION_MISMATCH"
            );
          }
          const priorResultIds = Array.isArray(prior.result?.processedIds)
            ? [...prior.result.processedIds]
                .map(Number)
                .sort((left, right) => left - right)
            : [];
          if (
            JSON.stringify(priorResultIds) !== JSON.stringify(selectedIds) ||
            Number(prior.result?.processedCount) !== selectedIds.length ||
            Number(prior.result?.callRecordsCreatedOrReconciled) !==
              selectedIds.length ||
            prior.result?.outboundContactPerformed !== false ||
            prior.result?.smsSent !== false ||
            prior.result?.deploymentPerformed !== false ||
            prior.result?.deletionPerformed !== false ||
            !Array.isArray(prior.workspace_ids) ||
            prior.workspace_ids.length !== 1 ||
            !Number.isInteger(Number(prior.workspace_ids[0])) ||
            Number(prior.workspace_ids[0]) <= 0
          ) {
            throw new WebhookBufferReplayRefusal(
              409,
              "WEBHOOK_REPLAY_PRIOR_RECEIPT_RESULT_MISMATCH"
            );
          }
          if (prior.approval_hash !==
            webhookBufferReplayApprovalHash(providedApproval)) {
            throw new WebhookBufferReplayRefusal(
              403,
              "WEBHOOK_REPLAY_PRIOR_APPROVAL_MISMATCH"
            );
          }
          return {
            ok: true,
            idempotentReplay: true,
            auditId: prior.id,
            workspaceIds: prior.workspace_ids,
            processedIds: prior.target_ids,
            result: prior.result || {},
            appliedAt: new Date(prior.created_at).toISOString(),
          };
        }

        const rows = await tx<WebhookBufferReplayRow[]>`
          SELECT id, call_sid, webhook_type, workspace_id, from_number, to_number,
                 direction, payload, process_status, received_at
          FROM webhook_event_buffer
          WHERE process_status IN ('received', 'retry')
            AND id = ANY(${selectedIds}::int[])
          ORDER BY id ASC
          FOR UPDATE
        `;
        const plan = buildWebhookBufferReplayPlan({
          requestedIds: selectedIds,
          rows,
          defaultWorkspaceId,
          runtimeCommit: deployVersion,
        });
        const authorization = evaluateWebhookBufferReplayApproval({
          plan,
          providedApproval,
          providedRequestDigest,
        });
        if (!authorization.authorized) {
          throw new WebhookBufferReplayRefusal(
            409,
            "WEBHOOK_REPLAY_APPROVAL_OR_STATE_MISMATCH",
            authorization.blockers
          );
        }

        const callSids = plan.replayRows.map((row: any) => row.callSid);
        const existingCalls = await tx<{
          call_sid: string;
          workspace_id: number;
          direction: string | null;
          from_number: string | null;
          to_number: string | null;
        }[]>`
          SELECT call_sid, workspace_id, direction, from_number, to_number
          FROM calls
          WHERE call_sid = ANY(${callSids}::text[])
          FOR UPDATE
        `;
        const expectedWorkspaceByCallSid = new Map(
          plan.replayRows.map((row: any) => [row.callSid, row.workspaceId])
        );
        if (existingCalls.some((row) =>
          Number(row.workspace_id) !==
            Number(expectedWorkspaceByCallSid.get(row.call_sid)))) {
          throw new WebhookBufferReplayRefusal(
            409,
            "WEBHOOK_REPLAY_EXISTING_CALL_WORKSPACE_MISMATCH"
          );
        }
        const conflictingValue = (left: unknown, right: unknown) => {
          const normalizedLeft = String(left || "").trim();
          const normalizedRight = String(right || "").trim();
          return Boolean(
            normalizedLeft &&
            normalizedRight &&
            normalizedLeft !== normalizedRight
          );
        };
        if (existingCalls.some((row) => {
          const expected = plan.replayRows.find(
            (candidate: any) => candidate.callSid === row.call_sid
          );
          return !expected ||
            conflictingValue(row.direction?.toLowerCase(), expected.direction) ||
            conflictingValue(row.from_number, expected.fromNumber) ||
            conflictingValue(row.to_number, expected.toNumber);
        })) {
          throw new WebhookBufferReplayRefusal(
            409,
            "WEBHOOK_REPLAY_EXISTING_CALL_IDENTITY_MISMATCH"
          );
        }

        const processedIds: number[] = [];
        for (const row of plan.replayRows as Array<any>) {
          const callWrites = await tx<{ call_sid: string }[]>`
              INSERT INTO calls (call_sid, direction, to_number, from_number, status, workspace_id, started_at)
              VALUES (${row.callSid}, ${row.direction}, ${row.toNumber}, ${row.fromNumber}, 'buffered', ${row.workspaceId}, ${row.receivedAt})
              ON CONFLICT (call_sid)
              DO UPDATE SET
                to_number = COALESCE(calls.to_number, EXCLUDED.to_number),
                from_number = COALESCE(calls.from_number, EXCLUDED.from_number)
              WHERE calls.workspace_id = EXCLUDED.workspace_id
              RETURNING call_sid
            `;
          if (callWrites.length !== 1) {
            throw new WebhookBufferReplayRefusal(
              409,
              "WEBHOOK_REPLAY_CALL_WRITE_COUNT_MISMATCH"
            );
          }
          const bufferWrites = await tx<{ id: number }[]>`
              UPDATE webhook_event_buffer
              SET process_status = 'processed',
                  processed_at = NOW(),
                  updated_at = NOW(),
                  error = NULL
              WHERE id = ${row.id}
                AND call_sid = ${row.callSid}
                AND webhook_type = ${row.webhookType}
                AND process_status = ${row.processStatus}
              RETURNING id
            `;
          if (bufferWrites.length !== 1) {
            throw new WebhookBufferReplayRefusal(
              409,
              "WEBHOOK_REPLAY_BUFFER_WRITE_COUNT_MISMATCH"
            );
          }
          processedIds.push(Number(row.id));
        }

        const receiptResult = {
          processedCount: processedIds.length,
          processedIds,
          callRecordsCreatedOrReconciled: processedIds.length,
          outboundContactPerformed: false,
          smsSent: false,
          deploymentPerformed: false,
          deletionPerformed: false,
        };
        const auditRows = await tx<{ id: number; created_at: Date }[]>`
          INSERT INTO admin_maintenance_action_audit (
            action_type, contract_version, request_digest, approval_hash,
            actor_auth_mode, actor_request_id, workspace_ids, target_ids,
            intended_action, result
          ) VALUES (
            'webhook_buffer_replay',
            ${WEBHOOK_BUFFER_REPLAY_CONTRACT},
            ${plan.requestDigest},
            ${plan.approvalHash},
            ${String((req as any).authMode || "unknown") === "operator" ? "dashboard_full_operator" : "unknown"},
            ${String((req as any).requestId || "") || null},
            ${plan.workspaceIds},
            ${processedIds},
            'replay-buffered-inbound-calls-only',
            ${tx.json(receiptResult)}
          )
          RETURNING id, created_at
        `;
        if (auditRows.length !== 1) {
          throw new WebhookBufferReplayRefusal(
            500,
            "WEBHOOK_REPLAY_AUDIT_WRITE_COUNT_MISMATCH"
          );
        }
        return {
          ok: true,
          idempotentReplay: false,
          auditId: auditRows[0].id,
          workspaceIds: plan.workspaceIds,
          processedIds,
          result: receiptResult,
          appliedAt: new Date(auditRows[0].created_at).toISOString(),
        };
      });

      return res.json({
        ...applied,
        contractVersion: WEBHOOK_BUFFER_REPLAY_CONTRACT,
        apply: true,
        mode: applied.idempotentReplay
          ? "apply-idempotent-replay"
          : "apply-verified",
        requestDigest: providedRequestDigest,
        source: "live-admin-api",
        productionWritePerformed: !applied.idempotentReplay,
        outboundContactPerformed: false,
        smsSent: false,
        deploymentPerformed: false,
        deletionPerformed: false,
      });
    } catch (err: any) {
      const refusal = err instanceof WebhookBufferReplayRefusal ? err : null;
      log(refusal ? "warn" : "error", "Webhook buffer replay failed", {
        errorType: err instanceof Error ? err.name : "unknown",
        code: refusal?.code || "WEBHOOK_REPLAY_DATABASE_FAILURE",
        apply,
        selectedCount: selectedIds.length,
        requestDigest: providedRequestDigest || null,
      });
      return res.status(refusal?.status || 500).json({
        ok: false,
        contractVersion: WEBHOOK_BUFFER_REPLAY_CONTRACT,
        apply,
        error: refusal?.code || "webhook-buffer-replay-failed",
        blockers: refusal?.blockers || [],
        requestDigest: providedRequestDigest || null,
        productionWritePerformed: false,
        outboundContactPerformed: false,
        smsSent: false,
        deploymentPerformed: false,
        deletionPerformed: false,
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
