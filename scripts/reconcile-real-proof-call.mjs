import fs from "node:fs";
import path from "node:path";
import { readRailwayEnvValue } from "./railway-json.mjs";

const EXACT_POSITIVE_INTEGER_RE = /^[1-9]\d*$/;
const CALL_SID_RE = /^CA[a-fA-F0-9]{32}$/;
const AUTHORITATIVE_SMIRK_PRODUCTION_ORIGIN = "https://ai-phone-agent-production-6811.up.railway.app";

const requestedBaseUrl = String(
  process.env.SMIRK_LIVE_BASE_URL
  || process.env.APP_URL
  || AUTHORITATIVE_SMIRK_PRODUCTION_ORIGIN,
).trim();
let parsedBaseUrl;
try {
  parsedBaseUrl = new URL(requestedBaseUrl);
} catch {
  throw new Error("The SMIRK reconciliation origin is invalid.");
}
if (parsedBaseUrl.protocol !== "https:"
  || parsedBaseUrl.origin !== AUTHORITATIVE_SMIRK_PRODUCTION_ORIGIN
  || !["", "/"].includes(parsedBaseUrl.pathname)
  || parsedBaseUrl.username
  || parsedBaseUrl.password
  || parsedBaseUrl.search
  || parsedBaseUrl.hash) {
  throw new Error(`Refusing to send proof-call authority anywhere except ${AUTHORITATIVE_SMIRK_PRODUCTION_ORIGIN}.`);
}
const baseUrl = AUTHORITATIVE_SMIRK_PRODUCTION_ORIGIN;

function readLocalEnvValue(key) {
  const files = [
    ".env.local",
    ".env",
    path.join(process.env.HOME || "", ".openclaw", "workspace", ".env.operator"),
    path.join(process.env.HOME || "", ".openclaw", "workspace", ".env.smirk"),
    path.join(process.env.HOME || "", ".openclaw", "workspace", ".env"),
  ];
  for (const file of files) {
    const candidate = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
    if (!fs.existsSync(candidate)) continue;
    for (const line of fs.readFileSync(candidate, "utf8").split(/\r?\n/)) {
      if (!line.startsWith(`${key}=`)) continue;
      return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return "";
}

function pickLiveFirst(...keys) {
  for (const key of keys) {
    const value = String(
      process.env[key]
      || readRailwayEnvValue(key, { quiet: true })
      || readLocalEnvValue(key)
      || "",
    ).trim();
    if (value) return value;
  }
  return "";
}

const secret = pickLiveFirst("DASHBOARD_API_KEY", "TEST_CALL_SECRET");
const workspaceId = String(process.env.SMIRK_PROOF_WORKSPACE_ID || process.argv[2] || "").trim();
const proofRequestId = String(process.env.SMIRK_PROOF_REQUEST_ID || process.argv[3] || "").trim();
const callSid = String(process.env.SMIRK_PROOF_CALL_SID || process.argv[4] || "").trim();
const confirmation = String(process.env.CONFIRM_SMIRK_PROOF_CALL_RECONCILIATION || "").trim();

if (!secret) throw new Error("DASHBOARD_API_KEY (or TEST_CALL_SECRET when no dashboard key exists) is required.");
if (!EXACT_POSITIVE_INTEGER_RE.test(workspaceId) || !EXACT_POSITIVE_INTEGER_RE.test(proofRequestId)) {
  throw new Error("Exact positive decimal SMIRK_PROOF_WORKSPACE_ID and SMIRK_PROOF_REQUEST_ID are required.");
}
if (!CALL_SID_RE.test(callSid)) throw new Error("SMIRK_PROOF_CALL_SID must be one exact Twilio CA call SID.");
if (confirmation !== "reconcile-one-smirk-proof-call") {
  throw new Error("Set CONFIRM_SMIRK_PROOF_CALL_RECONCILIATION=reconcile-one-smirk-proof-call after reviewing the exact workspace, request, and SID.");
}

const response = await fetch(`${baseUrl}/api/workspace/proof-call/reconcile`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": secret,
  },
  body: JSON.stringify({
    workspaceId: Number(workspaceId),
    proofRequestId: Number(proofRequestId),
    callSid,
    confirmation,
  }),
  signal: AbortSignal.timeout(30_000),
});
const payload = await response.json().catch(() => ({}));
if (!response.ok || payload?.ok !== true) {
  throw new Error(`Proof-call reconciliation failed (${response.status}): ${String(payload?.error || "unknown error")}`);
}
console.log(JSON.stringify({
  ok: true,
  workspaceId: payload.workspaceId,
  proofRequestId: payload.proofRequestId,
  callSid: payload.callSid,
  providerStatus: payload.providerStatus,
}, null, 2));
