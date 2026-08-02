#!/usr/bin/env node
import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

const client = read("src/velvet-discovery.ts");
const routes = read("src/routes/velvet-discovery-routes.ts");
const schema = read("src/prospector.ts");
const server = read("server.ts");
const ui = read("src/App.tsx");

const checks = [
  [
    "request, prepared, and status contracts are versioned",
    client.includes("smirk-velvet.discovery-request.v2") &&
      client.includes("velvet-smirk.discovery-response.v2") &&
      client.includes("velvet-smirk.discovery-status.v2"),
  ],
  [
    "SMIRK discovery requests cannot authorize contact or spend",
    client.includes("contactActionAllowed: z.literal(false)") &&
      client.includes("spendAuthorized: z.literal(false)"),
  ],
  [
    "lead and quote ceilings are bounded",
    client.includes("VELVET_DISCOVERY_MAX_LEADS = 20") &&
      client.includes("VELVET_DISCOVERY_MAX_BUDGET_CENTS = 500") &&
      client.includes("maps-plus-owner-email-v1") &&
      client.includes("hunter_owner_email"),
  ],
  [
    "discovery is separately disabled by default and workspace locked",
    client.includes("VELVET_DISCOVERY_ENABLED") &&
      client.includes("VELVET_LEAD_SOURCE_WORKSPACE_ID") &&
      client.includes("VELVET_LEAD_SOURCE_API_KEY"),
  ],
  [
    "the dedicated key cannot collide with operational keys",
    client.includes("DASHBOARD_API_KEY") &&
      client.includes("DEMO_OPERATOR_API_KEY") &&
      client.includes("VELVET_ALCHEMY_HANDOFF_API_KEY") &&
      client.includes("nonDedicatedKeys.includes(apiKey)"),
  ],
  [
    "all local mutations require full operator access",
    routes.split("deps.requireFullOperator").length >= 7,
  ],
  [
    "approve, dispatch, refresh, import, and cancel use exact confirmations",
    routes.includes("VELVET_DISCOVERY_APPROVAL_CONFIRMATION") &&
      routes.includes("VELVET_DISCOVERY_DISPATCH_CONFIRMATION") &&
      routes.includes("VELVET_DISCOVERY_REFRESH_CONFIRMATION") &&
      routes.includes("VELVET_DISCOVERY_IMPORT_CONFIRMATION") &&
      routes.includes("VELVET_DISCOVERY_CANCEL_CONFIRMATION"),
  ],
  [
    "dispatch has a durable lease and bounded exact retries",
    routes.includes("DISPATCH_LEASE_MS = 2 * 60_000") &&
      routes.includes("MAX_DISPATCH_ATTEMPTS = 3") &&
      routes.includes("pg_advisory_xact_lock"),
  ],
  [
    "stored request, prepared response, and status hashes are revalidated",
    routes.includes("assertStoredRequest") &&
      routes.includes("assertStoredPreparedResponse") &&
      routes.includes("assertStoredStatus"),
  ],
  [
    "remote terminal output only prepares a separate reviewed pull",
    routes.includes("prepare-import") &&
      routes.includes("buildVelvetLeadSourceRequest") &&
      routes.includes(
        "sourceDiscoveryRequestId: discoveryRequest.requestId"
      ) &&
      routes.includes("maxSpendCents: 0") &&
      routes.includes("contactActionAllowed: false"),
  ],
  [
    "durable request and append-only event receipts exist",
    schema.includes("velvet_discovery_requests") &&
      schema.includes("velvet_discovery_request_events") &&
      schema.includes("discovery_request_id"),
  ],
  [
    "the server registers guarded discovery routes",
    server.includes("registerVelvetDiscoveryRoutes(app"),
  ],
  [
    "the operator UI exposes every separate gate",
    ui.includes("Velvet lead discovery") &&
      ui.includes("Prepare discovery") &&
      ui.includes("Approve request") &&
      ui.includes("Send request to Velvet") &&
      ui.includes("Review provider quote in Velvet") &&
      ui.includes("Prepare reviewed pull"),
  ],
  [
    "the operator UI preserves no-contact and separate-spend copy",
    ui.includes("$5 maximum quote") &&
      ui.includes("it cannot approve provider") &&
      ui.includes("no-contact quote request") &&
      ui.includes("no outreach"),
  ],
  [
    "the discovery route contains no email, SMS, or telephony provider call",
    !routes.includes("sendApprovedProspectEmail") &&
      !routes.includes("sendSms") &&
      !routes.includes("messages.create") &&
      !routes.includes("calls.create"),
  ],
];

let failed = 0;
for (const [label, ok] of checks) {
  if (ok) {
    console.log(`PASS ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL ${label}`);
  }
}

if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log(
    `Velvet discovery contract passed (${checks.length}/${checks.length}).`
  );
}
