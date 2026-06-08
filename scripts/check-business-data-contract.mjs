#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const app = read("src/App.tsx");
const server = read("server.ts");
const knowledge = read("src/workspace-knowledge.ts");
const scanner = read("src/website-intake.ts");

const assertIncludes = (source, needle, label) => {
  if (!source.includes(needle)) {
    throw new Error(`Missing ${label}: ${needle}`);
  }
};

assertIncludes(app, 'id: "crm"', "CRM nav tab");
assertIncludes(app, "CRM / Business Data", "CRM page title");
assertIncludes(app, '"/api/workspace/website-scan"', "website scan client call");
assertIncludes(app, 'sourceType: "website"', "website source import client call");
assertIncludes(app, "Apply selected profile fields", "apply review action");
assertIncludes(app, "Import website facts", "website import action");

assertIncludes(server, 'app.post("/api/workspace/website-scan", dashboardAuth', "dashboard-auth protected website scan route");
assertIncludes(knowledge, '"website"', "website knowledge source type");
assertIncludes(scanner, "assertSafeWebsiteUrl", "safe website URL validation");
assertIncludes(scanner, "isPrivateIp", "private IP rejection");
assertIncludes(scanner, "allowPrivateHosts", "test-only fixture override");

const routeStart = server.indexOf('app.post("/api/workspace/website-scan"');
const routeEnd = server.indexOf('app.post("/api/workspace/provision-number"', routeStart);
if (routeStart < 0 || routeEnd < 0) {
  throw new Error("Could not isolate website-scan route.");
}
const websiteScanRoute = server.slice(routeStart, routeEnd);
for (const forbidden of ["updateWorkspace(", "importWorkspaceKnowledge(", "sql`"]) {
  if (websiteScanRoute.includes(forbidden)) {
    throw new Error(`Website scan route must be review-only before apply/import; found ${forbidden}`);
  }
}

execFileSync("npx", ["tsx", "scripts/check-business-data-fixture.ts"], {
  cwd: root,
  stdio: "inherit",
});

console.log("Business data contract checks passed.");
