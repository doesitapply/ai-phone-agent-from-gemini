import { readProspectEmailProviderConfig } from "./prospect-email-provider.js";
import { readProspectEmailWebhookConfig } from "./prospect-email-webhook.js";
import { readProspectInboxPlacementConfig } from "./prospect-inbox-placement.js";
import { readProspectQcModelProviderConfig } from "./prospect-qc-model-provider.js";
import { readProspectRevenueLoopObserverConfig } from "./prospect-revenue-loop-observer.js";
import { readVelvetDiscoveryConfig } from "./velvet-discovery.js";
import { readVelvetLeadSourceConfig } from "./velvet-lead-source.js";
import { readVelvetOutcomeDispatchConfig } from "./velvet-outcome.js";
import { readVelvetRemoteConnectionProofConfig } from "./velvet-connection-proof.js";

export const PROSPECT_ACQUISITION_CONNECTION_READINESS_CONTRACT =
  "smirk.prospect-acquisition-connections.v3" as const;

export const PROSPECT_ACQUISITION_CONFIGURATION_PHASES = [
  "velvet-authority",
  "no-contact-discovery",
  "pre-approval-qc",
  "controlled-inbox-placement",
  "single-recipient-email",
  "closed-loop-learning",
] as const;

export type ProspectAcquisitionConfigurationPhaseId =
  (typeof PROSPECT_ACQUISITION_CONFIGURATION_PHASES)[number];

type ConnectionSummary = {
  configured: boolean;
  enabled: boolean;
  available: boolean;
  workspaceId: number | null;
  missing: string[];
};

export type ProspectAcquisitionConfigurationPhase = {
  configurationReady: boolean;
  blockers: string[];
  workspaceId: number | null;
  externalActionScope:
    | "read-only-authority-proof"
    | "bounded-no-contact-research"
    | "capped-advisory-model-review"
    | "five-allowlisted-seed-emails"
    | "one-human-approved-prospect-email"
    | "signed-outcome-observation";
  activationAuthorized: false;
  explicitApprovalRequired: boolean;
  proofsStillRequired: string[];
};

export type ProspectAcquisitionConnectionReadiness = {
  contractVersion:
    typeof PROSPECT_ACQUISITION_CONNECTION_READINESS_CONTRACT;
  ok: boolean;
  source:
    | "railway-production-variables"
    | "process-environment"
    | "synthetic-test";
  connections: {
    velvetDiscovery: ConnectionSummary;
    velvetSource: ConnectionSummary;
    prospectEmail: ConnectionSummary;
    prospectEmailWebhook: ConnectionSummary;
    inboxPlacement: ConnectionSummary;
    prospectQcModel: ConnectionSummary;
    velvetOutcome: ConnectionSummary;
    revenueLoopObserver: ConnectionSummary;
  };
  workspaceBoundary: {
    aligned: boolean;
    workspaceId: number | null;
  };
  credentialSeparation: {
    velvetSourceAndOutcomeKeysDistinct: boolean;
    velvetKeysAndSmirkOperatorKeysDistinct: boolean;
    velvetSigningSecretDistinct: boolean;
    prospectAndTransactionalEmailKeysDistinct: boolean;
    prospectQcAndGeneralOpenRouterKeysDistinct: boolean;
    revenueLoopObserverAndOperatorKeysDistinct: boolean;
  };
  emailCaps: {
    dailyRecipientCap: number | null;
    dailySpendCapCents: number | null;
    unitCostCents: number | null;
  };
  qcCaps: {
    requiredForApproval: boolean;
    dailyReviewCap: number | null;
    dailySpendCapCents: number | null;
    reservedCostCents: number | null;
    timeoutMs: number | null;
  };
  configurationPhases: Record<
    ProspectAcquisitionConfigurationPhaseId,
    ProspectAcquisitionConfigurationPhase
  >;
  blockers: string[];
  guardrails: {
    coldSmsAllowed: false;
    bulkEmailAllowed: false;
    automatedProspectDialingAllowed: false;
    qcMayAuthorizeContact: false;
    providerMutationPerformed: false;
  };
  unproven: string[];
  externalAction: "none";
};

function summary(input: {
  configured: boolean;
  enabled: boolean;
  workspaceId?: number | null;
  missing: string[];
}): ConnectionSummary {
  return {
    configured: input.configured,
    enabled: input.enabled,
    available: input.configured && input.enabled,
    workspaceId: input.workspaceId ?? null,
    missing: [...new Set(input.missing)].sort(),
  };
}

