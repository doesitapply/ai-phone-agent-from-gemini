export const PROSPECT_REVENUE_LOOP_CONTRACT_VERSION =
  "smirk.prospect-revenue-loop.v11" as const;

export type ProspectRevenueLoopConnection = {
  configured: boolean;
  enabled: boolean;
  availableForWorkspace: boolean;
  missing: string[];
};

export type ProspectRevenueLoopConnections = {
  velvetDiscovery: ProspectRevenueLoopConnection;
  velvetSource: ProspectRevenueLoopConnection;
  advisoryQc: ProspectRevenueLoopConnection;
  emailProvider: ProspectRevenueLoopConnection;
  emailWebhook: ProspectRevenueLoopConnection;
  emailReceiving: ProspectRevenueLoopConnection;
  inboxPlacement: ProspectRevenueLoopConnection;
  velvetOutcome: ProspectRevenueLoopConnection;
};

export type ProspectRevenueLoopCounts = {
  campaigns: number;
  discoveryPrepared: number;
  discoveryApproved: number;
  discoveryInFlight: number;
  discoveryReadyForImport: number;
  discoveryFailed: number;
  sourcePrepared: number;
  sourceApproved: number;
  sourceInFlight: number;
  pendingReviewLeads: number;
  qualifiedLeads: number;
  qualifiedEmailLeadsWithoutOutreach: number;
  qualifiedCallLeadsWithoutOutreach: number;
  qcRevisionsRequired: number;
  outreachPrepared: number;
  outreachApprovedEmail: number;
  outreachApprovedCall: number;
  outreachSending: number;
  outreachSentWithoutOutcome: number;
  outreachSentEmailWithoutOutcome: number;
  outreachSentCallWithoutOutcome: number;
  outcomeEvents: number;
  positiveOutcomeJobs: number;
  unreviewedPositiveOutcomeJobs: number;
  velvetCallbacksPrepared: number;
  velvetCallbacksSending: number;
  passingInboxTests: number;
  inboxPlacementOpenTests: number;
  inboxSeedPrepared: number;
  inboxSeedApproved: number;
  inboxSeedSending: number;
  inboxSeedSentAwaitingInspection: number;
  inboxSeedInspected: number;
  inboxPlacementReadyToFinalize: number;
  inboxPlacementBlocked: number;
  emailExperimentsPrepared: number;
  emailExperimentsPreparedWithMatchingInboxTest: number;
  emailExperimentsActive: number;
  emailExperimentsReadyToClose: number;
  emailExperimentUnenrolled: number;
  callExperimentsPrepared: number;
  callExperimentsActive: number;
  callExperimentsReadyToClose: number;
  callExperimentUnenrolled: number;
  closedExperiments: number;
  learningCandidatesPending: number;
  learningCandidatesApproved: number;
  learningCandidatesApprovedUnapplied: number;
};

export type ProspectRevenueLoopStage =
  | "source"
  | "review"
  | "experiment"
  | "outreach"
  | "feedback"
  | "learning"
  | "configuration";

