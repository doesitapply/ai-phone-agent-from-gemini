#!/usr/bin/env node
import { readFileSync } from "node:fs";

const files = {
  db: readFileSync("src/db.ts", "utf8"),
  server: readFileSync("server.ts", "utf8"),
  adminRoutes: readFileSync("src/routes/admin-maintenance-routes.ts", "utf8"),
  contract: readFileSync("src/webhook-buffer-replay-contract.mjs", "utf8"),
  packageJson: readFileSync("package.json", "utf8"),
  replay: readFileSync("scripts/replay-webhook-buffer.mjs", "utf8"),
  operatorAuth: readFileSync("scripts/lib/smirk-operator-auth.mjs", "utf8"),
  lag: readFileSync("scripts/check-webhook-buffer-lag.mjs", "utf8"),
};

const failures = [];
const expect = (label, ok) => {
  if (!ok) failures.push(label);
};

expect("webhook_event_buffer table exists", files.db.includes("CREATE TABLE IF NOT EXISTS webhook_event_buffer"));
expect("buffer stores raw JSON payload", files.db.includes("payload        JSONB NOT NULL DEFAULT '{}'::jsonb"));
expect("buffer is idempotent per call/type", files.db.includes("idx_webhook_event_buffer_call_type"));
expect("buffer can be replayed by status", files.db.includes("idx_webhook_event_buffer_status"));
expect("maintenance approvals have a durable unique audit", files.db.includes("CREATE TABLE IF NOT EXISTS admin_maintenance_action_audit") && files.db.includes("UNIQUE (action_type, request_digest)"));

expect("server has non-throwing buffer helper", files.server.includes("async function bufferTwilioWebhookEvent"));
expect("server writes only the supported incoming buffer type", files.server.includes('webhookType: "twilio.incoming"'));
expect("incoming route does not await initial buffer write", files.server.includes("payload: req.body as Record<string, unknown>,\n  }).catch(() => {});"));
expect("incoming route backfills workspace id", files.server.includes("workspaceId: routedWsId"));
expect("replay receives the exact deployed commit", files.server.includes("deployVersion: DEPLOY_VERSION"));

expect("replay contract is versioned", files.contract.includes("smirk.webhook-buffer-replay.v2"));
expect("replay contract is capped at twenty rows", files.contract.includes("WEBHOOK_BUFFER_REPLAY_MAX_ROWS = 20"));
expect("approval binds payload and row hashes", files.contract.includes("payloadHash") && files.contract.includes("rowDigests"));
expect("approval binds exact runtime, rows, and workspace", files.contract.includes("runtimeCommit") && files.contract.includes("requestedIds") && files.contract.includes("workspaceIds"));
expect("only inbound Twilio calls are replayable", files.contract.includes('webhookType !== "twilio.incoming"') && files.contract.includes("WEBHOOK_REPLAY_DIRECTION_NOT_INBOUND"));
expect("public plans omit full CallSids and phone values", files.contract.includes("callSidSuffix") && !files.contract.includes("fromNumber: row.fromNumber"));
expect("approval grants no contact, SMS, deploy, or delete", files.contract.includes("outboundContactAuthorized: false") && files.contract.includes("smsAuthorized: false") && files.contract.includes("deploymentAuthorized: false") && files.contract.includes("deletionAuthorized: false"));

