#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const trackerPath = process.argv.find((arg) => arg.endsWith(".csv")) || "docs/launch/paid-test-tracker.csv";
const paidBriefPath = "docs/launch/paid-test-brief.md";
const manifestPath = "output/playwright/launch-assets/manifest.json";

const requiredColumns = [
  "channel",
  "budget_cents",
  "spend_cents",
  "approval_state",
  "readiness_gate",
  "tracking_status",
  "activation_gate",
  "launch_state",
  "allowed_start_condition",
  "stop_condition",
  "notes",
];

const expectedBudgets = new Map([
  ["meta_instagram_lead_demo", 20000],
  ["google_search_long_tail", 15000],
  ["retargeting_proof_loop", 10000],
  ["reserve_creative_tooling", 5000],
]);

const allowedApprovalStates = new Set(["blocked", "approved"]);
const allowedReadinessGates = new Set(["analytics_checkout_activation_required", "green"]);
const allowedTrackingStatuses = new Set(["not_started", "tracking_ready"]);
const allowedActivationGates = new Set(["self_serve_activation_required", "green"]);
const allowedLaunchStates = new Set(["blocked", "not_started", "running", "paused", "stopped"]);
const approvalPhrase =
  "APPROVE_SMIRK_PAID_TEST: $500 cap, no cold SMS, no automated phone spam, no Local Services Ads provider impersonation.";

function fail(error, detail = {}) {
  console.error(JSON.stringify({ ok: false, error, trackerPath, ...detail }, null, 2));
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim())) rows.push(row);
  }

  const [headers = [], ...dataRows] = rows;
  return {
    headers: headers.map((header) => header.trim()),
    rows: dataRows.map((values) =>
      Object.fromEntries(headers.map((header, index) => [header.trim(), String(values[index] || "").trim()])),
    ),
  };
}

function readJson(file) {
  if (!fs.existsSync(path.resolve(file))) return null;
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch {
    return null;
  }
}

function toNonnegativeInt(value) {
  if (!/^\d+$/.test(String(value || ""))) return null;
  return Number.parseInt(value, 10);
}

if (!fs.existsSync(path.resolve(trackerPath))) fail("paid-test-tracker-missing");
if (!fs.existsSync(path.resolve(paidBriefPath))) fail("paid-test-brief-missing");

const { headers, rows } = parseCsv(fs.readFileSync(path.resolve(trackerPath), "utf8"));
const headerSet = new Set(headers);
const missingColumns = requiredColumns.filter((column) => !headerSet.has(column));
if (missingColumns.length > 0) fail("paid-test-tracker-missing-columns", { missingColumns });
if (rows.length === 0) fail("paid-test-tracker-empty");

const paidBrief = fs.readFileSync(path.resolve(paidBriefPath), "utf8");
const manifest = readJson(manifestPath);
const paidCreativeReady = manifest?.submission_readiness?.paid_creative_ready === true;
const blockers = manifest?.submission_readiness?.blockers || [];
const channels = new Set(rows.map((row) => row.channel));
const missingChannels = [...expectedBudgets.keys()].filter((channel) => !channels.has(channel));
if (missingChannels.length > 0) fail("paid-test-tracker-missing-channels", { missingChannels });

const failures = [];
let totalBudgetCents = 0;
let totalSpendCents = 0;

for (const [index, row] of rows.entries()) {
  const label = `${index + 1}:${row.channel || "missing-channel"}`;
  const budgetCents = toNonnegativeInt(row.budget_cents);
  const spendCents = toNonnegativeInt(row.spend_cents);
  const rowText = Object.values(row).join(" ");

  if (!expectedBudgets.has(row.channel)) failures.push(`${label} unsupported channel`);
  if (budgetCents === null) failures.push(`${label} budget_cents must be a nonnegative integer`);
  if (spendCents === null) failures.push(`${label} spend_cents must be a nonnegative integer`);
  if (budgetCents !== null) totalBudgetCents += budgetCents;
  if (spendCents !== null) totalSpendCents += spendCents;
  if (expectedBudgets.has(row.channel) && budgetCents !== expectedBudgets.get(row.channel)) {
    failures.push(`${label} budget_cents must equal ${expectedBudgets.get(row.channel)}`);
  }
  if (spendCents !== 0) failures.push(`${label} spend_cents must stay 0 before approval and activation proof`);
  if (!allowedApprovalStates.has(row.approval_state)) failures.push(`${label} invalid approval_state ${row.approval_state}`);
  if (!allowedReadinessGates.has(row.readiness_gate)) failures.push(`${label} invalid readiness_gate ${row.readiness_gate}`);
  if (!allowedTrackingStatuses.has(row.tracking_status)) failures.push(`${label} invalid tracking_status ${row.tracking_status}`);
  if (!allowedActivationGates.has(row.activation_gate)) failures.push(`${label} invalid activation_gate ${row.activation_gate}`);
  if (!allowedLaunchStates.has(row.launch_state)) failures.push(`${label} invalid launch_state ${row.launch_state}`);
  if (row.approval_state !== "blocked") failures.push(`${label} approval_state must remain blocked until explicit spend approval`);
  if (row.readiness_gate !== "analytics_checkout_activation_required") failures.push(`${label} readiness_gate must remain blocked until analytics and checkout tracking are live`);
  if (row.activation_gate !== "self_serve_activation_required") failures.push(`${label} activation_gate must remain blocked until paid self-serve activation proof passes`);
  if (row.launch_state !== "blocked") failures.push(`${label} launch_state must remain blocked before proof and approval`);
  if (!row.allowed_start_condition.includes("APPROVE_SMIRK_PAID_TEST")) {
    failures.push(`${label} allowed_start_condition must include APPROVE_SMIRK_PAID_TEST`);
  }
  if (!row.stop_condition) failures.push(`${label} missing stop_condition`);
  if (!row.notes) failures.push(`${label} missing notes`);
  if (/\bguaranteed recovered revenue|unlimited voice|unlimited sms|cold sms campaign|sms-first|automated phone spam enabled\b/i.test(rowText)) {
    failures.push(`${label} includes unsupported claim or forbidden channel language`);
  }
}

if (totalBudgetCents !== 50000) failures.push(`total budget must equal 50000 cents, found ${totalBudgetCents}`);
if (totalSpendCents !== 0) failures.push(`total spend must stay 0 before approval and activation proof, found ${totalSpendCents}`);
if (!paidBrief.includes(approvalPhrase)) failures.push("paid-test brief must include the exact human approval phrase");
if (!paidBrief.includes("Self-serve activation proof has passed")) failures.push("paid-test brief must require self-serve activation proof before spend");
if (!paidBrief.includes("does not authorize spend")) failures.push("paid-test brief must state the brief does not authorize spend");
if (paidCreativeReady) failures.push("paid creative must remain blocked until self-serve paid activation proof is explicitly proven");
if (!blockers.some((blocker) => /Self-serve paid activation proof/i.test(blocker))) {
  failures.push("launch asset manifest must keep self-serve paid activation proof as a paid creative blocker");
}

if (failures.length > 0) {
  fail("paid-test-tracker-invalid", { failures });
}

console.log(JSON.stringify({
  ok: true,
  trackerPath,
  channels: [...channels].sort(),
  totalBudgetCents,
  totalSpendCents,
  paidCreativeReady,
  blockers,
  note: "Offline validation only. No ad campaigns, paid spend, outreach, SMS, Stripe smoke, platform submissions, or production writes.",
}, null, 2));
