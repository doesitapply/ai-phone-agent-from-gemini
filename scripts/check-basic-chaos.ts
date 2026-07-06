#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type JsonResult = {
  status: number;
  body: any;
};

type BasicIdentity = {
  workspaceId: string;
  token: string;
  provisioned: boolean;
  cleanupCommand?: string;
};

const rawAppUrl = String(process.env.APP_URL || process.env.SMIRK_TEST_URL || "http://127.0.0.1:3000").trim();
const appUrl = rawAppUrl.replace(/\/+$/, "").replace(/\/api$/, "");
const apiBaseUrl = `${appUrl}/api`;
const existingWorkspaceId = String(process.env.SMIRK_BASIC_CHAOS_WORKSPACE_ID || "").trim();
const existingToken = String(process.env.SMIRK_BASIC_CHAOS_TOKEN || "").trim();
const operatorKey = String(process.env.DASHBOARD_API_KEY || process.env.SMIRK_OPERATOR_API_KEY || "").trim();
const allowProvision = String(process.env.ALLOW_SMIRK_BASIC_CHAOS_PROVISION || "").trim() === "1";
const cleanupConfirm = String(process.env.CONFIRM_SMIRK_BASIC_CHAOS_CLEANUP || "").trim();
const concurrency = Math.max(1, Math.min(40, Number(process.env.SMIRK_BASIC_CHAOS_CONCURRENCY || 12)));
const artifactPath = path.resolve(process.env.SMIRK_BASIC_CHAOS_ARTIFACT || "output/basic-chaos-last.json");

const allowedBasicEndpoints = ["/calls", "/contacts", "/tasks"];
const restrictedProEndpoints = [
  "/stats",
  "/call-intelligence",
  "/triage",
  "/handoffs",
  "/recovery",
  "/appointments",
  "/calendar/events",
  "/workspace-overview",
];

function basicHeaders(identity: BasicIdentity): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Workspace-Id": identity.workspaceId,
    Authorization: `Bearer ${identity.token}`,
  };
}

function operatorHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Api-Key": operatorKey,
  };
}

async function requestJson(path: string, init: RequestInit = {}): Promise<JsonResult> {
  const res = await fetch(`${apiBaseUrl}${path}`, init);
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, body };
}

async function provisionBasicWorkspace(): Promise<BasicIdentity> {
  if (!allowProvision) {
    throw new Error(
      "Set SMIRK_BASIC_CHAOS_WORKSPACE_ID and SMIRK_BASIC_CHAOS_TOKEN, or set " +
      "ALLOW_SMIRK_BASIC_CHAOS_PROVISION=1 with DASHBOARD_API_KEY/SMIRK_OPERATOR_API_KEY to create a temporary Starter workspace."
    );
  }
  if (!operatorKey) {
    throw new Error("ALLOW_SMIRK_BASIC_CHAOS_PROVISION=1 requires DASHBOARD_API_KEY or SMIRK_OPERATOR_API_KEY.");
  }

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const create = await requestJson("/workspaces", {
    method: "POST",
    headers: operatorHeaders(),
    body: JSON.stringify({
      name: `SMIRK Basic Chaos ${suffix}`,
      owner_email: `basic-chaos-${suffix}@example.local`,
      plan: "starter",
      mode: "missed_call_recovery",
    }),
  });
  if (create.status < 200 || create.status >= 300) {
    throw new Error(`Temporary Basic workspace provisioning failed with HTTP ${create.status}: ${JSON.stringify(create.body)}`);
  }

  const workspace = create.body?.workspace;
  if (!workspace?.id || !workspace?.api_key) {
    throw new Error(`Workspace provisioning did not return id and api_key: ${JSON.stringify(create.body)}`);
  }

  return {
    workspaceId: String(workspace.id),
    token: String(workspace.api_key),
    provisioned: true,
    cleanupCommand: `APP_URL=${appUrl} DASHBOARD_API_KEY=<operator-key> CONFIRM_SMIRK_BASIC_CHAOS_CLEANUP=delete-temp-basic-workspace SMIRK_BASIC_CHAOS_WORKSPACE_ID=${workspace.id} SMIRK_BASIC_CHAOS_TOKEN=<redacted> npm run -s check:basic-chaos`,
  };
}

