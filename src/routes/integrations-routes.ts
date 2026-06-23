import type { Express, Request, RequestHandler, Response } from "express";
import {
  getConfiguredCrms,
  isAirtableConfigured,
  isHubSpotConfigured,
  isNotionConfigured,
  isSalesforceConfigured,
} from "../crm.js";
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServers,
  POPULAR_MCP_SERVERS,
  testMcpServer,
  updateMcpServer,
} from "../mcp-bridge.js";
import {
  createPluginTool,
  deletePluginTool,
  EXAMPLE_TOOLS,
  getAllPluginTools,
  testPluginTool,
  updatePluginTool,
} from "../plugin-tools.js";
import { fireTestWebhook, loadWebhookConfig } from "../webhooks.js";

type SqlClient = <T = any>(strings: TemplateStringsArray, ...values: any[]) => Promise<T>;

type IntegrationsRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  sql: SqlClient;
};

export function registerIntegrationsRoutes(app: Express, deps: IntegrationsRouteDeps): void {
  const { dashboardAuth, requireOperator, sql } = deps;

  app.get("/api/integrations/webhook", dashboardAuth, requireOperator, (_req: Request, res: Response) => {
    const config = loadWebhookConfig();
    res.json({
      configured: !!config,
      url: config?.url ? config.url.replace(/(?<=.{8}).(?=.{4})/g, "*") : null,
      events: config?.events || [],
      retryCount: config?.retryCount || 3,
      hasSecret: !!config?.secret,
    });
  });

  app.post("/api/integrations/webhook/test", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const { url, secret } = req.body;
    const testUrl = url || process.env.WEBHOOK_URL;
    if (!testUrl) return res.status(400).json({ error: "No webhook URL configured. Add WEBHOOK_URL in Settings." });
    try {
      const result = await fireTestWebhook(testUrl, secret || process.env.WEBHOOK_SECRET);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get("/api/integrations/webhook/deliveries", dashboardAuth, requireOperator, async (_req: Request, res: Response) => {
    const rows = await sql`
      SELECT wd.*, c.from_number, c.to_number
      FROM webhook_deliveries wd
      LEFT JOIN calls c ON wd.call_sid = c.call_sid
      ORDER BY wd.created_at DESC LIMIT 50
    `;
    res.json(rows);
  });

  app.get("/api/integrations/crm", dashboardAuth, requireOperator, (_req: Request, res: Response) => {
    res.json({
      hubspot: { configured: isHubSpotConfigured(), name: "HubSpot" },
      salesforce: { configured: isSalesforceConfigured(), name: "Salesforce" },
      airtable: { configured: isAirtableConfigured(), name: "Airtable" },
      notion: { configured: isNotionConfigured(), name: "Notion" },
      active: getConfiguredCrms(),
    });
  });

  app.post("/api/integrations/crm/test", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const { platform } = req.body;
    const testContact = { phone: "+15550000000", name: "SMIRK Test", email: "test@smirk.ai", company: "SMIRK AI" };
    try {
      let result: any;
      if (platform === "hubspot") {
        const { hubspotUpsertContact } = await import("../crm.js");
        result = await hubspotUpsertContact(testContact);
      } else if (platform === "salesforce") {
        const { salesforceUpsertContact } = await import("../crm.js");
        result = await salesforceUpsertContact(testContact);
      } else if (platform === "airtable") {
        const { airtableUpsertContact } = await import("../crm.js");
        result = await airtableUpsertContact(testContact);
      } else if (platform === "notion") {
        const { notionUpsertContact } = await import("../crm.js");
        result = await notionUpsertContact(testContact);
      } else {
        return res.status(400).json({ error: "Unknown platform" });
      }
      res.json(result);
    } catch (err: any) {
      res.json({ success: false, error: err.message });
    }
  });

  app.get("/api/tools", dashboardAuth, requireOperator, async (_req: Request, res: Response) => {
    const tools = await getAllPluginTools();
    res.json({ tools, examples: EXAMPLE_TOOLS });
  });

  app.post("/api/tools", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const tool = await createPluginTool(req.body);
      res.json(tool);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put("/api/tools/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const updated = await updatePluginTool(id, req.body);
    res.json(updated || { error: "Not found" });
  });

  app.delete("/api/tools/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    await deletePluginTool(parseInt(req.params.id));
    res.json({ success: true });
  });

  app.post("/api/tools/:id/test", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const result = await testPluginTool(id, req.body || {});
    res.json(result);
  });

  app.get("/api/mcp", dashboardAuth, requireOperator, async (_req: Request, res: Response) => {
    const servers = await getMcpServers();
    res.json({ servers, popular: POPULAR_MCP_SERVERS });
  });

  app.post("/api/mcp", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const server = await createMcpServer(req.body);
      res.json(server);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put("/api/mcp/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    await updateMcpServer(id, req.body);
    res.json({ success: true });
  });

  app.delete("/api/mcp/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    await deleteMcpServer(parseInt(req.params.id));
    res.json({ success: true });
  });

  app.post("/api/mcp/:id/test", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const result = await testMcpServer(id);
    res.json(result);
  });

  app.get("/api/plugin-tools", dashboardAuth, requireOperator, async (_req: Request, res: Response) => {
    res.redirect(307, "/api/tools");
  });
  app.post("/api/plugin-tools", dashboardAuth, requireOperator, async (_req: Request, res: Response) => {
    res.redirect(307, "/api/tools");
  });
  app.put("/api/plugin-tools/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    res.redirect(307, `/api/tools/${req.params.id}`);
  });
  app.delete("/api/plugin-tools/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    res.redirect(307, `/api/tools/${req.params.id}`);
  });

  app.get("/api/mcp-servers", dashboardAuth, requireOperator, async (_req: Request, res: Response) => {
    res.redirect(307, "/api/mcp");
  });
  app.post("/api/mcp-servers", dashboardAuth, requireOperator, async (_req: Request, res: Response) => {
    res.redirect(307, "/api/mcp");
  });
  app.put("/api/mcp-servers/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    res.redirect(307, `/api/mcp/${req.params.id}`);
  });
  app.delete("/api/mcp-servers/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    res.redirect(307, `/api/mcp/${req.params.id}`);
  });
}
