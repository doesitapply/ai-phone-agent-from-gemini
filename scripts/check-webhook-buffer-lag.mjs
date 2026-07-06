#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

const databaseUrl = String(process.env.DATABASE_URL || "").trim();
const appUrl = String(process.env.APP_URL || "").trim().replace(/\/$/, "");
const dashboardApiKey = String(process.env.DASHBOARD_API_KEY || "").trim();
const thresholdMinutes = Math.max(1, Math.min(1440, Number(process.env.WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES || 5)));
const limit = Math.max(1, Math.min(100, Number(process.env.WEBHOOK_BUFFER_LAG_SAMPLE_LIMIT || 20)));
const outputPath = path.resolve("output", "webhook-buffer-lag.json");

const writeOutput = (output) => {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
};

const checkViaAdminApi = async (fallbackReason) => {
  if (!appUrl || !dashboardApiKey) return null;

  const url = new URL("/api/admin/webhook-buffer-lag", appUrl);
  url.searchParams.set("thresholdMinutes", String(thresholdMinutes));
  url.searchParams.set("limit", String(limit));
  let res;
  let text;
  try {
    res = await fetch(url, {
      headers: {
        "x-api-key": dashboardApiKey,
        "accept": "application/json",
      },
    });
    text = await res.text();
  } catch (err) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      source: "live-admin-api",
      fallbackReason,
      error: "admin-api-fetch-failed",
      message: err instanceof Error ? err.message : String(err),
      artifactPath: outputPath,
    };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { ok: false, error: "invalid-json", raw: text.slice(0, 500) };
  }

  return {
    ...body,
    ok: res.ok && body?.ok === true,
    checkedAt: body?.checkedAt || new Date().toISOString(),
    source: "live-admin-api",
    fallbackReason,
    httpStatus: res.status,
    artifactPath: outputPath,
  };
};

if (!databaseUrl) {
  const fallback = await checkViaAdminApi("missing-database-url");
  if (fallback) {
    writeOutput(fallback);
    process.exit(fallback.ok ? 0 : 1);
  } else {
    writeOutput({
      ok: false,
      checkedAt: new Date().toISOString(),
      error: "missing-database-url",
      message: "Set DATABASE_URL, or set APP_URL and DASHBOARD_API_KEY to check webhook buffer lag through the live admin API.",
      artifactPath: outputPath,
    });
    process.exit(1);
  }
}

const sql = postgres(databaseUrl, {
  ssl: databaseUrl.includes("railway.internal") || databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1")
    ? false
    : { rejectUnauthorized: false },
  max: 2,
  idle_timeout: 10,
  connect_timeout: 10,
});

const output = {
  ok: true,
  checkedAt: new Date().toISOString(),
  thresholdMinutes,
  pendingCount: 0,
  staleCount: 0,
  oldestPendingReceivedAt: null,
  staleRows: [],
  artifactPath: outputPath,
};

try {
  const [summary] = await sql`
    SELECT
      COUNT(*)::int AS pending_count,
      COUNT(*) FILTER (
        WHERE received_at < NOW() - (${thresholdMinutes} * INTERVAL '1 minute')
      )::int AS stale_count,
      MIN(received_at) AS oldest_pending_received_at
    FROM webhook_event_buffer
    WHERE process_status IN ('received', 'retry')
  `;

  const staleRows = await sql`
    SELECT id, call_sid, webhook_type, workspace_id, process_status, error, received_at
    FROM webhook_event_buffer
    WHERE process_status IN ('received', 'retry')
      AND received_at < NOW() - (${thresholdMinutes} * INTERVAL '1 minute')
    ORDER BY received_at ASC
    LIMIT ${limit}
  `;

  output.pendingCount = Number(summary?.pending_count || 0);
  output.staleCount = Number(summary?.stale_count || 0);
  output.oldestPendingReceivedAt = summary?.oldest_pending_received_at
    ? new Date(summary.oldest_pending_received_at).toISOString()
    : null;
  output.staleRows = staleRows.map((row) => ({
    id: row.id,
    callSid: row.call_sid,
    webhookType: row.webhook_type,
    workspaceId: row.workspace_id,
    processStatus: row.process_status,
    error: row.error,
    receivedAt: row.received_at ? new Date(row.received_at).toISOString() : null,
  }));
  output.ok = output.staleCount === 0;
  output.code = output.ok ? "WEBHOOK_BUFFER_LAG_OK" : "WEBHOOK_BUFFER_LAG_STALE";
  output.message = output.ok
    ? "No stale received/retry webhook buffer rows found."
    : "Stale webhook buffer rows need replay or operator review.";
  if (!output.ok) {
    process.exitCode = 1;
  }
} catch (err) {
  const errorMessage = err instanceof Error ? err.message : String(err);
  const fallback = await checkViaAdminApi(errorMessage);
  if (fallback) {
    Object.assign(output, fallback);
    process.exitCode = fallback.ok ? 0 : 1;
  } else {
    output.ok = false;
    output.error = errorMessage;
    output.code = "WEBHOOK_BUFFER_LAG_CHECK_FAILED";
    output.message = "Direct database lag check failed. Set APP_URL and DASHBOARD_API_KEY to use the live admin API fallback when DATABASE_URL points to a private host.";
    process.exitCode = 1;
  }
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}

writeOutput(output);
