/**
 * HTTP Tool Plugin System
 *
 * Allows operators to define custom tools that the AI can call live during phone calls.
 * Each tool is an HTTP endpoint — the AI decides when to call it, maps caller speech
 * to parameters, and speaks the response back to the caller.
 *
 * Example use cases:
 *   - Check appointment availability: GET /api/availability?date={date}&service={service}
 *   - Look up order status: GET /api/orders?phone={caller_phone}
 *   - Check inventory: POST /api/inventory/check with { item, quantity }
 *   - Create a ticket in your own system: POST /api/tickets
 *   - Look up a customer account: GET /api/customers/{phone}
 *
 * Tool definitions are stored in the `plugin_tools` DB table and loaded at call start.
 * The AI sees them as native function declarations alongside the built-in tools.
 */

import { sql } from "./db.js";
import crypto from "crypto";

export interface PluginToolParam {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;
  example?: string;
}

export interface PluginTool {
  id: number;
  name: string;           // snake_case, used as function name by AI
  display_name: string;   // human-readable
  description: string;    // what the AI sees — be specific
  url: string;            // endpoint URL, supports {param} interpolation
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers: Record<string, string>;  // static headers (auth, content-type, etc.)
  params: PluginToolParam[];
  response_path?: string; // dot-notation path to extract from response, e.g. "data.message"
  response_template?: string; // template for AI to speak, e.g. "The status is {status}"
  enabled: boolean;
  agent_ids?: number[];   // null = all agents, [1,2] = specific agents only
  created_at: string;
}

export interface PluginToolResult {
  success: boolean;
  data?: any;
  spoken_response?: string;
  error?: string;
  statusCode?: number;
  durationMs?: number;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

export async function getPluginTools(agentId?: number): Promise<PluginTool[]> {
  try {
    const rows = await sql`
      SELECT * FROM plugin_tools
      WHERE enabled = true
        AND (agent_ids IS NULL OR ${agentId ?? null}::int = ANY(agent_ids))
      ORDER BY display_name ASC
    `;
    return rows.map((r: any) => ({
      ...r,
      headers: r.headers || {},
      params: r.params || [],
      agent_ids: r.agent_ids || null,
    }));
  } catch {
    return [];
  }
}

export async function getAllPluginTools(): Promise<PluginTool[]> {
  try {
    const rows = await sql`SELECT * FROM plugin_tools ORDER BY display_name ASC`;
    return rows.map((r: any) => ({
      ...r,
      headers: r.headers || {},
      params: r.params || [],
    }));
  } catch {
    return [];
  }
}

export async function createPluginTool(tool: Omit<PluginTool, "id" | "created_at">): Promise<PluginTool> {
  const [row] = await sql`
    INSERT INTO plugin_tools (name, display_name, description, url, method, headers, params, response_path, response_template, enabled, agent_ids)
    VALUES (
      ${tool.name}, ${tool.display_name}, ${tool.description}, ${tool.url},
      ${tool.method}, ${sql.json(tool.headers)}, ${sql.json(tool.params)},
      ${tool.response_path || null}, ${tool.response_template || null},
      ${tool.enabled}, ${tool.agent_ids ? sql.array(tool.agent_ids) : null}
    )
    RETURNING *
  `;
  return { ...row, headers: row.headers || {}, params: row.params || [] };
}

export async function updatePluginTool(id: number, updates: Partial<PluginTool>): Promise<PluginTool | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let i = 2;

  if (updates.name !== undefined) { fields.push(`name = $${i++}`); values.push(updates.name); }
  if (updates.display_name !== undefined) { fields.push(`display_name = $${i++}`); values.push(updates.display_name); }
  if (updates.description !== undefined) { fields.push(`description = $${i++}`); values.push(updates.description); }
  if (updates.url !== undefined) { fields.push(`url = $${i++}`); values.push(updates.url); }
  if (updates.method !== undefined) { fields.push(`method = $${i++}`); values.push(updates.method); }
  if (updates.headers !== undefined) { fields.push(`headers = $${i++}`); values.push(JSON.stringify(updates.headers)); }
  if (updates.params !== undefined) { fields.push(`params = $${i++}`); values.push(JSON.stringify(updates.params)); }
  if (updates.response_path !== undefined) { fields.push(`response_path = $${i++}`); values.push(updates.response_path); }
  if (updates.response_template !== undefined) { fields.push(`response_template = $${i++}`); values.push(updates.response_template); }
  if (updates.enabled !== undefined) { fields.push(`enabled = $${i++}`); values.push(updates.enabled); }

  if (fields.length === 0) return null;

