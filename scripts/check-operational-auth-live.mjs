#!/usr/bin/env node

const appUrl = String(process.env.APP_URL || "https://ai-phone-agent-production-6811.up.railway.app").replace(/\/$/, "");

const protectedChecks = [
  { method: "GET", path: "/api/calls", name: "calls list" },
  { method: "POST", path: "/api/calls", name: "outbound call create", body: { to: "+15555550123", reason: "auth audit" } },
  { method: "GET", path: "/api/tasks", name: "tasks list" },
  { method: "GET", path: "/api/triage", name: "triage bundle" },
  { method: "GET", path: "/api/recovery/queue", name: "recovery queue" },
  { method: "POST", path: "/api/recovery/direct-dial", name: "recovery direct dial", body: { phone_number: "+15555550123" } },
  { method: "GET", path: "/api/logs", name: "request logs" },
  { method: "GET", path: "/api/events", name: "event log" },
  { method: "GET", path: "/api/openclaw/status", name: "OpenClaw status" },
  { method: "GET", path: "/api/workspaces", name: "workspace list" },
  { method: "POST", path: "/api/provision/workspace", name: "workspace provisioning write", body: { name: "Auth Audit", owner_email: "audit@example.com" } },
  { method: "GET", path: "/api/provisioning/requests", name: "provisioning requests" },
  { method: "POST", path: "/api/admin/run-migrations", name: "admin migrations" },
];

const publicChecks = [
  { method: "GET", path: "/api/version", name: "version", okStatuses: [200] },
  { method: "POST", path: "/api/provisioning/request", name: "buyer provisioning request validation", okStatuses: [400, 429] },
  { method: "POST", path: "/api/provisioning/checkout-status", name: "buyer checkout status validation", okStatuses: [400, 429] },
];

function isProtectedStatus(status) {
  return status === 401 || status === 403;
}

async function request(check) {
  const init = { method: check.method, redirect: "manual" };
  if (check.body) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(check.body);
  } else if (check.method === "POST") {
    init.headers = { "content-type": "application/json" };
    init.body = "{}";
  }
  const res = await fetch(`${appUrl}${check.path}`, init);
  return res;
}

async function main() {
  let failures = 0;

  console.log(`SMIRK live operational auth audit for ${appUrl}`);

  for (const check of protectedChecks) {
    const res = await request(check);
    const ok = isProtectedStatus(res.status);
    console.log(`${ok ? "OK  " : "FAIL"} ${check.method} ${check.path} -> ${res.status} (${check.name})`);
    if (!ok) failures += 1;
  }

  for (const check of publicChecks) {
    const res = await request(check);
    const ok = check.okStatuses.includes(res.status);
    console.log(`${ok ? "OK  " : "FAIL"} ${check.method} ${check.path} -> ${res.status} (${check.name})`);
    if (!ok) failures += 1;
  }

  if (failures > 0) {
    console.log(`\nFAIL ${failures} route(s) did not match the expected public/protected behavior.`);
    process.exit(1);
  }

  console.log("\nOK operational endpoints reject unauthenticated public access; buyer validation routes remain reachable.");
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
