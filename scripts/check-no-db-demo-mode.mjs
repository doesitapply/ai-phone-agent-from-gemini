#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const serverPath = resolve(root, "dist-server/server.mjs");
const port = String(3300 + Math.floor(Math.random() * 500));
const baseUrl = `http://127.0.0.1:${port}`;

if (!existsSync(serverPath)) {
  console.error("dist-server/server.mjs is missing. Run npm run build before check:no-db-demo-mode.");
  process.exit(1);
}

const child = spawn(process.execPath, [serverPath], {
  cwd: root,
  env: {
    ...process.env,
    PORT: port,
    DATABASE_URL: "",
    DASHBOARD_API_KEY: "",
    SETTINGS_PATH: "/tmp/smirk-no-db-demo-empty-env",
    NODE_ENV: "production",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let logs = "";
child.stdout.on("data", (chunk) => {
  logs += String(chunk);
});
child.stderr.on("data", (chunk) => {
  logs += String(chunk);
});

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function fetchJson(path) {
  const res = await fetch(`${baseUrl}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`No-DB demo server did not start. Logs:\n${logs.slice(-4000)}`);
}

async function main() {
  try {
    await waitForServer();

    const workspaces = await fetchJson("/api/workspaces");
    assert(workspaces.status === 200, `/api/workspaces returned ${workspaces.status}`);
    assert(workspaces.body?.noDbDemo === true, "/api/workspaces did not advertise noDbDemo");
    assert(Array.isArray(workspaces.body?.workspaces) && workspaces.body.workspaces.length === 1, "No-DB workspace list should contain one demo workspace");
    assert(workspaces.body.workspaces[0]?.plan === "starter", "No-DB demo workspace must be starter/basic");
    assert(workspaces.body.workspaces[0]?.api_key === "***", "No-DB demo workspace must mask api_key");

    const calls = await fetchJson("/api/calls");
    assert(calls.status === 200, `/api/calls returned ${calls.status}`);
    assert(Array.isArray(calls.body?.calls) && calls.body.calls.length >= 3, "No-DB demo should expose realistic calls");
    assert(calls.body.calls.every((call) => /^CA[a-f0-9]{32}$/i.test(call.call_sid)), "Mock calls must use Twilio-shaped SIDs");

    const contacts = await fetchJson("/api/contacts");
    assert(contacts.status === 200, `/api/contacts returned ${contacts.status}`);
    assert(Array.isArray(contacts.body?.contacts) && contacts.body.contacts.length >= 3, "No-DB demo should expose contacts");
    assert(contacts.body.contacts.some((contact) => contact.do_not_call === true), "No-DB demo should include a DNC review case");

    const tasks = await fetchJson("/api/tasks");
    assert(tasks.status === 200, `/api/tasks returned ${tasks.status}`);
    assert(Array.isArray(tasks.body?.tasks) && tasks.body.tasks.length >= 3, "No-DB demo should expose callback tasks");

    const transcript = await fetchJson(`/api/calls/${calls.body.calls[0].call_sid}/transcript`);
    assert(transcript.status === 200, `/api/calls/:sid/transcript returned ${transcript.status}`);
    assert(Array.isArray(transcript.body?.transcript) && transcript.body.transcript.length >= 2, "No-DB demo should expose transcripts");

    const stats = await fetchJson("/api/stats");
    assert(stats.status === 200, `/api/stats returned ${stats.status}`);
    assert(stats.body?.completeProofCalls >= 3, "No-DB stats should expose proof-call style counts");

    const intelligence = await fetchJson("/api/call-intelligence");
    assert(intelligence.status === 200, `/api/call-intelligence returned ${intelligence.status}`);
    assert(Array.isArray(intelligence.body?.reviewQueue) && intelligence.body.reviewQueue.length >= 1, "No-DB call intelligence should expose review queue items");

    console.log(JSON.stringify({
      ok: true,
      baseUrl,
      workspacePlan: workspaces.body.workspaces[0].plan,
      calls: calls.body.calls.length,
      contacts: contacts.body.contacts.length,
      tasks: tasks.body.tasks.length,
      reviewItems: intelligence.body.reviewQueue.length,
      code: "NO_DB_DEMO_MODE_PASSED",
    }, null, 2));
  } finally {
    child.kill("SIGINT");
  }
}

main().catch((err) => {
  child.kill("SIGINT");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
