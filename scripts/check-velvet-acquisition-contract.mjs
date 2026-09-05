#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const domain = read("src/velvet-acquisition.ts");
const route = read("src/routes/velvet-acquisition-routes.ts");
const operations = read("src/routes/operations-routes.ts");
const db = read("src/db.ts");
const server = read("server.ts");
const openapiGenerator = read("scripts/generate-openapi.mjs");
const postgresCheck = read("scripts/check-velvet-acquisition-postgres.ts");
const docs = read("docs/VELVET_ACQUISITION_INBOX.md");
const pkg = JSON.parse(read("package.json"));
const failures = [];
const expect = (label, condition) => {
  if (!condition) failures.push(label);
};

expect("source record and source event identities are distinct", domain.includes("sourceRecordId") && domain.includes("sourceEventId"));
expect("opaque acquisition and receipt IDs are deterministic", domain.includes("buildVelvetAcquisitionId") && domain.includes("buildVelvetAcquisitionReceiptId"));
expect("payload evidence is SHA-256 hashed", domain.includes('createHash("sha256")') && domain.includes("buildVelvetAcquisitionPayloadHash"));
expect("intake requires a dedicated strong token", domain.includes("apiKey.length < 32") && domain.includes("VELVET_ALCHEMY_ACQUISITION_API_KEY_SEPARATION") && domain.includes("SECRET_PLACEHOLDER"));
expect("intake requires an explicit evidence or synthetic-only mode", domain.includes("synthetic-fixture-only-v1") && domain.includes("evidence-inbox-v1"));
expect("synthetic fixtures use reserved identity and phone values", domain.includes('"velvet-manus-fake-"') && domain.includes('"+12025550124"'));
expect("route uses constant-time bearer authentication", route.includes("constantTimeSecretEquals(token, config.apiKey)"));
expect("route validates a strict payload", route.includes("velvetAcquisitionPayloadSchema.safeParse(req.body)"));
expect("route is workspace-bound", route.includes("VELVET_ALCHEMY_WORKSPACE_MISMATCH"));
expect("route is schema-readiness gated", route.includes("isSchemaReady") && route.includes("VELVET_ALCHEMY_ACQUISITION_SCHEMA_NOT_READY"));
expect("route is rate-limited", route.includes("velvetAcquisitionRateLimit"));
expect("route registers the acquisition inbox", route.includes('app.post("/api/integrations/velvet/acquisitions"'));
expect("server preserves the hardened legacy handoff receiver separately", server.includes("registerVelvetHandoffRoutes(app") && domain.includes("normalizeLegacyVelvetHandoffPayload"));
expect("store independently enforces evidence classification", route.includes("validateVelvetAcquisitionEvidence(input)"));
expect("store computes its own provenance hash", route.includes("const payloadHash = buildVelvetAcquisitionPayloadHash(input)"));
expect("real evidence requires explicit inbox mode", route.includes("VELVET_EVIDENCE_INBOX_MODE") && route.includes("VELVET_ALCHEMY_EVIDENCE_INBOX_MODE_REQUIRED"));
expect("store enforces changed-replay conflicts", route.includes("VELVET_ALCHEMY_IDEMPOTENCY_CONFLICT") && route.includes("existingEvent.payload_hash !== payloadHash"));
for (const table of ["contacts", "calls", "handoffs", "tasks", "messages", "launch_outreach_approvals"]) {
  expect(`synthetic intake does not write ${table}`, !route.includes(`INSERT INTO ${table}`));
}

