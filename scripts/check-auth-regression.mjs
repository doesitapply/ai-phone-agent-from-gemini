#!/usr/bin/env node
import fs from "fs";
import path from "path";

const root = path.resolve(process.argv[2] || ".");
const serverPath = path.join(root, "server.ts");
const packagePath = path.join(root, "package.json");
const scriptsPath = path.join(root, "scripts");
const routeSources = [
  { name: "server.ts", text: fs.readFileSync(serverPath, "utf8") },
  { name: path.join("src", "team-routes.ts"), text: fs.readFileSync(path.join(root, "src", "team-routes.ts"), "utf8") },
  ...fs.readdirSync(path.join(root, "src", "routes"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => {
      const relativePath = path.join("src", "routes", entry.name);
      return {
        name: relativePath,
        text: fs.readFileSync(path.join(root, relativePath), "utf8"),
      };
    }),
];

const fail = (message) => {
  console.error(`[check-auth] ${message}`);
  process.exitCode = 1;
};

const server = routeSources.find((source) => source.name === "server.ts")?.text || "";
const provisioningRoutes = routeSources.find((source) => source.name === path.join("src", "routes", "provisioning-routes.ts"))?.text || "";
const saas = fs.readFileSync(path.join(root, "src", "saas.ts"), "utf8");
const bossModePath = path.join(root, "src", "boss-mode.ts");
const bossMode = fs.readFileSync(bossModePath, "utf8");
const smirkChat = fs.readFileSync(path.join(root, "src", "smirk-chat.ts"), "utf8");
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const readScript = (file) => fs.readFileSync(path.join(scriptsPath, file), "utf8");

const forbiddenSnippets = [
  'import basicAuth from "express-basic-auth";',
  "basicAuth(",
  "DASHBOARD_USER",
  "DASHBOARD_PASS",
  "WWW-Authenticate",
  "www-authenticate",
];

for (const snippet of forbiddenSnippets) {
  if (server.includes(snippet)) fail(`server.ts must not contain browser basic-auth snippet: ${snippet}`);
}

const requiredProvisioningSecretSnippets = [
  'import { timingSafeEqual } from "crypto";',
  'const timingSafeSecretEquals = (provided: string, expected: string): boolean => {',
  'if (providedBytes.length !== expectedBytes.length) return false;',
  'return timingSafeEqual(providedBytes, expectedBytes);',
];

for (const snippet of requiredProvisioningSecretSnippets) {
  if (!server.includes(snippet)) {
    fail(`provisioning secret auth must use timing-safe comparison: ${snippet}`);
  }
}

const provisioningSecretBlock = server.match(/const requireProvisioningSecret =[\s\S]*?\n};/)?.[0] || "";
if (!provisioningSecretBlock) {
  fail("server.ts must define requireProvisioningSecret");
}
for (const snippet of [
  "PHONE_AGENT_PROVISIONING_SECRET",
  "const token = readBearerToken(req);",
  'if (!token || !timingSafeSecretEquals(token, expected)) return res.status(401).json({ ok: false, error: "Unauthorized" });',
]) {
  if (!provisioningSecretBlock.includes(snippet)) {
    fail(`requireProvisioningSecret must use timing-safe bearer token auth: ${snippet}`);
  }
}
if (provisioningSecretBlock.includes("token !== expected")) {
  fail("requireProvisioningSecret must not compare bearer tokens with plain string inequality");
}

if (server.includes("req.query.apiKey")) {
  fail("server auth must not accept apiKey from URL query params");
}

const dashboardAuthBlock = server.match(/const dashboardAuth =[\s\S]*?\n};/)?.[0] || "";
if (!dashboardAuthBlock) {
  fail("server.ts must define dashboardAuth");
}
for (const snippet of [
  'const providedApiKey = String(req.headers["x-api-key"] || "").trim();',
  "timingSafeSecretEquals(providedApiKey, operatorApiKey)",
]) {
  if (!dashboardAuthBlock.includes(snippet)) {
    fail(`dashboardAuth must use header-only timing-safe operator auth: ${snippet}`);
  }
}
if (dashboardAuthBlock.includes("req.query") || dashboardAuthBlock.includes("providedApiKey === operatorApiKey")) {
  fail("dashboardAuth must not accept query-string API keys or plain equality operator auth");
}

const testCallSecretBlock = server.match(/const requireTestCallSecret =[\s\S]*?\n};/)?.[0] || "";
if (!testCallSecretBlock) {
  fail("server.ts must define requireTestCallSecret");
}
for (const snippet of [
  'const providedKey = String(req.headers["x-api-key"] || req.body?.secret || "").trim();',
  "timingSafeSecretEquals(providedKey, expected)",
]) {
  if (!testCallSecretBlock.includes(snippet)) {
    fail(`requireTestCallSecret must use header/body-only timing-safe auth: ${snippet}`);
  }
}
if (testCallSecretBlock.includes("req.query") || testCallSecretBlock.includes("providedKey !== expected")) {
  fail("requireTestCallSecret must not accept query-string API keys or plain inequality secret auth");
}

const publicRouteAllowlist = [
  { method: "GET", pattern: /^\/api\/auth\/google\/config$/ },
  { method: "POST", pattern: /^\/api\/auth\/google\/exchange$/ },
  { method: "GET", pattern: /^\/api\/twiml\/appointment-confirm$/ },
  { method: "POST", pattern: /^\/api\/twiml\/appointment-confirm-response$/ },
  { method: "GET", pattern: /^\/api\/twiml\/inline$/ },
  { method: "POST", pattern: /^\/api\/calls$/ },
  { method: "POST", pattern: /^\/api\/twilio\/amd$/ },
  { method: "POST", pattern: /^\/api\/twilio\/status$/ },
  { method: "POST", pattern: /^\/api\/twilio\/incoming$/ },
  { method: "POST", pattern: /^\/api\/twilio\/process$/ },
  { method: "POST", pattern: /^\/api\/twilio\/response$/ },
  { method: "POST", pattern: /^\/api\/twilio\/voicemail$/ },
  { method: "GET", pattern: /^\/api\/tts\/:id$/ },
  { method: "GET", pattern: /^\/api\/health$/ },
  { method: "GET", pattern: /^\/api\/version$/ },
  { method: "POST", pattern: /^\/api\/demo$/ },
  { method: "GET", pattern: /^\/api\/system-health\/public$/ },
  { method: "GET", pattern: /^\/api\/public-proof-snapshot$/ },
  { method: "GET", pattern: /^\/api\/first-dollar-readiness$/ },
  { method: "POST", pattern: /^\/api\/provisioning\/request$/ },
  { method: "POST", pattern: /^\/api\/provisioning\/checkout-status$/ },
  { method: "GET", pattern: /^\/api\/invite\/:token$/ },
  { method: "GET", pattern: /^\/api\/pricing$/ },
  { method: "POST", pattern: /^\/api\/stripe\/webhook$/ },
];

for (const entry of publicRouteAllowlist) {
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(entry.method)) {
    fail(`public route allowlist entry must include an explicit HTTP method: ${entry.pattern}`);
  }
  if (!entry.pattern.source.endsWith("$")) {
    fail(`public route allowlist entry must be an exact route pattern, not a broad prefix: ${entry.method} ${entry.pattern}`);
  }
}

