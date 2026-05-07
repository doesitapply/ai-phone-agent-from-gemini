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
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import twilio from "twilio";
import basicAuth from "express-basic-auth";
import cors from "cors";
import { HELP_KEYWORDS, START_KEYWORDS, STOP_KEYWORDS, normalizeSmsKeyword, storeSms } from "./src/sms";
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
import { searchLeadsApollo, searchLeadsGoogleMaps, generatePersonalizedPitch, saveLead, getLeads, saveCampaign, getCampaigns as getLeadCampaigns, aiQualifyLeads, SCORE_GATE_SAVE, type LeadSearchParams, type Lead } from "./src/lead-hunter.js";
import { upsertLead, validateLeadInput, type LeadUpsertInput } from "./src/leads-upsert.js";
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
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  TWILIO_DEFAULT_AREA_CODE: z.string().optional(),
  WORKSPACE_SECRET_ENCRYPTION_KEY: z.string().optional(),
  PHONE_AGENT_API_KEY: z.string().optional(),
  PHONE_AGENT_PROVISIONING_SECRET: z.string().optional(),
  APP_URL: z.string().optional(),
  PORT: z.string().optional(),
  DASHBOARD_API_KEY: z.string().optional(),
  DASHBOARD_USER: z.string().optional(),
  DASHBOARD_PASS: z.string().optional(),
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
  // Business timezone for date/time injection
  BUSINESS_TIMEZONE: z.string().optional(),
  // Business identity fields — injected into every call's system prompt
  BUSINESS_NAME: z.string().optional(),
  BUSINESS_TAGLINE: z.string().optional(),
  BUSINESS_PHONE: z.string().optional(),
  BUSINESS_WEBSITE: z.string().optional(),
  BUSINESS_ADDRESS: z.string().optional(),
  BUSINESS_HOURS: z.string().optional(),
  AGENT_NAME: z.string().optional(),
  AGENT_PERSONA: z.string().optional(),
  // Human transfer number — where to dial when escalating to a human agent
  HUMAN_TRANSFER_NUMBER: z.string().optional(),
  // Twilio signature validation skip (set to 'true' to disable in dev)
  TWILIO_SKIP_VALIDATION: z.enum(["true", "false"]).optional(),
  WEBHOOK_URL: z.string().optional(),
  OUTBOUND_WEBHOOK_URL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  FROM_EMAIL: z.string().optional(),
  FROM_NAME: z.string().optional(),
  // Owner phone number for SMS notifications on high-value call outcomes
  OWNER_PHONE: z.string().optional(),
  // Calendly webhook signing secret (from Calendly Developer → Webhooks)
  CALENDLY_SIGNING_SECRET: z.string().optional(),
  // Calendly booking page URL for embed
  CALENDLY_URL: z.string().optional(),
});

// ── Load Identity Files (Soul & Agents) ───────────────────────────────────────
const SOUL_PATH = path.resolve(__dirname, "../SOUL.md");
if (fs.existsSync(SOUL_PATH)) {
  const soul = fs.readFileSync(SOUL_PATH, "utf8");
  if (!process.env.AGENT_PERSONA) {
    process.env.AGENT_PERSONA = soul;
    console.log("[INFO] Loaded agent persona from SOUL.md");
  }
}

const envResult = EnvSchema.safeParse(process.env);
if (!envResult.success) {
  console.error("❌ Environment validation failed:");
  envResult.error.issues.forEach((i) => console.error(`   ${i.path.join(".")}: ${i.message}`));
  process.exit(1);
}
const env = envResult.data;
const PORT = parseInt(env.PORT || "3000", 10);
const IS_PROD = env.NODE_ENV === "production";

// ── Simple API key auth for demo endpoints (landing page trigger) ─────────────
const readBearerToken = (req: Request): string => {
  const auth = String(req.headers["authorization"] || "");
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
};

const requirePhoneAgentApiKey = (req: Request, res: Response, next: NextFunction) => {
  const expected = (process.env.PHONE_AGENT_API_KEY || "").trim();
  if (!expected) return res.status(503).json({ ok: false, error: "PHONE_AGENT_API_KEY not configured" });

  const token = readBearerToken(req);
  if (!token || token !== expected) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
};

const requireProvisioningSecret = (req: Request, res: Response, next: NextFunction) => {
  const expected = (process.env.PHONE_AGENT_PROVISIONING_SECRET || "").trim();
  if (!expected) return res.status(503).json({ ok: false, error: "PHONE_AGENT_PROVISIONING_SECRET not configured" });

  const token = readBearerToken(req);
  if (!token || token !== expected) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
};

// ── Import modules (after env is loaded) ─────────────────────────────────────
import { sql, initSchema, DB_ENABLED } from "./src/db.js";
import { resolveContact, buildCallerContext, buildOutboundContext } from "./src/contacts.js";
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
import { initSaasSchema, getWorkspaces, getWorkspaceById, getWorkspaceByApiKey, createWorkspace, provisionWorkspace, updateWorkspace, deleteWorkspace, getWorkspaceMembers, inviteMember, removeMember, acceptInvite, checkUsageLimits, getWorkspaceStats, handleStripeWebhook, PLAN_LIMITS } from "./src/saas.js";
import { TwilioService } from "./src/twilio-provisioning.js";

async function getWorkspaceMode(workspaceId: number): Promise<"general" | "missed_call_recovery"> {
  try {
    const rows = await sql<{ mode: string }[]>`SELECT mode FROM workspaces WHERE id = ${workspaceId} LIMIT 1`;
    const m = (rows?.[0]?.mode || "general").toLowerCase();
    return m === "missed_call_recovery" ? "missed_call_recovery" : "general";
  } catch {
    return "general";
  }
}
import { initProspectorSchema, getCampaigns as getProspectingCampaigns, getCampaignById, createCampaign, updateCampaignStatus, getLeads as getProspectLeads, addLeads, updateLeadStatus, findBusinessesViaPlaces, buildPitchSystemPrompt, parseLeadsCsv, dialNextLead } from "./src/prospector.js";
import { initSequenceSchema, scheduleFollowUpSteps, executeDueSequenceSteps, getSequenceStats, getLeadSequenceSteps, cancelLeadSequence, DEFAULT_SEQUENCES } from "./src/sequence-engine.js";
import { initComplianceSchema, checkOutboundCompliance, nextValidWindowUTC, addToDNC, isOnDNC, getDNCList, removeFromDNC, detectOptOut, getComplianceAudit, getRecordingDisclosure } from "./src/compliance.js";
import { insertCalendarEvent, isCalendarConfigured, listCalendarEvents } from "./src/gcal.js";
import { handleSmirkChat, loadChatContext, type ChatMessage } from "./src/smirk-chat.js";
import {
  SETTINGS_GROUPS,
  getMaskedSettings,
  writeEnvFile,
  getConfigStatus,
} from "./src/settings.js";
import { registerTeamRoutes } from "./src/team-routes.js";
import { registerBossModeRoutes, getActiveTemporaryContext } from "./src/boss-mode.js";

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
// Serve pre-recorded audio assets (voicemail drops, hold music, etc.) without auth
app.use("/public", express.static(path.resolve(__dirname, "../public")));
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
// CORS
// For the GitHub Pages landing calling the Railway backend, set:
//   PAGES_ALLOWED_ORIGIN="https://artificially-educated.github.io"
// If unset, default to permissive cors() for backwards compatibility.
const PAGES_ALLOWED_ORIGIN = (process.env.PAGES_ALLOWED_ORIGIN || "").trim();
app.use(cors(PAGES_ALLOWED_ORIGIN ? {
  origin: (origin, cb) => {
    // allow server-to-server or curl (no Origin)
    if (!origin) return cb(null, true);
    if (origin === PAGES_ALLOWED_ORIGIN) return cb(null, true);
    return cb(new Error("CORS blocked"));
  },
  methods: ["POST", "GET", "OPTIONS"],
  allowedHeaders: ["content-type", "authorization"],
} : undefined));
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
const publicDemoRateLimit = rateLimit({ windowMs: 15 * 60_000, max: 8, message: { ok: false, error: "Too many demo requests. Please try again later." }, standardHeaders: true, legacyHeaders: false });
const publicHealthRateLimit = rateLimit({ windowMs: 60_000, max: 60, message: { error: "Too many health requests." }, standardHeaders: true, legacyHeaders: false });

app.use("/api/calls", apiRateLimit);
app.use("/api/agents", apiRateLimit);
app.use("/api/stats", apiRateLimit);
app.use("/api/contacts", apiRateLimit);
app.use("/api/tasks", apiRateLimit);
app.use("/api/handoffs", apiRateLimit);
app.use("/api/summaries", apiRateLimit);
app.use("/api/demo", publicDemoRateLimit);
app.use("/health", publicHealthRateLimit);
app.use("/api/system-health/public", publicHealthRateLimit);

// ── Dashboard Basic Auth (browser pop-up — simple wall for single-tenant clients) ──
if (env.DASHBOARD_USER && env.DASHBOARD_PASS) {
  const basicAuthMiddleware = basicAuth({
    users: { [env.DASHBOARD_USER]: env.DASHBOARD_PASS },
    challenge: true,
    realm: "AI Phone Agent Dashboard",
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Buyer/public surfaces must stay reachable without a browser auth popup.
    const isPublic =
      req.path.startsWith("/api/twilio") ||
      req.path === "/health" ||
      req.path === "/pricing" ||
      req.path.startsWith("/checkout/") ||
      req.path === "/api/provisioning/request" ||
      req.path === "/api/provisioning/checkout-status" ||
      req.path.startsWith("/api/demo") ||
      req.path === "/api/system-health/public";
    if (isPublic) return next();

    // If DB is disabled, many dashboard endpoints cannot function anyway.
    // Don't add auth friction during local/UI work.
    if (!DB_ENABLED) return next();

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

// Ensure the phone-number mapping table exists (minimal, safe). If DB is disabled, this is a no-op.
const ensureWorkspacePhoneNumbersTable = async (): Promise<void> => {
  if (!DB_ENABLED) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS workspace_phone_numbers (
        id           SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL,
        phone_number TEXT NOT NULL,
        twilio_sid   TEXT,
        enabled      BOOLEAN NOT NULL DEFAULT TRUE,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(phone_number)
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_workspace_phone_numbers_ws ON workspace_phone_numbers(workspace_id)`;
  } catch {
    // non-critical
  }
};

// Resolve workspace by Twilio "To" number for dedicated-number-per-customer mode.
// Returns null if no mapping exists.
const getWorkspaceIdByToNumber = async (toNumber: string): Promise<number | null> => {
  const to = String(toNumber || "").trim();
  if (!to) return null;
  try {
    const rows = await sql<{ workspace_id: number }[]>`
      SELECT workspace_id
      FROM workspace_phone_numbers
      WHERE enabled = TRUE AND phone_number = ${to}
      LIMIT 1
    `;
    const wsId = rows?.[0]?.workspace_id;
    return wsId && wsId > 0 ? wsId : null;
  } catch {
    return null;
  }
};

// ── Dashboard / Workspace Auth ────────────────────────────────────────────────
const dashboardAuth = async (req: Request, res: Response, next: NextFunction) => {
  const operatorApiKey = env.DASHBOARD_API_KEY;
  const providedApiKey = req.headers["x-api-key"] || req.query.apiKey;
  if (operatorApiKey && providedApiKey === operatorApiKey) {
    (req as any).authMode = "operator";
    return next();
  }

  const workspaceToken = readBearerToken(req);
  if (workspaceToken) {
    try {
      const workspace = await getWorkspaceByApiKey(workspaceToken);
      if (workspace) {
        (req as any).authMode = "workspace";
        (req as any).workspaceAuth = workspace;
        (req.headers as any)["x-workspace-id"] = String(workspace.id);
        return next();
      }
    } catch (err: any) {
      log("warn", "Workspace auth lookup failed", { requestId: (req as any).requestId, path: req.path, error: err?.message || String(err) });
    }
  }

  if (!operatorApiKey) return next();
  log("warn", "Unauthorized API access", { requestId: (req as any).requestId, path: req.path, ip: req.ip });
  return res.status(401).json({ error: "Unauthorized. Provide a valid X-Api-Key header or workspace Bearer token." });
};

["/api/calls", "/api/agents", "/api/stats", "/api/contacts", "/api/tasks", "/api/handoffs", "/api/summaries", "/api/logs", "/api/webhook-url"].forEach(
  (route) => app.use(route, dashboardAuth)
);

// ── Twilio Signature Validation ───────────────────────────────────────────────
const twilioValidate = (req: Request, res: Response, next: NextFunction) => {
  const authToken = env.TWILIO_AUTH_TOKEN;
  // Skip validation in dev, when no auth token configured, or when bypass is enabled
  if (!authToken || !IS_PROD) return next();
  if (process.env.TWILIO_SKIP_VALIDATION === "true") {
    log("warn", "Twilio signature validation BYPASSED (TWILIO_SKIP_VALIDATION=true)");
    return next();
  }

  const signature = req.headers["x-twilio-signature"] as string;
  if (!signature) {
    log("warn", "Missing Twilio signature header", { ip: req.ip, path: req.path });
    return res.status(403).send("Forbidden");
  }

  // Build every possible URL form Twilio might have signed
  const proto = (req.headers["x-forwarded-proto"] as string || "https").split(",")[0].trim();
  const forwardedHost = (req.headers["x-forwarded-host"] as string || "").split(",")[0].trim();
  const rawHost = req.headers["host"] || "";
  const appUrl = getAppUrl().replace(/\/$/, "");

  const candidateUrls = [
    `${proto}://${forwardedHost}${req.originalUrl}`,
    `${proto}://${rawHost}${req.originalUrl}`,
    `${appUrl}${req.originalUrl}`,
    `https://${forwardedHost}${req.originalUrl}`,
    `https://${rawHost}${req.originalUrl}`,
  ].filter((u, i, arr) => u.startsWith("https://") && arr.indexOf(u) === i); // dedupe, https only

  const isValid = candidateUrls.some(url =>
    twilio.validateRequest(authToken, signature, url, req.body)
  );

  if (!isValid) {
    log("warn", "Invalid Twilio signature — tried all URL forms", {
      candidateUrls,
      signature: signature.substring(0, 20) + "...",
      ip: req.ip,
      path: req.path,
    });
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
  voice: z.string().optional().default("Polly.Matthew-Neural"),
  language: z.string().min(2).max(10).optional().default("en-US"),
  vertical: z.string().optional().default("general"),
  role: z.string().optional().default("vertical"),
  tier: z.string().optional().default("specialist"),
  color: z.string().optional().default("#ff6b00"),
  openclaw_agent_id: z.string().max(100).optional(),
  max_turns: z.number().int().min(3).max(50).optional().default(20),
  tool_permissions: z.array(z.string()).optional().default([]),
  routing_keywords: z.array(z.string()).optional().default([]),
});

const resolveOpenClawModelForAgent = (baseModel: string | undefined | null, agentId: string): string => {
  const m = (baseModel || "").trim();
  // If you're using explicit OpenClaw models (openclaw:<agent>), keep them aligned with the chosen agent.
  if (!m) return `openclaw:${agentId}`;
  if (m.startsWith("openclaw:")) return `openclaw:${agentId}`;
  return m;
};

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

async function provisionWorkspaceTelephony(workspaceId: number, businessName: string, ownerPhone?: string | null) {
  const service = new TwilioService({ appUrl: getAppUrl() });
  const result = await service.provision({
    businessName,
    ownerPhone,
    voiceUrl: `${getAppUrl()}/api/twilio/incoming`,
  });

  if (!result.enabled || !result.phoneNumber || !result.subaccountSid) {
    return result;
  }

  await updateWorkspace(workspaceId, {
    twilio_account_sid: result.subaccountSid,
    twilio_auth_token: result.encryptedAuthToken || undefined,
    twilio_phone_number: result.phoneNumber,
  } as any);

  await sql`
    INSERT INTO workspace_phone_numbers (workspace_id, phone_number, twilio_sid, enabled)
    VALUES (${workspaceId}, ${result.phoneNumber}, ${result.phoneNumberSid || result.subaccountSid}, TRUE)
    ON CONFLICT (phone_number) DO UPDATE SET
      workspace_id = ${workspaceId},
      twilio_sid = ${result.phoneNumberSid || result.subaccountSid},
      enabled = TRUE
  `;

  return result;
}

// ── Default System Prompt: Home Services Appointment Setter ─────────────────
const HOME_SERVICES_SYSTEM_PROMPT = `You are SMIRK, a professional AI phone agent for a home services company (HVAC, plumbing, roofing, electrical, and general repairs).

Your ONE job: answer calls, collect the caller's info, and book an appointment.

CORE FLOW:
1. Greet warmly and ask what service they need.
2. Collect: name, best callback number, service type (HVAC / plumbing / roofing / electrical / other), and whether it's urgent or can wait.
3. Offer available time windows: mornings (8am-12pm), afternoons (12pm-5pm), or evenings (5pm-8pm). Pick a day within the next 7 days.
4. Confirm the booking out loud: "Great, I have you down for [day] in the [window]. Someone will call to confirm."
5. Confirm the next step clearly: booking, callback, or escalation.
6. Thank them and end the call.

TOOL USAGE:
- Use create_lead to capture caller info as soon as you have name + service type.
- Use book_appointment once you have a confirmed date + time window.
- Use set_callback if the caller wants a call back instead of locking a time now.
- Use add_note to log anything unusual or important.
- Use set_callback if they want a call back instead of booking now.
- Use escalate_to_human ONLY if: (a) the caller explicitly asks for a human, or (b) you have failed to help twice in a row. Never transfer for confusion or slow responses.

PERSONALITY:
- Friendly, efficient, and confident. No filler words.
- Never say "I cannot" — say what you CAN do.
- Never quote prices. "Our technician will discuss pricing when they arrive."
- Keep every response under 3 sentences.`;

// In-memory TTS audio store: id → Buffer (cleared after 5 min)
const ttsAudioStore = new Map<string, { buffer: Buffer; expires: number; contentType: string }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ttsAudioStore) {
    if (v.expires < now) ttsAudioStore.delete(k);
  }
}, 60_000);

// ── Async AI Response Store ────────────────────────────────────────────────────
// Stores AI responses keyed by CallSid while they are being generated.
// Pattern: /process immediately starts AI work and returns <Redirect> to /response.
// IMPORTANT: Do NOT rely on in-memory state across webhook hops in production.
// Railway/Twilio can route /process and /response to different instances.
// We persist pending TwiML in Postgres (pending_twiml) to make this replica-safe.
// The in-memory map is only an optimization for same-instance hops.
type PendingResponse = {
  twiml: string;        // Final TwiML to return to Twilio
  ready: boolean;       // True when AI generation is complete
  expires: number;      // Timestamp after which entry is stale
  resolve?: () => void; // Notify waiting poll that response is ready
};
const pendingResponses = new Map<string, PendingResponse>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingResponses) {
    if (v.expires < now) pendingResponses.delete(k);
  }
}, 30_000);

// Cross-instance-safe backing store for pending TwiML.
// In production, Twilio webhooks may land on different instances.
// The in-memory Map above will not survive that. Mirror to Postgres when DB is enabled.
const PENDING_TWIML_DB_ENABLED = DB_ENABLED;

const upsertPendingTwimlDb = async (callSid: string, ready: boolean, twiml: string, expiresMs: number) => {
  if (!PENDING_TWIML_DB_ENABLED) return;
  const expiresAt = new Date(expiresMs).toISOString();
  await sql`
    INSERT INTO pending_twiml (call_sid, ready, twiml, expires_at, updated_at)
    VALUES (${callSid}, ${ready}, ${twiml}, ${expiresAt}, NOW())
    ON CONFLICT (call_sid)
    DO UPDATE SET ready = EXCLUDED.ready, twiml = EXCLUDED.twiml, expires_at = EXCLUDED.expires_at, updated_at = NOW()
  `;
};

