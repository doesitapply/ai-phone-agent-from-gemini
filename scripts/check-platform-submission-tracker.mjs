#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const trackerPath = process.argv.find((arg) => arg.endsWith(".csv")) || "docs/launch/platform-submission-tracker.csv";
const manifestPath = "output/playwright/launch-assets/manifest.json";

const requiredColumns = [
  "platform",
  "submission_url",
  "submission_state",
  "gate_status",
  "asset_status",
  "next_action",
  "owner",
  "response_plan",
  "notes",
];

const requiredPlatforms = new Set(["product_hunt", "g2", "capterra", "appsumo"]);
const allowedSubmissionStates = new Set(["prepared_blocked", "prepared_ready", "submitted", "delayed"]);
const allowedGateStatuses = new Set([
  "self_serve_activation_required",
  "active_selling_required",
  "usage_caps_and_margin_required",
  "approved_preproof_feedback_launch",
  "green",
]);
const allowedAssetStatuses = new Set(["assets_ready", "assets_ready_for_feedback", "not_ready"]);

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

function readManifest() {
  if (!fs.existsSync(path.resolve(manifestPath))) return null;
  try {
    return JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8"));
  } catch {
    return null;
  }
}

function assetExists(file, minBytes = 20000) {
  const resolved = path.resolve(file);
  return fs.existsSync(resolved) && fs.statSync(resolved).size >= minBytes;
}

if (!fs.existsSync(path.resolve(trackerPath))) {
  fail("platform-submission-tracker-missing");
}

const { headers, rows } = parseCsv(fs.readFileSync(path.resolve(trackerPath), "utf8"));
const headerSet = new Set(headers);
const missingColumns = requiredColumns.filter((column) => !headerSet.has(column));
if (missingColumns.length > 0) fail("platform-submission-tracker-missing-columns", { missingColumns });
if (rows.length === 0) fail("platform-submission-tracker-empty");

const platforms = new Set(rows.map((row) => row.platform));
const missingPlatforms = [...requiredPlatforms].filter((platform) => !platforms.has(platform));
if (missingPlatforms.length > 0) fail("platform-submission-tracker-missing-platforms", { missingPlatforms });

const manifest = readManifest();
const publicAssetCount = manifest?.public_screenshots?.filter((asset) => asset.ok === true).length || 0;
const protectedAssets = [
  "output/playwright/launch-assets/06-redacted-proof-dashboard.png",
  "output/playwright/launch-assets/07-redacted-callback-task-queue.png",
  "output/playwright/launch-assets/08-smirk-short-proof-walkthrough.mp4",
];
const protectedAssetsPresent = protectedAssets.every((file) => assetExists(file));
const submissionReady = manifest?.submission_readiness?.product_hunt_submission_ready === true;
const blockers = manifest?.submission_readiness?.blockers || [];

const failures = [];
for (const [index, row] of rows.entries()) {
  const label = `${index + 1}:${row.platform || "missing-platform"}`;
  if (!requiredPlatforms.has(row.platform)) failures.push(`${label} unsupported platform`);
  if (!/^https:\/\//.test(row.submission_url)) failures.push(`${label} submission_url must be https`);
  if (!allowedSubmissionStates.has(row.submission_state)) failures.push(`${label} invalid submission_state ${row.submission_state}`);
  if (!allowedGateStatuses.has(row.gate_status)) failures.push(`${label} invalid gate_status ${row.gate_status}`);
  if (!allowedAssetStatuses.has(row.asset_status)) failures.push(`${label} invalid asset_status ${row.asset_status}`);
  if (!row.next_action) failures.push(`${label} missing next_action`);
  if (!row.owner) failures.push(`${label} missing owner`);
  if (!row.response_plan) failures.push(`${label} missing response_plan`);
  if (/\bguaranteed recovered revenue|unlimited voice|unlimited sms|cold sms campaign|automated phone spam\b/i.test(Object.values(row).join(" "))) {
    failures.push(`${label} includes unsupported claim or forbidden channel language`);
  }
}

const productHunt = rows.find((row) => row.platform === "product_hunt");
if (productHunt?.submission_state === "submitted" && productHunt.gate_status !== "green" && productHunt.gate_status !== "approved_preproof_feedback_launch") {
  failures.push("Product Hunt cannot be submitted until self-serve proof is green or pre-proof feedback launch is explicitly approved");
}
if (productHunt?.asset_status !== "assets_ready_for_feedback") {
  failures.push("Product Hunt should stay assets_ready_for_feedback until self-serve proof clears submission readiness");
}

for (const platform of ["g2", "capterra"]) {
  const row = rows.find((entry) => entry.platform === platform);
  if (row?.submission_state === "submitted" && row.gate_status !== "green") {
    failures.push(`${platform} cannot be marked submitted until active selling/support gate is green`);
  }
}

const appsumo = rows.find((row) => row.platform === "appsumo");
if (appsumo?.submission_state !== "delayed") failures.push("AppSumo must remain delayed until usage caps, margins, support load, and self-serve proof are known");
if (appsumo?.asset_status !== "not_ready") failures.push("AppSumo asset_status must remain not_ready before unit economics are proven");

if (publicAssetCount < 5) failures.push("launch asset manifest must include five public screenshots");
if (!protectedAssetsPresent) failures.push("redacted proof screenshots and walkthrough clip must exist before platform submission prep is considered asset-ready");
if (submissionReady) failures.push("submission readiness should not be green until self-serve paid activation proof is explicitly proven");
if (!blockers.some((blocker) => /Self-serve paid activation proof/i.test(blocker))) {
  failures.push("launch asset manifest must keep self-serve paid activation proof as a submission blocker");
}

if (failures.length > 0) {
  fail("platform-submission-tracker-invalid", { failures });
}

console.log(JSON.stringify({
  ok: true,
  trackerPath,
  platforms: [...platforms].sort(),
  publicAssetCount,
  protectedAssetsPresent,
  productHuntSubmissionReady: submissionReady,
  blockers,
  note: "Offline validation only. No platform submissions, paid spend, outreach, SMS, Stripe smoke, or production writes.",
}, null, 2));
