#!/usr/bin/env node
import fs from "node:fs";

const app = fs.readFileSync("src/App.tsx", "utf8");
const setupWizard = fs.readFileSync("src/components/SetupWizard.tsx", "utf8");
const server = fs.readFileSync("server.ts", "utf8");
const settings = fs.readFileSync("src/settings.ts", "utf8");

const failures = [];

function requireIncludes(source, needle, label) {
  if (!source.includes(needle)) failures.push(`${label}: missing ${needle}`);
}

requireIncludes(app, 'const BASIC_WORKSPACE_TABS = new Set<Tab>(["calls", "handoffs", "tasks", "settings", "crm"]);', "starter customer nav");
requireIncludes(app, 'const OPERATOR_ONLY_TABS = new Set<Tab>([', "operator-only nav denylist");
requireIncludes(app, "const workspacePlan = normalizeWorkspacePlan(currentWorkspace?.plan || workspaceSession?.plan);", "workspace plan source");
requireIncludes(app, "const customerVisibleTabs = workspacePlanHasFullSuite(workspacePlan) ? PRO_WORKSPACE_TABS : BASIC_WORKSPACE_TABS;", "plan-based customer nav");
requireIncludes(app, "if (OPERATOR_ONLY_TABS.has(tabId)) return false;", "operator-only route gate");
requireIncludes(app, "if (isDemoOperator) return demoOperatorVisibleTabs.has(tabId);", "demo operator route allowlist");
requireIncludes(app, 'const activeTab = isCustomerView && !customerVisibleTabs.has(normalizedTab)', "customer active-tab fallback branch");
requireIncludes(app, '? "calls"', "customer active-tab calls fallback");
requireIncludes(app, "isDemoOperator && !demoOperatorVisibleTabs.has(normalizedTab)", "demo operator active-tab fallback branch");
requireIncludes(app, "? demoFallbackTab", "demo operator active-tab first-allowed fallback");
requireIncludes(app, 'operatorSession && !isDemoOperator ? api<ConfigStatus>("/api/config-status") : Promise.resolve(null)', "customer/demo must not poll operator-only config status");
requireIncludes(settings, "providerConfiguration: {", "config status must expose explicit provider configuration");
requireIncludes(settings, "twilioConfigured: Boolean(raw.TWILIO_ACCOUNT_SID && raw.TWILIO_AUTH_TOKEN && raw.TWILIO_PHONE_NUMBER)", "Twilio telemetry must require complete configuration");
requireIncludes(settings, "leadSearchConfigured: Boolean(process.env.GOOGLE_PLACES_API_KEY)", "lead-search telemetry must use an explicit configuration signal");
requireIncludes(app, "const providerConfigurationKnown = providerConfiguration !== undefined;", "command rail must distinguish unknown provider state");
requireIncludes(app, "state: twilioReady ? 'configured' : 'not set'", "command rail must label configuration rather than claim provider uptime");
requireIncludes(app, 'api<Stats>("/api/stats")', "paid customer live metrics poll");
requireIncludes(app, "const CUSTOMER_NETWORK_ERROR", "app error sanitizer");
requireIncludes(app, "const CUSTOMER_DATA_ERROR", "app data sanitizer");
requireIncludes(app, "const CUSTOMER_AUTH_ERROR", "app auth sanitizer");
requireIncludes(setupWizard, "function safeSetupError", "setup wizard sanitizer");
if (server.includes("requireProSuite") || server.includes("PRO_SUITE_REQUIRED")) {
  failures.push("single-offer customer workflow must not retain a hidden Pro-only API gate");
}

const customerShellBlock = app.match(/const customerHiddenTabs = new Set<Tab>\(\[([\s\S]*?)\]\);/)?.[1] || "";
for (const tab of ["campaigns", "mission_control", "prospecting", "agent", "voice", "leads", "integrations", "agents", "compliance", "logs", "workspaces", "system_health"]) {
  if (!customerShellBlock.includes(`"${tab}"`)) failures.push(`customer hidden tabs: ${tab} is not hidden from customer sessions`);
}

const basicTabsBlock = app.match(/const BASIC_WORKSPACE_TABS = new Set<Tab>\(\[([\s\S]*?)\]\);/)?.[1] || "";
for (const tab of ["calls", "handoffs", "tasks", "settings", "crm"]) {
  if (!basicTabsBlock.includes(`"${tab}"`)) failures.push(`starter owner tabs: ${tab} is not available to the paid customer workspace`);
}
for (const tab of ["dashboard", "review", "calendar", "recovery", "analytics", "agent", "voice", "integrations", "logs", "system_health", "workspaces"]) {
  if (basicTabsBlock.includes(`"${tab}"`)) failures.push(`starter owner tabs: ${tab} must remain behind an operator or future paid-suite boundary`);
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

console.log("OK paid customer dashboard exposes recovery controls, hides restricted surfaces, and reports provider configuration honestly");
