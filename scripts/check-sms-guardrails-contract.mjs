#!/usr/bin/env node
import fs from "node:fs";

const smsGuardrails = fs.readFileSync("src/sms-guardrails.ts", "utf8");
const smsRoutes = fs.readFileSync("src/routes/sms-routes.ts", "utf8");
const runbook = fs.readFileSync("docs/launch/sms-guarded-enablement-runbook.md", "utf8");
const packageJson = fs.readFileSync("package.json", "utf8");

const failures = [];

function expect(label, condition) {
  if (!condition) failures.push(label);
}

for (const snippet of [
  'SMS_LIVE_CONFIRMATION = "send guarded sms"',
  'SMS_SEND_MODE || "dry_run"',
  "SMS_A2P_CAMPAIGN_APPROVED",
  "SMS_ALLOW_NON_ALLOWLISTED",
  "SMS_ALLOWED_NUMBERS",
  'readPositiveInt("SMS_MAX_PER_RECIPIENT_PER_DAY", 2)',
  'readPositiveInt("SMS_MAX_PER_WORKSPACE_PER_DAY", 20)',
  'readPositiveInt("SMS_MIN_SECONDS_BETWEEN_RECIPIENT", 300)',
  'readPositiveInt("SMS_DAILY_SPEND_CAP_CENTS", 200)',
  'readPositiveInt("SMS_ESTIMATED_CENTS_PER_MESSAGE", 2)',
]) {
  expect(`sms guardrails include ${snippet}`, smsGuardrails.includes(snippet));
}

expect("SMS body must include STOP and HELP", smsGuardrails.includes("hasOptOutLanguage") && smsGuardrails.includes("Message must include STOP and HELP instructions."));
expect("SMS checks consent before non-allowlisted sends", smsGuardrails.includes("getConsentStatus(to)") && smsGuardrails.includes("Recipient does not have active SMS consent on record."));
expect("SMS checks outbound compliance before non-allowlisted sends", smsGuardrails.includes("checkOutboundCompliance(to)") && smsGuardrails.includes("Outbound compliance check blocked this number."));
expect("SMS enforces workspace daily cap", smsGuardrails.includes("Workspace daily SMS cap reached"));
expect("SMS enforces recipient daily cap", smsGuardrails.includes("Recipient daily SMS cap reached"));
expect("SMS enforces recipient cooldown", smsGuardrails.includes("Recipient cooldown active"));
expect("SMS enforces spend cap", smsGuardrails.includes("Estimated daily SMS spend cap would be exceeded"));
expect("SMS records blocked messages", smsGuardrails.includes('"blocked"') && smsGuardrails.includes("recordOutboundSms"));
expect("SMS records dry runs", smsGuardrails.includes('"dry_run"') && smsGuardrails.includes("liveBlockedReasons"));
expect("SMS handles STOP keywords with DNC", smsGuardrails.includes("STOP_KEYWORDS") && smsGuardrails.includes("addToDNC"));
expect("SMS handles START consent", smsGuardrails.includes("START_KEYWORDS") && smsGuardrails.includes("recordConsent"));
expect("SMS handles HELP replies", smsGuardrails.includes("HELP_KEYWORDS"));

expect("SMS safety route is operator-only", smsRoutes.includes('app.get("/api/sms/safety", dashboardAuth, requireOperator'));
expect("SMS test route is operator-only", smsRoutes.includes('app.post("/api/sms/test", dashboardAuth, requireOperator'));
expect("SMS test route refuses missing DB", smsRoutes.includes("Database is required before SMS can be tested or enabled."));
expect("SMS test route requires live confirmation phrase", smsRoutes.includes("confirmedLive") && smsRoutes.includes("SMS_LIVE_CONFIRMATION"));
expect("SMS incoming route validates Twilio", smsRoutes.includes('app.post("/api/sms/incoming", validateTwilio'));
expect("SMS status route validates Twilio", smsRoutes.includes('app.post("/api/sms/status", validateTwilio'));
expect("SMS status route stores Twilio callback status", smsRoutes.includes("MessageStatus") && smsRoutes.includes("storeSms"));
expect("package exposes SMS guardrail check", packageJson.includes('"check:sms-guardrails": "node scripts/check-sms-guardrails-contract.mjs"'));

for (const snippet of [
  "SMS is not part of first-dollar acquisition.",
  "SMS_SEND_MODE=dry_run",
  "SMS_MAX_PER_WORKSPACE_PER_DAY=3",
  "SMS_MAX_PER_RECIPIENT_PER_DAY=1",
  "SMS_DAILY_SPEND_CAP_CENTS=50",
  '"confirm": "send guarded sms"',
  "Stop after one message.",
  "Do not raise caps because a test \"looks fine.\"",
  "any operator proposes SMS as a cold acquisition channel",
]) {
  expect(`SMS runbook includes ${snippet}`, runbook.includes(snippet));
}

if (failures.length > 0) {
  console.error("FAIL SMS guardrail contract drift:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK SMS guardrails require dry-run defaults, allowlisted live testing, low caps, STOP/HELP, consent, cooldowns, spend controls, and operator-only routes");
