#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

const databaseUrl = String(process.env.DATABASE_URL || "").trim();
const apply = process.argv.includes("--apply");
const limit = Math.max(1, Math.min(500, Number(process.env.WEBHOOK_BUFFER_REPLAY_LIMIT || 100)));
const confirmation = String(process.env.CONFIRM_WEBHOOK_BUFFER_REPLAY || "").trim();
const defaultWorkspaceId = Number(process.env.WEBHOOK_BUFFER_REPLAY_DEFAULT_WORKSPACE_ID || 0);
const outputPath = path.resolve("output", apply ? "webhook-buffer-replay-apply.json" : "webhook-buffer-replay-dry-run.json");

if (!databaseUrl) {
  console.error(JSON.stringify({
    ok: false,
    error: "missing-database-url",
    message: "Set DATABASE_URL before replaying the webhook buffer.",
  }, null, 2));
  process.exit(1);
}

if (apply && confirmation !== "process-buffered-webhooks") {
  console.error(JSON.stringify({
    ok: false,
    error: "missing-apply-confirmation",
    message: "Dry-run is safe by default. To apply replay, rerun with CONFIRM_WEBHOOK_BUFFER_REPLAY=process-buffered-webhooks.",
    apply,
  }, null, 2));
  process.exit(1);
}

const sql = postgres(databaseUrl, {
  ssl: databaseUrl.includes("railway.internal") || databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1")
    ? false
    : { rejectUnauthorized: false },
  max: 2,
  idle_timeout: 10,
  connect_timeout: 10,
});

const normalizeDirection = (value) => String(value || "").trim() === "outbound-api" ? "outbound" : "inbound";
const safeNumber = (value) => {
  const text = String(value || "").trim();
  return text.length > 0 ? text : null;
};

const markRetry = async (id, error) => {
  if (!apply) return;
  await sql`
    UPDATE webhook_event_buffer
    SET process_status = 'retry',
        updated_at = NOW(),
        error = ${error}
    WHERE id = ${id}
  `.catch(() => {});
};

const output = {
  ok: true,
  apply,
  checkedAt: new Date().toISOString(),
  limit,
  defaultWorkspaceId: defaultWorkspaceId > 0 ? defaultWorkspaceId : null,
  selected: 0,
  processed: 0,
  failed: 0,
  deferred: 0,
  rows: [],
  artifactPath: outputPath,
};

try {
  const rows = await sql`
    SELECT id, call_sid, webhook_type, workspace_id, from_number, to_number, direction, payload, received_at
    FROM webhook_event_buffer
    WHERE process_status IN ('received', 'retry')
    ORDER BY received_at ASC
    LIMIT ${limit}
  `;
  output.selected = rows.length;

  for (const row of rows) {
    const payload = row.payload || {};
    const callSid = String(row.call_sid || payload.CallSid || "").trim();
    const workspaceId = Number(row.workspace_id || payload.workspace_id || defaultWorkspaceId);
    const fromNumber = safeNumber(row.from_number || payload.From);
    const toNumber = safeNumber(row.to_number || payload.To);
    const direction = normalizeDirection(row.direction || payload.Direction);

    const result = {
      id: row.id,
      callSid,
      webhookType: row.webhook_type,
      workspaceId,
      direction,
      apply,
      status: "dry-run",
    };

    if (!callSid) {
      output.deferred += 1;
      result.status = "deferred";
      result.error = "missing-call-sid";
      await markRetry(row.id, result.error);
      output.rows.push(result);
      continue;
    }

    if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
      output.deferred += 1;
      result.status = "deferred";
      result.error = "missing-workspace-id";
      await markRetry(row.id, result.error);
      output.rows.push(result);
      continue;
    }

    if (!apply) {
      output.rows.push(result);
      continue;
    }

    try {
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO calls (call_sid, direction, to_number, from_number, status, workspace_id, started_at)
          VALUES (${callSid}, ${direction}, ${toNumber}, ${fromNumber}, 'buffered', ${workspaceId}, ${row.received_at})
          ON CONFLICT (call_sid)
          DO UPDATE SET
            to_number = COALESCE(calls.to_number, EXCLUDED.to_number),
            from_number = COALESCE(calls.from_number, EXCLUDED.from_number)
        `;
        await tx`
          UPDATE webhook_event_buffer
          SET process_status = 'processed',
              processed_at = NOW(),
              updated_at = NOW(),
              error = NULL
          WHERE id = ${row.id}
        `;
      });
      output.processed += 1;
      result.status = "processed";
    } catch (err) {
      output.failed += 1;
      result.status = "failed";
      result.error = err instanceof Error ? err.message : String(err);
      await sql`
        UPDATE webhook_event_buffer
        SET process_status = 'retry',
            updated_at = NOW(),
            error = ${result.error}
        WHERE id = ${row.id}
      `.catch(() => {});
    }

    output.rows.push(result);
  }
} catch (err) {
  output.ok = false;
  output.error = err instanceof Error ? err.message : String(err);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
