#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const checks = [];
const expect = (name, condition) => {
  checks.push({ name, ok: Boolean(condition) });
};

const server = read("server.ts");
const app = read("src/App.tsx");
const wizard = read("src/components/SetupWizard.tsx");

expect("workspace greeting preview route is dashboard-auth protected",
  server.includes('app.post("/api/workspace/greeting-preview", dashboardAuth'));
expect("workspace profile cache is cleared after profile save",
  server.includes("workspaceProfileCache.delete(id)"));
expect("settings save updates live process env",
  server.includes("process.env[key] = String(value)"));
expect("google calendar test performs a real events.list call",
  server.includes('service === "google_calendar"') && server.includes("calendar.events.list"));
expect("openai tts has a real settings test",
  server.includes('service === "openai_tts"') && server.includes("generateOpenAISpeech"));
expect("google tts has a real settings test",
  server.includes('service === "google_tts"') && server.includes("generateGoogleSpeech"));
expect("deployment has a real health test",
  server.includes('service === "deployment"') && server.includes("/health"));
expect("email test accepts setup wizard notification payload",
  server.includes("body.email || body.to || body.NOTIFICATION_EMAIL"));

expect("settings page has setup wizard action",
  app.includes("Open setup wizard"));
expect("settings page has inbound greeting test",
  app.includes("Test inbound") && app.includes('/api/workspace/greeting-preview'));
expect("settings page has outbound greeting test",
  app.includes("Test outbound") && app.includes('/api/workspace/greeting-preview'));
expect("settings page can provision a workspace phone number",
  app.includes("Provision number") && app.includes("/api/workspace/provision-number"));
expect("settings page can mark setup complete",
  app.includes("Mark setup complete") && app.includes("setup_completed_at"));
expect("settings tests do not send masked secrets",
  app.includes('value.includes("•")'));
expect("setup wizard sends email field expected by test route",
  wizard.includes('JSON.stringify({ email: notifEmail })'));

const failed = checks.filter((check) => !check.ok);
for (const check of checks) {
  console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}`);
}

if (failed.length > 0) {
  console.error(`\n${failed.length} settings setup contract check(s) failed.`);
  process.exit(1);
}

console.log(`\nSettings setup contract checks passed (${checks.length}).`);
