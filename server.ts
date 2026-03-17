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

import { loadElevenLabsConfig, generateSpeech, getElevenLabsAgentVoice, type ElevenLabsConfig } from "./src/elevenlabs.js";
import { loadCartesiaTTSConfig, generateCartesiaSpeech, type CartesiaTTSConfig } from "./src/cartesia-tts.js";
import { searchLeadsApollo, searchLeadsGoogleMaps, generatePersonalizedPitch, saveLead, getLeads, saveCampaign, getCampaigns, type LeadSearchParams } from "./src/lead-hunter.js";
import { loadOpenAITTSConfig, generateOpenAISpeech, getAgentVoice, type OpenAITTSConfig } from "./src/openai-tts.js";
import { loadGoogleTTSConfig, generateGoogleSpeech, getGoogleAgentVoice, type GoogleTTSConfig } from "./src/google-tts.js";

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
  // OpenAI TTS
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_TTS_VOICE: z.string().optional(),
  OPENAI_TTS_MODEL: z.string().optional(),
  OPENAI_TTS_SPEED: z.string().optional(),
  // Google Cloud TTS
  GOOGLE_TTS_API_KEY: z.string().optional(),
  GOOGLE_TTS_VOICE: z.string().optional(),
  GOOGLE_TTS_LANGUAGE: z.string().optional(),
  GOOGLE_TTS_SPEED: z.string().optional(),
  GOOGLE_TTS_PITCH: z.string().optional(),
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
import { loadOpenRouterConfig, queryOpenRouter, streamOpenRouter, type OpenRouterConfig } from "./src/openrouter.js";
import { fireCallWebhooks, fireTestWebhook, buildCallPayload, loadWebhookConfig } from "./src/webhooks.js";
import { syncAllCrms, getConfiguredCrms, isHubSpotConfigured, isSalesforceConfigured, isAirtableConfigured, isNotionConfigured } from "./src/crm.js";
import { getAllPluginTools, getPluginTools, createPluginTool, updatePluginTool, deletePluginTool, testPluginTool, pluginToolsToDeclarations, executePluginTool, EXAMPLE_TOOLS } from "./src/plugin-tools.js";
import { getMcpServers, getEnabledMcpServers, createMcpServer, updateMcpServer, deleteMcpServer, testMcpServer, loadMcpSession, mcpToolsToDeclarations, callMcpTool, POPULAR_MCP_SERVERS } from "./src/mcp-bridge.js";
import { initSaasSchema, getWorkspaces, getWorkspaceById, createWorkspace, updateWorkspace, deleteWorkspace, getWorkspaceMembers, inviteMember, removeMember, acceptInvite, checkUsageLimits, getWorkspaceStats, handleStripeWebhook, PLAN_LIMITS } from "./src/saas.js";
import { initProspectorSchema, getCampaigns, getCampaignById, createCampaign, updateCampaignStatus, getLeads, addLeads, updateLeadStatus, findBusinessesViaPlaces, buildPitchSystemPrompt, parseLeadsCsv, dialNextLead } from "./src/prospector.js";
import { initComplianceSchema, checkOutboundCompliance, addToDNC, isOnDNC, getDNCList, removeFromDNC, detectOptOut, getComplianceAudit, getRecordingDisclosure } from "./src/compliance.js";
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

app.set('trust proxy', 1); // Railway sits behind a proxy
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

// ── Workspace Resolver ───────────────────────────────────────────────────────
// Extracts workspace_id from X-Workspace-Id header, defaults to 1 (single-tenant).
// All data queries MUST use this to prevent cross-tenant leakage.
const getWorkspaceId = (req: Request): number => {
  const h = req.headers['x-workspace-id'];
  const id = h ? parseInt(Array.isArray(h) ? h[0] : h, 10) : 1;
  return isNaN(id) || id < 1 ? 1 : id;
};

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
  // Skip validation in dev or when no auth token is configured
  if (!authToken || !IS_PROD) return next();

  const signature = req.headers["x-twilio-signature"] as string;
  if (!signature) {
    log("warn", "Missing Twilio signature header", { ip: req.ip });
    return res.status(403).send("Forbidden");
  }

  // Build the URL exactly as Twilio signed it — use the forwarded proto if behind a proxy
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers["host"] || "";
  const urlFromRequest = `${proto}://${host}${req.originalUrl}`;
  const urlFromEnv = `${getAppUrl()}${req.originalUrl}`;

  // Try both URL forms — Railway proxy can change the apparent host
  const isValidFromRequest = twilio.validateRequest(authToken, signature, urlFromRequest, req.body);
  const isValidFromEnv = twilio.validateRequest(authToken, signature, urlFromEnv, req.body);

  if (!isValidFromRequest && !isValidFromEnv) {
    log("warn", "Invalid Twilio signature", { urlFromRequest, urlFromEnv, ip: req.ip });
    return res.status(403).send("Forbidden");
  }
  next();
};

app.use("/api/twilio", twilioValidate);

// ── Input Validation Schemas ──────────────────────────────────────────────────
const OutboundCallSchema = z.object({
  to: z.string().regex(/^\+[1-9]\d{7,14}$/, "Phone number must be in E.164 format (e.g. +15551234567)"),
  agentId: z.number().int().positive().optional(),
  reason: z.string().max(500).optional(),
  notes: z.string().max(1000).optional(),
  scheduleAt: z.string().optional(), // ISO datetime for scheduled calls (future use)
});

const AgentConfigSchema = z.object({
  name: z.string().min(1).max(100),
  display_name: z.string().max(100).optional(),
  tagline: z.string().max(300).optional(),
  system_prompt: z.string().min(10).max(8000),
  greeting: z.string().min(5).max(500),
  voice: z.string().optional().default("alice"),
  language: z.string().min(2).max(10).optional().default("en-US"),
  vertical: z.string().optional().default("general"),
  role: z.string().optional().default("vertical"),
  tier: z.string().optional().default("specialist"),
  color: z.string().optional().default("#ff6b00"),
  max_turns: z.number().int().min(3).max(50).optional().default(20),
  tool_permissions: z.array(z.string()).optional().default([]),
  routing_keywords: z.array(z.string()).optional().default([]),
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

const getAppUrl = () => (env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

// In-memory TTS audio store: id → Buffer (cleared after 5 min)
const ttsAudioStore = new Map<string, { buffer: Buffer; expires: number; contentType: string }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ttsAudioStore) {
    if (v.expires < now) ttsAudioStore.delete(k);
  }
}, 60_000);

/**
 * Build TwiML speech output.
 * Priority: 1) ElevenLabs (best quality, human-sounding) → 2) Google Neural2 → 3) OpenAI TTS
 * Polly is NEVER used — if no TTS is configured the call gets a spoken error.
 */
const buildTwimlSay = async (twiml: twilio.twiml.VoiceResponse, text: string, _voice: string, agentName?: string): Promise<void> => {
  // 0. Cartesia Sonic — fastest (40ms), most human-sounding
  if (cartesiaConfig) {
    try {
      const buffer = await generateCartesiaSpeech(text, cartesiaConfig, agentName);
      if (buffer) {
        const id = uuidv4();
        ttsAudioStore.set(id, { buffer, expires: Date.now() + 5 * 60_000, contentType: "audio/basic" });
        const appUrl = getAppUrl();
        twiml.play(`${appUrl}/api/tts/${id}`);
        return;
      }
    } catch (err: any) {
      log("warn", "Cartesia TTS failed, trying ElevenLabs", { error: err.message });
    }
  }
  // 1. ElevenLabs Flash v2.5 — 75ms, very human-sounding
  if (elevenLabsConfig) {
    try {
      const buffer = await generateSpeech(text, elevenLabsConfig, agentName);
      if (buffer) {
        const id = uuidv4();
        ttsAudioStore.set(id, { buffer, expires: Date.now() + 5 * 60_000, contentType: "audio/mpeg" });
        const appUrl = getAppUrl();
        twiml.play(`${appUrl}/api/tts/${id}`);
        return;
      }
    } catch (err: any) {
      log("warn", "ElevenLabs TTS failed, trying Google Neural2", { error: err.message });
    }
  }
  // 2. Google Cloud Neural2 — second best
  if (googleTTSConfig) {
    try {
      const googleVoice = agentName ? getGoogleAgentVoice(agentName) : googleTTSConfig.voice;
      const configWithVoice = { ...googleTTSConfig, voice: googleVoice };
      const buffer = await generateGoogleSpeech(text, configWithVoice);
      if (buffer) {
        const id = uuidv4();
        ttsAudioStore.set(id, { buffer, expires: Date.now() + 5 * 60_000, contentType: "audio/mpeg" });
        const appUrl = getAppUrl();
        twiml.play(`${appUrl}/api/tts/${id}`);
        return;
      }
    } catch (err: any) {
      log("warn", "Google TTS failed, trying OpenAI TTS", { error: err.message });
    }
  }
  // 3. OpenAI TTS — third option
  if (openAITTSConfig) {
    try {
      const agentVoice = agentName ? getAgentVoice(agentName) : openAITTSConfig.voice;
      const configWithVoice = { ...openAITTSConfig, voice: agentVoice };
      const buffer = await generateOpenAISpeech(text, configWithVoice);
      if (buffer) {
        const id = uuidv4();
        ttsAudioStore.set(id, { buffer, expires: Date.now() + 5 * 60_000, contentType: "audio/mpeg" });
        const appUrl = getAppUrl();
        twiml.play(`${appUrl}/api/tts/${id}`);
        return;
      }
    } catch (err: any) {
      log("warn", "OpenAI TTS failed — no more TTS options", { error: err.message });
    }
  }
  // No TTS configured — use Twilio's built-in neural voice (NOT Polly)
  // Alice is Twilio's own neural TTS — far better than Polly
  twiml.say({ voice: "alice" as any }, text);
};

