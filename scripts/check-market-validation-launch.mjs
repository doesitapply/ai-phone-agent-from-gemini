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
const server = read("server.ts");
const db = read("src/db.ts");
const launchRoutes = read("src/routes/launch-routes.ts");
const packageJson = read("package.json");
const marketStatusScript = read("scripts/check-market-validation-status.mjs");
const analyticsSmokeScript = read("scripts/check-launch-analytics-smoke.mjs");
const importScript = read("scripts/import-launch-ledger-csv.mjs");
const launchDoc = read("docs/SMIRK_30_DAY_MARKET_VALIDATION_GOAL.md");
const ledger = read("docs/launch/traction-ledger-template.csv");
const prospectBatch = read("docs/launch/prospect-batch-001-reno.csv");
const prospectBatch2 = read("docs/launch/prospect-batch-002-sacramento.csv");
const contentCalendar = read("docs/launch/content-calendar.csv");
const productHunt = read("docs/launch/product-hunt-kit.md");
const platformKit = read("docs/launch/platform-submission-kit.md");
const outboundPlaybook = read("docs/launch/manual-outbound-playbook.md");
const paidBrief = read("docs/launch/paid-test-brief.md");
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
expect("public launch page tracks page view", app.includes('trackLaunchEvent("launch_page_view"'));
expect("public landing page tracks page view", app.includes('trackLaunchEvent("landing_page_view"'));
expect("public pricing page tracks page view", app.includes('trackLaunchEvent("pricing_page_view"'));
expect("public launch page tracks CTA clicks", app.includes('trackLaunchEvent("cta_clicked"'));
expect("public checkout flow tracks checkout starts", app.includes('trackLaunchEvent("checkout_started"'));

