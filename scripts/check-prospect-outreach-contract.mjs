#!/usr/bin/env node
import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");
const failures = [];
const expect = (label, condition) => {
  if (!condition) failures.push(label);
};

const contract = read("src/prospect-outreach.ts");
const routes = read("src/routes/prospect-outreach-routes.ts");
const prospectingRoutes = read("src/routes/prospecting-routes.ts");
const schema = read("src/prospector.ts");
const learning = read("src/prospect-learning.ts");
const velvetOutcome = read("src/velvet-outcome.ts");
const server = read("server.ts");

expect(
  "the outreach contract supports only recipient-specific email and call jobs",
  contract.includes('export type ProspectOutreachChannel = "email" | "call"')
    && contract.includes("recipientSpecific: true")
    && contract.includes("bulkExecution: false")
    && contract.includes("smsAllowed: false"),
);
expect(
  "email and call approvals carry explicit compliance prerequisites",
  contract.includes("physicalPostalAddress")
    && contract.includes("optOutInstructions")
    && contract.includes("suppressionCheckRequired")
    && contract.includes("doNotCallCheckRequired")
    && contract.includes("callingWindowCheckRequired")
    && contract.includes("automatedDialing: false")
    && routes.includes("PROSPECT_OUTREACH_COMPLIANCE_ATTESTATION_REQUIRED"),
);
expect(
  "contact provenance is persisted and enforced before draft preparation",
  schema.includes("email_verification")
    && schema.includes("phone_contact_mode")
    && routes.includes("verified_owner_email")
    && routes.includes("operator_review_only"),
);
expect(
  "the approval lifecycle separates preparation, approval, execution, success, and failure",
  ["PREPARED", "APPROVED", "SENDING", "SENT", "FAILED", "REJECTED", "EXPIRED", "CANCELLED"]
    .every((state) => contract.includes(`"${state}"`)),
);
expect(
  "unsupported business-outcome claims fail draft validation",
  contract.includes("unsupported business-outcome claim")
    && contract.includes("costing you")
    && contract.includes("you(?:'re| are) losing"),
);
expect(
  "provider execution remains explicitly blocked",
  routes.includes("PROSPECT_OUTREACH_EXECUTION_DISABLED")
    && routes.includes("Provider execution is disabled")
    && !routes.includes("calls.create")
    && !routes.includes("api.resend.com")
    && !routes.includes("TWILIO_PHONE_NUMBER")
    && !routes.includes("RESEND_API_KEY"),
);
expect(
  "approval mutations are operator-authenticated, workspace-scoped, hash-bound, and row-count checked",
  routes.includes("dashboardAuth")
    && routes.includes("requireOperator")
    && routes.includes("workspace_id = ${workspaceId}")
    && routes.includes("payload_hash = ${parsed.data.payloadHash}")
    && routes.includes("approval_attestations")
    && routes.includes("updated.length !== 1"),
);
expect(
  "preview, approve, reject, cancel, expiry, execution-record, and outcome paths exist",
  [
    '/leads/:id/outreach"',
    '/:approvalId/approve"',
    '/:approvalId/reject"',
    '/:approvalId/cancel"',
    "PROSPECT_OUTREACH_EXPIRED",
    '/:approvalId/record-execution"',
    '/leads/:id/outcomes"',
  ].every((fragment) => routes.includes(fragment)),
);
expect(
  "durable schema keeps jobs, transition audit, outcomes, and learning candidates separate",
  [
    "prospect_outreach_jobs",
    "prospect_outreach_events",
    "prospect_outcome_events",
    "velvet_outcome_outbox",
    "prospect_learning_candidates",
  ].every((table) => schema.includes(`CREATE TABLE IF NOT EXISTS ${table}`)),
);
expect(
  "operator-recorded execution proof is not stored as a provider message ID",
  schema.includes("execution_proof_reference")
    && routes.includes("execution_proof_reference = ${parsed.data.proofReference}")
    && !routes.includes("provider_message_id = ${parsed.data.proofReference}"),
);
expect(
  "Velvet feedback is signed, queued, previewable, and dispatch-disabled",
  velvetOutcome.includes("signVelvetOutcomePayload")
    && velvetOutcome.includes("VELVET_OUTCOME_DISPATCH_ENABLED")
    && routes.includes("/api/prospecting/velvet-outcomes/outbox")
    && routes.includes("VELVET_OUTCOME_DISPATCH_DISABLED"),
);
expect(
  "learning compares versioned variants with minimum samples and never mutates runtime policy",
  contract.includes("variantKey")
    && learning.includes("MINIMUM_VARIANT_SAMPLE = 10")
    && learning.includes("NO_MEASURED_LIFT")
    && routes.includes("/api/prospecting/learning/scorecard")
    && routes.includes("/api/prospecting/learning/candidates")
    && routes.includes("policyChanged: false"),
);
expect(
  "outcomes are idempotent and direct status invention is blocked",
  schema.includes("UNIQUE (workspace_id, source, external_event_id)")
    && prospectingRoutes.includes("PROSPECT_OUTCOME_EVENT_REQUIRED"),
);
expect(
  "the guarded routes are registered in the server",
  server.includes("registerProspectOutreachRoutes(app"),
);

if (failures.length) {
  console.error("Prospect outreach contract failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "OK prospect outreach is recipient-specific, approval-ledgered, outcome-linked, SMS-free, and provider-disabled",
);
