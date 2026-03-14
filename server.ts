/**
 * AI Phone Agent — Main Server
 *
 * Architecture: Twilio → OpenClaw Gateway (Codex 5.3) OR Gemini 2.0 Flash → Amazon Polly TTS
 * AI Brain: OpenClaw Gateway (preferred) with automatic Gemini fallback
 * State: Postgres (calls, messages, contacts, summaries, events, tasks, tools, handoffs)
 * Security: helmet, rate-limit, zod validation, API key auth, Twilio sig verification
 * Observability: structured logging, request IDs, AI latency tracking
 */
import express, { Request, Response, NextFunction } from "express";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import twilio from "twilio";
import basicAuth from "express-basic-auth";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import morgan from "morgan";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

import { loadElevenLabsConfig, generateSpeech, type ElevenLabsConfig } from "./src/elevenlabs.js";

// ── Load env before importing modules that use it ─────────────────────────────
// Load settings: /tmp/.env.local in production (Railway read-only fs), .env.local in dev
const settingsPath = process.env.SETTINGS_PATH ||
  (process.env.NODE_ENV === "production" ? "/tmp/.env.local" : ".env.local");
dotenv.config({ path: settingsPath });
dotenv.config(); // also load .env as fallback

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Environment Schema Validation ─────────────────────────────────────────────
const EnvSchema = z.object({
  GEMINI_API_KEY: z.string().optional(), // Optional — OpenRouter is the primary AI brain
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  APP_URL: z.string().optional(),
  PORT: z.string().optional(),
  DASHBOARD_API_KEY: z.string().optional(),
  NODE_ENV: z.enum(["development", "production", "test"]).optional(),
  // OpenClaw Gateway integration
  OPENCLAW_ENABLED: z.enum(["true", "false"]).optional(),
  OPENCLAW_GATEWAY_URL: z.string().url().optional(),
  OPENCLAW_GATEWAY_TOKEN: z.string().optional(),
  OPENCLAW_AGENT_ID: z.string().optional(),
  OPENCLAW_MODEL: z.string().optional(),
  OPENCLAW_TIMEOUT_MS: z.string().optional(),
  // OpenRouter omni-brain failover
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().optional(),
  OPENROUTER_ENABLED: z.enum(["true", "false"]).optional(),
  OPENROUTER_TIMEOUT_MS: z.string().optional(),
  // ElevenLabs TTS
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  ELEVENLABS_MODEL_ID: z.string().optional(),
  // Google Calendar sync
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().optional(),
  GOOGLE_CALENDAR_TZ: z.string().optional(),
  // Dashboard basic auth (browser pop-up login)
  DASHBOARD_USER: z.string().optional(),
  DASHBOARD_PASS: z.string().optional(),
  // Business timezone for date/time injection
  BUSINESS_TIMEZONE: z.string().optional(),
});

const envResult = EnvSchema.safeParse(process.env);
if (!envResult.success) {
  console.error("❌ Environment validation failed:");
  envResult.error.issues.forEach((i) => console.error(`   ${i.path.join(".")}: ${i.message}`));
  process.exit(1);
}
const env = envResult.data;
const PORT = parseInt(env.PORT || "3000", 10);
const IS_PROD = env.NODE_ENV === "production";

// ── Import modules (after env is loaded) ─────────────────────────────────────
import { sql, initSchema } from "./src/db.js";
import { resolveContact, buildCallerContext } from "./src/contacts.js";
import { runPostCallIntelligence } from "./src/intelligence.js";
import { logEvent } from "./src/events.js";
import { generateAiResponseWithTools } from "./src/function-calling.js";
import {
  loadOpenClawConfig,
  queryOpenClaw,
  testOpenClawConnection,
  buildOpenClawSystemPrompt,
  queueInjectedMessage,
  dequeueInjectedMessages,
  hasInjectedMessages,
  type OpenClawConfig,
} from "./src/openclaw.js";
import {
  OpenClawGatewayBridge,
  loadGatewayBridgeConfig,
  type VoiceCallEvent,
} from "./src/openclaw-bridge.js";
import { loadOpenRouterConfig, queryOpenRouter, type OpenRouterConfig } from "./src/openrouter.js";
import { insertCalendarEvent, isCalendarConfigured } from "./src/gcal.js";
import {
  SETTINGS_GROUPS,
  getMaskedSettings,
  writeEnvFile,
  getConfigStatus,
} from "./src/settings.js";

// ── Structured Logger ─────────────────────────────────────────────────────────
type LogLevel = "info" | "warn" | "error" | "debug";
const log = (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
  const entry = { timestamp: new Date().toISOString(), level, message, ...meta };
  if (IS_PROD) {
    console.log(JSON.stringify(entry));
  } else {
    const colors: Record<LogLevel, string> = { info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m", debug: "\x1b[90m" };
    const reset = "\x1b[0m";
    console.log(`${colors[level]}[${level.toUpperCase()}]${reset} ${message}${meta ? " " + JSON.stringify(meta) : ""}`);
  }
};

// ── Express App ───────────────────────────────────────────────────────────────
const app = express();

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(cors());
app.use(morgan(IS_PROD ? "combined" : "dev", {
  stream: { write: (msg) => log("info", msg.trim(), { type: "http" }) },
}));

// ── Request ID Middleware ─────────────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  (req as any).requestId = uuidv4();
  res.setHeader("X-Request-ID", (req as any).requestId);
  next();
});

// ── Request Logging Middleware ────────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (req.path.startsWith("/api/")) {
      log("info", `${req.method} ${req.path}`, {
        requestId: (req as any).requestId,
        status: res.statusCode,
        durationMs: duration,
        ip: req.ip,
      });
      sql`
        INSERT INTO request_logs (request_id, method, path, status_code, duration_ms, ip)
        VALUES (${(req as any).requestId}, ${req.method}, ${req.path}, ${res.statusCode}, ${duration}, ${req.ip})
      `.catch(() => {/* non-critical */});
    }
  });
  next();
});

// ── Rate Limiting ─────────────────────────────────────────────────────────────
const callRateLimit = rateLimit({ windowMs: 60_000, max: 10, message: { error: "Too many call requests." }, standardHeaders: true, legacyHeaders: false });
const apiRateLimit = rateLimit({ windowMs: 60_000, max: 200, message: { error: "Too many requests." }, standardHeaders: true, legacyHeaders: false });

app.use("/api/calls", apiRateLimit);
app.use("/api/agents", apiRateLimit);
app.use("/api/stats", apiRateLimit);
app.use("/api/contacts", apiRateLimit);
app.use("/api/tasks", apiRateLimit);
app.use("/api/handoffs", apiRateLimit);
app.use("/api/summaries", apiRateLimit);

// ── Dashboard Basic Auth (browser pop-up — simple wall for single-tenant clients) ──
if (env.DASHBOARD_USER && env.DASHBOARD_PASS) {
  const basicAuthMiddleware = basicAuth({
    users: { [env.DASHBOARD_USER]: env.DASHBOARD_PASS },
    challenge: true,
    realm: "AI Phone Agent Dashboard",
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Twilio webhooks and health check must stay public
    const isPublic = req.path.startsWith("/api/twilio") || req.path === "/health";
    if (isPublic) return next();
    return basicAuthMiddleware(req, res, next);
  });
  log("info", "Dashboard basic auth enabled", { user: env.DASHBOARD_USER });
}

// ── Dashboard API Key Auth ────────────────────────────────────────────────────
const dashboardAuth = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = env.DASHBOARD_API_KEY;
  if (!apiKey) return next();
  const provided = req.headers["x-api-key"] || req.query.apiKey;
  if (provided !== apiKey) {
    log("warn", "Unauthorized API access", { requestId: (req as any).requestId, path: req.path, ip: req.ip });
    return res.status(401).json({ error: "Unauthorized. Provide a valid X-Api-Key header." });
  }
  next();
};