const getPendingTwimlDb = async (callSid: string): Promise<{ ready: boolean; twiml: string } | null> => {
  if (!PENDING_TWIML_DB_ENABLED) return null;
  const rows = await sql<{ ready: boolean; twiml: string; expires_at: any }[]>`
    SELECT ready, twiml, expires_at
    FROM pending_twiml
    WHERE call_sid = ${callSid}
    LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;
  const expiresAtMs = new Date(r.expires_at).getTime();
  if (Number.isFinite(expiresAtMs) && expiresAtMs < Date.now()) {
    try { await sql`DELETE FROM pending_twiml WHERE call_sid = ${callSid}`; } catch {}
    return null;
  }
  return { ready: r.ready, twiml: r.twiml };
};

const deletePendingTwimlDb = async (callSid: string) => {
  if (!PENDING_TWIML_DB_ENABLED) return;
  await sql`DELETE FROM pending_twiml WHERE call_sid = ${callSid}`;
};

const touchPendingTwimlDbExpiry = async (callSid: string, expiresMs: number) => {
  if (!PENDING_TWIML_DB_ENABLED) return;
  const expiresAt = new Date(expiresMs).toISOString();
  await sql`UPDATE pending_twiml SET expires_at = ${expiresAt}, updated_at = NOW() WHERE call_sid = ${callSid}`;
};

/**
 * Build TwiML speech output.
 * Priority: 1) Cartesia → 2) ElevenLabs → 3) Google → 4) OpenAI → fallback Twilio Polly Neural.
 *
 * NOTE: We intentionally accept any TwiML node that supports .play()/.say(),
 * including <Response> and <Gather>. This allows barge-in friendly prompts by
 * placing audio inside <Gather>.
 */
const buildTwimlSay = async (
  node: { play: (url: string) => any; say: (opts: any, text?: string) => any },
  text: string,
  _voice: string,
  agentName?: string
): Promise<void> => {
  // 0. Cartesia Sonic — fastest (40ms), most human-sounding
  if (cartesiaConfig) {
    try {
      const buffer = await generateCartesiaSpeech(text, cartesiaConfig, agentName);
      if (buffer) {
        const id = uuidv4();
        ttsAudioStore.set(id, { buffer, expires: Date.now() + 5 * 60_000, contentType: "audio/basic" });
        const appUrl = getAppUrl();
        node.play(`${appUrl}/api/tts/${id}`);
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
        node.play(`${appUrl}/api/tts/${id}`);
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
        node.play(`${appUrl}/api/tts/${id}`);
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
        node.play(`${appUrl}/api/tts/${id}`);
        return;
      }
    } catch (err: any) {
      log("warn", "OpenAI TTS failed — no more TTS options", { error: err.message });
    }
  }
  // No TTS configured — use Twilio Polly Neural (sounds like a real human)
  // Polly.Matthew-Neural: natural American male, far better than Alice
  node.say({ voice: "Polly.Matthew-Neural" as any }, text);
};

// ── Active Call Kill Timers (15-min watchdog) ────────────────────────────────
const activeCallTimers = new Map<string, ReturnType<typeof setTimeout>>();

const TERMINAL_CALL_STATUSES = new Set(["completed", "failed", "busy", "no-answer", "canceled"]);
const STALE_CALL_MAX_AGE_MS = 20 * 60 * 1000;

const finalizeCallBySid = async (
  callSid: string,
  status: string,
  durationSeconds?: number | null,
): Promise<{ finalized: boolean; status: string }> => {
  if (!TERMINAL_CALL_STATUSES.has(status)) {
    await sql`UPDATE calls SET status = ${status} WHERE call_sid = ${callSid}`;
    return { finalized: false, status };
  }

  const rows = await sql<{ call_sid: string; status: string }[]>`
    UPDATE calls
    SET status = ${status},
        ended_at = COALESCE(ended_at, NOW()),
        duration_seconds = COALESCE(${durationSeconds ?? null}, duration_seconds)
    WHERE call_sid = ${callSid}
      AND ended_at IS NULL
    RETURNING call_sid, status
  `;

  return { finalized: rows.length > 0, status: rows[0]?.status || status };
};

const fixStaleCalls = async (): Promise<{ scanned: number; fixed: number; callSids: string[]; durationMs: number }> => {
  const startedAt = Date.now();
  const staleRows = await sql<{ call_sid: string }[]>`
    SELECT call_sid
    FROM calls
    WHERE ended_at IS NULL
      AND status IN ('initiated', 'ringing', 'answered', 'in-progress')
      AND started_at < NOW() - (${STALE_CALL_MAX_AGE_MS} * INTERVAL '1 millisecond')
  `;

  const callSids = staleRows.map((r) => r.call_sid);
  if (!callSids.length) {
    return { scanned: 0, fixed: 0, callSids: [], durationMs: Date.now() - startedAt };
  }

  const fixedRows = await sql<{ call_sid: string }[]>`
    UPDATE calls
    SET status = 'failed',
        ended_at = COALESCE(ended_at, NOW())
    WHERE call_sid = ANY(${callSids})
      AND ended_at IS NULL
    RETURNING call_sid
  `;

  for (const row of fixedRows) {
    const timer = activeCallTimers.get(row.call_sid);
    if (timer) { clearTimeout(timer); activeCallTimers.delete(row.call_sid); }
    logEvent(row.call_sid, "CALL_ENDED", { status: "failed", source: "stale-watchdog" });
  }

  return {
    scanned: callSids.length,
    fixed: fixedRows.length,
    callSids: fixedRows.map((r) => r.call_sid),
    durationMs: Date.now() - startedAt,
  };
};

setInterval(() => {
  const runStartedAt = Date.now();
  fixStaleCalls()
    .then(({ scanned, fixed, callSids, durationMs }) => {
      log("info", "Stale-call watchdog run", {
        scanned,
        fixed,
        callSids,
        durationMs,
        totalDurationMs: Date.now() - runStartedAt,
      });
    })
    .catch((err: any) => {
      log("warn", "Stale-call watchdog failed", { error: err.message, durationMs: Date.now() - runStartedAt });
    });
}, 60_000);

// ── Callback Executor ─────────────────────────────────────────────────────────
// Runs every 60s. Finds open callback tasks whose due_at has passed and fires
// an outbound Twilio call. Marks the task as in_progress to prevent double-fire.
const executeScheduledCallbacks = async (): Promise<void> => {
  if (!DB_ENABLED) return;
  const twilioClient = getTwilioClient();
  if (!twilioClient || !env.TWILIO_PHONE_NUMBER) return;
  try {
    const dueTasks = await sql<{
      id: number;
      contact_id: number;
      phone_number: string | null;
      notes: string | null;
      call_sid: string | null;
    }[]>`
      SELECT t.id, t.contact_id, t.phone_number, t.notes, t.call_sid
      FROM tasks t
      WHERE t.task_type = 'callback'
        AND t.status = 'open'
        AND t.callback_fired_at IS NULL
        AND t.due_at IS NOT NULL
        AND t.due_at <= NOW()
      ORDER BY t.due_at ASC
      LIMIT 10
    `;
    for (const task of dueTasks) {
      // Resolve phone number: task.phone_number → contact.phone_number
      let phone = task.phone_number;
      if (!phone && task.contact_id) {
        const rows = await sql<{ phone_number: string }[]>`SELECT phone_number FROM contacts WHERE id = ${task.contact_id} LIMIT 1`;
        phone = rows[0]?.phone_number || null;
      }
      if (!phone) {
        log("warn", "Callback executor: no phone number for task", { taskId: task.id });
        await sql`UPDATE tasks SET status = 'failed', notes = COALESCE(notes, '') || ' [no phone number]' WHERE id = ${task.id}`;
        continue;
      }
      // Check DNC
      const { isOnDNC } = await import("./src/compliance.js");
      if (await isOnDNC(phone)) {
        log("info", "Callback executor: DNC skip", { taskId: task.id, phone });
        await sql`UPDATE tasks SET status = 'skipped', callback_fired_at = NOW(), notes = COALESCE(notes, '') || ' [DNC]' WHERE id = ${task.id}`;
        continue;
      }
      // Mark fired immediately to prevent double-fire across instances
      const updated = await sql`
        UPDATE tasks SET callback_fired_at = NOW(), status = 'in_progress'
        WHERE id = ${task.id} AND callback_fired_at IS NULL
        RETURNING id
      `;
      if (!updated.length) continue; // Another instance beat us to it
      try {
        const agent = await getActiveAgent();
        const agentId = agent?.id;
        const appUrl = getAppUrl();
        const call = await twilioClient.calls.create({
          to: phone,
          from: env.TWILIO_PHONE_NUMBER,
          url: `${appUrl}/api/twilio/incoming${agentId ? `?agentId=${agentId}` : ""}&reason=${encodeURIComponent(task.notes || "callback")}&notes=${encodeURIComponent("Scheduled callback")}`,
          statusCallback: `${appUrl}/api/twilio/status`,
          statusCallbackMethod: "POST",
          statusCallbackEvent: ["completed", "failed", "no-answer", "busy", "canceled"],
          machineDetection: "Enable",
          machineDetectionTimeout: 30,
        });
        await sql`UPDATE tasks SET callback_call_sid = ${call.sid}, status = 'in_progress' WHERE id = ${task.id}`;
        log("info", "Callback executor: call placed", { taskId: task.id, phone, callSid: call.sid });
      } catch (callErr: any) {
        log("error", "Callback executor: Twilio call failed", { taskId: task.id, error: callErr.message });
        await sql`UPDATE tasks SET status = 'open', callback_fired_at = NULL WHERE id = ${task.id}`;
      }
    }
  } catch (err: any) {
    log("warn", "Callback executor run failed", { error: err.message });
  }
};

setInterval(() => {
  executeScheduledCallbacks().catch((err: any) => {
    log("warn", "Callback executor interval error", { error: err.message });
  });
}, 60_000);

// ── Appointment Confirmation Job ──────────────────────────────────────────────
// Runs every 5 minutes. Finds appointments scheduled 20–26 hours from now
// that haven't been confirmation-called yet. Places an outbound call using
// the ECHO agent to confirm the appointment.
const executeAppointmentConfirmations = async () => {
  if (!DB_ENABLED || !getTwilioClient() || !env.TWILIO_PHONE_NUMBER) return;
  try {
    const now = new Date();
    const windowStart = new Date(now.getTime() + 20 * 60 * 60 * 1000); // 20h from now
    const windowEnd   = new Date(now.getTime() + 26 * 60 * 60 * 1000); // 26h from now
    const appts = await sql<{
      id: number; contact_id: number; service_type: string;
      scheduled_at: string; phone_number: string | null;
    }[]>`
      SELECT a.id, a.contact_id, a.service_type, a.scheduled_at, c.phone_number
      FROM appointments a
      JOIN contacts c ON c.id = a.contact_id
      WHERE a.status = 'scheduled'
        AND a.confirmation_called_at IS NULL
        AND a.scheduled_at >= ${windowStart.toISOString()}
        AND a.scheduled_at <= ${windowEnd.toISOString()}
      LIMIT 10
    `;
    for (const appt of appts) {
      const phone = appt.phone_number?.trim();
      if (!phone) { log("warn", "Appt confirm: no phone for contact", { apptId: appt.id }); continue; }
      // DNC check
      if (await isOnDNC(phone)) { log("info", "Appt confirm: DNC skip", { apptId: appt.id, phone }); continue; }
      // Mark immediately to prevent double-dial
      await sql`UPDATE appointments SET confirmation_called_at = NOW() WHERE id = ${appt.id}`;
      try {
        const apptTime = new Date(appt.scheduled_at).toLocaleString("en-US", {
          weekday: "long", month: "long", day: "numeric",
          hour: "numeric", minute: "2-digit", timeZoneName: "short"
        });
        const twimlUrl = `${getAppUrl()}/api/twiml/appointment-confirm?apptId=${appt.id}&service=${encodeURIComponent(appt.service_type)}&time=${encodeURIComponent(apptTime)}`;
        const call = await getTwilioClient()!.calls.create({
          to: phone,
          from: env.TWILIO_PHONE_NUMBER!,
          url: twimlUrl,
          statusCallback: `${getAppUrl()}/api/twilio/status`,
          statusCallbackMethod: "POST",
          machineDetection: "Enable",
        });
        await sql`UPDATE appointments SET confirmation_call_sid = ${call.sid} WHERE id = ${appt.id}`;
        log("info", "Appt confirm: call placed", { apptId: appt.id, phone, callSid: call.sid });
      } catch (callErr: any) {
        // Reset so it retries next cycle
        await sql`UPDATE appointments SET confirmation_called_at = NULL WHERE id = ${appt.id}`;
        log("error", "Appt confirm: Twilio call failed", { apptId: appt.id, error: callErr.message });
      }
    }
  } catch (err: any) {
    log("warn", "Appointment confirmation job failed", { error: err.message });
  }
};
setInterval(() => {
  executeAppointmentConfirmations().catch((err: any) => {
    log("warn", "Appointment confirmation interval error", { error: err.message });
  });
}, 5 * 60_000); // every 5 minutes

// ── Sequence Engine: execute due follow-up steps every 60 seconds ─────────────
setInterval(() => {
  if (!DB_ENABLED) return;
  const twilioClient = getTwilioClient();
  const fromNumber = env.TWILIO_PHONE_NUMBER;
  if (!twilioClient || !fromNumber) return;
  executeDueSequenceSteps(twilioClient, fromNumber, getAppUrl()).catch((err: any) => {
    log("warn", "Sequence engine interval error", { error: err.message });
  });
}, 60_000); // every 60 seconds



// ── TwiML: Appointment confirmation call script ───────────────────────────────
app.get("/api/twiml/appointment-confirm", (req: Request, res: Response) => {
  const { service, time, apptId } = req.query as Record<string, string>;
  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    numDigits: 1,
    action: `/api/twiml/appointment-confirm-response?apptId=${apptId || ""}`,
    method: "POST",
    timeout: 8,
  });
  gather.say(
    { voice: "Polly.Joanna" },
    `Hi, this is SMIRK calling to confirm your upcoming ${service || "appointment"} scheduled for ${time || "tomorrow"}. ` +
    `Press 1 to confirm, press 2 to reschedule, or press 3 to cancel.`
  );
  twiml.say({ voice: "Polly.Joanna" }, "We didn't receive your response. We'll follow up with you shortly. Goodbye.");
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

app.post("/api/twiml/appointment-confirm-response", async (req: Request, res: Response) => {
  const { Digits } = req.body as Record<string, string>;
  const { apptId } = req.query as Record<string, string>;
  const twiml = new twilio.twiml.VoiceResponse();
  if (Digits === "1") {
    twiml.say({ voice: "Polly.Joanna" }, "Great, you're all confirmed. We look forward to seeing you. Goodbye!");
    if (apptId && DB_ENABLED) {
      await sql`UPDATE appointments SET status = 'confirmed' WHERE id = ${parseInt(apptId)}`.catch(() => {});
    }
  } else if (Digits === "2") {
    twiml.say({ voice: "Polly.Joanna" }, "No problem. Someone will reach out to find a new time that works for you. Goodbye!");
    if (apptId && DB_ENABLED) {
      await sql`UPDATE appointments SET status = 'reschedule_requested' WHERE id = ${parseInt(apptId)}`.catch(() => {});
    }
  } else if (Digits === "3") {
    twiml.say({ voice: "Polly.Joanna" }, "Understood. Your appointment has been cancelled. If you change your mind, just call us back. Goodbye!");
    if (apptId && DB_ENABLED) {
      await sql`UPDATE appointments SET status = 'cancelled' WHERE id = ${parseInt(apptId)}`.catch(() => {});
    }
  } else {
    twiml.say({ voice: "Polly.Joanna" }, "We didn't catch that. Someone will follow up with you. Goodbye!");
  }
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

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
  if (!openRouterConfig?.enabled && !openClawConfig?.enabled) {
    throw new Error("No streaming AI provider configured (OpenRouter or OpenClaw required)");
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
      ttsAudioStore.set(id, { buffer, expires: Date.now() + 5 * 60_000, contentType: "audio/mpeg" });
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
let gatewayBridge: OpenClawGatewayBridge | null = null;

// ── OpenRouter Config (loaded once at startup) ────────────────────────────────────────────
let openRouterConfig: OpenRouterConfig | null = loadOpenRouterConfig();

// ── Google Cloud TTS Config (loaded once at startup — primary voice engine) ──────────────
let googleTTSConfig: GoogleTTSConfig | null = loadGoogleTTSConfig();
// ── OpenAI TTS Config (loaded once at startup — secondary voice fallback) ───────────────────
let openAITTSConfig: OpenAITTSConfig | null = loadOpenAITTSConfig();
// ── ElevenLabs TTS Config (loaded once at startup — tertiary fallback) ───────────────────
let elevenLabsConfig: ElevenLabsConfig | null = loadElevenLabsConfig();
// ── Cartesia TTS Config (not yet configured — placeholder to prevent ReferenceError) ──────
let cartesiaConfig: CartesiaTTSConfig | null = null;
try { cartesiaConfig = loadCartesiaTTSConfig(); } catch { cartesiaConfig = null; }



// Reload all AI + TTS config (called at startup and when settings change)
const reloadOpenClawConfig = async () => {
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

  // Restart Gateway bridge if enabled
  if (gatewayBridge) {
    gatewayBridge.disconnect();
    gatewayBridge = null;
  }
  const bridgeConfig = loadGatewayBridgeConfig();
  if (bridgeConfig) {
    gatewayBridge = new OpenClawGatewayBridge(bridgeConfig, {
      onCallStart: async (event: VoiceCallEvent) => {
        const agent = await getActiveAgent();
        const { contact, isNew } = await resolveContact(event.from || "unknown");
        logEvent(event.callId, isNew ? "CALLER_NEW" : "CALLER_IDENTIFIED", {
          contactId: contact.id, phone: event.from, source: "openclaw-bridge",
        });
        
        await sql`
          INSERT INTO calls (call_sid, direction, to_number, from_number, status, agent_name, contact_id)
          VALUES (${event.callId}, 'inbound', ${event.to || ""}, ${event.from || ""}, 'in-progress', ${agent?.name || "Default Assistant"}, ${contact.id})
          ON CONFLICT (call_sid) DO UPDATE SET status = 'in-progress', contact_id = ${contact.id}
        `;
        
        logEvent(event.callId, "CALL_STARTED", { source: "openclaw-voice-call-plugin", from: event.from });
        return agent?.greeting || "Hello! I'm your AI assistant. How can I help you today?";
      },
      onTranscript: async (event: VoiceCallEvent) => {
        const agent = await getActiveAgent();
        const callRows = await sql<{ contact_id: number | null; turn_count: number }[]>`
          SELECT contact_id, turn_count FROM calls WHERE call_sid = ${event.callId}
        `;
        const callRecord = callRows[0];
        const contactId = callRecord?.contact_id || null;
        const turnCount = (callRecord?.turn_count || 0) + 1;
        await sql`UPDATE calls SET turn_count = ${turnCount} WHERE call_sid = ${event.callId}`;

        await sql`INSERT INTO messages (call_sid, role, text) VALUES (${event.callId}, 'user', ${event.transcript || ""})`;
        logEvent(event.callId, "SPEECH_RECEIVED", { text: event.transcript?.slice(0, 100), turn: turnCount });

        const contactRows = contactId ? await sql`SELECT * FROM contacts WHERE id = ${contactId}` : [];
        const contact = contactRows[0];
        const callerContext = contact ? buildCallerContext(contact as any, false) : "";
        const systemPrompt = agent?.system_prompt || "You are a helpful AI assistant on a phone call.";
        
        const dispatchCtx = {
          callSid: event.callId,
          contactId: contactId || 0,
          callerPhone: event.from || "",
          fromPhone: event.to || "",
          twilioClient: getTwilioClient(),
          appUrl: getAppUrl(),
        };

        const { text, latencyMs, source } = await generateAiResponse(
          event.callId, event.transcript!, "bridge", callerContext, systemPrompt,
          dispatchCtx, env.GEMINI_API_KEY, turnCount, event.from || ""
        );

        await sql`INSERT INTO messages (call_sid, role, text) VALUES (${event.callId}, 'assistant', ${text})`;
        logEvent(event.callId, "AI_RESPONSE_GENERATED", { latencyMs, source, turn: turnCount });

        return text;
      },
      onCallEnd: (event: VoiceCallEvent) => {
        sql`UPDATE calls SET status = 'completed', ended_at = NOW() WHERE call_sid = ${event.callId}`.catch(() => {});
        logEvent(event.callId, "CALL_ENDED", { source: "openclaw-voice-call-plugin" });
        setTimeout(async () => {
          const rows = await sql`SELECT contact_id FROM calls WHERE call_sid = ${event.callId}`;
          const endedRecord = rows[0];
          if (env.GEMINI_API_KEY) {
            runPostCallIntelligence(event.callId, (endedRecord as any)?.contact_id ?? null, env.GEMINI_API_KEY).catch((err: any) =>
              log("warn", "Post-call intelligence failed", { callId: event.callId, error: err.message })
            );
          }
        }, 1_000);
      },
    }, log);
    gatewayBridge.connect();
    log("info", "OpenClaw Gateway Bridge started", {
      gatewayUrl: bridgeConfig.gatewayUrl,
      agentId: bridgeConfig.agentId,
    });
  }
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
): Promise<{ text: string; latencyMs: number; toolsInvoked: string[]; shouldHangUp: boolean; transferPhone?: string | null; transferName?: string | null; source: "openclaw" | "gemini" }> {
  // ── OpenClaw Gateway (Primary Brain if enabled) ─────────────────────────────
  if (openClawConfig?.enabled) {
    try {
      // Load per-call OpenClaw agent selection (captured at call start).
      const callRows = await sql<{ openclaw_agent_id: string | null }[]>`
        SELECT openclaw_agent_id FROM calls WHERE call_sid = ${callSid} LIMIT 1
      `;
      const callOpenClawAgentId = callRows[0]?.openclaw_agent_id || openClawConfig.agentId || process.env.OPENCLAW_AGENT_ID || "main";
      const modelForCall = resolveOpenClawModelForAgent(openClawConfig.model, callOpenClawAgentId);

      const historyRows = await sql<{ role: string; text: string }[]>`
        SELECT role, text FROM messages WHERE call_sid = ${callSid} AND role IN ('user','assistant') ORDER BY id ASC LIMIT 10
      `;
      const history = historyRows.map((m) => ({ role: m.role as "user" | "assistant", content: m.text }));
      
      const result = await queryOpenClaw(
        openClawConfig,
        callSid,
        callerPhone,
        speechText,
        systemPrompt,
        history,
        turnCount,
        { agentId: callOpenClawAgentId, model: modelForCall }
      );
      
      logEvent(callSid, "OPENCLAW_RESPONSE", { latencyMs: result.latencyMs, agentId: callOpenClawAgentId, model: modelForCall });
      return { 
        text: result.text, 
        latencyMs: result.latencyMs, 
        toolsInvoked: [], // OpenClaw context handles tools internally for now
        shouldHangUp: false, 
        source: "openclaw" 
      };
    } catch (err: any) {
      log("warn", "OpenClaw failed — falling back", { requestId, callSid, error: err.message });
      logEvent(callSid, "OPENCLAW_FALLBACK", { error: err.message });
    }
  }


  // ── Gemini function-calling (Primary Brain — Fast & Native) ───────────────────
  if (geminiApiKey) {
    try {
      const result = await generateAiResponseWithTools(
        callSid,
        speechText,
        requestId,
        callerContext,
        systemPrompt,
        dispatchCtx,
        geminiApiKey
      );
      logEvent(callSid, "GEMINI_RESPONSE", { latencyMs: result.latencyMs, toolsInvoked: result.toolsInvoked });
      return { ...result, source: "gemini" };
    } catch (err: any) {
      log("warn", "Gemini failed — falling back to OpenRouter", { requestId, callSid, error: err.message });
      logEvent(callSid, "GEMINI_FALLBACK", { error: err.message });
    }
  }

  // ── OpenRouter — Secondary Brain (Backup/Plugin tools) ────────────────────────
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
        // Log persistent tool failures to skill_gap_log for post-call analysis
        const failedTools = Object.entries(toolFailCounts).filter(([, c]) => c >= 2);
        if (failedTools.length > 0) {
          for (const [toolName, failCount] of failedTools) {
            sql`INSERT INTO skill_gap_log (call_sid, tool_name, fail_count) VALUES (${callSid}, ${toolName}, ${failCount})`.catch(() => {});
          }
          logEvent(callSid, "SKILL_GAPS_LOGGED", { gaps: failedTools.map(([t]) => t) });
        }

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
    // ── Hard compliance gate: dialing window + DNC + timezone ─────────────────
    const normalizePhoneForBypass = (n: string) => n.replace(/\D/g, "");
    const bypassEnabled = process.env.DEV_OUTBOUND_BYPASS === "true";
    const bypassNumbers = (process.env.DEV_OUTBOUND_BYPASS_NUMBERS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(normalizePhoneForBypass);
    const isBypassNumber = bypassNumbers.includes(normalizePhoneForBypass(to));
    const shouldBypassCompliance = bypassEnabled && isBypassNumber;

    if (!shouldBypassCompliance) {
      const compliance = await checkOutboundCompliance(to);
      if (!compliance.allowed) {
        const nextWindow = compliance.nextValidWindow;
        log("warn", "Outbound call blocked by compliance gate", {
          requestId, to,
          reason: compliance.reason,
          blockedReason: compliance.blockedReason,
          nextValidWindow: nextWindow?.toISOString(),
        });
        return res.status(403).json({
          error: compliance.reason,
          blocked: true,
          blockedReason: compliance.blockedReason,
          nextValidWindow: nextWindow?.toISOString() ?? null,
          message: nextWindow
            ? `Call blocked. Next valid window opens at ${nextWindow.toISOString()} UTC.`
            : "Call blocked. Resolve timezone or DNC status before retrying.",
        });
      }
    } else {
      log("warn", "DEV outbound compliance bypass applied", { requestId, to });
    }
    // ─────────────────────────────────────────────────────────────────────────

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
      VALUES (${call.sid}, 'outbound', ${to}, ${from}, 'initiated', ${process.env.AGENT_NAME || agent?.name || "SMIRK"}, ${contact.id})
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
      const agentValue = await getActiveAgent();
      const bizName = agentValue?.name?.replace(" Agent", "") || "our office";
      // Use pre-recorded ElevenLabs MP3 — sounds human, drives higher callback rate
      const vmAudioUrl = `${getAppUrl()}/public/voicemail-drop.mp3`;
      await client.calls(CallSid).update({
        twiml: `<Response><Play>${vmAudioUrl}</Play><Hangup/></Response>`,
      });
      logEvent(CallSid, "VOICEMAIL_DROP_SENT", { bizName, answeredBy: AnsweredBy });
      log("info", "Voicemail drop sent", { callSid: CallSid, answeredBy: AnsweredBy });
    } catch (err: any) {
      log("warn", "Voicemail drop failed", { callSid: CallSid, error: err.message });
    }
  }
  res.sendStatus(200);
});
// ── TwiML Inline Delivery — for agent-initiated outbound calls ────────────────
app.get("/api/twiml/inline", (req: Request, res: Response) => {
  const xml = req.query.xml as string;
  if (!xml) return res.status(400).send("<Response><Say>No message configured.</Say></Response>");
  res.set("Content-Type", "text/xml");
  res.send(xml);
});


// ── Twilio Webhook: Call Status ───────────────────────────────────────────────
app.post("/api/twilio/status", async (req: Request, res: Response) => {
  const { CallSid, CallStatus, CallDuration } = req.body;

  const terminalResult = await finalizeCallBySid(
    CallSid,
    CallStatus,
    CallDuration ? parseInt(CallDuration, 10) : null,
  );

  const wsId = getWorkspaceId(req) || 1;
  const workspaceMode = await getWorkspaceMode(wsId);

  if (TERMINAL_CALL_STATUSES.has(CallStatus)) {
    // Clear the 15-minute kill switch timer when call ends naturally
    const timer = activeCallTimers.get(CallSid);
    if (timer) { clearTimeout(timer); activeCallTimers.delete(CallSid); }

    if (terminalResult.finalized && CallStatus === "completed") { // runs via OpenRouter or Gemini, whichever is configured
      const statusCallRows = await sql<{ contact_id: number | null; workspace_id: number | null }[]>`SELECT contact_id, workspace_id FROM calls WHERE call_sid = ${CallSid}`;
      const callRecord = statusCallRows[0];
      setImmediate(async () => {
        try {
          await runPostCallIntelligence(CallSid, callRecord?.contact_id || null, env.GEMINI_API_KEY);
          log("info", "Post-call intelligence complete", { callSid: CallSid });
          // Auto-detect opt-out phrases and add to DNC if found
          try {
            const msgRows = await sql`SELECT text FROM messages WHERE call_sid = ${CallSid} AND role = 'user' ORDER BY created_at ASC`;
            const fullTranscript = msgRows.map((m: any) => m.text).join(" ");
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
                duration: call.duration_seconds || 0,
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
        // Owner notification for high-value outcomes
        try {
          const [summaryRow] = await sql<{ outcome: string; intent: string; summary: string; extracted_entities: any }[]>`
            SELECT outcome, intent, summary, extracted_entities FROM call_summaries WHERE call_sid = ${CallSid} LIMIT 1`;
          const [ownerContactRow] = await sql<{ name: string | null; phone_number: string | null }[]>`
            SELECT name, phone_number FROM contacts WHERE id = ${callRecord?.contact_id || 0} LIMIT 1`;
          const HIGH_VALUE_OUTCOMES = ["appointment_booked", "lead_captured", "qualified_lead", "callback_needed", "escalation_requested"];
          if (summaryRow && HIGH_VALUE_OUTCOMES.includes(summaryRow.outcome)) {
            const callerLabel = ownerContactRow?.name || ownerContactRow?.phone_number || "Unknown caller";
            const outcomeLabels: Record<string, string> = {
              appointment_booked: "Appointment booked",
              lead_captured: "New lead captured",
              qualified_lead: "Qualified lead",
              callback_needed: "Callback requested",
              escalation_requested: "Escalation requested",
            };
            const notifTitle = `${outcomeLabels[summaryRow.outcome] || summaryRow.outcome} — ${callerLabel}`;
            const notifBody = [
              summaryRow.summary,
              (summaryRow.extracted_entities as any)?.service_type ? `Service: ${(summaryRow.extracted_entities as any).service_type}` : null,
              ownerContactRow?.phone_number ? `Caller phone: ${ownerContactRow.phone_number}` : null,
              `View: ${getAppUrl()}/dashboard`,
            ].filter(Boolean).join("\n");
            const webhookUrl = env.OUTBOUND_WEBHOOK_URL || env.WEBHOOK_URL;
            if (webhookUrl) {
              await fetch(webhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "owner_notification", title: notifTitle, body: notifBody, outcome: summaryRow.outcome, callSid: CallSid }),
              }).catch((e: any) => log("warn", "Owner notification webhook failed", { error: e.message }));
            }

            const workspaceIdForAlert = callRecord?.workspace_id || wsId || 1;
            const workspace = await getWorkspaceById(workspaceIdForAlert).catch(() => null);
            const ownerEmail = workspace?.owner_email || null;
            const resendKey = env.RESEND_API_KEY;
            const fromEmail = env.FROM_EMAIL;
            const fromName = env.FROM_NAME || "SMIRK";
            if (ownerEmail && resendKey && fromEmail) {
              const emailText = [
                notifTitle,
                "",
                notifBody,
                "",
                `Call SID: ${CallSid}`,
              ].join("\n");
              const emailHtml = [
                `<h2>${notifTitle}</h2>`,
                `<p>${(summaryRow.summary || "Call completed.").replace(/</g, "&lt;")}</p>`,
                (summaryRow.extracted_entities as any)?.service_type ? `<p><strong>Service:</strong> ${(summaryRow.extracted_entities as any).service_type}</p>` : "",
                ownerContactRow?.phone_number ? `<p><strong>Caller phone:</strong> ${ownerContactRow.phone_number}</p>` : "",
                `<p><a href="${getAppUrl()}/dashboard">Open dashboard</a></p>`,
                `<p style="color:#666;font-size:12px">Call SID: ${CallSid}</p>`,
              ].filter(Boolean).join("");
              await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  from: `${fromName} <${fromEmail}>`,
                  to: [ownerEmail],
                  subject: notifTitle,
                  text: emailText,
                  html: emailHtml,
                }),
              }).then(async (resp) => {
                if (!resp.ok) throw new Error(await resp.text());
              }).catch((e: any) => log("warn", "Owner email notification failed", { error: e.message, workspaceId: workspaceIdForAlert }));
            }

            const ownerPhone = env.OWNER_PHONE;
            if (ownerPhone && getTwilioClient() && env.TWILIO_PHONE_NUMBER) {
              await getTwilioClient()!.messages.create({
                to: ownerPhone,
                from: env.TWILIO_PHONE_NUMBER,
                body: `SMIRK: ${notifTitle}\n${(summaryRow.summary || "").slice(0, 120)}`,
              }).catch((e: any) => log("warn", "Owner SMS notification failed", { error: e.message }));
            }
          }
        } catch (notifErr: any) {
          log("warn", "Owner notification block failed", { error: notifErr.message });
        }
    }

    // ── Missed Call Text Back (inbound missed/abandoned) ──────────────────────
    // Twilio inbound calls often report "completed" (duration 0) rather than "no-answer".
    // We detect missed inbound calls by combining status + duration + turn_count.
    if (terminalResult.finalized && ["no-answer", "busy", "failed", "canceled", "completed"].includes(CallStatus)) {
      setImmediate(async () => {
        try {
          let missedRow: {
            direction: string;
            from_number: string;
            contact_id: number | null;
            duration_seconds: number | null;
            turn_count: number | null;
            missed_text_sent_at: string | null;
          } | undefined;

          try {
            const rows = await sql<{
              direction: string;
              from_number: string;
              contact_id: number | null;
              duration_seconds: number | null;
              turn_count: number | null;
              missed_text_sent_at: string | null;
            }[]>`
              SELECT direction, from_number, contact_id, duration_seconds, turn_count, missed_text_sent_at
              FROM calls
              WHERE call_sid = ${CallSid}
            `;
            missedRow = rows?.[0];
          } catch {
            // No-DB mode: fall back to Twilio webhook payload
            missedRow = {
              direction: "inbound",
              from_number: String(req.body?.From || ""),
              contact_id: null,
              duration_seconds: CallDuration ? parseInt(String(CallDuration), 10) : 0,
              turn_count: 0,
              missed_text_sent_at: null,
            };
          }

          // SMS disabled — text-back removed
          return;
          const modeEnabled = workspaceMode === "missed_call_recovery";
          const envEnabled = process.env.MISSED_CALL_TEXT_BACK === "true";
          if (!modeEnabled && !envEnabled) return;

          const isInbound = missedRow?.direction === "inbound";
          if (!isInbound) return;

          // Idempotency: only send once per call (DB only). In no-db mode, allow.
          if (missedRow?.missed_text_sent_at) return;

          const duration = (missedRow?.duration_seconds ?? (CallDuration ? parseInt(String(CallDuration), 10) : 0) ?? 0) || 0;
          const turns = (missedRow?.turn_count ?? 0) || 0;

          // In Missed-Call Recovery mode, bias hard toward sending fast.
          // Outside the mode, keep the conservative "abandoned" heuristic.
          const shouldSend = modeEnabled ? (turns === 0 && duration <= 30) : (turns === 0 && duration <= 5);
          if (!shouldSend) return;

          const callerNumber = missedRow?.from_number;
          if (!callerNumber) return;

          // Operator "Hot Lead" SMS (white-label pitch): send immediate summary to OPERATOR_PHONE_NUMBER
          // This is independent of the customer text-back.
          const operatorNumber = process.env.OPERATOR_PHONE_NUMBER;

          // Safety: never text DNC
          try {
            if (await isOnDNC(callerNumber)) return;
          } catch {}

          const twilioClient = getTwilioClient();
          const fromPhone = env.TWILIO_PHONE_NUMBER;
          if (!twilioClient || !fromPhone) return;

          let contactName = "there";
          if (missedRow.contact_id) {
            const [cr] = await sql<{ name: string | null }[]>`SELECT name FROM contacts WHERE id = ${missedRow.contact_id}`;
            if (cr?.name) contactName = cr.name.split(" ")[0];
          }

          // 1) Operator Hot Lead SMS (immediate)
          if (operatorNumber) {
            const operatorTemplate = process.env.MISSED_CALL_OPERATOR_TEXT_MESSAGE ||
              "HOT LEAD | {name} | {phone} | Missed call";
            const operatorBody = operatorTemplate
              .replace(/\{priority\}/g, "HOT")
              .replace(/\{job_type\}/g, "MISSED CALL")
              .replace(/\{name\}/g, contactName)
              .replace(/\{phone\}/g, callerNumber)
              .replace(/\{address\}/g, "(unknown)")
              .replace(/\{summary\}/g, `Missed inbound call. duration=${duration}s turns=${turns} status=${CallStatus}`)
              .trim();
            try {
              await twilioClient.messages.create({ body: operatorBody, to: operatorNumber, from: fromPhone });
              logEvent(CallSid, "OPERATOR_HOT_LEAD_SENT", { to: operatorNumber, fromCaller: callerNumber, durationSeconds: duration, turnCount: turns, callStatus: CallStatus });
              log("info", "Operator hot lead SMS sent", { callSid: CallSid, to: operatorNumber });
            } catch (e: any) {
              log("warn", "Operator hot lead SMS failed", { callSid: CallSid, to: operatorNumber, error: e.message });
            }
          }

          // 2) Customer text-back (optional but enabled for missed-call recovery)
          const bookingLink = process.env.BOOKING_LINK || "";
          const rawMsg = process.env.MISSED_CALL_TEXT_MESSAGE ||
            `Hey {name} — sorry we missed your call! What were you looking to book? Reply here or use this link: {booking_link}`;
          const body = rawMsg
            .replace(/\{name\}/g, contactName)
            .replace(/\{booking_link\}/g, bookingLink)
            .trim();

          await twilioClient.messages.create({ body, to: callerNumber, from: fromPhone });
          try {
            await sql`UPDATE calls SET missed_text_sent_at = NOW() WHERE call_sid = ${CallSid} AND missed_text_sent_at IS NULL`;
          } catch {}
          logEvent(CallSid, "MISSED_CALL_TEXT_BACK_SENT", { to: callerNumber, durationSeconds: duration, turnCount: turns, callStatus: CallStatus, workspaceMode });
          log("info", "Missed call text back sent", { callSid: CallSid, to: callerNumber, workspaceMode });
          if (missedRow.contact_id) {
            await sql`UPDATE contacts SET notes = COALESCE(notes, '') || ${`\n[MISSED CALL TEXT BACK ${new Date().toISOString()}] Sent: ${body}`} WHERE id = ${missedRow.contact_id}`;
          }
        } catch (err: any) {
          log("warn", "Missed call text back failed", { callSid: CallSid, error: err.message });
        }
      });
    }

    // ── Review Request SMS (after completed inbound calls) ─────────────────────
    if (terminalResult.finalized && CallStatus === "completed") {
      setImmediate(async () => {
        try {
          const reviewEnabled = false; // SMS disabled
          const reviewLink = process.env.REVIEW_LINK || "";
          const twilioClient = getTwilioClient();
          const fromPhone = env.TWILIO_PHONE_NUMBER;
          if (!reviewEnabled || !reviewLink || !twilioClient || !fromPhone) return;
          const [reviewRow] = await sql<{ direction: string; from_number: string; contact_id: number | null; duration_seconds: number | null }[]>`
            SELECT direction, from_number, contact_id, duration_seconds FROM calls WHERE call_sid = ${CallSid}
          `;
          // Only send for inbound calls with meaningful duration (> 30s) and not already sent
          if (reviewRow?.direction !== "inbound" || (reviewRow.duration_seconds || 0) < 30) return;
          if (reviewRow.contact_id) {
            const [alreadySent] = await sql<{ review_sent_at: string | null }[]>`SELECT review_sent_at FROM contacts WHERE id = ${reviewRow.contact_id}`;
            if (alreadySent?.review_sent_at) return; // already sent a review request
          }
          const delayMinutes = parseInt(process.env.REVIEW_SMS_DELAY_MINUTES || "30", 10);
          const businessName = process.env.BUSINESS_NAME || "us";
          const rawMsg = process.env.REVIEW_SMS_MESSAGE ||
            `Thanks for calling {business_name}! If you had a great experience, we'd love a quick review: {review_link} — it means the world to us!`;
          const body = rawMsg
            .replace(/\{review_link\}/g, reviewLink)
            .replace(/\{business_name\}/g, businessName)
            .trim();
          setTimeout(async () => {
            try {
              await twilioClient.messages.create({ body, to: reviewRow.from_number, from: fromPhone });
              log("info", "Review request SMS sent", { callSid: CallSid, to: reviewRow.from_number });
              if (reviewRow.contact_id) {
                await sql`UPDATE contacts SET review_sent_at = NOW() WHERE id = ${reviewRow.contact_id}`;
              }
            } catch (smsErr: any) {
              log("warn", "Review request SMS failed", { callSid: CallSid, error: smsErr.message });
            }
          }, delayMinutes * 60 * 1000);
        } catch (err: any) {
          log("warn", "Review SMS setup failed", { callSid: CallSid, error: err.message });
        }
      });
    }

    // Auto-create follow-up task for outbound calls that didn't connect
    if (terminalResult.finalized && ["no-answer", "busy", "failed"].includes(CallStatus)) {
      setImmediate(async () => {
        try {
          const [callRow] = await sql<{ contact_id: number | null; direction: string; to_number: string; agent_name: string }[]>`
            SELECT contact_id, direction, to_number, agent_name FROM calls WHERE call_sid = ${CallSid}
          `;
          if (callRow?.direction === "outbound" && callRow?.contact_id) {
            // Fetch the original call reason from stored system message
            const ctxRows = await sql<{ text: string }[]>`
              SELECT text FROM messages WHERE call_sid = ${CallSid} AND role = 'system' LIMIT 1
            `;
            const storedCtx = ctxRows[0]?.text || "";
            const reasonMatch = storedCtx.match(/\[CALL REASON\]\s*(.+)/)?.[1]?.trim();
            const taskTitle = reasonMatch
              ? `Follow up: ${reasonMatch} (${CallStatus})`
              : `Follow up outbound call to ${callRow.to_number} (${CallStatus})`;
            // Schedule retry in 4 hours
            const dueAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
            await sql`
              INSERT INTO tasks (title, description, status, priority, due_at, contact_id, call_sid, task_type, workspace_id)
              VALUES (
                ${taskTitle},
                ${`Outbound call to ${callRow.to_number} ended with status: ${CallStatus}. Original reason: ${reasonMatch || "not specified"}. Retry the call.`},
                'open',
                ${CallStatus === "no-answer" ? "medium" : "high"},
                ${dueAt},
                ${callRow.contact_id},
                ${CallSid},
                'callback',
                1
              )
            `;
            log("info", "Auto-follow-up task created for missed outbound call", { callSid: CallSid, status: CallStatus, contactId: callRow.contact_id });
          }
        } catch (err: any) {
          log("warn", "Auto-follow-up task creation failed", { callSid: CallSid, error: err.message });
        }
      });
    }

    if (terminalResult.finalized) {
      logEvent(CallSid, "CALL_ENDED", { status: CallStatus, duration: CallDuration });
    }
  }

  log("info", "Call status updated", { callSid: CallSid, status: CallStatus, finalized: terminalResult.finalized });
  res.sendStatus(200);
});
// ── Dynamic Greeting Generator ──────────────────────────────────────────────
// Generates a context-aware greeting using Gemini in parallel with DB setup work.
// Hard-capped at 2.5s — falls back to static template if LLM is slow or unavailable.
async function generateDynamicGreeting(opts: {
  contact: { name: string | null; business_name: string | null; last_summary: string | null; open_tasks_count: number };
  isNew: boolean;
  isOutbound: boolean;
  agentName: string;
  bizName: string;
  callReason?: string;
}): Promise<string | null> {
  const ai = getAi();
  if (!ai) return null;
  const { contact, isNew, isOutbound, agentName, bizName, callReason } = opts;
  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const lines: string[] = [];
  if (bizName) lines.push(`Business: ${bizName}`);
  lines.push(`Agent name: ${agentName}`);
  if (!isNew && contact.name) lines.push(`Caller name: ${contact.name}`);
  if (!isNew && contact.business_name) lines.push(`Caller's business: ${contact.business_name}`);
  if (!isNew && contact.last_summary) lines.push(`Last call summary: ${contact.last_summary.slice(0, 200)}`);
  if (!isNew && contact.open_tasks_count > 0) lines.push(`Open follow-up items: ${contact.open_tasks_count}`);
  if (isOutbound && callReason) lines.push(`Reason for this call: ${callReason}`);
  lines.push(`Time of day: ${timeOfDay}`);
  lines.push(`Call type: ${isOutbound ? "outbound (you are calling them)" : "inbound (they called you)"}`);
  lines.push(`Caller status: ${isNew ? "first-time caller" : "returning caller"}`);
  const prompt = `You are generating a phone greeting for an AI phone agent. Output ONLY the greeting — one sentence, max 25 words. Natural spoken English. No markdown, no quotes. Do not start with "Hello" or "Hi there". Use the caller's name if known. If there are open follow-up items, reference them briefly. Match tone to the agent persona.\n\n${lines.join("\n")}`;
  try {
    const result = await Promise.race([
      ai.models.generateContent({
        model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
        contents: prompt,
        config: { temperature: 0.7, maxOutputTokens: 60 },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("greeting_timeout")), 2500)),
    ]);
    const text = (result as any).text?.trim();
    if (!text || text.length < 5 || text.length > 300) return null;
    return text.replace(/^"|"$/g, "").replace(/^'|'$/g, "").trim();
  } catch (err: any) {
    log("warn", "Dynamic greeting failed — using static fallback", { error: err.message });
    return null;
  }
}