async function resolveBasicIdentity(): Promise<BasicIdentity> {
  if (existingWorkspaceId && existingToken) {
    return { workspaceId: existingWorkspaceId, token: existingToken, provisioned: false };
  }
  return provisionBasicWorkspace();
}

function assertNoProLeak(path: string, body: any): void {
  const serialized = JSON.stringify(body || {});
  const leaked = [
    "proofFreshness",
    "setupReadiness",
    "prospectTotalLeads",
    "avgAiLatencyMs",
    "pendingHandoffs",
    "ownerEmailAlertsSent",
    "completeProofCalls",
  ].filter((field) => serialized.includes(field));
  if (leaked.length > 0) {
    throw new Error(`${path} leaked Pro-suite fields for a Basic token: ${leaked.join(", ")}`);
  }
}

function readGitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function writeArtifact(payload: Record<string, unknown>): void {
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function verifyIdentityIsBasic(identity: BasicIdentity): Promise<void> {
  const result = await requestJson("/workspaces", { headers: basicHeaders(identity) });
  if (result.status !== 200) {
    throw new Error(`Basic workspace identity check failed with HTTP ${result.status}: ${JSON.stringify(result.body)}`);
  }
  const workspace = Array.isArray(result.body?.workspaces) ? result.body.workspaces[0] : null;
  const plan = String(workspace?.plan || "").toLowerCase();
  if (!["starter", "basic", "free"].includes(plan)) {
    throw new Error(`Chaos identity is not Basic/Starter. Workspace plan was ${plan || "(missing)"}.`);
  }
}

async function runChaos(identity: BasicIdentity) {
  await verifyIdentityIsBasic(identity);

  const allowedResults = await Promise.all(allowedBasicEndpoints.flatMap((path) =>
    Array.from({ length: concurrency }, () => requestJson(path, { headers: basicHeaders(identity) }).then((result) => ({ path, ...result })))
  ));

  for (const result of allowedResults) {
    if (result.status !== 200) {
      throw new Error(`${result.path} should be available to Basic, got HTTP ${result.status}: ${JSON.stringify(result.body)}`);
    }
    assertNoProLeak(result.path, result.body);
  }

  const restrictedResults = await Promise.all(restrictedProEndpoints.flatMap((path) =>
    Array.from({ length: concurrency }, () => requestJson(path, { headers: basicHeaders(identity) }).then((result) => ({ path, ...result })))
  ));

  for (const result of restrictedResults) {
    if (result.status !== 403 || result.body?.code !== "PRO_SUITE_REQUIRED") {
      throw new Error(`${result.path} should return PRO_SUITE_REQUIRED for Basic, got HTTP ${result.status}: ${JSON.stringify(result.body)}`);
    }
  }

  return {
    allowedRequests: allowedResults.length,
    restrictedRequests: restrictedResults.length,
  };
}

async function cleanupIfApproved(identity: BasicIdentity): Promise<boolean> {
  if (!identity.provisioned) return false;
  if (cleanupConfirm !== "delete-temp-basic-workspace") return false;
  if (!operatorKey) throw new Error("Cleanup requested but no operator key is configured.");
  const result = await requestJson(`/workspaces/${encodeURIComponent(identity.workspaceId)}`, {
    method: "DELETE",
    headers: operatorHeaders(),
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Temporary Basic workspace cleanup failed with HTTP ${result.status}: ${JSON.stringify(result.body)}`);
  }
  return true;
}

async function main() {
  const identity = await resolveBasicIdentity();
  const chaos = await runChaos(identity);
  const cleanedUp = await cleanupIfApproved(identity);

  const payload = {
    ok: true,
    checkedAt: new Date().toISOString(),
    gitCommit: readGitCommit(),
    appUrl,
    workspaceId: identity.workspaceId,
    provisioned: identity.provisioned,
    cleanedUp,
    concurrency,
    ...chaos,
    code: "BASIC_CHAOS_PASSED",
    cleanupRequired: identity.provisioned && !cleanedUp,
    cleanupCommand: identity.provisioned && !cleanedUp ? identity.cleanupCommand : undefined,
    artifactPath,
  };
  writeArtifact(payload);
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
