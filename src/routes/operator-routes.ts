import type { Express, NextFunction, Request, Response, RequestHandler } from "express";
import type { OpenClawConfig } from "../openclaw.js";

type OperatorRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: (req: Request, res: Response, next: NextFunction) => void;
  sql: any;
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
    sql,
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
      label: "SMIRK Operator Admin",
      spendRestricted: false,
      access: "full_operator",
      capabilities: fullOperatorCapabilities,
      pages: fullOperatorPages,
    });
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
