#!/usr/bin/env node
import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");
const failures = [];
const expect = (label, condition) => {
  if (!condition) failures.push(label);
};

const contract = read("src/prospect-outreach.ts");
const routes = read("src/routes/prospect-outreach-routes.ts");
const emailProvider = read("src/prospect-email-provider.ts");
const emailWebhook = read("src/prospect-email-webhook.ts");
const prospectingRoutes = read("src/routes/prospecting-routes.ts");
const schema = read("src/prospector.ts");
const learning = read("src/prospect-learning.ts");
const messageExperiments = read("src/prospect-message-experiments.ts");
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
  contract.includes("advertisementDisclosure")
    && contract.includes("physicalPostalAddress")
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
  "email provider execution is single-recipient, full-operator, confirmed, capped, suppressed, and idempotent",
  routes.includes("requireFullOperator")
    && routes.includes("PROSPECT_EMAIL_EXECUTION_CONFIRMATION")
    && routes.includes("PROSPECT_EMAIL_DAILY_CAP_REACHED")
    && routes.includes("prospect_email_suppressions")
    && routes.includes("provider_idempotency_key")
    && routes.includes("state = 'SENDING'")
    && routes.includes("deliveryConfirmed: false")
    && emailProvider.includes("PROSPECT_EMAIL_RESEND_API_KEY")
    && emailProvider.includes("env.RESEND_API_KEY")
    && emailProvider.includes("hashProspectOutreachPayload(payload)")
    && emailProvider.includes('"Idempotency-Key"')
    && emailProvider.includes("to: [payload.recipient]")
    && emailProvider.includes("single-recipient-reviewed-v1")
    && emailProvider.includes("bulkExecution !== false")
    && emailProvider.includes("smsAllowed !== false")
    && !routes.includes("calls.create")
    && !routes.includes("TWILIO_PHONE_NUMBER")
    && !routes.includes("sendSms")
    && !emailProvider.includes("TWILIO_PHONE_NUMBER")
    && !emailProvider.includes("calls.create")
    && !emailProvider.includes("sendSms"),
);
expect(
  "call execution remains manual-only and has no provider path",
  routes.includes("PROSPECT_CALL_PROVIDER_EXECUTION_DISABLED")
    && routes.includes("Call jobs remain manual-dial-only")
    && contract.includes('providerExecution !== "disabled"')
    && contract.includes("automatedDialing: false"),
);
expect(
  "Resend outcomes use raw-body signature verification and durable event deduplication",
  server.includes('"/api/prospecting/resend/webhook"')
    && server.includes("rawWebhookPaths")
    && routes.includes('express.raw({ type: "application/json", limit: "64kb" })')
    && routes.includes("verifyProspectEmailWebhook")
    && routes.includes("prospect_email_provider_events")
    && routes.includes("recordProspectOutcomeTransaction")
    && routes.includes("source: \"resend_webhook\"")
    && emailWebhook.includes('"svix-id"')
    && emailWebhook.includes('"svix-timestamp"')
    && emailWebhook.includes('"svix-signature"')
    && emailWebhook.includes("webhooks.verify")
    && schema.includes("UNIQUE (provider, provider_event_id)")
    && schema.includes("'REVIEW_REQUIRED'")
    && schema.includes("'RETRY'"),
);
expect(
  "bounce, complaint, suppression, and reply handling fail closed",
  emailWebhook.includes('event.type === "email.bounced"')
    && emailWebhook.includes('event.type === "email.complained"')
    && emailWebhook.includes('event.type === "email.suppressed"')
    && emailWebhook.includes('event.type === "email.received"')
    && emailWebhook.includes('event.type === "suppression.added"')
    && routes.includes("upsertProspectEmailSuppression")
    && routes.includes("ambiguous_recent_outreach")
    && !routes.includes("suppression.removed"),
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
    "prospect_email_suppressions",
    "prospect_email_provider_events",
    "velvet_outcome_outbox",
    "prospect_message_experiments",
    "prospect_message_experiment_events",
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
  "Velvet feedback is signed, queued, and dispatched one event at a time behind a full-operator gate",
  velvetOutcome.includes("signVelvetOutcomePayload")
    && velvetOutcome.includes("VELVET_OUTCOME_DISPATCH_ENABLED")
    && velvetOutcome.includes("VELVET_OUTCOME_WORKSPACE_ID")
    && velvetOutcome.includes("buildVelvetOutcomeIdempotencyKey")
    && routes.includes("/api/prospecting/velvet-outcomes/outbox")
    && routes.includes("VELVET_OUTCOME_DISPATCH_CONFIRMATION")
    && routes.includes("requireFullOperator")
    && routes.includes("dispatchVelvetOutcome")
    && routes.includes("appendVelvetDispatchEvent")
    && routes.includes("VELVET_OUTCOME_DISPATCH_DISABLED")
    && schema.includes("velvet_outcome_dispatch_events")
    && schema.includes("'SENDING'"),
);
expect(
  "observational learning is labeled and never creates a policy candidate by itself",
  contract.includes("variantKey")
    && learning.includes("MINIMUM_VARIANT_SAMPLE = 10")
    && learning.includes("NO_MEASURED_LIFT")
    && routes.includes("/api/prospecting/learning/scorecard")
    && routes.includes('studyDesign: "observational"')
    && routes.includes("candidateEligible: false")
    && routes.includes("/api/prospecting/learning/candidates")
    && routes.includes("policyChanged: false"),
);
expect(
  "controlled message candidates require immutable deterministic assignment and a closed cohort",
  messageExperiments.includes(
    "PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION"
  )
    && messageExperiments.includes(
      "PROSPECT_MESSAGE_ASSIGNMENT_CONTRACT_VERSION"
    )
    && messageExperiments.includes("allocationBucket")
    && messageExperiments.includes(
      "verifyProspectMessageExperimentAssignment"
    )
    && contract.includes("experimentAssignment")
    && schema.includes("idx_prospect_message_experiment_active")
    && schema.includes("idx_prospect_message_experiment_enrollment")
    && routes.includes("loadActiveMessageExperiment")
    && routes.includes("PROSPECT_LEARNING_EXPERIMENT_NOT_CLOSED")
    && routes.includes("PROSPECT_LEARNING_PROTOCOL_DEVIATION")
    && routes.includes("deterministic-assignment-v1")
    && routes.includes("runtimePolicyChange: false"),
);
expect(
  "experiment lifecycle is full-operator, audited, terminal-job gated, and contact-free",
  routes.includes(
    "/api/prospecting/learning/experiments/:experimentId/activate"
  )
    && routes.includes(
      "/api/prospecting/learning/experiments/:experimentId/close"
    )
    && routes.includes(
      "/api/prospecting/learning/experiments/:experimentId/cancel"
    )
    && routes.includes(
      "PROSPECT_MESSAGE_EXPERIMENT_ACTIVATION_CONFIRMATION"
    )
    && routes.includes(
      "PROSPECT_MESSAGE_EXPERIMENT_CLOSE_CONFIRMATION"
    )
    && routes.includes("allJobsTerminal")
    && routes.includes("outcomeWindowReviewed")
    && routes.includes(
      "PROSPECT_MESSAGE_EXPERIMENT_JOBS_NOT_TERMINAL"
    )
    && routes.includes("appendExperimentEvent")
    && routes.includes("contactAuthorized: false")
    && routes.includes("spendAuthorized: false")
    && !messageExperiments.includes("fetch(")
    && !messageExperiments.includes("sendSms")
    && !messageExperiments.includes("calls.create"),
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
  "OK prospect outreach is recipient-specific, approval-ledgered, outcome-linked, SMS-free, manual-call-only, and guarded for one-email execution",
);