expect("replay endpoint is full-operator-only", files.adminRoutes.includes('"/api/admin/webhook-buffer-replay", dashboardAuth, requireFullOperator'));
expect("lag and replay audit are full-operator-only", files.adminRoutes.includes('"/api/admin/webhook-buffer-lag", dashboardAuth, requireFullOperator') && files.adminRoutes.includes('"/api/admin/webhook-buffer-replay/audit", dashboardAuth, requireFullOperator'));
expect("generic replay confirmation is gone", !files.adminRoutes.includes("process-buffered-webhooks") && !files.replay.includes("process-buffered-webhooks"));
expect("route requires exact digest and approval", files.adminRoutes.includes("providedRequestDigest") && files.adminRoutes.includes("providedApproval") && files.adminRoutes.includes("evaluateWebhookBufferReplayApproval"));
expect("route locks approved rows", files.adminRoutes.includes("ORDER BY id ASC\n          FOR UPDATE"));
expect("route rejects cross-workspace CallSid collisions", files.adminRoutes.includes("WEBHOOK_REPLAY_EXISTING_CALL_WORKSPACE_MISMATCH"));
expect("call upsert is workspace constrained", files.adminRoutes.includes("WHERE calls.workspace_id = EXCLUDED.workspace_id"));
expect("buffer update binds prior state", files.adminRoutes.includes("AND process_status = ${row.processStatus}") && files.adminRoutes.includes("WEBHOOK_REPLAY_BUFFER_WRITE_COUNT_MISMATCH"));
expect("every expected write checks RETURNING cardinality", files.adminRoutes.includes("WEBHOOK_REPLAY_CALL_WRITE_COUNT_MISMATCH") && files.adminRoutes.includes("WEBHOOK_REPLAY_AUDIT_WRITE_COUNT_MISMATCH"));
expect("successful apply writes one durable audit", files.adminRoutes.includes("INSERT INTO admin_maintenance_action_audit") && files.adminRoutes.includes("intended_action"));
expect("audit reads expose only a fixed result shape", files.adminRoutes.includes("publicWebhookReplayReceiptResult(row.result)") && !files.adminRoutes.includes("result: row.result || {}"));
expect("repeated apply resolves from the audit receipt", files.adminRoutes.includes("apply-idempotent-replay") && files.adminRoutes.includes("WEBHOOK_REPLAY_PRIOR_APPROVAL_MISMATCH"));
expect("idempotent replay validates receipt contract and intended action", files.adminRoutes.includes("WEBHOOK_REPLAY_PRIOR_RECEIPT_CONTRACT_MISMATCH") && files.adminRoutes.includes("prior.contract_version") && files.adminRoutes.includes("prior.intended_action"));
expect("idempotent replay validates stored scope claims", files.adminRoutes.includes("prior.result?.outboundContactPerformed !== false") && files.adminRoutes.includes("prior.result?.callRecordsCreatedOrReconciled"));
expect("route never claims outbound side effects", files.adminRoutes.includes("outboundContactPerformed: false") && files.adminRoutes.includes("smsSent: false") && files.adminRoutes.includes("deploymentPerformed: false") && files.adminRoutes.includes("deletionPerformed: false"));

expect("replay script is exposed as dry-run and apply commands", files.packageJson.includes('"replay:webhook-buffer"') && files.packageJson.includes('"replay:webhook-buffer:apply"'));
expect("client requires exact approval environment", files.replay.includes("WEBHOOK_BUFFER_REPLAY_APPROVAL") && files.replay.includes("WEBHOOK_BUFFER_REPLAY_REQUEST_DIGEST"));
expect("client previews before apply", files.replay.indexOf("previewResponse") < files.replay.indexOf("applyResponse"));
expect("client rejects an old live endpoint", files.replay.includes("WEBHOOK_REPLAY_LIVE_CONTRACT_MISMATCH"));
expect("client contains no direct database write path", !files.replay.includes('from "postgres"') && !files.replay.includes("UPDATE webhook_event_buffer"));
expect("operator credential destination is allowlisted", files.operatorAuth.includes("SMIRK_OPERATOR_ORIGINS") && files.operatorAuth.includes("SMIRK_OPERATOR_ORIGIN_NOT_ALLOWLISTED"));
expect("loopback auth requires an explicit test switch", files.replay.includes("SMIRK_ALLOW_LOOPBACK_OPERATOR_TEST") && files.operatorAuth.includes("allowLoopback"));

expect("lag monitor checks received and retry rows", files.lag.includes("process_status IN ('received', 'retry')"));
expect("lag monitor exits nonzero on stale rows", files.lag.includes("process.exitCode = 1"));
expect("lag monitor writes evidence artifact", files.lag.includes("webhook-buffer-lag.json"));
expect("lag telemetry redacts full provider call IDs and raw errors", files.adminRoutes.includes("callSidSuffix") && files.adminRoutes.includes("hasError: Boolean(row.error)") && files.lag.includes("callSidSuffix") && files.lag.includes("hasError: Boolean(row.error)") && !files.lag.includes("callSid: row.call_sid") && !files.lag.includes("error: row.error"));
expect("lag query bounds fail closed and failures return stable text", files.adminRoutes.includes("boundedPositiveInteger") && files.adminRoutes.includes("Webhook buffer lag telemetry is unavailable.") && !files.adminRoutes.includes("message: err?.message"));
expect("Railway operator credentials are not consulted for loopback", files.operatorAuth.includes("SMIRK_OPERATOR_ORIGINS.has(origin)") && files.operatorAuth.includes('? String(\n        readRailwayEnvValue("DASHBOARD_API_KEY"'));

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log("OK webhook buffer replay is exact-snapshot approved, full-operator-only, tenant-safe, audited, idempotent, and outbound-inert");