const isAllowedPublicRoute = (method, route) =>
  publicRouteAllowlist.some((entry) => entry.method === method && entry.pattern.test(route));

const workspaceDashboardRouteAllowlist = [
  { method: "GET", route: "/api/team", reason: "buyer workspace team roster" },
  { method: "GET", route: "/api/stats", reason: "buyer dashboard metrics" },
  { method: "GET", route: "/api/call-intelligence", reason: "buyer dashboard proof/review queue" },
  { method: "GET", route: "/api/triage", reason: "buyer missed-call triage bundle" },
  { method: "GET", route: "/api/webhook-url", reason: "workspace setup helper" },
  { method: "POST", route: "/api/workspace/proof-call/request", reason: "buyer activation proof call request" },
  { method: "GET", route: "/api/workspace/activation-events", reason: "buyer activation timeline" },
  { method: "GET", route: "/api/workspace/activation-status", reason: "buyer activation status" },
  { method: "GET", route: "/api/contacts", reason: "buyer workspace contacts" },
  { method: "POST", route: "/api/contacts", reason: "buyer workspace contacts" },
  { method: "GET", route: "/api/contacts/:id", reason: "buyer workspace contacts" },
  { method: "DELETE", route: "/api/contacts/:id", reason: "buyer workspace contacts" },
  { method: "GET", route: "/api/contacts/:id/detail", reason: "buyer workspace contacts" },
  { method: "PATCH", route: "/api/contacts/:id", reason: "buyer workspace contacts" },
  { method: "PUT", route: "/api/contacts/:id/fields", reason: "buyer workspace contacts" },
  { method: "GET", route: "/api/workspace/knowledge", reason: "buyer workspace knowledge base" },
  { method: "POST", route: "/api/workspace/knowledge/import", reason: "buyer workspace knowledge base" },
  { method: "DELETE", route: "/api/workspace/knowledge/:id", reason: "buyer workspace knowledge base" },
  { method: "POST", route: "/api/workspace/generate-prompt", reason: "buyer onboarding prompt generation" },
  { method: "POST", route: "/api/workspace/website-scan", reason: "buyer onboarding website scan" },
  { method: "POST", route: "/api/workspace/greeting-preview", reason: "buyer onboarding greeting preview" },
  { method: "POST", route: "/api/workspace/provision-number", reason: "buyer activation phone provisioning" },
  { method: "GET", route: "/api/workspace/profile", reason: "buyer workspace profile" },
  { method: "PATCH", route: "/api/workspace/profile", reason: "buyer workspace profile" },
  { method: "GET", route: "/api/workspace-overview", reason: "buyer proof dashboard" },
  { method: "GET", route: "/api/tasks", reason: "buyer callback task queue" },
  { method: "PUT", route: "/api/tasks/:id", reason: "buyer callback task actions" },
  { method: "PATCH", route: "/api/tasks/:id", reason: "buyer callback task actions" },
  { method: "POST", route: "/api/tasks/:id/complete", reason: "buyer callback task actions" },
  { method: "POST", route: "/api/tasks/bulk-complete", reason: "buyer callback task actions" },
  { method: "GET", route: "/api/handoffs", reason: "buyer handoff queue" },
  { method: "POST", route: "/api/handoffs/:id/acknowledge", reason: "buyer handoff action" },
  { method: "POST", route: "/api/calls", reason: "buyer outbound proof/test call" },
  { method: "GET", route: "/api/workspaces", reason: "workspace session selection plus operator list branch" },
  { method: "GET", route: "/api/appointments", reason: "buyer calendar read" },
  { method: "GET", route: "/api/appointments/:id", reason: "buyer calendar read" },
  { method: "GET", route: "/api/calendar/events", reason: "buyer calendar read" },
  { method: "GET", route: "/api/recovery/queue", reason: "buyer missed-call recovery queue" },
  { method: "POST", route: "/api/recovery/:callSid/call-back", reason: "buyer callback action" },
  { method: "POST", route: "/api/recovery/:callSid/close", reason: "buyer recovery close action" },
  { method: "GET", route: "/api/recovery/stats", reason: "buyer missed-call recovery metrics" },
  { method: "GET", route: "/api/calendly/config", reason: "buyer setup-help config" },
  { method: "GET", route: "/api/calls", reason: "buyer call history" },
  { method: "GET", route: "/api/calls/active", reason: "buyer live-call status" },
  { method: "GET", route: "/api/calls/:callSid/messages", reason: "buyer call transcript messages" },
  { method: "GET", route: "/api/calls/:sid/transcript", reason: "buyer call transcript" },
  { method: "GET", route: "/api/calls/:sid/recording", reason: "buyer call recording metadata" },
  { method: "GET", route: "/api/recordings/:sid/audio", reason: "buyer call recording playback" },
  { method: "POST", route: "/api/chat", reason: "buyer workspace chat constrained by workspace-safe tool allowlist" },
];

const isAllowedWorkspaceDashboardRoute = (method, route) =>
  workspaceDashboardRouteAllowlist.some((entry) => entry.method === method && entry.route === route);

const authMarkers = [
  'dashboardAuth',
  'requirePhoneAgentApiKey',
  'requireProvisioningSecret',
  'requireTestCallSecret',
  'twilioValidate',
  'validateTwilio',
  'publicDemoRateLimit',
  'express.raw',
];

