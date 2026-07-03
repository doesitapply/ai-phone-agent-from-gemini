import fs from "node:fs";
import path from "node:path";
import { readRailwayEnvValue } from "./railway-json.mjs";

const explicitAppUrl = String(process.env.APP_URL || "").trim();
const explicitApiKey = String(process.env.DASHBOARD_API_KEY || "").trim();

const appUrl = (explicitAppUrl || readLocalEnvValue("APP_URL") || "https://ai-phone-agent-production-6811.up.railway.app").replace(/\/$/, "");
const apply = process.argv.includes("--apply");
const applyConfirmation = String(process.env.CONFIRM_SMOKE_CLEANUP_APPLY || "").trim();

if (apply && applyConfirmation !== "delete-smirk-smoke-records") {
  console.error(JSON.stringify({
    ok: false,
    error: "missing-apply-confirmation",
    message: "Dry-run is safe by default. To apply production smoke cleanup, rerun with CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records.",
    apply,
  }, null, 2));
  process.exit(1);
}

function readLocalEnvValue(key) {
  const files = [
    process.env.SETTINGS_PATH || ".env.local",
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

const candidates = [
  ["process env", explicitApiKey],
  ["local env file", readLocalEnvValue("DASHBOARD_API_KEY")],
  ["railway variables", readRailwayEnvValue("DASHBOARD_API_KEY", { quiet: true })],
].filter(([, value]) => String(value || "").trim().length > 0);

if (candidates.length === 0) {
  console.error(JSON.stringify({
    ok: false,
    error: "missing-dashboard-api-key",
    message: "Set DASHBOARD_API_KEY in env, .env.local, or live Railway variables before running cleanup.",
  }, null, 2));
  process.exit(1);
}

let output;
let lastFailure;

for (const [authSource, apiKey] of candidates) {
  const res = await fetch(`${appUrl}/api/admin/cleanup-smoke-workspaces`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ apply }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  const candidateOutput = {
    ok: res.ok && body?.ok !== false,
    endpoint: `${appUrl}/api/admin/cleanup-smoke-workspaces`,
    http_status: res.status,
    auth_source: authSource,
    apply,
    result: body,
  };

  if (candidateOutput.ok || res.status !== 401) {
    output = candidateOutput;
    break;
  }

  lastFailure = { ...candidateOutput, result: { error: "unauthorized" } };
}

output ||= lastFailure || {
  ok: false,
  endpoint: `${appUrl}/api/admin/cleanup-smoke-workspaces`,
  http_status: 0,
  apply,
  result: { error: "cleanup-request-failed" },
};

console.log(JSON.stringify(output, null, 2));

const outDir = path.resolve("output");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, apply ? "smoke-workspace-cleanup-apply.json" : "smoke-workspace-cleanup-dry-run.json"),
  JSON.stringify(output, null, 2) + "\n"
);

if (!output.ok) process.exit(1);
