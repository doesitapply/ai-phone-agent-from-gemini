#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const serverPath = resolve(root, "dist-server/server.mjs");
const port = String(3300 + Math.floor(Math.random() * 500));
const baseUrl = `http://127.0.0.1:${port}`;
const apiKey = "local-storage-guard-key";

if (!existsSync(serverPath)) {
  console.error("dist-server/server.mjs is missing. Run npm run build before check:no-db-storage-guard.");
  process.exit(1);
}

const child = spawn(process.execPath, [serverPath], {
  cwd: root,
  env: {
    ...process.env,
    PORT: port,
    DATABASE_URL: "",
    DASHBOARD_API_KEY: apiKey,
    DEMO_OPERATOR_API_KEY: "",
    SETTINGS_PATH: "/tmp/smirk-no-db-storage-guard",
    NODE_ENV: "production",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let logs = "";
child.stdout.on("data", (chunk) => { logs += String(chunk); });
child.stderr.on("data", (chunk) => { logs += String(chunk); });

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function fetchJson(path, init = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "x-api-key": apiKey, ...(init.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`No-storage guard server did not start. Logs:\n${logs.slice(-4000)}`);
}

async function main() {
  try {
    await waitForServer();
    const protectedReads = [
      "/api/workspaces",
      "/api/workspace-overview",
      "/api/workspace/profile",
      "/api/stats",
      "/api/call-intelligence",
      "/api/triage",
      "/api/calls",
      "/api/calls/active",
      "/api/contacts",
      "/api/tasks",
      "/api/handoffs",
      "/api/recovery/queue",
      "/api/recovery/stats",
      "/api/appointments",
      "/api/compliance/dnc",
    ];

    for (const path of protectedReads) {
      const result = await fetchJson(path);
      assert(result.status === 503, `${path} returned ${result.status}, expected 503 when durable storage is unavailable`);
      assert(result.body?.code === "DURABLE_STORAGE_UNAVAILABLE", `${path} did not identify durable-storage unavailability`);
    }

    const blockedAction = await fetchJson("/api/recovery/direct-dial", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone_number: "+15551234567" }),
    });
    assert(blockedAction.status === 503, `Recovery direct dial returned ${blockedAction.status}, expected 503 without durable storage`);
    assert(blockedAction.body?.code === "DURABLE_STORAGE_UNAVAILABLE", "Recovery direct dial did not identify durable-storage unavailability");

    console.log(JSON.stringify({ ok: true, checkedRoutes: protectedReads.length + 1, code: "NO_DB_STORAGE_GUARD_PASSED" }, null, 2));
  } finally {
    child.kill("SIGINT");
  }
}

main().catch((err) => {
  child.kill("SIGINT");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