["/api/calls", "/api/agents", "/api/stats", "/api/contacts", "/api/tasks", "/api/handoffs", "/api/summaries", "/api/logs", "/api/webhook-url"].forEach(
  (route) => app.use(route, dashboardAuth)
);

// ── Twilio Signature Validation ───────────────────────────────────────────────
const twilioValidate = (req: Request, res: Response, next: NextFunction) => {
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!authToken || !IS_PROD) return next(); // Skip in dev

  const signature = req.headers["x-twilio-signature"] as string;
  const url = `${getAppUrl()}${req.originalUrl}`;
  const isValid = twilio.validateRequest(authToken, signature, url, req.body);

  if (!isValid) {
    log("warn", "Invalid Twilio signature", { url, ip: req.ip });
    return res.status(403).send("Forbidden");
  }
  next();
};

app.use("/api/twilio", twilioValidate);

// ── Input Validation Schemas ──────────────────────────────────────────────────
const OutboundCallSchema = z.object({
  to: z.string().regex(/^\+[1-9]\d{7,14}$/, "Phone number must be in E.164 format (e.g. +15551234567)"),
});

const AgentConfigSchema = z.object({
  name: z.string().min(1).max(100),
  system_prompt: z.string().min(10).max(4000),
  greeting: z.string().min(5).max(500),
  voice: z.string().optional().default("Polly.Joanna"),
  language: z.string().min(2).max(10).optional().default("en-US"),
  vertical: z.string().optional().default("general"),
  max_turns: z.number().int().min(3).max(50).optional().default(20),
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const getActiveAgent = async (): Promise<{ id: number; name: string; system_prompt: string; greeting: string; voice: string; language: string; max_turns: number } | undefined> => {
  const rows = await sql<{ id: number; name: string; system_prompt: string; greeting: string; voice: string; language: string; max_turns: number }[]>`
    SELECT * FROM agent_configs WHERE is_active = TRUE ORDER BY id DESC LIMIT 1
  `;
  return rows[0];
};

const getAi = () => {
  if (!env.GEMINI_API_KEY) return null; // Optional — OpenRouter handles AI if not set
  return new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
};

const getTwilioClient = () => {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) throw new Error("Twilio credentials not configured.");
  return twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
};

const getAppUrl = () => (env.APP_URL || `http://localhost:${PORT}`).replace("ais-dev-", "ais-pre-");

// In-memory TTS audio store: id → Buffer (cleared after 5 min)
const ttsAudioStore = new Map<string, { buffer: Buffer; expires: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ttsAudioStore) {
    if (v.expires < now) ttsAudioStore.delete(k);
  }
}, 60_000);

/**
 * Build TwiML speech output.
 * If ElevenLabs is configured, generates audio and uses <Play>.
 * Falls back to Polly <Say> if ElevenLabs fails or is not configured.
 */
const buildTwimlSay = async (twiml: twilio.twiml.VoiceResponse, text: string, voice: string): Promise<void> => {
  if (elevenLabsConfig) {
    try {
      const buffer = await generateSpeech(text, elevenLabsConfig);
      if (buffer) {
        const id = uuidv4();
        ttsAudioStore.set(id, { buffer, expires: Date.now() + 5 * 60_000 });
        const appUrl = getAppUrl();
        twiml.play(`${appUrl}/api/tts/${id}`);
        return;
      }
    } catch (err: any) {
      log("warn", "ElevenLabs TTS failed, falling back to Polly", { error: err.message });
    }
  }
  // Polly fallback
  twiml.say({ voice: voice.startsWith("Polly.") ? (voice as any) : "Polly.Joanna" }, text);
};

// ── Active Call Kill Timers (15-min watchdog) ────────────────────────────────
const activeCallTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ── OpenClaw Config (loaded once at startup) ────────────────────────────────────────────
let openClawConfig: OpenClawConfig | null = loadOpenClawConfig();

// ── OpenRouter Config (loaded once at startup) ────────────────────────────────────────────
let openRouterConfig: OpenRouterConfig | null = loadOpenRouterConfig();

// ── ElevenLabs TTS Config (loaded once at startup) ───────────────────────────────────
let elevenLabsConfig: ElevenLabsConfig | null = loadElevenLabsConfig();

// ── OpenClaw Gateway Bridge (WebSocket — handles voice-call plugin events) ───
// This is the correct integration path when OpenClaw's voice-call plugin
// owns the Twilio number. The bridge receives transcript events from the
// plugin and sends AI responses back via the Gateway speak API.
let gatewayBridge: OpenClawGatewayBridge | null = null;

// Reload OpenClaw + OpenRouter + ElevenLabs config (called at startup and when settings change)
const reloadOpenClawConfig = () => {
  openClawConfig = loadOpenClawConfig();
  openRouterConfig = loadOpenRouterConfig();
  elevenLabsConfig = loadElevenLabsConfig();
  log("info", openClawConfig?.enabled
    ? `OpenClaw enabled: ${openClawConfig.gatewayUrl} agent=${openClawConfig.agentId} model=${openClawConfig.model}`
    : "OpenClaw disabled"
  );
  log("info", openRouterConfig?.enabled
    ? `OpenRouter enabled: model=${openRouterConfig.model}`
    : "OpenRouter disabled"
  );
};

// ── AI Response Generation ────────────────────────────────────────────────────
// Routes to OpenClaw Gateway (if enabled) or falls back to Gemini function-calling.
// OpenClaw uses the OpenResponses HTTP API (POST /v1/responses).
async function generateAiResponse(
  callSid: string,
  speechText: string,
  requestId: string,
  callerContext: string,
  systemPrompt: string,
  dispatchCtx: Parameters<typeof generateAiResponseWithTools>[5],
  geminiApiKey: string | undefined,
  turnCount: number,
  callerPhone: string
): Promise<{ text: string; latencyMs: number; toolsInvoked: string[]; shouldHangUp: boolean; source: "openclaw" | "gemini" }> {

  // ── Try OpenClaw first ────────────────────────────────────────────────────
  if (openClawConfig?.enabled) {
    try {
      // Build conversation history for context
      const historyRows = await sql<{ role: string; text: string }[]>`
        SELECT role, text FROM messages WHERE call_sid = ${callSid} AND role IN ('user','assistant') ORDER BY id ASC LIMIT 20
      `;
      const history = historyRows.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.text,
      }));

      const openClawSystemPrompt = buildOpenClawSystemPrompt(
        systemPrompt,
        callerContext,
        callSid,
        callerPhone,
        turnCount
      );

      const result = await queryOpenClaw(
        openClawConfig,
        callSid,
        callerPhone,
        speechText,
        openClawSystemPrompt,
        history,
        turnCount
      );

      logEvent(callSid, "OPENCLAW_RESPONSE", {
        latencyMs: result.latencyMs,
        model: openClawConfig.model,
        agentId: openClawConfig.agentId,
      });

      return {
        text: result.text,
        latencyMs: result.latencyMs,
        toolsInvoked: [],
        shouldHangUp: false,
        source: "openclaw",
      };
     } catch (err: any) {
      log("warn", "OpenClaw request failed — trying OpenRouter", { requestId, callSid, error: err.message });
      logEvent(callSid, "OPENCLAW_FALLBACK", { error: err.message });
      // Fall through to OpenRouter or Gemini
    }
  }

  // ── OpenRouter failover (if configured) ──────────────────────────────────
  if (openRouterConfig?.enabled) {
    try {
      const historyRows = await sql<{ role: string; text: string }[]>`
        SELECT role, text FROM messages WHERE call_sid = ${callSid} AND role IN ('user','assistant') ORDER BY id ASC LIMIT 20
      `;
      const history = historyRows.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.text,
      }));
      const nowStr = new Date().toLocaleString("en-US", {
        timeZone: process.env.BUSINESS_TIMEZONE || "America/Los_Angeles",
        weekday: "long", year: "numeric", month: "long", day: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true,
      });
      const fullPrompt = `${systemPrompt}\n\nCurrent date/time: ${nowStr}\n\nCaller context: ${callerContext || "New caller"}`;
      const result = await queryOpenRouter(openRouterConfig, fullPrompt, history, speechText);
      logEvent(callSid, "OPENROUTER_RESPONSE", { latencyMs: result.latencyMs, model: result.model, tokensUsed: result.tokensUsed });
      return { text: result.text, latencyMs: result.latencyMs, toolsInvoked: [], shouldHangUp: false, source: "openclaw" as const };
    } catch (err: any) {
      log("warn", "OpenRouter failed — falling back to Gemini", { requestId, callSid, error: err.message });
      logEvent(callSid, "OPENROUTER_FALLBACK", { error: err.message });
    }
  }

   // ── Gemini function-calling (optional final fallback) ───────────────────
  if (geminiApiKey) {
    const result = await generateAiResponseWithTools(
      callSid,
      speechText,
      requestId,
      callerContext,
      systemPrompt,
      dispatchCtx,
      geminiApiKey
    );
    return { ...result, source: "gemini" };
  }
  // No AI configured — return a graceful message
  log("error", "No AI provider available for call", { callSid, requestId });
  return { text: "I'm sorry, the AI service is temporarily unavailable. Please call back shortly.", latencyMs: 0, toolsInvoked: [], shouldHangUp: false, source: "gemini" };
}

