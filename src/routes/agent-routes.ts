import type { Express, Request, RequestHandler, Response } from "express";

type AgentConfigSchema = {
  safeParse: (value: unknown) => {
    success: boolean;
    data?: any;
    error?: { issues: Array<{ message: string }> };
  };
};

type AgentRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  sql: any;
  dbEnabled: boolean;
  getWorkspaceId: (req: Request) => number;
  agentConfigSchema: AgentConfigSchema;
};

export function registerAgentRoutes(app: Express, deps: AgentRouteDeps): void {
  const { dashboardAuth, requireOperator, sql, dbEnabled, getWorkspaceId, agentConfigSchema: AgentConfigSchema } = deps;

  app.get("/api/agents", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.json({ agents: [] });
    const wsId = getWorkspaceId(req);
    const agents = await sql`SELECT * FROM agent_configs WHERE workspace_id = ${wsId} ORDER BY id DESC`;
    res.json({ agents });
  });

  app.post("/api/agents", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Database is not connected in this local environment." });
    const parsed = AgentConfigSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error?.issues[0]?.message || "Invalid agent config." });
    const { name, display_name, tagline, system_prompt, greeting, voice, language, vertical, role, tier, color, openclaw_agent_id, max_turns, tool_permissions, routing_keywords } = parsed.data;
    await sql`UPDATE agent_configs SET is_active = FALSE`;
    const agentRows = await sql`
      INSERT INTO agent_configs (name, display_name, tagline, system_prompt, greeting, voice, language, is_active, vertical, role, tier, color, max_turns, openclaw_agent_id, tool_permissions, routing_keywords)
      VALUES (${name}, ${display_name ?? name}, ${tagline ?? ''}, ${system_prompt}, ${greeting}, ${voice}, ${language}, TRUE, ${vertical}, ${role ?? 'vertical'}, ${tier ?? 'specialist'}, ${color ?? '#ff6b00'}, ${max_turns}, ${openclaw_agent_id ?? null}, ${JSON.stringify(tool_permissions ?? [])}, ${JSON.stringify(routing_keywords ?? [])})
      RETURNING id
    `;
    res.json({ success: true, id: (agentRows as any)[0]?.id });
  });

  app.put("/api/agents/:id/activate", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Database is not connected in this local environment." });
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid agent ID." });
    await sql`UPDATE agent_configs SET is_active = FALSE`;
    await sql`UPDATE agent_configs SET is_active = TRUE WHERE id = ${id}`;
    res.json({ success: true });
  });

  app.put("/api/agents/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Database is not connected in this local environment." });
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid agent ID." });
    const parsed = AgentConfigSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error?.issues[0]?.message || "Invalid agent config." });
    const { name, display_name, tagline, system_prompt, greeting, voice, language, vertical, role, tier, color, openclaw_agent_id, max_turns, tool_permissions, routing_keywords } = parsed.data;
    await sql`
      UPDATE agent_configs SET
        name = ${name}, display_name = ${display_name ?? name}, tagline = ${tagline ?? ''},
        system_prompt = ${system_prompt}, greeting = ${greeting},
        voice = ${voice}, language = ${language}, vertical = ${vertical},
        role = ${role ?? 'vertical'}, tier = ${tier ?? 'specialist'}, color = ${color ?? '#ff6b00'},
        max_turns = ${max_turns},
        openclaw_agent_id = ${openclaw_agent_id ?? null},
        tool_permissions = ${JSON.stringify(tool_permissions ?? [])},
        routing_keywords = ${JSON.stringify(routing_keywords ?? [])},
        updated_at = NOW()
      WHERE id = ${id}
    `;
    res.json({ success: true });
  });

  app.delete("/api/agents/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Database is not connected in this local environment." });
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid agent ID." });
    await sql`DELETE FROM agent_configs WHERE id = ${id}`;
    res.json({ success: true });
  });

  app.get("/api/agents/active", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(404).json({ error: "No active agent found." });
    const wsId = getWorkspaceId(req);
    const rows = await sql`SELECT * FROM agent_configs WHERE is_active = TRUE AND workspace_id = ${wsId} LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: "No active agent found." });
    res.json({ agent: rows[0] });
  });

  app.get("/api/agents/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(404).json({ error: "Agent not found." });
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid agent ID." });
    const rows = await sql`SELECT * FROM agent_configs WHERE id = ${id} LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: "Agent not found." });
    res.json({ agent: rows[0] });
  });

  app.patch("/api/agents/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Database is not connected in this local environment." });
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid agent ID." });
    const {
      name, display_name, tagline, system_prompt, greeting,
      voice, language, vertical, role, tier, color,
      max_turns, openclaw_agent_id, tool_permissions, routing_keywords, is_active,
    } = req.body;
    await sql`
      UPDATE agent_configs SET
        name             = COALESCE(${name             ?? null}, name),
        display_name     = COALESCE(${display_name     ?? null}, display_name),
        tagline          = COALESCE(${tagline          ?? null}, tagline),
        system_prompt    = COALESCE(${system_prompt    ?? null}, system_prompt),
        greeting         = COALESCE(${greeting         ?? null}, greeting),
        voice            = COALESCE(${voice            ?? null}, voice),
        language         = COALESCE(${language         ?? null}, language),
        vertical         = COALESCE(${vertical         ?? null}, vertical),
        role             = COALESCE(${role             ?? null}, role),
        tier             = COALESCE(${tier             ?? null}, tier),
        color            = COALESCE(${color            ?? null}, color),
        max_turns        = COALESCE(${max_turns        ?? null}, max_turns),
        openclaw_agent_id= COALESCE(${openclaw_agent_id?? null}, openclaw_agent_id),
        tool_permissions = COALESCE(${tool_permissions ? JSON.stringify(tool_permissions) : null}, tool_permissions),
        routing_keywords = COALESCE(${routing_keywords ? JSON.stringify(routing_keywords) : null}, routing_keywords),
        is_active        = COALESCE(${is_active        ?? null}, is_active),
        updated_at       = NOW()
      WHERE id = ${id}
    `;
    res.json({ success: true });
  });
}