// ── Twilio Webhook: Incoming / Outbound Connectedd ─────────────────────────────
app.post("/api/twilio/incoming", async (req: Request, res: Response) => {
  try {
  const { CallSid, To, From, Direction } = req.body;
  log("info", "Incoming call webhook received", { callSid: CallSid, from: From, to: To, direction: Direction });

  // Dedicated-number per customer: route by the Twilio "To" number.
  // For outbound calls (Direction=outbound-api), Twilio sets To=destination and From=our number.
  // Workspace lookup must use our number (From on outbound, To on inbound).
  const lookupNumber = Direction === "outbound-api" ? String(From || "") : String(To || "");
  const routedWsId = await getWorkspaceIdByToNumber(lookupNumber).catch(() => null);
  if (!routedWsId) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("We're sorry, this line is not configured yet. Please try again later.");
    twiml.hangup();
    res.type("text/xml");
    return res.send(twiml.toString());
  }
  // Attach workspace id to request so downstream calls can use getWorkspaceId(req)
  (req.headers as any)["x-workspace-id"] = String(routedWsId);

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

  // Choose which OpenClaw agent should answer this call (stable across turns).
  // Priority: DB agent.openclaw_agent_id → env OPENCLAW_AGENT_ID → "main".
  const openclawAgentIdForCall = (agent as any)?.openclaw_agent_id || process.env.OPENCLAW_AGENT_ID || "main";

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
    VALUES (${CallSid}, ${Direction === "outbound-api" ? "outbound" : "inbound"}, ${To}, ${From}, 'in-progress', ${process.env.AGENT_NAME || agent?.name || "SMIRK"}, ${contact.id})
    ON CONFLICT (call_sid) DO NOTHING
  `;

  await sql`UPDATE calls SET status = 'in-progress', contact_id = ${contact.id}, openclaw_agent_id = ${openclawAgentIdForCall} WHERE call_sid = ${CallSid}`;

  // ── Context snapshot: freeze temporary_context at call start to prevent mid-call instability ──
  // Any Boss Mode briefings that expire or get rolled back AFTER this point won't affect this call.
  const snapshotCtx = await getActiveTemporaryContext(1);
  if (snapshotCtx) {
    await sql`UPDATE calls SET context_snapshot = ${snapshotCtx} WHERE call_sid = ${CallSid}`;
  }

  // Store caller context for use during the call
  // For outbound calls, build a rich mission-aware context block
  let callerContext: string;
  if (Direction === "outbound-api") {
    // Fetch the call reason/notes stored when the outbound call was initiated
    const ctxRows = await sql<{ text: string }[]>`
      SELECT text FROM messages WHERE call_sid = ${CallSid} AND role = 'system' LIMIT 1
    `;
    const storedCtx = ctxRows[0]?.text || "";
    const reasonMatch = storedCtx.match(/\[CALL REASON\]\s*(.+)/)?.[1]?.trim();
    const notesMatch = storedCtx.match(/\[OPERATOR NOTES\]\s*(.+)/)?.[1]?.trim();
    callerContext = await buildOutboundContext(contact, CallSid, reasonMatch, notesMatch);
  } else {
    callerContext = buildCallerContext(contact, isNew);
  }
  if (callerContext) {
    await sql`INSERT INTO messages (call_sid, role, text) VALUES (${CallSid}, 'system', ${`[CONTEXT]${callerContext}`}) ON CONFLICT DO NOTHING`;
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
  const agentName = process.env.AGENT_NAME || agent?.name || "SMIRK";
  log("info", "Call connected", { callSid: CallSid, direction: Direction, contactId: contact.id, isNew, agentName });

  const twiml = new twilio.twiml.VoiceResponse();
  const appUrl = getAppUrl();
  const _bizName = process.env.BUSINESS_NAME || "";
  const _agentName = process.env.AGENT_NAME || agent?.name || "SMIRK";

  // ── Static fallback greeting (used if dynamic generation is disabled or times out) ──
  const staticGreeting = (() => {
    const replaceVars = (s: string) => s
      .replaceAll("{business_name}", _bizName)
      .replaceAll("{agent_name}", _agentName);
    if (Direction === "outbound-api") {
      const tpl = process.env.OUTBOUND_GREETING || "Hi, this is {business_name}. I'm following up on your request. Is now a good time?";
      return replaceVars(tpl);
    }
    const tpl = process.env.INBOUND_GREETING || (agent?.greeting || (_bizName
      ? `Thanks for calling ${_bizName}! This is ${_agentName}, your AI assistant. How can I help you today?`
      : `Hello! This is ${_agentName}, your AI assistant. How can I help you today?`));
    return replaceVars(tpl);
  })();

  // ── Dynamic greeting: LLM-generated in parallel with DB work above ──────────
  // Kick off the LLM call now. It races against a 2.5s timeout.
  // For outbound calls, extract the call reason from the stored context.
  let outboundCallReason: string | undefined;
  if (Direction === "outbound-api") {
    const ctxForGreeting = await sql<{ text: string }[]>`
      SELECT text FROM messages WHERE call_sid = ${CallSid} AND role = 'system' LIMIT 1
    `.catch(() => []);
    outboundCallReason = ctxForGreeting[0]?.text?.match(/\[CALL REASON\]\s*(.+)/)?.[1]?.trim();
  }
  const dynamicGreeting = await generateDynamicGreeting({
    contact,
    isNew,
    isOutbound: Direction === "outbound-api",
    agentName: _agentName,
    bizName: _bizName,
    callReason: outboundCallReason,
  });
  const greeting = dynamicGreeting || staticGreeting;
  logEvent(CallSid, dynamicGreeting ? "DYNAMIC_GREETING_USED" : "STATIC_GREETING_USED", { greeting: greeting.slice(0, 80) });
  const voice = agent?.voice || "Polly.Matthew-Neural";
  const language = (agent?.language || "en-US") as any;

  // Barge-in friendly: put the prompt INSIDE <Gather> so caller speech is captured
  // even if they start talking over the greeting.
  const g: any = twiml.gather({
    input: ["speech"],
    action: `${appUrl}/api/twilio/process`,
    method: "POST",
    // smoother: give people time to finish a thought, and don't cut them off mid-sentence
    timeout: 10,
    speechTimeout: 3 as any,
    bargeIn: false as any,
    speechModel: "phone_call",
    enhanced: true,
    language,
    // help recognition for a services business
    hints: ["estimate", "quote", "appointment", "schedule", "today", "tomorrow", "emergency", "leak", "clog", "water heater", "heater", "AC"] as any,
  });
  await buildTwimlSay(g, greeting, voice, agentName);

  twiml.say("I didn't hear anything. Goodbye!");
  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
  } catch (err: any) {
    log("error", "FATAL: Incoming webhook crashed", { error: err.message, stack: err.stack });
    // Embed error in XML comment for debugging
    const errMsg = String(err.message || err).slice(0, 200);
    const errTwiml = new twilio.twiml.VoiceResponse();
    // Return error in response header for debugging
    res.setHeader('X-Debug-Error', errMsg);
    errTwiml.say({ voice: "Polly.Matthew-Neural" as any }, "Hello! I'm having a brief technical issue. Please stay on the line.");
    errTwiml.gather({ input: ["speech"], action: "/api/twilio/process", speechTimeout: 2 as any, speechModel: "phone_call", enhanced: true });
    res.type("text/xml");
    res.send(`<!-- ERROR: ${errMsg} -->${errTwiml.toString()}`);
  }
});
// Hard timeout guard so Twilio never waits forever on AI/TTS
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }).catch((e) => { clearTimeout(timer); reject(e); });
  });
}

// ── Background AI Generation (top-level function — immune to bundler scope issues) ───
async function generateAndStoreTwiml(
  callSid: string,
  speechResult: string,
  requestId: string,
  contactId: number | null,
  turnCount: number,
  voice: string,
  agentName: string,
  language: string,
  agent: any,
  appUrl: string
): Promise<void> {
  const responseTwiml = new twilio.twiml.VoiceResponse();
  try {
    // Load context
    let callerContext = "";
    if (contactId) {
      const ctxRows = await sql<{ text: string }[]>`
        SELECT text FROM messages WHERE call_sid = ${callSid} AND role = 'system' AND text LIKE '[CONTEXT]%' LIMIT 1
      `;
      callerContext = ctxRows[0]?.text?.replace("[CONTEXT]", "") || "";
    }
    const callerPhoneRows = await sql`SELECT from_number, direction, to_number FROM calls WHERE call_sid = ${callSid}`;
    const callerPhone = callerPhoneRows[0] as any;
    const callerPhoneNumber = callerPhone?.direction === "outbound" ? callerPhone?.to_number : callerPhone?.from_number || "";
    const fromPhone = env.TWILIO_PHONE_NUMBER || "";
    const twilioClient = (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) ? getTwilioClient() : null;
    const dispatchCtx = { callSid, contactId: contactId || 0, callerPhone: callerPhoneNumber, fromPhone, twilioClient, appUrl: getAppUrl() };

    const nowStr = new Date().toLocaleString("en-US", {
      timeZone: env.BUSINESS_TIMEZONE || "America/Los_Angeles",
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
    const basePrompt = agent?.system_prompt || HOME_SERVICES_SYSTEM_PROMPT;

    // ── Identity injection: prepend business/agent identity from settings ──────
    const bizName = process.env.BUSINESS_NAME || "";
    const bizTagline = process.env.BUSINESS_TAGLINE || "";
    const bizPhone = process.env.BUSINESS_PHONE || "";
    const bizWebsite = process.env.BUSINESS_WEBSITE || "";
    const bizAddress = process.env.BUSINESS_ADDRESS || "";
    const bizHours = process.env.BUSINESS_HOURS || "";
    const agentNameFromEnv = process.env.AGENT_NAME || "";
    const agentPersona = process.env.AGENT_PERSONA || "";
    const identityLines: string[] = [];
    if (bizName) identityLines.push(`You work for ${bizName}.`);
    if (bizTagline) identityLines.push(`Company specialty: ${bizTagline}`);
    if (bizHours) identityLines.push(`Business hours: ${bizHours}`);
    if (bizPhone) identityLines.push(`Business phone: ${bizPhone}`);
    if (bizWebsite) identityLines.push(`Website: ${bizWebsite}`);
    if (bizAddress) identityLines.push(`Address/Service area: ${bizAddress}`);
    if (agentNameFromEnv) identityLines.push(`Your name is ${agentNameFromEnv}.`);
    if (agentPersona) identityLines.push(`Your communication style: ${agentPersona}`);
    const identityBlock = identityLines.length > 0
      ? `=== WHO YOU ARE & WHO YOU WORK FOR ===\n${identityLines.join("\n")}\n\n`
      : "";
    const promptWithIdentity = identityBlock + basePrompt;

    // ── Boss Mode: use context SNAPSHOT frozen at call start (prevents mid-call instability) ──
    // The snapshot was captured when the call was answered and won't change during the call.
    // This prevents a rolled-back briefing from affecting an already-in-progress conversation.
    const snapshotRows = await sql<{ context_snapshot: string | null }[]>`
      SELECT context_snapshot FROM calls WHERE call_sid = ${callSid} LIMIT 1
    `;
    const tmpCtx = snapshotRows[0]?.context_snapshot || null;
    const tmpCtxBlock = tmpCtx
      ? `\n\n=== IMPORTANT TODAY (from Business Owner) ===\n${tmpCtx}\n\nYou MUST reference this information when relevant. It overrides any default responses about pricing, hours, or promotions.`
      : "";

    const systemPrompt = `${promptWithIdentity}${tmpCtxBlock}

=== CURRENT DATE & TIME ===
${nowStr}

=== IRONCLAD RULES — NEVER VIOLATE ===
1. NEVER invent pricing, discounts, or promotions UNLESS the Business Owner has provided them above in IMPORTANT TODAY.
2. NEVER speak negatively about competitors. "I can only speak to what we offer."
3. NEVER book appointments in the past. Use the current date above.
4. NEVER make up information. If unsure: "I don't have that on hand, but someone will follow up."
5. Keep all responses under 3 sentences. You are on a phone call — be concise.
6. ONLY transfer to a human if the caller explicitly asks for one, or if you have failed to help twice in a row.`;

    const historyRows = await sql<{ role: string; text: string }[]>`
      SELECT role, text FROM messages WHERE call_sid = ${callSid} AND role IN ('user','assistant') ORDER BY id ASC LIMIT 20
    `;
    const conversationHistory = historyRows.map((m) => ({ role: m.role as "user" | "assistant", content: m.text }));
    const fullSystemPrompt = `${systemPrompt}\n\nCaller context: ${callerContext || "New caller"}`;

    let aiText = "";
    let usedStreaming = false;

    // Detect if the caller is asking for a human — skip streaming, use tool-calling path
    const escalationPhrases = ["speak to a human", "talk to a person", "real person", "speak to someone", "transfer me", "connect me", "agent please", "representative"];
    const needsEscalation = escalationPhrases.some((p) => speechResult.toLowerCase().includes(p));

    // Try streaming pipeline (OpenRouter + TTS in parallel)
    if (!needsEscalation && openRouterConfig?.enabled && (googleTTSConfig || openAITTSConfig || elevenLabsConfig)) {
      try {
        const streamResult = await withTimeout(
        streamingTtsPipeline(fullSystemPrompt, conversationHistory, speechResult, agentName),
        5000,
        "streaming_tts_pipeline"
      );
        aiText = streamResult.fullText;
        usedStreaming = true;
        const appUrl2 = getAppUrl();
        if (streamResult.audioIds.length > 0) {
          for (const id of streamResult.audioIds) responseTwiml.play(`${appUrl2}/api/tts/${id}`);
        } else {
          responseTwiml.say({ voice: "Polly.Matthew-Neural" as any }, aiText);
        }
        log("info", "Streaming pipeline complete", { callSid, latencyMs: streamResult.latencyMs, chunks: streamResult.audioIds.length });
      } catch (streamErr: any) {
        log("warn", "Streaming pipeline failed, falling back", { callSid, error: streamErr.message });
        usedStreaming = false;
      }
    }

    // Non-streaming fallback (also used for escalation/tool-calling)
    if (!usedStreaming) {
      const { text, latencyMs, toolsInvoked, shouldHangUp: hangUp, transferPhone: routedPhone, transferName: routedName, source } = await generateAiResponse(
        callSid, speechResult, requestId, callerContext, systemPrompt, dispatchCtx, env.GEMINI_API_KEY, turnCount, callerPhoneNumber
      );
      aiText = text;
      logEvent(callSid, "AI_RESPONSE_GENERATED", { latencyMs, turnCount, responseLength: aiText.length, source });

      // Human transfer — use routed team member phone, fall back to HUMAN_TRANSFER_NUMBER env var
      if (hangUp && toolsInvoked.includes("escalate_to_human")) {
        const transferNumber = routedPhone || env.HUMAN_TRANSFER_NUMBER || null;
        if (transferNumber) {
          // Speak the handoff message, then bridge to the team member
          await buildTwimlSay(responseTwiml, aiText, voice, agentName);
          const dial = responseTwiml.dial({ timeout: 30, record: "record-from-answer", callerId: callerPhoneNumber || undefined });
          dial.number(transferNumber);
          await sql`INSERT INTO messages (call_sid, role, text) VALUES (${callSid}, 'assistant', ${aiText})`;
          logEvent(callSid, "CALL_TRANSFERRED", { to: transferNumber, to_name: routedName ?? "team member" });
          // Update handoff status to 'transferred'
          await sql`UPDATE handoffs SET status = 'transferred' WHERE call_sid = ${callSid} AND status = 'pending'`.catch(() => {});
          const entry = pendingResponses.get(callSid);
          if (entry) { entry.twiml = responseTwiml.toString(); entry.ready = true; entry.resolve?.(); }
          return;
        } else {
          // No transfer number available — tell caller we'll have someone call them back
          const noTransferMsg = "I wasn't able to connect you directly right now, but I've flagged this as urgent and a team member will call you back shortly. Is there anything else I can help you with in the meantime?";
          await sql`INSERT INTO messages (call_sid, role, text) VALUES (${callSid}, 'assistant', ${noTransferMsg})`;
          const g: any = responseTwiml.gather({
            input: ["speech"],
            action: `${appUrl}/api/twilio/process`,
            method: "POST",
            timeout: 8,
            speechTimeout: "auto" as any,
            bargeIn: true as any,
            speechModel: "phone_call",
            enhanced: true,
            language: language as any,
          });
          await buildTwimlSay(g, noTransferMsg, voice, agentName);
          responseTwiml.redirect({ method: "POST" }, `${appUrl}/api/twilio/process`);
          const entry = pendingResponses.get(callSid);
          if (entry) { entry.twiml = responseTwiml.toString(); entry.ready = true; entry.resolve?.(); }
          return;
        }
      }

      // If we're ending the call, speak immediately and hang up.
      // Otherwise, we speak inside <Gather> below to enable barge-in capture.
      if (hangUp) {
        await buildTwimlSay(responseTwiml, aiText, voice, agentName);
        await sql`INSERT INTO messages (call_sid, role, text) VALUES (${callSid}, 'assistant', ${aiText})`;
        responseTwiml.hangup();
        const entry = pendingResponses.get(callSid);
        const finalTwiml = responseTwiml.toString();
        if (entry) { entry.twiml = finalTwiml; entry.ready = true; entry.resolve?.(); }
        upsertPendingTwimlDb(callSid, true, finalTwiml, Date.now() + 30_000).catch(() => {/* non-critical */});
        return;
      }
    }

    await sql`INSERT INTO messages (call_sid, role, text) VALUES (${callSid}, 'assistant', ${aiText})`;
    const g: any = responseTwiml.gather({
      input: ["speech"],
      action: `${appUrl}/api/twilio/process`,
      method: "POST",
      timeout: 8,
      speechTimeout: "auto" as any,
      bargeIn: true as any,
      speechModel: "phone_call",
      enhanced: true,
      language: language as any,
    });
    // If we already emitted audio (streaming path), do not double-speak.
    if (!usedStreaming) {
      await buildTwimlSay(g, aiText, voice, agentName);
    }
    responseTwiml.redirect({ method: "POST" }, `${appUrl}/api/twilio/process`);
  } catch (error: any) {
    log("error", "AI generation failed (async)", { requestId, callSid, error: error.message });
    logEvent(callSid, "AI_ERROR", { error: error.message, turnCount });
    const g: any = responseTwiml.gather({
      input: ["speech"],
      action: `${appUrl}/api/twilio/process`,
      method: "POST",
      timeout: 8,
      speechTimeout: "auto" as any,
      bargeIn: true as any,
      speechModel: "phone_call",
      enhanced: true,
      language: language as any,
    });
    await buildTwimlSay(g, "I'm sorry, I had a brief technical issue. Could you say that again?", voice, agentName);
    responseTwiml.redirect({ method: "POST" }, `${appUrl}/api/twilio/process`);
  }
  // Signal the response endpoint
  const entry = pendingResponses.get(callSid);
  const finalTwiml = responseTwiml.toString();
  if (entry) { entry.twiml = finalTwiml; entry.ready = true; entry.resolve?.(); }
  upsertPendingTwimlDb(callSid, true, finalTwiml, Date.now() + 30_000).catch(() => {/* non-critical */});
}

// ── Twilio Webhook: Process Speech (Async Pattern) ────────────────────────────
// Step 1: Immediately respond with a <Pause>+<Redirect> to keep the call alive
//         while AI generation runs in the background (avoids Twilio's 5s timeout).
// Step 2: /api/twilio/response polls the pendingResponses map and returns TwiML.
app.post("/api/twilio/process", async (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  const { CallSid, SpeechResult, Confidence } = req.body;

  // ── Quick pre-flight checks (must complete before we respond to Twilio) ──────
  const { Digits } = req.body as any;
  const processCallRecordRows = await sql<{ contact_id: number | null; turn_count: number; agent_name: string | null }[]>`
    SELECT contact_id, turn_count, agent_name FROM calls WHERE call_sid = ${CallSid}
  `;
  const callRecord = processCallRecordRows[0];

  // DTMF escape hatch: SMS disabled — fall through to normal processing
  if (false && Digits === "1") {
    logEvent(CallSid, "RECOVERY_TEXT_BACK_SENT", { reason: "dtmf_1_fallback", turnCount: (callRecord?.turn_count || 0) + 1 });

    // Trigger the same recovery SMS as a missed call (best-effort, non-blocking)
    try {
      const callRows = await sql<{ contact_id: number | null; from_number: string | null; to_number: string | null }[]>`
        SELECT contact_id, from_number, to_number FROM calls WHERE call_sid = ${CallSid}
      `;
      const r = callRows[0];
      if (r?.contact_id) {
        const contactRows = await sql<{ phone_number: string | null; name: string | null }[]>`
          SELECT phone_number, name FROM contacts WHERE id = ${r.contact_id}
        `;
        const c = contactRows[0];
        const to = c?.phone_number;
        const from = (r?.to_number || env.TWILIO_PHONE_NUMBER || "").toString();
        if (to && from && !isOnDNC(to)) {
          const twilioClient = getTwilioClient();
          if (twilioClient) {
            const body = process.env.SMS_FOLLOWUP_TEMPLATE || "Got it. What’s the service address, and what’s going on?";
            await twilioClient.messages.create({ to, from, body });
          }
        }
      }
    } catch {
      // swallow, caller still gets clean hangup
    }

    const t = new twilio.twiml.VoiceResponse();
    t.say({ voice: "Polly.Matthew-Neural" as any }, "Got it. We'll call you back shortly.");
    t.hangup();
    res.type("text/xml");
    return res.send(t.toString());
  }
  const contactId = callRecord?.contact_id || null;
  const turnCount = (callRecord?.turn_count || 0) + 1;
  let agent = await getActiveAgent();
  if (callRecord?.agent_name && callRecord.agent_name !== agent?.name) {
    const namedRows = await sql`SELECT * FROM agent_configs WHERE name = ${callRecord.agent_name} LIMIT 1` as any[];
    if (namedRows[0]) agent = namedRows[0];
  }
  const voice = agent?.voice || "Polly.Matthew-Neural";
  const agentName = process.env.AGENT_NAME || agent?.name || "SMIRK";
  const maxTurns = agent?.max_turns || 20;
  const language = (agent?.language || "en-US") as any;
  await sql`UPDATE calls SET turn_count = ${turnCount} WHERE call_sid = ${CallSid}`;

  // Max turns watchdog
  if (turnCount > maxTurns) {
    logEvent(CallSid, "MAX_TURNS_REACHED", { turnCount, maxTurns });
    const t = new twilio.twiml.VoiceResponse();
    await buildTwimlSay(t, "We've been talking for a while. Let me have someone from our team follow up with you shortly. Have a great day!", voice, agentName);
    t.hangup();
    res.type("text/xml"); return res.send(t.toString());
  }

  logEvent(CallSid, "SPEECH_RECEIVED", { turnCount, speechLength: SpeechResult?.length || 0, confidence: Confidence });

  // Dead air — add escape hatch + longer timeouts + hard fallback to voicemail capture
  if (!SpeechResult) {
    logEvent(CallSid, "DEAD_AIR_DETECTED", { turnCount });

    // After 2 dead-air turns, stop looping. Capture a voicemail and move the lead into callback follow-up.
    if (turnCount >= 2) {
      const t = new twilio.twiml.VoiceResponse();
      const vm = process.env.VOICEMAIL_MESSAGE || "I’m having trouble hearing you. Please leave a short message after the beep with your service address and what’s going on, and our team will follow up as soon as possible.";
      t.say({ voice: "Polly.Matthew-Neural" as any }, vm);
      t.record({
        action: `${getAppUrl()}/api/twilio/voicemail`,
        method: "POST",
        maxLength: 45,
        playBeep: true,
        trim: "trim-silence" as any,
      });
      t.hangup();
      res.type("text/xml");
      return res.send(t.toString());
    }

    const t = new twilio.twiml.VoiceResponse();
    const appUrl = getAppUrl();
    const g: any = t.gather({
      input: ["speech", "dtmf"],
      action: `${appUrl}/api/twilio/process`,
      method: "POST",
      timeout: 12,
      speechTimeout: "auto" as any,
      bargeIn: true as any,
      speechModel: "phone_call",
      enhanced: true,
      language,
    });
    await buildTwimlSay(g, "Sorry, I didn't catch that. You can say it again, or press 1 to leave a voicemail for a callback.", voice, agentName);
    res.type("text/xml");
    return res.send(t.toString());
  }

  // End-of-call keyword detection
  const endKeywords = ["goodbye", "bye", "hang up", "end call", "stop", "quit", "that's all", "no more", "thank you goodbye"];
  if (endKeywords.some((kw) => SpeechResult.toLowerCase().includes(kw))) {
    await sql`INSERT INTO messages (call_sid, role, text) VALUES (${CallSid}, 'user', ${SpeechResult})`;
    await sql`INSERT INTO messages (call_sid, role, text) VALUES (${CallSid}, 'assistant', ${"Goodbye! Have a great day!"})`;
    const t = new twilio.twiml.VoiceResponse();
    await buildTwimlSay(t, "Goodbye! Have a great day!", voice, agentName);
    t.hangup();
    res.type("text/xml"); return res.send(t.toString());
  }

  // Store user message
  await sql`INSERT INTO messages (call_sid, role, text) VALUES (${CallSid}, 'user', ${SpeechResult})`;

  // ── Injected messages (OpenClaw push) — return immediately ───────────────────
  if (hasInjectedMessages(CallSid)) {
    const injected = dequeueInjectedMessages(CallSid);
    const injectedText = injected.map((m) => m.message).join(" ");
    logEvent(CallSid, "INJECTED_MESSAGE_DELIVERED", { source: injected[0]?.source, count: injected.length });
    await sql`INSERT INTO messages (call_sid, role, text) VALUES (${CallSid}, 'assistant', ${`[INJECTED] ${injectedText}`})`;
    const t = new twilio.twiml.VoiceResponse();
    const appUrl = getAppUrl();
    const g: any = t.gather({
      input: ["speech"],
      action: `${appUrl}/api/twilio/process`,
      method: "POST",
      timeout: 8,
      speechTimeout: "auto" as any,
      bargeIn: true as any,
      speechModel: "phone_call",
      enhanced: true,
      language,
    });
    await buildTwimlSay(g, injectedText, voice, agentName);
    res.type("text/xml"); return res.send(t.toString());
  }

  // ── ASYNC PATTERN: Kick off AI generation in background, return redirect ──────
  // Register a pending slot so /response knows to wait
  const pending: PendingResponse = { twiml: "", ready: false, expires: Date.now() + 30_000 };
  pendingResponses.set(CallSid, pending);
  upsertPendingTwimlDb(CallSid, false, "", pending.expires).catch(() => {/* non-critical */});

  // Immediately respond with a short pause + redirect (keeps call alive)
  const appUrl = getAppUrl();
  const holdTwiml = new twilio.twiml.VoiceResponse();
  holdTwiml.pause({ length: 1 }); // 1s silence while AI works
  holdTwiml.redirect({ method: "POST" }, `${appUrl}/api/twilio/response`);
  res.type("text/xml");
  res.send(holdTwiml.toString());

  // ── Background: call top-level function (immune to bundler scope issues) ────────────
  setImmediate(() => {
    generateAndStoreTwiml(
      CallSid as string, 
      SpeechResult as string, 
      requestId, 
      contactId, 
      turnCount,
      voice, 
      agentName, 
      String(language), 
      agent, 
      appUrl
    ).catch((err) => {
      log("error", "generateAndStoreTwiml uncaught", { callSid: CallSid, error: err.message });
      const entry = pendingResponses.get(CallSid);
      const fallbackTwiml = `<Response><Say>I'm sorry, something went wrong. Please call back.</Say><Hangup/></Response>`;
      if (entry) { entry.twiml = fallbackTwiml; entry.ready = true; entry.resolve?.(); }
      upsertPendingTwimlDb(CallSid, true, fallbackTwiml, Date.now() + 30_000).catch(() => {/* non-critical */});
    });
  });
});