function scopedWorkspace(input: {
  connections: ConnectionSummary[];
  blocker: string;
}): {
  aligned: boolean;
  workspaceId: number | null;
  blockers: string[];
} {
  const ids = input.connections.map(
    (connection) => connection.workspaceId
  );
  const validIds = ids.filter(
    (value): value is number => value !== null
  );
  const uniqueIds = new Set(validIds);
  const aligned =
    validIds.length === ids.length && uniqueIds.size === 1;
  return {
    aligned,
    workspaceId: aligned ? validIds[0] || null : null,
    blockers: aligned ? [] : [input.blocker],
  };
}

function phase(input: {
  connectionBlockers?: string[];
  additionalBlockers?: string[];
  workspaceId?: number | null;
  externalActionScope:
    ProspectAcquisitionConfigurationPhase["externalActionScope"];
  explicitApprovalRequired: boolean;
  proofsStillRequired: string[];
}): ProspectAcquisitionConfigurationPhase {
  const blockers = [
    ...(input.connectionBlockers || []),
    ...(input.additionalBlockers || []),
  ];
  const uniqueBlockers = [...new Set(blockers)].sort();
  return {
    configurationReady: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    workspaceId: input.workspaceId ?? null,
    externalActionScope: input.externalActionScope,
    activationAuthorized: false,
    explicitApprovalRequired: input.explicitApprovalRequired,
    proofsStillRequired: [...input.proofsStillRequired],
  };
}

function missingFrom(
  ...connections: ConnectionSummary[]
): string[] {
  return connections.flatMap((connection) => connection.missing);
}