const routeRegex = /app\.(get|post|put|patch|delete)\(\"([^\"]+)\"([^\n]*)/g;
const routeCallRegex = /app\.(get|post|put|patch|delete)\s*\(/g;
const routeDeclarations = [];
for (const source of routeSources) {
  const parsedRouteIndexes = new Set();
  for (const match of source.text.matchAll(routeRegex)) {
    parsedRouteIndexes.add(match.index);
    const method = match[1].toUpperCase();
    const route = match[2];
    const tail = match[3] || '';
    routeDeclarations.push({ method, route, tail, source: source.name });
    if (!route.startsWith('/api/')) continue;
    if (isAllowedPublicRoute(method, route)) continue;
    if (!authMarkers.some((marker) => tail.includes(marker))) {
      fail(`${source.name}: route ${method} ${route} is missing an auth/guard marker on its declaration line`);
    }
  }

  for (const match of source.text.matchAll(routeCallRegex)) {
    if (parsedRouteIndexes.has(match.index)) continue;
    const lineNumber = source.text.slice(0, match.index).split("\n").length;
    const declarationLine = source.text.slice(match.index, source.text.indexOf("\n", match.index));
    const isProtectedMissionControlArrayRoute = declarationLine.includes(
      'app.get(["/mission-control", "/mission-control/*"], dashboardAuth, requireOperator',
    );
    if (!isProtectedMissionControlArrayRoute) {
      fail(`${source.name}:${lineNumber}: route declaration is not covered by the auth scanner: ${declarationLine.trim()}`);
    }
  }
}

for (const entry of publicRouteAllowlist) {
  const matches = routeDeclarations.filter((item) => item.method === entry.method && entry.pattern.test(item.route));
  if (matches.length === 0) {
    fail(`public route allowlist entry must match a current route declaration: ${entry.method} ${entry.pattern}`);
  }
  if (matches.length > 1) {
    fail(`public route allowlist entry must match only one route declaration: ${entry.method} ${entry.pattern}`);
  }
}

for (const entry of workspaceDashboardRouteAllowlist) {
  const matches = routeDeclarations.filter((item) => item.method === entry.method && item.route === entry.route);
  if (matches.length === 0) {
    fail(`workspace dashboard route allowlist entry must match a current route declaration: ${entry.method} ${entry.route}`);
    continue;
  }
  if (matches.length > 1) {
    fail(`workspace dashboard route allowlist entry must match only one route declaration: ${entry.method} ${entry.route}`);
  }
  for (const match of matches) {
    if (!match.tail.includes("dashboardAuth")) {
      fail(`workspace dashboard route allowlist entry must require dashboardAuth: ${entry.method} ${entry.route}`);
    }
    if (match.tail.includes("requireOperator")) {
      fail(`workspace dashboard route allowlist entry must not be operator-only: ${entry.method} ${entry.route}`);
    }
  }
}

for (const declaration of routeDeclarations) {
  if (!declaration.route.startsWith("/api/")) continue;
  if (!declaration.tail.includes("dashboardAuth") || declaration.tail.includes("requireOperator")) continue;
  if (!isAllowedWorkspaceDashboardRoute(declaration.method, declaration.route)) {
    fail(`${declaration.source}: dashboard-authenticated non-operator route must be explicitly classified as buyer/workspace safe: ${declaration.method} ${declaration.route}`);
  }
}

const routeDeclarationCounts = new Map();
for (const declaration of routeDeclarations) {
  if (!declaration.route.startsWith('/api/')) continue;
  const key = `${declaration.method} ${declaration.route}`;
  const declarations = routeDeclarationCounts.get(key) || [];
  declarations.push(declaration);
  routeDeclarationCounts.set(key, declarations);
}
for (const [key, declarations] of routeDeclarationCounts.entries()) {
  if (declarations.length <= 1) continue;
  const { method, route } = declarations[0];
  if (isAllowedPublicRoute(method, route)) {
    fail(`public route ${key} must not have duplicate declarations`);
  }
  const unguarded = declarations.filter(
    (declaration) => !authMarkers.some((marker) => declaration.tail.includes(marker)),
  );
  if (unguarded.length > 0) {
    fail(`duplicate route ${key} must include an auth/guard marker on every declaration line`);
  }
}

const requireRouteGuard = ({ method, route, markers }) => {
  const declaration = routeDeclarations.find((item) => item.method === method && item.route === route);
  if (!declaration) {
    fail(`missing expected protected route declaration: ${method} ${route}`);
    return;
  }
  for (const marker of markers) {
    if (!declaration.tail.includes(marker)) {
      fail(`route ${method} ${route} must include ${marker} on its declaration line`);
    }
  }
};

[
  { method: "GET", route: "/api/operator/session", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/settings/groups", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/settings", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/settings", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/agent/identity", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/agent/identity", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/settings/test/:service", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/config-status", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/system-health", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/debug/tts", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/compliance/dnc", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/compliance/dnc", markers: ["dashboardAuth", "requireOperator"] },
  { method: "DELETE", route: "/api/compliance/dnc/:phone", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/contacts/:id/dnc", markers: ["dashboardAuth", "requireOperator"] },
  { method: "DELETE", route: "/api/contacts/:id/dnc", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/compliance/audit", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/compliance/check", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/analytics/agents", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/events", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/summaries", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/field-definitions", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/field-definitions", markers: ["dashboardAuth", "requireOperator"] },
  { method: "DELETE", route: "/api/field-definitions/:key", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/openclaw/status", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/openclaw/test", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/openclaw/inject", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/openclaw/active-calls", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/provisioning/requests", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/provision/workspace", markers: ["requireProvisioningSecret"] },
  { method: "POST", route: "/api/scheduled/monthly-usage-reset", markers: ["requireProvisioningSecret"] },
  { method: "POST", route: "/api/admin/run-migrations", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/admin/webhook-buffer-lag", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/calls", markers: ["dashboardAuth"] },
  { method: "POST", route: "/api/calls/fix-stale", markers: ["dashboardAuth", "requireOperator"] },
  { method: "PATCH", route: "/api/calls/fix-stale", markers: ["dashboardAuth", "requireOperator"] },
  { method: "DELETE", route: "/api/calls/:sid", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/calls/:sid/reprocess", markers: ["dashboardAuth", "requireOperator"] },
  { method: "DELETE", route: "/api/calls", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/calls", markers: ["callRateLimit"] },
  { method: "POST", route: "/api/team", markers: ["dashboardAuth", "requireOperator"] },
  { method: "PATCH", route: "/api/team/:id", markers: ["dashboardAuth", "requireOperator"] },
  { method: "PATCH", route: "/api/team/:id/oncall", markers: ["dashboardAuth", "requireOperator"] },
  { method: "DELETE", route: "/api/team/:id", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/tasks", markers: ["dashboardAuth"] },
  { method: "GET", route: "/api/recordings/:sid/audio", markers: ["dashboardAuth"] },
  { method: "GET", route: "/api/integrations/webhook", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/integrations/webhook/deliveries", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/integrations/crm", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/integrations/webhook/test", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/integrations/crm/test", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/tools", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/tools", markers: ["dashboardAuth", "requireOperator"] },
  { method: "PUT", route: "/api/tools/:id", markers: ["dashboardAuth", "requireOperator"] },
  { method: "DELETE", route: "/api/tools/:id", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/tools/:id/test", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/mcp", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/mcp", markers: ["dashboardAuth", "requireOperator"] },
  { method: "PUT", route: "/api/mcp/:id", markers: ["dashboardAuth", "requireOperator"] },
  { method: "DELETE", route: "/api/mcp/:id", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/mcp/:id/test", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/plugin-tools", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/plugin-tools", markers: ["dashboardAuth", "requireOperator"] },
  { method: "PUT", route: "/api/plugin-tools/:id", markers: ["dashboardAuth", "requireOperator"] },
  { method: "DELETE", route: "/api/plugin-tools/:id", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/mcp-servers", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/mcp-servers", markers: ["dashboardAuth", "requireOperator"] },
  { method: "PUT", route: "/api/mcp-servers/:id", markers: ["dashboardAuth", "requireOperator"] },
  { method: "DELETE", route: "/api/mcp-servers/:id", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/prospecting/campaigns", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/prospecting/campaigns", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/prospecting/campaigns/:id", markers: ["dashboardAuth", "requireOperator"] },
  { method: "PATCH", route: "/api/prospecting/campaigns/:id/status", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/prospecting/campaigns/:id/leads", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/prospecting/campaigns/:id/search", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/prospecting/leads", markers: ["dashboardAuth", "requireOperator"] },
  { method: "PATCH", route: "/api/prospecting/leads/:id", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/prospecting/campaigns/:id/dial-next", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/prospecting/campaigns/:id/auto-dial/start", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/prospecting/campaigns/:id/auto-dial/stop", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/prospecting/campaigns/:id/auto-dial/status", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/prospecting/sequences/stats", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/prospecting/leads/:id/sequence", markers: ["dashboardAuth", "requireOperator"] },
  { method: "DELETE", route: "/api/prospecting/leads/:id/sequence", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/prospecting/sequence-templates", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/leads", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/leads", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/leads/upsert", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/leads/funnel", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/leads/scoreboard", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/leads/alerts", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/leads/search/apollo", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/leads/search/maps", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/leads/personalize", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/campaigns", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/campaigns", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/campaigns/:id/launch", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/chat", markers: ["dashboardAuth"] },
  { method: "GET", route: "/api/chat/debug-context", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/sms/safety", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/sms/test", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/sms/incoming", markers: ["validateTwilio"] },
  { method: "POST", route: "/api/sms/status", markers: ["validateTwilio"] },
  { method: "PATCH", route: "/api/appointments/:id", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/appointments", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/calendar/test-booking", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/agents", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/agents/active", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/agents/:id", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/agents", markers: ["dashboardAuth", "requireOperator"] },
  { method: "PUT", route: "/api/agents/:id/activate", markers: ["dashboardAuth", "requireOperator"] },
  { method: "PUT", route: "/api/agents/:id", markers: ["dashboardAuth", "requireOperator"] },
  { method: "PATCH", route: "/api/agents/:id", markers: ["dashboardAuth", "requireOperator"] },
  { method: "DELETE", route: "/api/agents/:id", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/checkout/create", markers: ["publicDemoRateLimit"] },
  { method: "POST", route: "/api/provisioning/request", markers: ["publicDemoRateLimit"] },
  { method: "POST", route: "/api/provisioning/checkout-status", markers: ["publicDemoRateLimit"] },
  { method: "GET", route: "/api/invite/:token", markers: ["publicDemoRateLimit"] },
  { method: "POST", route: "/api/stripe/webhook", markers: ["express.raw"] },
  { method: "POST", route: "/api/recovery/direct-dial", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/twilio/test-webhook", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/twilio/test-call", markers: ["dashboardAuth", "requireOperator"] },
].forEach(requireRouteGuard);

for (const removedRoute of [
  "/api/twilio/test-sms",
  "/api/twilio/sms",
  "/api/twilio/sms-status",
  "/api/contacts/:id/sms",
  "/api/recovery/:callSid/text" + "-back",
]) {
  if (server.includes(removedRoute)) {
    fail(`legacy texting route must stay removed from public API: ${removedRoute}`);
  }
}

if (!server.includes('app.get(["/mission-control", "/mission-control/*"], dashboardAuth, requireOperator')) {
  fail("Mission Control routes must require dashboardAuth and requireOperator");
}
if (!server.includes("registerBossModeRoutes(app, dashboardAuth, requireOperator")) {
  fail("Boss Mode routes must be registered with dashboardAuth and requireOperator");
}
for (const snippet of [
  'export type ChatAccessMode = "operator" | "workspace";',
]) {
  if (!smirkChat.includes(snippet)) {
    fail(`workspace SMIRK chat must preserve the constrained tool access contract: ${snippet}`);
  }
}
if (!smirkChat.includes("const WORKSPACE_ALLOWED_TOOLS = new Set([")) {
  fail("workspace SMIRK chat must preserve the constrained tool access contract: const WORKSPACE_ALLOWED_TOOLS = new Set([");
}
if (!smirkChat.includes("const toolDeclarationsForAccessMode = (accessMode: ChatAccessMode)")) {
  fail("workspace SMIRK chat must preserve the constrained tool access contract: const toolDeclarationsForAccessMode = (accessMode: ChatAccessMode)");
}
if (!smirkChat.includes('if (accessMode !== "operator" && !WORKSPACE_ALLOWED_TOOLS.has(name))')) {
  fail("workspace SMIRK chat must deny tools outside the workspace allowlist");
}
for (const forbiddenWorkspaceTool of [
  '"start_call"',
  '"update_settings"',
  '"update_agent_prompt"',
  '"set_team_oncall"',
  '"inject_live_briefing"',
  '"create_calendar_event"',
]) {
  const allowlistBlock = smirkChat.match(/const WORKSPACE_ALLOWED_TOOLS = new Set<string>\(\[[\s\S]*?\]\);/)?.[0] || "";
  if (allowlistBlock.includes(forbiddenWorkspaceTool)) {
    fail(`workspace SMIRK chat allowlist must not include operator-only tool ${forbiddenWorkspaceTool}`);
  }
}
const callRoutes = routeSources.find((source) => source.name === path.join("src", "routes", "call-routes.ts"))?.text || "";
const callListBlock = callRoutes.match(/app\.get\("\/api\/calls"[\s\S]*?\n  }\);/)?.[0] || "";
if (!callListBlock) {
  fail("buyer call list route must exist");
} else {
  for (const forbidden of [
    "SELECT c.*",
    "c.workspace_id,",
    "c.business_id",
    "c.contact_id,",
    "c.workflow_stage",
    "c.openclaw_agent_id",
    "c.is_deduplicated",
    "c.resolution_score",
  ]) {
    if (callListBlock.includes(forbidden)) {
      fail(`buyer call list route must not expose broad call rows: ${forbidden}`);
    }
  }
  for (const required of [
    "c.id",
    "c.call_sid",
    "c.direction",
    "c.to_number",
    "c.from_number",
    "c.status",
    "c.started_at",
    "c.ended_at",
    "c.duration_seconds",
    "c.agent_name",
    "mc.message_count",
    "co.name as contact_name",
    "cs.intent",
    "cs.outcome",
    "cs.summary as call_summary",
    "cs.resolution_score as summary_score",
    "cs.next_action",
    "cs.sentiment",
    "WHERE c.workspace_id = ${wsId}",
  ]) {
    if (!callListBlock.includes(required)) {
      fail(`buyer call list route must return an explicit call history payload: ${required}`);
    }
  }
}
const callMessagesBlock = callRoutes.match(/app\.get\("\/api\/calls\/:callSid\/messages"[\s\S]*?\n  }\);/)?.[0] || "";
if (!callMessagesBlock) {
  fail("call detail messages route must exist");
} else {
  for (const forbidden of [
    "FROM call_events",
    "payload",
    "events,",
    "SELECT * FROM calls",
    "SELECT * FROM messages",
    "SELECT * FROM call_summaries",
    "call:",
    "summary:",
  ]) {
    if (callMessagesBlock.includes(forbidden)) {
      fail(`buyer call detail messages route must not expose raw operational rows: ${forbidden}`);
    }
  }
  for (const required of [
    "SELECT id, role, text, created_at",
    "res.json({ messages });",
  ]) {
    if (!callMessagesBlock.includes(required)) {
      fail(`buyer call detail messages route must return a minimal transcript payload: ${required}`);
    }
  }
}
const activeCallsBlock = callRoutes.match(/app\.get\("\/api\/calls\/active"[\s\S]*?\n  }\);/)?.[0] || "";
if (!activeCallsBlock) {
  fail("buyer active calls route must exist");
} else {
  for (const forbidden of [
    "SELECT *",
    "FROM call_events",
    "payload",
    "c.to_number",
    "agent_name",
    "duration_seconds",
  ]) {
    if (activeCallsBlock.includes(forbidden)) {
      fail(`buyer active calls route must return minimal live-call status: ${forbidden}`);
    }
  }
  for (const required of [
    "SELECT c.call_sid, c.from_number, c.started_at, c.direction, c.turn_count",
    "co.name as contact_name",
    "WHERE c.status = 'in-progress' AND c.workspace_id = ${wsId}",
    "res.json(activeCalls);",
  ]) {
    if (!activeCallsBlock.includes(required)) {
      fail(`buyer active calls route must be tenant-scoped and minimal: ${required}`);
    }
  }
}
const callTranscriptBlock = callRoutes.match(/app\.get\("\/api\/calls\/:sid\/transcript"[\s\S]*?\n  }\);/)?.[0] || "";
if (!callTranscriptBlock) {
  fail("buyer transcript route must exist");
} else {
  for (const forbidden of [
    "SELECT *",
    "FROM call_events",
    "payload",
    "call:",
    "summary:",
  ]) {
    if (callTranscriptBlock.includes(forbidden)) {
      fail(`buyer transcript route must not expose raw operational rows: ${forbidden}`);
    }
  }
  for (const required of [
    "if (!/^CA[a-f0-9]{32}$/i.test(sid))",
    "SELECT call_sid FROM calls WHERE call_sid = ${sid} AND workspace_id = ${wsId} LIMIT 1",
    "SELECT role, text, created_at FROM messages",
    "WHERE call_sid = ${sid} AND role IN ('user', 'assistant')",
    "res.json({ callSid: sid, transcript: lines });",
  ]) {
    if (!callTranscriptBlock.includes(required)) {
      fail(`buyer transcript route must be valid-SID scoped and minimal: ${required}`);
    }
  }
}
const callRecordingBlock = callRoutes.match(/app\.get\("\/api\/calls\/:sid\/recording"[\s\S]*?\n  }\);/)?.[0] || "";
if (!callRecordingBlock) {
  fail("buyer call recording metadata route must exist");
} else {
  for (const required of [
    "if (!/^CA[a-f0-9]{32}$/i.test(sid))",
    "const wsId = getWorkspaceId(req);",
    "SELECT call_sid FROM calls WHERE call_sid = ${sid} AND workspace_id = ${wsId} LIMIT 1",
    "if (!callRows.length) return res.status(404).json({ error: \"Call not found.\" });",
    "url: `/api/recordings/${r.sid}/audio?callSid=${encodeURIComponent(sid)}`",
  ]) {
    if (!callRecordingBlock.includes(required)) {
      fail(`buyer call recording metadata route must be callSid-bound and tenant-scoped: ${required}`);
    }
  }
}
const recordingAudioBlock = callRoutes.match(/app\.get\("\/api\/recordings\/:sid\/audio"[\s\S]*?\n  }\);/)?.[0] || "";
if (!recordingAudioBlock) {
  fail("buyer recording audio proxy route must exist");
} else {
  for (const required of [
    "const callSid = String(req.query.callSid || \"\");",
    "if (!/^RE[a-f0-9]{32}$/i.test(sid))",
    "if (!/^CA[a-f0-9]{32}$/i.test(callSid))",
    "const wsId = getWorkspaceId(req);",
    "SELECT call_sid FROM calls WHERE call_sid = ${callSid} AND workspace_id = ${wsId} LIMIT 1",
    "if (!callRows.length) return res.status(404).json({ error: \"Call not found.\" });",
    `Recordings/\${sid}.json`,
    "if (recording.call_sid !== callSid) return res.status(404).json({ error: 'Recording not found' });",
  ]) {
    if (!recordingAudioBlock.includes(required)) {
      fail(`buyer recording audio proxy must require a workspace-owned call SID: ${required}`);
    }
  }
}
const contactRoutes = routeSources.find((source) => source.name === path.join("src", "routes", "contact-routes.ts"))?.text || "";
const contactListBlock = contactRoutes.match(/app\.get\("\/api\/contacts"[\s\S]*?\n  }\);/)?.[0] || "";
if (!contactListBlock) {
  fail("buyer contact list route must exist");
} else {
  for (const forbidden of [
    "SELECT c.*",
    "created_at",
    "updated_at",
    "tags",
    "address",
    "notes",
  ]) {
    if (contactListBlock.includes(forbidden)) {
      fail(`buyer contact list route must not expose broad contact rows: ${forbidden}`);
    }
  }
  for (const required of [
    "c.id",
    "c.phone_number",
    "c.name",
    "c.email",
    "c.company_name",
    "c.last_seen",
    "c.last_summary",
    "c.last_outcome",
    "c.open_tasks_count",
    "c.do_not_call",
    "c.status",
    "COUNT(ca.id) as total_calls",
  ]) {
    if (!contactListBlock.includes(required)) {
      fail(`buyer contact list route must return a minimal contact list payload: ${required}`);
    }
  }
}
const contactDetailBlock = contactRoutes.match(/app\.get\("\/api\/contacts\/:id\/detail"[\s\S]*?\n  }\);/)?.[0] || "";
if (!contactDetailBlock) {
  fail("buyer contact detail route must exist");
} else {
  for (const forbidden of [
    "SELECT * FROM contacts",
    "SELECT c.*",
    "SELECT * FROM calls",
    "SELECT * FROM tasks",
    "SELECT * FROM appointments",
    "SELECT * FROM call_summaries",
    "SELECT * FROM contact_custom_fields",
  ]) {
    if (contactDetailBlock.includes(forbidden)) {
      fail(`buyer contact detail route must not expose broad operational rows: ${forbidden}`);
    }
  }
  for (const required of [
    "c.id",
    "c.phone_number",
    "c.name",
    "c.email",
    "c.company_name",
    "c.address",
    "c.notes",
    "c.status",
    "COUNT(ca.id) as total_calls",
    "c.call_sid",
    "c.direction",
    "c.from_number",
    "c.to_number",
    "cs.summary as call_summary",
    "SELECT id, contact_id, call_sid, task_type, title, description, priority, status, notes, due_at, created_at, assigned_to",
    "SELECT id, contact_id, scheduled_at, service_type, notes, technician, location, duration_minutes, status, created_at",
    "SELECT id, call_sid, intent, outcome, sentiment, resolution_score, summary, next_action, created_at",
    "SELECT field_key, field_value, confidence, source, transcript_snippet, updated_at",
  ]) {
    if (!contactDetailBlock.includes(required)) {
      fail(`buyer contact detail route must return an explicit contact detail payload: ${required}`);
    }
  }
}
const taskRoutes = routeSources.find((source) => source.name === path.join("src", "routes", "task-routes.ts"))?.text || "";
const taskListBlock = taskRoutes.match(/app\.get\("\/api\/tasks"[\s\S]*?\n  }\);/)?.[0] || "";
if (!taskListBlock) {
  fail("buyer task list route must exist");
} else {
  for (const forbidden of [
    "SELECT t.*",
    "completed_at",
    "updated_at",
  ]) {
    if (taskListBlock.includes(forbidden)) {
      fail(`buyer task list route must not expose broad task rows: ${forbidden}`);
    }
  }
  for (const required of [
    "t.id",
    "t.contact_id",
    "t.call_sid",
    "t.task_type",
    "t.title",
    "t.description",
    "t.priority",
    "t.status",
    "t.notes",
    "t.due_at",
    "t.created_at",
    "t.assigned_to",
    "co.name as contact_name",
    "co.phone_number",
  ]) {
    if (!taskListBlock.includes(required)) {
      fail(`buyer task list route must return an explicit callback-task payload: ${required}`);
    }
  }
}
const operationsRoutes = routeSources.find((source) => source.name === path.join("src", "routes", "operations-routes.ts"))?.text || "";
const handoffListBlock = operationsRoutes.match(/app\.get\("\/api\/handoffs"[\s\S]*?\n  }\);/)?.[0] || "";
if (!handoffListBlock) {
  fail("buyer handoff list route must exist");
} else {
  for (const forbidden of [
    "SELECT h.*",
    "workspace_id,",
    "contact_id,",
    "updated_at",
  ]) {
    if (handoffListBlock.includes(forbidden)) {
      fail(`buyer handoff list route must not expose broad handoff rows: ${forbidden}`);
    }
  }
  for (const required of [
    "h.id",
    "h.call_sid",
    "h.reason",
    "h.urgency",
    "h.status",
    "h.notes",
    "h.recommended_action",
    "h.transcript_snippet",
    "h.created_at",
    "h.acknowledged_at",
    "h.assigned_to_name",
    "h.assigned_to_phone",
    "h.assigned_to_email",
    "co.name as contact_name",
    "co.phone_number",
  ]) {
    if (!handoffListBlock.includes(required)) {
      fail(`buyer handoff list route must return an explicit handoff queue payload: ${required}`);
    }
  }
}
const calendarRoutes = routeSources.find((source) => source.name === path.join("src", "routes", "calendar-routes.ts"))?.text || "";
const appointmentListBlock = calendarRoutes.match(/app\.get\("\/api\/appointments"[\s\S]*?\n  }\);/)?.[0] || "";
const appointmentDetailBlock = calendarRoutes.match(/app\.get\("\/api\/appointments\/:id"[\s\S]*?\n  }\);/)?.[0] || "";
if (!appointmentListBlock) {
  fail("buyer appointment list route must exist");
} else {
  for (const forbidden of [
    "SELECT a.*",
    "workspace_id,",
    "business_id",
    "calendar_event_id",
    "calendly_event_uri",
    "calendly_invitee_uri",
    "confirmation_call_sid",
  ]) {
    if (appointmentListBlock.includes(forbidden)) {
      fail(`buyer appointment list route must not expose broad appointment rows: ${forbidden}`);
    }
  }
  for (const required of [
    "${appointmentSelect()}",
    "WHERE a.workspace_id = ${wsId}",
  ]) {
    if (!appointmentListBlock.includes(required)) {
      fail(`buyer appointment list route must use the explicit workspace appointment payload: ${required}`);
    }
  }
}
if (!appointmentDetailBlock) {
  fail("buyer appointment detail route must exist");
} else {
  for (const forbidden of [
    "SELECT a.*",
    "calendar_event_id",
    "calendly_event_uri",
    "calendly_invitee_uri",
    "confirmation_call_sid",
  ]) {
    if (appointmentDetailBlock.includes(forbidden)) {
      fail(`buyer appointment detail route must not expose broad appointment rows: ${forbidden}`);
    }
  }
  for (const required of [
    "${appointmentSelect()}",
    "const wsId = getWorkspaceId(req);",
    "WHERE a.id = ${id} AND a.workspace_id = ${wsId}",
  ]) {
    if (!appointmentDetailBlock.includes(required)) {
      fail(`buyer appointment detail route must use tenant-scoped explicit appointment payload: ${required}`);
    }
  }
}
for (const required of [
  "a.id",
  "a.contact_id",
  "a.call_sid",
  "a.scheduled_at",
  "a.service_type",
  "a.notes",
  "a.technician",
  "a.location",
  "a.duration_minutes",
  "a.status",
  "a.created_at",
  "c.name as contact_name",
  "c.phone_number",
]) {
  if (!calendarRoutes.includes(required)) {
    fail(`buyer appointment routes must define an explicit appointment payload: ${required}`);
  }
}
const recoveryRoutes = routeSources.find((source) => source.name === path.join("src", "routes", "recovery-routes.ts"))?.text || "";
const recoveryQueueBlock = recoveryRoutes.match(/app\.get\("\/api\/recovery\/queue"[\s\S]*?\n  }\);/)?.[0] || "";
if (!recoveryQueueBlock) {
  fail("buyer recovery queue route must exist");
} else {
  for (const forbidden of [
    "SELECT c.*",
    "c.to_number",
    "c.status,",
    "c.recovery_status",
    "last_sms_preview",
    "meta:",
    "...r",
  ]) {
    if (recoveryQueueBlock.includes(forbidden)) {
      fail(`buyer recovery queue route must not expose raw call metadata: ${forbidden}`);
    }
  }
  for (const required of [
    "c.call_sid",
    "c.from_number",
    "c.started_at",
    "c.duration_seconds",
    "c.turn_count",
    "c.contact_id",
    "co.name as contact_name",
    "c.recovery_call_back_started_at",
    "c.recovery_closed_at",
    "WHERE c.workspace_id = ${wsId}",
    "id: r.call_sid",
    "call_sid: r.call_sid",
    "contact_id: contactId || 0",
    "name: contactName",
    "phone_number: r.from_number",
    "reason",
    "priority",
    "last_touch_at: r.started_at",
    "status",
    "res.json({ days, items });",
  ]) {
    if (!recoveryQueueBlock.includes(required)) {
      fail(`buyer recovery queue route must return an explicit missed-call recovery payload: ${required}`);
    }
  }
}
const dashboardRoutes = routeSources.find((source) => source.name === path.join("src", "routes", "dashboard-routes.ts"))?.text || "";
const callIntelligenceBlock = dashboardRoutes.match(/app\.get\("\/api\/call-intelligence"[\s\S]*?\n  }\);/)?.[0] || "";
if (!callIntelligenceBlock) {
  fail("buyer call intelligence route must exist");
} else {
  for (const forbidden of [
    "SELECT *",
    "FROM call_events",
    "payload",
    "c.to_number",
    "toNumber:",
    "co.phone_number",
  ]) {
    if (callIntelligenceBlock.includes(forbidden)) {
      fail(`buyer call intelligence route must not expose raw operational/customer rows: ${forbidden}`);
    }
  }
  for (const required of [
    "LEFT JOIN call_summaries cs ON cs.call_sid = c.call_sid AND cs.workspace_id = c.workspace_id",
    "LEFT JOIN contacts co ON co.id = c.contact_id AND co.workspace_id = c.workspace_id",
    "FROM handoffs",
    "WHERE workspace_id = ${wsId}",
    "FROM tasks",
    "fromNumber: row.from_number",
    "hasRecording: Boolean(row.recording_url)",
  ]) {
    if (!callIntelligenceBlock.includes(required)) {
      fail(`buyer call intelligence route must be tenant-scoped and stripped to review payload: ${required}`);
    }
  }
}
const triageBlock = dashboardRoutes.match(/app\.get\("\/api\/triage"[\s\S]*?\n  }\);/)?.[0] || "";
if (!triageBlock) {
  fail("buyer triage route must exist");
} else {
  for (const forbidden of [
    "SELECT *",
    "FROM call_events",
    "payload",
    "c.to_number",
    "co.phone_number",
    "contact_phone",
  ]) {
    if (triageBlock.includes(forbidden)) {
      fail(`buyer triage route must not expose extra operational/customer fields: ${forbidden}`);
    }
  }
  for (const required of [
    "LEFT JOIN contacts co ON c.contact_id = co.id AND co.workspace_id = c.workspace_id",
    "LEFT JOIN call_summaries cs ON c.call_sid = cs.call_sid AND cs.workspace_id = c.workspace_id",
    "WHERE c.workspace_id = ${wsId}",
    "from_number: r.from_number",
    "res.json({",
  ]) {
    if (!triageBlock.includes(required)) {
      fail(`buyer triage route must use tenant-scoped joins and minimal callback payload: ${required}`);
    }
  }
}
if (!bossMode.includes("export function registerBossModeRoutes(app: Express, dashboardAuth: RequestHandler, requireOperator: RequestHandler, dbEnabled: boolean): void")) {
  fail("Boss Mode route registration must require explicit dashboardAuth and requireOperator middleware");
}
if (/registerBossModeRoutes\(app:\s*Express,\s*dashboardAuth:\s*RequestHandler\s*=/.test(bossMode)) {
  fail("Boss Mode route registration must not default dashboardAuth to a no-op middleware");
}
for (const snippet of [
  'router.get("/settings", dashboardAuth, requireOperator',
  'router.post("/settings", dashboardAuth, requireOperator',
  'router.get("/context", dashboardAuth, requireOperator',
  'router.post("/context", dashboardAuth, requireOperator',
  'router.delete("/context/:id", dashboardAuth, requireOperator',
  'router.get("/audit", dashboardAuth, requireOperator',
  'router.get("/metrics", dashboardAuth, requireOperator',
]) {
  if (!bossMode.includes(snippet)) {
    fail(`Boss Mode dashboard route must require operator auth: ${snippet}`);
  }
}
if (!provisioningRoutes.includes("request_summary: requestSummary")) {
  fail("public checkout-status must return a sanitized request_summary instead of the raw provisioning request");
}
if (provisioningRoutes.includes("request: row")) {
  fail("public checkout-status must not return raw provisioning request rows");
}
if (!provisioningRoutes.includes("inviteLink: null")) {
  fail("public checkout-status activation_status must strip inviteLink");
}
if (!provisioningRoutes.includes("workspaceId: null")) {
  fail("public checkout-status activation_status must strip internal workspaceId");
}
if (!provisioningRoutes.includes("exceptionReason: null")) {
  fail("public checkout-status activation_status must strip internal exceptionReason");
}
const checkoutStatusBlock = provisioningRoutes.match(/app\.post\("\/api\/provisioning\/checkout-status"[\s\S]*?\n  }\);/)?.[0] || "";
if (!checkoutStatusBlock) {
  fail("public checkout-status route must exist");
} else {
  for (const forbidden of [
    "w.business_phone as w_business_phone",
    "w.business_address as w_business_address",
    "w.service_area as w_service_area",
    "w.business_hours as w_business_hours",
    "w.inbound_greeting as w_inbound_greeting",
    "w.owner_phone as w_owner_phone",
    "w.notification_email as w_notification_email",
    "w.twilio_phone_number as w_twilio_phone_number",
    "w.escalation_preference as w_escalation_preference",
    "w.proof_call_target as w_proof_call_target",
  ]) {
    if (checkoutStatusBlock.includes(forbidden)) {
      fail(`public checkout-status must not select raw workspace setup fields: ${forbidden}`);
    }
  }
  for (const required of [
    "w_callback_phone_configured",
    "w_service_area_configured",
    "w_business_hours_configured",
    "w_inbound_greeting_configured",
    "w_owner_email_configured",
    "w_setup_completed",
    "w_twilio_phone_configured",
    "w_escalation_preference_configured",
    "w_proof_call_target_configured",
    "business_phone: row.w_callback_phone_configured ? \"__configured__\" : null",
    "workspaceTwilioNumber: row.w_twilio_phone_configured ? \"__configured__\" : null",
  ]) {
    if (!checkoutStatusBlock.includes(required)) {
      fail(`public checkout-status must derive setup readiness from configured booleans: ${required}`);
    }
  }
}
const proofRoutes = routeSources.find((source) => source.name === path.join("src", "routes", "proof-routes.ts"))?.text || "";
const operatorEventsBlock = proofRoutes.match(/app\.get\("\/api\/events"[\s\S]*?\n  }\);/)?.[0] || "";
if (!operatorEventsBlock) {
  fail("operator event feed route must exist");
} else {
  for (const forbidden of [
    "SELECT ce.*",
    "c.from_number",
    "c.to_number",
    "LEFT JOIN calls",
  ]) {
    if (operatorEventsBlock.includes(forbidden)) {
      fail(`operator event feed route must not expose broad joined rows: ${forbidden}`);
    }
  }
  for (const required of [
    "app.get(\"/api/events\", dashboardAuth, requireOperator",
    "if (call_sid && !/^CA[a-f0-9]{32}$/i.test(call_sid))",
    "SELECT ce.id, ce.call_sid, ce.event_type, ce.payload, ce.created_at",
    "JOIN calls c ON ce.call_sid = c.call_sid",
    "WHERE c.workspace_id = ${wsId}",
    "res.json({ events: rows, total: rows.length });",
  ]) {
    if (!operatorEventsBlock.includes(required)) {
      fail(`operator event feed route must be explicit and workspace-scoped: ${required}`);
    }
  }
}
const operatorSummariesBlock = operationsRoutes.match(/app\.get\("\/api\/summaries"[\s\S]*?\n  }\);/)?.[0] || "";
if (!operatorSummariesBlock) {
  fail("operator summary feed route must exist");
} else {
  for (const forbidden of [
    "SELECT cs.*",
    "co.phone_number",
    "SELECT *",
  ]) {
    if (operatorSummariesBlock.includes(forbidden)) {
      fail(`operator summary feed route must not expose broad joined rows: ${forbidden}`);
    }
  }
  for (const required of [
    "app.get(\"/api/summaries\", dashboardAuth, requireOperator",
    "cs.call_sid",
    "cs.intent",
    "cs.outcome",
    "cs.summary",
    "cs.next_action",
    "cs.sentiment",
    "cs.resolution_score",
    "cs.extracted_entities",
    "LEFT JOIN contacts co ON cs.contact_id = co.id AND co.workspace_id = cs.workspace_id",
    "WHERE cs.workspace_id = ${wsId}",
    "res.json(summaries);",
  ]) {
    if (!operatorSummariesBlock.includes(required)) {
      fail(`operator summary feed route must be explicit and workspace-scoped: ${required}`);
    }
  }
}
const adminMaintenanceRoutes = routeSources.find((source) => source.name === path.join("src", "routes", "admin-maintenance-routes.ts"))?.text || "";
const publicSystemHealthBlock =
  adminMaintenanceRoutes.match(/app\.get\("\/api\/system-health\/public"[\s\S]*?\n  }\);/)?.[0] || "";
