#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { firstWorkingSmirkOperatorAuth } from "./lib/smirk-operator-auth.mjs";

const databaseUrl = String(process.env.DATABASE_URL || "").trim();
const appUrl = String(process.env.APP_URL || "https://ai-phone-agent-production-6811.up.railway.app").trim();
const thresholdMinutes = Math.max(1, Math.min(1440, Number(process.env.WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES || 5)));
const limit = Math.max(1, Math.min(100, Number(process.env.WEBHOOK_BUFFER_LAG_SAMPLE_LIMIT || 20)));
const outputPath = path.resolve("output", "webhook-buffer-lag.json");
const maximumAdminResponseBytes = 128 * 1024;

const nonnegativeInteger = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const positiveIntegerOrNull = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const isoTimestampOrNull = (value) => {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const boundedToken = (value, maximum = 80) => {
  const normalized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, "");
  return normalized ? normalized.slice(0, maximum) : null;
};

const sanitizeAdminLagBody = ({ body, responseOk, status }) => {
  const source = body && typeof body === "object" && !Array.isArray(body)
    ? body
    : {};
  const staleRows = Array.isArray(source.staleRows)
    ? source.staleRows.slice(0, limit).flatMap((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
        const id = positiveIntegerOrNull(raw.id);
        if (!id) return [];
        const providerId = raw.callSidSuffix || raw.callSid || raw.call_sid || "";
        return [{
          id,
          callSidSuffix: providerId ? String(providerId).slice(-6) : null,
          webhookType: boundedToken(raw.webhookType || raw.webhook_type),
          workspaceId: positiveIntegerOrNull(raw.workspaceId || raw.workspace_id),
          processStatus: boundedToken(raw.processStatus || raw.process_status, 32),
          hasError: raw.hasError === true || Boolean(raw.error),
          receivedAt: isoTimestampOrNull(raw.receivedAt || raw.received_at),
        }];
      })
    : [];
  const pendingCount = nonnegativeInteger(source.pendingCount);
  const staleCount = nonnegativeInteger(source.staleCount);
  const ok = responseOk && source.ok === true && staleCount === 0;
  return {
    ok,
    checkedAt: isoTimestampOrNull(source.checkedAt) || new Date().toISOString(),
    thresholdMinutes,
    pendingCount,
    staleCount,
    oldestPendingReceivedAt: isoTimestampOrNull(
      source.oldestPendingReceivedAt
    ),
    staleRows,
    code: ok
      ? "WEBHOOK_BUFFER_LAG_OK"
      : staleCount > 0
        ? "WEBHOOK_BUFFER_LAG_STALE"
        : "WEBHOOK_BUFFER_LAG_CHECK_FAILED",
    message: ok
      ? "No stale received/retry webhook buffer rows found."
      : staleCount > 0
        ? "Stale webhook buffer rows need replay or operator review."
        : "Webhook buffer lag telemetry is unavailable.",
    httpStatus: status,
  };
};

const writeOutput = (output) => {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
};

const checkViaAdminApi = async (fallbackReason) => {
  let dashboardAuth;
  try {
    dashboardAuth = await firstWorkingSmirkOperatorAuth({
      appUrl,
      allowLoopback: process.env.SMIRK_ALLOW_LOOPBACK_OPERATOR_TEST === "1",
    });
  } catch (error) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      source: "live-admin-api",
      fallbackReason,
      error: error instanceof Error ? error.message : "operator-auth-failed",
      artifactPath: outputPath,
    };
  }
  const dashboardApiKey = dashboardAuth.apiKey;
  if (!dashboardAuth.ok || !dashboardApiKey) return null;

  const url = new URL("/api/admin/webhook-buffer-lag", dashboardAuth.origin);
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
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const announcedLength = Number(res.headers.get("content-length") || 0);
    if (announcedLength > maximumAdminResponseBytes) {
      throw new Error("admin-api-response-too-large");
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maximumAdminResponseBytes) {
      throw new Error("admin-api-response-too-large");
    }
    text = new TextDecoder().decode(bytes);
  } catch {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      source: "live-admin-api",
      operatorAuthSource: dashboardAuth.source,
      fallbackReason,
      error: "admin-api-fetch-failed",
      message: "The live admin lag endpoint could not be reached.",
      artifactPath: outputPath,
    };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  const sanitized = sanitizeAdminLagBody({
    body,
    responseOk: res.ok,
    status: res.status,
  });

  return {
    ...sanitized,
    source: "live-admin-api",
    operatorAuthSource: dashboardAuth.source,
    fallbackReason,
    artifactPath: outputPath,
    operatorAuthFailures: dashboardAuth.failures?.length
      ? dashboardAuth.failures.map((failure) => ({
          source: failure.source,
          status: failure.status,
        }))
      : undefined,
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
      message: "Set DATABASE_URL, or make APP_URL reachable and set DASHBOARD_API_KEY in env, local env, or live Railway variables.",
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
    callSidSuffix: row.call_sid ? String(row.call_sid).slice(-6) : null,
    webhookType: row.webhook_type,
    workspaceId: row.workspace_id,
    processStatus: row.process_status,
    hasError: Boolean(row.error),
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
  const fallback = await checkViaAdminApi("direct-database-check-failed");
  if (fallback) {
    Object.assign(output, fallback);
    process.exitCode = fallback.ok ? 0 : 1;
  } else {
    output.ok = false;
    output.error = "direct-database-check-failed";
    output.code = "WEBHOOK_BUFFER_LAG_CHECK_FAILED";
    output.message = "Direct database lag check failed. Set APP_URL and DASHBOARD_API_KEY to use the live admin API fallback when DATABASE_URL points to a private host.";
    process.exitCode = 1;
  }
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}

writeOutput(output);
