#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const defaultFile = "output/launch-touch-packets/first-20-manual-touch-execution.csv";
const inputFile = process.argv.find((arg) => arg.endsWith(".csv")) || defaultFile;
const resolved = path.resolve(inputFile);

const requiredHeaders = [
  "send_order",
  "company",
  "vertical",
  "launch_region",
  "channel",
  "message_variant",
  "contact_url",
  "draft_subject",
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

function fail(error, detail = {}) {
  console.error(JSON.stringify({ ok: false, error, input_file: inputFile, ...detail }, null, 2));
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

function toInt(value) {
  const num = Number.parseInt(String(value || "0"), 10);
  return Number.isFinite(num) ? num : Number.NaN;
}

function looksForbidden(row) {
  return /\b(sms|text|auto[-_\s]?dial|voicemail[-_\s]?drop|purchased[-_\s]?list)\b/i.test([
    row.channel,
    row.contact_url,
    row.actual_contact_path,
    row.skip_reason,
  ].join(" "));
}

if (!fs.existsSync(resolved)) {
  fail("execution-csv-missing", {
    next_action: "Run npm run write:launch-touch-packet before checking the execution sheet.",
  });
}

const { headers, rows } = parseCsv(fs.readFileSync(resolved, "utf8"));
const headerSet = new Set(headers);
const missingHeaders = requiredHeaders.filter((header) => !headerSet.has(header));
if (missingHeaders.length > 0) fail("execution-csv-missing-headers", { missingHeaders });
if (rows.length === 0) fail("execution-csv-empty");

const failures = [];
const summary = {
  rows: rows.length,
  sent: 0,
  skipped: 0,
  ready_to_log: 0,
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

  if (sent) {
    summary.sent += 1;
    if (!row.human_sender) failures.push(`${label} sent_at requires human_sender`);
    if (!row.actual_contact_path) failures.push(`${label} sent_at requires actual_contact_path`);
    if (touchDelta !== 1) failures.push(`${label} sent rows must use touch_count_delta=1`);
    if (nextState === "researched") failures.push(`${label} sent rows cannot remain researched`);
  }

  if (skipped) {
    summary.skipped += 1;
    if (sent) failures.push(`${label} skipped rows must not have sent_at`);
    if (touchDelta !== 0) failures.push(`${label} skipped rows must use touch_count_delta=0`);
  }

  if (!sent && !skipped && response !== "no_response") {
    failures.push(`${label} response_status ${response} requires sent_at or skip_reason`);
  }

  if (response === "qualified") {
    summary.qualified += 1;
    if (!row.qualified_reason) failures.push(`${label} qualified response requires qualified_reason`);
    if (!["qualified", "proof_requested", "checkout_started", "paid", "activated"].includes(nextState)) {
      failures.push(`${label} qualified response must move to a qualified/proof/checkout/paid/activated next state`);
    }
  }

  if (response === "do_not_contact") {
    summary.do_not_contact += 1;
    if (nextState !== "do_not_contact") failures.push(`${label} do_not_contact response must set next_state_after_send=do_not_contact`);
    if (!row.objection && !row.skip_reason) failures.push(`${label} do_not_contact needs objection or skip_reason`);
  }

  if (sent && row.touch_logged_at) summary.ready_to_log += 1;
  summary.spend_cents_delta += Number.isFinite(spendDelta) ? spendDelta : 0;
});

if (failures.length > 0) {
  fail("execution-csv-invalid", { failures });
}

console.log(JSON.stringify({
  ok: true,
  input_file: inputFile,
  summary,
  note: "Offline validation only. No Railway writes, outreach, SMS, calls, payments, or spend.",
}, null, 2));