// ── Active Call Kill Timers (15-min watchdog) ────────────────────────────────
const activeCallTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Streaming TTS pipeline: LLM tokens → sentence chunks → parallel TTS synthesis → TwiML play chain.
 *
 * How it works:
 *   1. Stream tokens from OpenRouter, buffering until a sentence boundary is hit
 *   2. As each sentence arrives, immediately fire a Google TTS synthesis request (async)
 *   3. Collect all audio buffers in order, store in ttsAudioStore
 *   4. Return an ordered list of audio IDs for TwiML <Play> tags
 *
 * This gets first-audio latency down to ~400ms (first LLM sentence + TTS) vs 2-3s non-streaming.
 * Falls back to non-streaming if streaming fails.
 */
async function streamingTtsPipeline(
  systemPrompt: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
  userMessage: string,
  agentName: string
): Promise<{ audioIds: string[]; fullText: string; latencyMs: number; firstChunkMs?: number }> {
  if (!openRouterConfig?.enabled) {
    throw new Error("OpenRouter not configured");
  }

  const start = Date.now();
  const audioIds: string[] = [];
  const sentences: string[] = [];
  let firstChunkMs: number | undefined;

  // Determine TTS synthesizer: Cartesia > ElevenLabs > Google > OpenAI
  const synthesize = async (text: string): Promise<Buffer | null> => {
    if (cartesiaConfig) {
      try {
        return await generateCartesiaSpeech(text, cartesiaConfig, agentName);
      } catch { /* fall through */ }
    }
    if (elevenLabsConfig) {
      try {
        return await generateSpeech(text, elevenLabsConfig, agentName);
      } catch { /* fall through */ }
    }
    if (googleTTSConfig) {
      const googleVoice = getGoogleAgentVoice(agentName);
      return generateGoogleSpeech(text, { ...googleTTSConfig, voice: googleVoice });
    }
    if (openAITTSConfig) {
      const openAIVoice = getAgentVoice(agentName);
      return generateOpenAISpeech(text, { ...openAITTSConfig, voice: openAIVoice });
    }
    return null;
  };

  // Fire TTS requests as sentences arrive, collect promises in order
  const ttsPromises: Promise<{ id: string | null; sentence: string }>[] = [];

  const stream = streamOpenRouter(
    openRouterConfig,
    systemPrompt,
    conversationHistory,
    userMessage
  );

  for await (const chunk of stream) {
    if (chunk.firstChunkMs !== undefined) firstChunkMs = chunk.firstChunkMs;
    if (!chunk.sentence) continue;

    sentences.push(chunk.sentence);
    const sentence = chunk.sentence;

    // Fire TTS synthesis immediately (don't await — pipeline in parallel)
    const ttsPromise = synthesize(sentence).then((buffer) => {
      if (!buffer) return { id: null, sentence };
      const id = uuidv4();
      ttsAudioStore.set(id, { buffer, expires: Date.now() + 5 * 60_000 });
      return { id, sentence };
    }).catch(() => ({ id: null, sentence }));

    ttsPromises.push(ttsPromise);
  }

  // Wait for all TTS synthesis to complete (in order)
  const results = await Promise.all(ttsPromises);
  for (const r of results) {
    if (r.id) audioIds.push(r.id);
  }

  return {
    audioIds,
    fullText: sentences.join(" "),
    latencyMs: Date.now() - start,
    firstChunkMs,
  };
}

// ── OpenClaw Config (loaded once at startup) ────────────────────────────────────────────
let openClawConfig: OpenClawConfig | null = loadOpenClawConfig();

// ── OpenRouter Config (loaded once at startup) ────────────────────────────────────────────
let openRouterConfig: OpenRouterConfig | null = loadOpenRouterConfig();

// ── Google Cloud TTS Config (loaded once at startup — primary voice engine) ──────────────
let googleTTSConfig: GoogleTTSConfig | null = loadGoogleTTSConfig();
// ── OpenAI TTS Config (loaded once at startup — secondary voice fallback) ───────────────────
let openAITTSConfig: OpenAITTSConfig | null = loadOpenAITTSConfig();
// ── ElevenLabs TTS Config (loaded once at startup — tertiary fallback) ───────────────────
let elevenLabsConfig: ElevenLabsConfig | null = loadElevenLabsConfig();

// ── OpenClaw Gateway Bridge (WebSocket — handles voice-call plugin events) ───
// This is the correct integration path when OpenClaw's voice-call plugin
// owns the Twilio number. The bridge receives transcript events from the
// plugin and sends AI responses back via the Gateway speak API.
let gatewayBridge: OpenClawGatewayBridge | null = null;