// ── Twilio Webhook: Response Poller ────────────────────────────────────────────
// Twilio calls this after the <Redirect> in /process. We wait up to 25s for the
// AI to finish, then return the TwiML. If it times out, we play a brief hold message
// and redirect again to keep the call alive.
app.post("/api/twilio/response", async (req: Request, res: Response) => {
  const { CallSid } = req.body;
  const appUrl = getAppUrl();

  // Wait up to 25 seconds for the AI response to be ready
  const maxWaitMs = 25_000;
  const pollIntervalMs = 200;
  const startWait = Date.now();

  const waitForResponse = (): Promise<string | null> =>
    new Promise((resolve) => {
      const entry = pendingResponses.get(CallSid);
      if (entry?.ready) { resolve(entry.twiml); return; }

      // Attach resolver so background task can notify us immediately (same instance).
      if (entry) {
        entry.resolve = () => {
          const e = pendingResponses.get(CallSid);
          resolve(e?.twiml || null);
        };
      }

      // Poll DB as primary cross-instance-safe source of truth.
      const poll = setInterval(() => {
        const e = pendingResponses.get(CallSid);
        if (e?.ready) {
          clearInterval(poll);
          resolve(e.twiml);
          return;
        }

        getPendingTwimlDb(CallSid).then((r) => {
          if (r?.ready && r.twiml) {
            clearInterval(poll);
            resolve(r.twiml);
          }
        }).catch(() => {/* ignore */});

        if (Date.now() - startWait > maxWaitMs) {
          clearInterval(poll);
          resolve(null);
        }
      }, pollIntervalMs);
    });

  const twimlStr = await waitForResponse();
  pendingResponses.delete(CallSid);
  // Leave the DB row for a short TTL instead of deleting immediately.
  // This makes the handshake robust across retries and late-arriving polls.
  // Cleanup is handled by expires_at enforcement.

  if (twimlStr) {
    res.type("text/xml");
    return res.send(twimlStr);
  }

  // Timed out — apologize and ask caller to repeat so we get a fresh /process turn
  log("warn", "AI response timed out — asking caller to repeat", { callSid: CallSid });
  const t = new twilio.twiml.VoiceResponse();
  const g: any = t.gather({
    input: ["speech"],
    action: `${appUrl}/api/twilio/process`,
    method: "POST",
    timeout: 8,
    speechTimeout: "auto" as any,
    bargeIn: true as any,
    speechModel: "phone_call",
    enhanced: true,
  });
  g.say({ voice: "Polly.Matthew-Neural" as any }, "Sorry about that, I had a brief delay. Could you say that again?");
  t.redirect({ method: "POST" }, `${appUrl}/api/twilio/process`);
  res.type("text/xml");
  res.send(t.toString());
});

// Voicemail fallback: when Twilio speech capture fails repeatedly, record a short message and text back.
app.post("/api/twilio/voicemail", async (req: Request, res: Response) => {
  const { CallSid, RecordingUrl, RecordingDuration } = req.body as any;
  try {
    logEvent(CallSid, "RECOVERY_TEXT_BACK_SENT", { reason: "voicemail_recorded", RecordingDuration });

    // Update call record with a pointer (optional)
    try {
      await sql`UPDATE calls SET recording_url = COALESCE(recording_url, ${RecordingUrl}) WHERE call_sid = ${CallSid}`;
    } catch {
      // ignore if column not present
    }

    // SMS disabled — voicemail SMS removed
  } catch (e: any) {
    log("error", "Twilio voicemail handler failed", { CallSid, error: e?.message || String(e) });
  }

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: "Polly.Matthew-Neural" as any }, "Thanks for leaving a message. We'll call you back shortly.");
  twiml.hangup();
  res.type("text/xml");
  return res.send(twiml.toString());
});