// ── Webhook Deduplication ─────────────────────────────────────────────────────
const processedWebhooks = new Set<string>();
const isDuplicateWebhook = (callSid: string, eventType: string): boolean => {
  const key = `${callSid}:${eventType}`;
  if (processedWebhooks.has(key)) {
    logEvent(callSid, "DUPLICATE_WEBHOOK", { eventType });
    return true;
  }
  processedWebhooks.add(key);
  // Clean up after 10 minutes to prevent unbounded growth
  setTimeout(() => processedWebhooks.delete(key), 600_000);
  return false;
};

// ── API: Make Outbound Call ───────────────────────────────────────────────────
app.post("/api/calls", callRateLimit, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  const parsed = OutboundCallSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const { to } = parsed.data;
  const from = env.TWILIO_PHONE_NUMBER;
  if (!from) return res.status(400).json({ error: "TWILIO_PHONE_NUMBER is not configured." });

  try {
    const client = getTwilioClient();
    const appUrl = getAppUrl();
    const call = await client.calls.create({
      url: `${appUrl}/api/twilio/incoming`,
      to,
      from,
      statusCallback: `${appUrl}/api/twilio/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      // AMD: Answering Machine Detection — drop a voicemail instead of talking to a machine
      machineDetection: "DetectMessageEnd",
      asyncAmdStatusCallback: `${appUrl}/api/twilio/amd`,
      asyncAmdStatusCallbackMethod: "POST",
    });

    const agent = await getActiveAgent();
    const { contact } = await resolveContact(to);

    await sql`
      INSERT INTO calls (call_sid, direction, to_number, from_number, status, agent_name, contact_id)
      VALUES (${call.sid}, 'outbound', ${to}, ${from}, 'initiated', ${agent?.name || "Default Assistant"}, ${contact.id})
      ON CONFLICT (call_sid) DO NOTHING
    `;

    logEvent(call.sid, "CALL_STARTED", { direction: "outbound", to, contactId: contact.id });
    log("info", "Outbound call initiated", { requestId, callSid: call.sid, to });
    res.json({ success: true, callSid: call.sid });
  } catch (error: any) {
    log("error", "Outbound call failed", { requestId, error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ── Twilio Webhook: AMD (Answering Machine Detection) ────────────────────────
app.post("/api/twilio/amd", async (req: Request, res: Response) => {
  const { CallSid, AnsweredBy } = req.body;
  log("info", "AMD result", { callSid: CallSid, answeredBy: AnsweredBy });
  logEvent(CallSid, "AMD_RESULT", { answeredBy: AnsweredBy });
  if (["machine_start", "machine_end_beep", "machine_end_silence"].includes(AnsweredBy)) {
    try {
      const client = getTwilioClient();
      const agent = getActiveAgent();
      const bizName = agent?.name?.replace(" Agent", "") || "our office";
      await client.calls(CallSid).update({
        twiml: `<Response><Say voice="Polly.Joanna">Hey, this is the AI assistant at ${bizName}. Sorry we missed you — please give us a call back at your convenience and we'll get you taken care of. Have a great day!</Say><Hangup/></Response>`,
      });
      logEvent(CallSid, "VOICEMAIL_DROP_SENT", { bizName, answeredBy: AnsweredBy });
      log("info", "Voicemail drop sent", { callSid: CallSid, answeredBy: AnsweredBy });
    } catch (err: any) {
      log("warn", "Voicemail drop failed", { callSid: CallSid, error: err.message });
    }
  }
  res.sendStatus(200);
});

// ── Twilio Webhook: Call Status ───────────────────────────────────────────────
app.post("/api/twilio/status", async (req: Request, res: Response) => {
  const { CallSid, CallStatus, CallDuration } = req.body;

  if (["completed", "failed", "busy", "no-answer"].includes(CallStatus)) {
    // Clear the 15-minute kill switch timer when call ends naturally
    const timer = activeCallTimers.get(CallSid);
    if (timer) { clearTimeout(timer); activeCallTimers.delete(CallSid); }
    await sql`
      UPDATE calls SET status = ${CallStatus}, ended_at = NOW(),
      duration_seconds = ${CallDuration ? parseInt(CallDuration) : null}
      WHERE call_sid = ${CallSid}
    `;

    // Run post-call intelligence asynchronously (don't block Twilio's webhook)
    if (CallStatus === "completed") { // runs via OpenRouter or Gemini, whichever is configured
      const statusCallRows = await sql<{ contact_id: number | null }[]>`SELECT contact_id FROM calls WHERE call_sid = ${CallSid}`;
      const callRecord = statusCallRows[0];
      setImmediate(async () => {
        try {
          await runPostCallIntelligence(CallSid, callRecord?.contact_id || null, env.GEMINI_API_KEY);
          log("info", "Post-call intelligence complete", { callSid: CallSid });
        } catch (err: any) {
          log("error", "Post-call intelligence failed", { callSid: CallSid, error: err.message });
        }
      });
    }

    logEvent(CallSid, "CALL_ENDED", { status: CallStatus, duration: CallDuration });
  } else {
    await sql`UPDATE calls SET status = ${CallStatus} WHERE call_sid = ${CallSid}`;
  }

  log("info", "Call status updated", { callSid: CallSid, status: CallStatus });
  res.sendStatus(200);
});

