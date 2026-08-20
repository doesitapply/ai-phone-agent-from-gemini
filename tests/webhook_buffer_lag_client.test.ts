import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "check-webhook-buffer-lag.mjs");
const fullCallSid = "CA436230540466d83c5a4acb59d974dd4c";

function runLagCheck(appUrl: string, cwd: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath], {
        cwd,
        env: {
          ...process.env,
          APP_URL: appUrl,
          DATABASE_URL: "",
          DASHBOARD_API_KEY: "fixture-full-operator",
          SMIRK_ALLOW_LOOPBACK_OPERATOR_TEST: "1",
          WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES: "5",
          WEBHOOK_BUFFER_LAG_SAMPLE_LIMIT: "20",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    }
  );
}

test("lag client redacts a legacy live response before output or storage", async (t) => {
  const workspace = mkdtempSync(path.join(tmpdir(), "smirk-lag-client-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/operator/session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, role: "operator" }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/admin/webhook-buffer-lag")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        checkedAt: "2026-08-07T13:05:16.785Z",
        thresholdMinutes: 5,
        pendingCount: 4,
        staleCount: 1,
        oldestPendingReceivedAt: "2026-07-19T20:06:23.235Z",
        staleRows: [{
          id: 19,
          callSid: fullCallSid,
          webhookType: "twilio.incoming",
          workspaceId: 1,
          processStatus: "received",
          error: "secret-provider-error-detail",
          receivedAt: "2026-07-19T20:06:23.235Z",
          extra: "secret-row-detail",
        }],
        code: "WEBHOOK_BUFFER_LAG_STALE",
        message: "secret-server-message",
        extra: "secret-top-level-detail",
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const result = await runLagCheck(
    `http://127.0.0.1:${address.port}`,
    workspace
  );
  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, new RegExp(fullCallSid));
  assert.doesNotMatch(
    result.stdout,
    /secret-provider-error-detail|secret-row-detail|secret-server-message|secret-top-level-detail/
  );

  const output = JSON.parse(result.stdout) as Record<string, any>;
  assert.equal(output.source, "live-admin-api");
  assert.equal(output.staleRows[0].callSidSuffix, "74dd4c");
  assert.equal(output.staleRows[0].hasError, true);
  assert.deepEqual(
    Object.keys(output.staleRows[0]).sort(),
    [
      "callSidSuffix",
      "hasError",
      "id",
      "processStatus",
      "receivedAt",
      "webhookType",
      "workspaceId",
    ]
  );

  const stored = readFileSync(
    path.join(workspace, "output", "webhook-buffer-lag.json"),
    "utf8"
  );
  assert.equal(stored.trim(), result.stdout.trim());
  assert.doesNotMatch(stored, new RegExp(fullCallSid));
});