if (!publicSystemHealthBlock) {
  fail("public system health route must exist");
}
for (const field of [
  "status",
  "timestamp",
  "service",
]) {
  if (!publicSystemHealthBlock.includes(field)) {
    fail(`public system health route must expose minimal health field: ${field}`);
  }
}
for (const forbidden of [
  "process.env",
  "DATABASE_URL",
  "PHONE_AGENT_API_KEY",
  "PHONE_AGENT_PROVISIONING_SECRET",
  "DASHBOARD_API_KEY",
  "workspace_api_key",
  "invite_token",
  "owner_email",
  "from_number",
  "to_number",
  "phone_number",
  "transcript",
  "recording_url",
  "call_summary",
  "task_notes",
  "messages",
  "sql`",
  "dbEnabled",
  "operator",
  "workspace",
]) {
  if (publicSystemHealthBlock.includes(forbidden)) {
    fail(`public system health route must not expose operational data: ${forbidden}`);
  }
}
const publicProofBlock = proofRoutes.match(/app\.get\("\/api\/public-proof-snapshot"[\s\S]*?\n  }\);/)?.[0] || "";
if (!publicProofBlock) {
  fail("public proof snapshot route must exist");
}
for (const field of [
  "totalCalls",
  "callsThisMonth",
  "summariesGenerated",
  "callbackTasksCreated",
  "ownerEmailAlertsSent",
  "completeProofCalls",
  "summaryCoverage",
  "proofFreshness",
]) {
  if (!publicProofBlock.includes(field)) {
    fail(`public proof snapshot must expose aggregate proof field: ${field}`);
  }
}
for (const forbidden of [
  "from_number",
  "to_number",
  "phone_number",
  "transcript",
  "recording_url",
  "call_summary",
  "task_notes",
  "messages",
  "owner_email",
  "email",
]) {
  if (publicProofBlock.includes(forbidden)) {
    fail(`public proof snapshot must not expose raw customer/operator data: ${forbidden}`);
  }
}
const buyerRoutes = routeSources.find((source) => source.name === path.join("src", "routes", "buyer-routes.ts"))?.text || "";
const firstDollarReadinessBlock = buyerRoutes.match(/app\.get\("\/api\/first-dollar-readiness"[\s\S]*?\n  }\);/)?.[0] || "";
if (!firstDollarReadinessBlock) {
  fail("public first-dollar readiness route must exist");
}
for (const field of [
  "checkoutReady",
  "planCount",
]) {
  if (!firstDollarReadinessBlock.includes(field)) {
    fail(`public first-dollar readiness must expose buyer-safe readiness field: ${field}`);
  }
}
if (!firstDollarReadinessBlock.includes('"readiness_check_failed"')) {
  fail("public first-dollar readiness must use a generic error string");
}
for (const forbidden of [
  "missing",
  "checkout_urls_in_pricing",
  "DATABASE_URL",
  "PHONE_AGENT_API_KEY",
  "PHONE_AGENT_PROVISIONING_SECRET",
  "DASHBOARD_API_KEY",
  "workspace_api_key",
  "invite_token",
  "owner_email",
  "from_number",
  "to_number",
  "phone_number",
  "transcript",
  "recording_url",
  "call_summary",
  "task_notes",
  "messages",
  "e.message",
]) {
  if (firstDollarReadinessBlock.includes(forbidden)) {
    fail(`public first-dollar readiness must not expose operational detail: ${forbidden}`);
  }
}
const inviteRouteBlock = buyerRoutes.match(/app\.get\("\/api\/invite\/:token"[\s\S]*?\n  }\);/)?.[0] || "";
const generateApiKeyBlock = saas.match(/function generateApiKey\(\): string \{[\s\S]*?\n\}/)?.[0] || "";
const generateInviteTokenBlock = saas.match(/function generateInviteToken\(\): string \{[\s\S]*?\n\}/)?.[0] || "";
if (!buyerRoutes.includes("const isPlausibleInviteToken = (token: string): boolean =>")) {
  fail("public invite acceptance must validate token shape before database lookup");
}
if (!buyerRoutes.includes("/^[a-f0-9]{64}$/i.test(token)") || !buyerRoutes.includes("/^[A-Za-z0-9]{48}$/.test(token)")) {
  fail("public invite token validation must accept current crypto tokens and legacy pending invite tokens");
}
if (!inviteRouteBlock.includes("if (!isPlausibleInviteToken(token))")) {
  fail("public invite acceptance route must reject malformed invite tokens before database lookup");
}
if (!saas.includes('import { randomBytes } from "crypto";')) {
  fail("workspace API keys and invite tokens must use crypto randomBytes");
}
if (!generateApiKeyBlock.includes("randomBytes(") || generateApiKeyBlock.includes("Math.random")) {
  fail("workspace API keys must be generated with crypto randomBytes, not Math.random");
}
if (!generateInviteTokenBlock.includes("randomBytes(") || generateInviteTokenBlock.includes("Math.random")) {
  fail("invite tokens must be generated with crypto randomBytes, not Math.random");
}
if (!inviteRouteBlock.includes('res.setHeader("Cache-Control", "no-store");')) {
  fail("public invite acceptance route must set Cache-Control: no-store before returning workspace credentials");
}
if (!inviteRouteBlock.includes('res.setHeader("Pragma", "no-cache");')) {
  fail("public invite acceptance route must set Pragma: no-cache before returning workspace credentials");
}
if (!saas.includes("UPDATE workspace_members SET accepted_at = NOW(), invite_token = NULL")) {
  fail("public invite acceptance must clear invite_token so invites are single-use");
}
if (!inviteRouteBlock.includes("invite_token: undefined")) {
  fail("public invite acceptance response must not echo invite_token in the returned member object");
}

