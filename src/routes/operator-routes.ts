import type { Express, NextFunction, Request, Response, RequestHandler } from "express";
import type { OpenClawConfig } from "../openclaw.js";
import { calculateOperatorScoreboard, type OperatorMissionControlMetrics } from "../operator-scoreboard.js";

type OperatorRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: (req: Request, res: Response, next: NextFunction) => void;
  requireFullOperator: (req: Request, res: Response, next: NextFunction) => void;
  sql: any;
  dbEnabled: boolean;
  env: Record<string, string | undefined>;
  getOpenClawConfig: () => OpenClawConfig | null;
  testOpenClawConnection: (config: OpenClawConfig) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  queueInjectedMessage: (message: {
    callSid: string;
    message: string;
    source: "openclaw" | "dashboard" | "api";
    timestamp: string;
  }) => void;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

export function registerOperatorRoutes(app: Express, deps: OperatorRouteDeps) {
  const {
    dashboardAuth,
    requireOperator,
    requireFullOperator,
    sql,
    dbEnabled,
    env,
    getOpenClawConfig,
    testOpenClawConnection,
    queueInjectedMessage,
    log,
  } = deps;

  const fullOperatorCapabilities = [
    "all_customer_features",
    "pro_suite_bypass",
    "workspaces",
    "workspace_members",
    "usage_limits",
    "calls",
    "contacts",
    "tasks",
    "recovery",
    "handoffs",
    "appointments",
    "analytics",
    "review_queue",
    "logs",
    "migrations",
    "openclaw_injection",
    "provisioning",
    "settings",
    "agent_identity",
    "voice_config",
    "agent_configs",
    "integrations",
    "compliance",
    "prospecting",
    "lead_hunter",
    "system_health",
    "owner_control",
    "mission_control_scoreboard",
    "portfolio_observability",
    "admin_api",
  ];

  const fullOperatorPages = [
    "dashboard",
    "review",
    "calls",
    "contacts",
    "crm",
    "calendar",
    "handoffs",
    "recovery",
    "tasks",
    "settings",
    "analytics",
    "mission_control",
    "prospecting",
    "agent",
    "voice",
    "leads",
    "integrations",
    "agents",
    "compliance",
    "workspaces",
    "system_health",
    "owner_control",
    "logs",
  ];

  const demoOperatorPages = [
    "dashboard",
    "review",
    "calls",
    "contacts",
    "crm",
    "calendar",
    "handoffs",
    "recovery",
    "tasks",
    "analytics",
    "launch",
  ];

  app.get("/api/operator/session", dashboardAuth, requireOperator, (req: Request, res: Response) => {
    if ((req as any).authMode === "demo_operator") {
      return res.json({
        ok: true,
        role: "demo_operator",
        label: "SMIRK Demo Operator",
        spendRestricted: true,
        access: "read_only_demo",
        capabilities: [
          "read_dashboard",
          "read_calls",
          "read_contacts",
          "read_tasks",
          "read_recovery",
          "read_handoffs",
          "read_appointments",
          "read_analytics",
          "read_launch",
          "read_only_chat",
          "workspace_switcher",
        ],
        pages: demoOperatorPages,
        blockedActions: [
          "outbound_calls",
          "sms",
          "prospecting",
          "lead_search",
          "workspace_provisioning",
          "workspace_invites",
          "settings_changes",
          "agent_prompt_changes",
          "openclaw_injection",
          "proof_calls",
          "launch_ledger_writes",
        ],
      });
    }

    res.json({
      ok: true,
      role: "operator",
      operatorClass: "owner_operator",
      label: "SMIRK Owner Operator Admin",
      spendRestricted: false,
      access: "full_operator",
      missionControl: {
        enabled: true,
        scope: "all_workspaces",
        scoreboardEndpoint: "/api/operator/mission-control",
      },
      capabilities: fullOperatorCapabilities,
      pages: fullOperatorPages,
    });
  });

  app.get("/api/operator/mission-control", dashboardAuth, requireFullOperator, async (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    if (!dbEnabled) {
      return res.status(503).json({ error: "Mission Control requires durable workspace storage.", code: "MISSION_CONTROL_DB_REQUIRED" });
    }

    try {
      const [metricRows, workspaceRows] = await Promise.all([
        sql<any[]>`
          SELECT
            (SELECT COUNT(*) FROM workspaces) AS workspaces_total,
            (SELECT COUNT(*) FROM workspaces WHERE subscription_status IN ('active', 'trialing')) AS workspaces_active,
            (SELECT COUNT(*) FROM calls WHERE started_at >= NOW() - INTERVAL '7 days') AS calls_7d,
            (SELECT COUNT(*) FROM calls WHERE started_at >= NOW() - INTERVAL '14 days' AND started_at < NOW() - INTERVAL '7 days') AS calls_previous_7d,
            (SELECT COUNT(*) FROM calls WHERE started_at >= NOW() - INTERVAL '7 days' AND status = 'completed') AS completed_calls_7d,
            (SELECT COUNT(DISTINCT cs.call_sid) FROM call_summaries cs JOIN calls c ON c.call_sid = cs.call_sid WHERE c.started_at >= NOW() - INTERVAL '7 days') AS summarized_calls_7d,
            (SELECT COUNT(*) FROM contacts WHERE created_at >= NOW() - INTERVAL '7 days') AS contacts_7d,
            (SELECT COUNT(*) FROM tasks WHERE created_at >= NOW() - INTERVAL '7 days') AS tasks_7d,
            (SELECT COUNT(*) FROM tasks WHERE created_at >= NOW() - INTERVAL '7 days' AND status = 'completed') AS completed_tasks_7d,
            (SELECT COUNT(*) FROM tasks WHERE status IN ('open', 'in_progress')) AS open_tasks,
            (SELECT COUNT(*) FROM tasks WHERE status IN ('open', 'in_progress') AND due_at IS NOT NULL AND due_at < NOW()) AS overdue_tasks,
            (SELECT COUNT(*) FROM handoffs WHERE created_at >= NOW() - INTERVAL '7 days') AS handoffs_7d,
            (SELECT COUNT(*) FROM handoffs WHERE created_at >= NOW() - INTERVAL '7 days' AND status IN ('acknowledged', 'resolved', 'completed')) AS cleared_handoffs_7d,
            (SELECT COUNT(*) FROM handoffs WHERE status = 'pending') AS pending_handoffs,
            (SELECT COUNT(*) FROM appointments WHERE created_at >= NOW() - INTERVAL '7 days') AS appointments_7d,
            (SELECT COUNT(*) FROM appointments WHERE status != 'cancelled' AND scheduled_at >= NOW()) AS upcoming_appointments,
            (SELECT COUNT(*) FROM provisioning_requests WHERE status NOT IN ('workspace_and_line_created', 'workspace_created', 'activated', 'complete', 'cancelled')) AS provisioning_attention
        `,
        sql<any[]>`
          SELECT
            w.id,
            w.name,
            w.slug,
            w.plan,
            w.subscription_status,
            w.calls_this_month,
            w.minutes_this_month,
            w.monthly_call_limit,
            w.monthly_minute_limit,
            (SELECT COUNT(*) FROM calls c WHERE c.workspace_id = w.id AND c.started_at >= NOW() - INTERVAL '7 days') AS calls_7d,
            (SELECT COUNT(*) FROM contacts c WHERE c.workspace_id = w.id AND c.created_at >= NOW() - INTERVAL '7 days') AS contacts_7d,
            (SELECT COUNT(*) FROM tasks t WHERE t.workspace_id = w.id AND t.status IN ('open', 'in_progress')) AS open_tasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.workspace_id = w.id AND t.status IN ('open', 'in_progress') AND t.due_at IS NOT NULL AND t.due_at < NOW()) AS overdue_tasks,
            (SELECT COUNT(*) FROM handoffs h WHERE h.workspace_id = w.id AND h.status = 'pending') AS pending_handoffs,
            (SELECT COUNT(*) FROM appointments a WHERE a.workspace_id = w.id AND a.created_at >= NOW() - INTERVAL '7 days') AS appointments_7d
          FROM workspaces w
          ORDER BY
            (SELECT COUNT(*) FROM tasks t WHERE t.workspace_id = w.id AND t.status IN ('open', 'in_progress') AND t.due_at IS NOT NULL AND t.due_at < NOW()) DESC,
            (SELECT COUNT(*) FROM calls c WHERE c.workspace_id = w.id AND c.started_at >= NOW() - INTERVAL '7 days') DESC,
            w.id ASC
          LIMIT 50
        `,
      ]);

      const row = metricRows[0] || {};
      const number = (value: unknown) => Number(value || 0);
      const rawMetrics = {
        workspacesTotal: number(row.workspaces_total),
        workspacesActive: number(row.workspaces_active),
        calls7d: number(row.calls_7d),
        callsPrevious7d: number(row.calls_previous_7d),
        completedCalls7d: number(row.completed_calls_7d),
        summarizedCalls7d: number(row.summarized_calls_7d),
        contacts7d: number(row.contacts_7d),
        tasks7d: number(row.tasks_7d),
        completedTasks7d: number(row.completed_tasks_7d),
        openTasks: number(row.open_tasks),
        overdueTasks: number(row.overdue_tasks),
        handoffs7d: number(row.handoffs_7d),
        clearedHandoffs7d: number(row.cleared_handoffs_7d),
        pendingHandoffs: number(row.pending_handoffs),
        appointments7d: number(row.appointments_7d),
        upcomingAppointments: number(row.upcoming_appointments),
        provisioningAttention: number(row.provisioning_attention),
      };
      const score = calculateOperatorScoreboard({
        calls: rawMetrics.calls7d,
        completedCalls: rawMetrics.completedCalls7d,
        summarizedCalls: rawMetrics.summarizedCalls7d,
        tasks: rawMetrics.tasks7d,
        completedTasks: rawMetrics.completedTasks7d,
        handoffs: rawMetrics.handoffs7d,
        clearedHandoffs: rawMetrics.clearedHandoffs7d,
      });
      const metrics: OperatorMissionControlMetrics = {
        workspaces: { total: rawMetrics.workspacesTotal, active: rawMetrics.workspacesActive },
        calls: {
          last7d: rawMetrics.calls7d,
          previous7d: rawMetrics.callsPrevious7d,
          completed7d: rawMetrics.completedCalls7d,
          summarized7d: rawMetrics.summarizedCalls7d,
        },
        contacts: { new7d: rawMetrics.contacts7d },
        tasks: {
          created7d: rawMetrics.tasks7d,
          completed7d: rawMetrics.completedTasks7d,
          open: rawMetrics.openTasks,
          overdue: rawMetrics.overdueTasks,
        },
        handoffs: {
          created7d: rawMetrics.handoffs7d,
          cleared7d: rawMetrics.clearedHandoffs7d,
          pending: rawMetrics.pendingHandoffs,
        },
        appointments: {
          created7d: rawMetrics.appointments7d,
          upcoming: rawMetrics.upcomingAppointments,
        },
        provisioning: { needsAttention: rawMetrics.provisioningAttention },
      };

      return res.json({
        ok: true,
        generatedAt: new Date().toISOString(),
        scope: "all_workspaces",
        access: "full_operator",
        score,
        metrics,
        workspaces: workspaceRows.map((workspace: any) => ({
          id: number(workspace.id),
          name: String(workspace.name || `Workspace ${workspace.id}`),
          slug: String(workspace.slug || ""),
          plan: String(workspace.plan || "free"),
          subscriptionStatus: String(workspace.subscription_status || "none"),
          callsThisMonth: number(workspace.calls_this_month),
          minutesThisMonth: number(workspace.minutes_this_month),
          monthlyCallLimit: number(workspace.monthly_call_limit),
          monthlyMinuteLimit: number(workspace.monthly_minute_limit),
          calls7d: number(workspace.calls_7d),
          contacts7d: number(workspace.contacts_7d),
          openTasks: number(workspace.open_tasks),
          overdueTasks: number(workspace.overdue_tasks),
          pendingHandoffs: number(workspace.pending_handoffs),
          appointments7d: number(workspace.appointments_7d),
        })),
      });
    } catch (error: any) {
      log("error", "Operator Mission Control scoreboard failed", { error: error?.message || String(error) });
      return res.status(503).json({ error: "Mission Control scoreboard is temporarily unavailable.", code: "MISSION_CONTROL_UNAVAILABLE" });
    }
  });

  app.get("/api/openclaw/status", dashboardAuth, requireOperator, async (_req: Request, res: Response) => {
    const cfg = getOpenClawConfig();
    if (!cfg?.enabled) {
      return res.json({
        enabled: false,
        gatewayUrl: env.OPENCLAW_GATEWAY_URL || "",
        agentId: env.OPENCLAW_AGENT_ID || "main",
        model: env.OPENCLAW_MODEL || "",
        connected: false,
      });
    }

    const test = await testOpenClawConnection(cfg);
    res.json({
      enabled: true,
      gatewayUrl: cfg.gatewayUrl,
      agentId: cfg.agentId,
      model: cfg.model,
      connected: test.ok,
      latencyMs: test.latencyMs,
      error: test.error,
    });
  });

  app.post("/api/openclaw/test", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const { gatewayUrl, token, agentId, model } = req.body;
    if (!gatewayUrl || !token) {
      return res.status(400).json({ error: "gatewayUrl and token are required" });
    }
    const testCfg: OpenClawConfig = {
      enabled: true,
      gatewayUrl: (gatewayUrl as string).replace(/\/$/, ""),
      token,
      agentId: agentId || "main",
      model: model || `openclaw:${agentId || "main"}`,
      timeoutMs: 8_000,
    };
    const result = await testOpenClawConnection(testCfg);
    res.json(result);
  });

  app.post("/api/openclaw/inject", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const { callSid, message, source } = req.body;
    if (!callSid || typeof callSid !== "string") {
      return res.status(400).json({ error: "callSid is required" });
    }
    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({ error: "message is required" });
    }

    const callStatusRows = await sql<{ status: string }[]>`SELECT status FROM calls WHERE call_sid = ${callSid}`;
    const call = callStatusRows[0];
    if (!call) {
      return res.status(404).json({ error: "Call not found" });
    }
    if (call.status !== "in-progress") {
      return res.status(409).json({ error: `Call is not active (status: ${call.status})` });
    }

    queueInjectedMessage({
      callSid,
      message: message.trim(),
      source: (source as "openclaw" | "dashboard" | "api") || "api",
      timestamp: new Date().toISOString(),
    });

    log("info", "Message injected into active call", {
      requestId: (req as any).requestId,
      callSid,
      source: source || "api",
      messageLength: message.length,
    });

    res.json({ success: true, callSid, queued: true });
  });

  app.get("/api/openclaw/active-calls", dashboardAuth, requireOperator, async (_req: Request, res: Response) => {
    const activeCalls = await sql`
      SELECT c.call_sid, c.direction, c.from_number, c.to_number, c.started_at, c.turn_count,
             co.name as contact_name, co.phone_number
      FROM calls c
      LEFT JOIN contacts co ON c.contact_id = co.id
      WHERE c.status = 'in-progress'
      ORDER BY c.started_at DESC
    `;
    res.json(activeCalls);
  });
}
