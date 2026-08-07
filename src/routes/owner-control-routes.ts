import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import {
  PROSPECT_ACQUISITION_CONFIGURATION_PHASES,
  buildProspectAcquisitionConnectionReadiness,
  type ProspectAcquisitionConfigurationPhaseId,
} from "../prospect-acquisition-connection-readiness.js";
import { buildProspectAcquisitionConfigurationPlan } from "../prospect-acquisition-configuration-plan.js";

type OwnerControlRouteDeps = {
  dashboardAuth: RequestHandler;
  requireFullOperator: (req: Request, res: Response, next: NextFunction) => void;
  sql: any;
  dbEnabled: boolean;
  env: Record<string, string | undefined>;
  getWorkspaceId: (req: Request) => number;
  getAdminAllowlistCount: () => number;
  buildOpsMonitor: (workspaceId: number) => Promise<{
    services: any[];
    spend: any;
    config: any[];
    generatedAt: string;
  }>;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

const PROSPECT_CONNECTION_LABELS = {
  velvetDiscovery: "Velvet lead discovery",
  velvetSource: "Velvet reviewed-lead source",
  prospectEmail: "Prospect email sender",
  prospectEmailWebhook: "Prospect delivery webhook",
  prospectEmailReceiving: "Prospect reply receiving",
  prospectManualCall: "Operator-only manual call",
  inboxPlacement: "Controlled inbox placement",
  prospectQcModel: "Advisory QC model",
  velvetOutcome: "Velvet outcome callback",
  revenueLoopObserver: "Revenue-loop observer",
  revenueLoopPreparer: "Revenue-loop preparer",
} as const;

const PROSPECT_SWITCH_LABELS = {
  VELVET_DISCOVERY_ENABLED: "Velvet discovery",
  VELVET_LEAD_SOURCE_ENABLED: "Velvet reviewed-lead import",
  PROSPECT_REVENUE_LOOP_PREPARER_ENABLED: "Review-item preparation",
  PROSPECT_QC_MODEL_REVIEW_ENABLED: "Advisory QC provider",
  PROSPECT_EMAIL_EXECUTION_ENABLED: "Single-recipient email",
  PROSPECT_EMAIL_WEBHOOK_ENABLED: "Signed email events",
  PROSPECT_EMAIL_RECEIVING_ENABLED: "Reply retrieval",
  PROSPECT_MANUAL_CALL_ENABLED: "Operator-only manual call",
  VELVET_OUTCOME_DISPATCH_ENABLED: "Velvet outcome dispatch",
} as const;

const PROSPECT_PHASE_LABELS = {
  "velvet-authority": "Velvet authority",
  "no-contact-discovery": "No-contact discovery",
  "pre-approval-qc": "Pre-approval QC",
  "controlled-inbox-placement": "Controlled inbox placement",
  "single-recipient-email": "Single-recipient email",
  "single-recipient-manual-call": "Single manual prospect call",
  "closed-loop-learning": "Closed-loop learning",
} as const;

type ProspectPhaseSetupLink = {
  id: string;
  label: string;
  href: string;
  external: boolean;
};

const PROSPECT_PHASE_SETUP_LINKS: Record<
  ProspectAcquisitionConfigurationPhaseId,
  ProspectPhaseSetupLink[]
> = {
  "velvet-authority": [
    {
      id: "velvet-api-keys",
      label: "Velvet API keys",
      href: "https://velvetalchemy.manus.space/api-keys",
      external: true,
    },
    {
      id: "railway-variables",
      label: "Railway variables",
      href: "https://railway.com/dashboard",
      external: true,
    },
  ],
  "no-contact-discovery": [
    {
      id: "velvet-governor",
      label: "Velvet governor",
      href: "https://velvetalchemy.manus.space/governor",
      external: true,
    },
    {
      id: "railway-variables",
      label: "Railway variables",
      href: "https://railway.com/dashboard",
      external: true,
    },
  ],
  "pre-approval-qc": [
    {
      id: "openrouter-keys",
      label: "OpenRouter keys",
      href: "https://openrouter.ai/settings/keys",
      external: true,
    },
    {
      id: "openrouter-credits",
      label: "OpenRouter credits",
      href: "https://openrouter.ai/settings/credits",
      external: true,
    },
    {
      id: "railway-variables",
      label: "Railway variables",
      href: "https://railway.com/dashboard",
      external: true,
    },
  ],
  "controlled-inbox-placement": [
    {
      id: "resend-domains",
      label: "Resend domains",
      href: "https://resend.com/domains",
      external: true,
    },
    {
      id: "resend-api-keys",
      label: "Resend API keys",
      href: "https://resend.com/api-keys",
      external: true,
    },
    {
      id: "resend-billing",
      label: "Resend billing",
      href: "https://resend.com/settings/billing",
      external: true,
    },
  ],
  "single-recipient-email": [
    {
      id: "resend-api-keys",
      label: "Resend API keys",
      href: "https://resend.com/api-keys",
      external: true,
    },
    {
      id: "resend-webhooks",
      label: "Resend webhooks",
      href: "https://resend.com/webhooks",
      external: true,
    },
    {
      id: "railway-variables",
      label: "Railway variables",
      href: "https://railway.com/dashboard",
      external: true,
    },
  ],
  "single-recipient-manual-call": [
    {
      id: "railway-variables",
      label: "Railway variables",
      href: "https://railway.com/dashboard",
      external: true,
    },
    {
      id: "smirk-compliance",
      label: "SMIRK compliance",
      href: "/dashboard/compliance",
      external: false,
    },
  ],
  "closed-loop-learning": [
    {
      id: "resend-webhooks",
      label: "Resend webhooks",
      href: "https://resend.com/webhooks",
      external: true,
    },
    {
      id: "velvet-api-keys",
      label: "Velvet API keys",
      href: "https://velvetalchemy.manus.space/api-keys",
      external: true,
    },
    {
      id: "railway-variables",
      label: "Railway variables",
      href: "https://railway.com/dashboard",
      external: true,
    },
  ],
};

const CREDENTIAL_SEPARATION_LABELS = {
  velvetSourceAndOutcomeKeysDistinct: "Velvet source and outcome keys",
  velvetKeysAndSmirkOperatorKeysDistinct: "Velvet and operator keys",
  velvetSigningSecretDistinct: "Velvet signing secret",
  prospectAndTransactionalEmailKeysDistinct: "Prospect and transactional email keys",
  prospectReceivingKeyDistinct: "Prospect receiving key",
  prospectQcAndGeneralOpenRouterKeysDistinct: "QC and general model keys",
  revenueLoopObserverAndOperatorKeysDistinct: "Observer and operator keys",
  revenueLoopPreparerAndPrivilegedKeysDistinct: "Preparer and privileged keys",
} as const;

type OwnerCredentialState =
  | "active"
  | "missing"
  | "rejected"
  | "unverified"
  | "not_applicable";

type OwnerConnectionAction = {
  id: "configure" | "provider" | "billing";
  label: string;
  href: string;
  external: boolean;
};

const OWNER_CONNECTION_MANAGEMENT: Record<string, {
  settingsGroup?: string;
  providerUrl?: string;
  billingUrl?: string;
}> = {
  twilio: {
    settingsGroup: "core",
    providerUrl: "https://console.twilio.com/",
    billingUrl: "https://console.twilio.com/us1/billing",
  },
  openrouter: {
    settingsGroup: "openrouter",
    providerUrl: "https://openrouter.ai/settings/keys",
    billingUrl: "https://openrouter.ai/settings/credits",
  },
  stripe: {
    providerUrl: "https://dashboard.stripe.com/payment-links",
  },
  resend: {
    settingsGroup: "email_outreach",
    providerUrl: "https://resend.com/api-keys",
    billingUrl: "https://resend.com/settings/billing",
  },
  elevenlabs: {
    settingsGroup: "elevenlabs",
    providerUrl: "https://elevenlabs.io/app/settings/api-keys",
    billingUrl: "https://elevenlabs.io/app/subscription",
  },
  database_ops: {
    providerUrl: "https://railway.com/dashboard",
  },
  gemini: {
    settingsGroup: "gemini",
    providerUrl: "https://aistudio.google.com/app/apikey",
    billingUrl: "https://aistudio.google.com/app/billing",
  },
  google_calendar: {
    settingsGroup: "google_calendar",
    providerUrl: "https://console.cloud.google.com/apis/credentials",
  },
  google_places: {
    settingsGroup: "google_places",
    providerUrl: "https://console.cloud.google.com/apis/credentials",
    billingUrl: "https://console.cloud.google.com/billing",
  },
  google_tts: {
    settingsGroup: "google_tts",
    providerUrl: "https://console.cloud.google.com/apis/library/texttospeech.googleapis.com",
    billingUrl: "https://console.cloud.google.com/billing",
  },
  hubspot: {
    settingsGroup: "crm",
    providerUrl: "https://app.hubspot.com/",
  },
  salesforce: {
    settingsGroup: "crm",
    providerUrl: "https://login.salesforce.com/",
  },
  airtable: {
    settingsGroup: "crm",
    providerUrl: "https://airtable.com/create/tokens",
  },
  notion: {
    settingsGroup: "crm",
    providerUrl: "https://www.notion.so/profile/integrations",
  },
  apollo: {
    settingsGroup: "lead_providers",
    providerUrl: "https://app.apollo.io/#/settings/integrations/api",
  },
  brave_search: {
    settingsGroup: "lead_providers",
    providerUrl: "https://api.search.brave.com/app/keys",
  },
  serper: {
    settingsGroup: "lead_providers",
    providerUrl: "https://serper.dev/api-key",
  },
  google_maps: {
    settingsGroup: "lead_providers",
    providerUrl: "https://console.cloud.google.com/apis/credentials",
    billingUrl: "https://console.cloud.google.com/billing",
  },
  operator_access: {
    settingsGroup: "deployment",
  },
  google_admin_allowlist: {
    providerUrl: "https://railway.com/dashboard",
  },
  telegram_approval_guard: {
    providerUrl: "https://railway.com/dashboard",
  },
  openclaw_gateway: {
    settingsGroup: "openclaw",
  },
  cartesia_tts: {
    settingsGroup: "cartesia",
    providerUrl: "https://play.cartesia.ai/",
  },
  openai_tts: {
    settingsGroup: "openai_tts",
    providerUrl: "https://platform.openai.com/api-keys",
    billingUrl: "https://platform.openai.com/settings/organization/billing/overview",
  },
  calendly: {
    settingsGroup: "booking",
    providerUrl: "https://calendly.com/integrations",
  },
  outbound_webhook: {
    settingsGroup: "deployment",
  },
};

const rejectedCredentialPattern = /(?:\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid api key|authentication failed)/i;
const acceptedCredentialPattern = /(?:credential accepted|api reachable|restricted stripe read access (?:reached|succeeded)|characters [\d,]+\s*\/|account .+ is active)/i;

export function buildOwnerConnectionManagement(connection: {
  id: string;
  status: string;
  configured: boolean;
  detail: string;
  verification: string;
}) {
  const management = OWNER_CONNECTION_MANAGEMENT[connection.id] || {};
  const actions: OwnerConnectionAction[] = [];
  if (management.settingsGroup) {
    actions.push({
      id: "configure",
      label: connection.configured ? "Configure" : "Add connection",
      href: `/dashboard/settings?connection=${encodeURIComponent(management.settingsGroup)}`,
      external: false,
    });
  }
  if (management.providerUrl) {
    actions.push({
      id: "provider",
      label: "Open provider",
      href: management.providerUrl,
      external: true,
    });
  }
  if (management.billingUrl) {
    actions.push({
      id: "billing",
      label: "Billing / credits",
      href: management.billingUrl,
      external: true,
    });
  }

  let credentialState: OwnerCredentialState = "unverified";
  if (connection.verification === "policy" || connection.id === "database_ops") {
    credentialState = "not_applicable";
  } else if (!connection.configured) {
    credentialState = "missing";
  } else if (rejectedCredentialPattern.test(connection.detail)) {
    credentialState = "rejected";
  } else if (
    connection.verification === "provider_probe"
    && (
      connection.status === "online"
      || acceptedCredentialPattern.test(connection.detail)
    )
  ) {
    credentialState = "active";
  }

  return {
    credentialState,
    actionRequired:
      credentialState === "missing"
      || credentialState === "rejected"
      || connection.status === "offline"
      || connection.status === "warn",
    actions,
  };
}

export function buildOwnerProspectAcquisitionOverview(
  env: Record<string, string | undefined>
) {
  const readiness = buildProspectAcquisitionConnectionReadiness({
    env,
    source: "process-environment",
  });
  const phasePlans = PROSPECT_ACQUISITION_CONFIGURATION_PHASES.map((phaseId) => {
    const plan = buildProspectAcquisitionConfigurationPlan({
      phase: phaseId,
      env,
      source: "process-environment",
    });
    return {
      id: phaseId,
      label: PROSPECT_PHASE_LABELS[phaseId],
      configurationReady: plan.stagedConfigurationReady,
      safeStagingState: plan.safeStagingState,
      blockers: plan.stagedConfigurationBlockers,
      requiredVariables: plan.requiredVariables,
      externalPrerequisites: plan.externalPrerequisites,
      setupLinks: PROSPECT_PHASE_SETUP_LINKS[phaseId],
      nextCheckCommand: plan.nextCheckCommand,
      explicitApprovalRequired: plan.activation.explicitApprovalRequired,
      externalActionScope: plan.activation.externalActionScope,
      proofsStillRequired: plan.activation.proofsStillRequired,
    };
  });
  const closedLoopPlan = buildProspectAcquisitionConfigurationPlan({
    phase: "closed-loop-learning",
    env,
    source: "process-environment",
  });
  const executionSwitches = closedLoopPlan.requiredVariables
    .filter((variable) => variable.kind === "activation-switch")
    .map((variable) => ({
      key: variable.name,
      label:
        PROSPECT_SWITCH_LABELS[
          variable.name as keyof typeof PROSPECT_SWITCH_LABELS
        ] || variable.name,
      state: variable.state,
      enabled: variable.state === "enabled-requires-separate-approval",
    }));
  const nextIncompletePhase = phasePlans.find(
    (phase) => !phase.configurationReady
  );
  const nextAction = nextIncompletePhase
    ? {
        code: "COMPLETE_CONFIGURATION" as const,
        title: `Complete ${nextIncompletePhase.label.toLowerCase()} configuration`,
        detail:
          nextIncompletePhase.blockers[0] ||
          "Resolve the named configuration blocker before any external proof.",
      }
    : closedLoopPlan.activation.allExecutionSwitchesDisabled
      ? {
          code: "REQUEST_BOUNDED_PROOF_APPROVAL" as const,
          title: "Configuration is staged with execution disabled",
          detail:
            "Request a separate approval for one harmless phase proof; this console cannot enable or execute it.",
        }
      : {
          code: "REVIEW_ENABLED_SWITCHES" as const,
          title: "Review enabled execution switches",
          detail:
            "At least one execution switch is enabled. Verify its exact approval and proof receipt before relying on it.",
        };

  return {
    contractVersion: readiness.contractVersion,
    source: readiness.source,
    stagedConfigurationReady: closedLoopPlan.stagedConfigurationReady,
    safeStagingState: closedLoopPlan.safeStagingState,
    redactedPlanDigest: closedLoopPlan.redactedPlanDigest,
    connections: Object.entries(readiness.connections).map(
      ([id, connection]) => ({
        id,
        label:
          PROSPECT_CONNECTION_LABELS[
            id as keyof typeof PROSPECT_CONNECTION_LABELS
          ] || id,
        configured: connection.configured,
        enabled: connection.enabled,
        available: connection.available,
        workspaceId: connection.workspaceId,
        missing: connection.missing,
      })
    ),
    executionSwitches,
    workspaceBoundary: readiness.workspaceBoundary,
    credentialSeparation: Object.entries(readiness.credentialSeparation).map(
      ([id, passed]) => ({
        id,
        label:
          CREDENTIAL_SEPARATION_LABELS[
            id as keyof typeof CREDENTIAL_SEPARATION_LABELS
          ] || id,
        passed,
      })
    ),
    emailCaps: readiness.emailCaps,
    qcCaps: readiness.qcCaps,
    phases: phasePlans,
    blockers: closedLoopPlan.stagedConfigurationBlockers,
    unproven: readiness.unproven,
    nextAction,
    activation: {
      authorized: false as const,
      contactAuthorized: false as const,
      spendAuthorized: false as const,
      providerMutationPerformed: false as const,
      allExecutionSwitchesDisabled:
        closedLoopPlan.activation.allExecutionSwitchesDisabled,
    },
    guardrails: readiness.guardrails,
    externalAction: "none" as const,
  };
}

type ProspectUsageAvailability = "available" | "partial" | "unavailable";

const emptyProspectAcquisitionUsage = (
  generatedAt: string,
  issue: string
) => {
  const endsAt = new Date(generatedAt);
  const validEndsAt = Number.isFinite(endsAt.getTime())
    ? endsAt
    : new Date();
  const startsAt = new Date(validEndsAt.getTime() - 24 * 60 * 60 * 1000);
  return {
    availability: "unavailable" as ProspectUsageAvailability,
    source: "durable-database" as const,
    period: {
      kind: "rolling-24-hours" as const,
      startsAt: startsAt.toISOString(),
      endsAt: validEndsAt.toISOString(),
    },
    email: {
      available: false,
      recipientsReserved: null,
      providerAccepted: null,
      providerFailed: null,
      providerAttempts: null,
      reservedSpendCents: null,
    },
    qc: {
      available: false,
      reviewsReserved: null,
      completed: null,
      failedOrUnknown: null,
      totalTokens: null,
      reservedSpendCents: null,
    },
    discovery: {
      available: false,
      requests: null,
      approved: null,
      completed: null,
      providerRequests: null,
      approvedMaxSpendCents: null,
    },
    manualCall: {
      available: false,
      approvals: null,
      openApproved: null,
      recordedCompleted: null,
      closedWithoutExecution: null,
      providerRequests: 0 as const,
      automatedDials: 0 as const,
    },
    issues: [issue],
    externalAction: "none" as const,
  };
};

export async function loadOwnerProspectAcquisitionUsage(
  sql: any,
  workspaceId: number,
  generatedAt = new Date().toISOString()
) {
  const empty = emptyProspectAcquisitionUsage(generatedAt, "usage-unavailable");
  const startsAt = empty.period.startsAt;
  const run = (query: () => Promise<unknown>) => Promise.resolve().then(query);
  const [emailResult, qcResult, discoveryResult, manualCallResult] =
    await Promise.allSettled([
    run(() => sql`
      SELECT
        COUNT(*) FILTER (
          WHERE channel = 'email'
            AND provider_name = 'resend'
            AND state IN ('SENDING', 'SENT')
        )::int AS recipients_reserved,
        COUNT(*) FILTER (
          WHERE channel = 'email'
            AND provider_name = 'resend'
            AND state = 'SENT'
        )::int AS provider_accepted,
        COUNT(*) FILTER (
          WHERE channel = 'email'
            AND provider_name = 'resend'
            AND state = 'FAILED'
        )::int AS provider_failed,
        COALESCE(SUM(provider_attempts) FILTER (
          WHERE channel = 'email' AND provider_name = 'resend'
        ), 0)::int AS provider_attempts,
        COALESCE(SUM(provider_cost_cents) FILTER (
          WHERE channel = 'email'
            AND provider_name = 'resend'
            AND state IN ('SENDING', 'SENT')
        ), 0)::int AS reserved_spend_cents
      FROM prospect_outreach_jobs
      WHERE workspace_id = ${workspaceId}
        AND provider_requested_at >= ${startsAt}
    `),
    run(() => sql`
      SELECT
        COUNT(*)::int AS reviews_reserved,
        COUNT(*) FILTER (WHERE state = 'COMPLETED')::int AS completed,
        COUNT(*) FILTER (
          WHERE state IN ('DEFINITIVE_FAILURE', 'OUTCOME_UNKNOWN')
        )::int AS failed_or_unknown,
        COALESCE(SUM(total_tokens), 0)::int AS total_tokens,
        COALESCE(
          SUM(
            GREATEST(
              reserved_cost_cents,
              COALESCE(
                CEIL(provider_reported_cost_usd * 100)::int,
                reserved_cost_cents
              )
            )
          ),
          0
        )::int AS reserved_spend_cents
      FROM prospect_qc_model_reviews
      WHERE workspace_id = ${workspaceId}
        AND requested_at >= ${startsAt}
    `),
    run(() => sql`
      SELECT
        COUNT(*)::int AS requests,
        COUNT(*) FILTER (WHERE approved_at IS NOT NULL)::int AS approved,
        COUNT(*) FILTER (
          WHERE remote_state IN ('COMPLETED', 'EMPTY', 'PARTIAL')
        )::int AS completed,
        COALESCE(SUM(provider_requests), 0)::int AS provider_requests,
        COALESCE(SUM(approved_max_spend_cents), 0)::int
          AS approved_max_spend_cents
      FROM velvet_discovery_requests
      WHERE workspace_id = ${workspaceId}
        AND created_at >= ${startsAt}
    `),
    run(() => sql`
      SELECT
        COUNT(*) FILTER (
          WHERE approved_at >= ${startsAt}
        )::int AS approvals,
        COUNT(*) FILTER (
          WHERE state = 'APPROVED'
            AND approved_at >= ${startsAt}
        )::int AS open_approved,
        COUNT(*) FILTER (
          WHERE state = 'SENT'
            AND sent_at >= ${startsAt}
            AND execution_proof_reference LIKE 'manual:%'
        )::int AS recorded_completed,
        COUNT(*) FILTER (
          WHERE state IN ('FAILED', 'REJECTED', 'EXPIRED', 'CANCELLED')
            AND updated_at >= ${startsAt}
        )::int AS closed_without_execution
      FROM prospect_outreach_jobs
      WHERE workspace_id = ${workspaceId}
        AND channel = 'call'
        AND (
          created_at >= ${startsAt}
          OR approved_at >= ${startsAt}
          OR sent_at >= ${startsAt}
          OR updated_at >= ${startsAt}
        )
    `),
  ]);

  const issues: string[] = [];
  const emailRows = emailResult.status === "fulfilled"
    ? (emailResult.value as any[])
    : (issues.push("email-usage-unavailable"), []);
  const qcRows = qcResult.status === "fulfilled"
    ? (qcResult.value as any[])
    : (issues.push("qc-usage-unavailable"), []);
  const discoveryRows = discoveryResult.status === "fulfilled"
    ? (discoveryResult.value as any[])
    : (issues.push("discovery-usage-unavailable"), []);
  const manualCallRows = manualCallResult.status === "fulfilled"
    ? (manualCallResult.value as any[])
    : (issues.push("manual-call-usage-unavailable"), []);
  const email = emailRows[0] || {};
  const qc = qcRows[0] || {};
  const discovery = discoveryRows[0] || {};
  const manualCall = manualCallRows[0] || {};
  const availableStreams = 4 - issues.length;

  return {
    availability: (
      availableStreams === 4
        ? "available"
        : availableStreams === 0
          ? "unavailable"
          : "partial"
    ) as ProspectUsageAvailability,
    source: "durable-database" as const,
    period: empty.period,
    email: {
      available: emailResult.status === "fulfilled",
      recipientsReserved: emailResult.status === "fulfilled" ? asCount(email.recipients_reserved) : null,
      providerAccepted: emailResult.status === "fulfilled" ? asCount(email.provider_accepted) : null,
      providerFailed: emailResult.status === "fulfilled" ? asCount(email.provider_failed) : null,
      providerAttempts: emailResult.status === "fulfilled" ? asCount(email.provider_attempts) : null,
      reservedSpendCents: emailResult.status === "fulfilled" ? asCount(email.reserved_spend_cents) : null,
    },
    qc: {
      available: qcResult.status === "fulfilled",
      reviewsReserved: qcResult.status === "fulfilled" ? asCount(qc.reviews_reserved) : null,
      completed: qcResult.status === "fulfilled" ? asCount(qc.completed) : null,
      failedOrUnknown: qcResult.status === "fulfilled" ? asCount(qc.failed_or_unknown) : null,
      totalTokens: qcResult.status === "fulfilled" ? asCount(qc.total_tokens) : null,
      reservedSpendCents: qcResult.status === "fulfilled" ? asCount(qc.reserved_spend_cents) : null,
    },
    discovery: {
      available: discoveryResult.status === "fulfilled",
      requests: discoveryResult.status === "fulfilled" ? asCount(discovery.requests) : null,
      approved: discoveryResult.status === "fulfilled" ? asCount(discovery.approved) : null,
      completed: discoveryResult.status === "fulfilled" ? asCount(discovery.completed) : null,
      providerRequests: discoveryResult.status === "fulfilled" ? asCount(discovery.provider_requests) : null,
      approvedMaxSpendCents: discoveryResult.status === "fulfilled" ? asCount(discovery.approved_max_spend_cents) : null,
    },
    manualCall: {
      available: manualCallResult.status === "fulfilled",
      approvals: manualCallResult.status === "fulfilled" ? asCount(manualCall.approvals) : null,
      openApproved: manualCallResult.status === "fulfilled" ? asCount(manualCall.open_approved) : null,
      recordedCompleted: manualCallResult.status === "fulfilled" ? asCount(manualCall.recorded_completed) : null,
      closedWithoutExecution: manualCallResult.status === "fulfilled" ? asCount(manualCall.closed_without_execution) : null,
      providerRequests: 0 as const,
      automatedDials: 0 as const,
    },
    issues,
    externalAction: "none" as const,
  };
}

const asCount = (value: unknown): number => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
};

