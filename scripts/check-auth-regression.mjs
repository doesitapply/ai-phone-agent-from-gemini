#!/usr/bin/env node
import fs from "fs";
import path from "path";

const root = path.resolve(process.argv[2] || ".");
const serverPath = path.join(root, "server.ts");
const packagePath = path.join(root, "package.json");
const scriptsPath = path.join(root, "scripts");

const fail = (message) => {
  console.error(`[check-auth] ${message}`);
  process.exitCode = 1;
};

const server = fs.readFileSync(serverPath, "utf8");
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

const authMarkers = [
  'dashboardAuth',
  'requirePhoneAgentApiKey',
  'requireProvisioningSecret',
  'requireTestCallSecret',
  'twilioValidate',
  'publicDemoRateLimit',
  'express.raw',
];

const routeRegex = /app\.(get|post|put|patch|delete)\(\"([^\"]+)\"([^\n]*)/g;
const routeCallRegex = /app\.(get|post|put|patch|delete)\s*\(/g;
const routeDeclarations = [];
const parsedRouteIndexes = new Set();
for (const match of server.matchAll(routeRegex)) {
  parsedRouteIndexes.add(match.index);
  const method = match[1].toUpperCase();
  const route = match[2];
  const tail = match[3] || '';
  routeDeclarations.push({ method, route, tail });
  if (!route.startsWith('/api/')) continue;
  if (isAllowedPublicRoute(method, route)) continue;
  if (!authMarkers.some((marker) => tail.includes(marker))) {
    fail(`route ${method} ${route} is missing an auth/guard marker on its declaration line`);
  }
}

for (const match of server.matchAll(routeCallRegex)) {
  if (parsedRouteIndexes.has(match.index)) continue;
  const lineNumber = server.slice(0, match.index).split("\n").length;
  const declarationLine = server.slice(match.index, server.indexOf("\n", match.index));
  const isProtectedMissionControlArrayRoute = declarationLine.includes(
    'app.get(["/mission-control", "/mission-control/*"], dashboardAuth, requireOperator',
  );
  if (!isProtectedMissionControlArrayRoute) {
    fail(`route declaration on line ${lineNumber} is not covered by the auth scanner: ${declarationLine.trim()}`);
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
  { method: "GET", route: "/api/provisioning/requests", markers: ["dashboardAuth", "requireOperator"] },
  { method: "POST", route: "/api/provision/workspace", markers: ["requireProvisioningSecret"] },
  { method: "POST", route: "/api/scheduled/monthly-usage-reset", markers: ["requireProvisioningSecret"] },
  { method: "POST", route: "/api/admin/run-migrations", markers: ["dashboardAuth", "requireOperator"] },
  { method: "GET", route: "/api/calls", markers: ["dashboardAuth"] },
  { method: "POST", route: "/api/calls", markers: ["callRateLimit"] },
  { method: "GET", route: "/api/tasks", markers: ["dashboardAuth"] },
  { method: "GET", route: "/api/recordings/:sid/audio", markers: ["dashboardAuth"] },
  { method: "POST", route: "/api/provisioning/request", markers: ["publicDemoRateLimit"] },
  { method: "POST", route: "/api/provisioning/checkout-status", markers: ["publicDemoRateLimit"] },
  { method: "POST", route: "/api/stripe/webhook", markers: ["express.raw"] },
  { method: "POST", route: "/api/twilio/test-webhook", markers: ["dashboardAuth"] },
  { method: "POST", route: "/api/twilio/test-sms", markers: ["dashboardAuth"] },
  { method: "POST", route: "/api/twilio/test-call", markers: ["dashboardAuth"] },
].forEach(requireRouteGuard);

if (!server.includes('app.get(["/mission-control", "/mission-control/*"], dashboardAuth, requireOperator')) {
  fail("Mission Control routes must require dashboardAuth and requireOperator");
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
