import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProspectRevenueLoopStatus,
  deriveProspectRevenueLoopNextAction,
  type ProspectRevenueLoopConnections,
  type ProspectRevenueLoopCounts,
  type ProspectRevenueLoopNextActionCode,
} from "../src/prospect-revenue-loop.ts";

function counts(
  update: Partial<ProspectRevenueLoopCounts> = {}
): ProspectRevenueLoopCounts {
  return {
    campaigns: 0,
    discoveryPrepared: 0,
    discoveryApproved: 0,
    discoveryInFlight: 0,
    discoveryReadyForImport: 0,
    discoveryFailed: 0,
    sourcePrepared: 0,
    sourceApproved: 0,
    sourceInFlight: 0,
    pendingReviewLeads: 0,
    qualifiedLeads: 0,
    qualifiedEmailLeadsWithoutOutreach: 0,
    qualifiedCallLeadsWithoutOutreach: 0,
    qcRevisionsRequired: 0,
    outreachPrepared: 0,
    outreachApprovedEmail: 0,
    outreachApprovedCall: 0,
    outreachSending: 0,
    outreachSentWithoutOutcome: 0,
    outreachSentEmailWithoutOutcome: 0,
    outreachSentCallWithoutOutcome: 0,
    outcomeEvents: 0,
    positiveOutcomeJobs: 0,
    unreviewedPositiveOutcomeJobs: 0,
    velvetCallbacksPrepared: 0,
    velvetCallbacksSending: 0,
    passingInboxTests: 0,
    inboxPlacementOpenTests: 0,
    inboxSeedPrepared: 0,
    inboxSeedApproved: 0,
    inboxSeedSending: 0,
    inboxSeedSentAwaitingInspection: 0,
    inboxSeedInspected: 0,
    inboxPlacementReadyToFinalize: 0,
    inboxPlacementBlocked: 0,
    emailExperimentsPrepared: 0,
    emailExperimentsPreparedWithMatchingInboxTest: 0,
    emailExperimentsActive: 0,
    emailExperimentsReadyToClose: 0,
    emailExperimentUnenrolled: 0,
    callExperimentsPrepared: 0,
    callExperimentsActive: 0,
    callExperimentsReadyToClose: 0,
    callExperimentUnenrolled: 0,
    closedExperiments: 0,
    learningCandidatesPending: 0,
    learningCandidatesApproved: 0,
    learningCandidatesApprovedUnapplied: 0,
    ...update,
  };
}

function connections(
  available = false
): ProspectRevenueLoopConnections {
  const connection = {
    configured: available,
    enabled: available,
    availableForWorkspace: available,
    missing: available ? [] : ["SYNTHETIC_CONFIG"],
  };
  return {
    velvetDiscovery: { ...connection },
    velvetSource: { ...connection },
    advisoryQc: { ...connection },
    emailProvider: { ...connection },
    emailWebhook: { ...connection },
    inboxPlacement: { ...connection },
    velvetOutcome: { ...connection },
  };
}

function connectionsWithout(
  key: keyof ProspectRevenueLoopConnections
): ProspectRevenueLoopConnections {
  const result = connections(true);
  result[key] = {
    configured: false,
    enabled: false,
    availableForWorkspace: false,
    missing: [`SYNTHETIC_${key.toUpperCase()}_CONFIG`],
  };
  return result;
}

test("an empty loop names the exact discovery configuration gate", () => {
  const status = buildProspectRevenueLoopStatus({
    counts: counts(),
    connections: connections(),
  });
  assert.equal(
    status.nextAction.code,
    "CONFIGURE_VELVET_DISCOVERY"
  );
  assert.deepEqual(status.guardrails, {
    smsAllowed: false,
    bulkExecutionAllowed: false,
    automatedProspectDialingAllowed: false,
    qcMayAuthorizeContact: false,
    learningMayMutateRuntimePolicy: false,
  });
  assert.equal(status.externalAction, "none");
});