// ── API: Dashboard Stats ────────────────────────────────────────────────────
app.get("/api/stats", dashboardAuth, async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const [totalCalls, activeCalls, totalContacts, openTasks, avgDuration, fieldsCaptured, dncCount, pendingHandoffs, todayCalls, weekCalls, bookedCalls, resolvedCalls, avgResolution] = await Promise.all([
      sql<{ count: string }[]>`SELECT COUNT(*) as count FROM calls WHERE workspace_id = ${wsId}`,
      sql<{ count: string }[]>`SELECT COUNT(*) as count FROM calls WHERE status = 'in-progress' AND workspace_id = ${wsId}`,
      sql<{ count: string }[]>`SELECT COUNT(*) as count FROM contacts WHERE workspace_id = ${wsId} AND name IS NOT NULL AND TRIM(name) != ''`,
      sql<{ count: string }[]>`SELECT COUNT(*) as count FROM tasks WHERE status = 'open' AND workspace_id = ${wsId}`,
      // Note: handoffs use 'pending', tasks use 'open'
      sql<{ avg: string }[]>`SELECT AVG(duration_seconds) as avg FROM calls WHERE status = 'completed' AND workspace_id = ${wsId}`,
      sql<{ count: string }[]>`SELECT COUNT(DISTINCT contact_id) as count FROM contact_custom_fields WHERE workspace_id = ${wsId}`,
      sql<{ count: string }[]>`SELECT COUNT(*) as count FROM contacts WHERE do_not_call = TRUE AND workspace_id = ${wsId}`,
      sql<{ count: string }[]>`SELECT COUNT(*) as count FROM handoffs WHERE status = 'pending' AND workspace_id = ${wsId}`,
      sql<{ count: string }[]>`SELECT COUNT(*) as count FROM calls WHERE started_at >= NOW() - INTERVAL '1 day' AND workspace_id = ${wsId}`,
      sql<{ count: string }[]>`SELECT COUNT(*) as count FROM calls WHERE started_at >= NOW() - INTERVAL '7 days' AND workspace_id = ${wsId}`,
      sql<{ count: string }[]>`SELECT COUNT(*) as count FROM call_summaries WHERE outcome = 'appointment_booked' AND workspace_id = ${wsId}`,
      sql<{ count: string }[]>`SELECT COUNT(*) as count FROM call_summaries WHERE outcome NOT IN ('incomplete','escalated') AND workspace_id = ${wsId}`,
      sql<{ avg: string }[]>`SELECT AVG(resolution_score) as avg FROM call_summaries WHERE workspace_id = ${wsId}`,
    ]);
    const aiLatency = [{ avg: '0' }]; // ai_latency_ms not yet tracked
    const total = Number(totalCalls[0]?.count || 0);
    const sentimentCounts = await sql<{ sentiment: string; count: string }[]>`
      SELECT cs.sentiment, COUNT(*) as count
      FROM call_summaries cs
      WHERE cs.workspace_id = ${wsId} AND cs.sentiment IS NOT NULL
      GROUP BY cs.sentiment
    `;
    const sentimentMap: Record<string, number> = {};
    for (const row of sentimentCounts) {
      sentimentMap[row.sentiment] = Number(row.count);
    }
    const booked = Number(bookedCalls[0]?.count || 0);
    const resolved = Number(resolvedCalls[0]?.count || 0);
    const contactsWithEmail = await sql<{ count: string }[]>`SELECT COUNT(*) as count FROM contacts WHERE email IS NOT NULL AND workspace_id = ${wsId}`;
    const namedContacts = await sql<{ count: string }[]>`SELECT COUNT(*) as count FROM contacts WHERE name IS NOT NULL AND workspace_id = ${wsId}`;
    const callbackTasks = await sql<{ count: string }[]>`SELECT COUNT(*) as count FROM tasks WHERE task_type = 'callback' AND status = 'open' AND workspace_id = ${wsId}`;
    res.json({
      totalCalls: total,
      activeCalls: Number(activeCalls[0]?.count || 0),
      totalContacts: Number(totalContacts[0]?.count || 0),
      contactsWithEmail: Number(contactsWithEmail[0]?.count || 0),
      namedContacts: Number(namedContacts[0]?.count || 0),
      openTasks: Number(openTasks[0]?.count || 0),
      callbackTasks: Number(callbackTasks[0]?.count || 0),
      avgCallDuration: Math.round(Number(avgDuration[0]?.avg || 0)),
      fieldsCaptured: Number(fieldsCaptured[0]?.count || 0),
      dncCount: Number(dncCount[0]?.count || 0),
      pendingHandoffs: Number(pendingHandoffs[0]?.count || 0),
      todayCalls: Number(todayCalls[0]?.count || 0),
      weekCalls: Number(weekCalls[0]?.count || 0),
      bookedCalls: booked,
      resolvedCalls: resolved,
      conversionRate: total > 0 ? Math.round((booked / total) * 100) : 0,
      qualificationRate: total > 0 ? Math.round((resolved / total) * 100) : 0,
      avgResolutionScore: Math.round(Number(avgResolution[0]?.avg || 0) * 100) / 100,
      aiLatencyMs: Math.round(Number(aiLatency[0]?.avg || 0)),
      avgDurationSeconds: Math.round(Number(avgDuration[0]?.avg || 0)),
      avgAiLatencyMs: 0,
      avgFieldConfidence: null,
      dataCaptureCoverage: total > 0 ? Math.round((Number(namedContacts[0]?.count || 0) / total) * 100) : 0,
      fieldsExtracted: Number(fieldsCaptured[0]?.count || 0),
      sentiment: {
        positive: sentimentMap['positive'] || 0,
        neutral: sentimentMap['neutral'] || 0,
        negative: sentimentMap['negative'] || 0,
        frustrated: sentimentMap['frustrated'] || 0,
      },
    });
  } catch (err: any) {
    log("error", "Stats endpoint failed", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── API: Triage bundle (Dashboard V2) ───────────────────────────────────────
// Single endpoint to summarize “everything that happened” for dispatch triage.
app.get("/api/triage", dashboardAuth, async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const limit = Math.max(20, Math.min(200, parseInt(String(req.query.limit || "80"), 10) || 80));
    const days = Math.max(1, Math.min(30, parseInt(String(req.query.days || "7"), 10) || 7));

    const [recovery, activeCalls, recentCalls, pendingSms] = await Promise.all([
      sql`
        SELECT
          c.call_sid,
          c.started_at,
          c.direction,
          c.from_number,
          c.to_number,
          c.duration_seconds,
          c.turn_count,
          c.missed_text_sent_at,
          c.recovery_windows_sent_at,
          c.recovery_call_back_started_at,
          c.recovery_closed_at,
          c.recovery_status,
          co.id as contact_id,
          co.name as contact_name,
          co.phone_number as contact_phone,
          cs.outcome,
          cs.next_action,
          cs.sentiment
        FROM calls c
        LEFT JOIN contacts co ON c.contact_id = co.id
        LEFT JOIN call_summaries cs ON c.call_sid = cs.call_sid
        WHERE c.workspace_id = ${wsId}
          AND c.started_at >= NOW() - (${days} || ' days')::interval
          AND c.direction = 'inbound'
          AND COALESCE(c.turn_count, 0) <= 1
          AND COALESCE(c.duration_seconds, 0) <= 20
          AND COALESCE(c.recovery_closed_at, NULL) IS NULL
        ORDER BY c.started_at DESC
        LIMIT 200
      `,
      sql`
        SELECT c.call_sid, c.started_at, c.direction, c.from_number, c.to_number, c.turn_count,
               co.name as contact_name, cs.outcome
        FROM calls c
        LEFT JOIN contacts co ON c.contact_id = co.id
        LEFT JOIN call_summaries cs ON c.call_sid = cs.call_sid
        WHERE c.workspace_id = ${wsId} AND c.status = 'in-progress'
        ORDER BY c.started_at DESC
        LIMIT 20
      `,
      sql`
        SELECT c.call_sid, c.started_at, c.direction, c.from_number, c.to_number, c.duration_seconds, c.turn_count,
               co.name as contact_name,
               cs.outcome, cs.summary as call_summary, cs.next_action, cs.sentiment
        FROM calls c
        LEFT JOIN contacts co ON c.contact_id = co.id
        LEFT JOIN call_summaries cs ON c.call_sid = cs.call_sid
        WHERE c.workspace_id = ${wsId}
        ORDER BY c.started_at DESC
        LIMIT ${limit}
      `,
      sql`
        SELECT s.id, s.created_at, s.direction, s.status, s.from_number, s.to_number, s.body,
               co.id as contact_id, co.name as contact_name
        FROM sms_messages s
        LEFT JOIN contacts co ON s.contact_id = co.id
        WHERE s.workspace_id = ${wsId}
          AND s.direction = 'inbound'
          AND s.created_at >= NOW() - (${days} || ' days')::interval
        ORDER BY s.created_at DESC
        LIMIT 100
      `,
    ]);

    // Derive actionable “incidents” (sorted by priority)
    const incidents = [] as any[];
    for (const r of (recovery as any[])) {
      const needsText = !r.missed_text_sent_at;
      const needsWindows = !!r.missed_text_sent_at && !r.recovery_windows_sent_at;
      const label = needsText
        ? 'Missed call: text not sent'
        : needsWindows
          ? 'Recovery: needs booking windows'
          : 'Recovery: in progress';
      const priority = needsText ? 'P0' : needsWindows ? 'P1' : 'P2';
      incidents.push({
        kind: 'recovery',
        priority,
        label,
        call_sid: r.call_sid,
        at: r.started_at,
        contact_name: r.contact_name,
        from_number: r.from_number,
        status: r.recovery_status || 'open',
      });
    }
    // SMS disabled — SMS incidents removed from triage
    const priOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
    incidents.sort((a, b) => (priOrder[a.priority] - priOrder[b.priority]) || (String(b.at).localeCompare(String(a.at))));

    res.json({
      ok: true,
      window: { days, limit },
      incidents,
      recovery,
      activeCalls,
      recentCalls,
      sms: [], // SMS disabled
    });
  } catch (e: any) {
    log('error', 'Triage endpoint failed', { error: e?.message || String(e) });
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
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

// ── API: Recovery Queue V1 (missed inbound calls needing recovery) ───────────
app.get("/api/recovery/queue", dashboardAuth, async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const days = Math.max(1, Math.min(90, parseInt(String(req.query.days || "30"), 10) || 30));

    // "Missed" heuristic: inbound calls that were short — caller hung up quickly or
    // got the greeting but didn't complete a conversation. Relaxed thresholds:
    // turn_count <= 1 (greeting may have fired), duration <= 30s.
    const rows = await sql`
      SELECT
        c.call_sid,
        c.from_number,
        c.to_number,
        c.status,
        c.started_at,
        c.duration_seconds,
        c.turn_count,
        c.contact_id,
        co.name as contact_name,
        c.missed_text_sent_at,
        c.recovery_windows_sent_at,
        c.recovery_call_back_started_at,
        c.recovery_closed_at,
        c.recovery_status
      FROM calls c
      LEFT JOIN contacts co ON co.id = c.contact_id
      WHERE c.workspace_id = ${wsId}
        AND c.direction = 'inbound'
        AND COALESCE(c.turn_count, 0) <= 1
        AND COALESCE(c.duration_seconds, 0) <= 30
        AND c.started_at >= NOW() - make_interval(days => ${days})
        AND c.recovery_closed_at IS NULL
      ORDER BY c.started_at DESC
      LIMIT 200
    `;

    // DNC check is per-number; do it in parallel but keep it bounded.
    const items = await Promise.all(rows.map(async (r: any) => {
      let dnc = false;
      try {
        if (r.from_number) dnc = await isOnDNC(r.from_number);
      } catch {}

      // Ensure we have a contact_id for the UI SMS panel.
      let contactId: number | null = r.contact_id || null;
      let contactName: string | null = r.contact_name || null;
      if (!contactId && r.from_number) {
        try {
          const existing = await sql<{ id: number; name: string | null }[]>`
            SELECT id, name
            FROM contacts
            WHERE workspace_id = ${wsId} AND phone_number = ${r.from_number}
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
          `;
          if (existing?.[0]?.id) {
            contactId = existing[0].id;
            contactName = existing[0].name || contactName;
          } else {
            const inserted = await sql<{ id: number }[]>`
              INSERT INTO contacts (phone_number, name, workspace_id)
              VALUES (${r.from_number}, NULL, ${wsId})
              RETURNING id
            `;
            contactId = inserted?.[0]?.id || null;
          }

          if (contactId && !r.contact_id) {
            await sql`
              UPDATE calls
              SET contact_id = ${contactId}
              WHERE call_sid = ${r.call_sid} AND workspace_id = ${wsId} AND contact_id IS NULL
            `;
          }
        } catch {}
      }

      const priority = r.missed_text_sent_at ? "medium" : "high";
      const status = r.recovery_closed_at ? "closed" : (r.recovery_windows_sent_at ? "cooldown" : "needs_reply");
      const reason = r.missed_text_sent_at
        ? "Missed inbound call (text-back already sent)"
        : "Missed inbound call (needs text-back)";

      return {
        id: r.call_sid,
        call_sid: r.call_sid,
        contact_id: contactId || 0,
        name: contactName,
        phone_number: r.from_number,
        reason,
        priority,
        last_touch_at: r.started_at,
        last_sms_preview: null,
        status,
        meta: { ...r, dnc },
      };
    }));

    res.json({ days, items });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Recovery booking windows (stub) ─────────────────────────────────────
app.get("/api/recovery/booking-windows", dashboardAuth, async (req: Request, res: Response) => {
  try {
    const contactId = parseInt(String(req.query.contact_id || ""), 10);
    const days = Math.max(1, Math.min(14, parseInt(String(req.query.days || "7"), 10) || 7));
    if (isNaN(contactId)) return res.status(400).json({ error: "Missing/invalid contact_id" });

    // Server-side stub windows (business days only)
    const windows: any[] = [];
    const now = new Date();
    let added = 0;
    for (let i = 0; i < days * 2 && added < days; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() + i);
      const dow = d.getDay();
      if (dow === 0 || dow === 6) continue;
      added++;
      const start1 = new Date(d); start1.setHours(10, 0, 0, 0);
      const end1 = new Date(d); end1.setHours(12, 0, 0, 0);
      const start2 = new Date(d); start2.setHours(13, 0, 0, 0);
      const end2 = new Date(d); end2.setHours(16, 0, 0, 0);
      windows.push({ id: `${contactId}:${start1.toISOString()}`, start: start1.toISOString(), end: end1.toISOString(), label: "AM" });
      windows.push({ id: `${contactId}:${start2.toISOString()}`, start: start2.toISOString(), end: end2.toISOString(), label: "PM" });
    }

    res.json({ contact_id: contactId, windows });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ── API: Recovery book (send a window-confirmation SMS + mark call) ─────────
app.post("/api/recovery/book", dashboardAuth, async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req) || 1;
    const { call_sid, contact_id, window } = req.body as any;
    const contactId = parseInt(String(contact_id || ""), 10);
    if (!window?.start || !window?.end) return res.status(400).json({ error: "Missing window.start/window.end" });
    if (isNaN(contactId)) return res.status(400).json({ error: "Missing/invalid contact_id" });

    const contactRows = await sql<{ id: number; phone_number: string; workspace_id: number }[]>`
      SELECT id, phone_number, workspace_id
      FROM contacts
      WHERE id = ${contactId} AND workspace_id = ${wsId}
      LIMIT 1
    `;
    if (!contactRows.length) return res.status(404).json({ error: "Contact not found" });
    const to = contactRows[0].phone_number;
    if (!to) return res.status(400).json({ error: "Contact has no phone_number" });
    if (await isOnDNC(to)) return res.status(403).json({ error: "Contact has opted out (STOP)." });

    const twilioClient = getTwilioClient();
    if (!twilioClient) return res.status(400).json({ error: "Twilio not configured" });
    if (!env.TWILIO_PHONE_NUMBER) return res.status(400).json({ error: "Missing TWILIO_PHONE_NUMBER" });

    const start = new Date(window.start);
    const end = new Date(window.end);
    const body = `We can get you in ${start.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}–${end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Reply YES to confirm, or tell me a better time.`;

    const msg = await twilioClient.messages.create({ to, from: env.TWILIO_PHONE_NUMBER, body });
    try {
      await storeSms(sql, {
        messageSid: msg.sid,
        direction: "outbound",
        from: env.TWILIO_PHONE_NUMBER,
        to,
        body,
        status: msg.status || null,
        contactId,
        workspaceId: wsId,
      });
    } catch {}

    if (call_sid) {
      await sql`
        UPDATE calls
        SET recovery_windows_sent_at = COALESCE(recovery_windows_sent_at, NOW())
        WHERE call_sid = ${String(call_sid)} AND workspace_id = ${wsId}
      `;
      logEvent(String(call_sid), "RECOVERY_WINDOWS_SENT", { to, window });
    }

    res.json({ ok: true, sid: msg.sid, status: msg.status });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/api/recovery/:callSid/text-back", dashboardAuth, (_req: Request, res: Response) => {
  res.status(410).json({ error: "SMS disabled", code: "SMS_DISABLED" });
});
// (SMS disabled — original text-back handler removed)
app.post("/_disabled/recovery/:callSid/text-back", dashboardAuth, async (req: Request, res: Response) => {
  const { callSid } = req.params;
  const wsId = getWorkspaceId(req);

  try {
    const [row] = await sql<any[]>`
      SELECT call_sid, from_number, to_number, contact_id, missed_text_sent_at, recovery_closed_at
      FROM calls
      WHERE call_sid = ${callSid} AND workspace_id = ${wsId}
      LIMIT 1
    `;
    if (!row) return res.status(404).json({ error: "Call not found" });
    if (row.recovery_closed_at) return res.json({ ok: true, skipped: true, reason: "closed" });
    if (row.missed_text_sent_at) return res.json({ ok: true, skipped: true, reason: "already_sent" });
    if (!row.from_number) return res.status(400).json({ error: "Missing from_number" });

    // Safety: never text DNC
    if (await isOnDNC(row.from_number)) {
      return res.json({ ok: true, skipped: true, reason: "dnc" });
    }

    const twilioClient = getTwilioClient();
    const fromPhone = env.TWILIO_PHONE_NUMBER;
    if (!twilioClient || !fromPhone) return res.status(400).json({ error: "Twilio not configured" });

    let contactName = "there";
    if (row.contact_id) {
      const [cr] = await sql<{ name: string | null }[]>`SELECT name FROM contacts WHERE id = ${row.contact_id} LIMIT 1`;
      if (cr?.name) contactName = String(cr.name).split(" ")[0];
    }

    const bookingLink = process.env.BOOKING_LINK || "";
    const rawMsg = process.env.RECOVERY_TEXT_BACK_MESSAGE ||
      process.env.MISSED_CALL_TEXT_MESSAGE ||
      `Hey {name} — sorry we missed your call! What were you looking to book? Reply here or use this link: {booking_link}`;
    const body = String(rawMsg)
      .replace(/\{name\}/g, contactName)
      .replace(/\{booking_link\}/g, bookingLink)
      .trim();

    await twilioClient.messages.create({ body, to: row.from_number, from: fromPhone });
    await sql`UPDATE calls SET missed_text_sent_at = NOW() WHERE call_sid = ${callSid} AND workspace_id = ${wsId} AND missed_text_sent_at IS NULL`;
    logEvent(callSid, "RECOVERY_TEXT_BACK_SENT", { to: row.from_number });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/recovery/:callSid/send-windows", dashboardAuth, (_req: Request, res: Response) => {
  res.status(410).json({ error: "SMS disabled", code: "SMS_DISABLED" });
});
// (SMS disabled — original send-windows handler removed)
app.post("/_disabled/recovery/:callSid/send-windows", dashboardAuth, async (req: Request, res: Response) => {
  const { callSid } = req.params;
  const wsId = getWorkspaceId(req);

  try {
    const [row] = await sql<any[]>`
      SELECT call_sid, from_number, contact_id, recovery_windows_sent_at, recovery_closed_at
      FROM calls
      WHERE call_sid = ${callSid} AND workspace_id = ${wsId}
      LIMIT 1
    `;
    if (!row) return res.status(404).json({ error: "Call not found" });
    if (row.recovery_closed_at) return res.json({ ok: true, skipped: true, reason: "closed" });
    if (row.recovery_windows_sent_at) return res.json({ ok: true, skipped: true, reason: "already_sent" });
    if (!row.from_number) return res.status(400).json({ error: "Missing from_number" });
    if (await isOnDNC(row.from_number)) return res.json({ ok: true, skipped: true, reason: "dnc" });

    const twilioClient = getTwilioClient();
    const fromPhone = env.TWILIO_PHONE_NUMBER;
    if (!twilioClient || !fromPhone) return res.status(400).json({ error: "Twilio not configured" });

    let contactName = "there";
    if (row.contact_id) {
      const [cr] = await sql<{ name: string | null }[]>`SELECT name FROM contacts WHERE id = ${row.contact_id} LIMIT 1`;
      if (cr?.name) contactName = String(cr.name).split(" ")[0];
    }

    const bookingLink = process.env.BOOKING_LINK || "";
    const rawMsg = process.env.RECOVERY_WINDOWS_MESSAGE ||
      `Hey {name} — when works best for a quick call back? Reply 1) morning 2) afternoon 3) evening, or book here: {booking_link}`;
    const body = String(rawMsg)
      .replace(/\{name\}/g, contactName)
      .replace(/\{booking_link\}/g, bookingLink)
      .trim();

    await twilioClient.messages.create({ body, to: row.from_number, from: fromPhone });
    await sql`UPDATE calls SET recovery_windows_sent_at = NOW() WHERE call_sid = ${callSid} AND workspace_id = ${wsId} AND recovery_windows_sent_at IS NULL`;
    logEvent(callSid, "RECOVERY_WINDOWS_SENT", { to: row.from_number });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/recovery/:callSid/call-back", dashboardAuth, async (req: Request, res: Response) => {
  const { callSid } = req.params;
  const wsId = getWorkspaceId(req);

  try {
    const [row] = await sql<any[]>`
      SELECT call_sid, from_number, recovery_call_back_started_at, recovery_closed_at
      FROM calls
      WHERE call_sid = ${callSid} AND workspace_id = ${wsId}
      LIMIT 1
    `;
    if (!row) return res.status(404).json({ error: "Call not found" });
    if (row.recovery_closed_at) return res.json({ ok: true, skipped: true, reason: "closed" });
    if (row.recovery_call_back_started_at) return res.json({ ok: true, skipped: true, reason: "already_started" });
    if (!row.from_number) return res.status(400).json({ error: "Missing from_number" });
    if (await isOnDNC(row.from_number)) return res.json({ ok: true, skipped: true, reason: "dnc" });

    const twilioClient = getTwilioClient();
    const fromPhone = env.TWILIO_PHONE_NUMBER;
    if (!twilioClient || !fromPhone) return res.status(400).json({ error: "Twilio not configured" });

    const agent = await getActiveAgent();
    const agentId = agent?.id || undefined;
    const appUrl = getAppUrl();

    const call = await twilioClient.calls.create({
      to: row.from_number,
      from: fromPhone,
      url: `${appUrl}/api/twilio/incoming${agentId ? `?agentId=${agentId}` : ""}`,
      statusCallback: `${appUrl}/api/twilio/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["completed", "failed", "no-answer", "busy", "canceled"],
      machineDetection: "Enable",
      machineDetectionTimeout: 30,
    });

    await sql`UPDATE calls SET recovery_call_back_started_at = NOW() WHERE call_sid = ${callSid} AND workspace_id = ${wsId} AND recovery_call_back_started_at IS NULL`;
    logEvent(callSid, "RECOVERY_CALL_BACK_STARTED", { to: row.from_number, outboundCallSid: call.sid });
    res.json({ ok: true, outboundCallSid: call.sid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/recovery/:callSid/close", dashboardAuth, async (req: Request, res: Response) => {
  const { callSid } = req.params;
  const wsId = getWorkspaceId(req);

  try {
    const result = await sql`
      UPDATE calls
      SET recovery_closed_at = COALESCE(recovery_closed_at, NOW()),
          recovery_status = 'closed'
      WHERE call_sid = ${callSid} AND workspace_id = ${wsId}
      RETURNING call_sid, recovery_closed_at
    `;
    if (!result.length) return res.status(404).json({ error: "Call not found" });
    logEvent(callSid, "RECOVERY_CLOSED", {});
    res.json({ ok: true, closedAt: result[0].recovery_closed_at });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Recovery direct-dial (for contact-derived items with no call SID) ──────
app.post("/api/recovery/direct-dial", dashboardAuth, async (req: Request, res: Response) => {
  const { phone_number, contact_id } = req.body as { phone_number: string; contact_id?: number };
  if (!phone_number) return res.status(400).json({ error: "phone_number required" });
  const twilioClient = getTwilioClient();
  const fromPhone = env.TWILIO_PHONE_NUMBER;
  if (!twilioClient || !fromPhone) return res.status(400).json({ error: "Twilio not configured" });
  try {
    if (await isOnDNC(phone_number)) return res.status(400).json({ error: "Number is on DNC list" });
    const agent = await getActiveAgent();
    const agentId = agent?.id;
    const appUrl = getAppUrl();
    const call = await twilioClient.calls.create({
      to: phone_number.startsWith("+") ? phone_number : `+1${phone_number.replace(/\D/g, "")}`,
      from: fromPhone,
      url: `${appUrl}/api/twilio/incoming${agentId ? `?agentId=${agentId}` : ""}`,
      statusCallback: `${appUrl}/api/twilio/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["completed", "failed", "no-answer", "busy", "canceled"],
      machineDetection: "Enable",
      machineDetectionTimeout: 30,
    });
    log("info", "Recovery direct-dial initiated", { to: phone_number, contactId: contact_id, callSid: call.sid });
    res.json({ ok: true, callSid: call.sid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Recovery stats (header summary for the desk) ─────────────────────────
app.get("/api/recovery/stats", dashboardAuth, async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const [totals] = await sql<any[]>`
      SELECT
        COUNT(*) FILTER (WHERE recovery_closed_at IS NULL AND COALESCE(turn_count, 0) <= 1 AND COALESCE(duration_seconds, 0) <= 30) AS open_count,
        COUNT(*) FILTER (WHERE recovery_windows_sent_at IS NOT NULL AND recovery_closed_at IS NULL) AS windows_sent,
        COUNT(*) FILTER (WHERE recovery_call_back_started_at IS NOT NULL AND recovery_closed_at IS NULL) AS callbacks_started,
        COUNT(*) FILTER (WHERE recovery_closed_at IS NOT NULL AND recovery_closed_at >= NOW() - INTERVAL '7 days') AS closed_7d
      FROM calls
      WHERE workspace_id = ${wsId}
        AND direction = 'inbound'
        AND started_at >= NOW() - INTERVAL '90 days'
    `;
    res.json({ stats: totals || {} });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Calendly Webhook ────────────────────────────────────────────────────
// Receives invitee.created events from Calendly.
// Requires CALENDLY_SIGNING_SECRET env var (from Calendly Developer → Webhooks).
// Deduplicates on calendly_event_uri to survive replay.
app.post("/api/calendly/webhook", express.raw({ type: "*/*", limit: "64kb" }), async (req: Request, res: Response) => {
  const signingSecret = process.env.CALENDLY_SIGNING_SECRET || "";
  if (!signingSecret) {
    log("warn", "[calendly] CALENDLY_SIGNING_SECRET not set — rejecting webhook");
    return res.status(503).json({ error: "Calendly webhook not configured" });
  }

  // ── HMAC-SHA256 signature verification ────────────────────────────────────
  const rawBody = req.body as Buffer;
  const signature = req.headers["calendly-webhook-signature"] as string || "";
  if (!signature) {
    log("warn", "[calendly] Missing Calendly-Webhook-Signature header");
    return res.status(401).json({ error: "Missing signature" });
  }

  // Calendly signature format: "t=<timestamp>,v1=<hmac>"
  const parts: Record<string, string> = {};
  for (const part of signature.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k && v) parts[k] = v;
  }
  const ts = parts["t"];
  const v1 = parts["v1"];
  if (!ts || !v1) {
    log("warn", "[calendly] Malformed signature header", { signature });
    return res.status(401).json({ error: "Malformed signature" });
  }

  // Replay protection: reject if timestamp is older than 5 minutes
  const tsDiff = Math.abs(Date.now() - parseInt(ts, 10) * 1000);
  if (tsDiff > 5 * 60 * 1000) {
    log("warn", "[calendly] Webhook timestamp too old", { tsDiff });
    return res.status(401).json({ error: "Timestamp too old" });
  }

  const { createHmac } = await import("crypto");
  const expected = createHmac("sha256", signingSecret)
    .update(`${ts}.${rawBody.toString()}`, "utf8")
    .digest("hex");

  if (expected !== v1) {
    log("warn", "[calendly] Signature mismatch — possible spoofed webhook");
    return res.status(401).json({ error: "Invalid signature" });
  }

  // ── Parse payload ─────────────────────────────────────────────────────────
  let payload: any;
  try {
    payload = JSON.parse(rawBody.toString());
  } catch (e) {
    log("error", "[calendly] Failed to parse webhook body");
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const event = payload?.event as string;
  log("info", `[calendly] Received event: ${event}`);

  // Only handle invitee.created for now
  if (event !== "invitee.created") {
    return res.status(200).json({ ok: true, skipped: true, event });
  }

  // ── Extract fields ────────────────────────────────────────────────────────
  const invitee = payload?.payload?.invitee || {};
  const eventObj = payload?.payload?.event || {};
  const eventType = payload?.payload?.event_type || {};

  const calendlyEventUri: string = typeof eventObj === "string" ? eventObj : (eventObj?.uri || "");
  const calendlyInviteeUri: string = invitee?.uri || "";
  const inviteeName: string = invitee?.name || "";
  const inviteeEmail: string = invitee?.email || "";
  const eventTypeName: string = typeof eventType === "string" ? eventType : (eventType?.name || "SMIRK Demo");
  const startTime: string = invitee?.scheduled_event?.start_time || payload?.payload?.scheduled_event?.start_time || "";
  const endTime: string = invitee?.scheduled_event?.end_time || payload?.payload?.scheduled_event?.end_time || "";

  if (!calendlyEventUri) {
    log("error", "[calendly] Missing event URI in payload", { payload });
    return res.status(400).json({ error: "Missing event URI" });
  }

  if (!startTime) {
    log("error", "[calendly] Missing start_time in payload", { payload });
    return res.status(400).json({ error: "Missing start_time" });
  }

  // ── Deduplicate + upsert into appointments ────────────────────────────────
  try {
    const existing = await sql<any[]>`
      SELECT id FROM appointments WHERE calendly_event_uri = ${calendlyEventUri} LIMIT 1
    `;
    if (existing.length > 0) {
      log("info", `[calendly] Duplicate event — skipping (uri=${calendlyEventUri})`);
      return res.status(200).json({ ok: true, duplicate: true });
    }

    const durationMinutes = startTime && endTime
      ? Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / 60000)
      : 30;

    await sql`
      INSERT INTO appointments (
        scheduled_at, duration_minutes, status,
        service_type, notes,
        source, calendly_event_uri, calendly_invitee_uri,
        invitee_name, invitee_email, event_type_name
      ) VALUES (
        ${startTime}, ${durationMinutes}, 'scheduled',
        ${eventTypeName}, ${`Booked via Calendly by ${inviteeName} (${inviteeEmail})`},
        'calendly', ${calendlyEventUri}, ${calendlyInviteeUri},
        ${inviteeName}, ${inviteeEmail}, ${eventTypeName}
      )
    `;

    log("info", `[calendly] Appointment stored: ${inviteeName} (${inviteeEmail}) at ${startTime}`);
    res.status(200).json({ ok: true, stored: true });
  } catch (err: any) {
    log("error", "[calendly] DB insert failed", { error: err.message });
    res.status(500).json({ error: "DB error" });
  }
});

// ── API: Calendly config (for embed) ─────────────────────────────────────────
app.get("/api/calendly/config", dashboardAuth, (_req: Request, res: Response) => {
  const url = process.env.CALENDLY_URL || "";
  const configured = !!url;
  res.json({ configured, url });
});

// ── API: Fix stale calls (MUST be before :sid wildcard routes) ───────────────
app.post("/api/calls/fix-stale", dashboardAuth, async (_req: Request, res: Response) => {
  const { scanned, fixed, callSids } = await fixStaleCalls();
  res.json({ scanned, fixed, callSids });
});

app.patch("/api/calls/fix-stale", dashboardAuth, async (req: Request, res: Response) => {
  const wsId = getWorkspaceId(req);
  const stale = await sql`
    SELECT call_sid FROM calls
    WHERE workspace_id = ${wsId}
      AND status = 'in-progress'
      AND started_at < NOW() - INTERVAL '30 minutes'
  `;
  const staleSids = stale.map((r: any) => r.call_sid);
  if (staleSids.length > 0) {
    await sql`
      UPDATE calls SET status = 'failed', ended_at = NOW()
      WHERE call_sid = ANY(${staleSids}::text[]) AND workspace_id = ${wsId}
    `;
  }
  const orphaned = await sql`
    UPDATE calls SET status = 'failed', ended_at = NOW()
    WHERE workspace_id = ${wsId} AND status = 'in-progress' AND started_at IS NULL
    RETURNING call_sid
  `;
  const allFixed = [...staleSids, ...orphaned.map((r: any) => r.call_sid)];
  res.json({ fixed: allFixed.length, sids: allFixed });
});

// ── API: Delete a single call ─────────────────────────────────────────────────
app.delete("/api/calls/:sid", dashboardAuth, async (req: Request, res: Response) => {
  const { sid } = req.params;
  const wsId = getWorkspaceId(req);
  await sql`DELETE FROM messages WHERE call_sid = ${sid}`;
  await sql`DELETE FROM call_events WHERE call_sid = ${sid}`;
  await sql`DELETE FROM call_summaries WHERE call_sid = ${sid}`;
  const result = await sql`DELETE FROM calls WHERE call_sid = ${sid} AND workspace_id = ${wsId} RETURNING call_sid`;
  if (result.length === 0) return res.status(404).json({ error: "Call not found" });
  res.json({ deleted: sid });
});

// ── API: Reprocess a completed call (re-run post-call intelligence) ─────────────
app.post("/api/calls/:sid/reprocess", dashboardAuth, async (req: Request, res: Response) => {
  const { sid } = req.params;
  const wsId = getWorkspaceId(req);
  const rows = await sql`SELECT * FROM calls WHERE call_sid = ${sid} AND workspace_id = ${wsId}`;
  if (rows.length === 0) return res.status(404).json({ error: "Call not found" });
  const call = rows[0];
  // Clear existing summary so it gets regenerated fresh
  await sql`DELETE FROM call_summaries WHERE call_sid = ${sid}`;
  res.json({ status: "reprocessing", callSid: sid });
  // Run post-call intelligence in background
  setImmediate(async () => {
    try {
      await runPostCallIntelligence(sid, call.contact_id || null, env.GEMINI_API_KEY);
      log("info", "Reprocess complete", { callSid: sid });
    } catch (err: any) {
      log("error", "Reprocess failed", { callSid: sid, error: err.message });
    }
  });
});

// ── API: Bulk delete/clear calls ──────────────────────────────────────────────
// DELETE /api/calls?filter=stale  — deletes calls with no duration (failed/dropped)
// DELETE /api/calls?filter=all    — deletes ALL calls in workspace
// DELETE /api/calls?sids=CA1,CA2  — deletes specific SIDs
app.delete("/api/calls", dashboardAuth, async (req: Request, res: Response) => {
  const wsId = getWorkspaceId(req);
  const { filter, sids } = req.query as { filter?: string; sids?: string };
  let deletedSids: string[] = [];

  if (sids) {
    const sidList = sids.split(",").map((s) => s.trim()).filter(Boolean);
    for (const sid of sidList) {
      await sql`DELETE FROM messages WHERE call_sid = ${sid}`;
      await sql`DELETE FROM call_events WHERE call_sid = ${sid}`;
      await sql`DELETE FROM call_summaries WHERE call_sid = ${sid}`;
    }
    const result = await sql`DELETE FROM calls WHERE call_sid = ANY(${sidList}::text[]) AND workspace_id = ${wsId} RETURNING call_sid`;
    deletedSids = result.map((r: any) => r.call_sid);
  } else if (filter === "stale") {
    const stale = await sql`SELECT call_sid FROM calls WHERE workspace_id = ${wsId} AND (duration_seconds IS NULL OR duration_seconds = 0) AND status != 'in-progress'`;
    const staleSids = stale.map((r: any) => r.call_sid);
    if (staleSids.length > 0) {
      for (const sid of staleSids) {
        await sql`DELETE FROM messages WHERE call_sid = ${sid}`;
        await sql`DELETE FROM call_events WHERE call_sid = ${sid}`;
        await sql`DELETE FROM call_summaries WHERE call_sid = ${sid}`;
      }
      await sql`DELETE FROM calls WHERE call_sid = ANY(${staleSids}::text[]) AND workspace_id = ${wsId}`;
      deletedSids = staleSids;
    }
  } else if (filter === "all") {
    const all = await sql`SELECT call_sid FROM calls WHERE workspace_id = ${wsId}`;
    const allSids = all.map((r: any) => r.call_sid);
    if (allSids.length > 0) {
      await sql`DELETE FROM messages WHERE call_sid = ANY(${allSids}::text[])`;
      await sql`DELETE FROM call_events WHERE call_sid = ANY(${allSids}::text[])`;
      await sql`DELETE FROM call_summaries WHERE call_sid = ANY(${allSids}::text[])`;
      await sql`DELETE FROM calls WHERE workspace_id = ${wsId}`;
      deletedSids = allSids;
    }
  } else {
    return res.status(400).json({ error: "Provide filter=stale|all or sids=CA1,CA2" });
  }

  res.json({ deleted: deletedSids.length, sids: deletedSids });
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
  // By default, only show contacts with a name — phone-only records are
  // internal call-linking stubs and should not pollute the Contacts tab.
  // Pass ?include_anonymous=true to see all records (admin/debug use).
  const includeAnonymous = req.query.include_anonymous === "true";
  const contacts = includeAnonymous
    ? await sql`
        SELECT c.*, COUNT(ca.id) as total_calls
        FROM contacts c
        LEFT JOIN calls ca ON c.id = ca.contact_id
        WHERE c.workspace_id = ${wsId}
        GROUP BY c.id
        ORDER BY c.last_seen DESC
        LIMIT ${limit} OFFSET ${offset}
      `
    : await sql`
        SELECT c.*, COUNT(ca.id) as total_calls
        FROM contacts c
        LEFT JOIN calls ca ON c.id = ca.contact_id
        WHERE c.workspace_id = ${wsId}
          AND c.name IS NOT NULL
          AND TRIM(c.name) != ''
        GROUP BY c.id
        ORDER BY c.last_seen DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
  const totalRows = includeAnonymous
    ? await sql`SELECT COUNT(*) as count FROM contacts WHERE workspace_id = ${wsId}`
    : await sql`SELECT COUNT(*) as count FROM contacts WHERE workspace_id = ${wsId} AND name IS NOT NULL AND TRIM(name) != ''`;
  res.json({ contacts, total: Number(totalRows[0].count) });
});

// POST /api/contacts — create a new contact manually from the dashboard
app.post("/api/contacts", dashboardAuth, async (req: Request, res: Response) => {
  const wsId = getWorkspaceId(req);
  const { name, email, company, notes } = req.body;
  const phone_number = (req.body.phone_number || req.body.phone || "").trim();
  if (!phone_number) return res.status(400).json({ error: "phone or phone_number is required" });
  try {
    // Check for existing contact with same phone in this workspace
    const existing = await sql`SELECT id FROM contacts WHERE phone_number = ${phone_number.trim()} AND workspace_id = ${wsId}`;
    if (existing.length) return res.status(409).json({ error: "A contact with this phone number already exists.", id: existing[0].id });
    const rows = await sql`
      INSERT INTO contacts (phone_number, name, email, company, notes, workspace_id, last_seen)
      VALUES (${phone_number.trim()}, ${name?.trim() || null}, ${email?.trim() || null}, ${(req.body.company as string)?.trim() || null}, ${notes?.trim() || null}, ${wsId}, NOW())
      RETURNING *
    `;
    res.status(201).json({ contact: rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
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

app.delete("/api/contacts/:id", dashboardAuth, async (req: Request, res: Response) => {
  const wsId = getWorkspaceId(req);
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid contact ID." });
  const existing = await sql`SELECT id FROM contacts WHERE id = ${id} AND workspace_id = ${wsId}`;
  if (!existing.length) return res.status(404).json({ error: "Contact not found." });
  // Nullify contact_id on linked tables before deleting
  await sql`UPDATE calls SET contact_id = NULL WHERE contact_id = ${id} AND workspace_id = ${wsId}`;
  await sql`UPDATE tasks SET contact_id = NULL WHERE contact_id = ${id} AND workspace_id = ${wsId}`;
  await sql`UPDATE call_summaries SET contact_id = NULL WHERE contact_id = ${id}`;
  await sql`UPDATE sms_messages SET contact_id = NULL WHERE contact_id = ${id}`;
  await sql`UPDATE appointments SET contact_id = NULL WHERE contact_id = ${id}`;
  await sql`UPDATE tool_executions SET contact_id = NULL WHERE contact_id = ${id}`;
  await sql`UPDATE handoffs SET contact_id = NULL WHERE contact_id = ${id}`;
  await sql`DELETE FROM contact_custom_fields WHERE contact_id = ${id} AND workspace_id = ${wsId}`;
  await sql`DELETE FROM contacts WHERE id = ${id} AND workspace_id = ${wsId}`;
  res.json({ success: true, deleted: id });
});

// ── API: Tasks ────────────────────────────────────────────────────────────────
app.get("/api/tasks", async (req: Request, res: Response) => {
  const wsId = getWorkspaceId(req);
  const status = req.query.status as string || "all";
  const tasks = status === "all"
    ? await sql`
        SELECT t.*, co.name as contact_name, co.phone_number
        FROM tasks t
        LEFT JOIN contacts co ON t.contact_id = co.id
        WHERE t.workspace_id = ${wsId}
        ORDER BY t.status ASC, t.due_at ASC NULLS LAST, t.created_at DESC
        LIMIT 200
      `
    : await sql`
        SELECT t.*, co.name as contact_name, co.phone_number
        FROM tasks t
        LEFT JOIN contacts co ON t.contact_id = co.id
        WHERE t.status = ${status} AND t.workspace_id = ${wsId}
        ORDER BY t.due_at ASC NULLS LAST, t.created_at DESC
        LIMIT 100
      `;
  res.json({ tasks });
});

const handleTaskUpdate = async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid task ID." });
  const { status, notes, assigned_to, due_at } = req.body;
  const VALID_TASK_STATUSES = ["open", "in_progress", "completed", "cancelled"];
  if (status && !VALID_TASK_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_TASK_STATUSES.join(", ")}` });
  }
  // Verify task exists
  const existing = await sql`SELECT id FROM tasks WHERE id = ${id} LIMIT 1`;
  if (!existing.length) return res.status(404).json({ error: "Task not found." });
  await sql`
    UPDATE tasks SET
      status       = COALESCE(${status      ?? null}, status),
      notes        = COALESCE(${notes       ?? null}, notes),
      assigned_to  = COALESCE(${assigned_to ?? null}, assigned_to),
      due_at       = COALESCE(${due_at      ?? null}, due_at),
      completed_at = CASE WHEN ${status ?? ''} = 'completed' THEN NOW() ELSE completed_at END
    WHERE id = ${id}
  `;
  res.json({ success: true });
};
app.put("/api/tasks/:id", handleTaskUpdate);
app.patch("/api/tasks/:id", handleTaskUpdate);

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
  const { name, display_name, tagline, system_prompt, greeting, voice, language, vertical, role, tier, color, openclaw_agent_id, max_turns, tool_permissions, routing_keywords } = parsed.data;
  await sql`UPDATE agent_configs SET is_active = FALSE`;
  const agentRows = await sql`
    INSERT INTO agent_configs (name, display_name, tagline, system_prompt, greeting, voice, language, is_active, vertical, role, tier, color, max_turns, openclaw_agent_id, tool_permissions, routing_keywords)
    VALUES (${name}, ${display_name ?? name}, ${tagline ?? ''}, ${system_prompt}, ${greeting}, ${voice}, ${language}, TRUE, ${vertical}, ${role ?? 'vertical'}, ${tier ?? 'specialist'}, ${color ?? '#ff6b00'}, ${max_turns}, ${openclaw_agent_id ?? null}, ${JSON.stringify(tool_permissions ?? [])}, ${JSON.stringify(routing_keywords ?? [])})
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

app.delete("/api/agents/:id", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid agent ID." });
  await sql`DELETE FROM agent_configs WHERE id = ${id}`;
  res.json({ success: true });
});// ── API: Agent — get single + partial update + active ──────────────────────
app.get("/api/agents/active", async (req: Request, res: Response) => {
  const wsId = getWorkspaceId(req);
  const rows = await sql`SELECT * FROM agent_configs WHERE is_active = TRUE AND workspace_id = ${wsId} LIMIT 1`;
  if (!rows.length) return res.status(404).json({ error: "No active agent found." });
  res.json({ agent: rows[0] });
});

app.get("/api/agents/:id", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid agent ID." });
  const rows = await sql`SELECT * FROM agent_configs WHERE id = ${id} LIMIT 1`;
  if (!rows.length) return res.status(404).json({ error: "Agent not found." });
  res.json({ agent: rows[0] });
});

app.patch("/api/agents/:id", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid agent ID." });
  const {
    name, display_name, tagline, system_prompt, greeting,
    voice, language, vertical, role, tier, color,
    max_turns, openclaw_agent_id, tool_permissions, routing_keywords, is_active
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

// ── API: Appointments ────────────────────────────────────────────────────────────────────────────
app.get("/api/appointments", dashboardAuth, async (req: Request, res: Response) => {
  const wsId = getWorkspaceId(req);
  const { status, contact_id, limit = "50" } = req.query as Record<string, string>;
  const lim = Math.min(parseInt(limit) || 50, 200);
  let rows;
  if (status && contact_id) {
    rows = await sql`
      SELECT a.*, c.name as contact_name, c.phone_number
      FROM appointments a LEFT JOIN contacts c ON a.contact_id = c.id
      WHERE a.workspace_id = ${wsId} AND a.status = ${status} AND a.contact_id = ${parseInt(contact_id)}
      ORDER BY a.scheduled_at ASC LIMIT ${lim}
    `;
  } else if (status) {
    rows = await sql`
      SELECT a.*, c.name as contact_name, c.phone_number
      FROM appointments a LEFT JOIN contacts c ON a.contact_id = c.id
      WHERE a.workspace_id = ${wsId} AND a.status = ${status}
      ORDER BY a.scheduled_at ASC LIMIT ${lim}
    `;
  } else if (contact_id) {
    rows = await sql`
      SELECT a.*, c.name as contact_name, c.phone_number
      FROM appointments a LEFT JOIN contacts c ON a.contact_id = c.id
      WHERE a.workspace_id = ${wsId} AND a.contact_id = ${parseInt(contact_id)}
      ORDER BY a.scheduled_at ASC LIMIT ${lim}
    `;
  } else {
    rows = await sql`
      SELECT a.*, c.name as contact_name, c.phone_number
      FROM appointments a LEFT JOIN contacts c ON a.contact_id = c.id
      WHERE a.workspace_id = ${wsId}
      ORDER BY a.scheduled_at ASC LIMIT ${lim}
    `;
  }
  res.json({ appointments: rows, total: rows.length });
});

app.get("/api/appointments/:id", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid appointment ID." });
  const rows = await sql`
    SELECT a.*, c.name as contact_name, c.phone_number
    FROM appointments a LEFT JOIN contacts c ON a.contact_id = c.id
    WHERE a.id = ${id} LIMIT 1
  `;
  if (!rows.length) return res.status(404).json({ error: "Appointment not found." });
  res.json({ appointment: rows[0] });
});

app.patch("/api/appointments/:id", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid appointment ID." });
  const { status, notes, scheduled_at, service_type, technician, location } = req.body;
  const VALID_STATUSES = ["scheduled", "confirmed", "completed", "cancelled", "no_show"];
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` });
  }
  await sql`
    UPDATE appointments SET
      status       = COALESCE(${status       ?? null}, status),
      notes        = COALESCE(${notes        ?? null}, notes),
      scheduled_at = COALESCE(${scheduled_at ?? null}, scheduled_at),
      service_type = COALESCE(${service_type ?? null}, service_type),
      technician   = COALESCE(${technician   ?? null}, technician),
      location     = COALESCE(${location     ?? null}, location)
    WHERE id = ${id}
  `;
  res.json({ success: true });
});

app.post("/api/appointments", dashboardAuth, async (req: Request, res: Response) => {
  const { contact_id, scheduled_at, service_type, notes, technician, location, duration_minutes } = req.body;
  if (!contact_id || !scheduled_at) {
    return res.status(400).json({ error: "contact_id and scheduled_at are required." });
  }
  const wsId = getWorkspaceId(req);
  const rows = await sql`
    INSERT INTO appointments (contact_id, scheduled_at, service_type, notes, technician, location, duration_minutes, status, workspace_id)
    VALUES (${contact_id}, ${scheduled_at}, ${service_type ?? null}, ${notes ?? null}, ${technician ?? null}, ${location ?? null}, ${duration_minutes ?? 60}, 'scheduled', ${wsId})
    RETURNING id
  `;
  res.json({ success: true, id: (rows as any)[0]?.id });
});

// ── API: Google Calendar Test Booking ─────────────────────────────────────────────
// Creates a real calendar event for end-to-end verification.
// Accepts: { summary, scheduled_at, duration_minutes, location, notes, attendee_email }
app.post("/api/calendar/test-booking", dashboardAuth, async (req: Request, res: Response) => {
  if (!isCalendarConfigured()) {
    return res.status(400).json({ success: false, error: "Google Calendar not configured. Set GOOGLE_SA_* vars and GOOGLE_CALENDAR_ID." });
  }
  try {
    const {
      summary = "SMIRK TEST - LIVE",
      scheduled_at,
      duration_minutes = 30,
      location,
      notes,
      attendee_email,
    } = req.body as Record<string, any>;

    // Default: 1 hour from now if no time provided
    const startIso = scheduled_at || new Date(Date.now() + 60 * 60_000).toISOString();
    const endIso = new Date(new Date(startIso).getTime() + (duration_minutes || 30) * 60_000).toISOString();

    const result = await insertCalendarEvent({
      summary,
      description: [
        notes || "End-to-end booking verification via SMIRK API",
        `Created: ${new Date().toISOString()}`,
        `Source: /api/calendar/test-booking`,
      ].join("\n"),
      startIso,
      endIso,
      location: location || undefined,
      attendeeEmail: attendee_email || undefined,
      timeZone: "America/Los_Angeles",
    });

    if (!result.success) {
      return res.status(502).json({ success: false, error: result.error });
    }

    res.json({
      success: true,
      eventId: result.eventId,
      htmlLink: result.htmlLink,
      summary,
      start: startIso,
      end: endIso,
      message: "Calendar event created. Verify at the htmlLink above.",
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || "Unknown error" });
  }
});

// ── API: Google Calendar Events ─────────────────────────────────────────────
app.get("/api/calendar/events", dashboardAuth, async (req: Request, res: Response) => {
  if (!isCalendarConfigured()) {
    return res.json({ configured: false, events: [], message: "Google Calendar not configured. Add GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_CALENDAR_ID in Settings." });
  }
  const { start, end } = req.query as Record<string, string>;
  // Default: current week (Mon–Sun)
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay() + 1); // Monday
  startOfWeek.setHours(0, 0, 0, 0);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6); // Sunday
  endOfWeek.setHours(23, 59, 59, 999);

  const startIso = start || startOfWeek.toISOString();
  const endIso = end || endOfWeek.toISOString();

  try {
    const result = await listCalendarEvents(startIso, endIso, 100);
    if (!result.success) {
      return res.status(502).json({ configured: true, error: result.error, events: [] });
    }
    res.json({ configured: true, events: result.events, start: startIso, end: endIso });
  } catch (err: any) {
    res.status(500).json({ configured: true, error: err.message, events: [] });
  }
});

// ── API: Path aliases (for frontend compatibility) ────────────────────────────────────────────────────────────────────────────
// /api/plugin-tools → /api/tools
app.get("/api/plugin-tools",         dashboardAuth, async (req, res) => { req.url = "/api/tools";         res.redirect(307, "/api/tools"); });
app.post("/api/plugin-tools",        dashboardAuth, async (req, res) => { res.redirect(307, "/api/tools"); });
app.put("/api/plugin-tools/:id",     dashboardAuth, async (req, res) => { res.redirect(307, `/api/tools/${req.params.id}`); });
app.delete("/api/plugin-tools/:id",  dashboardAuth, async (req, res) => { res.redirect(307, `/api/tools/${req.params.id}`); });
// /api/mcp-servers → /api/mcp
app.get("/api/mcp-servers",          dashboardAuth, async (req, res) => { res.redirect(307, "/api/mcp"); });
app.post("/api/mcp-servers",         dashboardAuth, async (req, res) => { res.redirect(307, "/api/mcp"); });
app.put("/api/mcp-servers/:id",      dashboardAuth, async (req, res) => { res.redirect(307, `/api/mcp/${req.params.id}`); });
app.delete("/api/mcp-servers/:id",   dashboardAuth, async (req, res) => { res.redirect(307, `/api/mcp/${req.params.id}`); });
// /api/health → /health
app.get("/api/health", (_req, res) => { res.redirect(307, "/health"); });

// ── API: Settings groups (alias) ────────────────────────────────────────────────────────────────────────────
app.get("/api/settings/groups", dashboardAuth, (_req: Request, res: Response) => {
  res.json({ groups: SETTINGS_GROUPS });
});

// ── API: Event log ────────────────────────────────────────────────────────────────────────────
app.get("/api/events", dashboardAuth, async (req: Request, res: Response) => {
  const wsId = getWorkspaceId(req);
  const { call_sid, limit = "100", event_type } = req.query as Record<string, string>;
  const lim = Math.min(parseInt(limit) || 100, 500);
  let rows;
  if (call_sid && event_type) {
    rows = await sql`
      SELECT ce.*, c.from_number, c.to_number
      FROM call_events ce
      LEFT JOIN calls c ON ce.call_sid = c.call_sid
      WHERE c.workspace_id = ${wsId} AND ce.call_sid = ${call_sid} AND ce.event_type = ${event_type}
      ORDER BY ce.created_at DESC LIMIT ${lim}
    `;
  } else if (call_sid) {
    rows = await sql`
      SELECT ce.*, c.from_number, c.to_number
      FROM call_events ce
      LEFT JOIN calls c ON ce.call_sid = c.call_sid
      WHERE c.workspace_id = ${wsId} AND ce.call_sid = ${call_sid}
      ORDER BY ce.created_at DESC LIMIT ${lim}
    `;
  } else {
    rows = await sql`
      SELECT ce.*, c.from_number, c.to_number
      FROM call_events ce
      LEFT JOIN calls c ON ce.call_sid = c.call_sid
      WHERE c.workspace_id = ${wsId}
      ORDER BY ce.created_at DESC LIMIT ${lim}
    `;
  }
  res.json({ events: rows, total: rows.length });
});

// ── API: SaaS Workspaces ────────────────────────────────────────────────────────────────────────────
app.get("/api/workspaces", dashboardAuth, async (req: Request, res: Response) => {
  const wsId = getWorkspaceId(req);
  const workspaceAuth = (req as any).workspaceAuth;
  if (workspaceAuth) {
    const workspace = await getWorkspaceById(workspaceAuth.id);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const maskedWorkspace = {
      ...workspace,
      api_key: "***",
      twilio_auth_token: workspace.twilio_auth_token ? "***" : null,
      openrouter_api_key: workspace.openrouter_api_key ? "***" : null,
      elevenlabs_api_key: workspace.elevenlabs_api_key ? "***" : null,
      gemini_api_key: workspace.gemini_api_key ? "***" : null,
    };
    return res.json({
      workspaces: [maskedWorkspace],
      plans: PLAN_LIMITS,
      currentWorkspaceId: workspace.id,
      customerMode: true,
    });
  }
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
app.get("/api/openclaw/status", dashboardAuth, async (_req: Request, res: Response) => {
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
app.post("/api/openclaw/test", dashboardAuth, async (req: Request, res: Response) => {
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
  const twilioConfigured = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER);
  const aiConfigured = !!(env.GEMINI_API_KEY || openClawConfig?.enabled || openRouterConfig?.enabled);

  const db: { enabled: boolean; ok: boolean; latencyMs?: number } = {
    enabled: DB_ENABLED,
    ok: false,
  };
  if (DB_ENABLED) {
    const t0 = Date.now();
    try {
      await sql`SELECT 1 as ok`;
      db.ok = true;
      db.latencyMs = Date.now() - t0;
    } catch {
      db.ok = false;
      db.latencyMs = Date.now() - t0;
    }
  }

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    twilioConfigured,
    aiConfigured,
    db,
    uptime: Math.round(process.uptime()),
  });
});

// ── Demo trigger endpoints (called by the landing page backend) ─────────────
// Guardrails:
// - API key required (PHONE_AGENT_API_KEY)
// - Single call per request (no loops)
// - Optional dry-run via DEMO_MODE=true
app.post("/api/demo/outbound-call", requirePhoneAgentApiKey, async (req: Request, res: Response) => {
  try {
    const to = String((req.body as any)?.to || "").trim();
    const name = ((req.body as any)?.name || null) as string | null;
    if (!/^\+\d{10,15}$/.test(to)) return res.status(400).json({ ok: false, error: "Invalid 'to' (must be E.164 +15551234567)" });

    const demoMode = (process.env.DEMO_MODE || "false") === "true";
    if (demoMode) {
      log("info", "[DEMO_MODE] outbound demo call requested", { to, name });
      return res.json({ ok: true, sid: "DRY_RUN" });
    }

    const client = getTwilioClient();
    const from = env.TWILIO_PHONE_NUMBER;
    if (!from) return res.status(503).json({ ok: false, error: "TWILIO_PHONE_NUMBER not configured" });

    const appUrl = getAppUrl();
    const reason = encodeURIComponent("SMIRK Demo: Missed Call Recovery");
    const notes = encodeURIComponent(name ? `Demo for ${name}` : "Demo request");
    const url = `${appUrl}/api/twilio/incoming?reason=${reason}&notes=${notes}`;

    const call = await client.calls.create({ to, from, url, statusCallback: `${appUrl}/api/twilio/status` });
    return res.json({ ok: true, sid: call.sid });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "Call failed" });
  }
});

app.post("/api/demo/sample-hot-lead", requirePhoneAgentApiKey, async (req: Request, res: Response) => {
  try {
    const to = String((req.body as any)?.to || "").trim();
    const submittedPhone = String((req.body as any)?.submittedPhone || "").trim();
    const submittedName = ((req.body as any)?.submittedName || null) as string | null;
    if (!/^\+\d{10,15}$/.test(to)) return res.status(400).json({ ok: false, error: "Invalid 'to' (must be E.164 +15551234567)" });

    const demoMode = (process.env.DEMO_MODE || "false") === "true";
    const body = `P0 SEWER BACKUP | ${submittedName || "New Caller"} | ${submittedPhone || "(unknown)"} | 123 Nevada St, Reno | Main line backup, water entering basement. Transcript/Audio: (demo)`;
    if (demoMode) {
      log("info", "[DEMO_MODE] sample hot lead SMS requested", { to, body });
      return res.json({ ok: true, sid: "DRY_RUN" });
    }

    const client = getTwilioClient();
    const from = env.TWILIO_PHONE_NUMBER;
    if (!from) return res.status(503).json({ ok: false, error: "TWILIO_PHONE_NUMBER not configured" });
    const msg = await client.messages.create({ to, from, body });
    return res.json({ ok: true, sid: msg.sid });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "SMS failed" });
  }
});

