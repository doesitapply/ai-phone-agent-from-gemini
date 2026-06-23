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

  app.get("/api/operator/session", dashboardAuth, requireOperator, (_req: Request, res: Response) => {
    res.json({
      ok: true,
      role: "operator",
      capabilities: [
        "workspaces",
        "logs",
        "migrations",
        "openclaw_injection",
        "provisioning",
        "settings",
        "admin_api",
      ],
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