test("discovery and reviewed-source states preserve separate gates", () => {
  const readyConnections = connections(true);
  assert.equal(
    deriveProspectRevenueLoopNextAction(
      counts({ discoveryPrepared: 1 }),
      readyConnections
    ).code,
    "APPROVE_VELVET_DISCOVERY"
  );
  assert.equal(
    deriveProspectRevenueLoopNextAction(
      counts({ discoveryApproved: 1 }),
      readyConnections
    ).code,
    "DISPATCH_VELVET_DISCOVERY"
  );
  assert.equal(
    deriveProspectRevenueLoopNextAction(
      counts({ discoveryInFlight: 1 }),
      readyConnections
    ).code,
    "REFRESH_VELVET_DISCOVERY"
  );
  assert.equal(
    deriveProspectRevenueLoopNextAction(
      counts({ discoveryReadyForImport: 1 }),
      readyConnections
    ).code,
    "PREPARE_DISCOVERY_IMPORT"
  );
  assert.equal(
    deriveProspectRevenueLoopNextAction(
      counts({ sourcePrepared: 1 }),
      readyConnections
    ).code,
    "APPROVE_VELVET_SOURCE"
  );
  assert.equal(
    deriveProspectRevenueLoopNextAction(
      counts({ sourceApproved: 1 }),
      readyConnections
    ).code,
    "DISPATCH_VELVET_SOURCE"
  );
});

test("email leads cannot skip inbox proof or deterministic assignment", () => {
  const readyConnections = connections(true);
  const emailLead = {
    qualifiedLeads: 1,
    qualifiedEmailLeadsWithoutOutreach: 1,
  };
  const noInbox = connections(true);
  noInbox.inboxPlacement = {
    configured: false,
    enabled: true,
    availableForWorkspace: false,
    missing: ["PROSPECT_INBOX_SEED_ALLOWLIST"],
  };
  assert.equal(
    deriveProspectRevenueLoopNextAction(
      counts(emailLead),
      noInbox
    ).code,
    "CONFIGURE_INBOX_PLACEMENT"
  );
  assert.equal(
    deriveProspectRevenueLoopNextAction(
      counts(emailLead),
      readyConnections
    ).code,
    "PREPARE_INBOX_PLACEMENT"
  );
  assert.equal(
    deriveProspectRevenueLoopNextAction(
      counts({ ...emailLead, passingInboxTests: 1 }),
      readyConnections
    ).code,
    "PREPARE_EMAIL_EXPERIMENT"
  );
  assert.equal(
    deriveProspectRevenueLoopNextAction(
      counts({
        ...emailLead,
        passingInboxTests: 1,
        emailExperimentsPrepared: 1,
      }),
      readyConnections
    ).code,
    "PREPARE_INBOX_PLACEMENT"
  );
  assert.equal(
    deriveProspectRevenueLoopNextAction(
      counts({
        ...emailLead,
        passingInboxTests: 1,
        emailExperimentsPrepared: 1,
        emailExperimentsPreparedWithMatchingInboxTest: 1,
      }),
      readyConnections
    ).code,
    "ACTIVATE_EMAIL_EXPERIMENT"
  );
  assert.equal(
    deriveProspectRevenueLoopNextAction(
      counts({
        ...emailLead,
        passingInboxTests: 1,
        emailExperimentsActive: 1,
        emailExperimentUnenrolled: 20,
      }),
      readyConnections
    ).code,
    "PREPARE_EXPERIMENT_DRAFTS"
  );
  assert.equal(
    deriveProspectRevenueLoopNextAction(
      counts({
        emailExperimentsActive: 1,
        emailExperimentsReadyToClose: 1,
        emailExperimentUnenrolled: 0,
      }),
      readyConnections
    ).code,
    "CLOSE_ACTIVE_EXPERIMENT"
  );
});

