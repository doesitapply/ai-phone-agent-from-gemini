/**
 * OpenClaw Gateway Bridge
 *
 * This module connects the phone agent to the OpenClaw Gateway WebSocket
 * to receive voice-call plugin events (inbound calls, transcripts, etc.)
 * and respond with AI-generated text via the Gateway's speak/respond API.
 *
 * Architecture:
 *   Twilio → OpenClaw voice-call plugin (answers call, streams audio)
 *              ↓ WebSocket event: "voice-call:transcript"
 *   OpenClaw Gateway Bridge (this module)
 *              ↓ queryOpenClaw() or Gemini fallback
 *   AI response text
 *              ↓ POST /v1/voice-call/speak or Gateway WS response
 *   OpenClaw voice-call plugin → Twilio TTS → caller hears response
 *
 * This is the correct integration path when OpenClaw's voice-call plugin
 * owns the Twilio number webhook (not the phone agent directly).
 */

import WebSocket from "ws";

export interface GatewayBridgeConfig {
  gatewayUrl: string;   // e.g. ws://127.0.0.1:18789
  token: string;        // Gateway auth token
  agentId: string;      // e.g. "main"
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
}

export type TranscriptHandler = (event: VoiceCallEvent) => Promise<string | null>;
export type CallStartHandler = (event: VoiceCallEvent) => Promise<string | null>;
export type CallEndHandler = (event: VoiceCallEvent) => void;

export interface GatewayBridgeHandlers {
  onTranscript: TranscriptHandler;
  onCallStart?: CallStartHandler;
  onCallEnd?: CallEndHandler;
}

/**
 * Converts a Gateway ws:// URL to an http:// URL for REST calls.
 */
function wsToHttp(wsUrl: string): string {
  return wsUrl.replace(/^ws:\/\//, "http://").replace(/^wss:\/\//, "https://");
}

/**
 * OpenClaw Gateway Bridge — connects via WebSocket to receive voice-call events
 * and sends AI responses back via the Gateway REST API.
 */
export class OpenClawGatewayBridge {
  private ws: WebSocket | null = null;
  private config: GatewayBridgeConfig;
  private handlers: GatewayBridgeHandlers;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;
  private connId: string = "";
  private log: (level: string, msg: string, meta?: Record<string, unknown>) => void;

  constructor(
    config: GatewayBridgeConfig,
    handlers: GatewayBridgeHandlers,
    logger?: (level: string, msg: string, meta?: Record<string, unknown>) => void
  ) {
    this.config = config;
    this.handlers = handlers;
    this.log = logger ?? ((level, msg, meta) => console.log(`[openclaw-bridge] [${level}] ${msg}`, meta ?? ""));
  }

  /** Start the bridge — connect to Gateway and begin listening for events. */
  connect(): void {
    if (this.ws) return;
    this._connect();
  }

  /** Gracefully shut down the bridge. */
  disconnect(): void {
    this.isShuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Returns true if the WebSocket is currently connected. */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private _connect(): void {
    const wsUrl = this.config.gatewayUrl.replace(/^http/, "ws");
    const url = `${wsUrl}/gateway/ws`;

    this.log("info", "Connecting to OpenClaw Gateway WebSocket", { url });

    try {
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          "x-openclaw-agent-id": this.config.agentId,
          "x-openclaw-client": "ai-phone-agent",
        },
      });
    } catch (err: any) {
      this.log("error", "Failed to create WebSocket", { error: err.message });
      this._scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.log("info", "Connected to OpenClaw Gateway WebSocket");
      // Subscribe to voice-call events
      this._send({
        type: "subscribe",
        channels: ["voice-call"],
      });
    });

    this.ws.on("message", (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString());
        this._handleMessage(msg);
      } catch {
        // non-JSON message, ignore
      }
    });

    this.ws.on("close", (code, reason) => {
      this.log("warn", "Gateway WebSocket closed", { code, reason: reason.toString() });
      this.ws = null;
      if (!this.isShuttingDown) {
        this._scheduleReconnect();
      }
    });

    this.ws.on("error", (err: Error) => {
      this.log("error", "Gateway WebSocket error", { error: err.message });
      // close event will fire after error, which triggers reconnect
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

  private async _handleMessage(msg: Record<string, unknown>): Promise<void> {
    const type = msg.type as string;

    // Store connection ID for authenticated requests
    if (type === "connected" || type === "hello") {
      this.connId = (msg.connId as string) ?? (msg.id as string) ?? "";
      this.log("info", "Gateway handshake complete", { connId: this.connId });
      return;
    }

    // voice-call:inbound — new inbound call answered by OpenClaw
    if (type === "voice-call:inbound" || type === "voice-call:call.started") {
      const event: VoiceCallEvent = {
        type,
        callId: (msg.callId as string) ?? (msg.id as string) ?? "",
        from: msg.from as string,
        to: msg.to as string,
        direction: "inbound",
      };
      this.log("info", "Inbound call via OpenClaw voice-call plugin", { callId: event.callId, from: event.from });

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

    // voice-call:transcript — caller said something, AI needs to respond
    if (type === "voice-call:transcript" || type === "voice-call:speech") {
      const event: VoiceCallEvent = {
        type,
        callId: (msg.callId as string) ?? (msg.id as string) ?? "",
        transcript: (msg.transcript as string) ?? (msg.text as string) ?? "",
        confidence: msg.confidence as number,
        from: msg.from as string,
      };

      if (!event.transcript?.trim()) return;

      this.log("info", "Transcript received via OpenClaw", {
        callId: event.callId,
        transcript: event.transcript.slice(0, 80),
      });

      try {
        const response = await this.handlers.onTranscript(event);
        if (response) {
          await this._speak(event.callId, response);
        }
      } catch (err: any) {
        this.log("error", "onTranscript handler failed", { error: err.message, callId: event.callId });
        await this._speak(event.callId, "I'm sorry, I had a technical issue. Let me try again.").catch(() => {});
      }
      return;
    }

    // voice-call:call.ended — call finished
    if (type === "voice-call:call.ended" || type === "voice-call:hangup") {
      const event: VoiceCallEvent = {
        type,
        callId: (msg.callId as string) ?? (msg.id as string) ?? "",
      };
      this.log("info", "Call ended via OpenClaw", { callId: event.callId });
      if (this.handlers.onCallEnd) {
        this.handlers.onCallEnd(event);
      }
      return;
    }
  }

  /**
   * Sends text to be spoken on an active call via the OpenClaw Gateway REST API.
   * Uses POST /v1/voice-call/speak — the standard OpenClaw voice-call speak endpoint.
   */
  private async _speak(callId: string, text: string): Promise<void> {
    const httpBase = wsToHttp(this.config.gatewayUrl);
    const url = `${httpBase}/v1/voice-call/speak`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.token}`,
          "x-openclaw-agent-id": this.config.agentId,
        },
        body: JSON.stringify({ callId, text }),
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.log("warn", "speak API returned non-OK", { status: res.status, body: body.slice(0, 200), callId });
      } else {
        this.log("debug", "Spoke response to caller", { callId, textLength: text.length });
      }
    } catch (err: any) {
      this.log("error", "Failed to speak via OpenClaw", { error: err.message, callId });
    }
  }

  /**
   * Injects a message into an active call immediately (does not wait for next turn).
   * Same as _speak but exposed publicly for the inject endpoint.
   */
  async injectMessage(callId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this._speak(callId, text);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }
}

/**
 * Builds a GatewayBridgeConfig from environment variables.
 * Returns null if OpenClaw is not configured.
 */
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