expect("launch events schema exists", db.includes("CREATE TABLE IF NOT EXISTS launch_events"));
expect("launch events schema indexes event source", db.includes("idx_launch_events_name_source"));
expect("launch ledger schema exists", db.includes("CREATE TABLE IF NOT EXISTS launch_ledger"));
expect("launch ledger schema indexes state", db.includes("idx_launch_ledger_state"));
expect("launch routes are registered", server.includes("registerLaunchRoutes(app"));
expect("public launch tracking endpoint exists", launchRoutes.includes('app.post("/api/launch/events"'));
expect("operator launch summary endpoint exists", launchRoutes.includes('app.get("/api/launch/summary"') && launchRoutes.includes("dashboardAuth") && launchRoutes.includes("requireOperator"));
expect("operator launch ledger list endpoint exists", launchRoutes.includes('app.get("/api/launch/ledger"') && launchRoutes.includes("dashboardAuth") && launchRoutes.includes("requireOperator"));
expect("operator launch ledger create endpoint exists", launchRoutes.includes('app.post("/api/launch/ledger"') && launchRoutes.includes("dashboardAuth") && launchRoutes.includes("requireOperator"));
expect("operator launch ledger update endpoint exists", launchRoutes.includes('app.patch("/api/launch/ledger/:id"') && launchRoutes.includes("dashboardAuth") && launchRoutes.includes("requireOperator"));
expect("operator launch summary exposes spend gate", launchRoutes.includes("spend_gate") && launchRoutes.includes("paid_spend_allowed: false"));
expect("operator launch summary exposes traction hard-stop metrics", launchRoutes.includes("qualified_conversations") && launchRoutes.includes("proof_walkthroughs") && launchRoutes.includes("paid_activations") && launchRoutes.includes("negative_signal"));
expect("launch tracking allows checkout started", launchRoutes.includes('"checkout_started"'));
expect("launch tracking avoids raw buyer email fields", !/owner_email|buyer_email|email_address/.test(launchRoutes));
expect("operator launch sprint page exists", app.includes("function LaunchSprintPage()"));
expect("operator launch sprint route is wired", app.includes("<LaunchSprintPage />") && app.includes('launch: "/dashboard/launch"'));
expect("operator launch sprint reads ledger API", app.includes('"/api/launch/ledger?days=30&limit=200"') && app.includes('"/api/launch/ledger"'));
expect("operator launch sprint displays paid activation metric", app.includes("paid_activations"));
expect("market validation status package script exists", packageJson.includes('"check:market-validation-status": "node scripts/check-market-validation-status.mjs"'));
expect("market validation status script checks live parity", marketStatusScript.includes("check:live-is-current"));
expect("market validation status script checks failed deploys", marketStatusScript.includes("check:latest-failed-deploy"));
expect("market validation status script reads launch summary", marketStatusScript.includes("/api/launch/summary"));
expect("market validation status script reads launch ledger", marketStatusScript.includes("/api/launch/ledger"));
expect("market validation status script avoids printing ledger rows", marketStatusScript.includes("Ledger row details are intentionally omitted"));
expect("market validation status script writes snapshot", marketStatusScript.includes("market-validation-status.json"));
expect("market validation status script computes hard statuses", marketStatusScript.includes("success_revenue") && marketStatusScript.includes("success_interaction") && marketStatusScript.includes("negative_signal"));
expect("launch analytics smoke package script exists", packageJson.includes('"check:launch-analytics-smoke": "node scripts/check-launch-analytics-smoke.mjs"'));
expect("launch analytics smoke posts synthetic checkout tracking only", analyticsSmokeScript.includes('"checkout_started"') && analyticsSmokeScript.includes("creates_checkout_session: false") && analyticsSmokeScript.includes("stripe_session_created: false"));
expect("launch analytics smoke verifies source and campaign events", analyticsSmokeScript.includes("missing_from_source_summary") && analyticsSmokeScript.includes("missing_from_recent_campaign"));
expect("launch analytics smoke does not touch outreach or SMS", analyticsSmokeScript.includes("does not create checkout sessions, payments, ledger touches, SMS, or outreach"));
expect("launch ledger batch import package script exists", packageJson.includes('"import:launch-ledger:batch": "node scripts/import-launch-ledger-csv.mjs"'));
expect("launch ledger batch apply script exists", packageJson.includes('"import:launch-ledger:batch:apply": "node scripts/import-launch-ledger-csv.mjs --apply"'));
expect("launch ledger import requires confirmation to apply", importScript.includes("CONFIRM_SMIRK_LAUNCH_LEDGER_IMPORT") && importScript.includes("import-researched-launch-prospects"));
expect("launch ledger import is dry-run by default", importScript.includes("const apply = process.argv.includes(\"--apply\")") && importScript.includes("No outreach is sent by this importer"));
expect("launch ledger import deduplicates by company", importScript.includes("skipped_existing") && importScript.includes("existingCompanies"));
expect("launch ledger import labels the selected research batch", importScript.includes('path.basename(inputFile, ".csv")') && importScript.includes("research_batch=${batchSlug}"));

