/**
 * MCP Client Bridge
 *
 * Connects SMIRK to any Model Context Protocol (MCP) server and exposes
 * its tools to the AI during live phone calls.
 *
 * Supports two transport types:
 *   - HTTP/SSE: MCP servers with a URL endpoint (most hosted MCP services)
 *   - stdio: Local MCP servers run as child processes (e.g. npx @modelcontextprotocol/server-*)
 *
 * MCP server configs are stored in the `mcp_servers` DB table.
 * At call start, enabled servers are connected, their tool lists fetched,
 * and the tools are injected into the AI's function declarations alongside
 * built-in and plugin tools.
 *
 * Popular MCP servers that work out of the box:
 *   - Stripe: npx @stripe/mcp --api-key=sk_...
 *   - Linear: npx @linear/mcp --api-key=lin_api_...
 *   - Notion: npx @notionhq/notion-mcp-server
 *   - GitHub: npx @modelcontextprotocol/server-github
 *   - Postgres: npx @modelcontextprotocol/server-postgres postgresql://...
 *   - Brave Search: npx @modelcontextprotocol/server-brave-search
 *   - Any HTTP MCP server with a /mcp endpoint
 */

import { sql } from "./db.js";
import { spawn, ChildProcess } from "child_process";

export interface McpServerConfig {
  id: number;
  name: string;           // unique slug, e.g. "stripe", "linear"
  display_name: string;
  transport: "http" | "stdio";
  url?: string;           // for HTTP transport
  command?: string;       // for stdio: e.g. "npx"
  args?: string[];        // for stdio: e.g. ["@stripe/mcp", "--api-key=sk_..."]
  env?: Record<string, string>; // extra env vars for stdio process
  headers?: Record<string, string>; // extra HTTP headers
  enabled: boolean;
  tool_prefix?: string;   // prefix added to tool names to avoid collisions, e.g. "stripe_"
  description?: string;
  created_at: string;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: any;
  serverId: number;
  serverName: string;
}

export interface McpCallResult {
  success: boolean;
  content?: any;
  spoken_response?: string;
  error?: string;
}

// Active stdio processes (kept alive for the duration of a call)
const activeProcesses = new Map<string, ChildProcess>();

// ── DB helpers ────────────────────────────────────────────────────────────────

export async function getMcpServers(): Promise<McpServerConfig[]> {
  try {
    const rows = await sql`SELECT * FROM mcp_servers ORDER BY display_name ASC`;
    return rows.map((r: any) => ({
      ...r,
      args: r.args || [],
      env: r.env || {},
      headers: r.headers || {},
    }));
  } catch {
    return [];
  }
}

export async function getEnabledMcpServers(): Promise<McpServerConfig[]> {
  try {
    const rows = await sql`SELECT * FROM mcp_servers WHERE enabled = true ORDER BY display_name ASC`;
    return rows.map((r: any) => ({
      ...r,
      args: r.args || [],
      env: r.env || {},
      headers: r.headers || {},
    }));
  } catch {
    return [];
  }
}

export async function createMcpServer(config: Omit<McpServerConfig, "id" | "created_at">): Promise<McpServerConfig> {
  const [row] = await sql`
    INSERT INTO mcp_servers (name, display_name, transport, url, command, args, env, headers, enabled, tool_prefix, description)
    VALUES (
      ${config.name}, ${config.display_name}, ${config.transport},
      ${config.url || null}, ${config.command || null},
      ${sql.json(config.args || [])}, ${sql.json(config.env || {})},
      ${sql.json(config.headers || {})}, ${config.enabled},
      ${config.tool_prefix || null}, ${config.description || null}
    )
    RETURNING *
  `;
  return { ...row, args: row.args || [], env: row.env || {}, headers: row.headers || {} };
}

