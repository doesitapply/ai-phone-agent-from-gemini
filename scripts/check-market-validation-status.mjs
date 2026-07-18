#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readRailwayEnvValue } from "./railway-json.mjs";

const appUrl = String(process.env.APP_URL || "https://ai-phone-agent-production-6811.up.railway.app").replace(/\/$/, "");
const days = Math.min(Math.max(Number.parseInt(String(process.env.SMIRK_MARKET_VALIDATION_DAYS || "30"), 10) || 30, 1), 90);
const limit = Math.min(Math.max(Number.parseInt(String(process.env.SMIRK_MARKET_VALIDATION_LEDGER_LIMIT || "500"), 10) || 500, 1), 500);
const fetchTimeoutMs = Number(process.env.SMIRK_MARKET_VALIDATION_FETCH_TIMEOUT_MS || 15000);
const outputPath = path.resolve("output", "market-validation-status.json");
const shouldWrite = !process.argv.includes("--no-write");

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

function runCommand(command, args) {
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    }).trim();
    return { ok: true, stdout };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout || "").trim(),
      stderr: String(error?.stderr || "").trim(),
      message: String(error?.message || error),
    };
  }
}

function parseJsonCommand(command, args) {
  const result = runCommand(command, args);
  if (!result.ok) return result;
  try {
    return { ok: true, body: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, error: "invalid-json", sample: result.stdout.slice(0, 1000) };
  }
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
    return {
      ok: res.ok,
      status: res.status,
      body,
      cacheProtected: /no-store|private|no-cache/i.test(String(res.headers.get("cache-control") || "")),
    };
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
      message: "Could not find a working DASHBOARD_API_KEY in process env, local env, or Railway variables.",
      failures,
    },
  };
}

function asNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function countBy(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const raw = String(row?.[key] || "unknown").trim().toLowerCase() || "unknown";
    counts.set(raw, (counts.get(raw) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([name, count]) => ({ name, count }));
}

function summarizeLedgerRows(rows) {
  const checkoutNeedsActivation = rows.filter((row) => {
    const checkout = String(row?.checkout_status || "").toLowerCase();
    const state = String(row?.next_state || "").toLowerCase();
    const activation = String(row?.activation_status || "").toLowerCase();
    return (checkout === "paid" || checkout === "started" || state === "checkout_started" || state === "paid") && activation !== "activated";
  });
  const blockedActivations = rows.filter((row) => String(row?.activation_status || "").toLowerCase() === "blocked");
  return {
    rows_reviewed: rows.length,
    by_vertical: countBy(rows, "vertical"),
    by_channel: countBy(rows, "channel"),
    by_next_state: countBy(rows, "next_state"),
    checkout_without_activation_count: checkoutNeedsActivation.length,
    blocked_activation_count: blockedActivations.length,
  };
}

function buildNextActions({ traction, ledgerSummary, spendGate }) {
  const actions = [];
  const checkoutStarts = asNumber(traction.checkout_starts);
  const paidActivations = asNumber(traction.paid_activations);

  if (ledgerSummary.blocked_activation_count > 0) {
    actions.push("Pause promotion and fix the blocked self-serve activation rows before scaling launch channels.");
  }
  if (checkoutStarts > paidActivations) {
    actions.push("Investigate checkout starts without activation as product/onboarding defects before adding paid spend.");
  }
  if (paidActivations < 1) {
    actions.push("Keep the self-serve claim gated until a paid or explicitly approved production activation proves checkout, workspace access, dashboard, proof call, owner alert, and callback task.");
  }
  if (asNumber(traction.companies) === 0) {
    actions.push("Add the first researched home-service prospects to /dashboard/launch before reporting outreach progress.");
  }
  if (asNumber(traction.touches) < 200) {
    actions.push("Work toward the first 200 researched manual touches using the approved no-SMS, no-auto-dial outreach playbook.");
  }
  if (spendGate?.paid_spend_allowed !== true) {
    actions.push("Do not start paid spend until the approval phrase and self-serve proof gate are both satisfied.");
  }
  return actions.slice(0, 5);
}

const live = parseJsonCommand("npm", ["run", "-s", "check:live-is-current"]);
const failedDeploy = runCommand("npm", ["run", "-s", "check:latest-failed-deploy"]);

const operator = await firstWorkingOperatorKey();
if (operator.error) {
  console.error(JSON.stringify(operator.error, null, 2));
  process.exit(1);
}

const [summaryRes, ledgerRes] = await Promise.all([
  fetchJson(`/api/launch/summary?days=${days}`, operator.apiKey),
  fetchJson(`/api/launch/ledger?days=${days}&limit=${limit}`, operator.apiKey),
]);

if (!summaryRes.ok || summaryRes.body?.ok !== true) {
  console.error(JSON.stringify({
    ok: false,
    error: "launch-summary-unavailable",
    status: summaryRes.status,
    body: summaryRes.body,
  }, null, 2));
  process.exit(1);
}

if (!ledgerRes.ok || ledgerRes.body?.ok !== true) {
  console.error(JSON.stringify({
    ok: false,
    error: "launch-ledger-unavailable",
    status: ledgerRes.status,
    body: ledgerRes.body,
  }, null, 2));
  process.exit(1);
}

const traction = summaryRes.body.traction || {};
const ledgerRows = Array.isArray(ledgerRes.body.rows) ? ledgerRes.body.rows : [];
const ledgerSummary = summarizeLedgerRows(ledgerRows);
const hardStops = traction.hard_stops || {};
const status =
  hardStops.reported_paid_activation ? "provider_verification_required" :
  hardStops.interaction ? "success_interaction" :
  hardStops.negative_signal ? "negative_signal" :
  ledgerSummary.blocked_activation_count > 0 ? "pause_product_fix" :
  "continue";

const output = {
  ok: live.ok === true && live.body?.ok === true && failedDeploy.ok === true,
  checked_at: new Date().toISOString(),
  app_url: appUrl,
  operator_auth_source: operator.source,
  live: live.body || live,
  failed_deploy_check: {
    ok: failedDeploy.ok,
    message: failedDeploy.ok ? failedDeploy.stdout : failedDeploy.stderr || failedDeploy.stdout || failedDeploy.message,
  },
  window_days: days,
  status,
  stop_conditions: {
    revenue: false,
    reported_paid_activation: Boolean(hardStops.reported_paid_activation),
    interaction: Boolean(hardStops.interaction),
    negative_signal: Boolean(hardStops.negative_signal),
  },
  traction: {
    companies: asNumber(traction.companies),
    touches: asNumber(traction.touches),
    spend_cents: asNumber(traction.spend_cents),
    qualified_conversations: asNumber(traction.qualified_conversations),
    proof_walkthroughs: asNumber(traction.proof_walkthroughs),
    checkout_starts: asNumber(traction.checkout_starts),
    paid_activations: asNumber(traction.paid_activations),
  },
  spend_gate: summaryRes.body.spend_gate || null,
  launch_events: {
    by_event: summaryRes.body.by_event || [],
    by_source: summaryRes.body.by_source || [],
  },
  ledger_summary: ledgerSummary,
  next_actions: buildNextActions({ traction, ledgerSummary, spendGate: summaryRes.body.spend_gate || {} }),
  notes: [
    "Operator-edited paid activation is a reported milestone only. Run npm run check:qualifying-revenue-live for authoritative revenue proof.",
    "Ledger row details are intentionally omitted from this report to avoid printing owner/contact fields.",
    "Cold SMS, automated phone spam, purchased-list blasting, and uncapped SMS/AI testing remain outside the sprint.",
  ],
};

if (shouldWrite) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  output.wrote = outputPath;
}

console.log(JSON.stringify(output, null, 2));

if (!output.ok) process.exit(1);
