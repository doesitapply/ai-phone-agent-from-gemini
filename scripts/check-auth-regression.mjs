#!/usr/bin/env node
import fs from "fs";
import path from "path";

const root = path.resolve(process.argv[2] || ".");
const serverPath = path.join(root, "server.ts");
const packagePath = path.join(root, "package.json");

const fail = (message) => {
  console.error(`[check-auth] ${message}`);
  process.exitCode = 1;
};

const server = fs.readFileSync(serverPath, "utf8");
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));

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

const publicRouteAllowlist = [
  /^\/api\/auth\/google\/config$/,
  /^\/api\/auth\/google\/exchange$/,
  /^\/api\/twiml\//,
  /^\/api\/calls$/,
  /^\/api\/twilio\//,
  /^\/api\/tts\//,
  /^\/api\/health$/,
  /^\/api\/version$/,
  /^\/api\/demo$/,
  /^\/api\/system-health\/public$/,
  /^\/api\/provisioning\/request$/,
  /^\/api\/provisioning\/checkout-status$/,
  /^\/api\/invite\//,
  /^\/api\/pricing$/,
  /^\/api\/stripe\/webhook$/,
];

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
for (const match of server.matchAll(routeRegex)) {
  const method = match[1].toUpperCase();
  const route = match[2];
  const tail = match[3] || '';
  if (!route.startsWith('/api/')) continue;
  if (publicRouteAllowlist.some((pattern) => pattern.test(route))) continue;
  if (!authMarkers.some((marker) => tail.includes(marker))) {
    fail(`route ${method} ${route} is missing an auth/guard marker on its declaration line`);
  }
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

if (!process.exitCode) {
  console.log("[check-auth] browser basic-auth popup regression checks passed");
}