export async function updateMcpServer(id: number, updates: Partial<McpServerConfig>): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [id];
  let i = 2;

  const simpleFields = ["name", "display_name", "transport", "url", "command", "enabled", "tool_prefix", "description"] as const;
  for (const f of simpleFields) {
    if (updates[f] !== undefined) { fields.push(`${f} = $${i++}`); values.push(updates[f]); }
  }
  if (updates.args !== undefined) { fields.push(`args = $${i++}`); values.push(JSON.stringify(updates.args)); }
  if (updates.env !== undefined) { fields.push(`env = $${i++}`); values.push(JSON.stringify(updates.env)); }
  if (updates.headers !== undefined) { fields.push(`headers = $${i++}`); values.push(JSON.stringify(updates.headers)); }

  if (fields.length > 0) {
    await sql.unsafe(`UPDATE mcp_servers SET ${fields.join(", ")} WHERE id = $1`, values);
  }
}

export async function deleteMcpServer(id: number): Promise<void> {
  await sql`DELETE FROM mcp_servers WHERE id = ${id}`;
}

// ── HTTP MCP Transport ────────────────────────────────────────────────────────

async function httpMcpRequest(server: McpServerConfig, method: string, params?: any): Promise<any> {
  const url = server.url!;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    ...server.headers,
  };

  const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params || {} });
  const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10000) });

  const text = await res.text();

  // Handle SSE response (some MCP servers stream)
  if (text.startsWith("data:")) {
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));
    const lastLine = lines[lines.length - 1];
    return JSON.parse(lastLine.slice(5).trim());
  }

  return JSON.parse(text);
}

// ── stdio MCP Transport ───────────────────────────────────────────────────────

function stdioMcpRequest(process: ChildProcess, method: string, params?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = Date.now();
    const request = JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n";

    let buffer = "";
    const timeout = setTimeout(() => reject(new Error("MCP stdio timeout")), 10000);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            clearTimeout(timeout);
            process.stdout?.off("data", onData);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          }
        } catch { /* not JSON, skip */ }
      }
    };

    process.stdout?.on("data", onData);
    process.stdin?.write(request);
  });
}