export function buildProspectAcquisitionConnectionReadiness(input: {
  env: Record<string, string | undefined>;
  source: ProspectAcquisitionConnectionReadiness["source"];
}): ProspectAcquisitionConnectionReadiness {
  const discovery = readVelvetDiscoveryConfig(input.env);
  const source = readVelvetLeadSourceConfig(input.env);
  const email = readProspectEmailProviderConfig(input.env);
  const emailWebhook = readProspectEmailWebhookConfig(input.env);
  const inbox = readProspectInboxPlacementConfig(input.env);
  const qcModel = readProspectQcModelProviderConfig(input.env);
  const outcome = readVelvetOutcomeDispatchConfig(input.env);
  const observer = readProspectRevenueLoopObserverConfig(input.env);
  const remoteAuthority = readVelvetRemoteConnectionProofConfig(
    input.env
  );

  const connections = {
    velvetDiscovery: summary({
      configured: discovery.configured,
      enabled: discovery.enabled,
      workspaceId: discovery.workspaceId,
      missing: discovery.missing,
    }),
    velvetSource: summary({
      configured: source.configured,
      enabled: source.enabled,
      workspaceId: source.workspaceId,
      missing: source.missing,
    }),
    prospectEmail: summary({
      configured: email.configured,
      enabled: email.enabled,
      workspaceId: email.workspaceId,
      missing: [
        ...email.missing,
        ...(email.enabled ? [] : ["PROSPECT_EMAIL_EXECUTION_ENABLED"]),
      ],
    }),
    prospectEmailWebhook: summary({
      configured: emailWebhook.configured,
      enabled: emailWebhook.enabled,
      workspaceId: emailWebhook.workspaceId,
      missing: [
        ...emailWebhook.missing,
        ...(emailWebhook.enabled
          ? []
          : ["PROSPECT_EMAIL_WEBHOOK_ENABLED"]),
      ],
    }),
    inboxPlacement: summary({
      configured: inbox.configured,
      enabled: true,
      missing: inbox.missing,
    }),
    prospectQcModel: summary({
      configured: qcModel.configured,
      enabled: qcModel.enabled,
      workspaceId: qcModel.workspaceId,
      missing: [
        ...qcModel.missing,
        ...(qcModel.enabled
          ? []
          : ["PROSPECT_QC_MODEL_REVIEW_ENABLED"]),
        ...(qcModel.requiredForApproval
          ? []
          : [
              "PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL",
            ]),
      ],
    }),
    velvetOutcome: summary({
      configured: outcome.configured,
      enabled: outcome.enabled,
      workspaceId: outcome.workspaceId,
      missing: [
        ...outcome.missing,
        ...(outcome.enabled
          ? []
          : ["VELVET_OUTCOME_DISPATCH_ENABLED"]),
      ],
    }),
    revenueLoopObserver: summary({
      configured: observer.configured,
      enabled: true,
      workspaceId: observer.workspaceId,
      missing: observer.missing,
    }),
  };
  const workspaceIds = [
    discovery.workspaceId,
    source.workspaceId,
    email.workspaceId,
    emailWebhook.workspaceId,
    qcModel.workspaceId,
    outcome.workspaceId,
    observer.workspaceId,
  ];
  const validWorkspaceIds = workspaceIds.filter(
    (value): value is number => value !== null
  );
  const uniqueWorkspaceIds = new Set(validWorkspaceIds);
  const workspaceAligned =
    validWorkspaceIds.length === workspaceIds.length &&
    uniqueWorkspaceIds.size === 1;
  const workspaceId = workspaceAligned
    ? validWorkspaceIds[0] || null
    : null;
  const sourceApiKey = String(
    input.env.VELVET_LEAD_SOURCE_API_KEY || ""
  ).trim();
  const outcomeApiKey = String(
    input.env.VELVET_OUTCOME_API_KEY || ""
  ).trim();
  const velvetSigningSecret = String(
    input.env.VELVET_OUTCOME_SIGNING_SECRET || ""
  ).trim();
  const smirkOperatorKeys = [
    input.env.DASHBOARD_API_KEY,
    input.env.DEMO_OPERATOR_API_KEY,
    input.env.VELVET_ALCHEMY_HANDOFF_API_KEY,
    input.env.VELVET_ALCHEMY_RESEARCH_API_KEY,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const prospectEmailKey = String(
    input.env.PROSPECT_EMAIL_RESEND_API_KEY || ""
  ).trim();
  const transactionalEmailKey = String(
    input.env.RESEND_API_KEY || ""
  ).trim();
  const sourceOutcomeDistinct =
    sourceApiKey.length > 0 &&
    outcomeApiKey.length > 0 &&
    sourceApiKey !== outcomeApiKey;
  const velvetOperatorKeysDistinct =
    sourceApiKey.length >= 32 &&
    outcomeApiKey.length >= 32 &&
    !smirkOperatorKeys.includes(sourceApiKey) &&
    !smirkOperatorKeys.includes(outcomeApiKey);
  const velvetSigningSecretDistinct =
    velvetSigningSecret.length >= 32 &&
    ![
      sourceApiKey,
      outcomeApiKey,
      ...smirkOperatorKeys,
    ].includes(velvetSigningSecret);
  const prospectTransactionalDistinct =
    prospectEmailKey.length > 0 &&
    (!transactionalEmailKey ||
      prospectEmailKey !== transactionalEmailKey);
  const observerKey = String(
    input.env.PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY || ""
  ).trim();
  const qcModelKey = String(
    input.env.PROSPECT_QC_OPENROUTER_API_KEY || ""
  ).trim();
  const generalOpenRouterKey = String(
    input.env.OPENROUTER_API_KEY || ""
  ).trim();
  const qcGeneralOpenRouterDistinct =
    qcModelKey.length > 0 &&
    (!generalOpenRouterKey ||
      qcModelKey !== generalOpenRouterKey);
  const observerOperatorDistinct =
    observerKey.length >= 32 &&
    ![input.env.DASHBOARD_API_KEY, input.env.DEMO_OPERATOR_API_KEY]
      .map(value => String(value || "").trim())
      .filter(Boolean)
      .includes(observerKey);
  const discoveryWorkspace = scopedWorkspace({
    connections: [
      connections.velvetDiscovery,
      connections.velvetSource,
    ],
    blocker: "PROSPECT_DISCOVERY_WORKSPACE_ALIGNMENT",
  });
  const qcWorkspace = scopedWorkspace({
    connections: [
      connections.velvetDiscovery,
      connections.velvetSource,
      connections.prospectQcModel,
    ],
    blocker: "PROSPECT_QC_WORKSPACE_ALIGNMENT",
  });
  const emailWorkspace = scopedWorkspace({
    connections: [
      connections.velvetDiscovery,
      connections.velvetSource,
      connections.prospectQcModel,
      connections.prospectEmail,
      connections.prospectEmailWebhook,
    ],
    blocker: "PROSPECT_EMAIL_WORKSPACE_ALIGNMENT",
  });
  const authorityPhase = phase({
    connectionBlockers: remoteAuthority.missing,
    additionalBlockers: [
      ...(velvetOperatorKeysDistinct
        ? []
        : ["VELVET_OPERATOR_KEY_SEPARATION"]),
      ...(velvetSigningSecretDistinct
        ? []
        : ["VELVET_SIGNING_SECRET_SEPARATION"]),
    ],
    workspaceId: remoteAuthority.workspaceId,
    externalActionScope: "read-only-authority-proof",
    explicitApprovalRequired: false,
    proofsStillRequired: [
      "Both reviewed commits are deployed at their exact fingerprints.",
      "The two-request Velvet authority handshake passes without mutation.",
    ],
  });
  const discoveryPhase = phase({
    connectionBlockers: [
      ...authorityPhase.blockers,
      ...missingFrom(
        connections.velvetDiscovery,
        connections.velvetSource
      ),
      ...discoveryWorkspace.blockers,
    ],
    workspaceId: discoveryWorkspace.workspaceId,
    externalActionScope: "bounded-no-contact-research",
    explicitApprovalRequired: true,
    proofsStillRequired: [
      "The Velvet authority phase has passed remotely.",
      "One synthetic no-contact discovery, import, and exact replay pass.",
      "The discovery worker is disabled again after the bounded proof.",
    ],
  });
  const qcPhase = phase({
    connectionBlockers: [
      ...authorityPhase.blockers,
      ...missingFrom(connections.prospectQcModel),
      ...qcWorkspace.blockers,
    ],
    additionalBlockers: [
      ...(qcGeneralOpenRouterDistinct
        ? []
        : ["PROSPECT_QC_OPENROUTER_API_KEY_SEPARATION"]),
      ...(qcModel.requiredForApproval
        ? []
        : ["PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL"]),
    ],
    workspaceId: qcWorkspace.workspaceId,
    externalActionScope: "capped-advisory-model-review",
    explicitApprovalRequired: true,
    proofsStillRequired: [
      "A harmless fake-target review proves strict structured output.",
      "The review and spend caps are observed before any model request.",
      "The QC receipt remains advisory and cannot approve contact.",
    ],
  });
  const inboxPlacementPhase = phase({
    connectionBlockers: [
      ...qcPhase.blockers,
      ...missingFrom(
        connections.prospectEmail,
        connections.prospectEmailWebhook,
        connections.inboxPlacement
      ),
      ...emailWorkspace.blockers,
    ],
    additionalBlockers: prospectTransactionalDistinct
      ? []
      : ["PROSPECT_TRANSACTIONAL_EMAIL_KEY_SEPARATION"],
    workspaceId: emailWorkspace.workspaceId,
    externalActionScope: "five-allowlisted-seed-emails",
    explicitApprovalRequired: true,
    proofsStillRequired: [
      "A separate exact approval authorizes only the five seed recipients.",
      "SPF, DKIM, and DMARC alignment are inspected from received headers.",
      "A fresh immutable five-mailbox inbox-placement PASS receipt exists.",
    ],
  });
  const singleRecipientEmailPhase = phase({
    connectionBlockers: inboxPlacementPhase.blockers,
    workspaceId: inboxPlacementPhase.workspaceId,
    externalActionScope: "one-human-approved-prospect-email",
    explicitApprovalRequired: true,
    proofsStillRequired: [
      "The prospect has a durable reviewed Velvet source receipt from a separately proven no-contact import.",
      "A fresh matching inbox-placement PASS receipt is bound to the experiment.",
      "One exact draft has deterministic and advisory QC receipts.",
      "One human approval and a separate execution confirmation bind the payload hash.",
      "Suppression, opt-out, identity, footer, and one-recipient caps pass at execution.",
    ],
  });
  const closedLoopPhase = phase({
    connectionBlockers: [
      ...singleRecipientEmailPhase.blockers,
      ...missingFrom(
        connections.velvetOutcome,
        connections.revenueLoopObserver
      ),
      ...(workspaceAligned
        ? []
        : ["PROSPECT_ACQUISITION_WORKSPACE_ALIGNMENT"]),
    ],
    additionalBlockers: [
      ...(sourceOutcomeDistinct
        ? []
        : ["VELVET_SOURCE_OUTCOME_KEY_SEPARATION"]),
      ...(observerOperatorDistinct
        ? []
        : ["PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY_SEPARATION"]),
    ],
    workspaceId,
    externalActionScope: "signed-outcome-observation",
    explicitApprovalRequired: true,
    proofsStillRequired: [
      "Signed provider events and Velvet callbacks pass exact replay and tamper rejection.",
      "The observer can read one workspace but cannot contact, spend, or change policy.",
      "A measured outcome pauses the loop and remains one canonical sample.",
      "Any learned candidate still requires a separate human policy release.",
    ],
  });
  const configurationPhases = {
    "velvet-authority": authorityPhase,
    "no-contact-discovery": discoveryPhase,
    "pre-approval-qc": qcPhase,
    "controlled-inbox-placement": inboxPlacementPhase,
    "single-recipient-email": singleRecipientEmailPhase,
    "closed-loop-learning": closedLoopPhase,
  } satisfies ProspectAcquisitionConnectionReadiness["configurationPhases"];
  const blockers = Object.values(connections)
    .flatMap((connection) => connection.missing)
    .concat(
      workspaceAligned ? [] : ["PROSPECT_ACQUISITION_WORKSPACE_ALIGNMENT"],
      sourceOutcomeDistinct
        ? []
        : ["VELVET_SOURCE_OUTCOME_KEY_SEPARATION"],
      velvetOperatorKeysDistinct
        ? []
        : ["VELVET_OPERATOR_KEY_SEPARATION"],
      velvetSigningSecretDistinct
        ? []
        : ["VELVET_SIGNING_SECRET_SEPARATION"],
      prospectTransactionalDistinct
        ? []
        : ["PROSPECT_TRANSACTIONAL_EMAIL_KEY_SEPARATION"],
      qcGeneralOpenRouterDistinct
        ? []
        : ["PROSPECT_QC_OPENROUTER_API_KEY_SEPARATION"],
      observerOperatorDistinct
        ? []
        : ["PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY_SEPARATION"]
    );
  const uniqueBlockers = [...new Set(blockers)].sort();
  const allConnectionsAvailable = Object.values(connections).every(
    (connection) => connection.available
  );

  return {
    contractVersion:
      PROSPECT_ACQUISITION_CONNECTION_READINESS_CONTRACT,
    ok:
      allConnectionsAvailable &&
      workspaceAligned &&
      sourceOutcomeDistinct &&
      velvetOperatorKeysDistinct &&
      velvetSigningSecretDistinct &&
      prospectTransactionalDistinct &&
      qcGeneralOpenRouterDistinct &&
      qcModel.requiredForApproval &&
      observerOperatorDistinct,
    source: input.source,
    connections,
    workspaceBoundary: {
      aligned: workspaceAligned,
      workspaceId,
    },
    credentialSeparation: {
      velvetSourceAndOutcomeKeysDistinct: sourceOutcomeDistinct,
      velvetKeysAndSmirkOperatorKeysDistinct:
        velvetOperatorKeysDistinct,
      velvetSigningSecretDistinct,
      prospectAndTransactionalEmailKeysDistinct:
        prospectTransactionalDistinct,
      prospectQcAndGeneralOpenRouterKeysDistinct:
        qcGeneralOpenRouterDistinct,
      revenueLoopObserverAndOperatorKeysDistinct:
        observerOperatorDistinct,
    },
    emailCaps: {
      dailyRecipientCap: email.dailyRecipientCap,
      dailySpendCapCents: email.dailySpendCapCents,
      unitCostCents: email.unitCostCents,
    },
    qcCaps: {
      requiredForApproval: qcModel.requiredForApproval,
      dailyReviewCap: qcModel.dailyReviewCap,
      dailySpendCapCents: qcModel.dailySpendCapCents,
      reservedCostCents: qcModel.reservedCostCents,
      timeoutMs: qcModel.timeoutMs,
    },
    configurationPhases,
    blockers: uniqueBlockers,
    guardrails: {
      coldSmsAllowed: false,
      bulkEmailAllowed: false,
      automatedProspectDialingAllowed: false,
      qcMayAuthorizeContact: false,
      providerMutationPerformed: false,
    },
    unproven: [
      "Velvet API-key scopes and owner binding",
      "matching Velvet outcome signing secret and workspace",
      "Resend domain verification and SPF/DKIM/DMARC alignment",
      "OpenRouter funding, model availability, and advisory-review quality",
      "a fresh five-mailbox inbox-placement PASS receipt",
      "deployed commit parity and database migration state",
      "provider delivery, customer response, conversion, or revenue",
    ],
    externalAction: "none",
  };
}
