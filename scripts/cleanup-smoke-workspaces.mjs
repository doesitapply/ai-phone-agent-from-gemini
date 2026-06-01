import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: process.env.SETTINGS_PATH || ".env.local" });
dotenv.config();

const appUrl = String(process.env.APP_URL || "https://smirkcalls.com").replace(/\/$/, "");
const apiKey = String(process.env.DASHBOARD_API_KEY || "").trim();
const apply = process.argv.includes("--apply");

if (!apiKey) {
  console.error(JSON.stringify({
    ok: false,
    error: "missing-dashboard-api-key",
    message: "Set DASHBOARD_API_KEY in env or .env.local before running cleanup.",
  }, null, 2));
  process.exit(1);
}

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

const output = {
  ok: res.ok && body?.ok !== false,
  endpoint: `${appUrl}/api/admin/cleanup-smoke-workspaces`,
  http_status: res.status,
  apply,
  result: body,
};
console.log(JSON.stringify(output, null, 2));

const outDir = path.resolve("output");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, apply ? "smoke-workspace-cleanup-apply.json" : "smoke-workspace-cleanup-dry-run.json"),
  JSON.stringify(output, null, 2) + "\n"
);

if (!output.ok) process.exit(1);