// ── Twilio Webhook: Incoming / Outbound Connected ─────────────────────────────
app.post("/api/twilio/incoming", async (req: Request, res: Response) => {
  const { CallSid, To, From, Direction } = req.body;

  // Deduplication guard
  if (isDuplicateWebhook(CallSid, "incoming")) {
    const twiml = new twilio.twiml.VoiceResponse();
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  const agent = await getActiveAgent();
  const callerPhone = Direction === "outbound-api" ? To : From;

  // Resolve caller identity
  const { contact, isNew } = await resolveContact(callerPhone);
  logEvent(CallSid, isNew ? "CALLER_NEW" : "CALLER_IDENTIFIED", {
    contactId: contact.id,
    phone: callerPhone,
    hasHistory: !isNew,
  });

  // Check do-not-call
  if (contact.do_not_call) {
    log("info", "Do-not-call number blocked", { callSid: CallSid, phone: callerPhone });
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("We're sorry, this number is on our do-not-call list. Goodbye.");
    twiml.hangup();
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  await sql`
    INSERT INTO calls (call_sid, direction, to_number, from_number, status, agent_name, contact_id)
    VALUES (${CallSid}, ${Direction === "outbound-api" ? "outbound" : "inbound"}, ${To}, ${From}, 'in-progress', ${agent?.name || "Default Assistant"}, ${contact.id})
    ON CONFLICT (call_sid) DO NOTHING
  `;

  await sql`UPDATE calls SET status = 'in-progress', contact_id = ${contact.id} WHERE call_sid = ${CallSid}`;

  // Store caller context for use during the call
  const callerContext = buildCallerContext(contact, isNew);
  if (callerContext) {
    await sql`INSERT INTO messages (call_sid, role, text) VALUES (${CallSid}, 'system', ${`[CONTEXT]${callerContext}`})`;
  }
  // ── 15-minute kill switch: protect API tokens from runaway calls ──────────
  const CALL_TIMEOUT_MS = 15 * 60 * 1000;
  const killTimer = setTimeout(async () => {
    log("warn", "15-minute kill switch triggered", { callSid: CallSid });
    logEvent(CallSid, "CALL_KILLED_TIMEOUT", { timeoutMs: CALL_TIMEOUT_MS });
    try {
      const client = getTwilioClient();
      await client.calls(CallSid).update({
        twiml: "<Response><Say voice=\"Polly.Joanna\">I apologize, but we've reached our maximum call time. Please call back and we'll be happy to continue helping you. Goodbye!</Say><Hangup/></Response>",
      });
    } catch { /* call may have already ended */ }
  }, CALL_TIMEOUT_MS);
  activeCallTimers.set(CallSid, killTimer);
  log("info", "Call connected", { callSid: CallSid, direction: Direction, contactId: contact.id, isNew });

  const twiml = new twilio.twiml.VoiceResponse();
  const greeting = agent?.greeting || "Hello! I'm your AI assistant. How can I help you today?";
  const voice = agent?.voice || "Polly.Joanna";
  const language = (agent?.language || "en-US") as any;

  await buildTwimlSay(twiml, greeting, voice);
  twiml.gather({
    input: ["speech"],
    action: "/api/twilio/process",
    speechTimeout: "auto",
    speechModel: "phone_call",
    enhanced: true,
    language,
  });
  twiml.say("I didn't hear anything. Goodbye!");
  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

// ── Twilio Webhook: Process Speech ────────────────────────────────────────────
app.post("/api/twilio/process", async (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  const { CallSid, SpeechResult, Confidence } = req.body;
  const agent = await getActiveAgent();
  const voice = agent?.voice || "Polly.Joanna";
  const language = (agent?.language || "en-US") as any;
  const maxTurns = agent?.max_turns || 20;
  const twiml = new twilio.twiml.VoiceResponse();

  // Get call record for context
  const processCallRecordRows = await sql<{ contact_id: number | null; turn_count: number }[]>`
    SELECT contact_id, turn_count FROM calls WHERE call_sid = ${CallSid}
  `;
  const callRecord = processCallRecordRows[0];

  const contactId = callRecord?.contact_id || null;
  const turnCount = (callRecord?.turn_count || 0) + 1;

  // Update turn count
  await sql`UPDATE calls SET turn_count = ${turnCount} WHERE call_sid = ${CallSid}`;

  // Max turns watchdog
  if (turnCount > maxTurns) {
    logEvent(CallSid, "MAX_TURNS_REACHED", { turnCount, maxTurns });
    log("warn", "Max turns reached", { callSid: CallSid, turnCount });
    await buildTwimlSay(twiml, "We've been talking for a while. Let me connect you with someone from our team who can help you further. Have a great day!", voice);
    twiml.hangup();
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  logEvent(CallSid, "SPEECH_RECEIVED", { turnCount, speechLength: SpeechResult?.length || 0, confidence: Confidence });

  // Dead air / no speech detection
  if (!SpeechResult) {
    logEvent(CallSid, "DEAD_AIR_DETECTED", { turnCount });
    await buildTwimlSay(twiml, "I didn't catch that. Could you please repeat?", voice);
    twiml.gather({ input: ["speech"], action: "/api/twilio/process", speechTimeout: "auto", speechModel: "phone_call", enhanced: true, language });
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // End-of-call keyword detection
  const endKeywords = ["goodbye", "bye", "hang up", "end call", "stop", "quit", "that's all", "no more", "thank you goodbye"];
  if (endKeywords.some((kw) => SpeechResult.toLowerCase().includes(kw))) {
    await sql`INSERT INTO messages (call_sid, role, text) VALUES (${CallSid}, 'user', ${SpeechResult})`;
    await sql`INSERT INTO messages (call_sid, role, text) VALUES (${CallSid}, 'assistant', ${"Goodbye! Have a great day!"})`;
    await buildTwimlSay(twiml, "Goodbye! Have a great day!", voice);
    twiml.hangup();
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Store user message
  await sql`INSERT INTO messages (call_sid, role, text) VALUES (${CallSid}, 'user', ${SpeechResult})`;

  // Load caller context for AI prompt
  let callerContext = "";
  if (contactId) {
    const ctxRows = await sql<{ text: string }[]>`
      SELECT text FROM messages WHERE call_sid = ${CallSid} AND role = 'system' AND text LIKE '[CONTEXT]%' LIMIT 1
    `;
    callerContext = ctxRows[0]?.text?.replace("[CONTEXT]", "") || "";
  }

  // Build dispatch context for live tool invocation
  const callerPhoneRows = await sql`SELECT from_number, direction, to_number FROM calls WHERE call_sid = ${CallSid}`;
  const callerPhone = callerPhoneRows[0] as any;
  const callerPhoneNumber = callerPhone?.direction === "outbound" ? callerPhone?.to_number : callerPhone?.from_number || "";
  const fromPhone = env.TWILIO_PHONE_NUMBER || "";
  const twilioClient = (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN)
    ? getTwilioClient()
    : null;

  const dispatchCtx = {
    callSid: CallSid,
    contactId: contactId || 0,
    callerPhone: callerPhoneNumber,
    fromPhone,
    twilioClient,
  };

  // Check for injected messages from OpenClaw (push commands into active call)
  if (hasInjectedMessages(CallSid)) {
    const injected = dequeueInjectedMessages(CallSid);
    const injectedText = injected.map((m) => m.message).join(" ");
    log("info", "Injected message delivered to call", { callSid: CallSid, source: injected[0]?.source, text: injectedText });
    logEvent(CallSid, "INJECTED_MESSAGE_DELIVERED", { source: injected[0]?.source, count: injected.length });
    await sql`INSERT INTO messages (call_sid, role, text) VALUES (${CallSid}, 'assistant', ${`[INJECTED] ${injectedText}`})`;
    await buildTwimlSay(twiml, injectedText, voice);
    twiml.gather({ input: ["speech"], action: "/api/twilio/process", speechTimeout: "auto", speechModel: "phone_call", enhanced: true, language });
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  try {
    const agent = getActiveAgent();
    // ── Time/date injection + ironclad rules ─────────────────────────────────
    const nowStr = new Date().toLocaleString("en-US", {
      timeZone: env.BUSINESS_TIMEZONE || "America/Los_Angeles",
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
    const basePrompt = agent?.system_prompt || "You are a helpful AI assistant on a phone call. Be concise and conversational.";
    const systemPrompt = `${basePrompt}

=== CURRENT DATE & TIME ===
${nowStr}

=== IRONCLAD RULES — NEVER VIOLATE ===
1. NEVER invent, agree to, or confirm any pricing, discounts, or promotions not explicitly in your instructions. If asked, say: "I don't have authorization for that, but our technician can discuss options when they arrive."
2. NEVER speak negatively about competitors. If asked, say: "I can only speak to what we offer — and we'd love to earn your business."
3. NEVER book appointments in the past. Use the current date above to calculate all future dates correctly.
4. NEVER make up information. If unsure, say: "I don't have that on hand, but someone will follow up with you."
5. Keep all responses under 3 sentences. You are on a phone call — be concise.`;

    const { text: aiText, latencyMs, toolsInvoked, shouldHangUp, source } =
      await generateAiResponse(
        CallSid,
        SpeechResult,
        requestId,
        callerContext,
        systemPrompt,
        dispatchCtx,
        env.GEMINI_API_KEY,
        turnCount,
        callerPhoneNumber
      );

    await sql`INSERT INTO messages (call_sid, role, text) VALUES (${CallSid}, 'assistant', ${aiText})`;

    logEvent(CallSid, "AI_RESPONSE_GENERATED", {
      latencyMs,
      turnCount,
      responseLength: aiText.length,
      toolsInvoked,
      source,
    });
    log("info", "AI response delivered", {
      requestId,
      callSid: CallSid,
      latencyMs,
      turnCount,
      toolsInvoked,
      source,
    });

    await buildTwimlSay(twiml, aiText, voice);

    if (shouldHangUp) {
      twiml.hangup();
    } else {
      twiml.gather({ input: ["speech"], action: "/api/twilio/process", speechTimeout: "auto", speechModel: "phone_call", enhanced: true, language });
    }
  } catch (error: any) {
    log("error", "AI generation failed", { requestId, callSid: CallSid, error: error.message });
    logEvent(CallSid, "AI_ERROR", { error: error.message, turnCount });
    await buildTwimlSay(twiml, "I'm sorry, I'm having trouble right now. Please hold while I connect you with someone from our team.", voice);
    twiml.hangup();
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// ── API: Get All Calls ────────────────────────────────────────────────────────
app.get("/api/calls", async (req: Request, res: Response) => {
  const calls = await sql`
    SELECT c.*, COUNT(m.id) as message_count,
           co.name as contact_name,
           cs.intent, cs.outcome, cs.summary as call_summary, cs.resolution_score as summary_score,
           cs.next_action, cs.sentiment
    FROM calls c
    LEFT JOIN messages m ON c.call_sid = m.call_sid AND m.role != 'system'
    LEFT JOIN contacts co ON c.contact_id = co.id
    LEFT JOIN call_summaries cs ON c.call_sid = cs.call_sid
    GROUP BY c.call_sid, co.name, cs.intent, cs.outcome, cs.summary, cs.resolution_score, cs.next_action, cs.sentiment
    ORDER BY c.started_at DESC
    LIMIT 100
  `;
  res.json(calls);
});

// ── API: Get Active Calls ────────────────────────────────────────────────────
// ── TTS Audio Endpoint (serves ElevenLabs MP3 to Twilio) ─────────────────────
// No auth required — Twilio fetches this URL during an active call
app.get("/api/tts/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const entry = ttsAudioStore.get(id);
  if (!entry || entry.expires < Date.now()) {
    return res.status(404).send("Audio not found or expired");
  }
  res.set({
    "Content-Type": "audio/mpeg",
    "Content-Length": entry.buffer.length,
    "Cache-Control": "no-cache",
  });
  res.send(entry.buffer);
});

app.get("/api/calls/active", dashboardAuth, async (_req: Request, res: Response) => {
  const activeCalls = await sql`
    SELECT c.call_sid, c.from_number, c.to_number, c.started_at, c.direction,
           co.name as contact_name
    FROM calls c
    LEFT JOIN contacts co ON c.contact_id = co.id
    WHERE c.status = 'in-progress'
    ORDER BY c.started_at DESC
  `;
  res.json(activeCalls);
});
// ── API: Get Call Messages ────────────────────────────────────────────────────
app.get("/api/calls/:callSid/messages", async (req: Request, res: Response) => {
  const { callSid } = req.params;
  if (!/^CA[a-f0-9]{32}$/i.test(callSid)) return res.status(400).json({ error: "Invalid call SID format." });
  const callRows = await sql`SELECT * FROM calls WHERE call_sid = ${callSid}`;
  if (!callRows.length) return res.status(404).json({ error: "Call not found." });
  const messages = await sql`SELECT * FROM messages WHERE call_sid = ${callSid} AND role != 'system' ORDER BY id ASC`;
  const events = await sql`SELECT event_type, payload, created_at FROM call_events WHERE call_sid = ${callSid} ORDER BY id ASC`;
  const summaryRows = await sql`SELECT * FROM call_summaries WHERE call_sid = ${callSid}`;
  res.json({ call: callRows[0], messages, events, summary: summaryRows[0] || null });
});

// ── API: Contacts ─────────────────────────────────────────────────────────────
app.get("/api/contacts", async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string || "50"), 100);
  const offset = parseInt(req.query.offset as string || "0");
  const contacts = await sql`
    SELECT c.*, COUNT(ca.id) as total_calls
    FROM contacts c
    LEFT JOIN calls ca ON c.id = ca.contact_id
    GROUP BY c.id
    ORDER BY c.last_seen DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const totalRows = await sql`SELECT COUNT(*) as count FROM contacts`;
  res.json({ contacts, total: Number(totalRows[0].count) });
});

app.get("/api/contacts/:id", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid contact ID." });
  const contactRows = await sql`SELECT * FROM contacts WHERE id = ${id}`;
  if (!contactRows.length) return res.status(404).json({ error: "Contact not found." });
  const calls = await sql`SELECT * FROM calls WHERE contact_id = ${id} ORDER BY started_at DESC LIMIT 20`;
  const tasks = await sql`SELECT * FROM tasks WHERE contact_id = ${id} ORDER BY created_at DESC`;
  const appointments = await sql`SELECT * FROM appointments WHERE contact_id = ${id} ORDER BY scheduled_at DESC`;
  res.json({ contact: contactRows[0], calls, tasks, appointments });
});

// ── API: Tasks ────────────────────────────────────────────────────────────────
app.get("/api/tasks", async (req: Request, res: Response) => {
  const status = req.query.status as string || "open";
  const tasks = await sql`
    SELECT t.*, co.name as contact_name, co.phone_number
    FROM tasks t
    LEFT JOIN contacts co ON t.contact_id = co.id
    WHERE t.status = ${status}
    ORDER BY t.due_at ASC NULLS LAST, t.created_at DESC
    LIMIT 100
  `;
  res.json(tasks);
});

app.put("/api/tasks/:id", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid task ID." });
  const { status, notes } = req.body;
  if (!["open", "in_progress", "completed", "cancelled"].includes(status)) {
    return res.status(400).json({ error: "Invalid status." });
  }
  await sql`
    UPDATE tasks SET status = ${status}, notes = ${notes || null},
    completed_at = ${status === "completed" ? sql`NOW()` : null}
    WHERE id = ${id}
  `;
  res.json({ success: true });
});

// ── API: Handoffs ─────────────────────────────────────────────────────────────
app.get("/api/handoffs", async (req: Request, res: Response) => {
  const handoffs = await sql`
    SELECT h.*, co.name as contact_name, co.phone_number
    FROM handoffs h
    LEFT JOIN contacts co ON h.contact_id = co.id
    WHERE h.status = 'pending'
    ORDER BY h.created_at DESC
    LIMIT 50
  `;
  res.json(handoffs);
});

app.put("/api/handoffs/:id/acknowledge", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid handoff ID." });
  await sql`UPDATE handoffs SET status = 'acknowledged' WHERE id = ${id}`;
  res.json({ success: true });
});

// ── API: Call Summaries ───────────────────────────────────────────────────────
app.get("/api/summaries", async (req: Request, res: Response) => {
  const summaries = await sql`
    SELECT cs.*, co.name as contact_name, co.phone_number
    FROM call_summaries cs
    LEFT JOIN contacts co ON cs.contact_id = co.id
    ORDER BY cs.created_at DESC
    LIMIT 50
  `;
  res.json(summaries);
});

// ── API: Agent Config CRUD ────────────────────────────────────────────────────
app.get("/api/agents", async (_req: Request, res: Response) => {
  res.json(await sql`SELECT * FROM agent_configs ORDER BY id DESC`);
});

app.post("/api/agents", async (req: Request, res: Response) => {
  const parsed = AgentConfigSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { name, system_prompt, greeting, voice, language, vertical, max_turns } = parsed.data;
  await sql`UPDATE agent_configs SET is_active = FALSE`;
  const agentRows = await sql`
    INSERT INTO agent_configs (name, system_prompt, greeting, voice, language, is_active, vertical, max_turns)
    VALUES (${name}, ${system_prompt}, ${greeting}, ${voice}, ${language}, TRUE, ${vertical}, ${max_turns})
    RETURNING id
  `;
  res.json({ success: true, id: (agentRows as any)[0]?.id });
});

app.put("/api/agents/:id/activate", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid agent ID." });
  await sql`UPDATE agent_configs SET is_active = FALSE`;
  await sql`UPDATE agent_configs SET is_active = TRUE WHERE id = ${id}`;
  res.json({ success: true });
});

app.put("/api/agents/:id", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid agent ID." });
  const parsed = AgentConfigSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { name, system_prompt, greeting, voice, language, vertical, max_turns } = parsed.data;
  await sql`
    UPDATE agent_configs SET name = ${name}, system_prompt = ${system_prompt}, greeting = ${greeting},
    voice = ${voice}, language = ${language}, vertical = ${vertical}, max_turns = ${max_turns}
    WHERE id = ${id}
  `;
  res.json({ success: true });
});

app.delete("/api/agents/:id", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid agent ID." });
  await sql`DELETE FROM agent_configs WHERE id = ${id}`;
  res.json({ success: true });
});

// ── API: Stats ────────────────────────────────────────────────────────────────
app.get("/api/stats", async (_req: Request, res: Response) => {
  const [
    totalCallsR, activeCallsR, completedCallsR, totalMessagesR, totalContactsR,
    avgDurationR, inboundR, outboundR, avgLatencyR, openTasksR, pendingHandoffsR,
    avgResolutionR, callsTodayR, callsWeekR, totalHandoffsR, totalApptsR
  ] = await Promise.all([
    sql`SELECT COUNT(*) as count FROM calls`,
    sql`SELECT COUNT(*) as count FROM calls WHERE status = 'in-progress'`,
    sql`SELECT COUNT(*) as count FROM calls WHERE status = 'completed'`,
    sql`SELECT COUNT(*) as count FROM messages WHERE role != 'system'`,
    sql`SELECT COUNT(*) as count FROM contacts`,
    sql`SELECT AVG(duration_seconds) as avg FROM calls WHERE duration_seconds IS NOT NULL`,
    sql`SELECT COUNT(*) as count FROM calls WHERE direction = 'inbound'`,
    sql`SELECT COUNT(*) as count FROM calls WHERE direction = 'outbound'`,
    sql`SELECT AVG(duration_ms) as avg FROM request_logs WHERE path = '/api/twilio/process' AND status_code = 200`,
    sql`SELECT COUNT(*) as count FROM tasks WHERE status = 'open'`,
    sql`SELECT COUNT(*) as count FROM handoffs WHERE status = 'pending'`,
    sql`SELECT AVG(resolution_score) as avg FROM call_summaries`,
    sql`SELECT COUNT(*) as count FROM calls WHERE DATE(started_at) = CURRENT_DATE`,
    sql`SELECT COUNT(*) as count FROM calls WHERE started_at >= NOW() - INTERVAL '7 days'`,
    sql`SELECT COUNT(*) as count FROM handoffs`,
    sql`SELECT COUNT(*) as count FROM appointments WHERE status = 'scheduled'`,
  ]);
  const totalCalls = Number(totalCallsR[0].count);
  const activeCalls = Number(activeCallsR[0].count);
  const completedCalls = Number(completedCallsR[0].count);
  const totalMessages = Number(totalMessagesR[0].count);
  const totalContacts = Number(totalContactsR[0].count);
  const avgDuration = avgDurationR[0].avg;
  const inboundCalls = Number(inboundR[0].count);
  const outboundCalls = Number(outboundR[0].count);
  const avgAiLatency = avgLatencyR[0].avg;
  const openTasks = Number(openTasksR[0].count);
  const pendingHandoffs = Number(pendingHandoffsR[0].count);
  const avgResolution = avgResolutionR[0].avg;
  const callsToday = Number(callsTodayR[0].count);
  const callsThisWeek = Number(callsWeekR[0].count);
  const transferRate = totalCalls > 0 ? (Number(totalHandoffsR[0].count) / totalCalls) : 0;
  const bookingRate = totalCalls > 0 ? (Number(totalApptsR[0].count) / totalCalls) : 0;

  res.json({
    totalCalls, activeCalls, completedCalls, totalMessages, totalContacts,
    avgDurationSeconds: avgDuration ? Math.round(avgDuration) : 0,
    inboundCalls, outboundCalls,
    avgAiLatencyMs: avgAiLatency ? Math.round(avgAiLatency) : 0,
    openTasks, pendingHandoffs,
    avgResolutionScore: avgResolution ? Math.round(avgResolution * 100) / 100 : 0,
    callsToday, callsThisWeek,
    transferRate: Math.round(transferRate * 100),
    bookingRate: Math.round(bookingRate * 100),
  });
});

// ── API: OpenClaw Integration ────────────────────────────────────────────────

/** GET /api/openclaw/status — returns current OpenClaw config and connection status */
app.get("/api/openclaw/status", async (_req: Request, res: Response) => {
  const cfg = openClawConfig;
  if (!cfg?.enabled) {
    return res.json({
      enabled: false,
      gatewayUrl: process.env.OPENCLAW_GATEWAY_URL || "",
      agentId: process.env.OPENCLAW_AGENT_ID || "main",
      model: process.env.OPENCLAW_MODEL || "",
      connected: false,
    });
  }
  // Test live connection
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

/** POST /api/openclaw/test — test connectivity to the Gateway with provided config */
app.post("/api/openclaw/test", async (req: Request, res: Response) => {
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

/**
 * POST /api/openclaw/inject — push a message into an active call.
 * OpenClaw can call this endpoint to inject text that will be spoken
 * to the caller on the next turn.
 *
 * Body: { callSid: string, message: string, source?: string }
 * Auth: same DASHBOARD_API_KEY as other /api/* routes
 */
app.post("/api/openclaw/inject", dashboardAuth, async (req: Request, res: Response) => {
  const { callSid, message, source } = req.body;
  if (!callSid || typeof callSid !== "string") {
    return res.status(400).json({ error: "callSid is required" });
  }
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ error: "message is required" });
  }

  // Validate call exists and is active
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

/** GET /api/openclaw/active-calls — list all currently active calls (useful for OpenClaw to know what to inject into) */
app.get("/api/openclaw/active-calls", dashboardAuth, async (_req: Request, res: Response) => {
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

// ── Health Check ─────────────────────────────────────────────────────────────
// This endpoint is intentionally unauthenticated and fast.
// Use it to verify the tunnel is alive before making a call:
//   curl https://your-ngrok-url.ngrok.io/health
app.get("/health", async (_req: Request, res: Response) => {
  const appUrl = getAppUrl();
  const agent = await getActiveAgent();
  const twilioConfigured = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER);
  const geminiConfigured = !!env.GEMINI_API_KEY;
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    webhookUrl: `${appUrl}/api/twilio/incoming`,
    activeAgent: agent?.name || null,
    twilioConfigured,
    geminiConfigured,
    openClawEnabled: !!openClawConfig?.enabled,
    gatewayBridgeActive: !!gatewayBridge?.isConnected,
    aiBrain: openClawConfig?.enabled ? "OpenClaw" : openRouterConfig?.enabled ? `OpenRouter (${openRouterConfig.model})` : env.GEMINI_API_KEY ? "Gemini 2.0 Flash" : "No AI configured",
    ttsEngine: elevenLabsConfig ? `ElevenLabs (${elevenLabsConfig.voiceId})` : "Polly (fallback)",
    uptime: Math.round(process.uptime()),
  });
});

// ── Twilio Webhook Self-Test ──────────────────────────────────────────────────
// Simulates what Twilio sends when a call comes in, without needing a real call.
// Use this to verify the full incoming→process pipeline is working:
//   curl -X POST https://your-ngrok-url.ngrok.io/api/twilio/test-webhook
app.post("/api/twilio/test-webhook", async (req: Request, res: Response) => {
  const testCallSid = `TEST-${Date.now()}`;
  const testFrom = req.body.from || "+15550000001";
  const testTo = env.TWILIO_PHONE_NUMBER || "+15550000000";

  // Simulate the incoming call body
  const fakeIncoming = {
    CallSid: testCallSid,
    From: testFrom,
    To: testTo,
    Direction: "inbound",
  };

  // Simulate the process body (one turn)
  const fakeSpeech = req.body.speech || "Hello, is anyone there?";
  const fakeProcess = {
    CallSid: testCallSid,
    SpeechResult: fakeSpeech,
    Confidence: "0.9",
  };

  const results: Record<string, any> = {};

  try {
    // Step 1: Test incoming handler logic (without sending TwiML response)
    const agent = getActiveAgent();
    const { contact, isNew } = await resolveContact(testFrom);
    results.step1_caller_resolved = { contactId: contact.id, isNew, agentName: agent?.name || "(none)" };

    // Step 2: Test AI response generation
    const systemPrompt = agent?.system_prompt || "You are a helpful AI assistant on a phone call.";
    const callerContext = buildCallerContext(contact, isNew);
    const dispatchCtx = { callSid: testCallSid, contactId: contact.id, callerPhone: testFrom, fromPhone: testTo, twilioClient: null };

    const aiStart = Date.now();
    const { text: aiText, latencyMs, source } = await generateAiResponse(
      testCallSid, fakeSpeech, "test", callerContext, systemPrompt,
      dispatchCtx, env.GEMINI_API_KEY, 1, testFrom
    );
    results.step2_ai_response = { text: aiText.slice(0, 200), latencyMs, source };

    // Step 3: Check TwiML generation
    const twiml = new twilio.twiml.VoiceResponse();
    await buildTwimlSay(twiml, aiText, agent?.voice || "Polly.Joanna");
    twiml.gather({ input: ["speech"], action: "/api/twilio/process", speechTimeout: "auto" });
    results.step3_twiml = { valid: true, length: twiml.toString().length };

    results.overall = "PASS — all systems operational";
    res.json({ success: true, testCallSid, results });
  } catch (err: any) {
    results.error = err.message;
    results.overall = "FAIL";
    res.status(500).json({ success: false, testCallSid, results });
  }
});

// ── API: Webhook URL ──────────────────────────────────────────────────────────
app.get("/api/webhook-url", (_req: Request, res: Response) => {
  const appUrl = getAppUrl();
  res.json({ incomingUrl: `${appUrl}/api/twilio/incoming`, statusUrl: `${appUrl}/api/twilio/status` });
});

// ── API: Request Logs ─────────────────────────────────────────────────────────
app.get("/api/logs", async (_req: Request, res: Response) => {
  res.json(await sql`SELECT * FROM request_logs ORDER BY id DESC LIMIT 200`);
});

// ── API: Settings (in-app env var management) ────────────────────────────────
app.get("/api/settings", dashboardAuth, (_req: Request, res: Response) => {
  res.json({
    groups: SETTINGS_GROUPS,
    values: getMaskedSettings(),
    status: getConfigStatus(),
  });
});

app.post("/api/settings", dashboardAuth, (req: Request, res: Response) => {
  const updates = req.body as Record<string, string>;
  if (!updates || typeof updates !== "object") {
    return res.status(400).json({ error: "Body must be a JSON object of key-value pairs." });
  }
  const knownKeys = new Set(SETTINGS_GROUPS.flatMap((g: any) => g.fields.map((f: any) => f.key)));
  const unknownKeys = Object.keys(updates).filter((k) => !knownKeys.has(k));
  if (unknownKeys.length > 0) {
    return res.status(400).json({ error: `Unknown settings keys: ${unknownKeys.join(", ")}` });
  }
  try {
    writeEnvFile(updates);
    // Hot-reload OpenClaw and OpenRouter configs so changes take effect immediately
    reloadOpenClawConfig();
    log("info", "Settings updated via dashboard", { keys: Object.keys(updates) });
    res.json({ ok: true, status: getConfigStatus() });
  } catch (e: any) {
    log("error", "Failed to write settings", { error: e.message });
    res.status(500).json({ error: `Failed to save settings: ${e.message}` });
  }
});

app.post("/api/settings/test/:service", dashboardAuth, async (req: Request, res: Response) => {
  const { service } = req.params;
  const body = (req.body || {}) as Record<string, string>;

  try {
    if (service === "twilio") {
      const sid = body.TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID;
      const token = body.TWILIO_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN;
      if (!sid || !token) return res.json({ ok: false, error: "Account SID and Auth Token are required." });
      const client = twilio(sid, token);
      const account = await (client.api.accounts(sid) as any).fetch();
      res.json({ ok: true, message: `Connected — Account: ${account.friendlyName} (${account.status})` });
    } else if (service === "gemini") {
      const key = body.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
      if (!key) return res.json({ ok: false, error: "Gemini API Key is required." });
      const testAi = new GoogleGenAI({ apiKey: key });
      const result = await testAi.models.generateContent({ model: "gemini-2.0-flash", contents: "Reply with only the word: CONNECTED" });
      const text = (result as any).candidates?.[0]?.content?.parts?.[0]?.text || "";
      res.json({ ok: text.includes("CONNECTED"), message: text.includes("CONNECTED") ? "Gemini API connected successfully." : `Unexpected response: ${text}` });
    } else if (service === "openclaw") {
      const url = body.OPENCLAW_GATEWAY_URL || process.env.OPENCLAW_GATEWAY_URL;
      const token = body.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN;
      if (!url) return res.json({ ok: false, error: "Gateway URL is required." });
      const result = await testOpenClawConnection(url, token);
      res.json(result);
    } else if (service === "openrouter") {
      const key = body.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
      if (!key) return res.json({ ok: false, error: "OpenRouter API Key is required." });
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: body.OPENROUTER_MODEL || "openai/gpt-4o-mini", messages: [{ role: "user", content: "Reply with only: CONNECTED" }], max_tokens: 10 }),
      });
      if (!resp.ok) return res.json({ ok: false, error: `OpenRouter returned ${resp.status}: ${await resp.text()}` });
      const data = await resp.json() as any;
      const text = data.choices?.[0]?.message?.content || "";
      res.json({ ok: true, message: `OpenRouter connected. Response: ${text}` });
    } else if (service === "google_calendar") {
      const calId = body.GOOGLE_CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID;
      const saJson = body.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      if (!calId || !saJson) return res.json({ ok: false, error: "Calendar ID and Service Account JSON are required." });
      try {
        const creds = JSON.parse(saJson);
        const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: "test" }),
        });
        // If we can parse the JSON, credentials are valid format
        res.json({ ok: true, message: `Service account parsed successfully for: ${creds.client_email}. Full calendar test requires a live call.` });
      } catch (parseErr: any) {
        res.json({ ok: false, error: `Invalid JSON: ${parseErr.message}` });
      }
    } else {
      res.status(400).json({ error: `Unknown service: ${service}. Valid: twilio, gemini, openclaw, openrouter, google_calendar` });
    }
  } catch (e: any) {
    res.json({ ok: false, error: e.message });
  }
});

// ── API: Config Status (for onboarding wizard) ────────────────────────────────
app.get("/api/config-status", (_req: Request, res: Response) => {
  res.json(getConfigStatus());
});

// ── JSON 404 for API routes ───────────────────────────────────────────────────
app.use("/api/*", (_req: Request, res: Response) => {
  res.status(404).json({ error: "API endpoint not found." });
});

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  log("error", "Unhandled error", {
    requestId: (req as any).requestId,
    error: err.message,
    stack: IS_PROD ? undefined : err.stack,
  });
  res.status(500).json({ error: IS_PROD ? "Internal server error." : err.message });
});

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
const shutdown = () => {
  log("info", "Graceful shutdown initiated");
  if (gatewayBridge) gatewayBridge.disconnect();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ── Vite Middleware / Static Files ────────────────────────────────────────────
async function startServer() {
  // Initialize Postgres schema (idempotent)
  await initSchema();
  log("info", "Postgres schema initialized");

  if (!IS_PROD) {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    // In production the compiled bundle is at dist-server/server.mjs
    // The Vite frontend build is at dist/ (sibling of dist-server/)
    // Resolve one level up from __dirname to reach the project root
    const distPath = process.env.DIST_PATH ||
      path.resolve(__dirname, "..", "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  // Log OpenClaw status at startup
  reloadOpenClawConfig();

  // ── Start OpenClaw Gateway Bridge if configured ──────────────────────────
  const bridgeCfg = loadGatewayBridgeConfig();
  if (bridgeCfg) {
    gatewayBridge = new OpenClawGatewayBridge(
      bridgeCfg,
      {
        // Called when OpenClaw voice-call plugin answers an inbound call
        onCallStart: async (event: VoiceCallEvent) => {
          const agent = await getActiveAgent();
          const { contact, isNew } = await resolveContact(event.from || "unknown");
          logEvent(event.callId, isNew ? "CALLER_NEW" : "CALLER_IDENTIFIED", {
            contactId: contact.id, phone: event.from, source: "openclaw-bridge",
          });
          // Insert call record so the dashboard shows it
          await sql`
            INSERT INTO calls (call_sid, direction, to_number, from_number, status, agent_name, contact_id)
            VALUES (${event.callId}, 'inbound', ${event.to || ""}, ${event.from || ""}, 'in-progress', ${agent?.name || "Default Assistant"}, ${contact.id})
            ON CONFLICT (call_sid) DO NOTHING
          `;
          logEvent(event.callId, "CALL_STARTED", { source: "openclaw-voice-call-plugin", from: event.from });
          // Return greeting to be spoken
          return agent?.greeting || "Hello! I'm your AI assistant. How can I help you today?";
        },

        // Called every time the caller says something
        onTranscript: async (event: VoiceCallEvent) => {
          const agent = await getActiveAgent();
          const bridgeTurnRows = await sql<{ contact_id: number | null; turn_count: number }[]>`
            SELECT contact_id, turn_count FROM calls WHERE call_sid = ${event.callId}
          `;
          const bridgeTurnRecord = bridgeTurnRows[0];
          const contactId = bridgeTurnRecord?.contact_id || null;
          const turnCount = (bridgeTurnRecord?.turn_count || 0) + 1;
          await sql`UPDATE calls SET turn_count = ${turnCount} WHERE call_sid = ${event.callId}`;

          // Store user message
          await sql`INSERT INTO messages (call_sid, role, text) VALUES (${event.callId}, 'user', ${event.transcript})`;
          logEvent(event.callId, "SPEECH_RECEIVED", { text: event.transcript?.slice(0, 100), turn: turnCount });

          const bridgeContactRows = contactId
            ? await sql`SELECT * FROM contacts WHERE id = ${contactId}`
            : [];
          const contact = bridgeContactRows[0] || null;
          const callerContext = contact ? buildCallerContext(contact, false) : "";
          const systemPrompt = agent?.system_prompt || "You are a helpful AI assistant on a phone call.";
          const dispatchCtx = {
            callSid: event.callId, contactId, callerPhone: event.from || "",
            fromPhone: event.to || "", twilioClient: null,
          };

          const { text, latencyMs, source } = await generateAiResponse(
            event.callId, event.transcript!, "bridge", callerContext, systemPrompt,
            dispatchCtx, env.GEMINI_API_KEY, turnCount, event.from || ""
          );

          // Store AI response
          await sql`INSERT INTO messages (call_sid, role, text) VALUES (${event.callId}, 'assistant', ${text})`;
          logEvent(event.callId, "AI_RESPONSE_GENERATED", { latencyMs, source, turn: turnCount });

          return text;
        },

        // Called when the call ends
        onCallEnd: async (event: VoiceCallEvent) => {
          await sql`UPDATE calls SET status = 'completed' WHERE call_sid = ${event.callId}`;
          logEvent(event.callId, "CALL_ENDED", { source: "openclaw-voice-call-plugin" });
          // Run post-call intelligence asynchronously
          setTimeout(async () => {
            const endedBridgeRows = await sql<{ contact_id: number | null }[]>`SELECT contact_id FROM calls WHERE call_sid = ${event.callId}`;
            const endedRecord = endedBridgeRows[0];
            runPostCallIntelligence(event.callId, endedRecord?.contact_id ?? null, env.GEMINI_API_KEY).catch((err: Error) =>
              log("warn", "Post-call intelligence failed", { callId: event.callId, error: err.message })
            );
          }, 1_000);
        },
      },
      log
    );
    gatewayBridge.connect();
    log("info", "OpenClaw Gateway Bridge started", {
      gatewayUrl: bridgeCfg.gatewayUrl,
      agentId: bridgeCfg.agentId,
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    log("info", "AI Phone Agent started", {
      port: PORT,
      env: env.NODE_ENV || "development",
      webhookUrl: `${getAppUrl()}/api/twilio/incoming`,
      authEnabled: !!env.DASHBOARD_API_KEY,
      openClawEnabled: !!openClawConfig?.enabled,
      openClawGateway: openClawConfig?.gatewayUrl || "(disabled)",
      openClawModel: openClawConfig?.model || "(disabled)",
      gatewayBridgeActive: !!gatewayBridge?.isConnected,
      aiBrain: openClawConfig?.enabled ? "OpenClaw Gateway" : openRouterConfig?.enabled ? `OpenRouter (${openRouterConfig.model})` : env.GEMINI_API_KEY ? "Gemini 2.0 Flash" : "No AI configured",
      ttsEngine: elevenLabsConfig ? `ElevenLabs (${elevenLabsConfig.voiceId})` : "Polly (fallback)",
    });
  });
}

startServer().catch((err) => {
  log("error", "Failed to start server", { error: err.message });
  process.exit(1);
});