  const [row] = await sql.unsafe(
    `UPDATE plugin_tools SET ${fields.join(", ")} WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return row ? { ...row, headers: row.headers || {}, params: row.params || [] } : null;
}

export async function deletePluginTool(id: number): Promise<void> {
  await sql`DELETE FROM plugin_tools WHERE id = ${id}`;
}

// ── Tool execution ────────────────────────────────────────────────────────────

function interpolateUrl(url: string, args: Record<string, any>): string {
  return url.replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(String(args[key] ?? "")));
}

function extractPath(obj: any, path: string): any {
  if (!path) return obj;
  return path.split(".").reduce((acc, key) => acc?.[key], obj);
}

function applyTemplate(template: string, data: any): string {
  if (!template) return JSON.stringify(data);
  return template.replace(/\{(\w+(?:\.\w+)*)\}/g, (_, path) => {
    const val = extractPath(data, path);
    return val !== undefined ? String(val) : `{${path}}`;
  });
}

export async function executePluginTool(
  tool: PluginTool,
  args: Record<string, any>,
  callerPhone?: string
): Promise<PluginToolResult> {
  const start = Date.now();

  try {
    // Inject caller phone if not provided
    const enrichedArgs = { caller_phone: callerPhone, ...args };

    // Build URL
    const url = tool.method === "GET"
      ? interpolateUrl(tool.url, enrichedArgs)
      : tool.url;

    // Build query params for GET
    let finalUrl = url;
    if (tool.method === "GET") {
      const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
      for (const param of tool.params) {
        if (enrichedArgs[param.name] !== undefined && !url.includes(`{${param.name}}`)) {
          urlObj.searchParams.set(param.name, String(enrichedArgs[param.name]));
        }
      }
      finalUrl = urlObj.toString();
    }

    // Build headers
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "SMIRK-AI-Agent/1.0",
      ...tool.headers,
    };

    // Build body for non-GET
    const body = tool.method !== "GET" ? JSON.stringify(enrichedArgs) : undefined;

    const res = await fetch(finalUrl, { method: tool.method, headers, body, signal: AbortSignal.timeout(8000) });
    const durationMs = Date.now() - start;

    let responseData: any;
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      responseData = await res.json();
    } else {
      responseData = await res.text();
    }

    if (!res.ok) {
      return {
        success: false,
        statusCode: res.status,
        error: `HTTP ${res.status}: ${typeof responseData === "string" ? responseData : JSON.stringify(responseData)}`,
        durationMs,
      };
    }

    // Extract relevant data
    const extracted = tool.response_path ? extractPath(responseData, tool.response_path) : responseData;

    // Build spoken response
    const spoken_response = tool.response_template
      ? applyTemplate(tool.response_template, typeof extracted === "object" ? extracted : { value: extracted, result: extracted })
      : typeof extracted === "string"
        ? extracted
        : JSON.stringify(extracted);

    return { success: true, data: extracted, spoken_response, statusCode: res.status, durationMs };
  } catch (err: any) {
    return { success: false, error: err.message, durationMs: Date.now() - start };
  }
}

// ── Convert plugin tools to AI function declarations ─────────────────────────

export function pluginToolsToDeclarations(tools: PluginTool[]): any[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        tool.params.map((p) => [
          p.name,
          {
            type: p.type,
            description: p.description + (p.example ? ` Example: ${p.example}` : ""),
          },
        ])
      ),
      required: tool.params.filter((p) => p.required).map((p) => p.name),
    },
  }));
}

// ── Test a plugin tool (for the UI test panel) ────────────────────────────────

export async function testPluginTool(
  toolId: number,
  testArgs: Record<string, any>
): Promise<{ success: boolean; result?: PluginToolResult; error?: string }> {
  try {
    const [row] = await sql`SELECT * FROM plugin_tools WHERE id = ${toolId}`;
    if (!row) return { success: false, error: "Tool not found" };
    const tool: PluginTool = { ...row, headers: row.headers || {}, params: row.params || [] };
    const result = await executePluginTool(tool, testArgs);
    return { success: true, result };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── Seed example tools ────────────────────────────────────────────────────────

export const EXAMPLE_TOOLS: Omit<PluginTool, "id" | "created_at">[] = [
  {
    name: "check_availability",
    display_name: "Check Appointment Availability",
    description: "Check if a specific date and time is available for booking. Use when the caller asks about availability or wants to book at a specific time.",
    url: "https://your-api.com/availability",
    method: "GET",
    headers: {},
    params: [
      { name: "date", type: "string", description: "Date in YYYY-MM-DD format", required: true, example: "2026-03-20" },
      { name: "service", type: "string", description: "Type of service requested", required: false, example: "HVAC inspection" },
    ],
    response_path: "available",
    response_template: "That time slot is {available}.",
    enabled: false,
    agent_ids: null,
  },
  {
    name: "lookup_order",
    display_name: "Look Up Order Status",
    description: "Look up the status of a customer's order or service request by their phone number or order ID.",
    url: "https://your-api.com/orders",
    method: "GET",
    headers: {},
    params: [
      { name: "phone", type: "string", description: "Customer phone number", required: false },
      { name: "order_id", type: "string", description: "Order or ticket ID if provided by caller", required: false },
    ],
    response_path: "order.status",
    response_template: "Your order status is: {value}.",
    enabled: false,
    agent_ids: null,
  },
  {
    name: "get_pricing",
    display_name: "Get Service Pricing",
    description: "Retrieve pricing information for a specific service. Use when the caller asks about cost or pricing.",
    url: "https://your-api.com/pricing",
    method: "GET",
    headers: {},
    params: [
      { name: "service", type: "string", description: "The service the caller is asking about", required: true, example: "oil change" },
    ],
    response_path: "price",
    response_template: "The price for {service} is {value}.",
    enabled: false,
    agent_ids: null,
  },
];