for (const needle of [
  "1 paid Starter or Pro account completes checkout",
  "10 qualified owner/operator conversations",
  "500 researched outbound touches plus $500 paid spend",
  "SMS is not part of the launch acquisition motion",
  "Never use texting to cold-prospect this sprint",
  "Landing page analytics are working",
  "Checkout and activation events are trackable",
  "npm run check:market-validation-status",
  "docs/launch/prospect-batch-001-reno.csv",
  "docs/launch/prospect-batch-002-sacramento.csv",
  "npm run import:launch-ledger:batch",
  "does not send outreach",
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

const prospectRows = csvRows(prospectBatch);
expect("first researched prospect batch has at least 25 rows", prospectRows.length >= 26);
const prospectHeader = new Set(prospectRows[0] || []);
for (const column of [
  "company",
  "vertical",
  "region",
  "owner_contact",
  "channel",
  "message_variant",
  "next_state",
  "touch_count",
  "spend_cents",
  "source_url",
  "contact_url",
]) {
  expect(`first researched prospect batch has ${column}`, prospectHeader.has(column));
}
expect("first researched prospect batch is researched not contacted", prospectBatch.includes(",researched,0,0,") && !/,contacted,[1-9]/.test(prospectBatch));
expect("first researched prospect batch uses public web/contact channels", prospectBatch.includes("website_form") && prospectBatch.includes("Public official site from launch research; no message sent"));
expect("first researched prospect batch avoids cold SMS", !/sms|text|cold\s*text|auto[- ]?dial/i.test(prospectBatch));

const prospectRows2 = csvRows(prospectBatch2);
expect("second researched prospect batch has at least 25 rows", prospectRows2.length >= 26);
const prospectHeader2 = new Set(prospectRows2[0] || []);
for (const column of [
  "company",
  "vertical",
  "region",
  "owner_contact",
  "channel",
  "message_variant",
  "next_state",
  "touch_count",
  "spend_cents",
  "source_url",
  "contact_url",
]) {
  expect(`second researched prospect batch has ${column}`, prospectHeader2.has(column));
}
expect("second researched prospect batch is researched not contacted", prospectBatch2.includes(",researched,0,0,") && !/,contacted,[1-9]/.test(prospectBatch2));
expect("second researched prospect batch uses public web/contact channels", prospectBatch2.includes("website_form") && prospectBatch2.includes("Public official site from launch research; no message sent"));
expect("second researched prospect batch avoids cold SMS", !/sms|text|cold\s*text|auto[- ]?dial/i.test(prospectBatch2));

const contentRows = csvRows(contentCalendar);
expect("content calendar has 20 planned posts", contentRows.length === 21);
expect("content calendar has CTA column", (contentRows[0] || []).includes("cta"));
expect("content calendar avoids cold texting", !/cold\s+text|text\s+back|send\s+texts/i.test(contentCalendar));
expect("content calendar uses launch CTA", contentCalendar.includes("/launch"));

expect("Product Hunt kit has a tagline", productHunt.includes("Missed-call recovery for home-service businesses"));
expect("Product Hunt kit has first comment", productHunt.includes("## First Comment"));
expect("Product Hunt kit asks for buyer feedback", productHunt.includes("Would this be enough to try one proof call?"));
expect("Product Hunt kit keeps texting guarded", productHunt.includes("not part of the first-dollar launch motion"));

for (const needle of [
  "docs/launch/manual-outbound-playbook.md",
  "docs/launch/platform-submission-kit.md",
  "docs/launch/paid-test-brief.md",
]) {
  expect(`launch runbook links ${needle}`, launchDoc.includes(needle));
}

for (const needle of [
  "https://www.producthunt.com/launch/preparing-for-launch",
  "https://sell.g2.com/create-a-profile",
  "https://www.capterra.com/legal/listing-guidelines/",
  "https://sell.appsumo.com/",
  "Missed-call recovery for home-service teams",
  "Do not offer unlimited lifetime voice or SMS",
]) {
  expect(`platform submission kit contains: ${needle}`, platformKit.includes(needle));
}
expect("platform kit includes support response plan", platformKit.includes("Support response plan"));
expect("platform kit includes redacted screenshot checklist", platformKit.includes("caller details removed"));
expect("platform kit delays AppSumo", platformKit.includes("Status: delayed"));

for (const needle of [
  "200 researched manual touches",
  "No cold SMS",
  "Automated dialing",
  "100 touches and 0 qualified replies",
  "3% qualified reply rate",
  "Checkout starts without activation",
]) {
  expect(`manual outbound playbook contains: ${needle}`, outboundPlaybook.includes(needle));
}
expect("manual outbound playbook has message variants", outboundPlaybook.includes("Variant A") && outboundPlaybook.includes("Variant B") && outboundPlaybook.includes("Variant C"));
expect("manual outbound playbook avoids cold texting", !/text\s+back|cold\s+texting\s+approved/i.test(outboundPlaybook));

for (const needle of [
  "$500 total",
  "$200",
  "$150",
  "$100",
  "$50",
  "APPROVE_SMIRK_PAID_TEST",
  "no Local Services Ads provider impersonation",
  "Google Search long-tail test",
  "LinkedIn Lead Gen",
  "https://support.google.com/google-ads/answer/6167122",
  "https://business.linkedin.com/advertise/ads/sponsored-content/lead-gen-ads",
]) {
  expect(`paid test brief contains: ${needle}`, paidBrief.includes(needle));
}
expect("paid test brief blocks unsupported claims", paidBrief.includes("Not allowed") && paidBrief.includes("Guaranteed recovered revenue"));

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
