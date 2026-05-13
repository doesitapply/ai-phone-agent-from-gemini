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
