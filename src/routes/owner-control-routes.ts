import type { Express, NextFunction, Request, RequestHandler, Response } from "express";

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
        "Estimate: tracked minutes and AI tokens using the current local rate assumptions.",
      ],
    });
  });
}