test("controlled inbox work advances one observable seed at a time", () => {
  const readyConnections = connections(true);
  const openTest = { inboxPlacementOpenTests: 1 };

  const review = deriveProspectRevenueLoopNextAction(
    counts({ ...openTest, inboxSeedPrepared: 5 }),
    readyConnections
  );
  assert.equal(review.code, "REVIEW_CONTROLLED_INBOX_SEED");
  assert.equal(review.executionEffect, "none");
  assert.equal(review.requiresSeparateExecutionConfirmation, false);

  const send = deriveProspectRevenueLoopNextAction(
    counts({
      ...openTest,
      inboxSeedPrepared: 4,
      inboxSeedApproved: 1,
    }),
    readyConnections
  );
  assert.equal(send.code, "SEND_ONE_CONTROLLED_INBOX_SEED");
  assert.equal(send.executionEffect, "one_controlled_seed_email");
  assert.equal(send.requiresHumanApproval, true);
  assert.equal(send.requiresSeparateExecutionConfirmation, true);

  const inspect = deriveProspectRevenueLoopNextAction(
    counts({
      ...openTest,
      inboxSeedPrepared: 4,
      inboxSeedSentAwaitingInspection: 1,
    }),
    readyConnections
  );
  assert.equal(inspect.code, "INSPECT_CONTROLLED_INBOX_SEED");
  assert.equal(inspect.executionEffect, "none");

  const finalize = deriveProspectRevenueLoopNextAction(
    counts({
      ...openTest,
      inboxSeedInspected: 5,
      inboxPlacementReadyToFinalize: 1,
    }),
    readyConnections
  );
  assert.equal(finalize.code, "FINALIZE_INBOX_PLACEMENT");
  assert.equal(finalize.executionEffect, "none");

  const paused = deriveProspectRevenueLoopNextAction(
    counts({
      ...openTest,
      inboxSeedApproved: 1,
      positiveOutcomeJobs: 1,
      unreviewedPositiveOutcomeJobs: 1,
    }),
    readyConnections
  );
  assert.equal(paused.code, "REVIEW_POSITIVE_OUTCOME");
});

test("approved contact remains one-recipient and separately confirmed", () => {
  const readyConnections = connections(true);
  const email = deriveProspectRevenueLoopNextAction(
    counts({ outreachApprovedEmail: 1 }),
    readyConnections
  );
  assert.equal(email.code, "SEND_ONE_APPROVED_EMAIL");
  assert.equal(email.executionEffect, "one_email");
  assert.equal(email.requiresHumanApproval, true);
  assert.equal(email.requiresSeparateExecutionConfirmation, true);

  const call = deriveProspectRevenueLoopNextAction(
    counts({ outreachApprovedCall: 1 }),
    readyConnections
  );
  assert.equal(call.code, "MANUALLY_DIAL_ONE_APPROVED_CALL");
  assert.equal(call.executionEffect, "one_manual_call");
  assert.match(call.detail, /SMIRK will not auto-dial/);
});

test("recipient review and email execution require the QC and measurement connections", () => {
  assert.equal(
    deriveProspectRevenueLoopNextAction(
      counts({ outreachPrepared: 1 }),
      connectionsWithout("advisoryQc")
    ).code,
    "CONFIGURE_ADVISORY_QC"
  );
  assert.equal(
    deriveProspectRevenueLoopNextAction(
      counts({ outreachApprovedCall: 1 }),
      connectionsWithout("advisoryQc")
    ).code,
    "CONFIGURE_ADVISORY_QC"
  );
  assert.equal(
    deriveProspectRevenueLoopNextAction(
      counts({ outreachApprovedEmail: 1 }),
      connectionsWithout("emailWebhook")
    ).code,
    "CONFIGURE_EMAIL_OUTCOME_WEBHOOK"
  );
  assert.equal(
    deriveProspectRevenueLoopNextAction(
      counts({
        outreachSentWithoutOutcome: 1,
        outreachSentEmailWithoutOutcome: 1,
      }),
      connectionsWithout("emailWebhook")
    ).code,
    "CONFIGURE_EMAIL_OUTCOME_WEBHOOK"
  );
  assert.equal(
    deriveProspectRevenueLoopNextAction(
      counts({
        outreachSentWithoutOutcome: 1,
        outreachSentCallWithoutOutcome: 1,
      }),
      connectionsWithout("emailWebhook")
    ).code,
    "WAIT_FOR_MEASURED_OUTCOME"
  );
});

test("failed deterministic QC is revised before more outreach is prepared", () => {
  const next = deriveProspectRevenueLoopNextAction(
    counts({
      qcRevisionsRequired: 2,
      qualifiedEmailLeadsWithoutOutreach: 20,
      discoveryPrepared: 1,
    }),
    connections(true)
  );
  assert.equal(next.code, "REVISE_RECIPIENT_OUTREACH");
  assert.equal(next.executionEffect, "none");
  assert.equal(next.requiresHumanApproval, true);
  assert.equal(next.requiresSeparateExecutionConfirmation, false);
  assert.match(next.detail, /No approval or provider authority/);
});

