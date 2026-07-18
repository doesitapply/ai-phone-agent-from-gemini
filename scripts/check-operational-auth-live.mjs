#!/usr/bin/env node

const appUrl = String(process.env.APP_URL || "https://ai-phone-agent-production-6811.up.railway.app").replace(/\/$/, "");
const fetchTimeoutMs = Number(process.env.SMIRK_OPERATIONAL_AUTH_FETCH_TIMEOUT_MS || 15000);
const fetchAttempts = Number(process.env.SMIRK_OPERATIONAL_AUTH_FETCH_ATTEMPTS || 2);
const fetchRetryDelayMs = Number(process.env.SMIRK_OPERATIONAL_AUTH_FETCH_RETRY_DELAY_MS || 750);

const protectedChecks = [
  { method: "GET", path: "/mission-control", name: "Mission Control page shell" },
  { method: "GET", path: "/mission-control/calls/CA_AUTH_AUDIT", name: "Mission Control call deep link" },
  { method: "GET", path: "/mission-control/tasks", name: "Mission Control task deep link" },
  { method: "GET", path: "/api/operator/session", name: "operator session" },
  { method: "GET", path: "/api/calls", name: "calls list" },
  { method: "POST", path: "/api/calls", name: "outbound call create", body: { to: "+15555550123", reason: "auth audit" } },
  { method: "POST", path: "/api/calls/fix-stale", name: "global stale call fixer", body: {} },
  { method: "PATCH", path: "/api/calls/fix-stale", name: "workspace stale call fixer", body: {} },
  { method: "DELETE", path: "/api/calls/CA_AUTH_AUDIT", name: "call delete" },
  { method: "POST", path: "/api/calls/CA_AUTH_AUDIT/reprocess", name: "call summary reprocess", body: {} },
  { method: "DELETE", path: "/api/calls?filter=stale", name: "bulk call delete" },
  { method: "GET", path: "/api/calls/CA_AUTH_AUDIT/recording", name: "call recording metadata" },
  { method: "GET", path: "/api/recordings/RE_AUTH_AUDIT/audio", name: "recording audio proxy" },
  { method: "GET", path: "/api/tasks", name: "tasks list" },
  { method: "POST", path: "/api/appointments", name: "appointment create", body: { contact_id: 0, scheduled_at: "2026-06-11T22:00:00.000Z" } },
  { method: "PATCH", path: "/api/appointments/0", name: "appointment update", body: { status: "cancelled" } },
  { method: "POST", path: "/api/calendar/test-booking", name: "calendar live test booking", body: { summary: "Auth Audit" } },
  { method: "GET", path: "/api/agents", name: "agent list" },
  { method: "GET", path: "/api/agents/active", name: "active agent config" },
  { method: "GET", path: "/api/agents/0", name: "agent detail" },
  { method: "POST", path: "/api/agents", name: "agent create", body: { name: "auth-audit" } },
  { method: "PUT", path: "/api/agents/0/activate", name: "agent activate", body: {} },
  { method: "PUT", path: "/api/agents/0", name: "agent update", body: { name: "auth-audit" } },
  { method: "PATCH", path: "/api/agents/0", name: "agent patch", body: { greeting: "auth audit" } },
  { method: "DELETE", path: "/api/agents/0", name: "agent delete" },
  { method: "GET", path: "/api/team", name: "team roster" },
  { method: "POST", path: "/api/team", name: "team roster create", body: { name: "Auth Audit", role: "dispatcher" } },
  { method: "PATCH", path: "/api/team/0", name: "team roster update", body: { role: "owner" } },
  { method: "PATCH", path: "/api/team/0/oncall", name: "team roster on-call toggle", body: { is_on_call: true } },
  { method: "DELETE", path: "/api/team/0", name: "team roster delete" },
  { method: "GET", path: "/api/triage", name: "triage bundle" },
  { method: "GET", path: "/api/recovery/queue", name: "recovery queue" },
  { method: "POST", path: "/api/recovery/direct-dial", name: "recovery direct dial", body: { phone_number: "+15555550123" } },
  { method: "GET", path: "/api/workspace-overview", name: "workspace overview" },
  { method: "GET", path: "/api/workspace/profile", name: "workspace profile" },
  { method: "PATCH", path: "/api/workspace/profile", name: "workspace profile write", body: { business_name: "Auth Audit" } },
  { method: "POST", path: "/api/workspace/generate-prompt", name: "workspace prompt generation", body: { business_name: "Auth Audit" } },
  { method: "POST", path: "/api/workspace/provision-number", name: "workspace phone provisioning", body: { area_code: "775" } },
  { method: "POST", path: "/api/twilio/test-webhook", name: "Twilio webhook self-test", body: { from: "+15555550123", speech: "auth audit" } },
  { method: "POST", path: "/api/twilio/test-call", name: "static Twilio outbound connectivity test", body: { to: "+15555550123" } },
  { method: "POST", path: "/api/test-call", name: "real conversational proof call", body: { to: "+15555550123" } },
  { method: "POST", path: "/api/workspace/proof-call/fulfill", name: "customer-bound proof-call fulfillment", body: { proofRequestId: 0, workspaceId: 0, to: "+15555550123", confirmedTarget: "+15555550123", confirmation: "not-approved" } },
  { method: "POST", path: "/api/workspace/proof-call/reconcile", name: "provider-verified proof-call reconciliation", body: { proofRequestId: 0, workspaceId: 0, callSid: `CA${"0".repeat(32)}`, confirmation: "not-approved" } },
  { method: "GET", path: "/api/logs", name: "request logs" },
  { method: "GET", path: "/api/settings/groups", name: "global settings schema" },
  { method: "GET", path: "/api/settings", name: "global settings" },
  { method: "POST", path: "/api/settings", name: "global settings write", body: { AGENT_NAME: "Auth Audit" } },
  { method: "GET", path: "/api/agent/identity", name: "global agent identity" },
  { method: "POST", path: "/api/agent/identity", name: "global agent identity write", body: { AGENT_NAME: "Auth Audit" } },
  { method: "POST", path: "/api/settings/test/openclaw", name: "global OpenClaw settings test", body: { OPENCLAW_GATEWAY_URL: "https://example.invalid", OPENCLAW_GATEWAY_TOKEN: "audit" } },
  { method: "GET", path: "/api/config-status", name: "global config status" },
  { method: "GET", path: "/api/system-health", name: "system health diagnostics" },
  { method: "POST", path: "/api/debug/tts", name: "TTS diagnostics", body: { text: "auth audit" } },
  { method: "GET", path: "/api/compliance/dnc", name: "compliance DNC list" },
  { method: "POST", path: "/api/compliance/dnc", name: "compliance DNC mutation", body: { phone: "+15555550123", reason: "auth audit" } },
  { method: "DELETE", path: "/api/compliance/dnc/%2B15555550123", name: "compliance DNC delete" },
  { method: "GET", path: "/api/compliance/audit", name: "compliance audit log" },
  { method: "POST", path: "/api/compliance/check", name: "compliance outbound check", body: { phone: "+15555550123" } },
  { method: "GET", path: "/api/analytics/agents", name: "agent analytics" },
  { method: "GET", path: "/api/field-definitions", name: "custom field definition list" },
  { method: "POST", path: "/api/field-definitions", name: "custom field definition create", body: { field_key: "auth_audit", label: "Auth Audit" } },
  { method: "DELETE", path: "/api/field-definitions/auth_audit", name: "custom field definition delete" },
  { method: "GET", path: "/api/integrations/webhook", name: "webhook integration config" },
  { method: "GET", path: "/api/integrations/webhook/deliveries", name: "webhook delivery log" },
  { method: "GET", path: "/api/integrations/crm", name: "CRM integration config" },
  { method: "POST", path: "/api/integrations/webhook/test", name: "webhook delivery self-test", body: { url: "https://example.invalid" } },
  { method: "POST", path: "/api/integrations/crm/test", name: "CRM write self-test", body: { platform: "hubspot" } },
  { method: "GET", path: "/api/tools", name: "plugin tool listing" },
  { method: "POST", path: "/api/tools", name: "plugin tool create", body: { name: "auth_audit", url: "https://example.invalid" } },
  { method: "PUT", path: "/api/tools/0", name: "plugin tool update", body: { enabled: false } },
  { method: "DELETE", path: "/api/tools/0", name: "plugin tool delete" },
  { method: "POST", path: "/api/tools/0/test", name: "plugin tool test", body: {} },
  { method: "GET", path: "/api/mcp", name: "MCP server listing" },
  { method: "POST", path: "/api/mcp", name: "MCP server create", body: { name: "auth_audit", url: "https://example.invalid" } },
  { method: "PUT", path: "/api/mcp/0", name: "MCP server update", body: { enabled: false } },
  { method: "DELETE", path: "/api/mcp/0", name: "MCP server delete" },
  { method: "POST", path: "/api/mcp/0/test", name: "MCP server test", body: {} },
  { method: "GET", path: "/api/plugin-tools", name: "legacy plugin tool listing redirect" },
  { method: "POST", path: "/api/plugin-tools", name: "legacy plugin tool create redirect", body: {} },
  { method: "PUT", path: "/api/plugin-tools/0", name: "legacy plugin tool update redirect", body: {} },
  { method: "DELETE", path: "/api/plugin-tools/0", name: "legacy plugin tool delete redirect" },
  { method: "GET", path: "/api/mcp-servers", name: "legacy MCP server listing redirect" },
  { method: "POST", path: "/api/mcp-servers", name: "legacy MCP server create redirect", body: {} },
  { method: "PUT", path: "/api/mcp-servers/0", name: "legacy MCP server update redirect", body: {} },
  { method: "DELETE", path: "/api/mcp-servers/0", name: "legacy MCP server delete redirect" },
  { method: "GET", path: "/api/events", name: "event log" },
  { method: "GET", path: "/api/summaries", name: "legacy summary feed" },
  { method: "GET", path: "/api/openclaw/status", name: "OpenClaw status" },
  { method: "POST", path: "/api/openclaw/test", name: "OpenClaw test dispatch", body: { message: "auth audit" } },
  { method: "GET", path: "/api/boss/settings", name: "Boss Mode settings" },
  { method: "POST", path: "/api/boss/settings", name: "Boss Mode settings write", body: { enabled: false } },
  { method: "GET", path: "/api/boss/context", name: "Boss Mode active context" },
  { method: "POST", path: "/api/boss/context", name: "Boss Mode context write", body: { content: "auth audit", category: "briefing" } },
  { method: "DELETE", path: "/api/boss/context/0", name: "Boss Mode context delete" },
  { method: "GET", path: "/api/boss/audit", name: "Boss Mode audit log" },
  { method: "GET", path: "/api/boss/metrics", name: "Boss Mode metrics" },
  { method: "GET", path: "/api/workspaces", name: "workspace list" },
  { method: "POST", path: "/api/provision/workspace", name: "workspace provisioning write", body: { name: "Auth Audit", owner_email: "audit@example.com" } },
  { method: "POST", path: "/api/scheduled/monthly-usage-reset", name: "scheduled monthly usage reset" },
  { method: "GET", path: "/api/provisioning/requests", name: "provisioning requests" },
  { method: "POST", path: "/api/admin/run-migrations", name: "admin migrations" },
  { method: "GET", path: "/api/admin/webhook-buffer-lag", name: "admin webhook buffer lag" },
  { method: "GET", path: "/api/leads", name: "lead list" },
  { method: "POST", path: "/api/leads", name: "lead create", body: { leads: [{ name: "Auth Audit", phone: "+15555550123" }] } },
  { method: "POST", path: "/api/leads/upsert", name: "lead upsert bus", body: { phone: "+15555550123", name: "Auth Audit" } },
  { method: "GET", path: "/api/leads/funnel", name: "lead funnel" },
  { method: "GET", path: "/api/leads/scoreboard", name: "lead scoreboard" },
  { method: "GET", path: "/api/leads/alerts", name: "lead alerts" },
  { method: "POST", path: "/api/leads/search/apollo", name: "lead Apollo search", body: { query: "plumber", location: "Reno, NV" } },
  { method: "POST", path: "/api/leads/search/maps", name: "lead maps search", body: { query: "plumber", location: "Reno, NV" } },
  { method: "POST", path: "/api/leads/personalize", name: "lead pitch personalization", body: { lead: { name: "Auth Audit" } } },
  { method: "POST", path: "/api/chat", name: "SMIRK operator chat", body: { messages: [{ role: "user", content: "auth audit" }] } },
  { method: "GET", path: "/api/chat/debug-context", name: "SMIRK chat debug context" },
  { method: "GET", path: "/api/campaigns", name: "legacy campaigns" },
  { method: "POST", path: "/api/campaigns", name: "legacy campaign create", body: { name: "Auth Audit" } },
  { method: "POST", path: "/api/campaigns/0/launch", name: "legacy campaign launch", body: {} },
  { method: "GET", path: "/api/prospecting/campaigns", name: "prospecting campaigns" },
  { method: "GET", path: "/api/prospecting/campaigns/0", name: "prospecting campaign detail" },
  { method: "POST", path: "/api/prospecting/campaigns", name: "prospecting campaign create", body: { name: "Auth Audit" } },
  { method: "PATCH", path: "/api/prospecting/campaigns/0/status", name: "prospecting campaign status update", body: { status: "paused" } },
  { method: "POST", path: "/api/prospecting/campaigns/0/leads", name: "prospecting lead import", body: { leads: [{ phone: "+15555550123", business_name: "Auth Audit" }] } },
  { method: "POST", path: "/api/prospecting/campaigns/0/search", name: "prospecting lead search", body: { query: "plumber", location: "Reno, NV" } },
  { method: "POST", path: "/api/prospecting/campaigns/0/dial-next", name: "prospecting outbound dial next", body: {} },
  { method: "POST", path: "/api/prospecting/campaigns/0/auto-dial/start", name: "prospecting auto-dial start", body: {} },
  { method: "POST", path: "/api/prospecting/campaigns/0/auto-dial/stop", name: "prospecting auto-dial stop", body: {} },
  { method: "GET", path: "/api/prospecting/campaigns/0/auto-dial/status", name: "prospecting auto-dial status" },
  { method: "GET", path: "/api/prospecting/leads", name: "prospecting leads" },
  { method: "PATCH", path: "/api/prospecting/leads/0", name: "prospecting lead status update", body: { status: "callback" } },
  { method: "GET", path: "/api/prospecting/leads/0/sequence", name: "prospecting lead sequence" },
  { method: "DELETE", path: "/api/prospecting/leads/0/sequence", name: "prospecting sequence cancel" },
  { method: "GET", path: "/api/prospecting/sequences/stats", name: "prospecting sequence stats" },
  { method: "GET", path: "/api/prospecting/sequence-templates", name: "prospecting sequence templates" },
];

