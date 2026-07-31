import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

function runReplay(appUrl: string, extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/replay-webhook-buffer.mjs", "--apply"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: "",
        APP_URL: appUrl,
        DASHBOARD_API_KEY: "fixture-operator-key",
        CONFIRM_WEBHOOK_BUFFER_REPLAY: "process-buffered-webhooks",
        ...extraEnv,
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
  });
}

test("webhook replay client fails closed around exact live selection", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  let echoExactSelection = false;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      const apply = body.apply === true;
      const response = {
        ok: true,
        apply,
        selected: 2,
        processed: apply ? 2 : 0,
        failed: 0,
        deferred: 0,
        rows: Array.isArray(body.selectedIds)
          ? body.selectedIds.map((id) => ({ id, status: apply ? "processed" : "dry-run" }))
          : [],
        ...(echoExactSelection ? { requestedIds: body.selectedIds } : {}),
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const appUrl = `http://127.0.0.1:${address.port}`;

  await t.test("missing IDs stop before any network request", async () => {
    requests.length = 0;
    const result = await runReplay(appUrl);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /missing-replay-ids/);
    assert.equal(requests.length, 0);
  });

  await t.test("invalid IDs stop before any network request", async () => {
    requests.length = 0;
    const result = await runReplay(appUrl, { WEBHOOK_BUFFER_REPLAY_IDS: "19,not-an-id" });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid-replay-ids/);
    assert.equal(requests.length, 0);
  });

  await t.test("legacy endpoint receives preview only and never apply", async () => {
    requests.length = 0;
    echoExactSelection = false;
    const result = await runReplay(appUrl, { WEBHOOK_BUFFER_REPLAY_IDS: "19,21" });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /exact-selection-preflight-failed/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.apply, false);
  });

  await t.test("exact-aware endpoint receives preview before apply", async () => {
    requests.length = 0;
    echoExactSelection = true;
    const result = await runReplay(appUrl, { WEBHOOK_BUFFER_REPLAY_IDS: "21,19" });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.apply), [false, true]);
    assert.deepEqual(requests[0]?.selectedIds, [19, 21]);
    assert.deepEqual(requests[1]?.selectedIds, [19, 21]);
  });
});
