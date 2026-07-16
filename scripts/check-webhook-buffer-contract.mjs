#!/usr/bin/env node
import { readFileSync } from "node:fs";

const files = {
  db: readFileSync("src/db.ts", "utf8"),
  server: readFileSync("server.ts", "utf8"),
  adminRoutes: readFileSync("src/routes/admin-maintenance-routes.ts", "utf8"),
  packageJson: readFileSync("package.json", "utf8"),
  replay: readFileSync("scripts/replay-webhook-buffer.mjs", "utf8"),
  lag: readFileSync("scripts/check-webhook-buffer-lag.mjs", "utf8"),
};

const failures = [];
const expect = (label, ok) => {
  if (!ok) failures.push(label);
};

expect("webhook_event_buffer table exists", files.db.includes("CREATE TABLE IF NOT EXISTS webhook_event_buffer"));
expect("buffer stores Twilio CallSid", files.db.includes("call_sid       TEXT NOT NULL"));
expect("buffer stores webhook type", files.db.includes("webhook_type   TEXT NOT NULL"));
expect("buffer stores workspace id after routing", files.db.includes("workspace_id   INTEGER"));
expect("buffer stores raw JSON payload", files.db.includes("payload        JSONB NOT NULL DEFAULT '{}'::jsonb"));
expect("buffer is idempotent per call/type", files.db.includes("idx_webhook_event_buffer_call_type") && files.db.includes("ON webhook_event_buffer(call_sid, webhook_type)"));
expect("buffer can be replayed by status", files.db.includes("idx_webhook_event_buffer_status"));

expect("server has non-throwing buffer helper", files.server.includes("async function bufferTwilioWebhookEvent"));
expect("server writes twilio incoming payload", files.server.includes('webhookType: "twilio.incoming"'));
expect("server upserts buffer rows", files.server.includes("ON CONFLICT (call_sid, webhook_type)"));
expect("server logs buffer failures as warnings", files.server.includes("Twilio webhook buffer write skipped"));
expect("incoming route does not await initial buffer write", files.server.includes("payload: req.body as Record<string, unknown>,\n  }).catch(() => {});\n\n  // Dedicated-number per customer"));
expect("incoming route backfills workspace id after routing", files.server.includes("workspaceId: routedWsId"));

expect("replay script is exposed as dry-run npm command", files.packageJson.includes('"replay:webhook-buffer": "node scripts/replay-webhook-buffer.mjs"'));
expect("replay apply command is explicit", files.packageJson.includes('"replay:webhook-buffer:apply": "node scripts/replay-webhook-buffer.mjs --apply"'));
expect("lag monitor is exposed as npm command", files.packageJson.includes('"check:webhook-buffer-lag": "node scripts/check-webhook-buffer-lag.mjs"'));
expect("replay defaults to dry-run", files.replay.includes("const apply = process.argv.includes(\"--apply\")"));
expect("replay apply requires confirmation", files.replay.includes("CONFIRM_WEBHOOK_BUFFER_REPLAY") && files.replay.includes("process-buffered-webhooks"));
expect("replay does not silently default missing workspaces", files.replay.includes("WEBHOOK_BUFFER_REPLAY_DEFAULT_WORKSPACE_ID") && files.replay.includes("missing-workspace-id"));
expect("replay persists deferred row errors in apply mode", files.replay.includes("const markRetry") && files.replay.includes("await markRetry(row.id, result.error)"));
expect("replay reads received and retry rows", files.replay.includes("WHERE process_status IN ('received', 'retry')"));
expect("replay upserts into calls", files.replay.includes("INSERT INTO calls") && files.replay.includes("ON CONFLICT (call_sid)"));
expect("replay marks successful rows processed", files.replay.includes("SET process_status = 'processed'"));
expect("replay marks failed rows retry", files.replay.includes("SET process_status = 'retry'"));
expect("replay can use live admin API fallback", files.replay.includes("replayViaAdminApi") && files.replay.includes("/api/admin/webhook-buffer-replay"));
expect("replay fallback requires dashboard API key", files.replay.includes("DASHBOARD_API_KEY") && files.replay.includes('"x-api-key"'));
expect("replay fallback sends apply confirmation", files.replay.includes("confirmation") && files.replay.includes("process-buffered-webhooks"));
expect("lag monitor checks received and retry rows", files.lag.includes("process_status IN ('received', 'retry')"));
expect("lag monitor uses age threshold", files.lag.includes("WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES") && files.lag.includes("WEBHOOK_BUFFER_LAG_STALE"));
expect("lag monitor exits nonzero on stale rows", files.lag.includes("process.exitCode = 1"));
expect("lag monitor writes evidence artifact", files.lag.includes("webhook-buffer-lag.json"));
expect("live admin lag endpoint is operator protected", files.adminRoutes.includes('"/api/admin/webhook-buffer-lag"') && files.adminRoutes.includes("dashboardAuth, requireOperator"));
expect("live admin lag endpoint checks received and retry rows", files.adminRoutes.includes("webhook_event_buffer") && files.adminRoutes.includes("process_status IN ('received', 'retry')"));
expect("live admin replay endpoint is operator protected", files.adminRoutes.includes('"/api/admin/webhook-buffer-replay"') && files.adminRoutes.includes("dashboardAuth, requireOperator"));
expect("live admin replay endpoint requires apply confirmation", files.adminRoutes.includes('confirmation !== "process-buffered-webhooks"') && files.adminRoutes.includes("missing-apply-confirmation"));
expect("live admin replay endpoint defaults to dry-run", files.adminRoutes.includes("const apply = Boolean((req.body as any)?.apply)") && files.adminRoutes.includes('status: "dry-run"'));
expect("live admin replay endpoint marks successful rows processed", files.adminRoutes.includes("SET process_status = 'processed'"));
expect("live admin replay endpoint marks failed rows retry", files.adminRoutes.includes("SET process_status = 'retry'"));
expect("lag monitor can use live admin API fallback", files.lag.includes("checkViaAdminApi") && files.lag.includes("/api/admin/webhook-buffer-lag"));
expect("lag monitor fallback requires dashboard API key", files.lag.includes("DASHBOARD_API_KEY") && files.lag.includes('"x-api-key"'));

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log("OK webhook buffer contract captures raw Twilio intake without blocking call handling");
