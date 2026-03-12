/**
 * OpenClaw Gateway Bridge
 *
 * Connects the phone agent to the OpenClaw Gateway WebSocket to receive
 * voice-call plugin events and respond via the Gateway's voicecall.speak RPC.
 *
 * Architecture:
 *   Twilio → OpenClaw voice-call plugin (answers call, streams audio, runs STT)
 *              ↓ Gateway WS event: "plugin:event" { plugin: "voice-call", event: "transcript", ... }
 *   OpenClaw Gateway Bridge (this module)
 *              ↓ generateAiResponse() → Codex 5.3 via OpenClaw OR Gemini fallback
 *   AI response text
 *              ↓ POST /rpc  { method: "voicecall.speak", params: { callId, text } }
 *   OpenClaw voice-call plugin → Twilio TTS → caller hears response
 *
 * Key fix vs. previous version:
 *   - Uses correct Gateway WS event envelope: { type: "plugin:event", plugin: "voice-call", event: "..." }
 *   - Uses Gateway RPC endpoint POST /rpc instead of /v1/voice-call/speak
 *   - Handles "agent:busy" event to detect queue saturation and log it
 *   - Subscribes to the correct channel name: "plugin:voice-call"
 */

import WebSocket from "ws";

export interface GatewayBridgeConfig {
  gatewayUrl: string;        // e.g. http://127.0.0.1:18789
  token: string;             // Gateway auth token
  agentId: string;           // e.g. "main"
  reconnectDelayMs?: number;
}

export interface VoiceCallEvent {
  type: string;
  callId: string;
  from?: string;
  to?: string;
  transcript?: string;
  confidence?: number;
  direction?: "inbound" | "outbound";
  raw?: Record<string, unknown>;
}

export type TranscriptHandler = (event: VoiceCallEvent) => Promise<string | null>;
export type CallStartHandler  = (event: VoiceCallEvent) => Promise<string | null>;
export type CallEndHandler    = (event: VoiceCallEvent) => void;

export interface GatewayBridgeHandlers {
  onTranscript: TranscriptHandler;
  onCallStart?: CallStartHandler;
  onCallEnd?: CallEndHandler;
}

type Logger = (level: string, msg: string, meta?: Record<string, unknown>) => void;

// ── Helpers ───────────────────────────────────────────────────────────────────