test("a measured interaction pauses acquisition before new work", () => {
  const next = deriveProspectRevenueLoopNextAction(
    counts({
      positiveOutcomeJobs: 2,
      unreviewedPositiveOutcomeJobs: 2,
      sourceApproved: 1,
      qualifiedEmailLeadsWithoutOutreach: 10,
    }),
    connections(true)
  );
  assert.equal(next.code, "REVIEW_POSITIVE_OUTCOME");
  assert.equal(next.executionEffect, "none");
  assert.equal(next.requiresHumanApproval, true);
  assert.equal(next.requiresSeparateExecutionConfirmation, false);
  assert.equal(next.target, "revenue-loop-positive-review");
  assert.match(
    next.detail,
    /2 market interaction review items require attention/
  );
});

test("acknowledged historical positives remain measured without a permanent stop", () => {
  const next = deriveProspectRevenueLoopNextAction(
    counts({
      outcomeEvents: 4,
      positiveOutcomeJobs: 2,
      unreviewedPositiveOutcomeJobs: 0,
      discoveryPrepared: 1,
    }),
    connections(true)
  );
  assert.equal(next.code, "APPROVE_VELVET_DISCOVERY");
});

test("positive review pauses new callback, closure, and sourcing work", () => {
  const readyConnections = connections(true);
  const callback = deriveProspectRevenueLoopNextAction(
    counts({
      velvetCallbacksPrepared: 1,
      positiveOutcomeJobs: 1,
      unreviewedPositiveOutcomeJobs: 1,
      discoveryPrepared: 1,
      pendingReviewLeads: 1,
    }),
    readyConnections
  );
  assert.equal(callback.code, "REVIEW_POSITIVE_OUTCOME");
  assert.equal(callback.executionEffect, "none");

  const acknowledgedCallback =
    deriveProspectRevenueLoopNextAction(
      counts({
        velvetCallbacksPrepared: 1,
        positiveOutcomeJobs: 1,
        unreviewedPositiveOutcomeJobs: 0,
        discoveryPrepared: 1,
      }),
      readyConnections
    );
  assert.equal(
    acknowledgedCallback.code,
    "DISPATCH_ONE_VELVET_OUTCOME"
  );
  assert.equal(
    acknowledgedCallback.executionEffect,
    "one_velvet_callback"
  );

  const close = deriveProspectRevenueLoopNextAction(
    counts({
      emailExperimentsActive: 1,
      emailExperimentsReadyToClose: 1,
      emailExperimentUnenrolled: 0,
      positiveOutcomeJobs: 1,
      discoveryPrepared: 1,
    }),
    readyConnections
  );
  assert.equal(close.code, "CLOSE_ACTIVE_EXPERIMENT");
  assert.equal(close.executionEffect, "none");

  const candidate = deriveProspectRevenueLoopNextAction(
    counts({
      learningCandidatesPending: 1,
      discoveryPrepared: 1,
    }),
    readyConnections
  );
  assert.equal(candidate.code, "REVIEW_LEARNING_CANDIDATE");
  assert.equal(candidate.executionEffect, "none");

  const releasedControl = deriveProspectRevenueLoopNextAction(
    counts({
      learningCandidatesApproved: 1,
      learningCandidatesApprovedUnapplied: 1,
      discoveryPrepared: 1,
    }),
    readyConnections
  );
  assert.equal(releasedControl.code, "APPLY_MESSAGE_POLICY");
  assert.equal(releasedControl.executionEffect, "none");
  assert.match(releasedControl.detail, /does not authorize contact or spend/);
});

test("active experiments cannot advertise closure before the durable terminal-job preflight", () => {
  const readyConnections = connections(true);
  const pending = deriveProspectRevenueLoopNextAction(
    counts({
      emailExperimentsActive: 1,
      emailExperimentUnenrolled: 0,
      outreachPrepared: 1,
      positiveOutcomeJobs: 1,
    }),
    readyConnections
  );
  assert.equal(pending.code, "REVIEW_RECIPIENT_OUTREACH");

  const outcomePending = deriveProspectRevenueLoopNextAction(
    counts({
      emailExperimentsActive: 1,
      emailExperimentsReadyToClose: 1,
      emailExperimentUnenrolled: 0,
      outreachSentWithoutOutcome: 1,
      outreachSentEmailWithoutOutcome: 1,
      positiveOutcomeJobs: 1,
    }),
    readyConnections
  );
  assert.equal(outcomePending.code, "WAIT_FOR_MEASURED_OUTCOME");

  const drift = deriveProspectRevenueLoopNextAction(
    counts({
      emailExperimentsActive: 1,
      emailExperimentUnenrolled: 0,
    }),
    readyConnections
  );
  assert.equal(drift.code, "RECONCILE_ACTIVE_EXPERIMENT");
  assert.match(drift.detail, /durable closure preflight/);

  const ready = deriveProspectRevenueLoopNextAction(
    counts({
      emailExperimentsActive: 1,
      emailExperimentsReadyToClose: 1,
      emailExperimentUnenrolled: 0,
    }),
    readyConnections
  );
  assert.equal(ready.code, "CLOSE_ACTIVE_EXPERIMENT");
});

