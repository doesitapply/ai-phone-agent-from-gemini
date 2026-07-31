#!/usr/bin/env node
import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");
const failures = [];
const expect = (label, condition) => {
  if (!condition) failures.push(label);
};

const contract = read("src/prospect-outreach.ts");
const qc = read("src/prospect-qc.ts");
const routes = read("src/routes/prospect-outreach-routes.ts");
const emailProvider = read("src/prospect-email-provider.ts");
const emailWebhook = read("src/prospect-email-webhook.ts");
const prospectingRoutes = read("src/routes/prospecting-routes.ts");
const schema = read("src/prospector.ts");
const learning = read("src/prospect-learning.ts");
const messageExperiments = read("src/prospect-message-experiments.ts");
const messagePolicy = read("src/prospect-message-policy.ts");
const inboxPlacement = read("src/prospect-inbox-placement.ts");
const inboxPlacementStore = read(
  "src/prospect-inbox-placement-store.ts"
);
const inboxPlacementRoutes = read(
  "src/routes/prospect-inbox-placement-routes.ts"
);
const positiveOutcomeReview = read(
  "src/prospect-positive-outcome-review.ts"
);
const positiveOutcomePause = read(
  "src/prospect-positive-outcome-pause.ts"
);
const velvetDiscoveryRoutes = read(
  "src/routes/velvet-discovery-routes.ts"
);
const velvetLeadSourceRoutes = read(
  "src/routes/velvet-lead-source-routes.ts"
);
const velvetResearchRoutes = read(
  "src/routes/velvet-research-routes.ts"
);
const revenueLoop = read("src/prospect-revenue-loop.ts");
const revenueLoopRoutes = read(
  "src/routes/prospect-revenue-loop-routes.ts"
);
const revenueLoopObserver = read(
  "src/prospect-revenue-loop-observer.ts"
);
const revenueLoopRunner = read(
  "src/prospect-revenue-loop-runner.ts"
);
const revenueLoopRunnerCli = read(
  "scripts/run-prospect-revenue-loop-checkpoint.ts"
);
const acquisitionConnections = read(
  "src/prospect-acquisition-connection-readiness.ts"
);
const acquisitionConnectionCheck = read(
  "scripts/check-prospect-acquisition-connections.ts"
);
const velvetOutcome = read("src/velvet-outcome.ts");
const server = read("server.ts");
const candidateDecisionStart = routes.indexOf(
  '"/api/prospecting/learning/candidates/:id/decision"'
);
const candidateDecisionEnd = routes.indexOf(
  "\n  );",
  candidateDecisionStart
);
const candidateDecisionRoute =
  candidateDecisionStart >= 0 &&
  candidateDecisionEnd > candidateDecisionStart
    ? routes.slice(candidateDecisionStart, candidateDecisionEnd)
    : "";
const cohortDraftStart = routes.indexOf(
  '"/api/prospecting/learning/experiments/:experimentId/prepare-drafts"'
);
const cohortDraftEnd = routes.indexOf(
  '"/api/prospecting/learning/experiments/:experimentId/close"',
  cohortDraftStart
);
const cohortDraftRoute =
  cohortDraftStart >= 0 && cohortDraftEnd > cohortDraftStart
    ? routes.slice(cohortDraftStart, cohortDraftEnd)
    : "";
const policyApplyStart = routes.indexOf(
  '"/api/prospecting/learning/candidates/:id/apply-policy"'
);
const policyApplyEnd = routes.indexOf(
  '"/api/prospecting/learning/policies/:releaseId/rollback"',
  policyApplyStart
);
const policyApplyRoute =
  policyApplyStart >= 0 && policyApplyEnd > policyApplyStart
    ? routes.slice(policyApplyStart, policyApplyEnd)
    : "";