const monthKey = () => new Date().toISOString().slice(0, 7);

type OwnerCredentialDefinition = {
  key: string;
  label: string;
  category: string;
  critical?: boolean;
};

const OWNER_CREDENTIAL_DEFINITIONS: OwnerCredentialDefinition[] = [
  { key: "DATABASE_URL", label: "Postgres connection", category: "core", critical: true },
  { key: "WORKSPACE_SECRET_ENCRYPTION_KEY", label: "Workspace secret encryption", category: "core", critical: true },
  { key: "DASHBOARD_API_KEY", label: "Full-operator API key", category: "access", critical: true },
  { key: "DEMO_OPERATOR_API_KEY", label: "Restricted demo-operator key", category: "access" },
  { key: "PHONE_AGENT_API_KEY", label: "Phone-agent API key", category: "access", critical: true },
  { key: "PHONE_AGENT_PROVISIONING_SECRET", label: "Phone provisioning secret", category: "access", critical: true },
  { key: "GOOGLE_OAUTH_CLIENT_ID", label: "Google OAuth client", category: "access" },
  { key: "GOOGLE_ADMIN_EMAILS", label: "Google admin allowlist", category: "access", critical: true },
  { key: "TWILIO_ACCOUNT_SID", label: "Twilio account SID", category: "voice", critical: true },
  { key: "TWILIO_AUTH_TOKEN", label: "Twilio auth token", category: "voice", critical: true },
  { key: "TWILIO_PHONE_NUMBER", label: "Twilio phone number", category: "voice", critical: true },
  { key: "OPENROUTER_API_KEY", label: "OpenRouter API key", category: "ai", critical: true },
  { key: "GEMINI_API_KEY", label: "Gemini API key", category: "ai" },
  { key: "OPENAI_API_KEY", label: "OpenAI API key", category: "voice" },
  { key: "GOOGLE_TTS_API_KEY", label: "Google TTS API key", category: "voice" },
  { key: "CARTESIA_API_KEY", label: "Cartesia API key", category: "voice" },
  { key: "ELEVENLABS_API_KEY", label: "ElevenLabs API key", category: "voice" },
  { key: "RESEND_API_KEY", label: "Transactional Resend key", category: "email", critical: true },
  { key: "FROM_EMAIL", label: "Transactional sender address", category: "email", critical: true },
  { key: "STRIPE_REVENUE_READ_KEY", label: "Stripe restricted read key", category: "billing", critical: true },
  { key: "STRIPE_BILLING_PORTAL_KEY", label: "Stripe portal restricted key", category: "billing" },
  { key: "STRIPE_BILLING_PORTAL_CONFIGURATION_ID", label: "Stripe portal configuration", category: "billing" },
  { key: "STRIPE_WEBHOOK_SECRET", label: "Stripe webhook signing secret", category: "billing", critical: true },
  { key: "STRIPE_PAYMENT_LINK_STARTER_ID", label: "Starter payment-link ID", category: "billing", critical: true },
  { key: "STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS", label: "Starter fulfillment allowlist", category: "billing", critical: true },
  { key: "GOOGLE_SERVICE_ACCOUNT_JSON", label: "Google service account", category: "google" },
  { key: "GOOGLE_CALENDAR_ID", label: "Google Calendar ID", category: "google" },
  { key: "GOOGLE_PLACES_API_KEY", label: "Google Places API key", category: "lead data" },
  { key: "GOOGLE_MAPS_API_KEY", label: "Google Maps lead-search key", category: "lead data" },
  { key: "APOLLO_API_KEY", label: "Apollo API key", category: "lead data" },
  { key: "BRAVE_API_KEY", label: "Brave Search API key", category: "lead data" },
  { key: "SERPER_API_KEY", label: "Serper API key", category: "lead data" },
  { key: "HUBSPOT_ACCESS_TOKEN", label: "HubSpot private-app token", category: "crm" },
  { key: "SALESFORCE_INSTANCE_URL", label: "Salesforce instance URL", category: "crm" },
  { key: "SALESFORCE_ACCESS_TOKEN", label: "Salesforce access token", category: "crm" },
  { key: "SALESFORCE_CLIENT_ID", label: "Salesforce client ID", category: "crm" },
  { key: "SALESFORCE_CLIENT_SECRET", label: "Salesforce client secret", category: "crm" },
  { key: "SALESFORCE_REFRESH_TOKEN", label: "Salesforce refresh token", category: "crm" },
  { key: "AIRTABLE_API_KEY", label: "Airtable personal-access token", category: "crm" },
  { key: "AIRTABLE_BASE_ID", label: "Airtable base ID", category: "crm" },
  { key: "NOTION_API_KEY", label: "Notion integration secret", category: "crm" },
  { key: "NOTION_DATABASE_ID", label: "Notion database ID", category: "crm" },
  { key: "CALENDLY_URL", label: "Calendly booking URL", category: "booking" },
  { key: "CALENDLY_SIGNING_SECRET", label: "Calendly webhook secret", category: "booking" },
  { key: "OPENCLAW_GATEWAY_URL", label: "OpenClaw gateway URL", category: "automation" },
  { key: "OPENCLAW_GATEWAY_TOKEN", label: "OpenClaw gateway token", category: "automation" },
  { key: "TELEGRAM_WEBHOOK_SECRET", label: "Telegram webhook secret", category: "approval" },
  { key: "TELEGRAM_ALLOWED_USER_IDS", label: "Telegram user allowlist", category: "approval" },
  { key: "TELEGRAM_ALLOWED_CHAT_IDS", label: "Telegram chat allowlist", category: "approval" },
  { key: "VELVET_ALCHEMY_RESEARCH_API_KEY", label: "Velvet research receiver key", category: "velvet" },
  { key: "VELVET_LEAD_SOURCE_API_KEY", label: "Velvet reviewed-lead source key", category: "velvet" },
  { key: "VELVET_OUTCOME_API_KEY", label: "Velvet outcome callback key", category: "velvet" },
  { key: "VELVET_OUTCOME_SIGNING_SECRET", label: "Velvet outcome signing secret", category: "velvet" },
  { key: "PROSPECT_EMAIL_RESEND_API_KEY", label: "Prospect-email Resend key", category: "outreach" },
  { key: "PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET", label: "Prospect-email webhook secret", category: "outreach" },
  { key: "PROSPECT_EMAIL_RESEND_RECEIVING_API_KEY", label: "Prospect reply-receiving key", category: "outreach" },
  { key: "PROSPECT_QC_OPENROUTER_API_KEY", label: "Advisory-QC model key", category: "outreach" },
  { key: "PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY", label: "Revenue-loop observer key", category: "outreach" },
  { key: "PROSPECT_REVENUE_LOOP_PREPARER_API_KEY", label: "Revenue-loop preparer key", category: "outreach" },
];

