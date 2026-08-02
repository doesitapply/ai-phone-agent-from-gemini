import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import {
  PROSPECT_ACQUISITION_CONFIGURATION_PHASES,
  buildProspectAcquisitionConnectionReadiness,
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
  VELVET_OUTCOME_DISPATCH_ENABLED: "Velvet outcome dispatch",
} as const;

const PROSPECT_PHASE_LABELS = {
  "velvet-authority": "Velvet authority",
  "no-contact-discovery": "No-contact discovery",
  "pre-approval-qc": "Pre-approval QC",
  "controlled-inbox-placement": "Controlled inbox placement",
  "single-recipient-email": "Single-recipient email",
  "closed-loop-learning": "Closed-loop learning",
} as const;

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
  const [emailResult, qcResult, discoveryResult] = await Promise.allSettled([
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
  const email = emailRows[0] || {};
  const qc = qcRows[0] || {};
  const discovery = discoveryRows[0] || {};
  const availableStreams = 3 - issues.length;

  return {
    availability: (
      availableStreams === 3
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
    issues,
    externalAction: "none" as const,
  };
}

const asCount = (value: unknown): number => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
};

const monthKey = () => new Date().toISOString().slice(0, 7);

const cleanConfigInventory = (config: any[]) => config.map((item) => ({
  key: String(item?.key || "unknown"),
  label: String(item?.label || "Configuration"),
  configured: Boolean(item?.set),
  critical: Boolean(item?.critical),
  exposure: "write_only_secret",
}));

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
      status: process.env.CARTESIA_API_KEY ? "online" : "unknown",
      configured: Boolean(process.env.CARTESIA_API_KEY),
      detail: process.env.CARTESIA_API_KEY ? "Voice credential is configured." : "No Cartesia credential is configured.",
      verification: "configuration",
    },
    {
      id: "openai_tts",
      label: "OpenAI voice",
      category: "voice",
      status: env.OPENAI_API_KEY ? "online" : "unknown",
      configured: Boolean(env.OPENAI_API_KEY),
      detail: env.OPENAI_API_KEY ? "Voice credential is configured." : "No OpenAI voice credential is configured.",
      verification: "configuration",
    },
    {
      id: "calendly",
      label: "Calendly booking",
      category: "calendar",
      status: calendlyReady ? "online" : env.CALENDLY_URL ? "warn" : "unknown",
      configured: calendlyReady,
      detail: calendlyReady
        ? "Booking URL and webhook signing secret are configured."
        : env.CALENDLY_URL
          ? "Booking URL is configured, but the webhook signing secret is missing."
          : "No Calendly booking connection is configured.",
      verification: "configuration",
    },
    {
      id: "outbound_webhook",
      label: "Outbound webhook",
      category: "integrations",
      status: webhookReady ? "online" : "unknown",
      configured: webhookReady,
      detail: webhookReady ? "A webhook destination is configured." : "No outbound webhook destination is configured.",
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
    const connections = [
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
      prospectAcquisition,
      credentials: cleanConfigInventory(ops.config || []),
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