// Reload all AI + TTS config (called at startup and when settings change)
const reloadOpenClawConfig = () => {
  openClawConfig = loadOpenClawConfig();
  openRouterConfig = loadOpenRouterConfig();
  googleTTSConfig = loadGoogleTTSConfig();
  openAITTSConfig = loadOpenAITTSConfig();
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

  // ── OpenRouter — Primary AI Brain (with plugin tools + MCP) ────────────────────────
  if (openRouterConfig?.enabled) {
    try {
      const historyRows = await sql<{ role: string; text: string }[]>`
        SELECT role, text FROM messages WHERE call_sid = ${callSid} AND role IN ('user','assistant') ORDER BY id ASC LIMIT 20
      `;
      const history = historyRows.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.text,
      }));
      const fullPrompt = `${systemPrompt}\n\nCaller context: ${callerContext || "New caller"}`;

      // Load plugin tools and MCP tools for this call
      const [pluginTools, mcpSession] = await Promise.all([
        getPluginTools().catch(() => []),
        loadMcpSession().catch(() => ({ tools: [], serverMap: new Map() })),
      ]);

      const allExtraDeclarations = [
        ...pluginToolsToDeclarations(pluginTools),
        ...mcpToolsToDeclarations(mcpSession.tools),
      ];

      // If we have extra tools, use tool-calling mode; otherwise plain query
      if (allExtraDeclarations.length > 0) {
        const toolsInvoked: string[] = [];
        let messages: any[] = [
          { role: "system", content: fullPrompt },
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: speechText },
        ];

        // ── Hardened multi-round tool calling loop (max 4 rounds) ──────────────
        // Features: per-call timeout, partial JSON recovery, per-tool error isolation,
        // circuit breaker (skip tool after 2 consecutive failures), detailed logging.
        const toolFailCounts: Record<string, number> = {};
        const TOOL_TIMEOUT_MS = 8000; // 8s per tool call
        const loopStart = Date.now();

        // Helper: safe JSON parse with partial recovery
        const safeParseArgs = (raw: string): Record<string, unknown> => {
          try { return JSON.parse(raw || "{}"); } catch {
            // Attempt to recover truncated JSON by appending closing braces
            try { return JSON.parse(raw + "}"); } catch {
              try { return JSON.parse(raw + "}}"); } catch {
                log("warn", "Tool args unparseable — using empty object", { callSid, raw: raw.slice(0, 200) });
                return {};
              }
            }
          }
        };

        // Helper: run a promise with a timeout
        const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
          Promise.race([
            promise,
            new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Tool timeout: ${label} exceeded ${ms}ms`)), ms)),
          ]);

        for (let round = 0; round < 4; round++) {
          logEvent(callSid, "TOOL_LOOP_ROUND", { round, messagesLen: messages.length, toolsInvoked, elapsedMs: Date.now() - loopStart });

          const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${openRouterConfig.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: openRouterConfig.model,
              messages,
              tools: allExtraDeclarations.map((d) => ({ type: "function", function: d })),
              tool_choice: "auto",
              temperature: 0.4,
              max_tokens: 512,
            }),
          });
          if (!resp.ok) throw new Error(`OpenRouter ${resp.status}: ${await resp.text()}`);
          const data = await resp.json() as any;
          const msg = data.choices?.[0]?.message;
          if (!msg) break;

          // If no tool calls, we have the final text response
          if (!msg.tool_calls?.length) {
            const text = msg.content || "";
            logEvent(callSid, "OPENROUTER_RESPONSE", { latencyMs: Date.now() - loopStart, model: openRouterConfig.model, toolsInvoked, rounds: round + 1 });
            return { text, latencyMs: Date.now() - loopStart, toolsInvoked, shouldHangUp: false, source: "openclaw" as const };
          }

          // Execute tool calls (isolated — one failure doesn't break others)
          messages.push({ role: "assistant", content: msg.content || null, tool_calls: msg.tool_calls });
          for (const tc of msg.tool_calls) {
            const fnName = tc.function.name;

            // Circuit breaker: skip tools that have failed twice in this call
            if ((toolFailCounts[fnName] || 0) >= 2) {
              log("warn", "Circuit breaker: skipping tool after 2 failures", { callSid, fnName });
              messages.push({ role: "tool", tool_call_id: tc.id, content: `Tool ${fnName} is temporarily unavailable. Please proceed without it.` });
              continue;
            }

            const fnArgs = safeParseArgs(tc.function.arguments || "{}");
            toolsInvoked.push(fnName);
            let toolResult: any;

            try {
              // Check if it's a plugin tool
              const pluginTool = pluginTools.find((t) => t.name === fnName);
              if (pluginTool) {
                const r = await withTimeout(executePluginTool(pluginTool, fnArgs, callerPhone), TOOL_TIMEOUT_MS, fnName);
                toolResult = r.success ? (r.spoken_response || r.data) : `Error: ${r.error}`;
                if (!r.success) toolFailCounts[fnName] = (toolFailCounts[fnName] || 0) + 1;
              } else {
                // Check if it's an MCP tool
                const mcpServer = mcpSession.serverMap.get(fnName);
                if (mcpServer) {
                  const r = await withTimeout(callMcpTool(mcpServer, fnName, fnArgs), TOOL_TIMEOUT_MS, fnName);
                  toolResult = r.success ? (r.spoken_response || r.content) : `Error: ${r.error}`;
                  if (!r.success) toolFailCounts[fnName] = (toolFailCounts[fnName] || 0) + 1;
                } else {
                  // Built-in tool via dispatchCtx
                  const { dispatchTool } = await import("./src/function-calling.js");
                  const r = await withTimeout(dispatchTool(fnName, fnArgs, dispatchCtx), TOOL_TIMEOUT_MS, fnName);
                  toolResult = r.success ? r.message : `Error: ${r.error}`;
                  if (!r.success) toolFailCounts[fnName] = (toolFailCounts[fnName] || 0) + 1;
                  if (fnName === "mark_do_not_call" || (fnName === "escalate_to_human" && r.success)) {
                    messages.push({ role: "tool", tool_call_id: tc.id, content: String(toolResult) });
                    // Get final text then hang up
                    const finalResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                      method: "POST",
                      headers: { "Authorization": `Bearer ${openRouterConfig.apiKey}`, "Content-Type": "application/json" },
                      body: JSON.stringify({ model: openRouterConfig.model, messages, temperature: 0.4, max_tokens: 128 }),
                    });
                    const finalData = await finalResp.json() as any;
                    return { text: finalData.choices?.[0]?.message?.content || r.message, latencyMs: Date.now() - loopStart, toolsInvoked, shouldHangUp: true, source: "openclaw" as const };
                  }
                }
              }
            } catch (toolErr: any) {
              // Isolated tool failure — log and continue, don't crash the loop
              toolFailCounts[fnName] = (toolFailCounts[fnName] || 0) + 1;
              toolResult = `Tool error: ${toolErr.message}. Please continue without this information.`;
              log("warn", "Tool execution failed (isolated)", { callSid, fnName, error: toolErr.message, failCount: toolFailCounts[fnName] });
              logEvent(callSid, "TOOL_ERROR", { tool: fnName, error: toolErr.message, round });
            }

            messages.push({ role: "tool", tool_call_id: tc.id, content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult) });
          }
        }
        // Loop exhausted — get a final summary response
        logEvent(callSid, "TOOL_LOOP_EXHAUSTED", { toolsInvoked, rounds: 4, elapsedMs: Date.now() - loopStart });
        const exhaustedResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${openRouterConfig.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: openRouterConfig.model, messages, temperature: 0.4, max_tokens: 256 }),
        });
        const exhaustedData = await exhaustedResp.json() as any;
        const exhaustedText = exhaustedData.choices?.[0]?.message?.content || "I've handled everything. Is there anything else I can help with?";
        return { text: exhaustedText, latencyMs: Date.now() - loopStart, toolsInvoked, shouldHangUp: false, source: "openclaw" as const };
      }

      // No extra tools — plain query
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

  const { to, agentId, reason, notes } = parsed.data;
  const from = env.TWILIO_PHONE_NUMBER;
  if (!from) return res.status(400).json({ error: "TWILIO_PHONE_NUMBER is not configured." });

  try {
    const client = getTwilioClient();
    const appUrl = getAppUrl();
    // Build incoming URL with optional agentId override
    const incomingUrl = agentId
      ? `${appUrl}/api/twilio/incoming?agentId=${agentId}`
      : `${appUrl}/api/twilio/incoming`;
    const call = await client.calls.create({
      url: incomingUrl,
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

    // Resolve agent: use specified agentId or fall back to active agent
    let agent = await getActiveAgent();
    if (agentId) {
      const rows = await sql`SELECT * FROM agent_configs WHERE id = ${agentId} LIMIT 1` as any[];
      if (rows[0]) agent = rows[0];
    }
    const { contact } = await resolveContact(to);

    await sql`
      INSERT INTO calls (call_sid, direction, to_number, from_number, status, agent_name, contact_id)
      VALUES (${call.sid}, 'outbound', ${to}, ${from}, 'initiated', ${agent?.name || "Default Assistant"}, ${contact.id})
      ON CONFLICT (call_sid) DO NOTHING
    `;

    // Store call reason/notes as system context for the agent
    if (reason || notes) {
      const ctx = [reason && `[CALL REASON] ${reason}`, notes && `[OPERATOR NOTES] ${notes}`].filter(Boolean).join("\n");
      await sql`INSERT INTO messages (call_sid, role, text) VALUES (${call.sid}, 'system', ${ctx})`;
    }

    logEvent(call.sid, "CALL_STARTED", { direction: "outbound", to, contactId: contact.id, agentId, reason });
    log("info", "Outbound call initiated", { requestId, callSid: call.sid, to, agentId, reason });
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
        twiml: `<Response><Say voice="alice">Hey, this is the AI assistant at ${bizName}. Sorry we missed you — please give us a call back at your convenience and we'll get you taken care of. Have a great day!</Say><Hangup/></Response>`,
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
          // Auto-detect opt-out phrases and add to DNC if found
          try {
            const msgRows = await sql`SELECT content FROM messages WHERE call_sid = ${CallSid} AND role = 'user' ORDER BY created_at ASC`;
            const fullTranscript = msgRows.map((m: any) => m.content).join(" ");
            const [callRow] = await sql`SELECT from_number, to_number, direction FROM calls WHERE call_sid = ${CallSid}`;
            const callerPhone = callRow?.direction === "inbound" ? callRow?.from_number : callRow?.to_number;
            if (fullTranscript && callerPhone) {
              const optedOut = await detectOptOut(fullTranscript, callerPhone);
              if (optedOut) log("info", "Auto-DNC triggered from transcript", { callSid: CallSid, phone: callerPhone });
            }
          } catch (e: any) { log("warn", "Opt-out detection failed", { error: e.message }); }
        } catch (err: any) {
          log("error", "Post-call intelligence failed", { callSid: CallSid, error: err.message });
        }
        // Fire outbound webhooks after intelligence is done (so extracted data is included)
        try {
          await fireCallWebhooks(CallSid, getAppUrl(), "call_completed");
        } catch (err: any) {
          log("warn", "Webhook delivery failed", { callSid: CallSid, error: err.message });
        }
        // Sync to all configured CRMs
        try {
          const configuredCrms = getConfiguredCrms();
          if (configuredCrms.length > 0) {
            const [callRows, summaryRows, contactRows] = await Promise.all([
              sql`SELECT * FROM calls WHERE call_sid = ${CallSid}`,
              sql`SELECT * FROM call_summaries WHERE call_sid = ${CallSid} LIMIT 1`,
              sql`SELECT * FROM contacts WHERE id = ${callRecord?.contact_id || 0}`,
            ]);
            const call = callRows[0];
            const summary = summaryRows[0];
            const contact = contactRows[0];
            if (call && contact) {
              const crmContact = {
                phone: contact.phone_number,
                name: contact.name || undefined,
                email: contact.email || undefined,
                company: contact.company || undefined,
              };
              const crmLog = {
                callSid: CallSid,
                duration: call.duration || 0,
                summary: summary?.summary || "Call completed.",
                outcome: summary?.outcome || "completed",
                sentiment: summary?.sentiment || "neutral",
                calledAt: call.started_at || new Date().toISOString(),
                agentName: call.agent_name || "SMIRK",
              };
              const crmResults = await syncAllCrms(crmContact, crmLog);
              log("info", "CRM sync complete", { callSid: CallSid, crms: configuredCrms, results: crmResults.map((r) => ({ platform: r.platform, success: r.success, action: r.action })) });
            }
          }
        } catch (err: any) {
          log("warn", "CRM sync failed", { callSid: CallSid, error: err.message });
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

  // Support agentId override via query param (used by outbound calls with specific agent)
  const agentIdOverride = req.query.agentId ? parseInt(req.query.agentId as string) : null;
  let agent = await getActiveAgent();
  if (agentIdOverride) {
    const rows = await sql`SELECT * FROM agent_configs WHERE id = ${agentIdOverride} LIMIT 1` as any[];
    if (rows[0]) agent = rows[0];
  }

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
        twiml: "<Response><Say voice=\"alice\">I apologize, but we've reached our maximum call time. Please call back and we'll be happy to continue helping you. Goodbye!</Say><Hangup/></Response>",
      });
    } catch { /* call may have already ended */ }
  }, CALL_TIMEOUT_MS);
  activeCallTimers.set(CallSid, killTimer);
  const agentName = agent?.name || "SMIRK";
  log("info", "Call connected", { callSid: CallSid, direction: Direction, contactId: contact.id, isNew, agentName });

  const twiml = new twilio.twiml.VoiceResponse();
  const greeting = agent?.greeting || "Hello! I'm your AI assistant. How can I help you today?";
  const voice = agent?.voice || "alice";
  const language = (agent?.language || "en-US") as any;
  await buildTwimlSay(twiml, greeting, voice, agentName);
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
  const twiml = new twilio.twiml.VoiceResponse();
  // Get call record for context — also look up the agent stored on the call
  const processCallRecordRows = await sql<{ contact_id: number | null; turn_count: number; agent_name: string | null }[]>`
    SELECT contact_id, turn_count, agent_name FROM calls WHERE call_sid = ${CallSid}
  `;
  const callRecord = processCallRecordRows[0];
  const contactId = callRecord?.contact_id || null;
  const turnCount = (callRecord?.turn_count || 0) + 1;
  // Resolve the agent for this call: prefer the agent stored on the call record, fall back to active agent
  let agent = await getActiveAgent();
  if (callRecord?.agent_name && callRecord.agent_name !== agent?.name) {
    const namedRows = await sql`SELECT * FROM agent_configs WHERE name = ${callRecord.agent_name} LIMIT 1` as any[];
    if (namedRows[0]) agent = namedRows[0];
  }
  const voice = agent?.voice || "alice";
  const language = (agent?.language || "en-US") as any;
  const maxTurns = agent?.max_turns || 20;
  const agentName = agent?.name || "SMIRK";
  // Update turn count
  await sql`UPDATE calls SET turn_count = ${turnCount} WHERE call_sid = ${CallSid}`;
  // Max turns watchdog
  if (turnCount > maxTurns) {
    logEvent(CallSid, "MAX_TURNS_REACHED", { turnCount, maxTurns });
    log("warn", "Max turns reached", { callSid: CallSid, turnCount });
    await buildTwimlSay(twiml, "We've been talking for a while. Let me connect you with someone from our team who can help you further. Have a great day!", voice, agentName);
    twiml.hangup();
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  logEvent(CallSid, "SPEECH_RECEIVED", { turnCount, speechLength: SpeechResult?.length || 0, confidence: Confidence });

  // Dead air / no speech detection
  if (!SpeechResult) {
    logEvent(CallSid, "DEAD_AIR_DETECTED", { turnCount });
    await buildTwimlSay(twiml, "I didn't catch that. Could you please repeat?", voice, agentName);
    twiml.gather({ input: ["speech"], action: "/api/twilio/process", speechTimeout: "auto", speechModel: "phone_call", enhanced: true, language });
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // End-of-call keyword detection
  const endKeywords = ["goodbye", "bye", "hang up", "end call", "stop", "quit", "that's all", "no more", "thank you goodbye"];
  if (endKeywords.some((kw) => SpeechResult.toLowerCase().includes(kw))) {
    await sql`INSERT INTO messages (call_sid, role, text) VALUES (${CallSid}, 'user', ${SpeechResult})`;
    await sql`INSERT INTO messages (call_sid, role, text) VALUES (${CallSid}, 'assistant', ${"Goodbye! Have a great day!"})`;
    await buildTwimlSay(twiml, "Goodbye! Have a great day!", voice, agentName);
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
    await buildTwimlSay(twiml, injectedText, voice, agentName);
    twiml.gather({ input: ["speech"], action: "/api/twilio/process", speechTimeout: "auto", speechModel: "phone_call", enhanced: true, language });
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  try {
    const agent = await getActiveAgent();
    // ── Time/date injection + ironclad rules ─────────────────────────────────────
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

    // ── Load conversation history for streaming pipeline ────────────────────────
    const historyRows = await sql<{ role: string; text: string }[]>`
      SELECT role, text FROM messages WHERE call_sid = ${CallSid} AND role IN ('user','assistant') ORDER BY id ASC LIMIT 20
    `;
    const conversationHistory = historyRows.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.text,
    }));
    const fullSystemPrompt = `${systemPrompt}\n\nCaller context: ${callerContext || "New caller"}`;

    // ── Try streaming pipeline first (OpenRouter + TTS in parallel) ────────────
    let aiText = "";
    let latencyMs = 0;
    let firstChunkMs: number | undefined;
    let usedStreaming = false;

    if (openRouterConfig?.enabled && (googleTTSConfig || openAITTSConfig)) {
      try {
        const streamResult = await streamingTtsPipeline(
          fullSystemPrompt,
          conversationHistory,
          SpeechResult,
          agentName
        );

        aiText = streamResult.fullText;
        latencyMs = streamResult.latencyMs;
        firstChunkMs = streamResult.firstChunkMs;
        usedStreaming = true;

        // Build TwiML from ordered audio IDs
        const appUrl = getAppUrl();
        if (streamResult.audioIds.length > 0) {
          // Play each sentence chunk in sequence, then gather next input
          for (const id of streamResult.audioIds) {
            twiml.play(`${appUrl}/api/tts/${id}`);
          }
        } else {
          // Streaming succeeded but no TTS audio (TTS not configured) — use Polly
          twiml.say({ voice: "alice" as any }, aiText);
        }

        log("info", "Streaming pipeline complete", {
          requestId, callSid: CallSid, latencyMs, firstChunkMs,
          turnCount, chunks: streamResult.audioIds.length, source: "streaming",
        });
        logEvent(CallSid, "AI_RESPONSE_GENERATED", {
          latencyMs, firstChunkMs, turnCount,
          responseLength: aiText.length, source: "streaming",
        });
      } catch (streamErr: any) {
        log("warn", "Streaming pipeline failed, falling back to non-streaming", {
          requestId, callSid: CallSid, error: streamErr.message,
        });
        usedStreaming = false;
      }
    }

    // ── Non-streaming fallback (Gemini / no TTS configured) ──────────────────
    if (!usedStreaming) {
      const { text, latencyMs: fallbackLatency, toolsInvoked, shouldHangUp: hangUp, source } =
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
      aiText = text;
      latencyMs = fallbackLatency;

      logEvent(CallSid, "AI_RESPONSE_GENERATED", {
        latencyMs, turnCount, responseLength: aiText.length, source,
      });
      log("info", "Non-streaming AI response", { requestId, callSid: CallSid, latencyMs, turnCount, source });

      await buildTwimlSay(twiml, aiText, voice, agentName);

      if (hangUp) {
        await sql`INSERT INTO messages (call_sid, role, text) VALUES (${CallSid}, 'assistant', ${aiText})`;
        twiml.hangup();
        res.type("text/xml");
        return res.send(twiml.toString());
      }
    }

    await sql`INSERT INTO messages (call_sid, role, text) VALUES (${CallSid}, 'assistant', ${aiText})`;
    twiml.gather({ input: ["speech"], action: "/api/twilio/process", speechTimeout: "auto", speechModel: "phone_call", enhanced: true, language });
  } catch (error: any) {
    log("error", "AI generation failed", { requestId, callSid: CallSid, error: error.message });
    logEvent(CallSid, "AI_ERROR", { error: error.message, turnCount });
    await buildTwimlSay(twiml, "I'm sorry, I'm having trouble right now. Please hold while I connect you with someone from our team.", voice, agentName);
    twiml.hangup();
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// ── API: Get All Calls ────────────────────────────────────────────────────────
app.get("/api/calls", async (req: Request, res: Response) => {
  const wsId = getWorkspaceId(req);
  const calls = await sql`
    SELECT c.*,
           mc.message_count,
           co.name as contact_name,
           cs.intent, cs.outcome, cs.summary as call_summary, cs.resolution_score as summary_score,
           cs.next_action, cs.sentiment
    FROM calls c
    LEFT JOIN (
      SELECT call_sid, COUNT(id) as message_count
      FROM messages WHERE role != 'system'
      GROUP BY call_sid
    ) mc ON c.call_sid = mc.call_sid
    LEFT JOIN contacts co ON c.contact_id = co.id
    LEFT JOIN call_summaries cs ON c.call_sid = cs.call_sid
    WHERE c.workspace_id = ${wsId}
    ORDER BY c.started_at DESC
    LIMIT 100
  `;
  res.json({ calls });
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
    "Content-Type": entry.contentType || "audio/mpeg",
    "Content-Length": entry.buffer.length,
    "Cache-Control": "no-cache",
  });
  res.send(entry.buffer);
});