export const buildOwnerCredentialInventory = (
  env: Record<string, string | undefined>,
  config: any[] = []
) => {
  const monitorItems = new Map(
    config.map((item) => [String(item?.key || ""), item])
  );
  const definitions = [...OWNER_CREDENTIAL_DEFINITIONS];
  for (const item of config) {
    const key = String(item?.key || "").trim();
    if (!key || definitions.some((definition) => definition.key === key)) continue;
    definitions.push({
      key,
      label: String(item?.label || key),
      category: "runtime",
      critical: Boolean(item?.critical),
    });
  }

  return definitions.map((definition) => {
    const monitorItem = monitorItems.get(definition.key);
    return {
      key: definition.key,
      label: definition.label,
      category: definition.category,
      configured: Boolean(String(env[definition.key] || "").trim()) || Boolean(monitorItem?.set),
      critical: Boolean(definition.critical || monitorItem?.critical),
      exposure: "write_only_secret" as const,
    };
  });
};

const buildGuardrailConnections = (env: Record<string, string | undefined>, adminAllowlistCount: number) => {
  const telegramReady = Boolean(
    env.TELEGRAM_WEBHOOK_SECRET
    && env.TELEGRAM_ALLOWED_USER_IDS
    && env.TELEGRAM_ALLOWED_CHAT_IDS
  );
  const dashboardKeyReady = Boolean(env.DASHBOARD_API_KEY);
  const googleAdminReady = dashboardKeyReady && adminAllowlistCount > 0;
  const openClawEnabled = env.OPENCLAW_ENABLED === "true";
  const openClawReady = Boolean(openClawEnabled && env.OPENCLAW_GATEWAY_URL && env.OPENCLAW_GATEWAY_TOKEN);
  const calendlyReady = Boolean(env.CALENDLY_URL && env.CALENDLY_SIGNING_SECRET);
  const webhookReady = Boolean(env.WEBHOOK_URL || env.OUTBOUND_WEBHOOK_URL);
  const googleTtsReady = Boolean(env.GOOGLE_TTS_API_KEY || env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const hubspotReady = Boolean(env.HUBSPOT_ACCESS_TOKEN);
  const salesforceAccessReady = Boolean(env.SALESFORCE_INSTANCE_URL && env.SALESFORCE_ACCESS_TOKEN);
  const salesforceRefreshReady = Boolean(
    env.SALESFORCE_CLIENT_ID
    && env.SALESFORCE_CLIENT_SECRET
    && env.SALESFORCE_REFRESH_TOKEN
  );
  const airtableReady = Boolean(env.AIRTABLE_API_KEY && env.AIRTABLE_BASE_ID);
  const notionReady = Boolean(env.NOTION_API_KEY && env.NOTION_DATABASE_ID);

  return [
    {
      id: "operator_access",
      label: "Owner operator access",
      category: "access",
      status: dashboardKeyReady ? "online" : "offline",
      configured: dashboardKeyReady,
      detail: dashboardKeyReady
        ? "Full operator API authentication is configured."
        : "Full operator API authentication is not configured.",
      verification: "configuration",
    },
    {
      id: "google_admin_allowlist",
      label: "Google admin allowlist",
      category: "access",
      status: googleAdminReady ? "online" : adminAllowlistCount > 0 ? "warn" : "unknown",
      configured: googleAdminReady,
      detail: googleAdminReady
        ? `${adminAllowlistCount} approved full-admin ${adminAllowlistCount === 1 ? "identity" : "identities"}; addresses stay private.`
        : adminAllowlistCount > 0
          ? "Allowlist is present, but the full operator key is not configured."
          : "No Google full-admin allowlist is configured.",
      verification: "configuration",
    },
    {
      id: "telegram_approval_guard",
      label: "Telegram approval guard",
      category: "approval",
      status: telegramReady ? "online" : "warn",
      configured: telegramReady,
      detail: telegramReady
        ? "Webhook secret plus user and chat allowlists are configured."
        : "Approval callback is incomplete until the secret and both allowlists are configured.",
      verification: "configuration",
    },
    {
      id: "openclaw_gateway",
      label: "OpenClaw gateway",
      category: "ai",
      status: openClawReady ? "online" : openClawEnabled ? "warn" : "unknown",
      configured: openClawReady,
      detail: openClawReady
        ? "Gateway URL, operator token, and enabled state are configured. Runtime connectivity is checked in System Health."
        : openClawEnabled
          ? "Gateway is enabled but needs both a URL and operator token."
          : "Gateway is disabled; direct AI fallback configuration remains separate.",
      verification: "configuration",
    },
    {
      id: "cartesia_tts",
      label: "Cartesia voice",
      category: "voice",
      status: env.CARTESIA_API_KEY ? "unknown" : "unknown",
      configured: Boolean(env.CARTESIA_API_KEY),
      detail: env.CARTESIA_API_KEY
        ? "Voice credential is configured but not provider-probed on this surface."
        : "No Cartesia credential is configured.",
      verification: "configuration",
    },
    {
      id: "google_tts",
      label: "Google Cloud TTS",
      category: "voice",
      status: "unknown",
      configured: googleTtsReady,
      detail: googleTtsReady
        ? "Voice credential is configured but has not been provider-probed on this surface."
        : "No Google TTS API key or service account is configured.",
      verification: "configuration",
    },
    {
      id: "openai_tts",
      label: "OpenAI voice",
      category: "voice",
      status: "unknown",
      configured: Boolean(env.OPENAI_API_KEY),
      detail: env.OPENAI_API_KEY
        ? "Voice credential is configured but has not been provider-probed on this surface."
        : "No OpenAI voice credential is configured.",
      verification: "configuration",
    },
    {
      id: "hubspot",
      label: "HubSpot CRM",
      category: "integrations",
      status: "unknown",
      configured: hubspotReady,
      detail: hubspotReady
        ? "Private-app token is configured; live CRM access is not probed here."
        : "No HubSpot private-app token is configured.",
      verification: "configuration",
    },
    {
      id: "salesforce",
      label: "Salesforce CRM",
      category: "integrations",
      status: salesforceAccessReady && !salesforceRefreshReady ? "warn" : "unknown",
      configured: salesforceAccessReady,
      detail: salesforceAccessReady
        ? salesforceRefreshReady
          ? "Instance, access token, and refresh credentials are configured; live CRM access is not probed here."
          : "Instance and access token are configured, but automatic token refresh is incomplete."
        : "Salesforce needs an instance URL and access token.",
      verification: "configuration",
    },
    {
      id: "airtable",
      label: "Airtable CRM",
      category: "integrations",
      status: "unknown",
      configured: airtableReady,
      detail: airtableReady
        ? "Token and base ID are configured; live Airtable access is not probed here."
        : "Airtable needs both a personal-access token and base ID.",
      verification: "configuration",
    },
    {
      id: "notion",
      label: "Notion CRM",
      category: "integrations",
      status: "unknown",
      configured: notionReady,
      detail: notionReady
        ? "Integration secret and database ID are configured; live Notion access is not probed here."
        : "Notion needs both an integration secret and database ID.",
      verification: "configuration",
    },
    {
      id: "apollo",
      label: "Apollo lead data",
      category: "leads",
      status: "unknown",
      configured: Boolean(env.APOLLO_API_KEY),
      detail: env.APOLLO_API_KEY
        ? "Lead-search credential is configured but has not been provider-probed."
        : "No Apollo credential is configured.",
      verification: "configuration",
    },
    {
      id: "brave_search",
      label: "Brave Search",
      category: "leads",
      status: "unknown",
      configured: Boolean(env.BRAVE_API_KEY),
      detail: env.BRAVE_API_KEY
        ? "Search credential is configured but has not been provider-probed."
        : "No Brave Search credential is configured.",
      verification: "configuration",
    },
    {
      id: "serper",
      label: "Serper search",
      category: "leads",
      status: "unknown",
      configured: Boolean(env.SERPER_API_KEY),
      detail: env.SERPER_API_KEY
        ? "Search credential is configured but has not been provider-probed."
        : "No Serper credential is configured.",
      verification: "configuration",
    },
    {
      id: "google_maps",
      label: "Google Maps lead search",
      category: "leads",
      status: "unknown",
      configured: Boolean(env.GOOGLE_MAPS_API_KEY),
      detail: env.GOOGLE_MAPS_API_KEY
        ? "Lead-search key is configured but has not been provider-probed."
        : "No Google Maps lead-search key is configured.",
      verification: "configuration",
    },
    {
      id: "calendly",
      label: "Calendly booking",
      category: "calendar",
      status: calendlyReady ? "unknown" : env.CALENDLY_URL ? "warn" : "unknown",
      configured: calendlyReady,
      detail: calendlyReady
        ? "Booking URL and webhook signing secret are configured; webhook delivery is not live-verified here."
        : env.CALENDLY_URL
          ? "Booking URL is configured, but the webhook signing secret is missing."
          : "No Calendly booking connection is configured.",
      verification: "configuration",
    },
    {
      id: "outbound_webhook",
      label: "Outbound webhook",
      category: "integrations",
      status: "unknown",
      configured: webhookReady,
      detail: webhookReady
        ? "A webhook destination is configured; delivery is not live-verified here."
        : "No outbound webhook destination is configured.",
      verification: "configuration",
    },
    {
      id: "spend_actions",
      label: "Spend-capable actions",
      category: "guardrail",
      status: "online",
      configured: true,
      detail: "This console is read-only; calls, SMS, billing, provider writes, and outreach remain behind their existing action gates.",
      verification: "policy",
    },
  ];
};

const emptyBusinessSnapshot = (month: string) => ({
  month,
  workspaces: { total: 0, active: 0, entitled: 0, setupComplete: 0 },
  usage: { calls: 0, minutes: 0, aiTokens: 0, ttsChars: 0 },
  operations: { openPostCallJobs: 0, failedPostCallJobs: 0 },
  launch: { touches: 0, spendCents: 0, qualifiedConversations: 0, bookedDemos: 0, paidActivations: 0 },
});

async function loadBusinessSnapshot(sql: any, month: string) {
  const empty = emptyBusinessSnapshot(month);
  const [workspaceRows, usageRows, operationsRows, launchRows] = await Promise.all([
    sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(subscription_status, '')) = 'active')::int AS active,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(subscription_status, '')) IN ('active', 'trialing'))::int AS entitled,
        COUNT(*) FILTER (WHERE setup_completed_at IS NOT NULL)::int AS setup_complete
      FROM workspaces
    `.catch(() => []),
    sql`
      SELECT
        COALESCE(SUM(calls), 0)::int AS calls,
        COALESCE(SUM(minutes), 0)::int AS minutes,
        COALESCE(SUM(ai_tokens), 0)::int AS ai_tokens,
        COALESCE(SUM(tts_chars), 0)::int AS tts_chars
      FROM workspace_usage
      WHERE month = ${month}
    `.catch(() => []),
    sql`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('pending', 'running'))::int AS open_jobs,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_jobs
      FROM post_call_processing_jobs
    `.catch(() => []),
    sql`
      SELECT
        COALESCE(SUM(touch_count), 0)::int AS touches,
        COALESCE(SUM(spend_cents), 0)::int AS spend_cents,
        COUNT(*) FILTER (
          WHERE next_state IN ('qualified', 'proof_requested', 'checkout_started', 'paid', 'activated')
            OR response ILIKE '%qualified%'
        )::int AS qualified_conversations,
        COUNT(*) FILTER (WHERE proof_walkthrough_status IN ('scheduled', 'booked', 'completed'))::int AS booked_demos,
        COUNT(*) FILTER (
          WHERE (checkout_status = 'paid' AND activation_status = 'activated')
            OR next_state = 'activated'
        )::int AS paid_activations
      FROM launch_ledger
      WHERE created_at >= NOW() - INTERVAL '30 days'
    `.catch(() => []),
  ]);

  const workspace = workspaceRows[0] || {};
  const usage = usageRows[0] || {};
  const operations = operationsRows[0] || {};
  const launch = launchRows[0] || {};

  return {
    ...empty,
    workspaces: {
      total: asCount(workspace.total),
      active: asCount(workspace.active),
      entitled: asCount(workspace.entitled),
      setupComplete: asCount(workspace.setup_complete),
    },
    usage: {
      calls: asCount(usage.calls),
      minutes: asCount(usage.minutes),
      aiTokens: asCount(usage.ai_tokens),
      ttsChars: asCount(usage.tts_chars),
    },
    operations: {
      openPostCallJobs: asCount(operations.open_jobs),
      failedPostCallJobs: asCount(operations.failed_jobs),
    },
    launch: {
      touches: asCount(launch.touches),
      spendCents: asCount(launch.spend_cents),
      qualifiedConversations: asCount(launch.qualified_conversations),
      bookedDemos: asCount(launch.booked_demos),
      paidActivations: asCount(launch.paid_activations),
    },
  };
}

const estimateTrackedVariableCost = (usage: { minutes: number; aiTokens: number }) => {
  const twilioVoice = Math.round(usage.minutes * 0.015 * 100) / 100;
  const ai = Math.round((usage.aiTokens / 1000) * 0.0003 * 10000) / 10000;
  return {
    twilioVoice,
    ai,
    total: Math.round((twilioVoice + ai) * 100) / 100,
  };
};

const buildSettingsStoragePosture = (env: Record<string, string | undefined>) => {
  const configuredPath = String(env.SETTINGS_PATH || "").trim();
  const durable = Boolean(
    configuredPath
    && !configuredPath.startsWith("/tmp")
    && !configuredPath.startsWith("/var/tmp")
  );
  return {
    mode: durable ? "mounted-persistent-path" : "runtime-or-provider-environment",
    durableInAppWrites: durable,
    detail: durable
      ? "In-app setting writes target an explicitly configured persistent path. Provider environment remains authoritative after deploys."
      : "In-app values can update the running process, but durable production secrets must still be stored in the deployment provider before restart or redeploy.",
  };
};

const buildOwnerOperationalChecklist = (
  connections: Array<{
    id: string;
    status: string;
    configured: boolean;
    credentialState: OwnerCredentialState;
  }>,
  settingsStorage: ReturnType<typeof buildSettingsStoragePosture>,
  prospectAcquisition: ReturnType<typeof buildOwnerProspectAcquisitionOverview>
) => {
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  const available = (id: string) => {
    const connection = byId.get(id);
    return Boolean(connection && connection.status !== "offline" && connection.configured);
  };
  const probedActive = (id: string) => byId.get(id)?.credentialState === "active";
  const coreAiReady = probedActive("openrouter") || available("gemini");

  return [
    {
      id: "call_path",
      label: "Inbound call path",
      state: probedActive("twilio") && coreAiReady ? "ready" : "blocked",
      detail: "Twilio must pass a live provider probe and at least one AI path must be configured.",
      next: !probedActive("twilio") ? "Repair Twilio first." : !coreAiReady ? "Add or verify an AI provider." : "No action required.",
    },
    {
      id: "owner_alerts",
      label: "Owner alerts and proof",
      state: probedActive("resend") ? "ready" : "blocked",
      detail: "Transactional owner alerts require a provider-probed Resend connection and verified sender.",
      next: probedActive("resend") ? "No action required." : "Repair Resend and sender-domain verification.",
    },
    {
      id: "checkout",
      label: "Self-serve checkout",
      state: probedActive("stripe") ? "ready" : "blocked",
      detail: "The exact live Starter Payment Link and restricted read credential must both verify.",
      next: probedActive("stripe") ? "No action required." : "Repair the exact Stripe checkout lane before promoting it.",
    },
    {
      id: "durable_records",
      label: "Durable business records",
      state: available("database_ops") ? "ready" : "blocked",
      detail: "Calls, transcripts, tasks, leads, usage, and audit receipts require Postgres.",
      next: available("database_ops") ? "No action required." : "Restore the persistent database connection.",
    },
    {
      id: "secret_persistence",
      label: "Secret persistence",
      state: settingsStorage.durableInAppWrites ? "ready" : "attention",
      detail: settingsStorage.detail,
      next: settingsStorage.durableInAppWrites
        ? "Keep provider environment and mounted settings synchronized."
        : "Use Configure for runtime repair, then store the same secret in Railway before a restart or deploy.",
    },
    {
      id: "prospect_guardrails",
      label: "Velvet acquisition guardrails",
      state: prospectAcquisition.safeStagingState ? "ready" : "attention",
      detail: "Cold SMS, bulk email, and automated prospect dialing stay prohibited; execution switches require separate approval.",
      next: prospectAcquisition.nextAction.title,
    },
    {
      id: "production_backup",
      label: "Production backup receipt",
      state: "unverified",
      detail: "No backup receipt is connected to this endpoint, so this page cannot claim recoverability.",
      next: "Generate one exact backup request, approve only that request, then rerun the read-only readiness check.",
      actions: [
        {
          id: "open_railway_database",
          label: "Open Railway database",
          href: "https://railway.com/project/90599f03-6d6f-4044-8933-e0301be67a82/service/9d4a2f61-2ed3-4e66-8ea4-dcd07d1fbf79",
          external: true,
        },
        {
          id: "copy_backup_request",
          label: "Copy backup request",
          copyText: "npm run -s create:production-backup",
          external: false,
        },
      ],
    },
    {
      id: "deploy_parity",
      label: "GitHub and live deploy parity",
      state: "unverified",
      detail: "Connection health does not prove that production is running the current approved commit.",
      next: "Run the live-current and failed-deploy checks before deployment approval.",
    },
  ];
};

export function registerOwnerControlRoutes(app: Express, deps: OwnerControlRouteDeps): void {
  const {
    dashboardAuth,
    requireFullOperator,
    sql,
    dbEnabled,
    env,
    getWorkspaceId,
    getAdminAllowlistCount,
    buildOpsMonitor,
    log,
  } = deps;

  app.get("/api/owner-control/overview", dashboardAuth, requireFullOperator, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const month = monthKey();
    const workspaceId = getWorkspaceId(req) || 1;
    const generatedAt = new Date().toISOString();

    let ops: { services: any[]; spend: any; config: any[]; generatedAt: string } = {
      services: [],
      spend: null,
      config: [],
      generatedAt,
    };
    try {
      ops = await buildOpsMonitor(workspaceId);
    } catch (error) {
      log("warn", "Owner control provider monitor unavailable", {
        requestId: (req as any).requestId,
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }

    const business = dbEnabled
      ? await loadBusinessSnapshot(sql, month)
      : emptyBusinessSnapshot(month);
    const cost = estimateTrackedVariableCost(business.usage);
    const prospectUsage = dbEnabled
      ? await loadOwnerProspectAcquisitionUsage(sql, workspaceId, generatedAt)
      : emptyProspectAcquisitionUsage(generatedAt, "database-disabled");
    if (prospectUsage.issues.length > 0) {
      log("warn", "Owner control prospect usage telemetry is incomplete", {
        requestId: (req as any).requestId,
        workspaceId,
        issues: prospectUsage.issues,
      });
    }
    const prospectAcquisition = {
      ...buildOwnerProspectAcquisitionOverview(env),
      usage: prospectUsage,
    };
    const baseConnections = [
      ...(ops.services || []).map((service: any) => ({
        id: String(service?.id || "provider"),
        label: String(service?.label || "Provider"),
        category: String(service?.category || "provider"),
        status: String(service?.status || "unknown"),
        configured: Boolean(service?.configured),
        detail: String(service?.detail || "No provider detail available."),
        balanceLabel: service?.balanceLabel ? String(service.balanceLabel) : null,
        balanceValue: service?.balanceValue ? String(service.balanceValue) : null,
        latencyMs: Number.isFinite(Number(service?.latencyMs)) ? Number(service.latencyMs) : null,
        verification: ["twilio", "openrouter", "stripe", "resend", "elevenlabs"].includes(String(service?.id))
          ? "provider_probe"
          : "configuration",
      })),
      ...buildGuardrailConnections(env, getAdminAllowlistCount()),
    ];
    const connections = baseConnections.map((connection) => ({
      ...connection,
      ...buildOwnerConnectionManagement(connection),
    }));
    const settingsStorage = buildSettingsStoragePosture(env);
    const operationalChecklist = buildOwnerOperationalChecklist(
      connections,
      settingsStorage,
      prospectAcquisition
    );

    return res.json({
      ok: true,
      generatedAt: ops.generatedAt || generatedAt,
      access: {
        role: "operator",
        access: "full_operator",
        fullControl: true,
        readOnlyConsole: true,
        adminAllowlistCount: getAdminAllowlistCount(),
        scopes: [
          "workspace administration",
          "call and recovery operations",
          "agent and integration settings",
          "billing and launch visibility",
          "compliance and audit controls",
        ],
      },
      business,
      cost: {
        month,
        currency: "USD",
        estimated: cost,
        note: "Tracked voice and AI estimates only. Provider invoices and current provider balances remain the source of truth.",
      },
      selectedWorkspaceSpend: ops.spend || null,
      connections,
      settingsStorage,
      operationalChecklist,
      prospectAcquisition,
      credentials: buildOwnerCredentialInventory(env, ops.config || []),
      guardrails: [
        { label: "SMS and outbound delivery", state: "separate approval gate", detail: "No send control is available from this console." },
        { label: "Provider changes", state: "separate action", detail: "Connection state is visible here; provider writes stay in their guarded workflows." },
        { label: "Billing and checkout", state: "observed", detail: "This view does not create charges, alter payment links, or provision workspaces." },
        { label: "Secrets", state: "write-only", detail: "Keys and tokens are never returned to the browser from this endpoint." },
      ],
      dataSources: [
        "Provider probe: configured providers that expose a read-only health or balance endpoint.",
        "Local usage: durable workspace_usage and operations records for the current month.",
        "Prospect usage: rolling 24-hour durable reservations, provider attempts, QC tokens, and approved discovery exposure.",
        "Estimate: tracked minutes and AI tokens using the current local rate assumptions.",
      ],
    });
  });
}
