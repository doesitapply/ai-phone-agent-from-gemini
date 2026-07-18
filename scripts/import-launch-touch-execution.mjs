#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readRailwayEnvValue } from "./railway-json.mjs";
import { validateLaunchTouchExecutionApproval } from "./lib/launch-touch-approval.mjs";

const args = process.argv.slice(2);
const defaultFile = "output/launch-touch-packets/first-20-manual-touch-execution.csv";
const inputFile = args.find((arg) => arg.endsWith(".csv")) || defaultFile;
const validateOnly = args.includes("--validate-only");
const apply = args.includes("--apply");
const allowRepeatTouch = args.includes("--allow-repeat-touch");
const appUrl = String(process.env.APP_URL || "https://ai-phone-agent-production-6811.up.railway.app").replace(/\/$/, "");
const fetchTimeoutMs = Number(process.env.SMIRK_LAUNCH_TOUCH_IMPORT_FETCH_TIMEOUT_MS || 15000);
const requiredApplyConfirmation = "log-human-launch-touches";
const confirmation = String(process.env.CONFIRM_SMIRK_LAUNCH_TOUCH_IMPORT || "").trim();

const requiredHeaders = [
  "send_order",
  "company",
  "vertical",
  "launch_region",
  "channel",
  "message_variant",
  "contact_url",
  "draft_subject",
  "draft_sha256",
  "approval_batch_sha256",
  "human_sender",
  "actual_contact_path",
  "sent_at",
  "touch_logged_at",
  "next_state_after_send",
  "touch_count_delta",
  "spend_cents_delta",
  "response_status",
  "qualified_reason",
  "objection",
  "proof_walkthrough_status",
  "checkout_status",
  "activation_status",
  "skip_reason",
  "notes",
];

const allowedResponses = new Set([
  "no_response",
  "auto_reply",
  "interested",
  "qualified",
  "not_interested",
  "bad_fit",
  "do_not_contact",
  "bounce",
]);

const allowedNextStates = new Set([
  "researched",
  "contacted",
  "replied",
  "qualified",
  "proof_requested",
  "checkout_started",
  "paid",
  "activated",
  "lost",
  "do_not_contact",
]);

const qualifiedNextStates = new Set(["qualified", "proof_requested", "checkout_started", "paid", "activated"]);

function fail(error, detail = {}) {
  console.error(JSON.stringify({ ok: false, error, input_file: inputFile, ...detail }, null, 2));
  process.exit(1);
}

function readLocalEnvValue(key) {
  const files = [
    ".env.local",
    ".env",
    path.join(process.env.HOME || "", ".openclaw", "workspace", ".env.operator"),
    path.join(process.env.HOME || "", ".openclaw", "workspace", ".env.smirk"),
    path.join(process.env.HOME || "", ".openclaw", "workspace", ".env"),
  ];
  for (const file of files) {
    const p = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith(`${key}=`)) continue;
      return line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, "");
    }
  }
  return "";
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

function normalizeFetchError(error) {
  return {
    name: error?.name || null,
    message: String(error?.message || error || ""),
    code: error?.cause?.code || error?.code || null,
  };
}

