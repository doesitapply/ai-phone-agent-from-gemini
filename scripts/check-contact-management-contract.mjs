#!/usr/bin/env node
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const fail = (message) => {
  console.error(`[contact-management-contract] ${message}`);
  process.exitCode = 1;
};
const requireText = (file, needle, label) => {
  if (!read(file).includes(needle)) fail(`${label}: missing ${needle}`);
};

const app = read("src/App.tsx");
const contacts = read("src/routes/contact-routes.ts");
const compliance = read("src/compliance.ts");
const db = read("src/db.ts");

for (const status of ["active", "lead", "customer", "inactive", "bad_number"]) {
  if (!app.includes(`value: "${status}"`) || !contacts.includes(`"${status}"`)) {
    fail(`contact status ${status} must be available in UI and API validation`);
  }
}

for (const needle of [
  "ALTER TABLE contacts ADD COLUMN IF NOT EXISTS status",
  "status            TEXT NOT NULL DEFAULT 'active'",
]) {
  if (!db.includes(needle)) fail(`contacts.status migration/schema missing: ${needle}`);
}

for (const needle of [
  "c.status",
  "status       = COALESCE",
  "Invalid contact status.",
  'app.post("/api/contacts/:id/dnc", dashboardAuth, requireOperator',
  'app.delete("/api/contacts/:id/dnc", dashboardAuth, requireOperator',
  "consentNote.length < 8",
  "A consent or correction note is required to remove DNC.",
]) {
  if (!contacts.includes(needle)) fail(`contact routes missing contract marker: ${needle}`);
}

for (const needle of [
  "SET do_not_call = TRUE, updated_at = NOW()",
  "SET do_not_call = FALSE, updated_at = NOW()",
  'await logComplianceAudit(normalized, undefined, "dnc_removed"',
]) {
  if (!compliance.includes(needle)) fail(`compliance sync/audit missing: ${needle}`);
}

for (const needle of [
  "Remove from DNC",
  "Contact removed from DNC",
  "Add a consent or correction note before removing DNC.",
  "CONTACT_STATUS_OPTIONS",
  "statusFilter",
  "dncFilter",
  "dnc.dnc || dnc.list",
  "audit.audit || audit.events",
]) {
  if (!app.includes(needle)) fail(`contacts UI missing contract marker: ${needle}`);
}

requireText("scripts/check-auth-regression.mjs", 'route: "/api/contacts/:id/dnc", markers: ["dashboardAuth", "requireOperator"]', "auth regression route guard");
requireText("scripts/generate-openapi.mjs", '"POST /api/contacts/:id/dnc"', "OpenAPI operator-only route");

if (process.exitCode) process.exit(process.exitCode);
console.log("[contact-management-contract] ok");