export type ProspectRevenueLoopNextActionCode =
  | "CONFIGURE_VELVET_DISCOVERY"
  | "PREPARE_VELVET_DISCOVERY"
  | "APPROVE_VELVET_DISCOVERY"
  | "DISPATCH_VELVET_DISCOVERY"
  | "REFRESH_VELVET_DISCOVERY"
  | "REVIEW_VELVET_DISCOVERY_FAILURE"
  | "PREPARE_DISCOVERY_IMPORT"
  | "CONFIGURE_VELVET_SOURCE"
  | "APPROVE_VELVET_SOURCE"
  | "DISPATCH_VELVET_SOURCE"
  | "RECONCILE_VELVET_SOURCE"
  | "REVIEW_IMPORTED_PROSPECT"
  | "CONFIGURE_INBOX_PLACEMENT"
  | "PREPARE_INBOX_PLACEMENT"
  | "REVIEW_CONTROLLED_INBOX_SEED"
  | "CONFIGURE_CONTROLLED_INBOX_EMAIL"
  | "SEND_ONE_CONTROLLED_INBOX_SEED"
  | "RECONCILE_CONTROLLED_INBOX_SEED"
  | "INSPECT_CONTROLLED_INBOX_SEED"
  | "FINALIZE_INBOX_PLACEMENT"
  | "RECONCILE_INBOX_PLACEMENT"
  | "PREPARE_EMAIL_EXPERIMENT"
  | "ACTIVATE_EMAIL_EXPERIMENT"
  | "PREPARE_CALL_EXPERIMENT"
  | "ACTIVATE_CALL_EXPERIMENT"
  | "PREPARE_EXPERIMENT_DRAFTS"
  | "CLOSE_ACTIVE_EXPERIMENT"
  | "RECONCILE_ACTIVE_EXPERIMENT"
  | "REVISE_RECIPIENT_OUTREACH"
  | "CONFIGURE_ADVISORY_QC"
  | "REVIEW_RECIPIENT_OUTREACH"
  | "CONFIGURE_EMAIL_PROVIDER"
  | "CONFIGURE_EMAIL_OUTCOME_WEBHOOK"
  | "CONFIGURE_EMAIL_RECEIVING"
  | "SEND_ONE_APPROVED_EMAIL"
  | "MANUALLY_DIAL_ONE_APPROVED_CALL"
  | "RECONCILE_EMAIL_PROVIDER"
  | "WAIT_FOR_MEASURED_OUTCOME"
  | "REVIEW_POSITIVE_OUTCOME"
  | "CONFIGURE_VELVET_OUTCOME"
  | "DISPATCH_ONE_VELVET_OUTCOME"
  | "RECONCILE_VELVET_OUTCOME"
  | "REVIEW_LEARNING_CANDIDATE"
  | "APPLY_MESSAGE_POLICY";

export type ProspectRevenueLoopNextAction = {
  code: ProspectRevenueLoopNextActionCode;
  stage: ProspectRevenueLoopStage;
  title: string;
  detail: string;
  target: string;
  requiresHumanApproval: boolean;
  requiresSeparateExecutionConfirmation: boolean;
  executionEffect:
    | "none"
    | "one_velvet_request"
    | "one_email"
    | "one_controlled_seed_email"
    | "one_manual_call"
    | "one_velvet_callback";
  focus?:
    | {
        kind: "prospect";
        campaignId: number;
        leadId: number;
        approvalId?: string;
        revisionId?: string;
      }
    | {
        kind: "positive_outcome_review";
        reviewId: string;
      }
    | {
        kind: "learning_candidate";
        candidateId: number;
      }
    | {
        kind: "velvet_outcome";
        outboxId: number;
      }
    | {
        kind: "velvet_source_request";
        requestId: number;
      }
    | {
        kind: "velvet_discovery_request";
        requestId: number;
      }
    | {
        kind: "message_experiment";
        experimentId: string;
        campaignId: number;
      }
    | {
        kind: "inbox_placement";
        testId: string;
        campaignId: number;
        approvalId?: string;
      };
};

export type ProspectRevenueLoopStageStatus = {
  id: Exclude<ProspectRevenueLoopStage, "configuration">;
  label: string;
  state: "WAITING" | "ACTION_REQUIRED" | "READY" | "MEASURED";
  count: number;
};

export type ProspectRevenueLoopStatus = {
  contractVersion: typeof PROSPECT_REVENUE_LOOP_CONTRACT_VERSION;
  mode: "guarded-human-approval";
  counts: ProspectRevenueLoopCounts;
  connections: ProspectRevenueLoopConnections;
  stages: ProspectRevenueLoopStageStatus[];
  nextAction: ProspectRevenueLoopNextAction;
  guardrails: {
    smsAllowed: false;
    bulkExecutionAllowed: false;
    automatedProspectDialingAllowed: false;
    qcMayAuthorizeContact: false;
    learningMayMutateRuntimePolicy: false;
  };
  externalAction: "none";
};

function action(
  input: ProspectRevenueLoopNextAction
): ProspectRevenueLoopNextAction {
  return input;
}

