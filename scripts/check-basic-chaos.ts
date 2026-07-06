#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const useStripeSmokeWorkspace = String(process.env.SMIRK_BASIC_CHAOS_FROM_STRIPE_SMOKE || "").trim() === "1";
const cleanupConfirm = String(process.env.CONFIRM_SMIRK_BASIC_CHAOS_CLEANUP || "").trim();
const concurrency = Math.max(1, Math.min(40, Number(process.env.SMIRK_BASIC_CHAOS_CONCURRENCY || 12)));
const startupSettleMs = Math.max(0, Number(process.env.SMIRK_BASIC_CHAOS_STARTUP_SETTLE_MS || 5000));
const readinessTimeoutMs = Math.max(1000, Number(process.env.SMIRK_BASIC_CHAOS_READINESS_TIMEOUT_MS || 30000));
const artifactPath = path.resolve(process.env.SMIRK_BASIC_CHAOS_ARTIFACT || "output/basic-chaos-last.json");
const stripeSmokeArtifactPath = path.resolve(process.env.SMIRK_STRIPE_SMOKE_ARTIFACT || "output/stripe-webhook-handoff-live.json");
const stripeSmokeApprovalPhrase =
  "APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE: ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live";

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

function readJsonFile(file: string): any {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function resolveStripeSmokeWorkspace(): Promise<BasicIdentity> {
  if (!operatorKey) {
    throw new Error("SMIRK_BASIC_CHAOS_FROM_STRIPE_SMOKE=1 requires DASHBOARD_API_KEY or SMIRK_OPERATOR_API_KEY.");
  }

  const artifact = readJsonFile(stripeSmokeArtifactPath);
  if (artifact?.ok !== true || artifact?.webhook?.received !== true || artifact?.checkoutStatus?.found !== true) {
    throw new Error(
      `No approved Stripe smoke artifact is ready at ${stripeSmokeArtifactPath}. ` +
      `Run only after explicit approval: ${stripeSmokeApprovalPhrase}`
    );
  }

  const smokeOwnerEmail = String(artifact.webhook?.owner_email || artifact.ownerEmail || "").trim().toLowerCase();
  if (!smokeOwnerEmail) {
    throw new Error(
      "Stripe smoke artifact does not expose the smoke owner email for operator-side Basic chaos resolution. " +
      "Rerun npm run check:stripe-webhook-handoff-live after this commit, then rerun check:basic-chaos."
    );
  }

  const requests = await requestJson("/provisioning/requests?limit=100", { headers: operatorHeaders() });
  if (requests.status !== 200 || !Array.isArray(requests.body?.requests)) {
    throw new Error(`Could not read operator provisioning requests. HTTP ${requests.status}: ${JSON.stringify(requests.body)}`);
  }

  const request = requests.body.requests.find((row: any) => (
    String(row?.owner_email || "").trim().toLowerCase() === smokeOwnerEmail &&
    String(row?.requested_plan || "").trim().toLowerCase() === "starter" &&
    String(row?.source || "").includes("stripe") &&
    row?.workspace_id
  ));
  if (!request?.workspace_id) {
    throw new Error(
      `Could not find a Stripe-created Starter workspace for ${smokeOwnerEmail}. ` +
      "The Stripe smoke may not have auto-fulfilled yet, or smoke cleanup may already have removed it."
    );
  }

  const apiKey = await requestJson(`/workspaces/${encodeURIComponent(String(request.workspace_id))}/apikey`, {
    headers: operatorHeaders(),
  });
  if (apiKey.status !== 200 || !apiKey.body?.api_key) {
    throw new Error(`Could not read API key for Stripe smoke workspace ${request.workspace_id}. HTTP ${apiKey.status}: ${JSON.stringify(apiKey.body)}`);
  }

  return {
    workspaceId: String(request.workspace_id),
    token: String(apiKey.body.api_key),
    provisioned: false,
  };
}

async function resolveBasicIdentity(): Promise<BasicIdentity> {
  if (existingWorkspaceId && existingToken) {
    return { workspaceId: existingWorkspaceId, token: existingToken, provisioned: false };
  }
  if (useStripeSmokeWorkspace) {
    return resolveStripeSmokeWorkspace();
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

async function waitForBasicSurface(identity: BasicIdentity): Promise<void> {
  const deadline = Date.now() + readinessTimeoutMs;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const results = await Promise.all(allowedBasicEndpoints.map((path) =>
        requestJson(path, { headers: basicHeaders(identity) }).then((result) => ({ path, ...result }))
      ));
      const notReady = results.find((result) => result.status !== 200);
      if (!notReady) return;
      lastError = `${notReady.path} returned HTTP ${notReady.status}: ${JSON.stringify(notReady.body)}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(500);
  }

  throw new Error(`Basic surface did not become ready within ${readinessTimeoutMs}ms. Last error: ${lastError || "unknown"}`);
}

async function runChaos(identity: BasicIdentity) {
  await verifyIdentityIsBasic(identity);
  await waitForBasicSurface(identity);

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
  if (startupSettleMs > 0) await sleep(startupSettleMs);
  const identity = await resolveBasicIdentity();
  const chaos = await runChaos(identity);
  const cleanedUp = await cleanupIfApproved(identity);

  const payload = {
    ok: true,
    checkedAt: new Date().toISOString(),
    gitCommit: readGitCommit(),
    appUrl,
    workspaceId: identity.workspaceId,
    identitySource: useStripeSmokeWorkspace
      ? "stripe-smoke-workspace"
      : identity.provisioned
        ? "operator-temp-workspace"
        : "provided-basic-workspace",
    stripeSmokeArtifactPath: useStripeSmokeWorkspace ? stripeSmokeArtifactPath : undefined,
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
