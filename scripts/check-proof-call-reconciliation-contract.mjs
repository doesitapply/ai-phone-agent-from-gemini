#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const helperPath = "scripts/reconcile-real-proof-call.mjs";
const helper = fs.readFileSync(helperPath, "utf8");
const route = fs.readFileSync("src/routes/outbound-call-routes.ts", "utf8");
const schema = fs.readFileSync("src/saas.ts", "utf8");
const requestRoute = fs.readFileSync("src/routes/workspace-activation-routes.ts", "utf8");
const statusRoute = fs.readFileSync("src/routes/twilio-status-routes.ts", "utf8");
const server = fs.readFileSync("server.ts", "utf8");
const openapiGenerator = fs.readFileSync("scripts/generate-openapi.mjs", "utf8");

const requiredHelperNeedles = [
  'const AUTHORITATIVE_SMIRK_PRODUCTION_ORIGIN = "https://ai-phone-agent-production-6811.up.railway.app"',
  'pickLiveFirst("DASHBOARD_API_KEY", "TEST_CALL_SECRET")',
  '"x-api-key": secret',
  'confirmation !== "reconcile-one-smirk-proof-call"',
];
for (const needle of requiredHelperNeedles) {
  if (!helper.includes(needle)) throw new Error(`Reconciliation helper contract missing: ${needle}`);
}
if (helper.includes("x-test-call-secret")) throw new Error("Reconciliation helper uses a header the live middleware does not accept.");

const requiredRouteNeedles = [
  'app.post("/api/workspace/proof-call/reconcile", requireTestCallSecret, requireProofCallSchemaReady, callRateLimit',
  "claim.event_type IN ('proof_call_dispatch_claimed', 'proof_call_dispatched')",
  "claim.status IN ('open', 'outcome_unknown', 'in_progress')",
  "providerTimeMatchesClaim",
  "exactProofCallTargetMatchesDigest(providerTo, claim.proof_target_digest)",
  "reconciled_from_outcome_unknown",
];
for (const needle of requiredRouteNeedles) {
  if (!route.includes(needle)) throw new Error(`Reconciliation route contract missing: ${needle}`);
}
if (!schema.includes("idx_activation_events_workspace_active_proof_unique")) {
  throw new Error("Workspace-level active proof-attempt uniqueness fence is missing.");
}
if (!schema.includes("status IN ('open', 'outcome_unknown', 'in_progress')")) {
  throw new Error("Workspace proof fence does not retain dispatched calls while the provider call is active.");
}
if (!requestRoute.includes("active_or_uncertain_proof_call_claim")) {
  throw new Error("Customer proof-request route does not block on an active or uncertain workspace claim.");
}
if (!route.includes('requireTestCallSecret, requireProofCallSchemaReady, callRateLimit')) {
  throw new Error("Proof fulfillment/reconciliation does not fail closed until schema fences are ready.");
}
if (!server.includes("await initSaasSchema();")
  || !server.includes("await initSchema();")
  || !server.includes("await initComplianceSchema();")
  || server.indexOf("proofCallSchemaReady = true") < server.indexOf("await initComplianceSchema();")
  || !server.includes("catch (e: any) {\n          proofCallSchemaReady = false;")) {
  throw new Error("Server marks proof-call schema ready before all proof-critical schemas finish, or does not reset readiness on initialization failure.");
}
if (!statusRoute.includes("provider_terminal_status")
  || !statusRoute.includes("status IN ('outcome_unknown', 'in_progress')")) {
  throw new Error("Provider terminal callback does not release the active proof fence durably.");
}
if (!openapiGenerator.includes('"POST /api/workspace/proof-call/reconcile"')) {
  throw new Error("OpenAPI generator does not classify reconciliation as test-call-secret only.");
}

const wrongHost = spawnSync(process.execPath, [helperPath, "41", "501", `CA${"a".repeat(32)}`], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: {
    PATH: process.env.PATH || "",
    SMIRK_LIVE_BASE_URL: "https://attacker.invalid",
    DASHBOARD_API_KEY: "must-not-leave-process",
    CONFIRM_SMIRK_PROOF_CALL_RECONCILIATION: "reconcile-one-smirk-proof-call",
  },
});
if (wrongHost.status === 0 || !/Refusing to send proof-call authority anywhere except/.test(wrongHost.stderr)) {
  throw new Error(`Wrong-host reconciliation did not fail closed before fetch: ${wrongHost.stderr || wrongHost.stdout}`);
}

console.log("PASS proof-call reconciliation is exact-origin, exact-auth, provider-time-bound, and workspace-fenced");
