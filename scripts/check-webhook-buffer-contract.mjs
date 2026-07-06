#!/usr/bin/env node
import { readFileSync } from "node:fs";

const files = {
  db: readFileSync("src/db.ts", "utf8"),
  server: readFileSync("server.ts", "utf8"),
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

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log("OK webhook buffer contract captures raw Twilio intake without blocking call handling");