async function fetchJson(pathname, apiKey, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const res = await fetch(`${appUrl}${pathname}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 500) };
    }
    return { ok: res.ok, status: res.status, body };
  } catch (error) {
    return { ok: false, status: 0, fetchFailed: true, error: normalizeFetchError(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function firstWorkingOperatorKey() {
  const candidates = [
    ["process env", String(process.env.DASHBOARD_API_KEY || "").trim()],
    ["local env file", readLocalEnvValue("DASHBOARD_API_KEY")],
    ["railway variables", readRailwayEnvValue("DASHBOARD_API_KEY", { quiet: true })],
  ].filter(([, value]) => value);
  const failures = [];
  for (const [source, apiKey] of candidates) {
    const session = await fetchJson("/api/operator/session", apiKey);
    if (session.ok && session.body?.ok === true && session.body?.role === "operator") {
      return { source, apiKey };
    }
    failures.push({ source, status: session.status, error: session.body?.error || session.error || null });
  }
  return { error: { ok: false, error: "operator-auth-unavailable", failures } };
}

function toInt(value) {
  const num = Number.parseInt(String(value || "0"), 10);
  return Number.isFinite(num) ? num : Number.NaN;
}

function companyKey(value) {
  return String(value || "").trim().toLowerCase();
}

function looksForbidden(row) {
  return /\b(sms|text|auto[-_\s]?dial|voicemail[-_\s]?drop|purchased[-_\s]?list)\b/i.test([
    row.channel,
    row.contact_url,
    row.actual_contact_path,
    row.skip_reason,
  ].join(" "));
}

function noteFor(row, existing) {
  const noteParts = [
    existing?.notes ? `previous_notes=${String(existing.notes).slice(0, 1200)}` : "",
    "send_mode=human_manual",
    `execution_csv=${path.basename(inputFile)}`,
    row.send_order ? `send_order=${row.send_order}` : "",
    row.human_sender ? `human_sender=${row.human_sender}` : "",
    row.actual_contact_path ? `actual_contact_path=${row.actual_contact_path}` : "",
    row.sent_at ? `sent_at=${row.sent_at}` : "",
    row.response_status ? `response_status=${row.response_status}` : "",
    row.qualified_reason ? `qualified_reason=${row.qualified_reason}` : "",
    row.objection ? `objection=${row.objection}` : "",
  ].filter(Boolean);
  return noteParts.join("; ").slice(0, 2000);
}

function patchPayload(row, existing) {
  return {
    channel: row.channel,
    message_variant: row.message_variant,
    response: row.response_status || "no_response",
    objection: row.objection || null,
    proof_walkthrough_status: row.proof_walkthrough_status || "not_requested",
    checkout_status: row.checkout_status || "not_started",
    activation_status: row.activation_status || "not_started",
    next_state: row.next_state_after_send,
    bump_touch: true,
    notes: noteFor(row, existing),
  };
}

function validateExecutionSheet() {
  const resolved = path.resolve(inputFile);
  if (!fs.existsSync(resolved)) {
    fail("execution-csv-missing", {
      next_action: "Run npm run write:launch-touch-packet before importing human touch logs.",
    });
  }

  const { headers, rows } = parseCsv(fs.readFileSync(resolved, "utf8"));
  const headerSet = new Set(headers);
  const missingHeaders = requiredHeaders.filter((header) => !headerSet.has(header));
  if (missingHeaders.length > 0) fail("execution-csv-missing-headers", { missingHeaders });
  if (rows.length === 0) fail("execution-csv-empty");

  const approvalIntegrity = validateLaunchTouchExecutionApproval({ rows, executionFile: resolved });
  if (!approvalIntegrity.ok) {
    fail("execution-approval-integrity-invalid", {
      approval_manifest: approvalIntegrity.manifestPath,
      failures: approvalIntegrity.failures,
      owner_approval_proven: false,
      note: "Integrity validation does not approve outreach or prove that an owner approved this batch.",
    });
  }

  const failures = [];
  const summary = {
    rows: rows.length,
    sent: 0,
    already_logged: 0,
    eligible_to_import: 0,
    skipped: 0,
    qualified: 0,
    do_not_contact: 0,
    spend_cents_delta: 0,
  };

  rows.forEach((row, index) => {
    const label = `${index + 1}:${row.company || "missing-company"}`;
    const response = row.response_status || "no_response";
    const nextState = row.next_state_after_send || "";
    const sent = Boolean(row.sent_at);
    const skipped = Boolean(row.skip_reason);
    const touchDelta = toInt(row.touch_count_delta);
    const spendDelta = toInt(row.spend_cents_delta);

    if (!row.company) failures.push(`${label} missing company`);
    if (!row.contact_url) failures.push(`${label} missing contact_url`);
    if (!allowedResponses.has(response)) failures.push(`${label} invalid response_status ${response}`);
    if (!allowedNextStates.has(nextState)) failures.push(`${label} invalid next_state_after_send ${nextState}`);
    if (!Number.isFinite(touchDelta) || touchDelta < 0) failures.push(`${label} invalid touch_count_delta ${row.touch_count_delta}`);
    if (!Number.isFinite(spendDelta) || spendDelta < 0) failures.push(`${label} invalid spend_cents_delta ${row.spend_cents_delta}`);
    if (spendDelta !== 0) failures.push(`${label} spend_cents_delta must stay 0 for manual organic touches`);
    if (looksForbidden(row)) failures.push(`${label} includes forbidden SMS/auto-dial/voicemail-drop/purchased-list language`);
    if (row.touch_logged_at && !sent) failures.push(`${label} touch_logged_at requires sent_at`);

    if (sent) {
      summary.sent += 1;
      if (row.touch_logged_at) summary.already_logged += 1;
      else summary.eligible_to_import += 1;
      if (!row.human_sender) failures.push(`${label} sent_at requires human_sender`);
      if (!row.actual_contact_path) failures.push(`${label} sent_at requires actual_contact_path`);
      if (skipped) failures.push(`${label} sent rows must not have skip_reason`);
      if (touchDelta !== 1) failures.push(`${label} sent rows must use touch_count_delta=1`);
      if (nextState === "researched") failures.push(`${label} sent rows cannot remain researched`);
    }

    if (skipped && !sent) {
      summary.skipped += 1;
      if (touchDelta !== 0) failures.push(`${label} skipped rows must use touch_count_delta=0`);
      if (!["researched", "lost", "do_not_contact"].includes(nextState)) {
        failures.push(`${label} skipped rows must stay researched, lost, or do_not_contact`);
      }
    }

    if (!sent && !skipped) {
      if (row.human_sender || row.actual_contact_path || row.touch_logged_at) {
        failures.push(`${label} unsent rows must not have human_sender, actual_contact_path, or touch_logged_at`);
      }
      if (touchDelta !== 0) failures.push(`${label} unsent rows must keep touch_count_delta=0`);
      if (nextState !== "researched") failures.push(`${label} unsent rows must remain researched`);
    }

    if (!sent && !skipped && response !== "no_response") {
      failures.push(`${label} response_status ${response} requires sent_at or skip_reason`);
    }

    if (response === "qualified") {
      summary.qualified += 1;
      if (!row.qualified_reason) failures.push(`${label} qualified response requires qualified_reason`);
      if (!qualifiedNextStates.has(nextState)) {
        failures.push(`${label} qualified response must move to a qualified/proof/checkout/paid/activated next state`);
      }
    }

    if (response === "do_not_contact") {
      summary.do_not_contact += 1;
      if (nextState !== "do_not_contact") failures.push(`${label} do_not_contact response must set next_state_after_send=do_not_contact`);
      if (!row.objection && !row.skip_reason) failures.push(`${label} do_not_contact needs objection or skip_reason`);
    }

    summary.spend_cents_delta += Number.isFinite(spendDelta) ? spendDelta : 0;
  });

  const duplicateEligibleCompanies = Object.entries(
    rows
      .filter((row) => row.sent_at && !row.touch_logged_at)
      .reduce((map, row) => {
        const key = companyKey(row.company);
        if (key) map[key] = (map[key] || 0) + 1;
        return map;
      }, {}),
  ).filter(([, count]) => count > 1);
  if (duplicateEligibleCompanies.length > 0) {
    failures.push(`eligible sent rows must be unique by company: ${duplicateEligibleCompanies.map(([company]) => company).join(", ")}`);
  }

  if (failures.length > 0) fail("execution-csv-invalid", { failures });
  return { rows, summary, approvalIntegrity };
}

if (apply && validateOnly) {
  fail("validate-only-cannot-apply", {
    message: "Use --validate-only for offline checks or --apply for confirmed live writes, not both.",
  });
}

const { rows, summary, approvalIntegrity } = validateExecutionSheet();
const eligibleRows = rows.filter((row) => row.sent_at && !row.touch_logged_at);

if (validateOnly) {
  console.log(JSON.stringify({
    ok: true,
    validate_only: true,
    apply: false,
    input_file: inputFile,
    approval_manifest: approvalIntegrity.manifestPath,
    approval_payload_sha256: approvalIntegrity.payloadSha256,
    approval_integrity_verified: true,
    owner_approval_proven: false,
    summary,
    note: "Offline integrity validation only. This does not prove owner approval and performs no Railway writes, outreach, SMS, calls, payments, or spend.",
  }, null, 2));
  process.exit(0);
}

if (apply && confirmation !== requiredApplyConfirmation) {
  console.error(JSON.stringify({
    ok: false,
    error: "missing-touch-import-confirmation",
    message: "This logs human-completed manual touches to the live operator launch ledger. It does not send outreach.",
    requiredEnv: "CONFIRM_SMIRK_LAUNCH_TOUCH_IMPORT",
    requiredValue: requiredApplyConfirmation,
    nextAction: `CONFIRM_SMIRK_LAUNCH_TOUCH_IMPORT=${requiredApplyConfirmation} npm run import:launch-touch-execution:apply`,
  }, null, 2));
  process.exit(1);
}

if (apply && eligibleRows.length === 0) {
  fail("no-sent-rows-to-import", {
    message: "Fill sent_at, human_sender, actual_contact_path, next_state_after_send, and touch_count_delta=1 after a real human-reviewed send.",
  });
}

const operator = await firstWorkingOperatorKey();
if (operator.error) {
  console.error(JSON.stringify(operator.error, null, 2));
  process.exit(1);
}

const existing = await fetchJson("/api/launch/ledger?days=90&limit=500", operator.apiKey);
if (!existing.ok || existing.body?.ok !== true) {
  fail("launch-ledger-unavailable", {
    status: existing.status,
    body: existing.body,
  });
}

const existingRows = Array.isArray(existing.body.rows) ? existing.body.rows : [];
const existingByCompany = new Map();
const duplicateLiveCompanies = [];
for (const row of existingRows) {
  const key = companyKey(row?.company);
  if (!key) continue;
  if (existingByCompany.has(key)) duplicateLiveCompanies.push(row.company);
  else existingByCompany.set(key, row);
}
if (duplicateLiveCompanies.length > 0) {
  fail("duplicate-live-ledger-companies", {
    companies: duplicateLiveCompanies.slice(0, 20),
    message: "Refusing ambiguous launch touch import. Deduplicate live ledger rows first.",
  });
}

const missingExisting = [];
const skippedExistingTouched = [];
const toPatch = [];
for (const row of eligibleRows) {
  const match = existingByCompany.get(companyKey(row.company));
  if (!match) {
    missingExisting.push(row.company);
    continue;
  }
  if (!allowRepeatTouch && Number(match.touch_count || 0) > 0) {
    skippedExistingTouched.push(row.company);
    continue;
  }
  toPatch.push({ row, match, payload: patchPayload(row, match) });
}

if (missingExisting.length > 0) {
  fail("launch-touch-existing-row-missing", {
    companies: missingExisting,
    next_action: "Import researched prospects before importing sent touch logs.",
  });
}

const result = {
  ok: true,
  apply,
  validate_only: false,
  app_url: appUrl,
  operator_auth_source: operator.source,
  input_file: inputFile,
  approval_manifest: approvalIntegrity.manifestPath,
  approval_payload_sha256: approvalIntegrity.payloadSha256,
  approval_integrity_verified: true,
  owner_approval_proven: false,
  summary,
  eligible_sent_rows: eligibleRows.length,
  would_patch: toPatch.length,
  skipped_existing_touched: skippedExistingTouched.length,
  skipped_existing_touched_companies: skippedExistingTouched,
  patched: 0,
  failed: [],
  note: "No outreach is sent by this importer. Integrity validation does not prove owner approval; this only logs human-completed touches to existing launch ledger rows.",
};

if (apply) {
  for (const item of toPatch) {
    const updated = await fetchJson(`/api/launch/ledger/${item.match.id}`, operator.apiKey, {
      method: "PATCH",
      body: JSON.stringify(item.payload),
    });
    if (updated.ok && updated.body?.ok === true) {
      result.patched += 1;
    } else {
      result.failed.push({
        company: item.row.company,
        status: updated.status,
        error: updated.body?.error || updated.error || "patch-failed",
      });
    }
  }
  result.ok = result.failed.length === 0;
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