const publicChecks = [
  { method: "GET", path: "/api/version", name: "version", okStatuses: [200] },
  { method: "POST", path: "/api/provisioning/request", name: "buyer provisioning request validation", okStatuses: [400, 429] },
  { method: "POST", path: "/api/provisioning/checkout-status", name: "buyer checkout status validation", okStatuses: [400, 429] },
  { method: "POST", path: "/api/checkout/create", name: "buyer checkout create", body: { plan: "starter" }, okStatuses: [200, 400, 429, 503] },
];

function isProtectedStatus(status) {
  return status === 401 || status === 403;
}

const forbiddenProtectedBodySnippets = [
  "workspace_api_key",
  "workspace_id",
  "api_key",
  "invite_token",
  "invite_link",
  "owner_email",
  "email",
  "from_number",
  "to_number",
  "phone_number",
  "call_sid",
  "recording_sid",
  "transcript",
  "recording_url",
  "call_summary",
  "task_notes",
  "messages",
  "provisioning_requests",
  "dashboard_api_key",
  "phone_agent_api_key",
  "phone_agent_provisioning_secret",
  "twilio_auth_token",
  "stripe_secret_key",
  "resend_api_key",
  "openrouter_api_key",
  "database_url",
  "stack",
];

function protectedBodyIsSafe(text) {
  const joined = String(text || "").toLowerCase();
  return !forbiddenProtectedBodySnippets.some((snippet) => joined.includes(snippet));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeFetchError(error) {
  return {
    name: error?.name || null,
    message: String(error?.message || error || ""),
    code: error?.cause?.code || error?.code || null,
    cause: error?.cause?.constructor?.name || null,
  };
}

async function fetchWithTimeout(check, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    return await fetch(`${appUrl}${check.path}`, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithRetry(check, init = {}) {
  const attempts = Math.max(1, fetchAttempts);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchWithTimeout(check, init);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(fetchRetryDelayMs);
      }
    }
  }
  const error = new Error("operational-auth-fetch-failed");
  error.detail = {
    appUrl,
    method: check.method,
    path: check.path,
    name: check.name,
    attempts,
    timeoutMs: fetchTimeoutMs,
    retryDelayMs: fetchRetryDelayMs,
    lastError: normalizeFetchError(lastError),
  };
  throw error;
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
  return fetchTextWithRetry(check, init);
}

async function main() {
  let failures = 0;

  console.log(`SMIRK live operational auth audit for ${appUrl}`);

  for (const check of protectedChecks) {
    const res = await request(check);
    const text = await res.text();
    const ok = isProtectedStatus(res.status) && protectedBodyIsSafe(text);
    console.log(`${ok ? "OK  " : "FAIL"} ${check.method} ${check.path} -> ${res.status} (${check.name})`);
    if (!ok) {
      if (isProtectedStatus(res.status)) {
        console.log(text.slice(0, 240));
      }
      failures += 1;
    }
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
  if (err?.message === "operational-auth-fetch-failed") {
    console.error(JSON.stringify({ ok: false, message: "operational-auth-fetch-failed", detail: err.detail }, null, 2));
  } else {
    console.error(err?.message || String(err));
  }
  process.exit(1);
});
