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
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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


interface LocalDeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

interface LocalDeviceTokenStore {
  version: number;
  deviceId: string;
  tokens?: Record<string, {
    token?: string;
    role?: string;
    scopes?: string[];
  }>;
}

function base64UrlEncode(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function normalizeMeta(value: string | undefined): string {
  return (value ?? "").trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function derivePublicKeyRawBase64Url(publicKeyPem: string): string {
  const spki = crypto.createPublicKey(publicKeyPem).export({ format: "der", type: "spki" }) as Buffer;
  const raw = spki.subarray(-32);
  return base64UrlEncode(raw);
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

function loadLocalDeviceIdentity(log: Logger): LocalDeviceIdentity | null {
  try {
    const file = path.join(os.homedir(), ".openclaw", "identity", "device.json");
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as LocalDeviceIdentity;
    if (!parsed?.deviceId || !parsed?.publicKeyPem || !parsed?.privateKeyPem) return null;
    return parsed;
  } catch (err: any) {
    log("warn", "Failed to load local OpenClaw device identity", { error: err.message });
    return null;
  }
}

function loadLocalDeviceToken(deviceId: string, role: string): string | null {
  try {
    const file = path.join(os.homedir(), ".openclaw", "identity", "device-auth.json");
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as LocalDeviceTokenStore;
    if (!parsed || parsed.deviceId !== deviceId || !parsed.tokens) return null;
    const token = parsed.tokens[role]?.token;
    return typeof token === "string" && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
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
  private protocolConnected = false;
  private pendingReqId = 0;

  // Track active calls so we can skip duplicate events
  private activeCalls = new Set<string>();

  // Throttle unknown-event log spam (event type => count)
  private unhandledEventCounts = new Map<string, number>();

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

  private logUnhandledEvent(type: string, msg: Record<string, unknown>): void {
    const next = (this.unhandledEventCounts.get(type) ?? 0) + 1;
    this.unhandledEventCounts.set(type, next);

    // Log first 3, then every 25th occurrence to avoid log flood.
    if (next <= 3 || next % 25 === 0) {
      this.log("debug", `Unhandled Gateway event: ${type}`, {
        type,
        keys: Object.keys(msg),
        seen: next,
      });
    }
  }

  // ── WebSocket connection ────────────────────────────────────────────────────

  private _connect(): void {
    const wsBase = httpToWs(this.config.gatewayUrl.replace(/\/$/, ""));
    const url = `${wsBase}/gateway/ws`;

    this.log("info", "Connecting to OpenClaw Gateway WebSocket", { url });

    try {
      this.protocolConnected = false;
      this.ws = new WebSocket(url);
    } catch (err: any) {
      this.log("error", "Failed to create WebSocket", { error: err.message });
      this._scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.log("info", "Connected to OpenClaw Gateway WebSocket");
      // Wait for connect.challenge event, then send protocol connect req.
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

  private _nextReqId(): string {
    this.pendingReqId += 1;
    return `bridge-${Date.now()}-${this.pendingReqId}`;
  }

  private _sendConnectRequest(nonce?: string): void {
    const id = this._nextReqId();
    const role = "operator";
    const scopes = ["operator.read", "operator.write"];
    const clientId = "gateway-client";
    const clientMode = "backend";
    const platform = process.platform;
    const deviceFamily = "mac";

    let authToken = this.config.token;
    let device: Record<string, unknown> | undefined;

    const identity = loadLocalDeviceIdentity(this.log);
    if (identity && nonce) {
      const deviceToken = loadLocalDeviceToken(identity.deviceId, role);
      if (!authToken && deviceToken) authToken = deviceToken;

      const signedAtMs = Date.now();
      const payload = [
        "v2",
        identity.deviceId,
        clientId,
        clientMode,
        role,
        scopes.join(","),
        String(signedAtMs),
        authToken ?? "",
        nonce,
      ].join("|");

      try {
        device = {
          id: identity.deviceId,
          publicKey: derivePublicKeyRawBase64Url(identity.publicKeyPem),
          signature: signDevicePayload(identity.privateKeyPem, payload),
          signedAt: signedAtMs,
          nonce,
        };
      } catch (err: any) {
        this.log("warn", "Failed to sign device-auth connect payload", { error: err.message });
      }
    }

    this._send({
      type: "req",
      id,
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: clientId,
          version: "2.2.0",
          platform,
          mode: clientMode,
        },
        role,
        scopes,
        caps: [],
        commands: [],
        permissions: {},
        auth: { token: authToken },
        locale: "en-US",
        userAgent: "ai-phone-agent-bridge/2.2.0",
        ...(device ? { device } : {}),
      },
    });
  }

  // ── Message handling ────────────────────────────────────────────────────────

  private async _handleMessage(msg: Record<string, unknown>): Promise<void> {
    const type = msg.type as string;

    // ── Protocol v3 handshake (Gateway WS) ────────────────────────────────
    if (type === "event" && msg.event === "connect.challenge") {
      if (this.protocolConnected) {
        this.log("debug", "Ignoring connect.challenge — already protocol-connected");
        return;
      }
      const nonce = (msg.payload as Record<string, unknown> | undefined)?.nonce as string | undefined;
      this._sendConnectRequest(nonce);
      return;
    }

    if (type === "res") {
      const ok = Boolean(msg.ok);
      const payload = (msg.payload as Record<string, unknown> | undefined) ?? {};
      if (ok && (payload.type === "hello-ok" || (payload as any).protocol === 3)) {
        this.protocolConnected = true;
        this.connId = (payload.connId as string) ?? (msg.id as string) ?? "";
        this.log("info", "Gateway protocol connect complete", { connId: this.connId || undefined });
        return;
      }
      if (!ok) {
        this.log("warn", "Gateway request returned error", {
          id: msg.id,
          error: msg.error,
        });
        return;
      }
    }

    // Legacy handshake variants (kept for compatibility)
    if (type === "connected" || type === "hello" || type === "welcome") {
      this.protocolConnected = true;
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

    // ── Log unknown event types at debug level (throttled) ────────────────
    if (type !== "pong" && type !== "ping" && !type.startsWith("subscribed")) {
      this.logUnhandledEvent(type, msg);
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
  const openClawEnabled = process.env.OPENCLAW_ENABLED === "true";
  const bridgeEnabled = process.env.OPENCLAW_BRIDGE_ENABLED !== "false";
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL?.replace(/\/$/, "");
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;

  // Bridge defaults to enabled; set OPENCLAW_BRIDGE_ENABLED=false to disable.
  // OPENCLAW_ENABLED can still be true for HTTP-based queryOpenClaw usage.
  if (!openClawEnabled || !bridgeEnabled || !gatewayUrl || !token) return null;

  return {
    gatewayUrl,
    token,
    agentId: process.env.OPENCLAW_AGENT_ID ?? "main",
    reconnectDelayMs: 5_000,
  };
}