// Browser-safe demo endpoint for GitHub Pages landing.
// Guardrails:
// - Validates/normalizes phone
// - Rate limits by phone + IP
// - Dedupe (no repeat to same number for 10 minutes)
// - Dry-run supported (DEMO_MODE=true)
// - No credentials in browser; backend owns Twilio + any API keys
const demoLastByPhone = new Map<string, number>();
const demoLastByIp = new Map<string, number>();

function normalizeE164Loose(input: string): string | null {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (/^\+\d{10,15}$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

app.post("/api/demo", async (req: Request, res: Response) => {
  try {
    const ip = String((req.headers["x-forwarded-for"] || req.socket.remoteAddress || "") ).split(",")[0].trim();
    const name = String((req.body as any)?.name || "").trim() || null;
    const phone = normalizeE164Loose(String((req.body as any)?.phone || ""));
    if (!phone) return res.status(400).json({ ok: false, error: "Invalid phone. Use +15551234567 (E.164) or a 10-digit US number." });

    const now = Date.now();
    const lastPhone = demoLastByPhone.get(phone) || 0;
    const lastIp = demoLastByIp.get(ip) || 0;
    if (now - lastPhone < 10 * 60 * 1000) {
      return res.status(429).json({ ok: false, error: "Please wait a bit before requesting another demo call to the same number." });
    }
    if (now - lastIp < 15 * 1000) {
      return res.status(429).json({ ok: false, error: "Slow down and try again." });
    }
    demoLastByPhone.set(phone, now);
    demoLastByIp.set(ip, now);

    const demoMode = (process.env.DEMO_MODE || "false") === "true";
    log("info", "demo_submission", { name, phone, ip, demoMode });

    // Upsert contact so the lead is always recorded regardless of call outcome
    try {
      await sql`
        INSERT INTO contacts (phone, name, workspace_id, created_at, updated_at)
        VALUES (${phone}, ${name || "Demo Lead"}, 1, NOW(), NOW())
        ON DUPLICATE KEY UPDATE
          name = COALESCE(NULLIF(${name || ""}, ""), name),
          updated_at = NOW()
      `;
    } catch (dbErr: any) {
      log("warn", "demo_lead_upsert_failed", { error: dbErr?.message });
      // Non-fatal — continue even if DB write fails
    }

    // Log the demo submission for owner visibility
    log("info", "demo_lead_captured", { name: name || "(not provided)", phone, ip });

    // Place outbound demo call — degrade gracefully if Twilio not configured
    let callSid: string | null = null;
    let callStatus: "placed" | "queued" | "dry_run" = "queued";

    if (demoMode) {
      callSid = "DRY_RUN";
      callStatus = "dry_run";
    } else {
      const twilioConfigured = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER);
      if (twilioConfigured) {
        try {
          const client = getTwilioClient();
          const from = env.TWILIO_PHONE_NUMBER!;
          const appUrl = getAppUrl();
          const reason = encodeURIComponent("SMIRK Demo: Live Call");
          const notes = encodeURIComponent(name ? `Demo for ${name}` : "Demo request");
          const url = `${appUrl}/api/twilio/incoming?reason=${reason}&notes=${notes}`;
          const call = await client.calls.create({ to: phone, from, url, statusCallback: `${appUrl}/api/twilio/status` });
          callSid = call.sid;
          callStatus = "placed";
        } catch (callErr: any) {
          log("error", "demo_call_failed", { error: callErr?.message, phone });
          // Lead is already recorded — return success with queued status
        }
      }
    }

    const message = callStatus === "placed"
      ? "You should receive a call from SMIRK shortly."
      : callStatus === "dry_run"
      ? "Dry run: payload accepted (no call placed)."
      : "Demo request received. We'll follow up shortly.";

    return res.json({ ok: true, message, callSid, callStatus });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "Demo failed" });
  }
});

// ── Public System Health ─────────────────────────────────────────────────────
// Public-facing status endpoint kept intentionally minimal.
app.get("/api/system-health/public", async (_req: Request, res: Response) => {
  const db: { enabled: boolean; ok: boolean; latencyMs?: number } = {
    enabled: DB_ENABLED,
    ok: false,
  };
  if (DB_ENABLED) {
    const t0 = Date.now();
    try {
      await sql`SELECT 1 as ok`;
      db.ok = true;
      db.latencyMs = Date.now() - t0;
    } catch {
      db.ok = false;
      db.latencyMs = Date.now() - t0;
    }
  }

  res.json({
    status: DB_ENABLED && !db.ok ? "degraded" : "ok",
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    twilioConfigured: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER),
    aiConfigured: !!(env.GEMINI_API_KEY || openClawConfig?.enabled || openRouterConfig?.enabled),
    db,
  });
});