function startStdioProcess(server: McpServerConfig): ChildProcess {
  const key = `${server.id}`;
  if (activeProcesses.has(key)) return activeProcesses.get(key)!;

  const proc = spawn(server.command!, server.args || [], {
    env: { ...process.env, ...server.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.on("exit", () => activeProcesses.delete(key));
  proc.stderr?.on("data", (d) => console.error(`[MCP:${server.name}]`, d.toString()));

  // Initialize the MCP session
  const initMsg = JSON.stringify({
    jsonrpc: "2.0", id: 0, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smirk", version: "1.0" } }
  }) + "\n";
  proc.stdin?.write(initMsg);

  activeProcesses.set(key, proc);
  return proc;
}

// ── Fetch tools from an MCP server ───────────────────────────────────────────

export async function fetchMcpTools(server: McpServerConfig): Promise<McpTool[]> {
  try {
    let result: any;

    if (server.transport === "http") {
      result = await httpMcpRequest(server, "tools/list");
    } else {
      const proc = startStdioProcess(server);
      result = await stdioMcpRequest(proc, "tools/list");
    }

    const tools: any[] = result?.tools || [];
    const prefix = server.tool_prefix || "";

    return tools.map((t) => ({
      name: prefix + t.name,
      description: t.description || "",
      inputSchema: t.inputSchema || { type: "object", properties: {} },
      serverId: server.id,
      serverName: server.name,
    }));
  } catch (err: any) {
    console.error(`[MCP] Failed to fetch tools from ${server.name}:`, err.message);
    return [];
  }
}

// ── Call an MCP tool ──────────────────────────────────────────────────────────

export async function callMcpTool(
  server: McpServerConfig,
  toolName: string,
  args: Record<string, any>
): Promise<McpCallResult> {
  // Strip prefix from tool name before sending to server
  const prefix = server.tool_prefix || "";
  const actualName = prefix && toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;

  try {
    let result: any;

    if (server.transport === "http") {
      result = await httpMcpRequest(server, "tools/call", { name: actualName, arguments: args });
    } else {
      const proc = startStdioProcess(server);
      result = await stdioMcpRequest(proc, "tools/call", { name: actualName, arguments: args });
    }

    // Extract text content from MCP response
    const content = result?.content || result;
    let spoken_response = "";

    if (Array.isArray(content)) {
      spoken_response = content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join(" ");
    } else if (typeof content === "string") {
      spoken_response = content;
    } else if (content?.text) {
      spoken_response = content.text;
    } else {
      spoken_response = JSON.stringify(content);
    }

    return { success: true, content, spoken_response };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── Load all MCP tools for a call session ────────────────────────────────────

export interface McpSession {
  tools: McpTool[];
  serverMap: Map<string, McpServerConfig>; // tool name → server config
}

export async function loadMcpSession(): Promise<McpSession> {
  const servers = await getEnabledMcpServers();
  const allTools: McpTool[] = [];
  const serverMap = new Map<string, McpServerConfig>();

  await Promise.all(
    servers.map(async (server) => {
      const tools = await fetchMcpTools(server);
      for (const tool of tools) {
        allTools.push(tool);
        serverMap.set(tool.name, server);
      }
    })
  );

  return { tools: allTools, serverMap };
}

// ── Convert MCP tools to AI function declarations ─────────────────────────────

export function mcpToolsToDeclarations(tools: McpTool[]): any[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: `[${tool.serverName}] ${tool.description}`,
    parameters: tool.inputSchema,
  }));
}

// ── Test connectivity to an MCP server ───────────────────────────────────────

export async function testMcpServer(serverId: number): Promise<{ success: boolean; tools?: string[]; error?: string; latencyMs?: number }> {
  const start = Date.now();
  try {
    const [row] = await sql`SELECT * FROM mcp_servers WHERE id = ${serverId}`;
    if (!row) return { success: false, error: "Server not found" };

    const server: McpServerConfig = { ...row, args: row.args || [], env: row.env || {}, headers: row.headers || {} };
    const tools = await fetchMcpTools(server);

    return {
      success: true,
      tools: tools.map((t) => t.name),
      latencyMs: Date.now() - start,
    };
  } catch (err: any) {
    return { success: false, error: err.message, latencyMs: Date.now() - start };
  }
}

// ── Cleanup stdio processes ───────────────────────────────────────────────────

export function cleanupMcpProcesses(): void {
  for (const [key, proc] of activeProcesses) {
    try { proc.kill(); } catch { /* ignore */ }
    activeProcesses.delete(key);
  }
}

// ── Pre-configured popular MCP servers ───────────────────────────────────────

export const POPULAR_MCP_SERVERS: Omit<McpServerConfig, "id" | "created_at">[] = [
  {
    name: "stripe",
    display_name: "Stripe",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@stripe/agent-toolkit@latest", "--tools=all"],
    env: { STRIPE_SECRET_KEY: "" },
    headers: {},
    enabled: false,
    tool_prefix: "stripe_",
    description: "Create customers, charges, invoices, subscriptions, and payment links via Stripe.",
  },
  {
    name: "linear",
    display_name: "Linear",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@linear/mcp-server@latest"],
    env: { LINEAR_API_KEY: "" },
    headers: {},
    enabled: false,
    tool_prefix: "linear_",
    description: "Create and update issues, projects, and teams in Linear.",
  },
  {
    name: "github",
    display_name: "GitHub",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github@latest"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    headers: {},
    enabled: false,
    tool_prefix: "github_",
    description: "Search repos, create issues, and manage pull requests on GitHub.",
  },
  {
    name: "brave_search",
    display_name: "Brave Search",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search@latest"],
    env: { BRAVE_API_KEY: "" },
    headers: {},
    enabled: false,
    tool_prefix: "search_",
    description: "Search the web for real-time information during calls.",
  },
  {
    name: "postgres",
    display_name: "PostgreSQL",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres@latest", "postgresql://user:pass@host/db"],
    env: {},
    headers: {},
    enabled: false,
    tool_prefix: "db_",
    description: "Query your own PostgreSQL database live during calls.",
  },
];