app.get("/api/calls/active", dashboardAuth, async (req: Request, res: Response) => {
  const wsId = getWorkspaceId(req);
  const activeCalls = await sql`
    SELECT c.call_sid, c.from_number, c.to_number, c.started_at, c.direction,
           co.name as contact_name
    FROM calls c
    LEFT JOIN contacts co ON c.contact_id = co.id
    WHERE c.status = 'in-progress' AND c.workspace_id = ${wsId}
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
  const wsId = getWorkspaceId(req);
  const limit = Math.min(parseInt(req.query.limit as string || "50"), 100);
  const offset = parseInt(req.query.offset as string || "0");
  const contacts = await sql`
    SELECT c.*, COUNT(ca.id) as total_calls
    FROM contacts c
    LEFT JOIN calls ca ON c.id = ca.contact_id
    WHERE c.workspace_id = ${wsId}
    GROUP BY c.id
    ORDER BY c.last_seen DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const totalRows = await sql`SELECT COUNT(*) as count FROM contacts WHERE workspace_id = ${wsId}`;
  res.json({ contacts, total: Number(totalRows[0].count) });
});

app.get("/api/contacts/:id", async (req: Request, res: Response) => {
  const wsId = getWorkspaceId(req);
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid contact ID." });
  const contactRows = await sql`SELECT * FROM contacts WHERE id = ${id} AND workspace_id = ${wsId}`;
  if (!contactRows.length) return res.status(404).json({ error: "Contact not found." });
  const calls = await sql`SELECT * FROM calls WHERE contact_id = ${id} ORDER BY started_at DESC LIMIT 20`;
  const tasks = await sql`SELECT * FROM tasks WHERE contact_id = ${id} ORDER BY created_at DESC`;
  const appointments = await sql`SELECT * FROM appointments WHERE contact_id = ${id} ORDER BY scheduled_at DESC`;
  res.json({ contact: contactRows[0], calls, tasks, appointments });
});

// ── API: Tasks ────────────────────────────────────────────────────────────────
app.get("/api/tasks", async (req: Request, res: Response) => {
  const wsId = getWorkspaceId(req);
  const status = req.query.status as string || "open";
  const tasks = await sql`
    SELECT t.*, co.name as contact_name, co.phone_number
    FROM tasks t
    LEFT JOIN contacts co ON t.contact_id = co.id
    WHERE t.status = ${status} AND t.workspace_id = ${wsId}
    ORDER BY t.due_at ASC NULLS LAST, t.created_at DESC
    LIMIT 100
  `;
  res.json({ tasks });
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
  const wsId = getWorkspaceId(req);
  const handoffs = await sql`
    SELECT h.*, co.name as contact_name, co.phone_number
    FROM handoffs h
    LEFT JOIN contacts co ON h.contact_id = co.id
    WHERE h.status = 'pending' AND h.workspace_id = ${wsId}
    ORDER BY h.created_at DESC
    LIMIT 50
  `;
  res.json({ handoffs });
});

app.post("/api/handoffs/:id/acknowledge", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid handoff ID." });
  await sql`UPDATE handoffs SET status = 'acknowledged' WHERE id = ${id}`;
  res.json({ success: true });
});

