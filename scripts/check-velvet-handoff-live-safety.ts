#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  VELVET_HANDOFF_SYNTHETIC_MODE,
  buildVelvetHandoffLiveSafetyReport,
} from "../src/velvet-handoff-live-safety.js";
import { railwayVariables } from "./railway-json.mjs";

const SMIRK_PRODUCTION_ORIGINS = new Set([
  "https://smirkcalls.com",
  "https://www.smirkcalls.com",
  "https://ai-phone-agent-production-6811.up.railway.app",
]);
const VELVET_PRODUCTION_ORIGIN =
  "https://velvetalchemy.manus.space";
const MAX_HEALTH_BYTES = 64 * 1024;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_ASSET_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_ASSET_COUNT = 20;
const FETCH_TIMEOUT_MS = 15_000;

function trustedOrigin(
  raw: string,
  allowed: Set<string>,
  label: string
): string {
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !["", "/"].includes(parsed.pathname) ||
    parsed.search ||
    parsed.hash ||
    !allowed.has(parsed.origin)
  ) {
    throw new Error(`${label}_ORIGIN_NOT_ALLOWLISTED`);
  }
  return parsed.origin;
}

async function fetchBoundedText(
  url: string,
  maximumBytes: number,
  acceptedContentTypes: string[]
): Promise<{
  text: string;
  status: number;
  contentType: string;
  readinessHeader: string | null;
  versionHeader: string | null;
}> {
  const response = await fetch(url, {
    headers: { Accept: acceptedContentTypes.join(", ") },
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  if (
    acceptedContentTypes.length > 0 &&
    !acceptedContentTypes.some(type => contentType.includes(type))
  ) {
    throw new Error("UNEXPECTED_CONTENT_TYPE");
  }
  const announcedLength = Number(
    response.headers.get("content-length") || "0"
  );
  if (announcedLength > maximumBytes) {
    throw new Error("RESPONSE_TOO_LARGE");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new Error("RESPONSE_TOO_LARGE");
  }
  return {
    text: new TextDecoder().decode(bytes),
    status: response.status,
    contentType,
    readinessHeader: response.headers.get("x-smirk-readiness") || null,
    versionHeader: response.headers.get("x-smirk-version") || null,
  };
}

function readGitSource(commit: string | null): string | null {
  if (!commit || !/^[a-f0-9]{40}$/i.test(commit)) return null;
  try {
    const domain = execFileSync(
      "git",
      ["show", `${commit}:src/velvet-handoff.ts`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const route = execFileSync(
      "git",
      ["show", `${commit}:src/routes/velvet-handoff-routes.ts`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return `${domain}\n${route}`;
  } catch {
    return null;
  }
}

function extractSameOriginJavascriptAssets(
  html: string,
  origin: string
): string[] {
  const candidates = new Set<string>();
  const attributePattern = /\b(?:src|href)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(attributePattern)) {
    try {
      const candidate = new URL(match[1], origin);
      if (
        candidate.origin === origin &&
        candidate.pathname.endsWith(".js") &&
        !candidate.username &&
        !candidate.password
      ) {
        candidates.add(candidate.href);
      }
    } catch {
      // Ignore malformed document attributes; missing proof fails below.
    }
  }
  return [...candidates].slice(0, MAX_ASSET_COUNT);
}

function secretIsSeparated(
  handoffKey: string,
  env: Record<string, string | undefined>
): boolean {
  if (!handoffKey) return true;
  return [
    env.DASHBOARD_API_KEY,
    env.DEMO_OPERATOR_API_KEY,
    env.VELVET_ALCHEMY_RESEARCH_API_KEY,
  ]
    .map(value => String(value || "").trim())
    .filter(Boolean)
    .every(value => value !== handoffKey);
}

async function main() {
  const inspectionErrors: string[] = [];
  let railwayVariablesRead = false;
  let env: Record<string, string | undefined> = {};
  try {
    env = railwayVariables({
      quiet: true,
      attempts: 2,
      delayMs: 1_000,
    });
    railwayVariablesRead = true;
  } catch {
    inspectionErrors.push("RAILWAY_PRODUCTION_VARIABLES_UNAVAILABLE");
  }

  const requestedSmirkOrigin = String(
    process.env.SMIRK_HANDOFF_SAFETY_APP_URL ||
      env.APP_URL ||
      "https://smirkcalls.com"
  ).trim();
  const smirkOrigin = trustedOrigin(
    requestedSmirkOrigin,
    SMIRK_PRODUCTION_ORIGINS,
    "SMIRK"
  );
  const velvetOrigin = trustedOrigin(
    process.env.VELVET_HANDOFF_SAFETY_APP_URL ||
      VELVET_PRODUCTION_ORIGIN,
    new Set([VELVET_PRODUCTION_ORIGIN]),
    "VELVET"
  );

  let requestsPerformed = 0;
  let liveSmirkCommit: string | null = null;
  let liveSmirkStatus: number | null = null;
  let liveSmirkReadiness: string | null = null;
  try {
    requestsPerformed += 1;
    const health = await fetchBoundedText(
      `${smirkOrigin}/health`,
      MAX_HEALTH_BYTES,
      ["application/json"]
    );
    liveSmirkStatus = health.status;
    liveSmirkReadiness = health.readinessHeader;
    if (health.readinessHeader !== "1") {
      throw new Error("READINESS_HEADER_MISSING");
    }
    const parsed = JSON.parse(health.text) as {
      version?: unknown;
    };
    const bodyVersion =
      typeof parsed.version === "string" ? parsed.version : null;
    if (
      bodyVersion &&
      health.versionHeader &&
      bodyVersion !== health.versionHeader
    ) {
      throw new Error("VERSION_HEADER_BODY_MISMATCH");
    }
    liveSmirkCommit = bodyVersion || health.versionHeader;
    if (!liveSmirkCommit) {
      inspectionErrors.push("LIVE_SMIRK_FINGERPRINT_MISSING");
    }
  } catch (error) {
    inspectionErrors.push(
      `LIVE_SMIRK_HEALTH_${error instanceof Error ? error.message : "FAILED"}`
    );
  }

  let velvetBundleRead = false;
  let velvetBundleSource: string | null = null;
  let velvetAssetCount = 0;
  let velvetAssetBytes = 0;
  try {
    requestsPerformed += 1;
    const document = await fetchBoundedText(
      velvetOrigin,
      MAX_HTML_BYTES,
      ["text/html"]
    );
    const assets = extractSameOriginJavascriptAssets(
      document.text,
      velvetOrigin
    );
    if (assets.length === 0) throw new Error("JAVASCRIPT_ASSET_MISSING");
    const sources = [document.text];
    for (const asset of assets) {
      requestsPerformed += 1;
      const fetched = await fetchBoundedText(
        asset,
        MAX_ASSET_BYTES,
        ["application/javascript", "text/javascript"]
      );
      velvetAssetBytes += Buffer.byteLength(fetched.text);
      if (velvetAssetBytes > MAX_TOTAL_ASSET_BYTES) {
        throw new Error("TOTAL_ASSET_BYTES_EXCEEDED");
      }
      sources.push(fetched.text);
      velvetAssetCount += 1;
    }
    velvetBundleSource = sources.join("\n");
    velvetBundleRead = true;
  } catch (error) {
    inspectionErrors.push(
      `LIVE_VELVET_BUNDLE_${error instanceof Error ? error.message : "FAILED"}`
    );
  }

  const localTargetCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const handoffApiKey = String(
    env.VELVET_ALCHEMY_HANDOFF_API_KEY || ""
  ).trim();
  const report = buildVelvetHandoffLiveSafetyReport({
    localTargetCommit,
    localTargetSource: readGitSource(localTargetCommit),
    liveSmirkCommit,
    liveSmirkSource: readGitSource(liveSmirkCommit),
    railwayVariablesRead,
    handoffApiKeyConfigured: Boolean(handoffApiKey),
    handoffApiKeyStrong: handoffApiKey.length >= 32,
    handoffMode:
      String(env.VELVET_ALCHEMY_HANDOFF_MODE || "").trim() || null,
    handoffWorkspaceConfigured: /^[1-9]\d*$/.test(
      String(env.VELVET_ALCHEMY_WORKSPACE_ID || "").trim()
    ),
    handoffCredentialSeparated: secretIsSeparated(handoffApiKey, env),
    velvetBundleRead,
    velvetBundleSource,
    requestsPerformed,
  });

  const output = {
    ...report,
    inspection: {
      smirkOrigin,
      smirkHealthStatus: liveSmirkStatus,
      smirkReadinessHeader: liveSmirkReadiness,
      velvetOrigin,
      velvetAssetCount,
      velvetAssetBytes,
      errors: inspectionErrors,
      expectedSyntheticMode: VELVET_HANDOFF_SYNTHETIC_MODE,
    },
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.ok) process.exitCode = 1;
}

main().catch(error => {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: false,
        code: "VELVET_HANDOFF_LIVE_SAFETY_INSPECTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        guardrails: {
          contactAuthorized: false,
          spendAuthorized: false,
          providerMutationPerformed: false,
          productionWritePerformed: false,
          credentialsExposed: false,
        },
        externalAction: "none",
      },
      null,
      2
    )}\n`
  );
  process.exitCode = 1;
});
