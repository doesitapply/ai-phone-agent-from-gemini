import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const requestDigest = "a".repeat(64);
const approvalPhrase = [
  "APPROVE_REPLAY_SMIRK_WEBHOOK_BUFFER",
  `digest=${requestDigest}`,
  "rows=19,21",
  "workspace=1",
  `runtime=${"b".repeat(40)}`,
  "action=replay-buffered-inbound-calls-only",
].join(": ");

function runReplay(
  appUrl: string,
  extraEnv: Record<string, string> = {},
  apply = true
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["scripts/replay-webhook-buffer.mjs", ...(apply ? ["--apply"] : [])],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            APP_URL: appUrl,
            DASHBOARD_API_KEY: "fixture-operator-key",
            SMIRK_ALLOW_LOOPBACK_OPERATOR_TEST: "1",
            ...extraEnv,
          },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

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

test("webhook replay client requires an exact live v2 approval", async (t) => {
  const replayRequests: Array<Record<string, unknown>> = [];
  let exposeV2Contract = false;
  let corruptApplyReceipt = false;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/operator/session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, role: "operator" }));
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      replayRequests.push(body);
      const apply = body.apply === true;
      const selectedIds = Array.isArray(body.selectedIds)
        ? body.selectedIds
        : [];
      const response = exposeV2Contract
        ? apply
          ? {
              ok: true,
              contractVersion: "smirk.webhook-buffer-replay.v2",
              apply: true,
              mode: "apply-verified",
              requestDigest,
              processedIds: corruptApplyReceipt ? [19] : selectedIds,
              productionWritePerformed: true,
              auditId: corruptApplyReceipt ? null : 42,
              appliedAt: corruptApplyReceipt
                ? "not-a-timestamp"
                : "2026-08-07T12:30:00.000Z",
              outboundContactPerformed: false,
              smsSent: false,
              deploymentPerformed: false,
              deletionPerformed: false,
            }
          : {
              ok: true,
              contractVersion: "smirk.webhook-buffer-replay.v2",
              apply: false,
              mode: "dry-run",
              requestedIds: selectedIds,
              selected: selectedIds.length,
              requestDigest,
              approvalPhrase,
              productionWritePerformed: false,
            }
        : {
            ok: true,
            apply,
            requestedIds: selectedIds,
            selected: selectedIds.length,
            rows: selectedIds.map((id) => ({ id })),
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

  await t.test("missing IDs stop before authentication or replay", async () => {
    replayRequests.length = 0;
    const result = await runReplay(appUrl);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /WEBHOOK_REPLAY_ROW_SELECTION_REQUIRED/);
    assert.equal(replayRequests.length, 0);
  });

  await t.test("the legacy generic confirmation grants no authority", async () => {
    replayRequests.length = 0;
    const result = await runReplay(appUrl, {
      WEBHOOK_BUFFER_REPLAY_IDS: "19,21",
      CONFIRM_WEBHOOK_BUFFER_REPLAY: "process-buffered-webhooks",
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /exact-replay-approval-required/);
    assert.equal(replayRequests.length, 0);
  });

  await t.test("a legacy endpoint receives preview only", async () => {
    replayRequests.length = 0;
    exposeV2Contract = false;
    const result = await runReplay(appUrl, {
      WEBHOOK_BUFFER_REPLAY_IDS: "19,21",
      WEBHOOK_BUFFER_REPLAY_REQUEST_DIGEST: requestDigest,
      WEBHOOK_BUFFER_REPLAY_APPROVAL: approvalPhrase,
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /WEBHOOK_REPLAY_LIVE_CONTRACT_MISMATCH/);
    assert.equal(replayRequests.length, 1);
    assert.equal(replayRequests[0]?.apply, false);
  });

  await t.test("a changed approval receives preview only", async () => {
    replayRequests.length = 0;
    exposeV2Contract = true;
    const result = await runReplay(appUrl, {
      WEBHOOK_BUFFER_REPLAY_IDS: "21,19",
      WEBHOOK_BUFFER_REPLAY_REQUEST_DIGEST: requestDigest,
      WEBHOOK_BUFFER_REPLAY_APPROVAL: `${approvalPhrase} `,
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /WEBHOOK_REPLAY_EXACT_APPROVAL_MISSING/);
    assert.equal(replayRequests.length, 1);
    assert.equal(replayRequests[0]?.apply, false);
  });

  await t.test("the exact v2 approval previews before one apply", async () => {
    replayRequests.length = 0;
    exposeV2Contract = true;
    corruptApplyReceipt = false;
    const result = await runReplay(appUrl, {
      WEBHOOK_BUFFER_REPLAY_IDS: "21,19",
      WEBHOOK_BUFFER_REPLAY_REQUEST_DIGEST: requestDigest,
      WEBHOOK_BUFFER_REPLAY_APPROVAL: approvalPhrase,
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.deepEqual(replayRequests.map((request) => request.apply), [false, true]);
    assert.deepEqual(replayRequests[0]?.selectedIds, [19, 21]);
    assert.equal(replayRequests[1]?.requestDigest, requestDigest);
    assert.equal(replayRequests[1]?.approval, approvalPhrase);
  });

  await t.test("an incomplete apply receipt is rejected", async () => {
    replayRequests.length = 0;
    exposeV2Contract = true;
    corruptApplyReceipt = true;
    const result = await runReplay(appUrl, {
      WEBHOOK_BUFFER_REPLAY_IDS: "21,19",
      WEBHOOK_BUFFER_REPLAY_REQUEST_DIGEST: requestDigest,
      WEBHOOK_BUFFER_REPLAY_APPROVAL: approvalPhrase,
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /WEBHOOK_REPLAY_APPLY_RECEIPT_INVALID/);
    assert.match(result.stdout, /WEBHOOK_REPLAY_APPLY_SELECTION_MISMATCH/);
    assert.deepEqual(replayRequests.map((request) => request.apply), [false, true]);
    corruptApplyReceipt = false;
  });

  await t.test("dry-run returns the exact v2 approval without apply", async () => {
    replayRequests.length = 0;
    exposeV2Contract = true;
    const result = await runReplay(
      appUrl,
      { WEBHOOK_BUFFER_REPLAY_IDS: "19,21" },
      false
    );
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /APPROVE_REPLAY_SMIRK_WEBHOOK_BUFFER/);
    assert.deepEqual(replayRequests.map((request) => request.apply), [false]);
  });
});

test("operator credentials are never sent to an arbitrary APP_URL", async () => {
  const result = await runReplay(
    "https://credential-capture.invalid",
    {
      WEBHOOK_BUFFER_REPLAY_IDS: "19,21",
      WEBHOOK_BUFFER_REPLAY_REQUEST_DIGEST: requestDigest,
      WEBHOOK_BUFFER_REPLAY_APPROVAL: approvalPhrase,
      SMIRK_ALLOW_LOOPBACK_OPERATOR_TEST: "0",
    }
  );
  assert.equal(result.code, 1);
  assert.match(result.stdout, /SMIRK_OPERATOR_ORIGIN_NOT_ALLOWLISTED/);
});