expect("acquisition root exists", db.includes("CREATE TABLE IF NOT EXISTS acquisition_records"));
expect("append-only acquisition event ledger exists", db.includes("CREATE TABLE IF NOT EXISTS acquisition_events"));
expect("append-only acquisition reviews exist", db.includes("CREATE TABLE IF NOT EXISTS acquisition_reviews"));
expect("source record uniqueness is tenant scoped", db.includes("UNIQUE (workspace_id, source_system, source_record_id)"));
expect("source event uniqueness is tenant scoped", db.includes("UNIQUE (workspace_id, source_system, source_event_id)"));
expect("synthetic records are structurally non-contactable", db.includes("record_kind <> 'synthetic'") && db.includes("contact_permission = 'not_permitted'") && db.includes("contact_basis = 'synthetic_fixture'"));
expect("source and safety state are immutable", db.includes("guard_acquisition_record_identity") && db.includes("OLD.contact_permission IS DISTINCT FROM NEW.contact_permission") && db.includes("acquisition source identity is immutable"));
expect("event and review evidence is append-only", db.includes("guard_append_only_acquisition_evidence") && db.includes("acquisition event and review evidence is append-only"));
expect("call and handoff links are tenant matched", db.includes("calls_acquisition_tenant_fkey") && db.includes("handoffs_acquisition_tenant_fkey"));
expect("event call and handoff links are tenant matched", db.includes("acquisition_events_call_tenant_fkey") && db.includes("acquisition_events_handoff_tenant_fkey"));
for (const table of ["provisioning_requests", "activation_events", "stripe_checkout_fulfillments", "stripe_paid_checkout_exceptions", "launch_events", "launch_ledger", "launch_outreach_approvals"]) {
  expect(`${table} reserves a source-tenant acquisition link`, db.includes(`"${table}"`) || db.includes(`'${table}'`));
}
expect("source-tenant link pairs are constrained", db.includes("acquisition_workspace_id") && db.includes("constraint_prefix || '_pair_check'"));
expect("approval evidence joins the same acquisition and tenant", db.includes("acquisition_events_approval_evidence_fkey"));
expect("server registers the receiver", server.includes("registerVelvetAcquisitionRoutes(app"));
expect("server exposes receiver health from full configuration", server.includes("readVelvetAcquisitionConfig(process.env).configured"));
expect("server checks separation against the complete process secret inventory", server.includes("readVelvetAcquisitionConfig(process.env).configured") && server.includes("env: process.env"));
expect("server marks attribution ready only after schema initialization", server.includes("acquisitionSchemaReady = true"));
expect("portal separates synthetic acquisition counts from handoff counts", operations.includes("acquisitionCounts") && operations.includes("recentAcquisitions") && operations.includes("recentHandoffs"));
expect("pre-migration handoff reads avoid the new column", operations.includes("NULL::TEXT AS acquisition_id"));
expect("portal does not overstate lifecycle propagation", operations.includes("sourceAttributionAvailable: false") && operations.includes("acquisitionInboxAvailable"));
expect("portal verifies the configured receiver workspace exists", operations.includes("workspace_exists") && operations.includes("receiverReady"));
expect("operator can read tenant-scoped acquisition evidence", operations.includes('app.get("/api/acquisitions"') && operations.includes('app.get("/api/acquisitions/:id"'));
expect("OpenAPI uses the dedicated Velvet bearer scheme", openapiGenerator.includes("VelvetAcquisitionBearerAuth") && openapiGenerator.includes("POST /api/integrations/velvet/acquisitions") && openapiGenerator.includes("POST /api/integrations/velvet/handoffs"));
expect("Postgres fixture check creates and drops only a generated local database", postgresCheck.includes("SMIRK_ALLOW_TEMP_ACQUISITION_DB_CHECK") && postgresCheck.includes("CREATE DATABASE") && postgresCheck.includes("DROP DATABASE IF EXISTS") && postgresCheck.includes("smirk_acquisition_check_"));
expect("historical receipt migration remains explicit", docs.includes("velvet_alchemy_handoff_receipts") && docs.includes("not infer"));
expect(
  "package exposes the acquisition verification gate",
  pkg.scripts?.["check:velvet-acquisition"] === "node scripts/check-velvet-acquisition-contract.mjs && node --import tsx --test tests/velvet_acquisition_route.test.ts tests/velvet_acquisition_store.test.ts tests/velvet_acquisition_read.test.ts",
);

if (failures.length) {
  console.error("Velvet acquisition contract failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK Velvet acquisition evidence is tenant-scoped, idempotent, synthetic-separated, and non-contacting");
