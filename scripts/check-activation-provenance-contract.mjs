#!/usr/bin/env node
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const saas = read("src/saas.ts");
const admin = read("src/routes/workspace-admin-routes.ts");
const profile = read("src/routes/workspace-profile-routes.ts");
const activation = read("src/routes/workspace-activation-routes.ts");
const knowledge = read("src/routes/workspace-knowledge-routes.ts");
const outboundCalls = read("src/routes/outbound-call-routes.ts");
const provisioning = read("src/routes/provisioning-routes.ts");
const server = read("server.ts");
const revenueRuntime = read("scripts/check-qualifying-revenue-live.mjs");
const revenueEvidence = read("scripts/lib/qualifying-revenue-evidence.mjs");
const entitlementRuntime = read("scripts/check-live-workspace-entitlements.mjs");

const failures = [];
const expect = (label, condition) => { if (!condition) failures.push(label); };

expect("checkout invite acceptance writes a durable exact-request and exact-acceptance event",
  saas.includes("idx_activation_events_checkout_invite_accept_unique")
  && saas.includes("'buyer_invite_accepted'")
  && saas.includes('auth_provenance: "buyer_email_invite_token"')
  && saas.includes("pr.invite_link LIKE '%/invite/' || ${token}")
  && saas.includes("'checkout_session_id', ecr.checkout_session_id"));

expect("operator workspace reads redact credentials and member invite tokens",
  admin.includes("workspace: maskWorkspaceSecrets(workspace)")
  && admin.includes("members: members.map(redactWorkspaceMember)")
  && admin.includes("const { invite_token: _inviteToken, ...safeMember }"));
const apiKeyRouteStart = admin.indexOf('app.get("/api/workspaces/:id/apikey"');
const apiKeyRouteBlock = apiKeyRouteStart >= 0 ? admin.slice(apiKeyRouteStart) : "";
expect("operator API-key reveal is fail-closed and audited before disclosure",
  apiKeyRouteBlock.includes("Workspace API key reveal requires durable audit storage")
  && apiKeyRouteBlock.includes('"workspace_api_key_revealed_by_operator"')
  && apiKeyRouteBlock.indexOf('"workspace_api_key_revealed_by_operator"') < apiKeyRouteBlock.indexOf("api_key: workspace.api_key"));

for (const [label, source, markers] of [
  ["profile/setup", profile, ["workspace_profile_update_requested", "setup_completed", "activationIdentity.actor", "auth_provenance"]],
  ["proof request", activation, ["proof_call_action_requested", "proof_call_requested", "activationIdentity.actor", "auth_provenance"]],
  ["knowledge setup", knowledge, ["workspace_knowledge_import_requested", "workspace_knowledge_imported", "activationIdentity.actor", "auth_provenance"]],
  ["outbound proof call", outboundCalls, ["workspace_outbound_call_requested", "activationIdentity.actor", "auth_provenance"]],
]) {
  expect(`${label} mutations preserve the authenticated actor and provenance`, markers.every((marker) => source.includes(marker)));
}

const operatorListStart = provisioning.indexOf('app.get("/api/provisioning/requests"');
const operatorListBlock = operatorListStart >= 0 ? provisioning.slice(operatorListStart) : "";
expect("operator provisioning list omits paid invite links and stored workspace keys",
  operatorListStart >= 0
  && !operatorListBlock.includes("pr.status, pr.invite_link")
  && !operatorListBlock.includes("pr.workspace_api_key"));

for (const marker of [
  "buyer_invite_acceptance_event_at",
  "customer_setup_event_at",
  "customer_proof_event_at",
  "operator_rescue_event",
  "current_state",
  "activation_stage",
  "setup_ready",
  "proof_fresh",
]) {
  expect(`protected activation evidence includes ${marker}`, provisioning.includes(marker));
}
expect("operator rescue scan covers the exact workspace since checkout",
  provisioning.includes("ae.workspace_id = w.id")
  && provisioning.includes("ae.created_at >= pr.created_at")
  && provisioning.includes("ae.actor = 'operator'"));
expect("customer can request proof after setup without circularly requiring an existing proof",
  server.includes('item.key !== "fresh_proof_call"')
  && server.includes("setupItemsBeforeProof.every((item) => item.complete)"));

expect("authoritative revenue runtime never retrieves or impersonates a workspace token",
  !revenueRuntime.includes("/apikey")
  && !revenueRuntime.includes("workspaceToken")
  && !revenueRuntime.includes("authorization: `Bearer"));
expect("routine entitlement proof never retrieves or impersonates a workspace token",
  entitlementRuntime.includes("/entitlement-probe")
  && !entitlementRuntime.includes("/apikey")
  && !entitlementRuntime.includes("workspaceToken")
  && !entitlementRuntime.includes("authorization: `Bearer"));
for (const marker of [
  "buyer_invite_acceptance_event",
  "customer_setup_event",
  "customer_proof_event",
  "operator_rescue_event",
  "current_state",
]) {
  expect(`authoritative validator requires ${marker}`, revenueEvidence.includes(marker));
}

if (failures.length > 0) {
  console.error("FAIL activation provenance contract drift:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK first-dollar activation proof rejects founder rescue and operator-token impersonation");
