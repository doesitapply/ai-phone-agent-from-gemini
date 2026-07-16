#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readRailwayEnvValue } from "./railway-json.mjs";

const appUrl = String(process.env.APP_URL || "https://ai-phone-agent-production-6811.up.railway.app").replace(/\/$/, "");
const days = Math.min(Math.max(Number.parseInt(String(process.env.SMIRK_MARKET_VALIDATION_DAYS || "30"), 10) || 30, 1), 90);
const limit = Math.min(Math.max(Number.parseInt(String(process.env.SMIRK_MARKET_VALIDATION_LEDGER_LIMIT || "500"), 10) || 500, 1), 500);
const fetchTimeoutMs = Number(process.env.SMIRK_LAUNCH_SEGMENT_FETCH_TIMEOUT_MS || 15000);
const outputPath = path.resolve("output", "launch-segment-decisions.json");
const shouldWrite = !process.argv.includes("--no-write");

const qualifiedStates = new Set(["qualified", "proof_requested", "checkout_started", "paid", "activated"]);
const proofStates = new Set(["scheduled", "booked", "completed"]);
const checkoutStates = new Set(["started", "paid"]);

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

function normalizeFetchError(error) {
  return {
    name: error?.name || null,
    message: String(error?.message || error || ""),
    code: error?.cause?.code || error?.code || null,
  };
}

async function fetchJson(pathname, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const res = await fetch(`${appUrl}${pathname}`, {
      headers: { "x-api-key": apiKey },
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
  return {
    error: {
      ok: false,
      error: "operator-auth-unavailable",
      failures,
    },
  };
}

function asNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? Math.max(0, Math.trunc(num)) : 0;
}

function normalize(value, fallback = "unknown") {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "_") || fallback;
}

function isQualified(row) {
  const state = normalize(row?.next_state);
  const response = normalize(row?.response);
  const proof = normalize(row?.proof_walkthrough_status);
  const checkout = normalize(row?.checkout_status);
  return qualifiedStates.has(state) || response === "qualified" || proofStates.has(proof) || checkoutStates.has(checkout);
}

function hasCheckoutWithoutActivation(row) {
  const state = normalize(row?.next_state);
  const checkout = normalize(row?.checkout_status);
  const activation = normalize(row?.activation_status);
  return (checkoutStates.has(checkout) || state === "checkout_started" || state === "paid") && activation !== "activated";
}

function hasBlockedActivation(row) {
  return normalize(row?.activation_status) === "blocked";
}

function emptyBucket(name) {
  return {
    name,
    rows: 0,
    touches: 0,
    qualified: 0,
    proof_walkthroughs: 0,
    checkout_starts: 0,
    paid_activations: 0,
    checkout_without_activation: 0,
    blocked_activation: 0,
    objections: 0,
    do_not_contact: 0,
  };
}

function addRow(bucket, row) {
  const touches = asNumber(row?.touch_count);
  const state = normalize(row?.next_state);
  const proof = normalize(row?.proof_walkthrough_status);
  const checkout = normalize(row?.checkout_status);
  const activation = normalize(row?.activation_status);
  bucket.rows += 1;
  bucket.touches += touches;
  if (isQualified(row)) bucket.qualified += 1;
  if (proofStates.has(proof)) bucket.proof_walkthroughs += 1;
  if (checkoutStates.has(checkout) || state === "checkout_started" || state === "paid" || state === "activated") bucket.checkout_starts += 1;
  if ((checkout === "paid" && activation === "activated") || state === "activated") bucket.paid_activations += 1;
  if (hasCheckoutWithoutActivation(row)) bucket.checkout_without_activation += 1;
  if (hasBlockedActivation(row)) bucket.blocked_activation += 1;
  if (String(row?.objection || "").trim()) bucket.objections += 1;
  if (state === "do_not_contact" || normalize(row?.response) === "do_not_contact") bucket.do_not_contact += 1;
}

function classify(bucket) {
  const qualifiedRate = bucket.touches > 0 ? bucket.qualified / bucket.touches : 0;
  if (bucket.blocked_activation > 0 || bucket.checkout_without_activation > 0) return "product_fix";
  if (bucket.touches >= 200 && qualifiedRate < 0.01) return "pause_channel";
  if (bucket.touches >= 100 && bucket.qualified === 0) return "rewrite_segment_or_message";
  if (bucket.touches >= 25 && qualifiedRate >= 0.03) return "keep";
  if (bucket.touches > 0) return "watch";
  return "insufficient_data";
}