// ── Admin: force-run DB constraint migrations ────────────────────────────────
// One-time endpoint to apply missing constraints that initSchema may have missed
// on an existing DB (idempotent — safe to call multiple times).
app.post("/api/admin/run-migrations", dashboardAuth, async (_req: Request, res: Response) => {
  const results: Record<string, string> = {};
  try {
    // 1. contact_custom_fields unique index
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_custom_fields_contact_key ON contact_custom_fields(contact_id, field_key)`;
    results.contact_custom_fields_unique = "ok";
  } catch (e: any) {
    results.contact_custom_fields_unique = `error: ${e.message}`;
  }
  try {
    // 2. contacts workspace+phone unique index
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_workspace_phone ON contacts(workspace_id, phone_number) WHERE phone_number IS NOT NULL`;
    results.contacts_workspace_phone = "ok";
  } catch (e: any) {
    results.contacts_workspace_phone = `error: ${e.message}`;
  }
  try {
    // 3. leads workspace+phone unique index
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_workspace_phone ON leads(workspace_id, phone) WHERE phone IS NOT NULL`;
    results.leads_workspace_phone = "ok";
  } catch (e: any) {
    results.leads_workspace_phone = `error: ${e.message}`;
  }
  try {
    // 4. call_summaries unique index on call_sid (required for ON CONFLICT)
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_call_unique ON call_summaries(call_sid)`;
    results.call_summaries_call_sid = "ok";
  } catch (e: any) {
    results.call_summaries_call_sid = `error: ${e.message}`;
  }

  // 5. Recovery Desk V1: calls idempotency/status columns used by /api/recovery/*
  try {
    await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS missed_text_sent_at TIMESTAMPTZ`;
    await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS recovery_windows_sent_at TIMESTAMPTZ`;
    await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS recovery_call_back_started_at TIMESTAMPTZ`;
    await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS recovery_closed_at TIMESTAMPTZ`;
    await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS recovery_status TEXT NOT NULL DEFAULT 'open'`;
    results.recovery_calls_columns = "ok";
  } catch (e: any) {
    results.recovery_calls_columns = `error: ${e.message}`;
  }

  // 6. Triage/Dashboard: ensure sms_messages has workspace_id for filtering
  try {
    await sql`ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS workspace_id INTEGER NOT NULL DEFAULT 1`;
    results.sms_messages_workspace_id = "ok";
  } catch (e: any) {
    results.sms_messages_workspace_id = `error: ${e.message}`;
  }

  res.json({ status: "done", results });
});

// ── Admin: inspect live DB indexes ──────────────────────────────────────────────
app.get("/api/admin/db-check", dashboardAuth, async (_req: Request, res: Response) => {
  const indexes = await sql`
    SELECT indexname, tablename, indexdef
    FROM pg_indexes
    WHERE tablename IN ('contacts','contact_custom_fields','leads')
    AND indexname NOT LIKE 'pg_%'
    ORDER BY tablename, indexname
  `;
  res.json({ indexes });
});

// ── Twilio Webhook Self-Test ──────────────────────────────────────────────────
// Simulates what Twilio sends when a call comes in, without needing a real call.
// Use this to verify the full incoming→process pipeline is working:
//   curl -X POST https://your-ngrok-url.ngrok.io/api/twilio/test-webhook
app.post("/api/twilio/test-webhook", dashboardAuth, async (req: Request, res: Response) => {
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
    const agentValue = await getActiveAgent();
    const { contact, isNew } = await resolveContact(testFrom);
    results.step1_caller_resolved = { contactId: contact.id, isNew, agentName: agentValue?.name || "(none)" };

    // Step 2: Test AI response generation
    const systemPrompt = agentValue?.system_prompt || "You are a helpful AI assistant on a phone call.";
    const callerContext = buildCallerContext(contact, isNew);
    const dispatchCtx = { callSid: testCallSid, contactId: contact.id, callerPhone: testFrom, fromPhone: testTo, twilioClient: null, appUrl: getAppUrl() };

    const aiStart = Date.now();
    const { text: aiText, latencyMs, source } = await generateAiResponse(
      testCallSid, fakeSpeech, "test", callerContext, systemPrompt,
      dispatchCtx, env.GEMINI_API_KEY, 1, testFrom
    );
    results.step2_ai_response = { text: aiText.slice(0, 200), latencyMs, source };

    // Step 3: Check TwiML generation
    const twiml = new twilio.twiml.VoiceResponse();
    await buildTwimlSay(twiml, aiText, agentValue?.voice || "Polly.Matthew-Neural");
    twiml.gather({ input: ["speech"], action: "/api/twilio/process", speechTimeout: 2 as any });
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
app.get("/api/webhook-url", dashboardAuth, (_req: Request, res: Response) => {
  const appUrl = getAppUrl();
  res.json({ incomingUrl: `${appUrl}/api/twilio/incoming`, statusUrl: `${appUrl}/api/twilio/status` });
});

// ── Twilio: Test SMS / Test Call (dashboard) ───────────────────────────────
app.post("/api/twilio/test-sms", dashboardAuth, (_req: Request, res: Response) => {
  res.status(410).json({ error: "SMS disabled", code: "SMS_DISABLED" });
});
// (SMS disabled — original handler removed)
app.post("/_disabled/twilio/test-sms", dashboardAuth, async (req: Request, res: Response) => {
  try {
    const to = String(req.body?.to || "").trim();
    const message = String(req.body?.message || "Test message from your AI phone agent.").trim();

    if (!to) return res.status(400).json({ ok: false, error: "Missing 'to'" });
    const twilioClient = getTwilioClient();
    if (!twilioClient) return res.status(400).json({ ok: false, error: "Twilio not configured" });
    if (!env.TWILIO_PHONE_NUMBER) return res.status(400).json({ ok: false, error: "Missing TWILIO_PHONE_NUMBER" });

    const msg = await twilioClient.messages.create({
      to,
      from: env.TWILIO_PHONE_NUMBER,
      body: message,
    });

    return res.json({ ok: true, sid: msg.sid, status: msg.status });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/api/twilio/test-call", dashboardAuth, async (req: Request, res: Response) => {
  try {
    const to = String(req.body?.to || "").trim();
    if (!to) return res.status(400).json({ ok: false, error: "Missing 'to'" });
    const twilioClient = getTwilioClient();
    if (!twilioClient) return res.status(400).json({ ok: false, error: "Twilio not configured" });
    if (!env.TWILIO_PHONE_NUMBER) return res.status(400).json({ ok: false, error: "Missing TWILIO_PHONE_NUMBER" });

    // Safety: require allowlist for outbound test calls.
    const allow = String(process.env.COMPLIANCE_ALWAYS_ALLOW_NUMBERS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (allow.length > 0 && !allow.includes(to)) {
      return res.status(403).json({ ok: false, error: "Test call target is not allowlisted (COMPLIANCE_ALWAYS_ALLOW_NUMBERS)" });
    }

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: "Polly.Matthew-Neural" as any }, "This is a test call from your AI phone agent. If you hear this, your Twilio outbound calling is working.");
    twiml.hangup();

    const call = await twilioClient.calls.create({
      to,
      from: env.TWILIO_PHONE_NUMBER,
      twiml: twiml.toString(),
    });

    return res.json({ ok: true, sid: call.sid });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ── Twilio SMS (two-way texting v1) ─────────────────────────────────────────
// Inbound SMS webhook (Twilio Console → Messaging → A message comes in)
app.post("/api/twilio/sms", twilioValidate, (_req: Request, res: Response) => {
  // SMS disabled — return empty TwiML
  res.set("Content-Type", "text/xml");
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});
// (SMS disabled — original handler removed)
app.post("/_disabled/twilio/sms", twilioValidate, async (req: Request, res: Response) => {
  try {
    const from = String(req.body?.From || "").trim();
    const to = String(req.body?.To || "").trim();
    const body = String(req.body?.Body || "");
    const messageSid = String(req.body?.MessageSid || "").trim() || null;

    const keyword = normalizeSmsKeyword(body);

    // Persist inbound message (best-effort)
    try {
      // Best-effort: map inbound SMS to a contact + workspace by the sender number.
      // If multiple workspaces exist, this is ambiguous without a per-number mapping.
      // For now we take the most recently updated contact match.
      let contactId: number | null = null;
      let workspaceId: number = 1;
      if (from) {
        const rows = await sql<{ id: number; workspace_id: number }[]>`
          SELECT id, workspace_id
          FROM contacts
          WHERE phone_number = ${from}
          ORDER BY updated_at DESC, id DESC
          LIMIT 1
        `;
        if (rows?.[0]?.id) {
          contactId = rows[0].id;
          workspaceId = rows[0].workspace_id || 1;
        }
      }
      await storeSms(sql, {
        messageSid,
        direction: "inbound",
        from,
        to,
        body,
        contactId,
        workspaceId,
      });
    } catch {}

    // Compliance keywords
    if (STOP_KEYWORDS.has(keyword)) {
      if (from) await addToDNC(from, "sms_stop", "sms_webhook", "system");
      return res.type("text/xml").send(
        `<Response><Message>You’re unsubscribed. Reply START to resubscribe.</Message></Response>`
      );
    }
    if (HELP_KEYWORDS.has(keyword)) {
      return res
        .type("text/xml")
        .send(`<Response><Message>Help: reply STOP to unsubscribe. We will follow up shortly.</Message></Response>`);
    }
    if (START_KEYWORDS.has(keyword)) {
      if (from) await removeFromDNC(from);
      return res.type("text/xml").send(
        `<Response><Message>You’re resubscribed. How can we help?</Message></Response>`
      );
    }

    // v1 behavior: acknowledge receipt; higher-level SMS agent loop comes next.
    return res.type("text/xml").send(`<Response><Message>Got it. We’ll respond shortly.</Message></Response>`);
  } catch (e: any) {
    console.error("SMS webhook error", e);
    return res.type("text/xml").send(`<Response></Response>`);
  }
});

// Delivery/status callback for SMS
app.post("/api/twilio/sms-status", twilioValidate, (_req: Request, res: Response) => {
  res.sendStatus(204);
});
// (SMS disabled — original handler removed)
app.post("/_disabled/twilio/sms-status", twilioValidate, async (req: Request, res: Response) => {
  try {
    const messageSid = String(req.body?.MessageSid || req.body?.SmsSid || "").trim() || null;
    const status = String(req.body?.MessageStatus || req.body?.SmsStatus || "").trim() || null;
    const errorCode = req.body?.ErrorCode != null ? String(req.body.ErrorCode) : null;
    const errorMessage = req.body?.ErrorMessage != null ? String(req.body.ErrorMessage) : null;

    if (messageSid) {
      // Best-effort: look up any existing row to preserve contact/workspace mapping
      const prev = await sql<{ contact_id: number | null; workspace_id: number | null }[]>`
        SELECT contact_id, workspace_id
        FROM sms_messages
        WHERE message_sid = ${messageSid}
        LIMIT 1
      `;
      await storeSms(sql, {
        messageSid,
        direction: "outbound",
        from: String(req.body?.From || "").trim(),
        to: String(req.body?.To || "").trim(),
        body: String(req.body?.Body || ""),
        status,
        errorCode,
        errorMessage,
        contactId: prev?.[0]?.contact_id ?? null,
        workspaceId: prev?.[0]?.workspace_id ?? 1,
      });
    }

    return res.json({ ok: true });
  } catch (e: any) {
    console.error("SMS status error", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ── API: SMS thread (Contact-scoped) ─────────────────────────────────────────
// GET /api/contacts/:id/sms — SMS disabled
app.get("/api/contacts/:id/sms", dashboardAuth, (_req: Request, res: Response) => {
  res.status(410).json({ error: "SMS disabled", code: "SMS_DISABLED" });
});
// (SMS disabled — original handler removed)
app.get("/_disabled/contacts/:id/sms", dashboardAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid contact ID." });
    const wsId = getWorkspaceId(req) || 1;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || "200"), 10) || 200, 1), 500);

    const contactRows = await sql<{ id: number; phone_number: string; workspace_id: number }[]>`
      SELECT id, phone_number, workspace_id
      FROM contacts
      WHERE id = ${id} AND workspace_id = ${wsId}
      LIMIT 1
    `;
    if (!contactRows.length) return res.status(404).json({ error: "Contact not found." });

    const optedOut = contactRows[0]?.phone_number ? await isOnDNC(contactRows[0].phone_number) : false;

    const messages = await sql`
      SELECT id, message_sid, direction, from_number, to_number, body, status, error_code, error_message, created_at, updated_at
      FROM sms_messages
      WHERE contact_id = ${id} AND workspace_id = ${wsId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    res.json({ contact: contactRows[0], optedOut, messages });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// POST /api/contacts/:id/sms — SMS disabled
app.post("/api/contacts/:id/sms", dashboardAuth, (_req: Request, res: Response) => {
  res.status(410).json({ error: "SMS disabled", code: "SMS_DISABLED" });
});
// (SMS disabled — original handler removed)
app.post("/_disabled/contacts/:id/sms", dashboardAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid contact ID." });
    const wsId = getWorkspaceId(req) || 1;
    const text = String((req.body as any)?.body || "").trim();
    if (!text) return res.status(400).json({ error: "Missing body" });

    const contactRows = await sql<{ id: number; phone_number: string; workspace_id: number }[]>`
      SELECT id, phone_number, workspace_id
      FROM contacts
      WHERE id = ${id} AND workspace_id = ${wsId}
      LIMIT 1
    `;
    if (!contactRows.length) return res.status(404).json({ error: "Contact not found." });

    const to = contactRows[0].phone_number;
    if (!to) return res.status(400).json({ error: "Contact has no phone_number" });

    // STOP/DNC handling: never send outbound SMS to opted-out numbers
    if (await isOnDNC(to)) {
      return res.status(403).json({ error: "Contact has opted out (STOP). SMS is disabled for this number." });
    }

    const twilioClient = getTwilioClient();
    if (!twilioClient) return res.status(400).json({ error: "Twilio not configured" });
    if (!env.TWILIO_PHONE_NUMBER) return res.status(400).json({ error: "Missing TWILIO_PHONE_NUMBER" });

    const msg = await twilioClient.messages.create({ to, from: env.TWILIO_PHONE_NUMBER, body: text });

    // Persist outbound message with workspace/contact mapping
    try {
      await storeSms(sql, {
        messageSid: msg.sid,
        direction: "outbound",
        from: env.TWILIO_PHONE_NUMBER,
        to,
        body: text,
        status: msg.status || null,
        contactId: id,
        workspaceId: wsId,
      });
    } catch {}

    res.json({ ok: true, sid: msg.sid, status: msg.status });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
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

// ── Agent Identity — quick read/write for business identity fields ─────────────
const IDENTITY_KEYS = ["BUSINESS_NAME","BUSINESS_TAGLINE","BUSINESS_PHONE","BUSINESS_WEBSITE","BUSINESS_ADDRESS","BUSINESS_HOURS","AGENT_NAME","AGENT_PERSONA","BUSINESS_TIMEZONE","BOOKING_LINK","INBOUND_GREETING","OUTBOUND_GREETING"];
app.get("/api/agent/identity", dashboardAuth, (_req: Request, res: Response) => {
  const raw: Record<string, string> = {};
  for (const k of IDENTITY_KEYS) {
    raw[k] = process.env[k] || "";
  }
  res.json(raw);
});
app.post("/api/agent/identity", dashboardAuth, (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  const updates: Record<string, string> = {};
  for (const k of IDENTITY_KEYS) {
    if (body[k] !== undefined) updates[k] = body[k];
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No valid identity fields provided." });
  try {
    writeEnvFile(updates);
    log("info", "Agent identity updated", { keys: Object.keys(updates) });
    res.json({ ok: true, updated: Object.keys(updates) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/settings", dashboardAuth, async (req: Request, res: Response) => {
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
    await reloadOpenClawConfig();
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
      const model = body.GEMINI_MODEL || process.env.GEMINI_MODEL || "gemini-1.5-flash";
      const result = await testAi.models.generateContent({ model, contents: "Reply with only the word: CONNECTED" });
      const text = (result as any).candidates?.[0]?.content?.parts?.[0]?.text || "";
      res.json({ ok: text.includes("CONNECTED"), message: text.includes("CONNECTED") ? "Gemini API connected successfully." : `Unexpected response: ${text}` });
    } else if (service === "openclaw") {
      const url = body.OPENCLAW_GATEWAY_URL || process.env.OPENCLAW_GATEWAY_URL;
      const token = body.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN;
      if (!url) return res.json({ ok: false, error: "Gateway URL is required." });
      const result = await testOpenClawConnection({
        gatewayUrl: url,
        token: token || "",
        agentId: body.OPENCLAW_AGENT_ID || "main",
        model: body.OPENCLAW_MODEL || "",
        enabled: true
      });
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
    } else if (service === "elevenlabs") {
      const key = body.ELEVENLABS_API_KEY || process.env.ELEVENLABS_API_KEY;
      const voiceId = body.ELEVENLABS_VOICE_ID || process.env.ELEVENLABS_VOICE_ID || "TX3LPaxmHKxFdv7VOQHJ";
      const modelId = body.ELEVENLABS_MODEL_ID || process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5";
      if (!key) return res.json({ ok: false, error: "ElevenLabs API Key is required." });
      const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg" },
        body: JSON.stringify({ text: "Test.", model_id: modelId, voice_settings: { stability: 0.2, similarity_boost: 0.88 } }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        return res.json({ ok: false, error: `ElevenLabs returned ${resp.status}: ${errText}` });
      }
      const bytes = (await resp.arrayBuffer()).byteLength;
      res.json({ ok: true, message: `ElevenLabs connected — voice ${voiceId}, model ${modelId}, ${bytes} bytes returned.` });
    } else {
      res.status(400).json({ error: `Unknown service: ${service}. Valid: twilio, gemini, openclaw, openrouter, google_calendar, elevenlabs` });
    }
  } catch (e: any) {
    res.json({ ok: false, error: e.message });
  }
});

// ── API: Debug TTS (temporary — surfaces ElevenLabs errors) ─────────────────
app.post("/api/debug/tts", dashboardAuth, async (req: Request, res: Response) => {
  const text = (req.body as any)?.text || "Hello, this is a test of the voice system.";
  const twiml = new twilio.twiml.VoiceResponse();
  const errors: string[] = [];
  // Temporarily wrap buildTwimlSay to capture errors
  const origElevenLabs = elevenLabsConfig;
  try {
    if (!origElevenLabs) {
      errors.push("elevenLabsConfig is NULL — key not loaded");
    } else {
      errors.push(`elevenLabsConfig loaded: voiceId=${origElevenLabs.voiceId} modelId=${origElevenLabs.modelId} keyPrefix=${origElevenLabs.apiKey.substring(0,8)}...`);
      try {
        const { generateSpeech: gs } = await import("./src/elevenlabs.js");
        const buf = await gs(text, origElevenLabs, "SMIRK");
        if (buf) {
          errors.push(`✅ ElevenLabs TTS SUCCESS — ${buf.length} bytes`);
        } else {
          errors.push("❌ ElevenLabs returned null buffer");
        }
      } catch (e: any) {
        errors.push(`❌ ElevenLabs threw: ${e.message}`);
      }
    }
    await buildTwimlSay(twiml, text, "Polly.Matthew-Neural", "SMIRK");
    res.json({ twiml: twiml.toString(), diagnostics: errors });
  } catch (e: any) {
    res.json({ error: e.message, diagnostics: errors });
  }
});

// ── API: Config Status (for onboarding wizard) ────────────────────────────────
app.get("/api/config-status", dashboardAuth, (_req: Request, res: Response) => {
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
  const { name, email, company, notes, tags, address, city, state, zip } = req.body;
  await sql`
    UPDATE contacts SET
      name         = COALESCE(${name         ?? null}, name),
      email        = COALESCE(${email        ?? null}, email),
      company_name = COALESCE(${company      ?? null}, company_name),
      notes        = COALESCE(${notes        ?? null}, notes),
      address      = COALESCE(${address      ?? null}, address),
      city         = COALESCE(${city         ?? null}, city),
      state        = COALESCE(${state        ?? null}, state),
      zip          = COALESCE(${zip          ?? null}, zip),
      tags         = COALESCE(${tags ? sql.json(tags) : null}, tags),
      updated_at   = NOW()
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
    const upd = await sql`
      UPDATE contact_custom_fields
      SET field_value = ${value}, source = 'manual', updated_at = NOW()
      WHERE contact_id = ${id} AND field_key = ${key}
    `;
    if (upd.count === 0) {
      await sql`
        INSERT INTO contact_custom_fields (contact_id, field_key, field_value, source, updated_at)
        VALUES (${id}, ${key}, ${value}, 'manual', NOW())
        ON CONFLICT DO NOTHING
      `;
    }
  }
  res.json({ success: true });
});

// ── API: Call transcript ───────────────────────────────────────────────────────────────
app.get("/api/calls/:sid/transcript", async (req: Request, res: Response) => {
  const { sid } = req.params;
  // Verify the call exists first
  const callExists = await sql`SELECT call_sid FROM calls WHERE call_sid = ${sid} LIMIT 1`;
  if (!callExists.length) return res.status(404).json({ error: "Call not found.", callSid: sid });
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
app.post("/api/provision/workspace", requireProvisioningSecret, async (req: Request, res: Response) => {
  const name = String((req.body as any)?.name || (req.body as any)?.business_name || "").trim();
  const owner_email = String((req.body as any)?.owner_email || (req.body as any)?.email || "").trim().toLowerCase();
  const requestedSlug = String((req.body as any)?.slug || "").trim() || undefined;
  const requestedPlan = String((req.body as any)?.plan || "starter").trim().toLowerCase();
  const requestedMode = String((req.body as any)?.mode || "missed_call_recovery").trim();
  const source = String((req.body as any)?.source || "signup").trim() || "signup";
  const ownerPhone = String((req.body as any)?.phone || (req.body as any)?.owner_phone || "").trim() || null;
  const requestId = String((req as any).requestId || "");
  const ip = String((req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")).split(",")[0].trim() || null;

  if (!name || !owner_email) {
    return res.status(400).json({ ok: false, error: "name and owner_email required" });
  }

  const plan = (["free", "starter", "pro", "enterprise"].includes(requestedPlan) ? requestedPlan : "starter") as "free" | "starter" | "pro" | "enterprise";
  const mode = (requestedMode === "general" ? "general" : "missed_call_recovery") as "general" | "missed_call_recovery";

  const auditRows = await sql<{ id: number }[]>`
    INSERT INTO provisioning_requests (
      request_id, business_name, owner_email, requested_plan, requested_mode, requested_slug, status, source, ip
    ) VALUES (
      ${requestId || null}, ${name}, ${owner_email}, ${plan}, ${mode}, ${requestedSlug || null}, 'pending', ${source}, ${ip}
    )
    RETURNING id
  `;
  const provisioningRequestId = auditRows[0]?.id;

  try {
    const { workspace, ownerInvite } = await provisionWorkspace({
      name,
      owner_email,
      plan,
      slug: requestedSlug,
      mode,
    });
    const telephony = await provisionWorkspaceTelephony(workspace.id, workspace.name, ownerPhone);

    const inviteLink = `${getAppUrl()}/invite/${ownerInvite.invite_token}`;
    if (provisioningRequestId) {
      await sql`
        UPDATE provisioning_requests
        SET workspace_id = ${workspace.id},
            invite_link = ${inviteLink},
            workspace_api_key = ${workspace.api_key},
            status = ${telephony.phoneNumber ? 'workspace_and_line_created' : 'workspace_created'},
            updated_at = NOW()
        WHERE id = ${provisioningRequestId}
      `;
    }

    return res.json({
      ok: true,
      provisioning_request_id: provisioningRequestId,
      workspace: {
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        owner_email: workspace.owner_email,
        plan: workspace.plan,
        mode: workspace.mode,
        subscription_status: workspace.subscription_status,
        created_at: workspace.created_at,
        phone_number: telephony.phoneNumber,
        twilio_subaccount_sid: telephony.subaccountSid,
        phone_number_sid: telephony.phoneNumberSid,
      },
      invite_link: inviteLink,
      workspace_api_key: workspace.api_key,
      provisioned_phone_number: telephony.phoneNumber,
      twilio_subaccount_sid: telephony.subaccountSid,
      phone_number_sid: telephony.phoneNumberSid,
    });
  } catch (err: any) {
    if (provisioningRequestId) {
      await sql`
        UPDATE provisioning_requests
        SET status = 'manual_fallback_required',
            error = ${err?.message || 'Workspace provisioning failed'},
            updated_at = NOW()
        WHERE id = ${provisioningRequestId}
      `;
    }
    return res.status(500).json({
      ok: false,
      provisioning_request_id: provisioningRequestId,
      fallback_status: 'manual_fallback_required',
      error: err?.message || 'Workspace provisioning failed'
    });
  }
});

app.get("/api/provisioning/requests", dashboardAuth, async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit || "100"), 10) || 100, 500);
  const rows = await sql`
    SELECT id, request_id, workspace_id, business_name, owner_email, requested_plan, requested_mode,
           requested_slug, status, invite_link, error, source, ip, created_at, updated_at
    FROM provisioning_requests
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  res.json({ requests: rows });
});

app.get("/api/workspaces", dashboardAuth, async (_req: Request, res: Response) => {
  const workspaces = await getWorkspaces();
  // Mask sensitive keys
  const masked = workspaces.map((w: any) => ({ ...w, twilio_auth_token: w.twilio_auth_token ? "***" : null, openrouter_api_key: w.openrouter_api_key ? "***" : null, elevenlabs_api_key: w.elevenlabs_api_key ? "***" : null }));
  res.json({ workspaces: masked, plans: PLAN_LIMITS });
});

app.post("/api/workspaces", dashboardAuth, async (req: Request, res: Response) => {
  const { name, owner_email, plan, slug, mode, phone } = req.body;
  if (!name || !owner_email) return res.status(400).json({ error: "name and owner_email required" });
  const { workspace, ownerInvite } = await provisionWorkspace({ name, owner_email, plan, slug, mode });
  const telephony = await provisionWorkspaceTelephony(workspace.id, workspace.name, phone);
  res.json({
    workspace: {
      ...workspace,
      phone_number: telephony.phoneNumber,
      twilio_subaccount_sid: telephony.subaccountSid,
      phone_number_sid: telephony.phoneNumberSid,
    },
    invite_link: `${getAppUrl()}/invite/${ownerInvite.invite_token}`,
    provisioned_phone_number: telephony.phoneNumber,
  });
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
  const workspace = await getWorkspaceById(member.workspace_id);
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });
  res.json({
    success: true,
    member,
    workspace: {
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
      plan: workspace.plan,
      mode: workspace.mode,
      api_key: workspace.api_key,
    },
  });
});

// ── API: Prospecting Campaigns ────────────────────────────────────────────────
app.get("/api/prospecting/campaigns", dashboardAuth, async (_req: Request, res: Response) => {
  const campaigns = await getProspectingCampaigns();
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
  const leads = await getProspectLeads(id);
  // Funnel stats: Dialed → Answered → Interested → Booked
  const funnelRows = await sql<{ status: string; count: string }[]>`
    SELECT status, COUNT(*) as count FROM prospect_leads
    WHERE campaign_id = ${id}
    GROUP BY status
  `;
  const funnelMap: Record<string, number> = {};
  for (const r of funnelRows) funnelMap[r.status] = parseInt(r.count);
  const funnel = {
    total: leads.length,
    pending: funnelMap["pending"] || 0,
    calling: funnelMap["calling"] || 0,
    dialed: (funnelMap["voicemail"] || 0) + (funnelMap["no_answer"] || 0) + (funnelMap["not_interested"] || 0) + (funnelMap["interested"] || 0) + (funnelMap["callback"] || 0) + (funnelMap["dnc"] || 0) + (funnelMap["contacted"] || 0),
    answered: (funnelMap["not_interested"] || 0) + (funnelMap["interested"] || 0) + (funnelMap["callback"] || 0),
    interested: funnelMap["interested"] || 0,
    voicemail: funnelMap["voicemail"] || 0,
    not_interested: funnelMap["not_interested"] || 0,
    callback: funnelMap["callback"] || 0,
    dnc: funnelMap["dnc"] || 0,
    converted: funnelMap["converted"] || 0,
  };
  res.json({ campaign, leads, funnel });
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
  const leads = await getProspectLeads(campaignId, status);
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
    const rawFound = await findBusinessesViaPlaces({ query, location, radius, maxResults });
    // Convert to Lead format for AI qualification + hook generation
    const leadsForQualification: Lead[] = rawFound.map(l => ({
      name: l.contact_name || l.business_name,
      company: l.business_name,
      phone: l.phone,
      email: undefined,
      title: l.contact_title || "Owner",
      industry: l.industry || undefined,
      location: [l.city, l.state].filter(Boolean).join(", ") || l.address || undefined,
      website: l.website || undefined,
      score: (l as any).score,
      source: "google_maps" as const,
    }));
    // AI qualification + personalized hook in one LLM pass
    const qualified = await aiQualifyLeads(leadsForQualification, SCORE_GATE_SAVE);
    // Map back to ProspectLead format with score + hook
    const enrichedLeads = rawFound
      .map(l => {
        const q = qualified.find(q => q.phone === l.phone);
        if (!q) return null; // filtered out by score gate
        return { ...l, score: q.score, personalized_hook: q.personalizedHook };
      })
      .filter(Boolean) as typeof rawFound;
    const added = await addLeads(id, enrichedLeads);
    res.json({ found: rawFound.length, qualified: enrichedLeads.length, added, leads: enrichedLeads });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/prospecting/leads/:id", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { status, call_sid, notes } = req.body;
  await updateLeadStatus(id, status, call_sid, notes);
  // Auto-schedule follow-up sequence steps for terminal call outcomes
  if (DB_ENABLED && ["voicemail", "no_answer", "callback"].includes(status)) {
    try {
      const [lead] = await sql<{ campaign_id: number }[]>`SELECT campaign_id FROM prospect_leads WHERE id = ${id}`;
      if (lead?.campaign_id) {
        const scheduled = await scheduleFollowUpSteps(lead.campaign_id, id, status);
        log("info", "Sequence steps scheduled", { leadId: id, status, scheduled });
      }
    } catch (err: any) {
      log("warn", "Failed to schedule follow-up steps", { leadId: id, error: err.message });
    }
  }

  // Interested → Booking automation: send email with booking link immediately, schedule follow-up call in 24h
  if (DB_ENABLED && status === "interested") {
    try {
      const [lead] = await sql<{ phone: string; email: string | null; business_name: string; contact_name: string | null; personalized_hook: string | null; campaign_id: number }[]>`
        SELECT phone, email, business_name, contact_name, personalized_hook, campaign_id FROM prospect_leads WHERE id = ${id}
      `;
      if (lead) {
        const bookingLink = process.env.BOOKING_LINK || env.CALENDLY_URL || process.env.CALENDLY_URL || "https://calendly.com/smirk-demo";
        const name = lead.contact_name || lead.business_name || "there";
        const company = lead.business_name || "your business";
        const fromName = process.env.FROM_NAME || "SMIRK AI";
        const resendKey = process.env.RESEND_API_KEY;
        const fromEmail = process.env.FROM_EMAIL;
        // Send email if configured and lead has email
        if (resendKey && fromEmail && lead.email) {
          const subject = `Great talking with you, ${name} — here's your demo link`;
          const body = `Hi ${name},\n\nThanks for chatting with us today! You mentioned ${company} could use a hand with missed calls — that's exactly what SMIRK was built for.\n\nHere's a link to book your free 15-minute demo:\n${bookingLink}\n\nWe'll show you exactly how SMIRK answers calls, captures leads, and books jobs for home service businesses like yours — 24/7, no staff required.\n\nTalk soon,\n${fromName}`;
          const resp = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: `${fromName} <${fromEmail}>`,
              to: [lead.email],
              subject,
              text: body,
              html: body.split("\n").map((l: string) => l ? `<p>${l}</p>` : "<br>").join(""),
            }),
          });
          if (resp.ok) {
            log("info", "Interested→booking email sent", { leadId: id, email: lead.email });
          } else {
            const err = await resp.text();
            log("warn", "Interested→booking email failed", { leadId: id, error: err });
          }
        } else if (!lead.email) {
          log("info", "Interested lead has no email — skipping email, scheduling follow-up call", { leadId: id });
        }
        // Schedule follow-up call in 24h (gives them time to book; if no booking, call back)
        if (lead.campaign_id) {
          await sql`
            INSERT INTO prospect_sequence_steps (campaign_id, lead_id, step_number, step_type, delay_hours, status, scheduled_at, created_at)
            VALUES (${lead.campaign_id}, ${id}, 99, 'call', 24, 'pending',
              NOW() + INTERVAL '24 hours', NOW())
            ON CONFLICT DO NOTHING
          `;
          log("info", "Follow-up call scheduled in 24h for interested lead", { leadId: id });
        }
      }
    } catch (err: any) {
      log("warn", "Interested→booking automation failed", { leadId: id, error: err.message });
    }
  }

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
     res.json({ success: true, call_sid: result.callSid, lead: result.lead, pitch: (result as any).pitch });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Auto-Dial: in-memory state per campaign ───────────────────────────────
const autoDialState = new Map<number, { active: boolean; callsThisSession: number; lastCallAt: number }>();

app.post("/api/prospecting/campaigns/:id/auto-dial/start", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  const twilioClient = getTwilioClient();
  if (!twilioClient) return res.status(400).json({ error: "Twilio not configured" });
  if (!env.TWILIO_PHONE_NUMBER) return res.status(400).json({ error: "TWILIO_PHONE_NUMBER not configured" });
  if (autoDialState.get(id)?.active) return res.json({ success: true, message: "Auto-dial already running" });

  autoDialState.set(id, { active: true, callsThisSession: 0, lastCallAt: 0 });
  res.json({ success: true, message: "Auto-dial started" });

  (async () => {
    const INTER_CALL_DELAY_MS = 35_000;
    const MAX_CALLS_PER_SESSION = 100;
    let consecutiveBlocks = 0;
    while (true) {
      const state = autoDialState.get(id);
      if (!state?.active) break;
      if (state.callsThisSession >= MAX_CALLS_PER_SESSION) { log("info", "Auto-dial session limit reached", { campaignId: id }); break; }
      try {
        const result = await dialNextLead(id, twilioClient, env.TWILIO_PHONE_NUMBER!, getAppUrl());
        if ("blocked" in result) {
          consecutiveBlocks++;
          if (consecutiveBlocks >= 3) { log("info", "Auto-dial: 3 consecutive blocks, stopping", { campaignId: id }); break; }
          await new Promise(r => setTimeout(r, 60_000));
          continue;
        }
        consecutiveBlocks = 0;
        state.callsThisSession++;
        state.lastCallAt = Date.now();
        log("info", "Auto-dial: call placed", { campaignId: id, leadId: result.lead.id, callSid: result.callSid });
        await new Promise(r => setTimeout(r, INTER_CALL_DELAY_MS));
      } catch (err: any) {
        if (err.message === "No pending leads in this campaign") { log("info", "Auto-dial: no more leads", { campaignId: id }); break; }
        log("error", "Auto-dial error", { campaignId: id, error: err.message });
        await new Promise(r => setTimeout(r, 10_000));
      }
    }
    const s = autoDialState.get(id);
    if (s) s.active = false;
    log("info", "Auto-dial loop ended", { campaignId: id, totalCalls: s?.callsThisSession });
  })();
});

app.post("/api/prospecting/campaigns/:id/auto-dial/stop", dashboardAuth, (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  const state = autoDialState.get(id);
  if (state) state.active = false;
  res.json({ success: true, callsThisSession: state?.callsThisSession ?? 0 });
});

app.get("/api/prospecting/campaigns/:id/auto-dial/status", dashboardAuth, (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  const state = autoDialState.get(id);
  res.json({ active: state?.active ?? false, callsThisSession: state?.callsThisSession ?? 0, lastCallAt: state?.lastCallAt ? new Date(state.lastCallAt).toISOString() : null });
});

// ── Sequence Engine API ─────────────────────────────────────────────────────
app.get("/api/prospecting/sequences/stats", dashboardAuth, async (req: Request, res: Response) => {
  const campaignId = req.query.campaign_id ? parseInt(req.query.campaign_id as string) : undefined;
  const stats = await getSequenceStats(campaignId);
  res.json(stats);
});

app.get("/api/prospecting/leads/:id/sequence", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  const steps = await getLeadSequenceSteps(id);
  res.json({ steps });
});

app.delete("/api/prospecting/leads/:id/sequence", dashboardAuth, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  await cancelLeadSequence(id);
  res.json({ success: true });
});

