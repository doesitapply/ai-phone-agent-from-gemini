#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readRailwayEnvValue } from "./railway-json.mjs";

const appUrl = String(process.env.APP_URL || "https://ai-phone-agent-production-6811.up.railway.app").replace(/\/$/, "");
const fetchTimeoutMs = Number(process.env.SMIRK_LAUNCH_ANALYTICS_FETCH_TIMEOUT_MS || 15000);
const source = String(process.env.SMIRK_LAUNCH_ANALYTICS_SMOKE_SOURCE || "codex_launch_analytics_smoke").trim();
const campaign = String(process.env.SMIRK_LAUNCH_ANALYTICS_SMOKE_CAMPAIGN || `smoke_${new Date().toISOString().replace(/[:.]/g, "-")}`).trim();
const outputPath = path.resolve("output", "launch-analytics-smoke.json");

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

async function fetchJson(pathname, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const res = await fetch(`${appUrl}${pathname}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "user-agent": "smirk-launch-analytics-smoke",
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
  for (const [authSource, apiKey] of candidates) {
    const session = await fetchJson("/api/operator/session", {
      headers: { "x-api-key": apiKey },
    });
    if (session.ok && session.body?.ok === true && session.body?.role === "operator") {
      return { source: authSource, apiKey };
    }
    failures.push({ source: authSource, status: session.status, error: session.body?.error || session.error || null });
  }
  return { error: { ok: false, error: "operator-auth-unavailable", failures } };
}

const events = [
  {
    event_name: "launch_page_view",
    page_path: "/launch",
    source,
    medium: "smoke",
    campaign,
    channel: "launch_plan",
    metadata: {
      synthetic: true,
      purpose: "launch_analytics_tracking_proof",
      creates_checkout_session: false,
    },
  },
  {
    event_name: "cta_clicked",
    page_path: "/launch",
    source,
    medium: "smoke",
    campaign,
    channel: "launch_plan",
    cta: "smoke_start_starter",
    metadata: {
      synthetic: true,
      purpose: "launch_cta_tracking_proof",
      creates_checkout_session: false,
    },
  },
  {
    event_name: "checkout_started",
    page_path: "/pricing",
    source,
    medium: "smoke",
    campaign,
    channel: "pricing",
    plan: "starter",
    cta: "smoke_checkout_started_no_payment",
    metadata: {
      synthetic: true,
      purpose: "checkout_event_tracking_proof",
      creates_checkout_session: false,
      payment_started: false,
      stripe_session_created: false,
    },
  },
];

const posted = [];
for (const event of events) {
  const response = await fetchJson("/api/launch/events", {
    method: "POST",
    body: JSON.stringify(event),
  });
  posted.push({
    event_name: event.event_name,
    status: response.status,
    ok: response.ok,
    stored: response.body?.stored === true,
    body: response.body,
  });
}

const operator = await firstWorkingOperatorKey();
if (operator.error) {
  console.error(JSON.stringify(operator.error, null, 2));
  process.exit(1);
}

const summary = await fetchJson("/api/launch/summary?days=30", {
  headers: { "x-api-key": operator.apiKey },
});

if (!summary.ok || summary.body?.ok !== true) {
  console.error(JSON.stringify({
    ok: false,
    error: "launch-summary-unavailable",
    status: summary.status,
    body: summary.body,
  }, null, 2));
  process.exit(1);
}

const bySource = Array.isArray(summary.body.by_source) ? summary.body.by_source : [];
const recentEvents = Array.isArray(summary.body.recent_events) ? summary.body.recent_events : [];
const sourceEventNames = new Set(
  bySource
    .filter((row) => String(row?.source || "") === source)
    .map((row) => String(row?.event_name || "")),
);
const recentCampaignEvents = new Set(
  recentEvents
    .filter((row) => String(row?.source || "") === source && String(row?.campaign || "") === campaign)
    .map((row) => String(row?.event_name || "")),
);

const requiredEvents = events.map((event) => event.event_name);
const missingFromSourceSummary = requiredEvents.filter((eventName) => !sourceEventNames.has(eventName));
const missingFromRecentCampaign = requiredEvents.filter((eventName) => !recentCampaignEvents.has(eventName));
const postFailures = posted.filter((event) => event.ok !== true || event.stored !== true);

const output = {
  ok: postFailures.length === 0 && missingFromSourceSummary.length === 0 && missingFromRecentCampaign.length === 0 && summary.body.spend_gate?.checkout_events_trackable === true,
  app_url: appUrl,
  source,
  campaign,
  operator_auth_source: operator.source,
  posted,
  spend_gate: summary.body.spend_gate,
  source_events_seen: [...sourceEventNames].sort(),
  recent_campaign_events_seen: [...recentCampaignEvents].sort(),
  failures: {
    post_failures: postFailures,
    missing_from_source_summary: missingFromSourceSummary,
    missing_from_recent_campaign: missingFromRecentCampaign,
    checkout_events_trackable: summary.body.spend_gate?.checkout_events_trackable === true ? null : "not-true",
  },
  note: "This smoke writes synthetic launch analytics events only. It does not create checkout sessions, payments, ledger touches, SMS, or outreach.",
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));

if (!output.ok) process.exit(1);