export function deriveProspectRevenueLoopNextAction(
  counts: ProspectRevenueLoopCounts,
  connections: ProspectRevenueLoopConnections
): ProspectRevenueLoopNextAction {
  if (counts.outreachSending > 0) {
    return action({
      code: "RECONCILE_EMAIL_PROVIDER",
      stage: "outreach",
      title: "Reconcile the uncertain email request",
      detail:
        "One provider request is still SENDING. Inspect its durable provider state before any retry.",
      target: "revenue-loop-outreach",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: true,
      executionEffect: "none",
    });
  }
  if (counts.inboxSeedSending > 0) {
    return action({
      code: "RECONCILE_CONTROLLED_INBOX_SEED",
      stage: "experiment",
      title: "Reconcile the uncertain controlled seed",
      detail:
        "One controlled-mailbox provider request is still SENDING. Inspect its durable provider state before any retry or additional seed approval.",
      target: "revenue-loop-inbox",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: true,
      executionEffect: "none",
    });
  }
  if (counts.velvetCallbacksSending > 0) {
    return action({
      code: "RECONCILE_VELVET_OUTCOME",
      stage: "feedback",
      title: "Reconcile the Velvet outcome callback",
      detail:
        "A callback has an uncertain result. Inspect the stored idempotency receipt before retrying it.",
      target: "revenue-loop-feedback",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: true,
      executionEffect: "none",
    });
  }
  if (counts.unreviewedPositiveOutcomeJobs > 0) {
    return action({
      code: "REVIEW_POSITIVE_OUTCOME",
      stage: "feedback",
      title: "Market interaction detected: pause acquisition",
      detail:
        `${counts.unreviewedPositiveOutcomeJobs} market interaction review item${counts.unreviewedPositiveOutcomeJobs === 1 ? " requires" : "s require"} attention. Classify inbound email content or acknowledge the verified outcome before the guarded loop can resume.`,
      target: "revenue-loop-positive-review",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (counts.inboxSeedSentAwaitingInspection > 0) {
    return action({
      code: "INSPECT_CONTROLLED_INBOX_SEED",
      stage: "experiment",
      title: "Inspect one controlled seed mailbox",
      detail:
        "Open the exact controlled mailbox, verify folder placement and raw authentication headers, then record one immutable inspection. This performs no external send.",
      target: "revenue-loop-inbox",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (counts.inboxSeedApproved > 0) {
    if (!connections.emailProvider.availableForWorkspace) {
      return action({
        code: "CONFIGURE_CONTROLLED_INBOX_EMAIL",
        stage: "configuration",
        title: "Configure the bounded controlled-seed provider",
        detail:
          "One controlled seed is approved, but the dedicated email key, sender, workspace lock, caps, or execution switch is unavailable. Configuration is not send approval.",
        target: "revenue-loop-inbox",
        requiresHumanApproval: true,
        requiresSeparateExecutionConfirmation: false,
        executionEffect: "none",
      });
    }
    return action({
      code: "SEND_ONE_CONTROLLED_INBOX_SEED",
      stage: "experiment",
      title: "Confirm one controlled seed email",
      detail:
        "Review the exact allowlisted mailbox and immutable payload again, then submit one bounded provider request. This is not prospect outreach.",
      target: "revenue-loop-inbox",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: true,
      executionEffect: "one_controlled_seed_email",
    });
  }
  if (counts.inboxSeedPrepared > 0) {
    return action({
      code: "REVIEW_CONTROLLED_INBOX_SEED",
      stage: "experiment",
      title: "Review one controlled seed draft",
      detail:
        "Inspect one allowlisted mailbox, exact copy, QC receipt, sender, footer, opt-out, and cost ceiling before approving or rejecting only that seed.",
      target: "revenue-loop-inbox",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (counts.inboxPlacementReadyToFinalize > 0) {
    return action({
      code: "FINALIZE_INBOX_PLACEMENT",
      stage: "experiment",
      title: "Finalize the controlled inbox receipt",
      detail:
        "All five controlled emails have immutable mailbox inspections. Recheck the evidence and finalize PASS or FAIL without authorizing prospect contact.",
      target: "revenue-loop-inbox",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (
    counts.inboxPlacementOpenTests > 0 ||
    counts.inboxPlacementBlocked > 0
  ) {
    return action({
      code: "RECONCILE_INBOX_PLACEMENT",
      stage: "experiment",
      title: "Resolve the controlled inbox test",
      detail:
        "The open test has no safe next seed action or contains a terminal item. Inspect or cancel the exact test before preparing another one.",
      target: "revenue-loop-inbox",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (counts.velvetCallbacksPrepared > 0) {
    if (!connections.velvetOutcome.availableForWorkspace) {
      return action({
        code: "CONFIGURE_VELVET_OUTCOME",
        stage: "configuration",
        title: "Configure the signed Velvet outcome connection",
        detail:
          "Measured outcomes are waiting, but the dedicated callback key, signing secret, workspace lock, or enable switch is unavailable.",
        target: "revenue-loop-feedback",
        requiresHumanApproval: true,
        requiresSeparateExecutionConfirmation: false,
        executionEffect: "none",
      });
    }
    return action({
      code: "DISPATCH_ONE_VELVET_OUTCOME",
      stage: "feedback",
      title: "Return one measured outcome to Velvet",
      detail:
        "Review one signed callback payload and dispatch only that immutable outcome.",
      target: "revenue-loop-feedback",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: true,
      executionEffect: "one_velvet_callback",
    });
  }
  if (counts.learningCandidatesPending > 0) {
    return action({
      code: "REVIEW_LEARNING_CANDIDATE",
      stage: "learning",
      title: "Review the measured learning candidate",
      detail:
        "A closed assigned cohort has produced an advisory candidate. Approve or reject it without changing runtime policy automatically.",
      target: "revenue-loop-learning",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (counts.learningCandidatesApprovedUnapplied > 0) {
    return action({
      code: "APPLY_MESSAGE_POLICY",
      stage: "learning",
      title: "Release one approved winner as the next control",
      detail:
        "Review the approved candidate receipt and explicitly release it for future experiment control only. Existing drafts stay unchanged, and this does not authorize contact or spend.",
      target: "revenue-loop-learning",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (counts.qcRevisionsRequired > 0) {
    return action({
      code: "REVISE_RECIPIENT_OUTREACH",
      stage: "outreach",
      title: "Revise the failed recipient draft",
      detail:
        `${counts.qcRevisionsRequired} recipient-specific draft${counts.qcRevisionsRequired === 1 ? " is" : "s are"} held by deterministic QC. Correct or reject one immutable revision receipt before preparing more outreach. No approval or provider authority exists for these records.`,
      target: "revenue-loop-outreach",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (
    counts.outreachPrepared +
      counts.outreachApprovedEmail +
      counts.outreachApprovedCall >
      0 &&
    !connections.advisoryQc.availableForWorkspace
  ) {
    return action({
      code: "CONFIGURE_ADVISORY_QC",
      stage: "configuration",
      title: "Configure mandatory advisory QC",
      detail:
        "A recipient-specific draft is waiting, but the dedicated advisory model, workspace lock, review caps, enable switch, or required-for-approval policy is unavailable. Deterministic QC remains authoritative, and the model still cannot authorize contact.",
      target: "revenue-loop-outreach",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (counts.outreachApprovedEmail > 0) {
    if (!connections.emailProvider.availableForWorkspace) {
      return action({
        code: "CONFIGURE_EMAIL_PROVIDER",
        stage: "configuration",
        title: "Configure the bounded prospect email provider",
        detail:
          "An email is approved, but the dedicated Resend key, sender, workspace lock, caps, or execution switch is unavailable.",
        target: "revenue-loop-outreach",
        requiresHumanApproval: true,
        requiresSeparateExecutionConfirmation: false,
        executionEffect: "none",
      });
    }
    if (!connections.emailWebhook.availableForWorkspace) {
      return action({
        code: "CONFIGURE_EMAIL_OUTCOME_WEBHOOK",
        stage: "configuration",
        title: "Configure the signed email outcome webhook",
        detail:
          "An email is approved, but its workspace-locked signed delivery, bounce, complaint, suppression, and reply path is unavailable. Do not send an unmeasurable message.",
        target: "revenue-loop-outreach",
        requiresHumanApproval: true,
        requiresSeparateExecutionConfirmation: false,
        executionEffect: "none",
      });
    }
    if (!connections.emailReceiving.availableForWorkspace) {
      return action({
        code: "CONFIGURE_EMAIL_RECEIVING",
        stage: "configuration",
        title: "Configure exact inbound reply retrieval",
        detail:
          "An email is approved, but a full operator cannot yet retrieve and receipt the exact provider-backed plain text of a reply. Configure the dedicated GET-only code path before sending an email whose response cannot be safely classified.",
        target: "revenue-loop-feedback",
        requiresHumanApproval: true,
        requiresSeparateExecutionConfirmation: false,
        executionEffect: "none",
      });
    }
    return action({
      code: "SEND_ONE_APPROVED_EMAIL",
      stage: "outreach",
      title: "Confirm one approved email",
      detail:
        "Review the exact recipient and payload again, then submit one bounded provider request.",
      target: "revenue-loop-outreach",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: true,
      executionEffect: "one_email",
    });
  }
  if (counts.outreachApprovedCall > 0) {
    return action({
      code: "MANUALLY_DIAL_ONE_APPROVED_CALL",
      stage: "outreach",
      title: "Manually dial one approved call",
      detail:
        "Recheck DNC and local calling hours, dial manually, then record the exact call result. SMIRK will not auto-dial.",
      target: "revenue-loop-outreach",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: true,
      executionEffect: "one_manual_call",
    });
  }
  if (counts.outreachPrepared > 0) {
    return action({
      code: "REVIEW_RECIPIENT_OUTREACH",
      stage: "outreach",
      title: "Review one recipient-specific draft",
      detail:
        "Inspect the evidence, deterministic assignment, QC receipt, recipient, and compliance attestations before approving or rejecting it.",
      target: "revenue-loop-outreach",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (
    counts.outreachSentEmailWithoutOutcome > 0 &&
    !connections.emailWebhook.availableForWorkspace
  ) {
    return action({
      code: "CONFIGURE_EMAIL_OUTCOME_WEBHOOK",
      stage: "configuration",
      title: "Restore the signed email outcome webhook",
      detail:
        `${counts.outreachSentEmailWithoutOutcome} accepted email${counts.outreachSentEmailWithoutOutcome === 1 ? " has" : "s have"} no measured outcome while the signed workspace-locked webhook is unavailable. Restore that feedback path before treating the loop as observable.`,
      target: "revenue-loop-feedback",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (counts.outreachSentWithoutOutcome > 0) {
    return action({
      code: "WAIT_FOR_MEASURED_OUTCOME",
      stage: "feedback",
      title: "Capture the next measured outcome",
      detail:
        "At least one executed job has no measured result. Wait for a signed provider event or record one operator-observed call outcome.",
      target: "revenue-loop-feedback",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (counts.emailExperimentsActive > 0) {
    if (counts.emailExperimentUnenrolled > 0) {
      return action({
        code: "PREPARE_EXPERIMENT_DRAFTS",
        stage: "outreach",
        title: "Prepare the assigned email review queue",
        detail: `Prepare the ${counts.emailExperimentUnenrolled} remaining frozen assignments as recipient-specific drafts. This does not approve or send them.`,
        target: "revenue-loop-learning",
        requiresHumanApproval: true,
        requiresSeparateExecutionConfirmation: false,
        executionEffect: "none",
      });
    }
    if (counts.emailExperimentsReadyToClose > 0) {
      return action({
        code: "CLOSE_ACTIVE_EXPERIMENT",
        stage: "outreach",
        title: "Close the completed email experiment",
        detail:
          "The frozen cohort is exactly enrolled, every sent job has a measured outcome, and the seven-day window after the last email has elapsed. Review the durable closure evidence before closing it.",
        target: "revenue-loop-learning",
        requiresHumanApproval: true,
        requiresSeparateExecutionConfirmation: false,
        executionEffect: "none",
      });
    }
    return action({
      code: "RECONCILE_ACTIVE_EXPERIMENT",
      stage: "outreach",
      title: "Resolve the active email experiment",
      detail:
        "Every frozen assignment appears enrolled, but no active email experiment satisfies the durable closure preflight. Resolve pending jobs or inspect cohort drift before attempting closure.",
      target: "revenue-loop-learning",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (counts.callExperimentsActive > 0) {
    if (counts.callExperimentUnenrolled > 0) {
      return action({
        code: "PREPARE_EXPERIMENT_DRAFTS",
        stage: "outreach",
        title: "Prepare the assigned manual-call review queue",
        detail: `Prepare the ${counts.callExperimentUnenrolled} remaining frozen assignments as manual-dial-only briefs. This does not approve or dial them.`,
        target: "revenue-loop-learning",
        requiresHumanApproval: true,
        requiresSeparateExecutionConfirmation: false,
        executionEffect: "none",
      });
    }
    if (counts.callExperimentsReadyToClose > 0) {
      return action({
        code: "CLOSE_ACTIVE_EXPERIMENT",
        stage: "outreach",
        title: "Close the completed manual-call experiment",
        detail:
          "The frozen cohort is exactly enrolled, every sent job has a measured outcome, and the three-day window after the last manual call has elapsed. Review the durable closure evidence before closing it.",
        target: "revenue-loop-learning",
        requiresHumanApproval: true,
        requiresSeparateExecutionConfirmation: false,
        executionEffect: "none",
      });
    }
    return action({
      code: "RECONCILE_ACTIVE_EXPERIMENT",
      stage: "outreach",
      title: "Resolve the active manual-call experiment",
      detail:
        "Every frozen assignment appears enrolled, but no active manual-call experiment satisfies the durable closure preflight. Resolve pending jobs or inspect cohort drift before attempting closure.",
      target: "revenue-loop-learning",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (counts.qualifiedEmailLeadsWithoutOutreach > 0) {
    if (counts.emailExperimentsPrepared > 0) {
      if (
        counts.emailExperimentsPreparedWithMatchingInboxTest >
        0
      ) {
        return action({
          code: "ACTIVATE_EMAIL_EXPERIMENT",
          stage: "experiment",
          title: "Verify and activate the reviewed email experiment",
          detail:
            "A fresh PASS record matches the prepared campaign and exact control/challenger strategies. Activation will revalidate the immutable receipt before changing state and still authorizes no contact.",
          target: "revenue-loop-learning",
          requiresHumanApproval: true,
          requiresSeparateExecutionConfirmation: false,
          executionEffect: "none",
        });
      }
      return action({
        code: connections.inboxPlacement.availableForWorkspace
          ? "PREPARE_INBOX_PLACEMENT"
          : "CONFIGURE_INBOX_PLACEMENT",
        stage: connections.inboxPlacement.availableForWorkspace
          ? "experiment"
          : "configuration",
        title: connections.inboxPlacement.availableForWorkspace
          ? "Run the exact prepared-experiment inbox gate"
          : "Configure the controlled inbox allowlist",
        detail: connections.inboxPlacement.availableForWorkspace
          ? "No fresh PASS record matches the prepared campaign and exact control/challenger strategies. Unrelated inbox tests cannot authorize activation."
          : "Configure exactly five controlled mailboxes before the prepared email experiment can receive its matching inbox-placement receipt.",
        target: "revenue-loop-inbox",
        requiresHumanApproval: true,
        requiresSeparateExecutionConfirmation:
          connections.inboxPlacement.availableForWorkspace,
        executionEffect: "none",
      });
    }
    if (counts.passingInboxTests === 0) {
      return action({
        code: connections.inboxPlacement.availableForWorkspace
          ? "PREPARE_INBOX_PLACEMENT"
          : "CONFIGURE_INBOX_PLACEMENT",
        stage: connections.inboxPlacement.availableForWorkspace
          ? "experiment"
          : "configuration",
        title: connections.inboxPlacement.availableForWorkspace
          ? "Run the controlled five-inbox placement gate"
          : "Configure the controlled inbox allowlist",
        detail: connections.inboxPlacement.availableForWorkspace
          ? "Prove the exact two email variants across the 2/2/1 mailbox array before activating real-prospect assignment."
          : "Configure exactly five controlled mailboxes before any real-prospect email experiment can activate.",
        target: "revenue-loop-inbox",
        requiresHumanApproval: true,
        requiresSeparateExecutionConfirmation:
          connections.inboxPlacement.availableForWorkspace,
        executionEffect: "none",
      });
    }
    return action({
      code: "PREPARE_EMAIL_EXPERIMENT",
      stage: "experiment",
      title: "Prepare the deterministic email experiment",
      detail:
        "Select two registered transparent variants for the campaign. Preparation creates no outreach.",
      target: "revenue-loop-learning",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (counts.qualifiedCallLeadsWithoutOutreach > 0) {
    if (counts.callExperimentsPrepared > 0) {
      return action({
        code: "ACTIVATE_CALL_EXPERIMENT",
        stage: "experiment",
        title: "Activate the reviewed manual-call experiment",
        detail:
          "Activate immutable 50/50 assignment for manual call briefs. Automated dialing remains disabled.",
        target: "revenue-loop-learning",
        requiresHumanApproval: true,
        requiresSeparateExecutionConfirmation: false,
        executionEffect: "none",
      });
    }
    return action({
      code: "PREPARE_CALL_EXPERIMENT",
      stage: "experiment",
      title: "Prepare the deterministic manual-call experiment",
      detail:
        "Select two registered call briefs for the campaign. Preparation does not dial or authorize contact.",
      target: "revenue-loop-learning",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (counts.pendingReviewLeads > 0) {
    return action({
      code: "REVIEW_IMPORTED_PROSPECT",
      stage: "review",
      title: "Review one imported prospect",
      detail:
        "Verify its public evidence and contact provenance, then qualify or reject it before any draft exists.",
      target: "revenue-loop-review",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (counts.sourceInFlight > 0) {
    return action({
      code: "RECONCILE_VELVET_SOURCE",
      stage: "source",
      title: "Reconcile the reviewed lead pull",
      detail:
        "A source request is SENDING or PARTIAL. Inspect its durable response and retry only the exact missing work.",
      target: "revenue-loop-source",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: true,
      executionEffect: "none",
    });
  }
  if (counts.sourceApproved > 0) {
    if (!connections.velvetSource.availableForWorkspace) {
      return action({
        code: "CONFIGURE_VELVET_SOURCE",
        stage: "configuration",
        title: "Configure the reviewed Velvet lead feed",
        detail:
          "A pull is approved, but the dedicated research key, workspace lock, or source enable switch is unavailable.",
        target: "revenue-loop-source",
        requiresHumanApproval: true,
        requiresSeparateExecutionConfirmation: false,
        executionEffect: "none",
      });
    }
    return action({
      code: "DISPATCH_VELVET_SOURCE",
      stage: "source",
      title: "Pull one reviewed lead batch from Velvet",
      detail:
        "Dispatch the exact zero-spend, no-contact request and import only its audited receipts.",
      target: "revenue-loop-source",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: true,
      executionEffect: "one_velvet_request",
    });
  }
  if (counts.sourcePrepared > 0) {
    return action({
      code: "APPROVE_VELVET_SOURCE",
      stage: "source",
      title: "Review the prepared Velvet lead pull",
      detail:
        "Approve one immutable zero-spend, no-contact inventory request before dispatch.",
      target: "revenue-loop-source",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (counts.discoveryReadyForImport > 0) {
    return action({
      code: "PREPARE_DISCOVERY_IMPORT",
      stage: "source",
      title: "Prepare the discovery-bound reviewed pull",
      detail:
        "Velvet reports reviewed leads ready. Prepare a separate source request bound to that exact discovery receipt.",
      target: "revenue-loop-source",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (counts.discoveryInFlight > 0) {
    return action({
      code: "REFRESH_VELVET_DISCOVERY",
      stage: "source",
      title: "Refresh the exact Velvet discovery status",
      detail:
        "The quote or discovery is in progress. Refresh its immutable status without importing or contacting anyone.",
      target: "revenue-loop-source",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "one_velvet_request",
    });
  }
  if (counts.discoveryApproved > 0) {
    if (!connections.velvetDiscovery.availableForWorkspace) {
      return action({
        code: "CONFIGURE_VELVET_DISCOVERY",
        stage: "configuration",
        title: "Configure Velvet discovery",
        detail:
          "A request is approved, but the dedicated research key, workspace lock, or discovery enable switch is unavailable.",
        target: "revenue-loop-source",
        requiresHumanApproval: true,
        requiresSeparateExecutionConfirmation: false,
        executionEffect: "none",
      });
    }
    return action({
      code: "DISPATCH_VELVET_DISCOVERY",
      stage: "source",
      title: "Submit one discovery quote request to Velvet",
      detail:
        "Submit the exact no-contact quote. Provider spend still requires separate approval inside Velvet.",
      target: "revenue-loop-source",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: true,
      executionEffect: "one_velvet_request",
    });
  }
  if (counts.discoveryPrepared > 0) {
    return action({
      code: "APPROVE_VELVET_DISCOVERY",
      stage: "source",
      title: "Review the prepared Velvet discovery request",
      detail:
        "Approve only the immutable no-contact quote request. This does not approve provider spend.",
      target: "revenue-loop-source",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (counts.discoveryFailed > 0) {
    return action({
      code: "REVIEW_VELVET_DISCOVERY_FAILURE",
      stage: "source",
      title: "Review the failed discovery receipt",
      detail:
        "Inspect the durable failure before preparing a changed request. Do not retry uncertain work with new bytes.",
      target: "revenue-loop-source",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  if (!connections.velvetDiscovery.availableForWorkspace) {
    return action({
      code: "CONFIGURE_VELVET_DISCOVERY",
      stage: "configuration",
      title: "Configure Velvet discovery",
      detail:
        "Set the dedicated research origin, key, workspace lock, and disabled-by-default discovery switch before requesting leads.",
      target: "revenue-loop-source",
      requiresHumanApproval: true,
      requiresSeparateExecutionConfirmation: false,
      executionEffect: "none",
    });
  }
  return action({
    code: "PREPARE_VELVET_DISCOVERY",
    stage: "source",
    title: "Prepare one bounded Velvet discovery request",
    detail:
      "Choose one home-service segment, lead ceiling, and metro. Preparation authorizes neither contact nor provider spend.",
    target: "revenue-loop-source",
    requiresHumanApproval: true,
    requiresSeparateExecutionConfirmation: false,
    executionEffect: "none",
  });
}

function deriveStages(
  counts: ProspectRevenueLoopCounts
): ProspectRevenueLoopStageStatus[] {
  const sourced =
    counts.pendingReviewLeads +
    counts.qualifiedLeads +
    counts.sourcePrepared +
    counts.sourceApproved +
    counts.sourceInFlight;
  const outreachActive =
    counts.qcRevisionsRequired +
    counts.outreachPrepared +
    counts.outreachApprovedEmail +
    counts.outreachApprovedCall +
    counts.outreachSending;
  return [
    {
      id: "source",
      label: "Find",
      state:
        sourced > 0
          ? "READY"
          : counts.discoveryInFlight + counts.discoveryReadyForImport > 0
            ? "ACTION_REQUIRED"
            : "WAITING",
      count: sourced,
    },
    {
      id: "review",
      label: "Review",
      state:
        counts.pendingReviewLeads > 0
          ? "ACTION_REQUIRED"
          : counts.qualifiedLeads > 0
            ? "READY"
            : "WAITING",
      count: counts.pendingReviewLeads + counts.qualifiedLeads,
    },
    {
      id: "experiment",
      label: "Assign",
      state:
        counts.inboxPlacementOpenTests +
          counts.emailExperimentsPrepared +
          counts.callExperimentsPrepared >
        0
          ? "ACTION_REQUIRED"
          : counts.emailExperimentsActive +
                counts.callExperimentsActive >
              0
            ? "READY"
            : "WAITING",
      count:
        counts.inboxPlacementOpenTests +
        counts.emailExperimentsActive +
        counts.callExperimentsActive,
    },
    {
      id: "outreach",
      label: "Contact",
      state:
        outreachActive > 0
          ? "ACTION_REQUIRED"
          : counts.outreachSentWithoutOutcome > 0
            ? "READY"
            : "WAITING",
      count:
        outreachActive + counts.outreachSentWithoutOutcome,
    },
    {
      id: "feedback",
      label: "Measure",
      state:
        counts.velvetCallbacksPrepared +
          counts.velvetCallbacksSending >
          0 ||
        counts.unreviewedPositiveOutcomeJobs > 0
          ? "ACTION_REQUIRED"
          : counts.outcomeEvents > 0
            ? "MEASURED"
            : "WAITING",
      count: counts.outcomeEvents,
    },
    {
      id: "learning",
      label: "Improve",
      state:
        counts.learningCandidatesPending > 0 ||
        counts.learningCandidatesApprovedUnapplied > 0
          ? "ACTION_REQUIRED"
          : counts.learningCandidatesApproved > 0
            ? "MEASURED"
            : "WAITING",
      count:
        counts.learningCandidatesPending +
        counts.learningCandidatesApproved,
    },
  ];
}

export function buildProspectRevenueLoopStatus(input: {
  counts: ProspectRevenueLoopCounts;
  connections: ProspectRevenueLoopConnections;
}): ProspectRevenueLoopStatus {
  return {
    contractVersion: PROSPECT_REVENUE_LOOP_CONTRACT_VERSION,
    mode: "guarded-human-approval",
    counts: input.counts,
    connections: input.connections,
    stages: deriveStages(input.counts),
    nextAction: deriveProspectRevenueLoopNextAction(
      input.counts,
      input.connections
    ),
    guardrails: {
      smsAllowed: false,
      bulkExecutionAllowed: false,
      automatedProspectDialingAllowed: false,
      qcMayAuthorizeContact: false,
      learningMayMutateRuntimePolicy: false,
    },
    externalAction: "none",
  };
}