const requiredScripts = {
  "check:auth": "node scripts/check-auth-regression.mjs .",
  "smoke:buyer-auth": "bash scripts/buyer-funnel-auth-smoke.sh",
  "openclaw:automate": "node scripts/fix-openclaw.mjs",
  "openclaw:check": "node scripts/fix-openclaw.mjs --dry-run",
};

for (const [name, command] of Object.entries(requiredScripts)) {
  if (pkg.scripts?.[name] !== command) {
    fail(`package.json script ${name} must be: ${command}`);
  }
}

const deployFingerprintStampBody = readScript("stamp-railway-deploy-fingerprint.mjs");
const stampInventoryIndex = deployFingerprintStampBody.indexOf("assertLiveRailwayEnvReady();");
const stampReadIndex = deployFingerprintStampBody.indexOf("const vars = readRailwayVariables();\nconst currentBranch");
const stampSetIndex = deployFingerprintStampBody.indexOf("stampRailwayVariable(\"SMIRK_DEPLOY_BRANCH\"");
if (
  stampInventoryIndex < 0 ||
  stampReadIndex < 0 ||
  stampSetIndex < 0 ||
  !(stampInventoryIndex < stampReadIndex && stampInventoryIndex < stampSetIndex)
) {
  fail("stamp-railway-deploy-fingerprint.mjs must verify live Railway env readiness before reading or mutating deploy fingerprint variables");
}
for (const phrase of [
  "check:railway:first-dollar-env",
  "live-railway-env-failed",
  "Fix missing or placeholder live Railway first-dollar env values",
]) {
  if (!deployFingerprintStampBody.includes(phrase)) {
    fail(`stamp-railway-deploy-fingerprint.mjs must explain the deploy fingerprint live env gate: ${phrase}`);
  }
}

if (!process.exitCode) {
  console.log("[check-auth] browser basic-auth popup regression checks passed");
}
