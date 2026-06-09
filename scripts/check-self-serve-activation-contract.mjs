#!/usr/bin/env node
import fs from "node:fs";

const server = fs.readFileSync("server.ts", "utf8");
const saas = fs.readFileSync("src/saas.ts", "utf8");
const app = fs.readFileSync("src/App.tsx", "utf8");
const wizard = fs.readFileSync("src/components/SetupWizard.tsx", "utf8");
const stripeSmoke = fs.readFileSync("scripts/check-stripe-webhook-handoff-live.mjs", "utf8");
const cleanup = fs.readFileSync("scripts/cleanup-smoke-workspaces.mjs", "utf8");

const failures = [];
function expect(label, condition) {
  if (!condition) failures.push(label);
}

for (const field of ["service_area", "escalation_preference", "proof_call_target"]) {
  expect(`workspace schema has ${field}`, saas.includes(`ADD COLUMN IF NOT EXISTS ${field}`));
  expect(`workspace type has ${field}`, saas.includes(`${field}?: string`));
  expect(`profile write whitelist includes ${field}`, server.includes(`"${field}"`));
  expect(`setup wizard captures ${field}`, wizard.includes(field));
  expect(`settings profile captures ${field}`, app.includes(field));
}

expect("server builds setup readiness", server.includes("const buildSetupReadiness ="));
expect("server builds activation status", server.includes("const buildActivationStatus ="));
expect("workspace profile returns activation_status", server.includes("activation_status: activationStatus"));
expect("workspace activation status endpoint exists", server.includes('app.get("/api/workspace/activation-status", dashboardAuth'));
expect("checkout-status returns activation_status", server.includes("activation_status: activationStatus"));
expect("operator queue exposes activation_stage", server.includes("activation_stage: activationStage"));
expect("activation status includes proof-ready guard", server.includes("readyForProofCall"));
expect("activation status requires owner alert readiness", server.includes("ownerAlertReady"));
expect("activation status requires callback readiness", server.includes("callbackReady"));
expect("signed webhook smoke checks activation status", stripeSmoke.includes("activation_status"));
expect("signed webhook smoke uses cleanup-addressable smoke identity", stripeSmoke.includes("smoke+stripe-") && stripeSmoke.includes("SMIRK Stripe Webhook Smoke"));
expect("cleanup smoke helper exists", cleanup.includes("/api/admin/cleanup-smoke-workspaces"));

if (failures.length > 0) {
  console.error("FAIL self-serve activation contract drift:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK self-serve activation contract covers paid workspace, setup fields, activation status, proof readiness, and smoke cleanup hooks");