function wsToHttp(url: string): string {
  return url.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

function httpToWs(url: string): string {
  return url.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
}

/**
 * Extract callId from any known field name across Gateway versions.
 */
function extractCallId(msg: Record<string, unknown>): string {
  return (
    (msg.callId as string) ??
    (msg.call_id as string) ??
    (msg.id as string) ??
    ((msg.data as any)?.callId as string) ??
    ""
  );
}

/**
 * Extract transcript text from any known field name.
 */
function extractTranscript(msg: Record<string, unknown>): string {
  return (
    (msg.transcript as string) ??
    (msg.text as string) ??
    (msg.speech as string) ??
    ((msg.data as any)?.transcript as string) ??
    ""
  );
}

// ── OpenClawGatewayBridge ─────────────────────────────────────────────────────

export class OpenClawGatewayBridge {
  private ws: WebSocket | null = null;
  private config: GatewayBridgeConfig;
  private handlers: GatewayBridgeHandlers;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;
  private connId = "";
  private log: Logger;

  // Track active calls so we can skip duplicate events
  private activeCalls = new Set<string>();

  constructor(
    config: GatewayBridgeConfig,
    handlers: GatewayBridgeHandlers,
    logger?: Logger
  ) {
    this.config = config;
    this.handlers = handlers;
    this.log = logger ?? ((level, msg, meta) =>
      console.log(`[openclaw-bridge] [${level}] ${msg}`, meta ? JSON.stringify(meta) : "")
    );
  }

  connect(): void {
    if (this.ws) return;
    this._connect();
  }

  disconnect(): void {
    this.isShuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ── WebSocket connection ────────────────────────────────────────────────────

  private _connect(): void {
    const wsBase = httpToWs(this.config.gatewayUrl.replace(/\/$/, ""));
    const url = `${wsBase}/gateway/ws`;

    this.log("info", "Connecting to OpenClaw Gateway WebSocket", { url });

    try {
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          "x-openclaw-agent-id": this.config.agentId,
          "x-openclaw-client": "ai-phone-agent-bridge/2.0",
        },
      });
    } catch (err: any) {
      this.log("error", "Failed to create WebSocket", { error: err.message });
      this._scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.log("info", "Connected to OpenClaw Gateway WebSocket");
      // Subscribe to voice-call plugin events using the correct channel name
      this._send({ type: "subscribe", channels: ["plugin:voice-call", "voice-call"] });
    });

    this.ws.on("message", (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        this._handleMessage(msg).catch((e) =>
          this.log("error", "Unhandled error in message handler", { error: e.message })
        );
      } catch {
        // non-JSON, ignore
      }
    });

    this.ws.on("close", (code, reason) => {
      this.log("warn", "Gateway WebSocket closed", { code, reason: reason.toString() });
      this.ws = null;
      if (!this.isShuttingDown) this._scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      this.log("error", "Gateway WebSocket error", { error: err.message });
      // close event fires after error → triggers reconnect
    });
  }

  private _scheduleReconnect(): void {
    if (this.isShuttingDown || this.reconnectTimer) return;
    const delay = this.config.reconnectDelayMs ?? 5_000;
    this.log("info", `Reconnecting to Gateway in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }

  private _send(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  // ── Message handling ────────────────────────────────────────────────────────

  private async _handleMessage(msg: Record<string, unknown>): Promise<void> {
    const type = msg.type as string;

    // ── Handshake ──────────────────────────────────────────────────────────
    if (type === "connected" || type === "hello" || type === "welcome") {
      this.connId = (msg.connId as string) ?? (msg.id as string) ?? "";
      this.log("info", "Gateway handshake complete", { connId: this.connId });
      return;
    }

    // ── Agent busy warning — the root cause of hold music ─────────────────
    if (type === "agent:busy" || type === "agent:queue:full") {
      this.log("warn",
        "OpenClaw agent queue is full — calls are being put on hold. " +
        "Run: node scripts/fix-openclaw.mjs to clear stale sessions.",
        { msg }
      );
      return;
    }

    // ── Normalize plugin:event envelope (newer Gateway versions) ──────────
    // Gateway wraps plugin events as: { type: "plugin:event", plugin: "voice-call", event: "transcript", ... }
    let normalizedType = type;
    let payload = msg;

    if (type === "plugin:event" && msg.plugin === "voice-call") {
      normalizedType = `voice-call:${msg.event as string}`;
      payload = { ...msg, ...(msg.data as Record<string, unknown> ?? {}) };
    }

    // ── Inbound call started ───────────────────────────────────────────────
    if (
      normalizedType === "voice-call:inbound" ||
      normalizedType === "voice-call:call.started" ||
      normalizedType === "voice-call:call.created" ||
      normalizedType === "voice-call:answered"
    ) {
      const event: VoiceCallEvent = {
        type: normalizedType,
        callId: extractCallId(payload),
        from: payload.from as string,
        to: payload.to as string,
        direction: "inbound",
        raw: payload,
      };

      if (!event.callId) {
        this.log("warn", "Received call start event with no callId", { payload });
        return;
      }

      this.activeCalls.add(event.callId);
      this.log("info", "Inbound call via OpenClaw voice-call plugin", {
        callId: event.callId,
        from: event.from,
      });

      if (this.handlers.onCallStart) {
        try {
          const greeting = await this.handlers.onCallStart(event);
          if (greeting) {
            await this._speak(event.callId, greeting);
          }
        } catch (err: any) {
          this.log("error", "onCallStart handler failed", { error: err.message, callId: event.callId });
        }
      }
      return;
    }

    // ── Transcript received — caller said something ────────────────────────
    if (
      normalizedType === "voice-call:transcript" ||
      normalizedType === "voice-call:speech" ||
      normalizedType === "voice-call:speech.final" ||
      normalizedType === "voice-call:stt.result"
    ) {
      const event: VoiceCallEvent = {
        type: normalizedType,
        callId: extractCallId(payload),
        transcript: extractTranscript(payload),
        confidence: payload.confidence as number,
        from: payload.from as string,
        raw: payload,
      };

      if (!event.transcript?.trim()) return;

      this.log("info", "Transcript received via OpenClaw", {
        callId: event.callId,
        transcript: event.transcript.slice(0, 100),
      });

      try {
        const response = await this.handlers.onTranscript(event);
        if (response) {
          await this._speak(event.callId, response);
        }
      } catch (err: any) {
        this.log("error", "onTranscript handler failed", { error: err.message, callId: event.callId });
        await this._speak(
          event.callId,
          "I'm sorry, I had a brief technical issue. Could you say that again?"
        ).catch(() => {});
      }
      return;
    }

    // ── Call ended ────────────────────────────────────────────────────────
    if (
      normalizedType === "voice-call:call.ended" ||
      normalizedType === "voice-call:hangup" ||
      normalizedType === "voice-call:completed" ||
      normalizedType === "voice-call:call.completed"
    ) {
      const event: VoiceCallEvent = {
        type: normalizedType,
        callId: extractCallId(payload),
        raw: payload,
      };
      this.activeCalls.delete(event.callId);
      this.log("info", "Call ended via OpenClaw", { callId: event.callId });
      if (this.handlers.onCallEnd) {
        this.handlers.onCallEnd(event);
      }
      return;
    }

    // ── Log unknown event types at debug level ────────────────────────────
    if (type !== "pong" && type !== "ping" && !type.startsWith("subscribed")) {
      this.log("debug", `Unhandled Gateway event: ${type}`, { type, keys: Object.keys(msg) });
    }
  }

  // ── Speak via Gateway RPC ─────────────────────────────────────────────────

  /**
   * Sends text to be spoken on an active call.
   *
   * Tries two methods in order:
   *   1. POST /rpc  { method: "voicecall.speak", params: { callId, text } }  (preferred — Gateway RPC)
   *   2. POST /v1/voice-call/speak  { callId, text }  (legacy REST fallback)
   */
  private async _speak(callId: string, text: string): Promise<void> {
    const httpBase = wsToHttp(this.config.gatewayUrl.replace(/\/$/, ""));
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.token}`,
      "x-openclaw-agent-id": this.config.agentId,
    };

    // Method 1: Gateway RPC (correct for OpenClaw 2026.x)
    try {
      const rpcRes = await fetch(`${httpBase}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          method: "voicecall.speak",
          params: { callId, text },
        }),
        signal: AbortSignal.timeout(8_000),
      });

      if (rpcRes.ok) {
        this.log("debug", "Spoke via Gateway RPC voicecall.speak", { callId, textLength: text.length });
        return;
      }

      const rpcBody = await rpcRes.text().catch(() => "");
      // 404 means this RPC method isn't registered — fall through to legacy
      if (rpcRes.status !== 404) {
        this.log("warn", "voicecall.speak RPC returned non-OK", {
          status: rpcRes.status,
          body: rpcBody.slice(0, 200),
          callId,
        });
        return;
      }
    } catch (err: any) {
      if (!err.message?.includes("ECONNREFUSED")) {
        this.log("warn", "voicecall.speak RPC failed", { error: err.message, callId });
      }
    }

    // Method 2: Legacy REST endpoint
    try {
      const legacyRes = await fetch(`${httpBase}/v1/voice-call/speak`, {
        method: "POST",
        headers,
        body: JSON.stringify({ callId, text }),
        signal: AbortSignal.timeout(8_000),
      });

      if (legacyRes.ok) {
        this.log("debug", "Spoke via legacy /v1/voice-call/speak", { callId, textLength: text.length });
      } else {
        const body = await legacyRes.text().catch(() => "");
        this.log("warn", "Legacy speak endpoint returned non-OK", {
          status: legacyRes.status,
          body: body.slice(0, 200),
          callId,
        });
      }
    } catch (err: any) {
      this.log("error", "Both speak methods failed", { error: err.message, callId });
    }
  }

  // ── Public: inject a message into an active call ──────────────────────────

  async injectMessage(callId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this._speak(callId, text);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  // ── Public: get active call IDs ───────────────────────────────────────────

  getActiveCalls(): string[] {
    return Array.from(this.activeCalls);
  }
}

// ── Config loader ─────────────────────────────────────────────────────────────

export function loadGatewayBridgeConfig(): GatewayBridgeConfig | null {
  const enabled = process.env.OPENCLAW_ENABLED === "true";
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL?.replace(/\/$/, "");
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;

  if (!enabled || !gatewayUrl || !token) return null;

  return {
    gatewayUrl,
    token,
    agentId: process.env.OPENCLAW_AGENT_ID ?? "main",
    reconnectDelayMs: 5_000,
  };
}