app.get("/api/prospecting/sequence-templates", dashboardAuth, (_req: Request, res: Response) => {
  const templates = Object.entries(DEFAULT_SEQUENCES).map(([key, tpl]) => ({
    key,
    stepCount: tpl.steps.length,
    steps: tpl.steps.map(s => ({ step_number: s.step_number, step_type: s.step_type, delay_hours: s.delay_hours })),
  }));
  res.json({ templates });
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
app.get("/api/system-health", dashboardAuth, async (req: Request, res: Response) => {
  const checks: { id: string; label: string; status: 'pass'|'fail'|'warn'; detail: string }[] = [];
  const check = (id: string, label: string, pass: boolean, warn: boolean, detail: string) => {
    checks.push({ id, label, status: pass ? 'pass' : warn ? 'warn' : 'fail', detail });
  };
  let dbPass = false;
  let aiPass = false;
  let twilioPass = false;
  let ownerAlertsPass = false;
  let ownerAlertsWarn = false;
  let callbackPass = false;

  // 1. Database connectivity
  try {
    await sql`SELECT 1`;
    dbPass = true;
    check('db', 'Database', true, false, 'Postgres connection healthy');
  } catch (e: any) {
    check('db', 'Database', false, false, `DB error: ${e.message}`);
  }

  // 2. AI brain configured
  const aiOk = !!(env.OPENROUTER_API_KEY || env.GEMINI_API_KEY);
  aiPass = aiOk;
  const aiDetail = env.OPENROUTER_API_KEY ? `OpenRouter (${openRouterConfig?.model || 'default'})` : env.GEMINI_API_KEY ? 'Gemini 2.0 Flash' : 'No AI key set — add OPENROUTER_API_KEY';
  check('ai', 'AI Brain', aiOk, false, aiDetail);

  // 3. Voice engine configured
  const voiceOk = !!(env.ELEVENLABS_API_KEY || env.GOOGLE_TTS_API_KEY || env.OPENAI_API_KEY);
  const voiceDetail = env.ELEVENLABS_API_KEY ? 'ElevenLabs (primary)' : env.GOOGLE_TTS_API_KEY ? 'Google Neural2' : env.OPENAI_API_KEY ? 'OpenAI TTS' : 'Falling back to Twilio Alice — add ELEVENLABS_API_KEY for human-grade voice';
  check('voice', 'Voice Engine', voiceOk, !voiceOk, voiceDetail);

  // 4. Twilio configured
  const twilioOk = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER);
  twilioPass = twilioOk;
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

  // 10. Owner alert readiness for missed-call recovery MVP
  try {
    const workspaceId = getWorkspaceId(req) || 1;
    const workspace = await getWorkspaceById(workspaceId).catch(() => null);
    const ownerEmail = workspace?.owner_email || null;
    const emailReady = !!(ownerEmail && env.RESEND_API_KEY && env.FROM_EMAIL);
    const fallbackReady = !!(webhookUrl || env.OWNER_PHONE);
    ownerAlertsPass = emailReady;
    ownerAlertsWarn = !emailReady && fallbackReady;
    check(
      'owner_alerts',
      'Owner Alerts',
      emailReady,
      !emailReady && fallbackReady,
      emailReady
        ? `Email alerts ready for ${ownerEmail}`
        : fallbackReady
          ? 'Email alert path incomplete — falling back to webhook/SMS only'
          : 'No owner alert delivery path configured — set workspace owner_email plus RESEND_API_KEY and FROM_EMAIL'
    );
  } catch {
    check('owner_alerts', 'Owner Alerts', false, false, 'Could not verify workspace owner_email or alert configuration');
  }

  // 11. Callback automation readiness
  const callbackReady = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER);
  callbackPass = callbackReady;
  check(
    'callbacks',
    'Callback Automation',
    callbackReady,
    !callbackReady,
    callbackReady
      ? 'Callback tasks can be executed by the scheduled outbound caller'
      : 'Callback executor blocked — configure TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER'
  );

  // 12. Missed-call proof loop readiness
  const proofLoopPass = dbPass && aiPass && twilioPass && ownerAlertsPass && callbackPass;
  const proofLoopWarn = dbPass && aiPass && twilioPass && callbackPass && ownerAlertsWarn;
  check(
    'proof_loop',
    'Missed-Call Proof Loop',
    proofLoopPass,
    proofLoopWarn,
    proofLoopPass
      ? 'Ready to test summary + owner email + callback task + dashboard proof'
      : proofLoopWarn
        ? 'Almost ready, but owner alerts are only on fallback webhook/SMS rather than email'
        : 'Not ready for end-to-end proof yet — fix the failed dependency checks above first'
  );

  // 13. Session / auth working (if we got here, auth passed)
  check('auth', 'Dashboard Auth', true, false, 'Session valid — you are authenticated');

  const passed = checks.filter(c => c.status === 'pass').length;
  const warned = checks.filter(c => c.status === 'warn').length;
  const failed = checks.filter(c => c.status === 'fail').length;

  res.json({ checks, summary: { passed, warned, failed, total: checks.length } });
});

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

/**
 * POST /api/leads/upsert
 * Single integration bus: validate → upsert lead → HubSpot → Calendar → SMS
 * Body: LeadUpsertInput (phone or email required)
 */
app.post("/api/leads/upsert", dashboardAuth, async (req, res) => {
  try {
    const workspaceId = getWorkspaceId(req);
    const input: LeadUpsertInput = req.body;
    const validationError = validateLeadInput(input);
    if (validationError) return res.status(400).json({ error: validationError });
    const result = await upsertLead(input, workspaceId);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/leads/funnel
 * KPI funnel tiles: captured → qualified → booked → follow_up_due counts
 */
app.get("/api/leads/funnel", dashboardAuth, async (req, res) => {
  try {
    const workspaceId = getWorkspaceId(req);
    const rows = await sql`
      SELECT
        COUNT(*) FILTER (WHERE funnel_stage = 'captured')       AS captured,
        COUNT(*) FILTER (WHERE funnel_stage = 'qualified')      AS qualified,
        COUNT(*) FILTER (WHERE funnel_stage = 'booked')         AS booked,
        COUNT(*) FILTER (WHERE funnel_stage = 'follow_up_due')  AS follow_up_due,
        COUNT(*) FILTER (WHERE funnel_stage = 'closed')         AS closed,
        COUNT(*)                                                 AS total,
        COUNT(*) FILTER (WHERE booked_at IS NOT NULL)           AS total_booked,
        COUNT(*) FILTER (WHERE qualified_at IS NOT NULL)        AS total_qualified,
        COUNT(*) FILTER (WHERE sms_sent_at IS NOT NULL)         AS sms_sent,
        COUNT(*) FILTER (WHERE hubspot_id IS NOT NULL)          AS hubspot_synced,
        COUNT(*) FILTER (WHERE calendar_event_id IS NOT NULL)   AS calendar_synced,
        COUNT(*) FILTER (WHERE follow_up_due_at IS NOT NULL
                           AND follow_up_due_at <= NOW()
                           AND funnel_stage != 'closed')        AS overdue_follow_ups
      FROM leads
      WHERE workspace_id = ${workspaceId}
    `;
    const kpi = rows[0] as Record<string, string>;
    const funnel = Object.fromEntries(
      Object.entries(kpi).map(([k, v]) => [k, Number(v)])
    );
    const total = funnel.total || 1;
    funnel.captured_rate   = 100;
    funnel.qualified_rate  = Math.round((funnel.total_qualified / total) * 100);
    funnel.booked_rate     = Math.round((funnel.total_booked    / total) * 100);
    const { isHubSpotConfigured }   = await import("./src/crm.js");
    const { isCalendarConfigured }  = await import("./src/gcal.js");
    res.json({
      funnel,
      integrations: {
        hubspot:  { configured: isHubSpotConfigured(),  env_var: "HUBSPOT_ACCESS_TOKEN" },
        calendar: { configured: isCalendarConfigured(), env_var: "GOOGLE_SERVICE_ACCOUNT_JSON + GOOGLE_CALENDAR_ID" },
        sms:      { configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER), env_var: "TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_NUMBER" },
        operator_alert: { configured: !!(process.env.OPERATOR_ALERT_NUMBER ?? process.env.HUMAN_TRANSFER_NUMBER), env_var: "OPERATOR_ALERT_NUMBER" },
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/leads/scoreboard
 * Weekly ops scoreboard: leads captured, qualified, booked, follow-ups due,
 * booked rate, and per-connector integration error rates.
 * Supports ?weeks=N (default 1) to look back N weeks.
 */
app.get("/api/leads/scoreboard", dashboardAuth, async (req, res) => {
  try {
    const workspaceId = getWorkspaceId(req);
    const weeks = Math.min(Math.max(Number(req.query.weeks) || 1, 1), 52);
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - weeks * 7);
    const since = sinceDate.toISOString();

    // ── Weekly funnel counts ──────────────────────────────────────────────────
    const funnelRows = await sql`
      SELECT
        COUNT(*) FILTER (WHERE funnel_stage = 'captured')       AS captured,
        COUNT(*) FILTER (WHERE funnel_stage = 'qualified')      AS qualified,
        COUNT(*) FILTER (WHERE funnel_stage = 'booked')         AS booked,
        COUNT(*) FILTER (WHERE funnel_stage = 'follow_up_due')  AS follow_up_due,
        COUNT(*) FILTER (WHERE funnel_stage = 'closed')         AS closed,
        COUNT(*)                                                 AS total,
        COUNT(*) FILTER (WHERE booked_at IS NOT NULL)           AS total_booked,
        COUNT(*) FILTER (WHERE follow_up_due_at IS NOT NULL
                           AND follow_up_due_at <= NOW()
                           AND funnel_stage != 'closed')        AS overdue_follow_ups
      FROM leads
      WHERE workspace_id = ${workspaceId}
        AND created_at >= ${since}::timestamptz
    `;
    const kpi = funnelRows[0] as Record<string, string>;
    const funnel = Object.fromEntries(Object.entries(kpi).map(([k, v]) => [k, Number(v)]));
    const total = funnel.total || 1;
    funnel.booked_rate = Math.round((funnel.total_booked / total) * 100);

    // ── Integration error rates (all-time, by connector) ─────────────────────
    const integRows = await sql`
      SELECT
        COUNT(*) FILTER (WHERE integration_status->>'hubspot'  = 'ok')    AS hs_ok,
        COUNT(*) FILTER (WHERE integration_status->>'hubspot'  = 'error') AS hs_error,
        COUNT(*) FILTER (WHERE integration_status->>'hubspot'  = 'skip')  AS hs_skip,
        COUNT(*) FILTER (WHERE integration_status->>'calendar' = 'ok')    AS cal_ok,
        COUNT(*) FILTER (WHERE integration_status->>'calendar' = 'error') AS cal_error,
        COUNT(*) FILTER (WHERE integration_status->>'calendar' = 'skip')  AS cal_skip,
        COUNT(*) FILTER (WHERE integration_status->>'sms'      = 'ok')    AS sms_ok,
        COUNT(*) FILTER (WHERE integration_status->>'sms'      = 'error') AS sms_error,
        COUNT(*) FILTER (WHERE integration_status->>'sms'      = 'skip')  AS sms_skip,
        COUNT(*) FILTER (WHERE last_error IS NOT NULL)                     AS rows_with_errors
      FROM leads
      WHERE workspace_id = ${workspaceId}
    `;
    const ir = integRows[0] as Record<string, string>;
    const n = (k: string) => Number(ir[k] ?? 0);

    const errorRate = (ok: number, err: number): number => {
      const attempts = ok + err;
      return attempts === 0 ? 0 : Math.round((err / attempts) * 100);
    };

    const integrations = {
      hubspot: {
        configured: !!(process.env.HUBSPOT_ACCESS_TOKEN),
        ok: n("hs_ok"), error: n("hs_error"), skip: n("hs_skip"),
        error_rate_pct: errorRate(n("hs_ok"), n("hs_error")),
      },
      calendar: {
        configured: !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_CALENDAR_ID),
        ok: n("cal_ok"), error: n("cal_error"), skip: n("cal_skip"),
        error_rate_pct: errorRate(n("cal_ok"), n("cal_error")),
      },
      sms: {
        configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER),
        ok: n("sms_ok"), error: n("sms_error"), skip: n("sms_skip"),
        error_rate_pct: errorRate(n("sms_ok"), n("sms_error")),
      },
      rows_with_errors: n("rows_with_errors"),
    };

    // ── Recent errors (last 10 rows with last_error set) ──────────────────────
    const recentErrors = await sql`
      SELECT id, phone, name, funnel_stage, last_error, updated_at
      FROM leads
      WHERE workspace_id = ${workspaceId}
        AND last_error IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 10
    `;

    res.json({
      period: { weeks, since },
      funnel,
      integrations,
      recent_errors: recentErrors,
      generated_at: new Date().toISOString(),
    });
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

/**
 * GET /api/leads/alerts
 * Sev-1 threshold monitor. Returns firing alerts for:
 *   - operator SMS failures > 0 in last 24h
 *   - calls with no lead row (call completed but no lead upserted)
 *   - integration error rate > threshold (default 10%)
 * Used by ops monitoring / uptime checks.
 */
app.get("/api/leads/alerts", dashboardAuth, async (req, res) => {
  try {
    const workspaceId = getWorkspaceId(req);
    const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const alerts: Array<{ sev: string; code: string; message: string; count?: number }> = [];

    // ── Alert 1: Operator SMS failures in last 24h ────────────────────────────
    const smsFailRows = await sql`
      SELECT COUNT(*) AS cnt
      FROM leads
      WHERE workspace_id = ${workspaceId}
        AND updated_at >= ${since24h}::timestamptz
        AND integration_status->>'sms' = 'error'
        AND last_error IS NOT NULL
    `;
    const smsFailCount = Number((smsFailRows[0] as any)?.cnt ?? 0);
    if (smsFailCount > 0) {
      alerts.push({
        sev: "SEV1",
        code: "SMS_OPERATOR_ALERT_FAILURE",
        message: `${smsFailCount} lead(s) had operator SMS failures in the last 24h. Check last_error column.`,
        count: smsFailCount,
      });
    }

    // ── Alert 2: Calls completed with no lead row (pipeline gap) ─────────────
    // A completed inbound call with a call_summary (name was extracted) but no lead row is a Sev-1.
    // Calls with no summary = caller hung up before giving name = expected, not an alert.
    const orphanCallRows = await sql`
      SELECT COUNT(*) AS cnt
      FROM calls c
      WHERE c.workspace_id = ${workspaceId}
        AND c.status = 'completed'
        AND c.direction = 'inbound'
        AND c.contact_id IS NOT NULL
        AND c.started_at >= ${since24h}::timestamptz
        AND EXISTS (
          SELECT 1 FROM call_summaries s
          WHERE s.call_sid = c.call_sid
            AND s.extracted_entities->>'caller_name' IS NOT NULL
            AND s.extracted_entities->>'caller_name' != ''
        )
        AND NOT EXISTS (
          SELECT 1 FROM leads l
          WHERE l.workspace_id = c.workspace_id
            AND l.call_sid = c.call_sid
        )
    `;
    const orphanCount = Number((orphanCallRows[0] as any)?.cnt ?? 0);
    if (orphanCount > 0) {
      alerts.push({
        sev: "SEV1",
        code: "CALL_NO_LEAD_ROW",
        message: `${orphanCount} completed inbound call(s) in last 24h have no lead row. Post-call intelligence may have failed.`,
        count: orphanCount,
      });
    }

    // ── Alert 3: Integration error rate > threshold ───────────────────────────
    const errThreshold = Number(req.query.error_threshold_pct ?? 10);
    const integRows = await sql`
      SELECT
        COUNT(*) FILTER (WHERE integration_status->>'sms' = 'ok')    AS sms_ok,
        COUNT(*) FILTER (WHERE integration_status->>'sms' = 'error') AS sms_error
      FROM leads
      WHERE workspace_id = ${workspaceId}
        AND updated_at >= ${since24h}::timestamptz
    `;
    const ir = integRows[0] as Record<string, string>;
    const smsOk = Number(ir?.sms_ok ?? 0);
    const smsErr = Number(ir?.sms_error ?? 0);
    const smsAttempts = smsOk + smsErr;
    const smsErrRate = smsAttempts > 0 ? Math.round((smsErr / smsAttempts) * 100) : 0;
    if (smsErrRate > errThreshold) {
      alerts.push({
        sev: "SEV1",
        code: "SMS_ERROR_RATE_HIGH",
        message: `SMS error rate ${smsErrRate}% exceeds threshold ${errThreshold}% in last 24h.`,
        count: smsErr,
      });
    }

    // ── Alert 4: Follow-ups overdue > 24h ────────────────────────────────────
    const overdueRows = await sql`
      SELECT COUNT(*) AS cnt
      FROM leads
      WHERE workspace_id = ${workspaceId}
        AND funnel_stage = 'follow_up_due'
        AND follow_up_due_at IS NOT NULL
        AND follow_up_due_at <= NOW() - INTERVAL '24 hours'
    `;
    const overdueCount = Number((overdueRows[0] as any)?.cnt ?? 0);
    if (overdueCount > 0) {
      alerts.push({
        sev: "SEV2",
        code: "FOLLOW_UP_OVERDUE",
        message: `${overdueCount} lead(s) have overdue follow-ups (>24h past due_at).`,
        count: overdueCount,
      });
    }

    const status = alerts.some(a => a.sev === "SEV1") ? "firing" :
                   alerts.some(a => a.sev === "SEV2") ? "warning" : "ok";

    res.json({
      status,
      alert_count: alerts.length,
      alerts,
      checked_at: new Date().toISOString(),
      window_hours: 24,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── SMIRK Chat Agent ─────────────────────────────────────────────────────────
/**
 * POST /api/chat
 * Body: { messages: [{role, content}][], workspaceId?: number }
 * Returns: { reply: string, toolsUsed: string[] }
 */
app.post("/api/chat", dashboardAuth, async (req: Request, res: Response) => {
  try {
    const { messages, workspaceId } = req.body as { messages: ChatMessage[]; workspaceId?: number };
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array required" });
    }
    const wsId = workspaceId || getWorkspaceId(req) || 1;
    const result = await handleSmirkChat(messages, wsId);
    res.json(result);
  } catch (err: any) {
    log("error", "SMIRK Chat failed", { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/chat/debug-context
 * Returns the raw context string that would be loaded for the chat agent.
 * Used for debugging context loading issues.
 */
app.get("/api/chat/debug-context", dashboardAuth, async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req) || 1;
    const context = await loadChatContext(wsId);
    res.json({ workspaceId: wsId, context });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Team Member Routes (must be before 404 handler) ─────────────────────────
registerTeamRoutes(app);
registerBossModeRoutes(app);

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

  // In "no-db" mode sql.end() is a no-op.
  (sql as any).end?.().catch?.(() => {});
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ── Vite Middleware / Static Files ────────────────────────────────────────────
async function startServer() {
  // Always start the HTTP server quickly (Railway healthchecks hit /health early).
  // DB initialization should not block app.listen() in production.
  const PORT = Number(process.env.PORT || 3000);

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

  // Initialize Postgres schema in the background with retry (do not fail the process).
  if (DB_ENABLED) {
    (async () => {
      const maxAttempts = 30;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await initSchema();
          await initSaasSchema();
          await initProspectorSchema();
          await initSequenceSchema();
          await initComplianceSchema();
          await ensureWorkspacePhoneNumbersTable();
          // Auto-register the configured Twilio number to workspace 1 so inbound/outbound calls route correctly.
          // Also purge any stale seed/test numbers that don't match the real Twilio number.
          if (env.TWILIO_PHONE_NUMBER) {
            try {
              // Remove stale seed data (e.g. +17755550100) that would shadow the real number
              await sql`
                DELETE FROM workspace_phone_numbers
                WHERE phone_number != ${env.TWILIO_PHONE_NUMBER}
              `;
              // Insert or update the real number
              await sql`
                INSERT INTO workspace_phone_numbers (workspace_id, phone_number, twilio_sid, enabled)
                VALUES (1, ${env.TWILIO_PHONE_NUMBER}, ${env.TWILIO_ACCOUNT_SID || null}, TRUE)
                ON CONFLICT (phone_number) DO UPDATE SET enabled = TRUE, workspace_id = 1, twilio_sid = ${env.TWILIO_ACCOUNT_SID || null}
              `;
              log("info", "Twilio phone number auto-registered to workspace 1 (stale entries purged)", { phone: env.TWILIO_PHONE_NUMBER });
            } catch (e: any) {
              log("warn", "Failed to auto-register Twilio phone number", { error: e.message });
            }
          }
          log("info", "Postgres schema initialized (core + SaaS + prospector + compliance + team)", { attempt });
          return;
        } catch (e: any) {
          const msg = e?.message || String(e);
          log("warn", "Postgres init failed; retrying", { attempt, maxAttempts, error: msg });
          await new Promise(r => setTimeout(r, Math.min(10_000, 500 * attempt)));
        }
      }
      log("error", "Postgres init failed permanently; app will stay up but DB-backed features will be degraded");
    })();
  } else {
    log("warn", "DATABASE_URL not set: running in no-db mode (dashboard loads, but persistence APIs will fail)");
  }

  if (!IS_PROD) {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = process.env.DIST_PATH || path.resolve(__dirname, "..", "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  // Log OpenClaw status at startup
  await reloadOpenClawConfig();

  // Warn if APP_URL looks like a placeholder — TTS audio and Twilio callbacks will break
  const appUrl = getAppUrl();
  if (appUrl.includes("localhost") || appUrl.includes("YOUR_") || appUrl.includes("example.com") || appUrl.includes("<") || appUrl.includes("placeholder")) {
    log("warn",
      "APP_URL looks like a placeholder or localhost — Twilio webhooks and TTS audio URLs will not work in production. " +
      "Set APP_URL to your public Railway/ngrok URL (e.g. https://smirk.up.railway.app).",
      { APP_URL: appUrl }
    );
  }


/** Get all campaigns */
app.get("/api/campaigns", dashboardAuth, async (req, res) => {
  try {
    const workspaceId = getWorkspaceId(req);
    const campaigns = await getProspectingCampaigns();
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
    const [campaign] = await sql`SELECT * FROM campaigns WHERE id = ${campaignId} AND workspace_id = ${workspaceId}`;
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    // Get leads for this campaign
    const leads = await sql`SELECT * FROM leads WHERE campaign_id = ${campaignId} AND workspace_id = ${workspaceId} AND phone IS NOT NULL AND status = 'new'`;

    if (!leads.length) return res.status(400).json({ error: "No callable leads in this campaign" });

    // Update campaign status
    await sql`UPDATE campaigns SET status = 'active', updated_at = NOW() WHERE id = ${campaignId}`;

    // Queue calls (fire and forget — don't block response)
    res.json({ launched: true, leadsQueued: leads.length });

    // Dial leads sequentially with 30s gap between calls
    (async () => {
      const twilioClient = getTwilioClient();
      for (const lead of leads) {
        if (!lead.phone) continue;
        try {
          // ── Hard compliance gate before every dial ──────────────────────────────
          const compliance = await checkOutboundCompliance(lead.phone);
          if (!compliance.allowed) {
            log("warn", "Campaign lead skipped by compliance gate", {
              leadId: lead.id, phone: lead.phone,
              reason: compliance.reason,
              blockedReason: compliance.blockedReason,
              nextValidWindow: compliance.nextValidWindow?.toISOString(),
            });
            // Queue lead for next valid window instead of dropping it
            if (compliance.nextValidWindow) {
              await sql`
                UPDATE leads
                SET status = 'queued',
                    notes = COALESCE(notes, '') || ${`\n[BLOCKED ${new Date().toISOString()}] ${compliance.reason} — retry after ${compliance.nextValidWindow.toISOString()}`}
                WHERE id = ${lead.id}
              `;
            }
            continue; // skip to next lead
          }
          // ─────────────────────────────────────────────────────────────────────────

          // Generate personalized pitch
          const pitch = await generatePersonalizedPitch(
            { name: lead.name, company: lead.company, title: lead.title, industry: lead.industry, location: lead.location, source: "apollo" },
            campaign.pitch_template,
            "SMIRK"
          );

          // Make the call via Twilio
          const agent = campaign.agent_id
            ? (await sql`SELECT name FROM agent_configs WHERE id = ${campaign.agent_id}`)[0]
            : await getActiveAgent();

          await twilioClient.calls.create({
            to: lead.phone,
            from: process.env.TWILIO_PHONE_NUMBER!,
            url: `${getAppUrl()}/api/twilio/incoming?agentId=${campaign.agent_id || ""}&reason=${encodeURIComponent(campaign.call_reason)}&notes=${encodeURIComponent(pitch)}`,
            statusCallback: `${getAppUrl()}/api/twilio/status`,
            statusCallbackMethod: "POST",
          });

          // Mark lead as contacted
          await sql`UPDATE leads SET status = 'contacted', last_contacted = NOW() WHERE id = ${lead.id}`;

          // Wait 30 seconds between calls
          await new Promise(resolve => setTimeout(resolve, 30_000));
        } catch (err: any) {
          log("error", "Campaign call failed", { leadId: lead.id, error: err.message });
        }
      }
      await sql`UPDATE campaigns SET status = 'completed', updated_at = NOW() WHERE id = ${campaignId}`;
    })();
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

}

startServer().catch((err) => {
  log("error", "Failed to start server", { error: err.message });
  process.exit(1);
});
// Railway cache bust 1773713745