const policyRollbackStart = policyApplyEnd;
const policyRollbackEnd = routes.indexOf(
  '"/api/prospecting/velvet-outcomes/:id/dispatch"',
  policyRollbackStart
);
const policyRollbackRoute =
  policyRollbackStart >= 0 &&
  policyRollbackEnd > policyRollbackStart
    ? routes.slice(policyRollbackStart, policyRollbackEnd)
    : "";

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
    && qc.includes("costing you")
    && qc.includes("you(?:'re| are) losing"),
);
expect(
  "QC is deterministic-first, evidence-bound, advisory-only, and never authorizes execution",
  qc.includes("PROSPECT_QC_RULE_VERSION")
    && qc.includes("PLACEHOLDERS_RESOLVED")
    && qc.includes("SOURCE_CLAIMS_GROUNDED")
    && qc.includes("SPAM_LANGUAGE_BOUNDED")
    && qc.includes("LINK_COUNT_BOUNDED")
    && qc.includes("EMAIL_COMPLIANCE_PRESENT")
    && qc.includes('"advisory-only"')
    && qc.includes("humanApprovalRequired: true")
    && qc.includes("contactAuthorized: false")
    && qc.includes("executionAuthorized: false")
    && qc.includes("automatedSendingAuthorized: false")
    && qc.includes("automatedDialingAuthorized: false")
    && contract.includes("qcReceipt: prospectQcReceiptSchema.optional()")
    && routes.includes("qcVerdict: payload.qcReceipt!.verdict"),
);
expect(
  "email experiments require a fresh immutable five-inbox placement receipt",
  inboxPlacement.includes("google_workspace")
    && inboxPlacement.includes("microsoft_365")
    && inboxPlacement.includes("yahoo_aol")
    && inboxPlacement.includes(
      "PROSPECT_INBOX_SEED_ALLOWLIST"
    )
    && inboxPlacement.includes("trackingPixelAbsent")
    && inboxPlacement.includes("complianceFooterRendered")
    && inboxPlacement.includes(
      "authorizesExperimentActivation"
    )
    && inboxPlacement.includes("authorizesContact: false")
    && inboxPlacement.includes("authorizesSpend: false")
    && inboxPlacementStore.includes("state = 'PASSED'")
    && inboxPlacementStore.includes(
      "valid_until >"
    )
    && routes.includes(
      "PROSPECT_INBOX_PLACEMENT_PROOF_REQUIRED"
    )
    && routes.includes("inbox_placement_receipt_hash")
    && schema.includes("prospect_inbox_placement_tests")
    && schema.includes("prospect_inbox_placement_items")
    && schema.includes("is_seed")
);
expect(
  "controlled inbox preparation never bulk-sends and inspection is exact-message bound",
  inboxPlacementRoutes.includes(
    "prepareProspectInboxPlacementSchema"
  )
    && inboxPlacementRoutes.includes(
      "assertProspectInboxPlacementAllowlist"
    )
    && inboxPlacementRoutes.includes(
      "PROSPECT_INBOX_PLACEMENT_SENT_PROOF_REQUIRED"
    )
    && inboxPlacementRoutes.includes(
      "provider_message_id"
    )
    && inboxPlacementRoutes.includes(
      "externalAction: \"none\""
    )
    && !inboxPlacementRoutes.includes(
      "sendApprovedProspectEmail"
    )
    && !inboxPlacementRoutes.includes("fetch(")
    && !inboxPlacementRoutes.includes("sendSms")
    && !inboxPlacementRoutes.includes("calls.create"),
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
  "controlled inbox provider facts cannot become market outcomes or Velvet callbacks",
  routes.includes("PROSPECT_SEED_OUTCOME_FORBIDDEN")
    && routes.includes("controlled_seed_provider_event_recorded")
    && routes.includes("controlled_seed_reply_event_recorded")
    && routes.includes("marketOutcomeRecorded: false")
    && routes.includes("velvetCallbackPrepared: false")
    && routes.includes("j.is_seed = FALSE")
    && routes.includes("lead.source === SMIRK_INTERNAL_INBOX_SEED_SOURCE")
    && schema.includes("is_seed"),
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
    "prospect_positive_outcome_reviews",
    "prospect_positive_outcome_review_events",
    "prospect_email_suppressions",
    "prospect_email_provider_events",
    "velvet_outcome_outbox",
    "prospect_message_experiments",
    "prospect_message_experiment_events",
    "prospect_learning_candidates",
    "prospect_message_policy_releases",
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
    && messageExperiments.includes(
      "deterministic-eligible-cohort-v1"
    )
    && messageExperiments.includes("eligiblePopulationHash")
    && messageExperiments.includes("selectedProspectIdsHash")
    && messageExperiments.includes("buildFrozenCohortEntries")
    && routes.includes("loadEligibleExperimentProspectIds")
    && routes.includes(
      "PROSPECT_MESSAGE_EXPERIMENT_PROSPECT_NOT_SELECTED"
    )
    && routes.includes(
      "PROSPECT_MESSAGE_EXPERIMENT_FROZEN_COHORT_INCOMPLETE"
    )
    && routes.includes(
      "PROSPECT_MESSAGE_EXPERIMENT_COHORT_ELIGIBILITY_DRIFT"
    )
    && routes.includes(
      "PROSPECT_MESSAGE_EXPERIMENT_COHORT_RESERVED"
    )
    && routes.includes("runtimePolicyChange: false"),
);
expect(
  "learning approval is full-operator and bound to the exact closed deterministic cohort",
  candidateDecisionRoute.includes("requireFullOperator")
    && !candidateDecisionRoute.includes("requireOperator,")
    && candidateDecisionRoute.includes(
      "requireDeterministicCandidateBinding"
    )
    && candidateDecisionRoute.includes("state = 'CLOSED'")
    && candidateDecisionRoute.includes(
      "PROSPECT_LEARNING_CANDIDATE_INELIGIBLE"
    )
    && routes.includes("recommendation_eligible")
    && routes.includes("LEFT JOIN prospect_message_experiments")
    && routes.includes("executedProtocolDeviationCount"),
);
expect(
  "approved message learning changes only the next experiment control through an immutable full-operator release",
  messagePolicy.includes(
    "PROSPECT_MESSAGE_POLICY_APPLY_CONFIRMATION"
  )
    && messagePolicy.includes(
      "PROSPECT_MESSAGE_POLICY_ROLLBACK_CONFIRMATION"
    )
    && messagePolicy.includes("nextExperimentControlOnly")
    && messagePolicy.includes("existingJobsChanged")
    && messagePolicy.includes("contactAuthorized")
    && messagePolicy.includes("executionAuthorized")
    && messagePolicy.includes("spendAuthorized")
    && messageExperiments.includes("appliedPolicy")
    && policyApplyRoute.includes("requireFullOperator")
    && policyApplyRoute.includes(
      "requireDeterministicCandidateBinding"
    )
    && policyApplyRoute.includes("source_candidate_id")
    && policyApplyRoute.includes('externalAction: "none"')
    && policyRollbackRoute.includes("requireFullOperator")
    && policyRollbackRoute.includes("rollbackOfReleaseId")
    && policyRollbackRoute.includes(
      "PROSPECT_MESSAGE_POLICY_NOT_CURRENT"
    )
    && routes.includes(
      "PROSPECT_MESSAGE_POLICY_CONTROL_REQUIRED"
    )
    && routes.includes(
      "PROSPECT_MESSAGE_EXPERIMENT_POLICY_STALE"
    )
    && !messagePolicy.includes("fetch(")
    && !messagePolicy.includes("sendSms")
    && !messagePolicy.includes("calls.create"),
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
    && routes.includes("assertFrozenCohortEnrollment")
    && routes.includes("appendExperimentEvent")
    && routes.includes("contactAuthorized: false")
    && routes.includes("spendAuthorized: false")
    && !messageExperiments.includes("fetch(")
    && !messageExperiments.includes("sendSms")
    && !messageExperiments.includes("calls.create"),
);
expect(
  "the frozen-cohort feeder prepares only recipient-specific review jobs and cannot execute contact",
  cohortDraftRoute.includes("requireFullOperator")
    && routes.includes(
      "PROSPECT_MESSAGE_EXPERIMENT_PREPARE_DRAFTS_CONFIRMATION"
    )
    && cohortDraftRoute.includes("prepareProspectOutreachJob")
    && cohortDraftRoute.includes("requiredExperimentId")
    && cohortDraftRoute.includes("pendingHumanReview")
    && cohortDraftRoute.includes('externalAction: "none"')
    && cohortDraftRoute.includes("contactAuthorized: false")
    && cohortDraftRoute.includes("executionAuthorized: false")
    && cohortDraftRoute.includes("spendAuthorized: false")
    && !cohortDraftRoute.includes("sendApprovedProspectEmail")
    && !cohortDraftRoute.includes("dispatchVelvetOutcome")
    && !cohortDraftRoute.includes("fetchImpl")
    && !cohortDraftRoute.includes("sendSms")
    && !cohortDraftRoute.includes("calls.create"),
);
expect(
  "outcomes are idempotent and direct status invention is blocked",
  schema.includes("UNIQUE (workspace_id, source, external_event_id)")
    && prospectingRoutes.includes("PROSPECT_OUTCOME_EVENT_REQUIRED"),
);
expect(
  "positive interactions pause on a durable single-use human review receipt",
  positiveOutcomeReview.includes(
    "PROSPECT_POSITIVE_OUTCOME_ACKNOWLEDGMENT_CONFIRMATION"
  )
    && positiveOutcomeReview.includes(
      "noContactExecutedByAcknowledgment"
    )
    && positiveOutcomeReview.includes(
      "followUpRemainsSeparate"
    )
    && routes.includes(
      '"/api/prospecting/positive-outcomes"'
    )
    && routes.includes(
      '"/api/prospecting/positive-outcomes/:reviewId/acknowledge"'
    )
    && routes.includes("requireFullOperator")
    && routes.includes(
      "hashProspectPositiveOutcomeAcknowledgmentRequest"
    )
    && routes.includes(
      "PROSPECT_POSITIVE_OUTCOME_ACKNOWLEDGMENT_CONFLICT"
    )
    && schema.includes(
      "prospect_positive_outcome_reviews"
    )
    && schema.includes(
      "prospect_positive_outcome_review_events"
    ),
);
expect(
  "pending interaction reviews fail closed and pause new work per workspace",
  positiveOutcomePause.includes(
    "PROSPECT_ACQUISITION_PAUSED_FOR_INTERACTION_REVIEW"
  )
    && positiveOutcomePause.includes(
      "FROM prospect_positive_outcome_reviews"
    )
    && positiveOutcomePause.includes(
      "WHERE workspace_id = ${workspaceId}"
    )
    && positiveOutcomePause.includes("AND state = 'PENDING'")
    && positiveOutcomePause.includes(
      "PROSPECT_ACQUISITION_PAUSE_UNAVAILABLE"
    )
    && positiveOutcomePause.includes(
      "pg_advisory_xact_lock"
    )
    && positiveOutcomePause.includes(
      "assertProspectAcquisitionMutationUnpaused"
    )
    && positiveOutcomePause.includes(
      "providerRequestAuthorized: false"
    ),
);
expect(
  "direct outreach, discovery, source, callback, and learning paths enforce the interaction pause",
  routes.includes("createProspectAcquisitionUnpausedGuard")
    && routes.includes("requireAcquisitionUnpaused")
    && routes.includes(
      "assertProspectAcquisitionMutationUnpaused"
    )
    && routes.includes(
      "acquireProspectAcquisitionWorkspaceLock"
    )
    && schema.includes(
      "acquireProspectAcquisitionWorkspaceLock"
    )
    && routes.includes('if (job.state === "APPROVED")')
    && routes.includes('if (row.state === "PREPARED")')
    && velvetDiscoveryRoutes.includes(
      "createProspectAcquisitionUnpausedGuard"
    )
    && velvetDiscoveryRoutes.includes(
      "requireAcquisitionUnpaused"
    )
    && velvetDiscoveryRoutes.includes(
      'if (row.state === "APPROVED")'
    )
    && velvetDiscoveryRoutes.includes(
      "assertProspectAcquisitionMutationUnpaused"
    )
    && velvetLeadSourceRoutes.includes(
      "createProspectAcquisitionUnpausedGuard"
    )
    && velvetLeadSourceRoutes.includes(
      "requireAcquisitionUnpaused"
    )
    && velvetLeadSourceRoutes.includes(
      'if (row.state !== "SENDING")'
    )
    && velvetLeadSourceRoutes.includes(
      "assertProspectAcquisitionMutationUnpaused"
    )
    && prospectingRoutes.includes(
      "createProspectAcquisitionUnpausedGuard"
    )
    && prospectingRoutes.includes(
      "assertProspectAcquisitionMutationUnpaused"
    )
    && prospectingRoutes.includes(
      'if (status === "active")'
    )
    && velvetResearchRoutes.includes(
      "acquireProspectAcquisitionWorkspaceLock"
    )
    && velvetResearchRoutes.includes(
      "assertProspectAcquisitionUnpaused"
    )
    && velvetResearchRoutes.includes(
      'priorReceipt?.status === "received"'
    ),
);
expect(
  "operator guidance prioritizes interaction review after uncertain-request reconciliation",
  revenueLoop.indexOf(
    "if (counts.unreviewedPositiveOutcomeJobs > 0)"
  ) >
    revenueLoop.indexOf("if (counts.velvetCallbacksSending > 0)")
    && revenueLoop.indexOf(
      "if (counts.unreviewedPositiveOutcomeJobs > 0)"
    ) <
      revenueLoop.indexOf("if (counts.velvetCallbacksPrepared > 0)")
    && revenueLoop.indexOf(
      "if (counts.unreviewedPositiveOutcomeJobs > 0)"
    ) <
      revenueLoop.indexOf(
        "counts.emailExperimentsActive > 0"
      ),
);
expect(
  "the revenue-loop controller is read-only, workspace-scoped, and cannot bypass contact gates",
  revenueLoop.includes("PROSPECT_REVENUE_LOOP_CONTRACT_VERSION")
    && revenueLoop.includes("RECONCILE_EMAIL_PROVIDER")
    && revenueLoop.includes("CONFIGURE_INBOX_PLACEMENT")
    && revenueLoop.includes("RUN_INBOX_PLACEMENT")
    && revenueLoop.includes("ACTIVATE_EMAIL_EXPERIMENT")
    && revenueLoop.includes("PREPARE_EXPERIMENT_DRAFTS")
    && revenueLoop.includes("CLOSE_ACTIVE_EXPERIMENT")
    && revenueLoop.includes("APPLY_MESSAGE_POLICY")
    && revenueLoop.includes("SEND_ONE_APPROVED_EMAIL")
    && revenueLoop.includes("MANUALLY_DIAL_ONE_APPROVED_CALL")
    && revenueLoop.includes("REVIEW_POSITIVE_OUTCOME")
    && revenueLoopRoutes.includes("positive_outcome_jobs")
    && revenueLoopRoutes.includes(
      "unreviewed_positive_outcome_jobs"
    )
    && revenueLoopRunner.includes(
      "unreviewedPositiveOutcomeJobs"
    )
    && revenueLoopRoutes.includes(
      "'replied', 'qualified', 'demo_booked', 'converted'"
    )
    && revenueLoop.includes("smsAllowed: false")
    && revenueLoop.includes("bulkExecutionAllowed: false")
    && revenueLoop.includes("automatedProspectDialingAllowed: false")
    && revenueLoop.includes("qcMayAuthorizeContact: false")
    && revenueLoop.includes("learningMayMutateRuntimePolicy: false")
    && revenueLoopRoutes.includes(
      '"/api/prospecting/revenue-loop"'
    )
    && revenueLoopRoutes.includes("dashboardAuth")
    && revenueLoopRoutes.includes("requireOperator")
    && revenueLoopRoutes.includes("workspace_id = ${workspaceId}")
    && revenueLoopRoutes.includes(
      "prospect_message_policy_releases"
    )
    && !revenueLoopRoutes.includes("sendApprovedProspectEmail")
    && !revenueLoopRoutes.includes("dispatchVelvetOutcome")
    && !revenueLoopRoutes.includes("fetch(")
    && !revenueLoopRoutes.includes("sendSms")
    && !revenueLoopRoutes.includes("calls.create"),
);
expect(
  "the checkpoint observer is exact-route, workspace-locked, replay-safe, and stops on interaction without execution authority",
  revenueLoopObserver.includes(
    '"/api/prospecting/revenue-loop"'
  )
    && revenueLoopObserver.includes(
      "PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY"
    )
    && revenueLoopObserver.includes(
      "PROSPECT_REVENUE_LOOP_OBSERVER_WORKSPACE_ID"
    )
    && revenueLoopObserver.includes(
      'input.method.toUpperCase() !== "GET"'
    )
    && revenueLoopObserver.includes(
      "PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY_SEPARATION"
    )
    && server.includes(
      "dashboardAuth: prospectRevenueLoopObserverAuth"
    )
    && server.includes(
      "requireOperator: requireProspectRevenueLoopObserver"
    )
    && server.includes(
      '"prospect_revenue_loop_observer"'
    )
    && revenueLoopRunner.includes("STOP_INTERACTION")
    && revenueLoopRunner.includes(
      "shouldScheduleNextCheck: false"
    )
    && revenueLoopRunner.includes("contactAuthorized: false")
    && revenueLoopRunner.includes("executionAuthorized: false")
    && revenueLoopRunner.includes("spendAuthorized: false")
    && revenueLoopRunner.includes(
      "policyMutationAuthorized: false"
    )
    && revenueLoopRunner.includes(
      "providerRequestAuthorized: false"
    )
    && revenueLoopRunnerCli.includes('method: "GET"')
    && revenueLoopRunnerCli.includes('"X-Api-Key": apiKey')
    && !revenueLoopRunnerCli.includes("Authorization:")
    && revenueLoopRunnerCli.includes(
      "CONFIRM_SMIRK_PROSPECT_REVENUE_LOOP_CHECKPOINT"
    )
    && revenueLoopRunnerCli.includes(
      "previous.statusHash !== checkpoint.statusHash"
    )
    && !revenueLoopRunnerCli.includes(
      "sendApprovedProspectEmail"
    )
    && !revenueLoopRunnerCli.includes("dispatchVelvetOutcome")
    && !revenueLoopRunnerCli.includes("sendSms")
    && !revenueLoopRunnerCli.includes("calls.create"),
);
expect(
  "production acquisition connection readiness is redacted and read-only",
  acquisitionConnections.includes(
    "PROSPECT_ACQUISITION_CONNECTION_READINESS_CONTRACT"
  )
    && acquisitionConnections.includes("coldSmsAllowed: false")
    && acquisitionConnections.includes("bulkEmailAllowed: false")
    && acquisitionConnections.includes(
      "automatedProspectDialingAllowed: false"
    )
    && acquisitionConnections.includes(
      "revenueLoopObserver"
    )
    && acquisitionConnections.includes(
      "revenueLoopObserverAndOperatorKeysDistinct"
    )
    && acquisitionConnections.includes(
      "providerMutationPerformed: false"
    )
    && acquisitionConnections.includes('externalAction: "none"')
    && acquisitionConnectionCheck.includes("railwayVariables")
    && !acquisitionConnectionCheck.includes("railwaySetVariable")
    && !/variable\s+set/i.test(acquisitionConnectionCheck),
);
expect(
  "the guarded routes are registered in the server",
  server.includes("registerProspectOutreachRoutes(app")
    && server.includes("registerProspectRevenueLoopRoutes(app"),
);

if (failures.length) {
  console.error("Prospect outreach contract failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "OK prospect outreach is recipient-specific, approval-ledgered, outcome-linked, SMS-free, manual-call-only, and guarded for one-email execution",
);