function actionFor(bucket) {
  const decision = classify(bucket);
  const qualifiedRate = bucket.touches > 0 ? Number((bucket.qualified / bucket.touches).toFixed(4)) : 0;
  return {
    ...bucket,
    qualified_rate: qualifiedRate,
    decision,
  };
}

function summarizeBy(rows, label, keyFn) {
  const buckets = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!buckets.has(key)) buckets.set(key, emptyBucket(key));
    addRow(buckets.get(key), row);
  }
  const decisions = [...buckets.values()]
    .map(actionFor)
    .sort((a, b) => {
      const priority = {
        product_fix: 0,
        pause_channel: 1,
        rewrite_segment_or_message: 2,
        keep: 3,
        watch: 4,
        insufficient_data: 5,
      };
      return (priority[a.decision] ?? 9) - (priority[b.decision] ?? 9) || b.touches - a.touches || a.name.localeCompare(b.name);
    });
  return { label, decisions };
}

function compactRequiredActions(groups) {
  const required = [];
  for (const group of groups) {
    for (const item of group.decisions) {
      if (!["product_fix", "pause_channel", "rewrite_segment_or_message"].includes(item.decision)) continue;
      required.push({
        group: group.label,
        name: item.name,
        decision: item.decision,
        touches: item.touches,
        qualified: item.qualified,
        qualified_rate: item.qualified_rate,
        checkout_without_activation: item.checkout_without_activation,
        blocked_activation: item.blocked_activation,
      });
    }
  }
  return required.slice(0, 25);
}

const operator = await firstWorkingOperatorKey();
if (operator.error) {
  console.error(JSON.stringify(operator.error, null, 2));
  process.exit(1);
}

const ledgerRes = await fetchJson(`/api/launch/ledger?days=${days}&limit=${limit}`, operator.apiKey);
if (!ledgerRes.ok || ledgerRes.body?.ok !== true) {
  console.error(JSON.stringify({
    ok: false,
    error: "launch-ledger-unavailable",
    status: ledgerRes.status,
    body: ledgerRes.body,
  }, null, 2));
  process.exit(1);
}

const rows = Array.isArray(ledgerRes.body.rows) ? ledgerRes.body.rows : [];
const groups = [
  summarizeBy(rows, "channel", (row) => normalize(row.channel)),
  summarizeBy(rows, "vertical", (row) => normalize(row.vertical)),
  summarizeBy(rows, "message_variant", (row) => normalize(row.message_variant)),
  summarizeBy(rows, "channel_message_variant", (row) => `${normalize(row.channel)}:${normalize(row.message_variant)}`),
  summarizeBy(rows, "vertical_message_variant", (row) => `${normalize(row.vertical)}:${normalize(row.message_variant)}`),
];
const requiredActions = compactRequiredActions(groups);
const total = rows.reduce((bucket, row) => {
  addRow(bucket, row);
  return bucket;
}, emptyBucket("all"));
const totalDecision = actionFor(total);

const output = {
  ok: requiredActions.length === 0,
  checked_at: new Date().toISOString(),
  app_url: appUrl,
  operator_auth_source: operator.source,
  window_days: days,
  rows_reviewed: rows.length,
  total: totalDecision,
  required_actions: requiredActions,
  groups,
  rules: {
    keep: "touches >= 25 and qualified_rate >= 0.03",
    rewrite_segment_or_message: "touches >= 100 and qualified == 0",
    pause_channel: "touches >= 200 and qualified_rate < 0.01",
    product_fix: "checkout started/paid without activation, or blocked activation",
  },
  notes: [
    "Rows are aggregated by segment and message only; company, owner, contact path, and notes are intentionally omitted.",
    "No outreach, SMS, calls, payments, paid spend, or production writes are triggered by this check.",
  ],
};

if (shouldWrite) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  output.wrote = outputPath;
}

console.log(JSON.stringify(output, null, 2));
if (!output.ok) process.exit(1);
