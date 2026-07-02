#!/usr/bin/env node
import fs from "node:fs";

const app = fs.readFileSync("src/App.tsx", "utf8");
const setupWizard = fs.readFileSync("src/components/SetupWizard.tsx", "utf8");

const failures = [];

function requireIncludes(source, needle, label) {
  if (!source.includes(needle)) failures.push(`${label}: missing ${needle}`);
}

requireIncludes(app, 'const customerVisibleTabs = new Set<Tab>(["calls", "contacts", "tasks"]);', "customer nav");
requireIncludes(app, "const visibleForSession = (tabId: Tab) => !isCustomerView || customerVisibleTabs.has(tabId);", "customer route gate");
requireIncludes(app, 'const activeTab = isCustomerView && !customerVisibleTabs.has(normalizedTab) ? "calls" : normalizedTab;', "customer active-tab fallback");
requireIncludes(app, "const CUSTOMER_NETWORK_ERROR", "app error sanitizer");
requireIncludes(app, "const CUSTOMER_DATA_ERROR", "app data sanitizer");
requireIncludes(app, "const CUSTOMER_AUTH_ERROR", "app auth sanitizer");
requireIncludes(setupWizard, "function safeSetupError", "setup wizard sanitizer");

const customerShellBlock = app.match(/const customerHiddenTabs = new Set<Tab>\(\[([\s\S]*?)\]\);/)?.[1] || "";
for (const tab of ["dashboard", "review", "crm", "calendar", "handoffs", "recovery", "settings", "analytics", "mission_control", "prospecting", "agent", "voice", "leads", "integrations", "agents", "compliance", "logs", "workspaces", "system_health"]) {
  if (!customerShellBlock.includes(`"${tab}"`)) failures.push(`customer hidden tabs: ${tab} is not hidden from customer sessions`);
}

const ownerVisibleRegion = app.slice(app.indexOf("function CallsPage"), app.indexOf("// ── Handoffs Page"));
for (const raw of ["Failed to fetch", "Network error", "X-Api-Key", "Bearer token", "Failed to load contact", "Failed to save", "Failed to create contact", "Failed to update DNC", "Failed to update task", "Failed to clear tasks"]) {
  if (ownerVisibleRegion.includes(raw)) failures.push(`owner visible region still contains raw failure copy: ${raw}`);
}

if (failures.length > 0) {
  console.error("Customer dashboard contract failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK customer dashboard contract hides operator surface and sanitizes owner-visible failures");