// ── API: Call Summaries ───────────────────────────────────────────────────────
app.get("/api/summaries", async (req: Request, res: Response) => {
  const wsId = getWorkspaceId(req);
  const summaries = await sql`
    SELECT cs.*, co.name as contact_name, co.phone_number
    FROM call_summaries cs
    LEFT JOIN contacts co ON cs.contact_id = co.id
    WHERE cs.workspace_id = ${wsId}
    ORDER BY cs.created_at DESC
    LIMIT 50
  `;
  res.json(summaries);
});

// ── API: Agent Config CRUD ────────────────────────────────────────────
app.get("/api/agents", async (req: Request, res: Response) => {
  const wsId = getWorkspaceId(req);
  const agents = await sql`SELECT * FROM agent_configs WHERE workspace_id = ${wsId} ORDER BY id DESC`;
  res.json({ agents });
});

app.post("/api/agents", async (req: Request, res: Response) => {
  const parsed = AgentConfigSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { name, display_name, tagline, system_prompt, greeting, voice, language, vertical, role, tier, color, max_turns, tool_permissions, routing_keywords } = parsed.data;
  await sql`UPDATE agent_configs SET is_active = FALSE`;
  const agentRows = await sql`
    INSERT INTO agent_configs (name, display_name, tagline, system_prompt, greeting, voice, language, is_active, vertical, role, tier, color, max_turns, tool_permissions, routing_keywords)
    VALUES (${name}, ${display_name ?? name}, ${tagline ?? ''}, ${system_prompt}, ${greeting}, ${voice}, ${language}, TRUE, ${vertical}, ${role ?? 'vertical'}, ${tier ?? 'specialist'}, ${color ?? '#ff6b00'}, ${max_turns}, ${JSON.stringify(tool_permissions ?? [])}, ${JSON.stringify(routing_keywords ?? [])})
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
  const { name, display_name, tagline, system_prompt, greeting, voice, language, vertical, role, tier, color, max_turns, tool_permissions, routing_keywords } = parsed.data;
  await sql`
    UPDATE agent_configs SET
      name = ${name}, display_name = ${display_name ?? name}, tagline = ${tagline ?? ''},
      system_prompt = ${system_prompt}, greeting = ${greeting},
      voice = ${voice}, language = ${language}, vertical = ${vertical},
      role = ${role ?? 'vertical'}, tier = ${tier ?? 'specialist'}, color = ${color ?? '#ff6b00'},
      max_turns = ${max_turns},
      tool_permissions = ${JSON.stringify(tool_permissions ?? [])},
      routing_keywords = ${JSON.stringify(routing_keywords ?? [])},
      updated_at = NOW()
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
app.get("/api/stats", async (req: Request, res: Response) => {
  const wsId = getWorkspaceId(req);
  const [
    totalCallsR, activeCallsR, completedCallsR, totalMessagesR, totalContactsR,
    avgDurationR, inboundR, outboundR, avgLatencyR, openTasksR, pendingHandoffsR,
    avgResolutionR, callsTodayR, callsWeekR, totalHandoffsR, totalApptsR,
    // Conversion metrics
    leadsBookedR, callbacksR, qualifiedR, fieldsR, sentimentR,
    callsMonthR, contactsWithEmailR, contactsWithNameR,
    prospectTotalR, prospectInterestedR, prospectCalledR,
    dncCountR, avgConfidenceR,
  ] = await Promise.all([
    sql`SELECT COUNT(*) as count FROM calls WHERE workspace_id = ${wsId}`,
    sql`SELECT COUNT(*) as count FROM calls WHERE status = 'in-progress' AND workspace_id = ${wsId}`,
    sql`SELECT COUNT(*) as count FROM calls WHERE status = 'completed' AND workspace_id = ${wsId}`,
    sql`SELECT COUNT(*) as count FROM messages m JOIN calls c ON m.call_sid = c.call_sid WHERE m.role != 'system' AND c.workspace_id = ${wsId}`,
    sql`SELECT COUNT(*) as count FROM contacts WHERE workspace_id = ${wsId}`,
    sql`SELECT AVG(duration_seconds) as avg FROM calls WHERE duration_seconds IS NOT NULL AND workspace_id = ${wsId}`,
    sql`SELECT COUNT(*) as count FROM calls WHERE direction = 'inbound' AND workspace_id = ${wsId}`,
    sql`SELECT COUNT(*) as count FROM calls WHERE direction = 'outbound' AND workspace_id = ${wsId}`,
    sql`SELECT AVG(duration_ms) as avg FROM request_logs WHERE path = '/api/twilio/process' AND status_code = 200`,
    sql`SELECT COUNT(*) as count FROM tasks WHERE status = 'open' AND workspace_id = ${wsId}`,
    sql`SELECT COUNT(*) as count FROM handoffs WHERE status = 'pending' AND workspace_id = ${wsId}`,
    sql`SELECT AVG(resolution_score) as avg FROM call_summaries WHERE workspace_id = ${wsId}`,
    sql`SELECT COUNT(*) as count FROM calls WHERE DATE(started_at) = CURRENT_DATE AND workspace_id = ${wsId}`,
    sql`SELECT COUNT(*) as count FROM calls WHERE started_at >= NOW() - INTERVAL '7 days' AND workspace_id = ${wsId}`,
    sql`SELECT COUNT(*) as count FROM handoffs WHERE workspace_id = ${wsId}`,
    sql`SELECT COUNT(*) as count FROM appointments WHERE status = 'scheduled' AND workspace_id = ${wsId}`,
    // Conversion metrics
    sql`SELECT COUNT(*) as count FROM call_summaries WHERE outcome IN ('appointment_booked', 'lead_captured') AND workspace_id = ${wsId}`,
    sql`SELECT COUNT(*) as count FROM call_summaries WHERE outcome = 'callback_needed' AND workspace_id = ${wsId}`,
    sql`SELECT COUNT(*) as count FROM call_summaries WHERE resolution_score >= 0.7 AND workspace_id = ${wsId}`,
    sql`SELECT COUNT(*) as count FROM contact_custom_fields ccf JOIN contacts co ON ccf.contact_id = co.id WHERE ccf.source = 'ai_extracted' AND co.workspace_id = ${wsId}`,
    sql`SELECT sentiment, COUNT(*) as count FROM call_summaries WHERE workspace_id = ${wsId} GROUP BY sentiment`,
    sql`SELECT COUNT(*) as count FROM calls WHERE started_at >= NOW() - INTERVAL '30 days' AND workspace_id = ${wsId}`,
    sql`SELECT COUNT(*) as count FROM contacts WHERE email IS NOT NULL AND email != '' AND workspace_id = ${wsId}`,
    sql`SELECT COUNT(*) as count FROM contacts WHERE name IS NOT NULL AND name != '' AND workspace_id = ${wsId}`,
    sql`SELECT COALESCE(SUM(total_leads),0) as total, COALESCE(SUM(called),0) as called FROM prospecting_campaigns WHERE workspace_id = ${wsId}`,
    sql`SELECT COALESCE(SUM(interested),0) as count FROM prospecting_campaigns WHERE workspace_id = ${wsId}`,
    sql`SELECT COALESCE(SUM(called),0) as count FROM prospecting_campaigns WHERE workspace_id = ${wsId}`,
    sql`SELECT COUNT(*) as count FROM dnc_list WHERE workspace_id = ${wsId}`,
    sql`SELECT AVG(confidence) as avg FROM contact_custom_fields ccf JOIN contacts co ON ccf.contact_id = co.id WHERE ccf.confidence IS NOT NULL AND co.workspace_id = ${wsId}`,
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

  // Sentiment breakdown
  const sentimentMap: Record<string, number> = {};
  for (const row of sentimentR as any[]) sentimentMap[row.sentiment] = Number(row.count);

  // Conversion rates
  const leadsBooked = Number(leadsBookedR[0].count);
  const callbacksNeeded = Number(callbacksR[0].count);
  const qualifiedCalls = Number(qualifiedR[0].count);
  const fieldsExtracted = Number(fieldsR[0].count);
  const callsThisMonth = Number(callsMonthR[0].count);
  const contactsWithEmail = Number(contactsWithEmailR[0].count);
  const contactsWithName = Number(contactsWithNameR[0].count);
  const prospectTotalLeads = Number((prospectTotalR[0] as any).total || 0);
  const prospectCalled = Number((prospectTotalR[0] as any).called || 0);
  const prospectInterested = Number(prospectInterestedR[0].count || 0);
  const dncCount = Number(dncCountR[0].count);
  const avgFieldConfidence = avgConfidenceR[0].avg ? Math.round(Number(avgConfidenceR[0].avg) * 100) : null;

  const conversionRate = completedCalls > 0 ? Math.round((leadsBooked / completedCalls) * 100) : 0;
  const qualificationRate = completedCalls > 0 ? Math.round((qualifiedCalls / completedCalls) * 100) : 0;
  const prospectConversionRate = prospectCalled > 0 ? Math.round((prospectInterested / prospectCalled) * 100) : 0;
  const dataCaptureCoverage = totalContacts > 0 ? Math.round((contactsWithName / totalContacts) * 100) : 0;

  res.json({
    totalCalls, activeCalls, completedCalls, totalMessages, totalContacts,
    avgDurationSeconds: avgDuration ? Math.round(avgDuration) : 0,
    inboundCalls, outboundCalls,
    avgAiLatencyMs: avgAiLatency ? Math.round(avgAiLatency) : 0,
    openTasks, pendingHandoffs,
    avgResolutionScore: avgResolution ? Math.round(avgResolution * 100) / 100 : 0,
    callsToday, callsThisWeek, callsThisMonth,
    transferRate: Math.round(transferRate * 100),
    bookingRate: Math.round(bookingRate * 100),
    // Conversion reporting
    conversionRate,          // % of calls that resulted in a booking or lead capture
    qualificationRate,       // % of calls where resolution_score >= 0.7
    callbacksNeeded,         // calls that need follow-up
    leadsBooked,             // total appointments booked + leads captured
    fieldsExtracted,         // total AI-extracted CRM fields across all contacts
    dataCaptureCoverage,     // % of contacts with a name captured
    contactsWithEmail,       // contacts with email on file
    contactsWithName,        // contacts with name on file
    avgFieldConfidence,      // average confidence score on extracted fields (0-100)
    sentiment: sentimentMap, // { positive: N, neutral: N, negative: N, frustrated: N }
    // Prospecting
    prospectTotalLeads, prospectCalled, prospectInterested, prospectConversionRate,
    // Compliance
    dncCount,
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
    ttsEngine: openAITTSConfig ? `OpenAI TTS (${openAITTSConfig.voice})` : elevenLabsConfig ? `ElevenLabs (${elevenLabsConfig.voiceId})` : "Polly (fallback)",
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
    await buildTwimlSay(twiml, aiText, agent?.voice || "alice");
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
  const logs = await sql`SELECT * FROM request_logs ORDER BY id DESC LIMIT 200`;
  res.json({ logs });
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

// ── // ── API: Contact detail (with calls, summaries, tasks, custom fields) ─────────────
app.get("/api/contacts/:id/detail", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid contact ID." });
  const [contactRows, calls, tasks, appointments, summaries, customFields] = await Promise.all([
    sql`SELECT * FROM contacts WHERE id = ${id}`,
    sql`
      SELECT c.*, cs.intent, cs.outcome, cs.sentiment, cs.resolution_score, cs.summary as call_summary
      FROM calls c
      LEFT JOIN call_summaries cs ON c.call_sid = cs.call_sid
      WHERE c.contact_id = ${id}
      ORDER BY c.started_at DESC LIMIT 30
    `,
    sql`SELECT * FROM tasks WHERE contact_id = ${id} ORDER BY created_at DESC`,
    sql`SELECT * FROM appointments WHERE contact_id = ${id} ORDER BY scheduled_at DESC`,
    sql`SELECT * FROM call_summaries WHERE contact_id = ${id} ORDER BY created_at DESC LIMIT 10`,
    sql`SELECT * FROM contact_custom_fields WHERE contact_id = ${id} ORDER BY field_key ASC`,
  ]);
  if (!contactRows.length) return res.status(404).json({ error: "Contact not found." });
  res.json({ contact: contactRows[0], calls, tasks, appointments, summaries, customFields });
});

// ── API: Update contact ───────────────────────────────────────────────────────────────
app.patch("/api/contacts/:id", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid contact ID." });
  const { name, email, company, notes, tags } = req.body;
  await sql`
    UPDATE contacts SET
      name = COALESCE(${name || null}, name),
      email = COALESCE(${email || null}, email),
      company = COALESCE(${company || null}, company),
      notes = COALESCE(${notes || null}, notes),
      tags = COALESCE(${tags ? sql.json(tags) : null}, tags)
    WHERE id = ${id}
  `;
  res.json({ success: true });
});

// ── API: Upsert contact custom field ──────────────────────────────────────────────
app.put("/api/contacts/:id/fields", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid contact ID." });
  const fields = req.body as Record<string, string>;
  for (const [key, value] of Object.entries(fields)) {
    await sql`
      INSERT INTO contact_custom_fields (contact_id, field_key, field_value, source, updated_at)
      VALUES (${id}, ${key}, ${value}, 'manual', NOW())
      ON CONFLICT (contact_id, field_key) DO UPDATE
      SET field_value = EXCLUDED.field_value, source = 'manual', updated_at = NOW()
    `;
  }
  res.json({ success: true });
});

// ── API: Call transcript ───────────────────────────────────────────────────────────────
app.get("/api/calls/:sid/transcript", async (req: Request, res: Response) => {
  const { sid } = req.params;
  const messages = await sql`
    SELECT role, text, created_at FROM messages
    WHERE call_sid = ${sid} AND role IN ('user', 'assistant')
    ORDER BY id ASC
  `;
  const lines = messages.map((m: any) => ({
    speaker: m.role === 'user' ? 'Caller' : 'Agent',
    text: m.text,
    time: m.created_at,
  }));
  res.json({ callSid: sid, transcript: lines });
});

// ── API: Outbound webhook management ───────────────────────────────────────────────
app.get("/api/integrations/webhook", dashboardAuth, (_req: Request, res: Response) => {
  const config = loadWebhookConfig();
  res.json({
    configured: !!config,
    url: config?.url ? config.url.replace(/(?<=.{8}).(?=.{4})/g, '•') : null,
    events: config?.events || [],
    retryCount: config?.retryCount || 3,
    hasSecret: !!config?.secret,
  });
});

app.post("/api/integrations/webhook/test", dashboardAuth, async (req: Request, res: Response) => {
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

app.get("/api/integrations/webhook/deliveries", dashboardAuth, async (_req: Request, res: Response) => {
  const rows = await sql`
    SELECT wd.*, c.from_number, c.to_number
    FROM webhook_deliveries wd
    LEFT JOIN calls c ON wd.call_sid = c.call_sid
    ORDER BY wd.created_at DESC LIMIT 50
  `;
  res.json(rows);
});

// ── API: Field definitions (custom fields schema) ─────────────────────────────────
app.get("/api/field-definitions", dashboardAuth, async (_req: Request, res: Response) => {
  const fields = await sql`SELECT * FROM field_definitions ORDER BY sort_order ASC, label ASC`;
  res.json(fields);
});

app.post("/api/field-definitions", dashboardAuth, async (req: Request, res: Response) => {
  const { field_key, label, field_type, description, required, capture_via } = req.body;
  if (!field_key || !label) return res.status(400).json({ error: "field_key and label are required." });
  await sql`
    INSERT INTO field_definitions (field_key, label, field_type, description, required, capture_via)
    VALUES (${field_key}, ${label}, ${field_type || 'text'}, ${description || null}, ${required || false}, ${capture_via || 'ai'})
    ON CONFLICT (field_key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description
  `;
  res.json({ success: true });
});

app.delete("/api/field-definitions/:key", dashboardAuth, async (req: Request, res: Response) => {
  await sql`DELETE FROM field_definitions WHERE field_key = ${req.params.key}`;
  res.json({ success: true });
});

// ── API: CRM Integrations ───────────────────────────────────────────────────────────────
app.get("/api/integrations/crm", dashboardAuth, (_req: Request, res: Response) => {
  res.json({
    hubspot: { configured: isHubSpotConfigured(), name: "HubSpot" },
    salesforce: { configured: isSalesforceConfigured(), name: "Salesforce" },
    airtable: { configured: isAirtableConfigured(), name: "Airtable" },
    notion: { configured: isNotionConfigured(), name: "Notion" },
    active: getConfiguredCrms(),
  });
});

app.post("/api/integrations/crm/test", dashboardAuth, async (req: Request, res: Response) => {
  const { platform } = req.body;
  const testContact = { phone: "+15550000000", name: "SMIRK Test", email: "test@smirk.ai", company: "SMIRK AI" };
  const testLog = { callSid: "test_"+Date.now(), duration: 60, summary: "Test call from SMIRK dashboard.", outcome: "test", sentiment: "neutral", calledAt: new Date().toISOString(), agentName: "SMIRK" };
  try {
    let result: any;
    if (platform === "hubspot") { const { hubspotUpsertContact } = await import("./src/crm.js"); result = await hubspotUpsertContact(testContact); }
    else if (platform === "salesforce") { const { salesforceUpsertContact } = await import("./src/crm.js"); result = await salesforceUpsertContact(testContact); }
    else if (platform === "airtable") { const { airtableUpsertContact } = await import("./src/crm.js"); result = await airtableUpsertContact(testContact); }
    else if (platform === "notion") { const { notionUpsertContact } = await import("./src/crm.js"); result = await notionUpsertContact(testContact); }
    else return res.status(400).json({ error: "Unknown platform" });
    res.json(result);
  } catch (err: any) { res.json({ success: false, error: err.message }); }
});

// ── API: Plugin Tools ──────────────────────────────────────────────────────────────────
app.get("/api/tools", dashboardAuth, async (_req: Request, res: Response) => {
  const tools = await getAllPluginTools();
  res.json({ tools, examples: EXAMPLE_TOOLS });
});

app.post("/api/tools", dashboardAuth, async (req: Request, res: Response) => {
  try {
    const tool = await createPluginTool(req.body);
    res.json(tool);
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

app.put("/api/tools/:id", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  const updated = await updatePluginTool(id, req.body);
  res.json(updated || { error: "Not found" });
});

app.delete("/api/tools/:id", dashboardAuth, async (req: Request, res: Response) => {
  await deletePluginTool(parseInt(req.params.id));
  res.json({ success: true });
});

app.post("/api/tools/:id/test", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  const result = await testPluginTool(id, req.body || {});
  res.json(result);
});

// ── API: MCP Servers ───────────────────────────────────────────────────────────────────
app.get("/api/mcp", dashboardAuth, async (_req: Request, res: Response) => {
  const servers = await getMcpServers();
  res.json({ servers, popular: POPULAR_MCP_SERVERS });
});

app.post("/api/mcp", dashboardAuth, async (req: Request, res: Response) => {
  try {
    const server = await createMcpServer(req.body);
    res.json(server);
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

app.put("/api/mcp/:id", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  await updateMcpServer(id, req.body);
  res.json({ success: true });
});

app.delete("/api/mcp/:id", dashboardAuth, async (req: Request, res: Response) => {
  await deleteMcpServer(parseInt(req.params.id));
  res.json({ success: true });
});

app.post("/api/mcp/:id/test", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  const result = await testMcpServer(id);
  res.json(result);
});

// ── API: SaaS Workspaces ─────────────────────────────────────────────────────
app.get("/api/workspaces", dashboardAuth, async (_req: Request, res: Response) => {
  const workspaces = await getWorkspaces();
  // Mask sensitive keys
  const masked = workspaces.map((w: any) => ({ ...w, twilio_auth_token: w.twilio_auth_token ? "***" : null, openrouter_api_key: w.openrouter_api_key ? "***" : null, elevenlabs_api_key: w.elevenlabs_api_key ? "***" : null }));
  res.json({ workspaces: masked, plans: PLAN_LIMITS });
});

app.post("/api/workspaces", dashboardAuth, async (req: Request, res: Response) => {
  const { name, owner_email, plan } = req.body;
  if (!name || !owner_email) return res.status(400).json({ error: "name and owner_email required" });
  const workspace = await createWorkspace({ name, owner_email, plan });
  res.json({ workspace });
});

app.get("/api/workspaces/:id", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  const workspace = await getWorkspaceById(id);
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });
  const stats = await getWorkspaceStats(id);
  const members = await getWorkspaceMembers(id);
  res.json({ workspace, stats, members });
});

app.patch("/api/workspaces/:id", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  await updateWorkspace(id, req.body);
  res.json({ success: true });
});

app.delete("/api/workspaces/:id", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  await deleteWorkspace(id);
  res.json({ success: true });
});

app.post("/api/workspaces/:id/invite", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { email, role } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });
  const member = await inviteMember(id, email, role || "viewer");
  res.json({ member, invite_link: `${getAppUrl()}/invite/${member.invite_token}` });
});

app.delete("/api/workspaces/:id/members/:email", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  await removeMember(id, decodeURIComponent(req.params.email));
  res.json({ success: true });
});

