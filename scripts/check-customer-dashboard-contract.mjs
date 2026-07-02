#!/usr/bin/env node
import fs from "node:fs";

const app = fs.readFileSync("src/App.tsx", "utf8");
const setupWizard = fs.readFileSync("src/components/SetupWizard.tsx", "utf8");

const failures = [];

function requireIncludes(source, needle, label) {
  if (!source.includes(needle)) failures.push(`${label}: missing ${needle}`);
}

requireIncludes(app, 'const BASIC_WORKSPACE_TABS = new Set<Tab>(["calls", "contacts", "tasks"]);', "starter/basic customer nav");
requireIncludes(app, 'const PRO_WORKSPACE_TABS = new Set<Tab>([', "pro customer nav");
requireIncludes(app, 'const OPERATOR_ONLY_TABS = new Set<Tab>([', "operator-only nav denylist");
requireIncludes(app, "const workspacePlan = normalizeWorkspacePlan(currentWorkspace?.plan || workspaceSession?.plan);", "workspace plan source");
requireIncludes(app, "const customerVisibleTabs = workspacePlanHasFullSuite(workspacePlan) ? PRO_WORKSPACE_TABS : BASIC_WORKSPACE_TABS;", "plan-based customer nav");
requireIncludes(app, "if (OPERATOR_ONLY_TABS.has(tabId)) return false;", "operator-only route gate");
requireIncludes(app, 'const activeTab = isCustomerView && !customerVisibleTabs.has(normalizedTab) ? "calls" : normalizedTab;', "customer active-tab fallback");
requireIncludes(app, 'operatorSession ? api<ConfigStatus>("/api/config-status") : Promise.resolve(null)', "customer must not poll operator-only config status");
requireIncludes(app, "const CUSTOMER_NETWORK_ERROR", "app error sanitizer");
requireIncludes(app, "const CUSTOMER_DATA_ERROR", "app data sanitizer");
requireIncludes(app, "const CUSTOMER_AUTH_ERROR", "app auth sanitizer");
requireIncludes(setupWizard, "function safeSetupError", "setup wizard sanitizer");

const customerShellBlock = app.match(/const customerHiddenTabs = new Set<Tab>\(\[([\s\S]*?)\]\);/)?.[1] || "";
for (const tab of ["campaigns", "settings", "mission_control", "prospecting", "agent", "voice", "leads", "integrations", "agents", "compliance", "logs", "workspaces", "system_health"]) {
  if (!customerShellBlock.includes(`"${tab}"`)) failures.push(`customer hidden tabs: ${tab} is not hidden from customer sessions`);
}

const basicTabsBlock = app.match(/const BASIC_WORKSPACE_TABS = new Set<Tab>\(\[([\s\S]*?)\]\);/)?.[1] || "";
for (const tab of ["calls", "contacts", "tasks"]) {
  if (!basicTabsBlock.includes(`"${tab}"`)) failures.push(`basic dashboard tabs: ${tab} is not available to starter/basic workspaces`);
}
for (const tab of ["dashboard", "review", "crm", "calendar", "handoffs", "recovery", "analytics", "settings", "agent", "voice", "integrations", "logs", "system_health", "workspaces"]) {
  if (basicTabsBlock.includes(`"${tab}"`)) failures.push(`basic dashboard tabs: ${tab} must not be available to starter/basic workspaces`);
}

const proTabsBlock = app.match(/const PRO_WORKSPACE_TABS = new Set<Tab>\(\[([\s\S]*?)\]\);/)?.[1] || "";
for (const tab of ["dashboard", "review", "calls", "contacts", "crm", "calendar", "handoffs", "recovery", "tasks", "analytics"]) {
  if (!proTabsBlock.includes(`"${tab}"`)) failures.push(`pro dashboard tabs: ${tab} is not available to pro/agency workspaces`);
}
for (const tab of ["settings", "agent", "voice", "integrations", "agents", "compliance", "logs", "workspaces", "system_health", "mission_control", "prospecting", "leads"]) {
  if (proTabsBlock.includes(`"${tab}"`)) failures.push(`pro dashboard tabs: ${tab} is operator-only and must not be available by plan alone`);
}

const operatorTabsBlock = app.match(/const OPERATOR_ONLY_TABS = new Set<Tab>\(\[([\s\S]*?)\]\);/)?.[1] || "";
for (const tab of ["settings", "agent", "voice", "integrations", "agents", "compliance", "logs", "workspaces", "system_health", "mission_control", "prospecting", "leads"]) {
  if (!operatorTabsBlock.includes(`"${tab}"`)) failures.push(`operator-only tabs: ${tab} is not explicitly operator-only`);
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
