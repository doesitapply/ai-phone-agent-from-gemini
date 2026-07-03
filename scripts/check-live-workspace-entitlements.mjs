#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readRailwayEnvValue } from "./railway-json.mjs";

const appUrl = String(process.env.APP_URL || "https://ai-phone-agent-production-6811.up.railway.app").replace(/\/$/, "");
const fetchTimeoutMs = Number(process.env.SMIRK_WORKSPACE_ENTITLEMENT_FETCH_TIMEOUT_MS || 15000);
const fetchAttempts = Number(process.env.SMIRK_WORKSPACE_ENTITLEMENT_FETCH_ATTEMPTS || 2);
const fetchRetryDelayMs = Number(process.env.SMIRK_WORKSPACE_ENTITLEMENT_RETRY_DELAY_MS || 750);

const basicPlanIds = new Set(["free", "trial", "starter", "basic"]);
const proPlanIds = new Set(["pro", "enterprise", "agency"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizePlan(plan) {
  const raw = String(plan || "").trim().toLowerCase();
  if (raw === "enterprise" || raw === "agency") return "enterprise";
  if (raw === "pro") return "pro";
  if (raw === "free" || raw === "trial") return "free";
  if (raw === "basic") return "starter";
  return raw || "unknown";
}

function isBasicPlan(plan) {
  return basicPlanIds.has(normalizePlan(plan));
}

function isProPlan(plan) {
  return proPlanIds.has(normalizePlan(plan));
}

function normalizeFetchError(error) {
  return {
    name: error?.name || null,
    message: String(error?.message || error || ""),
    code: error?.cause?.code || error?.code || null,
  };
}

async function request(pathname, headers) {
  const attempts = Math.max(1, fetchAttempts);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      const res = await fetch(`${appUrl}${pathname}`, {
        headers,
        signal: controller.signal,
      });
      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return {
        status: res.status,
        ok: res.ok,
        cacheControl: res.headers.get("cache-control") || "",
        body,
        sample: body ? null : text.slice(0, 160),
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(fetchRetryDelayMs);
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    status: 0,
    ok: false,
    fetchFailed: true,
    error: normalizeFetchError(lastError),
  };
}

async function requestOperator(pathname, apiKey) {
  return request(pathname, { "x-api-key": apiKey });
}

async function requestWorkspace(pathname, workspaceId, apiKey) {
  return request(pathname, {
    "x-workspace-id": String(workspaceId),
    authorization: `Bearer ${apiKey}`,
  });
}

async function firstWorkingOperatorKey() {
  const candidates = [
    ["process env", String(process.env.DASHBOARD_API_KEY || "").trim()],
    ["local env file", readLocalEnvValue("DASHBOARD_API_KEY")],
    ["railway variables", readRailwayEnvValue("DASHBOARD_API_KEY", { quiet: true })],
  ].filter(([, value]) => value);

  const failures = [];
  for (const [source, apiKey] of candidates) {
    const session = await requestOperator("/api/operator/session", apiKey);
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

function summarizeWorkspace(workspace) {
  return {
    id: workspace.id,
    slug: workspace.slug || null,
    plan: workspace.plan || null,
    subscription_status: workspace.subscription_status || null,
    mode: workspace.mode || null,
  };
}

async function fetchWorkspaceToken(operatorApiKey, workspaceId) {
  const tokenResponse = await requestOperator(`/api/workspaces/${encodeURIComponent(workspaceId)}/apikey`, operatorApiKey);
  const token = String(tokenResponse.body?.api_key || "").trim();
  return {
    ok: tokenResponse.ok && Boolean(token),
    status: tokenResponse.status,
    token,
    detail: tokenResponse.ok && token
      ? { id: tokenResponse.body?.id || workspaceId, slug: tokenResponse.body?.slug || null }
      : { error: tokenResponse.body?.error || tokenResponse.error || "workspace-token-unavailable" },
  };
}

async function checkWorkspace(operatorApiKey, workspace, expectedTier) {
  const token = await fetchWorkspaceToken(operatorApiKey, workspace.id);
  if (!token.ok) {
    return {
      workspace: summarizeWorkspace(workspace),
      ok: false,
      error: "workspace-token-unavailable",
      tokenStatus: token.status,
      tokenDetail: token.detail,
    };
  }

  const basicEndpoints = [
    ["/api/calls", 200],
    ["/api/contacts", 200],
    ["/api/tasks", 200],
  ];
  const proEndpoints = [
    ["/api/stats", expectedTier === "pro" ? 200 : 403],
    ["/api/workspace-overview", expectedTier === "pro" ? 200 : 403],
    ["/api/recovery/queue", expectedTier === "pro" ? 200 : 403],
    ["/api/handoffs", expectedTier === "pro" ? 200 : 403],
  ];

  const checks = [];
  for (const [endpoint, expectedStatus] of [...basicEndpoints, ...proEndpoints]) {
    const response = await requestWorkspace(endpoint, workspace.id, token.token);
    checks.push({
      endpoint,
      expectedStatus,
      status: response.status,
      ok: response.status === expectedStatus,
      code: response.body?.code || null,
      cacheProtected: /no-store|no-cache|private/i.test(response.cacheControl),
    });
  }

  return {
    workspace: summarizeWorkspace(workspace),
    ok: checks.every((check) => check.ok),
    expectedTier,
    tokenMasked: token.token ? `${token.token.slice(0, 4)}...${token.token.slice(-4)}` : null,
    checks,
  };
}

const operator = await firstWorkingOperatorKey();
if (operator.error) {
  console.error(JSON.stringify(operator.error, null, 2));
  process.exit(1);
}

const workspaceList = await requestOperator("/api/workspaces", operator.apiKey);
if (!workspaceList.ok || !Array.isArray(workspaceList.body?.workspaces)) {
  console.error(JSON.stringify({
    ok: false,
    error: "workspace-list-unavailable",
    status: workspaceList.status,
    detail: workspaceList.body?.error || workspaceList.error || null,
  }, null, 2));
  process.exit(1);
}

const workspaces = workspaceList.body.workspaces;
const activeFirst = (workspace) => String(workspace.subscription_status || "") === "active" ? 0 : 1;
const basicWorkspace = [...workspaces]
  .filter((workspace) => isBasicPlan(workspace.plan))
  .sort((a, b) => activeFirst(a) - activeFirst(b) || Number(a.id || 0) - Number(b.id || 0))[0] || null;
const proWorkspace = [...workspaces]
  .filter((workspace) => isProPlan(workspace.plan))
  .sort((a, b) => activeFirst(a) - activeFirst(b) || Number(a.id || 0) - Number(b.id || 0))[0] || null;

const liveDeploy = await requestOperator("/health", operator.apiKey);
const results = [];
if (basicWorkspace) results.push(await checkWorkspace(operator.apiKey, basicWorkspace, "basic"));
if (proWorkspace) results.push(await checkWorkspace(operator.apiKey, proWorkspace, "pro"));

const out = {
  ok: results.length > 0 && results.every((result) => result.ok),
  appUrl,
  checkedAt: new Date().toISOString(),
  operatorAuthSource: operator.source,
  liveDeploy: {
    status: liveDeploy.status,
    version: liveDeploy.body?.version || null,
    branch: liveDeploy.body?.branch || null,
    appStatus: liveDeploy.body?.status || null,
  },
  workspaceInventory: {
    total: workspaces.length,
    plans: [...new Set(workspaces.map((workspace) => normalizePlan(workspace.plan)))].sort(),
    basicWorkspaceTested: Boolean(basicWorkspace),
    proWorkspaceTested: Boolean(proWorkspace),
    note: basicWorkspace
      ? null
      : "No Starter/Basic live workspace exists yet, so Basic blocking is covered by static contract until an approved paid/provisioning smoke creates one.",
  },
  testedWorkspaces: results,
};

const outputDir = path.resolve("output");
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "live-workspace-entitlements.json"), JSON.stringify(out, null, 2) + "\n");

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