app.get("/api/workspaces/:id/usage", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const limits = await checkUsageLimits(id);
  res.json(limits);
});

// Stripe webhook for billing events
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req: Request, res: Response) => {
  try {
    const event = JSON.parse(req.body.toString());
    await handleStripeWebhook(event);
    res.json({ received: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Invite acceptance
app.get("/api/invite/:token", async (req: Request, res: Response) => {
  const member = await acceptInvite(req.params.token);
  if (!member) return res.status(404).json({ error: "Invalid or expired invite" });
  res.json({ success: true, member });
});

// ── API: Prospecting Campaigns ────────────────────────────────────────────────
app.get("/api/prospecting/campaigns", dashboardAuth, async (_req: Request, res: Response) => {
  const campaigns = await getCampaigns();
  res.json({ campaigns });
});

app.post("/api/prospecting/campaigns", dashboardAuth, async (req: Request, res: Response) => {
  const campaign = await createCampaign(req.body);
  res.json({ campaign });
});

app.get("/api/prospecting/campaigns/:id", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  const campaign = await getCampaignById(id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  const leads = await getLeads(id);
  res.json({ campaign, leads });
});

app.patch("/api/prospecting/campaigns/:id/status", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { status } = req.body;
  await updateCampaignStatus(id, status);
  res.json({ success: true });
});

app.get("/api/prospecting/leads", dashboardAuth, async (req: Request, res: Response) => {
  const campaignId = req.query.campaign_id ? parseInt(req.query.campaign_id as string) : undefined;
  const status = req.query.status as string | undefined;
  const leads = await getLeads(campaignId, status);
  res.json({ leads });
});

app.post("/api/prospecting/campaigns/:id/leads", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  const { leads, csv } = req.body;
  let parsedLeads: any[] = leads || [];
  if (csv) parsedLeads = [...parsedLeads, ...parseLeadsCsv(csv)];
  const added = await addLeads(id, parsedLeads);
  res.json({ added });
});

app.post("/api/prospecting/campaigns/:id/search", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  const { query, location, radius, maxResults } = req.body;
  if (!query) return res.status(400).json({ error: "query required (e.g. 'plumbers in Miami FL')" });
  try {
    const found = await findBusinessesViaPlaces({ query, location, radius, maxResults });
    const added = await addLeads(id, found);
    res.json({ found: found.length, added, leads: found });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/prospecting/leads/:id", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { status, call_sid, notes } = req.body;
  await updateLeadStatus(id, status, call_sid, notes);
  res.json({ success: true });
});

// Launch a campaign — dial the next lead immediately
app.post("/api/prospecting/campaigns/:id/dial-next", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

  const twilioClient = getTwilioClient();
  if (!twilioClient) return res.status(400).json({ error: "Twilio not configured" });
  if (!env.TWILIO_PHONE_NUMBER) return res.status(400).json({ error: "TWILIO_PHONE_NUMBER not configured" });

  try {
    const result = await dialNextLead(id, twilioClient, env.TWILIO_PHONE_NUMBER, getAppUrl());
    if ("blocked" in result) {
      return res.status(403).json({ error: result.reason, blocked: true });
    }
    res.json({ success: true, call_sid: result.callSid, lead: result.lead });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Compliance / DNC API ──────────────────────────────────────────────────────
app.get("/api/compliance/dnc", dashboardAuth, async (_req: Request, res: Response) => {
  const list = await getDNCList();
  res.json({ dnc: list });
});

app.post("/api/compliance/dnc", dashboardAuth, async (req: Request, res: Response) => {
  const { phone, reason } = req.body;
  if (!phone) return res.status(400).json({ error: "phone required" });
  await addToDNC(phone, reason || "manual", "manual", "operator");
  res.json({ success: true });
});

app.delete("/api/compliance/dnc/:phone", dashboardAuth, async (req: Request, res: Response) => {
  await removeFromDNC(decodeURIComponent(req.params.phone));
  res.json({ success: true });
});

app.get("/api/compliance/audit", dashboardAuth, async (req: Request, res: Response) => {
  const limit = parseInt(String(req.query.limit)) || 100;
  const audit = await getComplianceAudit(limit);
  res.json({ audit });
});

app.post("/api/compliance/check", dashboardAuth, async (req: Request, res: Response) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "phone required" });
  const result = await checkOutboundCompliance(phone);
  res.json(result);
});

// ── API: Agent Analytics ──────────────────────────────────────────────────────────────────
app.get("/api/analytics/agents", dashboardAuth, async (_req: Request, res: Response) => {
  const rows = await sql`
    SELECT
      c.agent_name,
      COUNT(*) as total_calls,
      ROUND(AVG(cs.resolution_score) * 100)::int as avg_score,
      ROUND(AVG(c.duration_seconds))::int as avg_duration,
      COUNT(CASE WHEN cs.sentiment = 'positive' THEN 1 END) as positive_count,
      COUNT(CASE WHEN cs.outcome IN ('appointment_booked','lead_captured') THEN 1 END) as converted,
      ROUND(COUNT(CASE WHEN cs.sentiment = 'positive' THEN 1 END)::numeric / NULLIF(COUNT(*), 0) * 100)::int as positive_pct
    FROM calls c
    LEFT JOIN call_summaries cs ON c.call_sid = cs.call_sid
    WHERE c.agent_name IS NOT NULL
    GROUP BY c.agent_name
    ORDER BY total_calls DESC
  `;
  res.json({ agents: rows });
});

// ── API: Call Recording ──────────────────────────────────────────────────────────────────
app.get("/api/calls/:sid/recording", dashboardAuth, async (req: Request, res: Response) => {
  const { sid } = req.params;
  // Fetch recording from Twilio
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return res.status(503).json({ error: "Twilio not configured" });
  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings.json?CallSid=${sid}`,
      { headers: { Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64') } }
    );
    const data = await response.json() as any;
    const recordings = data.recordings || [];
    if (recordings.length === 0) return res.json({ recordings: [] });
    res.json({
      recordings: recordings.map((r: any) => ({
        sid: r.sid,
        duration: r.duration,
        url: `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${r.sid}.mp3`,
        created_at: r.date_created,
      }))
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Pricing page ──────────────────────────────────────────────────────────────────
app.get("/pricing", (_req: Request, res: Response) => {
  const plans = [
    { id: 'free',       name: 'Free Trial',  price: 0,   calls: 50,    minutes: 100,  features: ['1 agent', 'Basic CRM', 'Webhook', 'Email support'] },
    { id: 'starter',   name: 'Starter',     price: 49,  calls: 500,   minutes: 1000, features: ['3 agents', 'Full CRM', 'Zapier/Make', 'HubSpot sync', 'Priority support'] },
    { id: 'pro',       name: 'Pro',         price: 149, calls: 2000,  minutes: 4000, features: ['9 agents', 'All CRMs', 'Custom tools', 'MCP servers', 'Prospecting', 'Analytics'] },
    { id: 'enterprise',name: 'Enterprise',  price: 499, calls: 99999, minutes: 99999, features: ['Unlimited calls', 'Custom agents', 'White-label', 'SLA', 'Dedicated support'] },
  ];
  res.json({ plans });
});

// ── System Health Check (10-point smoke test) ────────────────────────────────
app.get("/api/system-health", dashboardAuth, async (_req: Request, res: Response) => {
  const checks: { id: string; label: string; status: 'pass'|'fail'|'warn'; detail: string }[] = [];
  const check = (id: string, label: string, pass: boolean, warn: boolean, detail: string) => {
    checks.push({ id, label, status: pass ? 'pass' : warn ? 'warn' : 'fail', detail });
  };

  // 1. Database connectivity
  try {
    await sql`SELECT 1`;
    check('db', 'Database', true, false, 'Postgres connection healthy');
  } catch (e: any) {
    check('db', 'Database', false, false, `DB error: ${e.message}`);
  }

  // 2. AI brain configured
  const aiOk = !!(env.OPENROUTER_API_KEY || env.GEMINI_API_KEY);
  const aiDetail = env.OPENROUTER_API_KEY ? `OpenRouter (${openRouterConfig?.model || 'default'})` : env.GEMINI_API_KEY ? 'Gemini 2.0 Flash' : 'No AI key set — add OPENROUTER_API_KEY';
  check('ai', 'AI Brain', aiOk, false, aiDetail);

  // 3. Voice engine configured
  const voiceOk = !!(env.ELEVENLABS_API_KEY || env.GOOGLE_TTS_API_KEY || env.OPENAI_API_KEY);
  const voiceDetail = env.ELEVENLABS_API_KEY ? 'ElevenLabs (primary)' : env.GOOGLE_TTS_API_KEY ? 'Google Neural2' : env.OPENAI_API_KEY ? 'OpenAI TTS' : 'Falling back to Twilio Alice — add ELEVENLABS_API_KEY for human-grade voice';
  check('voice', 'Voice Engine', voiceOk, !voiceOk, voiceDetail);

  // 4. Twilio configured
  const twilioOk = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER);
  check('twilio', 'Twilio', twilioOk, false, twilioOk ? `Phone: ${env.TWILIO_PHONE_NUMBER}` : 'Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER');

  // 5. Active agent exists
  try {
    const agentRows = await sql`SELECT name FROM agent_configs WHERE is_active = TRUE LIMIT 1`;
    check('agent', 'Active Agent', agentRows.length > 0, false, agentRows.length > 0 ? `Active: ${agentRows[0].name}` : 'No active agent — go to Agents tab and activate one');
  } catch {
    check('agent', 'Active Agent', false, false, 'Could not query agent_configs');
  }

  // 6. Calls table has data (or is empty but accessible)
  try {
    const callRows = await sql`SELECT COUNT(*) as count FROM calls`;
    const count = Number(callRows[0].count);
    check('calls', 'Call Records', true, count === 0, count === 0 ? 'No calls yet — make a test call to verify the pipeline' : `${count} call(s) recorded`);
  } catch {
    check('calls', 'Call Records', false, false, 'Could not query calls table');
  }

  // 7. Post-call intelligence (check if any summaries exist)
  try {
    const sumRows = await sql`SELECT COUNT(*) as count FROM call_summaries`;
    const count = Number(sumRows[0].count);
    check('intelligence', 'Post-Call Intelligence', aiOk, !aiOk, count === 0 ? (aiOk ? 'AI configured — summaries will appear after first call' : 'No AI key — summaries disabled') : `${count} summary(ies) generated`);
  } catch {
    check('intelligence', 'Post-Call Intelligence', false, false, 'Could not query call_summaries');
  }

  // 8. Contacts and CRM data
  try {
    const contactRows = await sql`SELECT COUNT(*) as count FROM contacts`;
    const fieldRows = await sql`SELECT COUNT(*) as count FROM contact_custom_fields`;
    const count = Number(contactRows[0].count);
    const fields = Number(fieldRows[0].count);
    check('contacts', 'Contacts & CRM', true, count === 0, count === 0 ? 'No contacts yet — they populate automatically from calls' : `${count} contact(s), ${fields} extracted field(s)`);
  } catch {
    check('contacts', 'Contacts & CRM', false, false, 'Could not query contacts');
  }

  // 9. Webhook configured
  const webhookUrl = env.WEBHOOK_URL || env.OUTBOUND_WEBHOOK_URL;
  check('webhook', 'Outbound Webhook', !!webhookUrl, !webhookUrl, webhookUrl ? `Configured: ${webhookUrl.substring(0, 40)}...` : 'No webhook URL set — add WEBHOOK_URL in Settings to push call data to Zapier/HubSpot/etc.');

  // 10. Session / auth working (if we got here, auth passed)
  check('auth', 'Dashboard Auth', true, false, 'Session valid — you are authenticated');

  const passed = checks.filter(c => c.status === 'pass').length;
  const warned = checks.filter(c => c.status === 'warn').length;
  const failed = checks.filter(c => c.status === 'fail').length;

  res.json({ checks, summary: { passed, warned, failed, total: checks.length } });
});

// ── JSON 404 for API routes ──────────────────────────────────────────────
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
  await initSaasSchema();
  await initProspectorSchema();
  await initComplianceSchema();
  log("info", "Postgres schema initialized (core + SaaS + prospector + compliance)");

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

  // Warn if APP_URL looks like a placeholder — TTS audio and Twilio callbacks will break
  const appUrl = getAppUrl();
  if (
    appUrl.includes("localhost") ||
    appUrl.includes("YOUR_") ||
    appUrl.includes("example.com") ||
    appUrl.includes("<") ||
    appUrl.includes("placeholder")
  ) {
    log("warn",
      "APP_URL looks like a placeholder or localhost — Twilio webhooks and TTS audio URLs will not work in production. " +
      "Set APP_URL to your public Railway/ngrok URL (e.g. https://smirk.up.railway.app).",
      { APP_URL: appUrl }
    );
  }

  
// ── Lead Hunter ───────────────────────────────────────────────────────────────

/** Search for leads via Apollo.io */
app.post("/api/leads/search/apollo", dashboardAuth, async (req, res) => {
  try {
    const params: LeadSearchParams = req.body;
    const leads = await searchLeadsApollo(params);
    res.json({ leads, count: leads.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Search for local business leads via Google Maps */
app.post("/api/leads/search/maps", dashboardAuth, async (req, res) => {
  try {
    const { query, location, radiusMiles, limit } = req.body;
    if (!query || !location) return res.status(400).json({ error: "query and location required" });
    const leads = await searchLeadsGoogleMaps(query, location, radiusMiles, limit);
    res.json({ leads, count: leads.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Save leads to the database */
app.post("/api/leads", dashboardAuth, async (req, res) => {
  try {
    const workspaceId = getWorkspaceId(req);
    const { leads } = req.body as { leads: Parameters<typeof saveLead>[0][] };
    const ids: number[] = [];
    for (const lead of leads) {
      const id = await saveLead(lead, workspaceId);
      ids.push(id);
    }
    res.json({ saved: ids.length, ids });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Get all leads */
app.get("/api/leads", dashboardAuth, async (req, res) => {
  try {
    const workspaceId = getWorkspaceId(req);
    const limit = parseInt(req.query.limit as string) || 100;
    const leads = await getLeads(workspaceId, limit);
    res.json({ leads });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Generate AI-personalized pitch for a lead */
app.post("/api/leads/personalize", dashboardAuth, async (req, res) => {
  try {
    const { lead, campaignContext, agentName } = req.body;
    const pitch = await generatePersonalizedPitch(lead, campaignContext, agentName || "SMIRK");
    res.json({ pitch });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Get all campaigns */
app.get("/api/campaigns", dashboardAuth, async (req, res) => {
  try {
    const workspaceId = getWorkspaceId(req);
    const campaigns = await getCampaigns(workspaceId);
    res.json({ campaigns });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Create a campaign */
app.post("/api/campaigns", dashboardAuth, async (req, res) => {
  try {
    const workspaceId = getWorkspaceId(req);
    const id = await saveCampaign(req.body, workspaceId);
    res.json({ id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Launch a campaign — dial all leads sequentially */
app.post("/api/campaigns/:id/launch", dashboardAuth, async (req, res) => {
  try {
    const workspaceId = getWorkspaceId(req);
    const campaignId = parseInt(req.params.id);
    const campaign = await db.get<{ name: string; agent_id: number; call_reason: string; pitch_template: string }>(
      "SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?", [campaignId, workspaceId]
    );
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    // Get leads for this campaign
    const leads = await db.all<{ id: number; name: string; phone: string; company: string; title: string; industry: string; location: string }>(
      "SELECT * FROM leads WHERE campaign_id = ? AND workspace_id = ? AND phone IS NOT NULL AND status = 'new'",
      [campaignId, workspaceId]
    );

    if (!leads.length) return res.status(400).json({ error: "No callable leads in this campaign" });

    // Update campaign status
    await db.run("UPDATE campaigns SET status = 'active', updated_at = datetime('now') WHERE id = ?", [campaignId]);

    // Queue calls (fire and forget — don't block response)
    res.json({ launched: true, leadsQueued: leads.length });

    // Dial leads sequentially with 30s gap between calls
    (async () => {
      for (const lead of leads) {
        if (!lead.phone) continue;
        try {
          // Generate personalized pitch
          const pitch = await generatePersonalizedPitch(
            { name: lead.name, company: lead.company, title: lead.title, industry: lead.industry, location: lead.location, source: "apollo" },
            campaign.pitch_template,
            "SMIRK"
          );

          // Make the call via Twilio
          const agent = campaign.agent_id
            ? await db.get<{ name: string }>("SELECT name FROM agent_configs WHERE id = ?", [campaign.agent_id])
            : await getActiveAgent();

          await twilioClient.calls.create({
            to: lead.phone,
            from: process.env.TWILIO_PHONE_NUMBER!,
            url: `${getAppUrl()}/api/twilio/incoming?agentId=${campaign.agent_id || ""}&reason=${encodeURIComponent(campaign.call_reason)}&notes=${encodeURIComponent(pitch)}`,
            statusCallback: `${getAppUrl()}/api/twilio/status`,
            statusCallbackMethod: "POST",
          });

          // Mark lead as contacted
          await db.run(
            "UPDATE leads SET status = 'contacted', last_contacted = datetime('now') WHERE id = ?",
            [lead.id]
          );

          // Wait 30 seconds between calls
          await new Promise(resolve => setTimeout(resolve, 30_000));
        } catch (err: any) {
          log("error", "Campaign call failed", { leadId: lead.id, error: err.message });
        }
      }
      await db.run("UPDATE campaigns SET status = 'completed', updated_at = datetime('now') WHERE id = ?", [campaignId]);
    })();
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

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
      ttsEngine: openAITTSConfig ? `OpenAI TTS (${openAITTSConfig.voice})` : elevenLabsConfig ? `ElevenLabs (${elevenLabsConfig.voiceId})` : "Polly (fallback)",
    });
  });
}

startServer().catch((err) => {
  log("error", "Failed to start server", { error: err.message });
  process.exit(1);
});
