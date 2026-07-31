import { readProspectEmailProviderConfig } from "./prospect-email-provider.js";
import { readProspectEmailWebhookConfig } from "./prospect-email-webhook.js";
import { readProspectInboxPlacementConfig } from "./prospect-inbox-placement.js";
import { readVelvetDiscoveryConfig } from "./velvet-discovery.js";
import { readVelvetLeadSourceConfig } from "./velvet-lead-source.js";
import { readVelvetOutcomeDispatchConfig } from "./velvet-outcome.js";

export const PROSPECT_ACQUISITION_CONNECTION_READINESS_CONTRACT =
  "smirk.prospect-acquisition-connections.v1" as const;

type ConnectionSummary = {
  configured: boolean;
  enabled: boolean;
  available: boolean;
  workspaceId: number | null;
  missing: string[];
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
    velvetOutcome: ConnectionSummary;
  };
  workspaceBoundary: {
    aligned: boolean;
    workspaceId: number | null;
  };
  credentialSeparation: {
    velvetSourceAndOutcomeKeysDistinct: boolean;
    prospectAndTransactionalEmailKeysDistinct: boolean;
  };
  emailCaps: {
    dailyRecipientCap: number | null;
    dailySpendCapCents: number | null;
    unitCostCents: number | null;
  };
  blockers: string[];
  guardrails: {
    coldSmsAllowed: false;
    bulkEmailAllowed: false;
    automatedProspectDialingAllowed: false;
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

export function buildProspectAcquisitionConnectionReadiness(input: {
  env: Record<string, string | undefined>;
  source: ProspectAcquisitionConnectionReadiness["source"];
}): ProspectAcquisitionConnectionReadiness {
  const discovery = readVelvetDiscoveryConfig(input.env);
  const source = readVelvetLeadSourceConfig(input.env);
  const email = readProspectEmailProviderConfig(input.env);
  const emailWebhook = readProspectEmailWebhookConfig(input.env);
  const inbox = readProspectInboxPlacementConfig(input.env);
  const outcome = readVelvetOutcomeDispatchConfig(input.env);

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
  };
  const workspaceIds = [
    discovery.workspaceId,
    source.workspaceId,
    email.workspaceId,
    emailWebhook.workspaceId,
    outcome.workspaceId,
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
  const prospectTransactionalDistinct =
    prospectEmailKey.length > 0 &&
    (!transactionalEmailKey ||
      prospectEmailKey !== transactionalEmailKey);
  const blockers = Object.values(connections)
    .flatMap((connection) => connection.missing)
    .concat(
      workspaceAligned ? [] : ["PROSPECT_ACQUISITION_WORKSPACE_ALIGNMENT"],
      sourceOutcomeDistinct
        ? []
        : ["VELVET_SOURCE_OUTCOME_KEY_SEPARATION"],
      prospectTransactionalDistinct
        ? []
        : ["PROSPECT_TRANSACTIONAL_EMAIL_KEY_SEPARATION"]
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
      prospectTransactionalDistinct,
    source: input.source,
    connections,
    workspaceBoundary: {
      aligned: workspaceAligned,
      workspaceId,
    },
    credentialSeparation: {
      velvetSourceAndOutcomeKeysDistinct: sourceOutcomeDistinct,
      prospectAndTransactionalEmailKeysDistinct:
        prospectTransactionalDistinct,
    },
    emailCaps: {
      dailyRecipientCap: email.dailyRecipientCap,
      dailySpendCapCents: email.dailySpendCapCents,
      unitCostCents: email.unitCostCents,
    },
    blockers: uniqueBlockers,
    guardrails: {
      coldSmsAllowed: false,
      bulkEmailAllowed: false,
      automatedProspectDialingAllowed: false,
      providerMutationPerformed: false,
    },
    unproven: [
      "Velvet API-key scopes and owner binding",
      "matching Velvet outcome signing secret and workspace",
      "Resend domain verification and SPF/DKIM/DMARC alignment",
      "a fresh five-mailbox inbox-placement PASS receipt",
      "deployed commit parity and database migration state",
      "provider delivery, customer response, conversion, or revenue",
    ],
    externalAction: "none",
  };
}
