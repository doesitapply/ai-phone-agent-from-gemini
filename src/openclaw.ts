/**
 * OpenClaw Gateway Adapter
 *
 * Bridges the AI phone agent to an OpenClaw Gateway instance.
 * When enabled, OpenClaw becomes the AI brain for all phone calls.
 * Falls back to direct Gemini if OpenClaw is unreachable or disabled.
 *
 * Integration surface: POST /v1/responses (OpenResponses-compatible HTTP API)
 * Docs: https://docs.openclaw.ai/gateway/openresponses-http-api
 *
 * OpenClaw config (openclaw.json) required to enable the endpoint:
 *   { gateway: { http: { endpoints: { responses: { enabled: true } } } } }
 */

export interface OpenClawConfig {
  /** Base URL of the OpenClaw Gateway, e.g. http://localhost:18789 */
  gatewayUrl: string;
  /** Bearer token (gateway.auth.token or OPENCLAW_GATEWAY_TOKEN) */
  token: string;
  /** Agent ID to target, e.g. "main" */
  agentId: string;
  /** Model string, e.g. "openclaw:main" or "openai-codex/gpt-5.3-codex" */
  model: string;
  /** Whether OpenClaw integration is active */
  enabled: boolean;
  /** Timeout in ms for Gateway requests (default 10000) */
  timeoutMs?: number;
}

export interface OpenClawResponse {
  text: string;
  latencyMs: number;
  /** True if response came from OpenClaw, false if from Gemini fallback */
  fromOpenClaw: boolean;
  /** Raw output items from the OpenResponses response */
  outputItems?: unknown[];
}

export interface OpenClawInjectResult {
  success: boolean;
  error?: string;
}

/**
 * Derives a stable session key for a call so that multi-turn conversations
 * share the same OpenClaw session context.
 * Format: "phone-call-{callSid}" — unique per call, stable across turns.
 */
export function callSessionKey(callSid: string): string {
  return `phone-call-${callSid}`;
}

/**
 * Builds the system prompt that OpenClaw receives at the start of each turn.
 * This injects the phone call context so OpenClaw knows it is operating
 * as a phone agent, not a chat assistant.
 */
export function buildOpenClawSystemPrompt(
  agentSystemPrompt: string,
  callerContext: string,
  callSid: string,
  callerPhone: string,
  turnCount: number
): string {
  return [
    agentSystemPrompt,
    "",
    "--- PHONE CALL CONTEXT ---",
    `You are currently handling a live phone call.`,
    `Call SID: ${callSid}`,
    `Caller phone: ${callerPhone}`,
    `Turn number: ${turnCount}`,
    callerContext ? `Caller context: ${callerContext}` : "",
    "",
    "IMPORTANT PHONE CALL RULES:",
    "- Keep responses SHORT — under 3 sentences. This is spoken audio.",
    "- Do NOT use markdown, bullet points, or formatting. Plain speech only.",
    "- Do NOT say 'As an AI' or similar disclaimers.",
    "- If you need to end the call, say goodbye naturally.",
    "- You have access to tools: book appointments, create leads, send SMS, escalate to humans.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Sends a single turn to the OpenClaw Gateway and returns the text response.
 * Uses the OpenResponses HTTP API (POST /v1/responses).
 *
 * Session is keyed by callSid so each call has its own isolated context.
 * The `user` field in the request body makes the session stable across turns.
 */
export async function queryOpenClaw(
  config: OpenClawConfig,
  callSid: string,
  callerPhone: string,
  speechText: string,
  systemPrompt: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
  turnCount: number
): Promise<OpenClawResponse> {
  const startMs = Date.now();
  const sessionKey = callSessionKey(callSid);
  const timeoutMs = config.timeoutMs ?? 10_000;

  // Build input array: history items + current user message
  // OpenResponses format: array of { role, content } message items
  const inputItems: Array<{ type: "message"; role: string; content: string }> =
    [];

  // Include recent history (last 10 turns to stay within context)
  const recentHistory = conversationHistory.slice(-10);
  for (const msg of recentHistory) {
    inputItems.push({ type: "message", role: msg.role, content: msg.content });
  }

  // Add current user speech
  inputItems.push({ type: "message", role: "user", content: speechText });

  const requestBody = {
    model: config.model || `openclaw:${config.agentId}`,
    input: inputItems,
    instructions: systemPrompt,
    stream: false,
    user: sessionKey, // stable session key — same session across turns
    max_output_tokens: 300, // keep phone responses short
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${config.gatewayUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
        "x-openclaw-agent-id": config.agentId,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(
        `OpenClaw Gateway returned ${response.status}: ${errBody}`
      );
    }

    const data = (await response.json()) as {
      output?: Array<{
        type: string;
        content?: Array<{ type: string; text?: string }>;
        text?: string;
      }>;
      error?: { message: string };
    };

    if (data.error) {
      throw new Error(`OpenClaw error: ${data.error.message}`);
    }

    // Extract text from output items
    // OpenResponses output format: output[].content[].text (for message items)
    let text = "";
    if (data.output && Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.type === "output_text" && part.text) {
              text += part.text;
            }
          }
        }
        // Some versions return text directly on the item
        if (item.text) {
          text += item.text;
        }
      }
    }

    if (!text.trim()) {
      throw new Error("OpenClaw returned empty response");
    }

    const latencyMs = Date.now() - startMs;
    return {
      text: text.trim(),
      latencyMs,
      fromOpenClaw: true,
      outputItems: data.output,
    };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const message =
      err instanceof Error ? err.message : "Unknown OpenClaw error";
    throw new Error(`OpenClaw Gateway request failed: ${message}`);
  }
}