test("uncertain provider state always wins over a new execution", () => {
  const next = deriveProspectRevenueLoopNextAction(
    counts({
      outreachSending: 1,
      outreachApprovedEmail: 1,
      discoveryPrepared: 1,
    }),
    connections(true)
  );
  assert.equal(next.code, "RECONCILE_EMAIL_PROVIDER");
  assert.equal(next.executionEffect, "none");
});

test("every controller action has a deterministic durable-state path", () => {
  const matrix: Record<
    ProspectRevenueLoopNextActionCode,
    {
      counts?: Partial<ProspectRevenueLoopCounts>;
      connections?: ProspectRevenueLoopConnections;
    }
  > = {
    CONFIGURE_VELVET_DISCOVERY: {
      connections: connectionsWithout("velvetDiscovery"),
    },
    PREPARE_VELVET_DISCOVERY: {},
    APPROVE_VELVET_DISCOVERY: {
      counts: { discoveryPrepared: 1 },
    },
    DISPATCH_VELVET_DISCOVERY: {
      counts: { discoveryApproved: 1 },
    },
    REFRESH_VELVET_DISCOVERY: {
      counts: { discoveryInFlight: 1 },
    },
    REVIEW_VELVET_DISCOVERY_FAILURE: {
      counts: { discoveryFailed: 1 },
    },
    PREPARE_DISCOVERY_IMPORT: {
      counts: { discoveryReadyForImport: 1 },
    },
    CONFIGURE_VELVET_SOURCE: {
      counts: { sourceApproved: 1 },
      connections: connectionsWithout("velvetSource"),
    },
    APPROVE_VELVET_SOURCE: {
      counts: { sourcePrepared: 1 },
    },
    DISPATCH_VELVET_SOURCE: {
      counts: { sourceApproved: 1 },
    },
    RECONCILE_VELVET_SOURCE: {
      counts: { sourceInFlight: 1 },
    },
    REVIEW_IMPORTED_PROSPECT: {
      counts: { pendingReviewLeads: 1 },
    },
    CONFIGURE_INBOX_PLACEMENT: {
      counts: {
        qualifiedLeads: 1,
        qualifiedEmailLeadsWithoutOutreach: 1,
      },
      connections: connectionsWithout("inboxPlacement"),
    },
    PREPARE_INBOX_PLACEMENT: {
      counts: {
        qualifiedLeads: 1,
        qualifiedEmailLeadsWithoutOutreach: 1,
      },
    },
    REVIEW_CONTROLLED_INBOX_SEED: {
      counts: {
        inboxPlacementOpenTests: 1,
        inboxSeedPrepared: 5,
      },
    },
    CONFIGURE_CONTROLLED_INBOX_EMAIL: {
      counts: {
        inboxPlacementOpenTests: 1,
        inboxSeedApproved: 1,
        inboxSeedPrepared: 4,
      },
      connections: connectionsWithout("emailProvider"),
    },
    SEND_ONE_CONTROLLED_INBOX_SEED: {
      counts: {
        inboxPlacementOpenTests: 1,
        inboxSeedApproved: 1,
        inboxSeedPrepared: 4,
      },
    },
    RECONCILE_CONTROLLED_INBOX_SEED: {
      counts: {
        inboxPlacementOpenTests: 1,
        inboxSeedSending: 1,
        inboxSeedPrepared: 4,
      },
    },
    INSPECT_CONTROLLED_INBOX_SEED: {
      counts: {
        inboxPlacementOpenTests: 1,
        inboxSeedSentAwaitingInspection: 1,
        inboxSeedPrepared: 4,
      },
    },
    FINALIZE_INBOX_PLACEMENT: {
      counts: {
        inboxPlacementOpenTests: 1,
        inboxSeedInspected: 5,
        inboxPlacementReadyToFinalize: 1,
      },
    },
    RECONCILE_INBOX_PLACEMENT: {
      counts: {
        inboxPlacementOpenTests: 1,
        inboxPlacementBlocked: 1,
      },
    },
    PREPARE_EMAIL_EXPERIMENT: {
      counts: {
        qualifiedLeads: 1,
        qualifiedEmailLeadsWithoutOutreach: 1,
        passingInboxTests: 1,
      },
    },
    ACTIVATE_EMAIL_EXPERIMENT: {
      counts: {
        qualifiedLeads: 1,
        qualifiedEmailLeadsWithoutOutreach: 1,
        passingInboxTests: 1,
        emailExperimentsPrepared: 1,
        emailExperimentsPreparedWithMatchingInboxTest: 1,
      },
    },
    PREPARE_CALL_EXPERIMENT: {
      counts: {
        qualifiedLeads: 1,
        qualifiedCallLeadsWithoutOutreach: 1,
      },
    },
    ACTIVATE_CALL_EXPERIMENT: {
      counts: {
        qualifiedLeads: 1,
        qualifiedCallLeadsWithoutOutreach: 1,
        callExperimentsPrepared: 1,
      },
    },
    PREPARE_EXPERIMENT_DRAFTS: {
      counts: {
        emailExperimentsActive: 1,
        emailExperimentUnenrolled: 20,
      },
    },
    CLOSE_ACTIVE_EXPERIMENT: {
      counts: {
        emailExperimentsActive: 1,
        emailExperimentsReadyToClose: 1,
      },
    },
    RECONCILE_ACTIVE_EXPERIMENT: {
      counts: { emailExperimentsActive: 1 },
    },
    REVISE_RECIPIENT_OUTREACH: {
      counts: { qcRevisionsRequired: 1 },
    },
    CONFIGURE_ADVISORY_QC: {
      counts: { outreachPrepared: 1 },
      connections: connectionsWithout("advisoryQc"),
    },
    REVIEW_RECIPIENT_OUTREACH: {
      counts: { outreachPrepared: 1 },
    },
    CONFIGURE_EMAIL_PROVIDER: {
      counts: { outreachApprovedEmail: 1 },
      connections: connectionsWithout("emailProvider"),
    },
    CONFIGURE_EMAIL_OUTCOME_WEBHOOK: {
      counts: { outreachApprovedEmail: 1 },
      connections: connectionsWithout("emailWebhook"),
    },
    SEND_ONE_APPROVED_EMAIL: {
      counts: { outreachApprovedEmail: 1 },
    },
    MANUALLY_DIAL_ONE_APPROVED_CALL: {
      counts: { outreachApprovedCall: 1 },
    },
    RECONCILE_EMAIL_PROVIDER: {
      counts: { outreachSending: 1 },
    },
    WAIT_FOR_MEASURED_OUTCOME: {
      counts: { outreachSentWithoutOutcome: 1 },
    },
    REVIEW_POSITIVE_OUTCOME: {
      counts: {
        positiveOutcomeJobs: 1,
        unreviewedPositiveOutcomeJobs: 1,
      },
    },
    CONFIGURE_VELVET_OUTCOME: {
      counts: { velvetCallbacksPrepared: 1 },
      connections: connectionsWithout("velvetOutcome"),
    },
    DISPATCH_ONE_VELVET_OUTCOME: {
      counts: { velvetCallbacksPrepared: 1 },
    },
    RECONCILE_VELVET_OUTCOME: {
      counts: { velvetCallbacksSending: 1 },
    },
    REVIEW_LEARNING_CANDIDATE: {
      counts: { learningCandidatesPending: 1 },
    },
    APPLY_MESSAGE_POLICY: {
      counts: {
        learningCandidatesApproved: 1,
        learningCandidatesApprovedUnapplied: 1,
      },
    },
  };

  for (const [expected, scenario] of Object.entries(matrix) as Array<
    [
      ProspectRevenueLoopNextActionCode,
      (typeof matrix)[ProspectRevenueLoopNextActionCode],
    ]
  >) {
    assert.equal(
      deriveProspectRevenueLoopNextAction(
        counts(scenario.counts),
        scenario.connections || connections(true)
      ).code,
      expected,
      expected
    );
  }
});
