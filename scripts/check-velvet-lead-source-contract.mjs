#!/usr/bin/env node
import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

const client = read("src/velvet-lead-source.ts");
const routes = read("src/routes/velvet-lead-source-routes.ts");
const schema = read("src/prospector.ts");
const server = read("server.ts");
const ui = read("src/App.tsx");

const checks = [
  [
    "request and response contracts are versioned",
    client.includes("smirk-velvet.lead-batch-request.v1") &&
      client.includes("velvet-smirk.lead-batch-response.v1"),
  ],
  [
    "request hard-codes no contact and zero spend",
    client.includes("contactActionAllowed: z.literal(false)") &&
      client.includes("maxSpendCents: z.literal(0)"),
  ],
  [
    "response must prove no contact and no spend",
    client.includes("contactActionAllowed: z.literal(false)") &&
      client.includes("spendAuthorized: z.literal(false)"),
  ],
  [
    "discovery-bound pulls require and echo exact opaque provenance",
    client.includes("sourceDiscoveryRequestId") &&
      client.includes(
        "A discovery-bound pull requires the exact manual category"
      ) &&
      client.includes(
        "parsed.data.sourceDiscoveryRequestId !=="
      ),
  ],
  [
    "batch size is capped at twenty",
    client.includes("VELVET_LEAD_SOURCE_MAX_BATCH_SIZE = 20"),
  ],
  [
    "source integration is default disabled and workspace locked",
    client.includes("VELVET_LEAD_SOURCE_ENABLED") &&
      client.includes("VELVET_LEAD_SOURCE_WORKSPACE_ID") &&
      client.includes("VELVET_LEAD_SOURCE_API_KEY"),
  ],
  [
    "approval, cancellation, and dispatch require exact confirmations",
    routes.includes("VELVET_LEAD_SOURCE_APPROVAL_CONFIRMATION") &&
      routes.includes("VELVET_LEAD_SOURCE_CANCEL_CONFIRMATION") &&
      routes.includes("VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION") &&
      routes.includes("requireFullOperator"),
  ],
  [
    "network uncertainty remains replayable",
    routes.includes('"SENDING" : "FAILED"') &&
      client.includes("VELVET_LEAD_SOURCE_TRANSPORT_UNCERTAIN"),
  ],
  [
    "a durable lease blocks simultaneous dispatch",
    routes.includes("VELVET_LEAD_SOURCE_DISPATCH_LEASE_MS") &&
      routes.includes("VELVET_LEAD_SOURCE_DISPATCH_IN_PROGRESS"),
  ],
  [
    "partial imports remain separately visible",
    routes.includes('"PARTIAL"') &&
      routes.includes("velvet_lead_source_request_items"),
  ],
  [
    "durable request, item, and event receipts exist",
    schema.includes("velvet_lead_source_requests") &&
      schema.includes("velvet_lead_source_request_items") &&
      schema.includes("velvet_lead_source_request_events"),
  ],
  [
    "the server registers the guarded source routes",
    server.includes("registerVelvetLeadSourceRoutes(app"),
  ],
  [
    "the operator UI preserves the no-contact and zero-spend boundary",
      ui.includes("Velvet reviewed lead feed") &&
      ui.includes("No contact and $0 spend") &&
      ui.includes("approve-one-velvet-source-request-v1") &&
      ui.includes("cancel-one-velvet-source-request-v1") &&
      ui.includes("dispatch-one-velvet-source-request-v1"),
  ],
  [
    "the source route has no email, SMS, or telephony provider call",
    !routes.includes("sendApprovedProspectEmail") &&
      !routes.includes("sendSms") &&
      !routes.includes("calls.create") &&
      !routes.includes("messages.create"),
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
  console.log(`Velvet lead source contract passed (${checks.length}/${checks.length}).`);
}