/**
 * Tests connectivity to the OpenClaw Gateway.
 * Returns { ok: true } if the Gateway responds, { ok: false, error } otherwise.
 */
export async function testOpenClawConnection(
  config: OpenClawConfig
): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5_000);

    const response = await fetch(`${config.gatewayUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
        "x-openclaw-agent-id": config.agentId,
      },
      body: JSON.stringify({
        model: config.model || `openclaw:${config.agentId}`,
        input: "ping",
        max_output_tokens: 10,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - start;

    if (response.status === 401) {
      return { ok: false, error: "Invalid token — check OPENCLAW_GATEWAY_TOKEN" };
    }
    if (response.status === 404) {
      return {
        ok: false,
        error:
          "OpenResponses endpoint not found — enable it in openclaw.json: gateway.http.endpoints.responses.enabled = true",
      };
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, error: `Gateway returned ${response.status}: ${body}` };
    }

    return { ok: true, latencyMs };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort") || msg.includes("timeout")) {
      return { ok: false, error: "Gateway connection timed out — is OpenClaw running?" };
    }
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      return {
        ok: false,
        error: `Cannot reach Gateway at ${config.gatewayUrl} — is OpenClaw running on that host/port?`,
      };
    }
    return { ok: false, error: msg };
  }
}

/**
 * Loads OpenClaw config from environment variables.
 * Returns null if OpenClaw is not configured or disabled.
 */
export function loadOpenClawConfig(): OpenClawConfig | null {
  const enabled = process.env.OPENCLAW_ENABLED === "true";
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL?.replace(/\/$/, "");
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;

  if (!enabled || !gatewayUrl || !token) {
    return null;
  }

  return {
    enabled: true,
    gatewayUrl,
    token,
    agentId: process.env.OPENCLAW_AGENT_ID || "main",
    model:
      process.env.OPENCLAW_MODEL ||
      `openclaw:${process.env.OPENCLAW_AGENT_ID || "main"}`,
    timeoutMs: parseInt(process.env.OPENCLAW_TIMEOUT_MS || "10000", 10),
  };
}

/**
 * Sends a message to an active call via OpenClaw injection.
 * This allows OpenClaw (or any external caller) to push text into a live call.
 * The injected message is stored as an AI turn and spoken on the next Gather.
 *
 * This is used by the POST /api/openclaw/inject endpoint.
 */
export interface InjectedMessage {
  callSid: string;
  message: string;
  source: "openclaw" | "dashboard" | "api";
  timestamp: string;
}

// In-memory queue of injected messages per callSid
// The /api/twilio/process handler checks this before calling the AI
const injectedMessageQueue = new Map<string, InjectedMessage[]>();

export function queueInjectedMessage(msg: InjectedMessage): void {
  const queue = injectedMessageQueue.get(msg.callSid) ?? [];
  queue.push(msg);
  injectedMessageQueue.set(msg.callSid, queue);
}

export function dequeueInjectedMessages(callSid: string): InjectedMessage[] {
  const msgs = injectedMessageQueue.get(callSid) ?? [];
  injectedMessageQueue.delete(callSid);
  return msgs;
}

export function hasInjectedMessages(callSid: string): boolean {
  return (injectedMessageQueue.get(callSid)?.length ?? 0) > 0;
}
