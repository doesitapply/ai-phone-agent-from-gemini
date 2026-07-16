#!/usr/bin/env node
import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");
const failures = [];

function expect(label, condition) {
  if (!condition) failures.push(label);
}

function csvRows(text) {
  return text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(",").map((cell) => cell.trim()));
}

const app = read("src/App.tsx");
const launchDoc = read("docs/SMIRK_30_DAY_MARKET_VALIDATION_GOAL.md");
const ledger = read("docs/launch/traction-ledger-template.csv");
const contentCalendar = read("docs/launch/content-calendar.csv");
const productHunt = read("docs/launch/product-hunt-kit.md");
const smsGuardrails = read("src/sms-guardrails.ts");

expect("public launch page component exists", app.includes("function PublicLaunchPage()"));
expect("public /launch route is wired", app.includes('pathname === "/launch"') && app.includes("<PublicLaunchPage />"));
expect("public navigation links to launch plan", app.includes('href="/launch"'));
expect("public launch page states 30-day market validation", app.includes("30-day market validation"));
expect("public launch page states 500-touch and $500 stop condition", app.includes("500 touches + $500 spend"));
expect("public launch page includes self-serve readiness gate", app.includes("self-serve activation proof is green"));
expect("public launch page excludes cold texting", app.includes("No cold SMS") || app.includes("Texting stays out of the first-dollar motion"));
expect("public launch page names Product Hunt", app.includes("Product Hunt"));
expect("public launch page names G2 and Capterra", app.includes("G2 and Capterra"));
expect("public launch page delays AppSumo", app.includes("AppSumo until usage caps and margins are confirmed"));

for (const needle of [
  "1 paid Starter or Pro account completes checkout",
  "10 qualified owner/operator conversations",
  "500 researched outbound touches plus $500 paid spend",
  "SMS is not part of the launch acquisition motion",
  "Never use texting to cold-prospect this sprint",
  "AppSumo",
  "Do not offer unlimited or lifetime voice usage",
]) {
  expect(`launch runbook contains: ${needle}`, launchDoc.includes(needle));
}

for (const source of [
  "https://smith.ai/pricing/ai-receptionist",
  "https://www.goodcall.com/pricing",
  "https://www.bland.ai/pricing",
  "https://www.retellai.com/pricing",
  "https://vapi.ai/pricing",
  "https://synthflow.ai/pricing",
  "https://www.producthunt.com/launch/preparing-for-launch",
  "https://sell.g2.com/create-a-profile",
  "https://www.capterra.com/legal/listing-guidelines/",
  "https://sell.appsumo.com/",
]) {
  expect(`launch runbook cites ${source}`, launchDoc.includes(source));
}

const ledgerRows = csvRows(ledger);
const ledgerHeader = new Set(ledgerRows[0] || []);
for (const column of [
  "source",
  "company",
  "vertical",
  "region",
  "owner_contact",
  "channel",
  "message_variant",
  "response",
  "objection",
  "proof_walkthrough_status",
  "checkout_status",
  "activation_status",
  "next_state",
]) {
  expect(`traction ledger has ${column}`, ledgerHeader.has(column));
}
expect("traction ledger has template rows", ledgerRows.length >= 5);

const contentRows = csvRows(contentCalendar);
expect("content calendar has 20 planned posts", contentRows.length === 21);
expect("content calendar has CTA column", (contentRows[0] || []).includes("cta"));
expect("content calendar avoids cold texting", !/cold\s+text|text\s+back|send\s+texts/i.test(contentCalendar));
expect("content calendar uses launch CTA", contentCalendar.includes("/launch"));

expect("Product Hunt kit has a tagline", productHunt.includes("Missed-call recovery for home-service businesses"));
expect("Product Hunt kit has first comment", productHunt.includes("## First Comment"));
expect("Product Hunt kit asks for buyer feedback", productHunt.includes("Would this be enough to try one proof call?"));
expect("Product Hunt kit keeps texting guarded", productHunt.includes("not part of the first-dollar launch motion"));

expect("SMS guardrail default mode is dry_run", smsGuardrails.includes('SMS_SEND_MODE || "dry_run"'));
expect("SMS guardrails require live confirmation phrase", smsGuardrails.includes('SMS_LIVE_CONFIRMATION = "send guarded sms"'));
expect("SMS guardrails require A2P approval for live sends", smsGuardrails.includes("SMS_A2P_CAMPAIGN_APPROVED"));
expect("SMS guardrails cap workspace daily sends", smsGuardrails.includes('readPositiveInt("SMS_MAX_PER_WORKSPACE_PER_DAY", 20)'));
expect("SMS guardrails cap recipient daily sends", smsGuardrails.includes('readPositiveInt("SMS_MAX_PER_RECIPIENT_PER_DAY", 2)'));
expect("SMS guardrails cap estimated daily spend", smsGuardrails.includes('readPositiveInt("SMS_DAILY_SPEND_CAP_CENTS", 200)'));
expect("SMS guardrails enforce recipient cooldown", smsGuardrails.includes('readPositiveInt("SMS_MIN_SECONDS_BETWEEN_RECIPIENT", 300)'));
expect("SMS guardrails support allowlisted testing", smsGuardrails.includes("SMS_ALLOWED_NUMBERS"));

if (failures.length > 0) {
  console.error("FAIL market validation launch implementation drift:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK market validation launch page, assets, hard goals, paid-spend cap, channel plan, and SMS guardrails are in place");
