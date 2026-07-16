#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readRailwayEnvValue } from "./railway-json.mjs";

const defaultFile = "docs/launch/prospect-batch-001-reno.csv";
const inputFile = process.argv.find((arg) => arg.endsWith(".csv")) || defaultFile;
const apply = process.argv.includes("--apply");
const appUrl = String(process.env.APP_URL || "https://ai-phone-agent-production-6811.up.railway.app").replace(/\/$/, "");
const fetchTimeoutMs = Number(process.env.SMIRK_LAUNCH_IMPORT_FETCH_TIMEOUT_MS || 15000);
const requiredApplyConfirmation = "import-researched-launch-prospects";
const confirmation = String(process.env.CONFIRM_SMIRK_LAUNCH_LEDGER_IMPORT || "").trim();

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
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
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
  return dataRows.map((values) => Object.fromEntries(headers.map((header, index) => [header.trim(), String(values[index] || "").trim()])));
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
  return Number.isFinite(num) ? Math.max(0, num) : 0;
}

function ledgerPayload(row) {
  const sourceUrl = String(row.source_url || "").trim();
  const contactUrl = String(row.contact_url || "").trim();
  const noteParts = [
    row.notes || "Public launch research; no message sent",
    sourceUrl ? `source_url=${sourceUrl}` : "",
    contactUrl ? `contact_url=${contactUrl}` : "",
    "research_batch=prospect-batch-001-reno",
  ].filter(Boolean);
  return {
    source: row.source || "manual_research",
    company: row.company,
    vertical: row.vertical,
    region: row.region,
    owner_contact: row.owner_contact,
    channel: row.channel,
    message_variant: row.message_variant,
    response: row.response || "no_response",
    objection: row.objection || null,
    proof_walkthrough_status: row.proof_walkthrough_status || "not_requested",
    checkout_status: row.checkout_status || "not_started",
    activation_status: row.activation_status || "not_started",
    next_state: row.next_state || "researched",
    touch_count: toInt(row.touch_count),
    spend_cents: toInt(row.spend_cents),
    notes: noteParts.join("; "),
  };
}

const raw = fs.readFileSync(path.resolve(inputFile), "utf8");
const rows = parseCsv(raw);
const payloads = rows.map(ledgerPayload);
const missingCompany = payloads.filter((row) => !row.company);
if (missingCompany.length > 0) {
  console.error(JSON.stringify({ ok: false, error: "missing-company", count: missingCompany.length }, null, 2));
  process.exit(1);
}

if (apply && confirmation !== requiredApplyConfirmation) {
  console.error(JSON.stringify({
    ok: false,
    error: "missing-import-confirmation",
    message: "This writes researched prospect rows to the live operator launch ledger. It does not send outreach.",
    requiredEnv: "CONFIRM_SMIRK_LAUNCH_LEDGER_IMPORT",
    requiredValue: requiredApplyConfirmation,
    nextAction: `CONFIRM_SMIRK_LAUNCH_LEDGER_IMPORT=${requiredApplyConfirmation} npm run import:launch-ledger:batch:apply`,
  }, null, 2));
  process.exit(1);
}

const operator = await firstWorkingOperatorKey();
if (operator.error) {
  console.error(JSON.stringify(operator.error, null, 2));
  process.exit(1);
}

const existing = await fetchJson("/api/launch/ledger?days=90&limit=500", operator.apiKey);
if (!existing.ok || existing.body?.ok !== true) {
  console.error(JSON.stringify({
    ok: false,
    error: "launch-ledger-unavailable",
    status: existing.status,
    body: existing.body,
  }, null, 2));
  process.exit(1);
}

const existingCompanies = new Set(
  (Array.isArray(existing.body.rows) ? existing.body.rows : [])
    .map((row) => String(row?.company || "").trim().toLowerCase())
    .filter(Boolean),
);
const toCreate = payloads.filter((row) => !existingCompanies.has(String(row.company || "").trim().toLowerCase()));
const skippedExisting = payloads.length - toCreate.length;
const result = {
  ok: true,
  apply,
  app_url: appUrl,
  operator_auth_source: operator.source,
  input_file: inputFile,
  researched_rows: payloads.length,
  would_create: toCreate.length,
  skipped_existing: skippedExisting,
  by_vertical: Object.fromEntries(
    [...payloads.reduce((map, row) => map.set(row.vertical || "unknown", (map.get(row.vertical || "unknown") || 0) + 1), new Map()).entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  ),
  created: 0,
  failed: [],
  note: "No outreach is sent by this importer.",
};

if (apply) {
  for (const payload of toCreate) {
    const created = await fetchJson("/api/launch/ledger", operator.apiKey, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (created.ok && created.body?.ok === true) {
      result.created += 1;
    } else {
      result.failed.push({ company: payload.company, status: created.status, error: created.body?.error || created.error || "create-failed" });
    }
  }
  result.ok = result.failed.length === 0;
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
