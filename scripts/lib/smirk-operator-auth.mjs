import fs from "node:fs";
import path from "node:path";
import { readRailwayEnvValue } from "../railway-json.mjs";

const SMIRK_OPERATOR_ORIGINS = new Set([
  "https://smirkcalls.com",
  "https://www.smirkcalls.com",
  "https://ai-phone-agent-production-6811.up.railway.app",
]);

export function exactSmirkOperatorOrigin(
  raw,
  { allowLoopback = false } = {}
) {
  const parsed = new URL(String(raw || "").trim());
  const isAllowlistedProduction = parsed.protocol === "https:" &&
    SMIRK_OPERATOR_ORIGINS.has(parsed.origin);
  const isExplicitLoopback = allowLoopback &&
    parsed.protocol === "http:" &&
    new Set(["127.0.0.1", "localhost", "::1"]).has(parsed.hostname);
  if (
    (!isAllowlistedProduction && !isExplicitLoopback) ||
    parsed.username ||
    parsed.password ||
    !["", "/"].includes(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("SMIRK_OPERATOR_ORIGIN_NOT_ALLOWLISTED");
  }
  return parsed.origin;
}

function readLocalEnvValue(key) {
  const files = [
    ".env.local",
    ".env",
    path.join(
      process.env.HOME || "",
      ".openclaw",
      "workspace",
      ".env.operator"
    ),
    path.join(
      process.env.HOME || "",
      ".openclaw",
      "workspace",
      ".env.smirk"
    ),
    path.join(process.env.HOME || "", ".openclaw", "workspace", ".env"),
  ];
  for (const file of files) {
    const absolute = path.isAbsolute(file)
      ? file
      : path.resolve(process.cwd(), file);
    if (!fs.existsSync(absolute)) continue;
    const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith(`${key}=`)) continue;
      return line
        .slice(key.length + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
    }
  }
  return "";
}

function localDashboardApiKeyCandidates() {
  return [
    ["process env", String(process.env.DASHBOARD_API_KEY || "").trim()],
    ["local env file", readLocalEnvValue("DASHBOARD_API_KEY")],
  ]
    .map(([source, value]) => ({ source, value: String(value || "").trim() }))
    .filter((candidate) => candidate.value);
}

async function fetchOperatorSession(origin, apiKey) {
  try {
    const response = await fetch(`${origin}/api/operator/session`, {
      headers: {
        "x-api-key": apiKey,
        accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const announcedLength = Number(response.headers.get("content-length") || 0);
    if (announcedLength > 64 * 1024) {
      return { ok: false, status: response.status, error: "response-too-large" };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 64 * 1024) {
      return { ok: false, status: response.status, error: "response-too-large" };
    }
    let body = null;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      body = null;
    }
    return {
      ok: response.ok && body?.ok === true && body?.role === "operator",
      status: response.status,
      error: body?.code || body?.error || null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.name : "operator-session-failed",
    };
  }
}

export async function firstWorkingSmirkOperatorAuth({
  appUrl,
  allowLoopback = false,
}) {
  const origin = exactSmirkOperatorOrigin(appUrl, { allowLoopback });
  const failures = [];
  const tryCandidate = async (candidate) => {
    const session = await fetchOperatorSession(origin, candidate.value);
    if (session.ok) {
      return {
        ok: true,
        origin,
        source: candidate.source,
        apiKey: candidate.value,
        failures,
      };
    }
    failures.push({
      source: candidate.source,
      status: session.status,
      error: session.error,
    });
    return null;
  };
  for (const candidate of localDashboardApiKeyCandidates()) {
    const accepted = await tryCandidate(candidate);
    if (accepted) return accepted;
  }
  const railwayValue = SMIRK_OPERATOR_ORIGINS.has(origin)
    ? String(
        readRailwayEnvValue("DASHBOARD_API_KEY", { quiet: true }) || ""
      ).trim()
    : "";
  if (railwayValue) {
    const accepted = await tryCandidate({
      source: "railway variables",
      value: railwayValue,
    });
    if (accepted) return accepted;
  }
  return {
    ok: false,
    origin,
    source: null,
    apiKey: "",
    failures,
  };
}
