/**
 * SMIRK missed-call recovery — Main Server
 *
 * Architecture: Twilio → OpenClaw Gateway (Codex 5.3) OR Gemini 2.5 Flash → Amazon Polly TTS
 * AI Brain: OpenClaw Gateway (preferred) with automatic Gemini fallback
 * State: Postgres (calls, messages, contacts, summaries, events, tasks, tools, handoffs)
 * Security: helmet, rate-limit, zod validation, API key auth, Twilio sig verification
 * Observability: structured logging, request IDs, AI latency tracking
 */
import express, { Request, Response, NextFunction } from "express";
import Stripe from "stripe";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import twilio from "twilio";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import morgan from "morgan";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { timingSafeEqual } from "crypto";

import { loadElevenLabsConfig, generateSpeech, getElevenLabsAgentVoice, type ElevenLabsConfig } from "./src/elevenlabs.js";
import { loadCartesiaTTSConfig, generateCartesiaSpeech, type CartesiaTTSConfig } from "./src/cartesia-tts.js";
import { loadOpenAITTSConfig, generateOpenAISpeech, getAgentVoice, type OpenAITTSConfig } from "./src/openai-tts.js";
import { loadGoogleTTSConfig, generateGoogleSpeech, getGoogleAgentVoice, type GoogleTTSConfig } from "./src/google-tts.js";
import { dispatchTool, TOOL_DECLARATIONS } from "./src/function-calling.js";
import { buildWorkspaceKnowledgeContext } from "./src/workspace-knowledge.js";

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
  LANDING_APP_URL: z.string().optional(),
  PORT: z.string().optional(),
  DASHBOARD_API_KEY: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_ADMIN_EMAILS: z.string().optional(),
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
  // Operator alert number — receives hot lead / escalation alerts
  OPERATOR_ALERT_NUMBER: z.string().optional(),
  // Twilio signature validation skip (set to 'true' to disable in dev)
  TWILIO_SKIP_VALIDATION: z.enum(["true", "false"]).optional(),
  WEBHOOK_URL: z.string().optional(),
  OUTBOUND_WEBHOOK_URL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  FROM_EMAIL: z.string().optional(),
  FROM_NAME: z.string().optional(),
  // Legacy owner phone field; SMS alerts stay disabled for the callback-first MVP.
  OWNER_PHONE: z.string().optional(),
  // Owner email — used for post-call notifications (overrides workspace.owner_email placeholder)
  OWNER_EMAIL: z.string().optional(),
  NOTIFICATION_EMAIL: z.string().optional(),
  // Calendly webhook signing secret (from Calendly Developer → Webhooks)
  CALENDLY_SIGNING_SECRET: z.string().optional(),
  // Calendly booking page URL for embed
  CALENDLY_URL: z.string().optional(),
  // Stripe billing
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_ALLOWED_USER_IDS: z.string().optional(),
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().optional(),
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
const DEPLOY_VERSION =
  process.env.SMIRK_DEPLOY_VERSION ||
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.SOURCE_VERSION ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.npm_package_version ||
  "dev";
const DEPLOY_BRANCH =
  process.env.SMIRK_DEPLOY_BRANCH ||
  process.env.RAILWAY_GIT_BRANCH ||
  process.env.VERCEL_GIT_COMMIT_REF ||
  process.env.GITHUB_REF_NAME ||
  "unknown";

// ── Simple API key auth for demo endpoints (landing page trigger) ─────────────
const readBearerToken = (req: Request): string => {
  const auth = String(req.headers["authorization"] || "");
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
};

const timingSafeSecretEquals = (provided: string, expected: string): boolean => {
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  if (providedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(providedBytes, expectedBytes);
};

const requirePhoneAgentApiKey = (req: Request, res: Response, next: NextFunction) => {
  const expected = (process.env.PHONE_AGENT_API_KEY || "").trim();
  if (!expected) return res.status(503).json({ ok: false, error: "PHONE_AGENT_API_KEY not configured" });

  const token = readBearerToken(req);
  if (!token || !timingSafeSecretEquals(token, expected)) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
};

const requireProvisioningSecret = (req: Request, res: Response, next: NextFunction) => {
  const expected = (process.env.PHONE_AGENT_PROVISIONING_SECRET || "").trim();
  if (!expected) return res.status(503).json({ ok: false, error: "PHONE_AGENT_PROVISIONING_SECRET not configured" });

  const token = readBearerToken(req);
  if (!token || !timingSafeSecretEquals(token, expected)) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
};

const requireTestCallSecret = (req: Request, res: Response, next: NextFunction) => {
  const expected = (env.DASHBOARD_API_KEY || process.env.TEST_CALL_SECRET || "").trim();
  if (!expected) return res.status(503).json({ ok: false, error: "TEST_CALL_SECRET not configured" });

  const providedKey = String(req.headers["x-api-key"] || req.body?.secret || "").trim();
  if (!providedKey || !timingSafeSecretEquals(providedKey, expected)) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
};

// ── Import modules (after env is loaded) ─────────────────────────────────────
import { sql, initSchema, DB_ENABLED } from "./src/db.js";
import { getMockWorkspace } from "./src/mock-db.js";
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
import { fireCallWebhooks, buildCallPayload } from "./src/webhooks.js";
import { syncAllCrms, getConfiguredCrms, isHubSpotConfigured } from "./src/crm.js";
import { getPluginTools, pluginToolsToDeclarations, executePluginTool } from "./src/plugin-tools.js";
import { getEnabledMcpServers, loadMcpSession, mcpToolsToDeclarations, callMcpTool } from "./src/mcp-bridge.js";
import { initSaasSchema, getWorkspaceById, getWorkspaceByApiKey, updateWorkspace, acceptInvite, checkUsageLimits, incrementWorkspaceUsage, resetMonthlyUsage, handleStripeWebhook, createActivationEvent, createActivationEventIfChanged, listActivationEvents } from "./src/saas.js";
import type { Workspace } from "./src/saas.js";
import { TwilioService } from "./src/twilio-provisioning.js";
import { resolveWorkspaceAiKeys, buildWorkspaceOpenRouterConfig, buildWorkspaceElevenLabsConfig, classifyAiKeyError, invalidateWorkspaceAiKeyCache } from "./src/workspace-ai-keys.js";

async function getWorkspaceMode(workspaceId: number): Promise<"general" | "missed_call_recovery"> {
  try {
    const rows = await sql<{ mode: string }[]>`SELECT mode FROM workspaces WHERE id = ${workspaceId} LIMIT 1`;
    const m = (rows?.[0]?.mode || "general").toLowerCase();
    return m === "missed_call_recovery" ? "missed_call_recovery" : "general";
  } catch {
    return "general";
  }
}
import { initProspectorSchema } from "./src/prospector.js";
import { initSequenceSchema, executeDueSequenceSteps } from "./src/sequence-engine.js";
import { initComplianceSchema, checkOutboundCompliance, isOnDNC, detectOptOut } from "./src/compliance.js";
import { registerTeamRoutes } from "./src/team-routes.js";
import { registerBossModeRoutes, getActiveTemporaryContext } from "./src/boss-mode.js";
import { registerAdminMaintenanceRoutes } from "./src/routes/admin-maintenance-routes.js";
import { registerAgentRoutes } from "./src/routes/agent-routes.js";
import { registerApiMiddleware } from "./src/routes/api-middleware.js";
import { registerAuthRoutes } from "./src/routes/auth-routes.js";
import { registerBuyerRoutes } from "./src/routes/buyer-routes.js";
import { registerCalendarRoutes } from "./src/routes/calendar-routes.js";
import { registerCalendlyRoutes } from "./src/routes/calendly-routes.js";
import { registerCallRoutes } from "./src/routes/call-routes.js";
import { registerComplianceRoutes } from "./src/routes/compliance-routes.js";
import { registerContactRoutes } from "./src/routes/contact-routes.js";
import { registerDashboardRoutes } from "./src/routes/dashboard-routes.js";
import { registerDebugRoutes } from "./src/routes/debug-routes.js";
import { registerDemoRoutes } from "./src/routes/demo-routes.js";
import { registerIntegrationsRoutes } from "./src/routes/integrations-routes.js";
import { registerLeadRoutes } from "./src/routes/lead-routes.js";
import { registerLaunchRoutes } from "./src/routes/launch-routes.js";
import { registerOperatorRoutes } from "./src/routes/operator-routes.js";
import { registerOperationsRoutes } from "./src/routes/operations-routes.js";
import { registerOutboundCallRoutes } from "./src/routes/outbound-call-routes.js";
import { registerProofRoutes } from "./src/routes/proof-routes.js";
import { registerProvisioningRoutes } from "./src/routes/provisioning-routes.js";
import { registerProspectingRoutes } from "./src/routes/prospecting-routes.js";
import { registerRecoveryRoutes } from "./src/routes/recovery-routes.js";
import { registerSettingsRoutes } from "./src/routes/settings-routes.js";
import { registerSmsRoutes } from "./src/routes/sms-routes.js";
import { registerSystemHealthRoutes } from "./src/routes/system-health-routes.js";
import { registerTaskRoutes } from "./src/routes/task-routes.js";
import { registerTelegramApprovalRoutes } from "./src/routes/telegram-approval-routes.js";
import { registerTwilioLiveRoutes } from "./src/routes/twilio-live-routes.js";
import { registerTwilioOpsRoutes } from "./src/routes/twilio-ops-routes.js";
import { registerTwilioStatusRoutes } from "./src/routes/twilio-status-routes.js";
import { registerTwimlRoutes } from "./src/routes/twiml-routes.js";
import { registerWorkspaceAdminRoutes } from "./src/routes/workspace-admin-routes.js";
import { registerWorkspaceActivationRoutes } from "./src/routes/workspace-activation-routes.js";
import { registerWorkspaceKnowledgeRoutes } from "./src/routes/workspace-knowledge-routes.js";
import { registerWorkspaceOverviewRoutes } from "./src/routes/workspace-overview-routes.js";
import { registerWorkspaceProfileRoutes } from "./src/routes/workspace-profile-routes.js";
import { classifyCallAtStart, classifyFromUtterance, storeClassification, type CallClass } from "./src/call-classifier.js";
import { evaluateCallPostHoc } from "./src/reward-system.js";
import { chooseSafeHumanTransferTarget, detectExplicitHumanTransferRequest } from "./src/handoff-transfer.js";

// ── Structured Logger ─────────────────────────────────────────────────────────────────────
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
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
}));
app.use((req, res, next) => {
  const host = req.get("host") || "";
  const forwardedProto = (req.get("x-forwarded-proto") || req.protocol || "").split(",")[0]?.trim();
  const isPublicAppHost = host.includes("smirkcalls.com") || host.includes("up.railway.app");

  if (IS_PROD && isPublicAppHost && forwardedProto === "http") {
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  }

  if (IS_PROD && isPublicAppHost) {
    res.setHeader("Content-Security-Policy", "upgrade-insecure-requests; block-all-mixed-content");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  next();
});
// Serve pre-recorded audio assets (voicemail drops, hold music, etc.) without auth
app.use("/public", express.static(path.resolve(__dirname, "../public")));
// Skip JSON body parsing for Stripe webhook — it needs the raw Buffer for signature verification
app.use((req, res, next) => {
  if (req.path === '/api/stripe/webhook') return next();
  const limit = req.path === '/api/workspace/knowledge/import' ? '256kb' : '10kb';
  express.json({ limit })(req, res, next);
});
app.use((req, res, next) => {
  if (req.path === '/api/stripe/webhook') return next();
  express.urlencoded({ extended: true, limit: '10kb' })(req, res, next);
});
// CORS
// For the GitHub Pages landing calling the Railway backend, set:
//   PAGES_ALLOWED_ORIGIN="https://artificially-educated.github.io"
// Production defaults closed to known app/landing origins. Local development
// keeps permissive CORS so old demos and tunnels do not break.
const corsAllowedOrigins = Array.from(new Set([
  process.env.PAGES_ALLOWED_ORIGIN,
  process.env.LANDING_APP_URL,
  process.env.APP_URL,
  "https://smirkcalls.com",
  "https://www.smirkcalls.com",
].map((origin) => String(origin || "").trim().replace(/\/$/, "")).filter(Boolean)));
const shouldRestrictCors = IS_PROD || corsAllowedOrigins.length > 0;
app.use(cors(shouldRestrictCors ? {
  origin: (origin, cb) => {
    // allow server-to-server or curl (no Origin)
    if (!origin) return cb(null, true);
    if (corsAllowedOrigins.includes(origin.replace(/\/$/, ""))) return cb(null, true);
    return cb(new Error("CORS blocked"));
  },
  methods: ["POST", "GET", "OPTIONS"],
  allowedHeaders: ["content-type", "authorization", "x-api-key", "x-workspace-id"],
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

app.use("/health", publicHealthRateLimit);

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
    if (wsId && wsId > 0) return wsId;
    // Single-tenant fallback: if workspace_phone_numbers is empty or number not found,
    // check if this matches the configured TWILIO_PHONE_NUMBER and return workspace 1.
    const configuredNumber = (process.env.TWILIO_PHONE_NUMBER || "").trim();
    if (configuredNumber && (to === configuredNumber || !configuredNumber)) return 1;
    // Also fall back to workspace 1 if no multi-tenant phone numbers are configured at all
    const countRows = await sql<{ count: number }[]>`SELECT COUNT(*) as count FROM workspace_phone_numbers WHERE enabled = TRUE`;
    const totalConfigured = Number(countRows?.[0]?.count || 0);
    if (totalConfigured === 0) return 1; // single-tenant mode
    return null;
  } catch {
    return 1; // fail open to workspace 1 rather than rejecting the call
  }
};

// ── Dashboard / Workspace Auth ────────────────────────────────────────────────
const dashboardAuth = async (req: Request, res: Response, next: NextFunction) => {
  const operatorApiKey = env.DASHBOARD_API_KEY;
  const providedApiKey = String(req.headers["x-api-key"] || "").trim();
  if (operatorApiKey && providedApiKey && timingSafeSecretEquals(providedApiKey, operatorApiKey)) {
    (req as any).authMode = "operator";
    return next();
  }

  if (!DB_ENABLED && req.method === "GET" && req.path === "/api/workspaces") {
    (req as any).authMode = "workspace";
    const mockWorkspace = getMockWorkspace();
    (req as any).workspaceAuth = mockWorkspace;
    (req.headers as any)["x-workspace-id"] = String(mockWorkspace.id);
    return next();
  }

  const workspaceToken = readBearerToken(req);
  if (!DB_ENABLED && workspaceToken) {
    const mockWorkspace = getMockWorkspace();
    if (workspaceToken === mockWorkspace.api_key) {
      (req as any).authMode = "workspace";
      (req as any).workspaceAuth = mockWorkspace;
      (req.headers as any)["x-workspace-id"] = String(mockWorkspace.id);
      return next();
    }
  }

  if (workspaceToken) {
    try {
      const workspace = await getWorkspaceByApiKey(workspaceToken);
      if (workspace) {
        if (workspace.plan === "free" && workspace.trial_ends_at && new Date(workspace.trial_ends_at) < new Date()) {
          return res.status(402).json({
            error: "Workspace demo access expired. Upgrade or request an extension to reactivate this profile.",
            code: "WORKSPACE_DEMO_EXPIRED",
            trial_ended_at: workspace.trial_ends_at,
          });
        }
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

const requireOperator = (req: Request, res: Response, next: NextFunction) => {
  if ((req as any).authMode === "operator") return next();
  return res.status(403).json({ error: "Forbidden. Operator access required." });
};

const hasProSuitePlan = (plan: unknown): boolean => {
  const normalized = String(plan || "").trim().toLowerCase();
  return normalized === "pro" || normalized === "enterprise" || normalized === "agency";
};

const requireProSuite = (req: Request, res: Response, next: NextFunction) => {
  if ((req as any).authMode === "operator") return next();
  const workspace = (req as any).workspaceAuth;
  if (!workspace) return next();
  if (hasProSuitePlan(workspace.plan)) return next();
  return res.status(403).json({
    error: "This workspace is on the Basic dashboard. Upgrade to Pro to open the full suite.",
    code: "PRO_SUITE_REQUIRED",
    required_plan: "pro",
  });
};

type GoogleIdentity = {
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
  aud?: string;
  sub?: string;
};

const splitCsv = (raw?: string | null) => String(raw || "")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

const googleClientIds = () => splitCsv(env.GOOGLE_OAUTH_CLIENT_ID);
const googleAdminEmails = () => splitCsv(env.GOOGLE_ADMIN_EMAILS);

const verifyGoogleIdToken = async (credential: string): Promise<GoogleIdentity> => {
  const idToken = String(credential || "").trim();
  if (!idToken) throw new Error("Missing Google credential.");

  const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  const body = await resp.json().catch(() => ({} as any));
  if (!resp.ok) {
    throw new Error(body.error_description || body.error || `Google token verification failed (${resp.status}).`);
  }

  const email = String(body.email || "").trim().toLowerCase();
  const aud = String(body.aud || "").trim();
  const allowedAudiences = googleClientIds();
  if (allowedAudiences.length > 0 && aud && !allowedAudiences.includes(aud)) {
    throw new Error("Google client mismatch. Check GOOGLE_OAUTH_CLIENT_ID.");
  }

  return {
    email,
    email_verified: String(body.email_verified || "false") === "true",
    name: String(body.name || "").trim() || undefined,
    picture: String(body.picture || "").trim() || undefined,
    aud: aud || undefined,
    sub: String(body.sub || "").trim() || undefined,
  };
};

const getWorkspacesForEmail = async (emailRaw: string) => {
  const email = String(emailRaw || "").trim().toLowerCase();
  if (!email) return [] as Array<{ id: number; name: string; slug: string; plan: string; mode: string; api_key: string; role: string }>;
  return sql<Array<{ id: number; name: string; slug: string; plan: string; mode: string; api_key: string; role: string }>>`
    WITH owner_matches AS (
      SELECT w.id, w.name, w.slug, w.plan, w.mode, w.api_key, 'owner'::TEXT AS role
      FROM workspaces w
      WHERE lower(w.owner_email) = ${email}
    ),
    member_matches AS (
      SELECT w.id, w.name, w.slug, w.plan, w.mode, w.api_key, wm.role::TEXT AS role
      FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id
      WHERE lower(wm.email) = ${email}
        AND wm.accepted_at IS NOT NULL
    )
    SELECT DISTINCT ON (id) *
    FROM (
      SELECT * FROM owner_matches
      UNION ALL
      SELECT * FROM member_matches
    ) matches
    ORDER BY id, CASE WHEN role = 'owner' THEN 0 WHEN role = 'admin' THEN 1 ELSE 2 END
  `;
};

registerAuthRoutes(app, {
  env,
  googleClientIds,
  googleAdminEmails,
  verifyGoogleIdToken,
  getWorkspacesForEmail,
});

["/api/calls", "/api/agents", "/api/stats", "/api/contacts", "/api/tasks", "/api/handoffs", "/api/team", "/api/summaries", "/api/logs", "/api/webhook-url"].forEach(
  (route) => app.use(route, dashboardAuth)
);

[
  "/api/stats",
  "/api/call-intelligence",
  "/api/triage",
  "/api/handoffs",
  "/api/recovery",
  "/api/appointments",
  "/api/calendar/events",
  "/api/workspace-overview",
].forEach((route) => app.use(route, dashboardAuth, requireProSuite));

// ── Twilio Signature Validation ───────────────────────────────────────────────
const twilioValidate = (req: Request, res: Response, next: NextFunction) => {
  // Operator-only Twilio smoke routes are protected by dashboardAuth later in
  // the route chain. They are not signed by Twilio, so do not require a Twilio
  // webhook signature before dashboardAuth can evaluate the operator key.
  if (["/test-webhook", "/test-call"].includes(req.path)) return next();

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

registerApiMiddleware(app, {
  apiRateLimit,
  publicDemoRateLimit,
  publicHealthRateLimit,
  twilioValidate,
});

// ── Input Validation Schemas ──────────────────────────────────────────────────
const OutboundCallSchema = z.object({
  to: z.string().regex(/^\+[1-9]\d{7,14}$/, "Phone number must be in E.164 format (e.g. +15551234567)"),
  agentId: z.number().int().positive().optional(),
  reason: z.string().max(500).optional(),
  notes: z.string().max(1000).optional(),
  source: z.string().max(80).optional(),
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
const FAST_LIVE_CALLS = process.env.FAST_LIVE_CALLS !== "false";
const FAST_LIVE_CALL_TTS_VOICE = "Polly.Matthew-Neural";

let lastActiveAgentDbWarningAt = 0;
let activeAgentCache: {
  value: { id: number; name: string; system_prompt: string; greeting: string; voice: string; language: string; max_turns: number } | undefined;
  expiresAt: number;
} | null = null;
const getActiveAgent = async (): Promise<{ id: number; name: string; system_prompt: string; greeting: string; voice: string; language: string; max_turns: number } | undefined> => {
  if (!DB_ENABLED) return undefined;
  const now = Date.now();
  if (activeAgentCache && activeAgentCache.expiresAt > now) return activeAgentCache.value;
  try {
    const rows = await sql<{ id: number; name: string; system_prompt: string; greeting: string; voice: string; language: string; max_turns: number }[]>`
      SELECT * FROM agent_configs WHERE is_active = TRUE ORDER BY id DESC LIMIT 1
    `;
    activeAgentCache = { value: rows[0], expiresAt: now + 30_000 };
    return activeAgentCache.value;
  } catch (err: any) {
    if (now - lastActiveAgentDbWarningAt > 60_000) {
      lastActiveAgentDbWarningAt = now;
      log("warn", "Active agent lookup unavailable; using default agent behavior", { error: err?.message || String(err) });
    }
    return undefined;
  }
};

const getAi = () => {
  if (!env.GEMINI_API_KEY) return null; // Optional — OpenRouter handles AI if not set
  return new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
};

const getTwilioClient = () => {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) throw new Error("Twilio credentials not configured.");
  return twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
};

const getAppUrl = () => {
  // Use RAILWAY_PUBLIC_DOMAIN for webhook URLs — this is the direct Railway URL
  // that Twilio can reach. APP_URL may point to a frontend-only domain (e.g., smirkcalls.com)
  // that doesn't proxy /api/* routes to this server.
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL;
  if (railwayDomain && railwayDomain.trim()) {
    return `https://${railwayDomain.trim().replace(/^\/+|\/+$/g, "")}`;
  }
  return (env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
};

const getPublicAppUrl = () => {
  return (env.LANDING_APP_URL || env.APP_URL || getAppUrl()).replace(/\/$/, "");
};

const workspaceProfileCache = new Map<number, { value: Workspace | null; expiresAt: number }>();
const getCachedWorkspaceById = async (workspaceId: number): Promise<Workspace | null> => {
  const now = Date.now();
  const cached = workspaceProfileCache.get(workspaceId);
  if (cached && cached.expiresAt > now) return cached.value;
  const workspace = await getWorkspaceById(workspaceId);
  workspaceProfileCache.set(workspaceId, { value: workspace ?? null, expiresAt: now + 30_000 });
  return workspace ?? null;
};

type GreetingDirection = "inbound" | "outbound";

const renderWorkspaceGreeting = ({
  direction,
  workspace,
  businessName,
  agentName,
  agentGreeting,
}: {
  direction: GreetingDirection;
  workspace: Workspace | null;
  businessName?: string | null;
  agentName?: string | null;
  agentGreeting?: string | null;
}): string => {
  const resolvedBusinessName = businessName || workspace?.business_name || process.env.BUSINESS_NAME || "";
  const resolvedAgentName = workspace?.agent_name || process.env.AGENT_NAME || agentName || "SMIRK";
  const replaceVars = (template: string) => template
    .replaceAll("{business_name}", resolvedBusinessName)
    .replaceAll("{agent_name}", resolvedAgentName);

  if (direction === "outbound") {
    const outboundTemplate = workspace?.outbound_greeting
      || process.env.OUTBOUND_GREETING
      || "Hi, this is {business_name}. I'm following up on your request. Is now a good time?";
    return replaceVars(outboundTemplate);
  }

  const inboundTemplate = workspace?.inbound_greeting
    || process.env.INBOUND_GREETING
    || agentGreeting
    || (resolvedBusinessName
      ? `Thanks for calling ${resolvedBusinessName}! This is ${resolvedAgentName}, your AI assistant. This call may be recorded for quality and follow-up. How can I help you today?`
      : `Hello! This is ${resolvedAgentName}, your AI assistant. This call may be recorded for quality and follow-up. How can I help you today?`);
  return replaceVars(inboundTemplate);
};

const cleanOwnerEmail = (value?: string | null): string | null => {
  const email = String(value || "").trim();
  if (!email || /owner@example\.com/i.test(email)) return null;
  return email;
};

const maskPhoneForResponse = (value?: string | null): string | null => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  const last4 = digits.slice(-4);
  return `***-***-${last4}`;
};

const formatSenderEmail = (fromEmail: string, fromName = "SMIRK"): string => {
  const trimmed = String(fromEmail || "").trim();
  if (!trimmed) return "";
  return /<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>/i.test(trimmed) ? trimmed : `${fromName} <${trimmed}>`;
};

const getOwnerAlertRecipients = async (workspaceId: number): Promise<string[]> => {
  const recipients = new Set<string>();
  const envOwnerEmail = cleanOwnerEmail(env.OWNER_EMAIL);
  if (envOwnerEmail) recipients.add(envOwnerEmail);
  try {
    const workspace = await getCachedWorkspaceById(workspaceId);
    const workspaceOwnerEmail = cleanOwnerEmail(workspace?.owner_email);
    const notificationEmail = cleanOwnerEmail(workspace?.notification_email);
    if (workspaceOwnerEmail) recipients.add(workspaceOwnerEmail);
    if (notificationEmail) recipients.add(notificationEmail);
  } catch (err: unknown) {
    log("warn", "Owner alert recipient lookup failed", { workspaceId, error: err instanceof Error ? err.message : String(err) });
  }
  return Array.from(recipients);
};

type ProofFreshness = {
  latestCompleteProofAt: string | null;
  maxAgeHours: number;
  ageHours: number | null;
  fresh: boolean;
  needsProofCall: boolean;
};

const getProofFreshnessMaxHours = (): number => {
  const configured = Number(process.env.PROOF_FRESHNESS_MAX_HOURS || 168);
  return Number.isFinite(configured) && configured > 0 ? configured : 168;
};

const buildProofFreshness = (latestAt: string | Date | null | undefined, completeProofCalls: number): ProofFreshness => {
  const maxAgeHours = getProofFreshnessMaxHours();
  const latestDate = latestAt ? new Date(latestAt) : null;
  const latestCompleteProofAt = latestDate && !Number.isNaN(latestDate.getTime()) ? latestDate.toISOString() : null;
  const ageHours = latestDate && !Number.isNaN(latestDate.getTime())
    ? Math.round(((Date.now() - latestDate.getTime()) / 3_600_000) * 10) / 10
    : null;
  const fresh = completeProofCalls > 0 && ageHours !== null && ageHours <= maxAgeHours;
  return {
    latestCompleteProofAt,
    maxAgeHours,
    ageHours,
    fresh,
    needsProofCall: !fresh,
  };
};

type SetupReadinessItem = {
  key: string;
  label: string;
  complete: boolean;
  nextAction: string;
};

type ActivationStatus = {
  stage: "payment_pending" | "workspace_created" | "setup_required" | "proof_ready" | "proof_complete" | "operator_exception";
  readyForProofCall: boolean;
  customerNextAction: string;
  operatorException: boolean;
  exceptionReason: string | null;
  paymentActive: boolean;
  setupComplete: boolean;
  ownerAlertReady: boolean;
  callbackReady: boolean;
  workspaceId: number | null;
  inviteLink?: string | null;
  checklist: SetupReadinessItem[];
};

const buildSetupReadiness = ({
  workspace,
  workspaceTwilioNumber,
  knowledgeSourceCount = 0,
  proofFreshness,
}: {
  workspace: Workspace;
  workspaceTwilioNumber?: string | null;
  knowledgeSourceCount?: number;
  proofFreshness?: ProofFreshness;
}) => {
  const ownerEmailReady = Boolean(cleanOwnerEmail(workspace.owner_email) || cleanOwnerEmail(workspace.notification_email));
  const serviceArea = String(workspace.service_area || workspace.business_address || "").trim();
  const items: SetupReadinessItem[] = [
    {
      key: "business_profile",
      label: "Business profile",
      complete: Boolean((workspace.business_name || workspace.name || "").trim() && ownerEmailReady),
      nextAction: "Save the business name and real owner or notification email.",
    },
    {
      key: "callback_phone",
      label: "Callback phone",
      complete: Boolean((workspace.owner_phone || workspace.business_phone || "").trim()),
      nextAction: "Add the phone number the owner wants callbacks and escalations to use.",
    },
    {
      key: "service_area",
      label: "Service area",
      complete: Boolean(serviceArea),
      nextAction: "Add the city, region, or service area the agent should reference.",
    },
    {
      key: "operating_hours",
      label: "Operating hours",
      complete: Boolean((workspace.business_hours || "").trim()),
      nextAction: "Add operating hours so the agent can set caller expectations.",
    },
    {
      key: "greeting",
      label: "Inbound greeting",
      complete: Boolean((workspace.inbound_greeting || "").trim()),
      nextAction: "Save the first sentence callers will hear.",
    },
    {
      key: "escalation_preference",
      label: "Escalation preference",
      complete: Boolean((workspace.escalation_preference || "").trim()),
      nextAction: "Choose how urgent calls should be routed to a human.",
    },
    {
      key: "proof_call_target",
      label: "Proof-call target",
      complete: Boolean((workspace.proof_call_target || "").trim()),
      nextAction: "Add the owner-approved phone number for the guarded proof call.",
    },
    {
      key: "call_routing",
      label: "Call routing",
      complete: Boolean(workspaceTwilioNumber || workspace.twilio_phone_number),
      nextAction: "Provision or connect a Twilio phone number for this workspace.",
    },
    {
      key: "owner_notifications",
      label: "Owner notifications",
      complete: Boolean(ownerEmailReady && env.RESEND_API_KEY && env.FROM_EMAIL),
      nextAction: "Set a real owner notification email plus verified Resend sender.",
    },
    {
      key: "workspace_knowledge",
      label: "Workspace knowledge",
      complete: knowledgeSourceCount > 0,
      nextAction: "Upload or paste customer/CRM/business knowledge so the agent stops guessing.",
    },
    {
      key: "setup_wizard",
      label: "Setup wizard",
      complete: Boolean(workspace.setup_completed_at),
      nextAction: "Finish the dashboard setup checklist.",
    },
    {
      key: "fresh_proof_call",
      label: "Fresh proof call",
      complete: proofFreshness ? proofFreshness.fresh : false,
      nextAction: "Run a new proof call that creates a summary, callback task, and owner alert.",
    },
  ];
  const completeCount = items.filter((item) => item.complete).length;
  const nextItem = items.find((item) => !item.complete);
  return {
    ready: completeCount === items.length,
    completeCount,
    totalCount: items.length,
    nextAction: nextItem?.nextAction || "Ready for customer activation.",
    items,
  };
};

const buildActivationStatus = ({
  workspace,
  provisioningRequest,
  setupReadiness,
  proofFreshness,
  workspaceTwilioNumber,
}: {
  workspace?: Workspace | null;
  provisioningRequest?: any | null;
  setupReadiness?: ReturnType<typeof buildSetupReadiness> | null;
  proofFreshness?: ProofFreshness | null;
  workspaceTwilioNumber?: string | null;
}): ActivationStatus => {
  const requestStatus = String(provisioningRequest?.status || "").trim();
  const requestError = String(provisioningRequest?.error || "").trim();
  const workspaceId = Number(workspace?.id || provisioningRequest?.workspace_id || 0) || null;
  const hasWorkspace = Boolean(workspaceId);
  const paymentActive = Boolean(
    workspace?.subscription_status === "active" ||
    workspace?.subscription_status === "trialing" ||
    ["workspace_created", "workspace_and_line_created"].includes(requestStatus) ||
    String(provisioningRequest?.source || "").includes("stripe")
  );
  const ownerEmailReady = Boolean(cleanOwnerEmail(workspace?.owner_email) || cleanOwnerEmail(workspace?.notification_email));
  const ownerAlertReady = Boolean(ownerEmailReady && env.RESEND_API_KEY && env.FROM_EMAIL);
  const callbackReady = Boolean(
    (workspace?.owner_phone || workspace?.business_phone || "").trim() &&
    env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    (workspaceTwilioNumber || env.TWILIO_PHONE_NUMBER)
  );
  const setupComplete = Boolean(setupReadiness?.ready);
  const operatorException = Boolean(
    requestError ||
    requestStatus === "manual_fallback_required" ||
    requestStatus === "pending_auto_fulfillment" ||
    (!hasWorkspace && paymentActive)
  );
  const exceptionReason = requestError || (
    requestStatus === "manual_fallback_required"
      ? "Manual activation is required."
      : requestStatus === "pending_auto_fulfillment"
        ? "Automatic activation is still pending."
        : (!hasWorkspace && paymentActive)
          ? "Payment signal exists but no workspace has been created yet."
          : null
  );
  const readyForProofCall = Boolean(hasWorkspace && paymentActive && setupComplete && ownerAlertReady && callbackReady);
  const stage: ActivationStatus["stage"] = operatorException
    ? "operator_exception"
    : proofFreshness?.fresh
      ? "proof_complete"
      : readyForProofCall
        ? "proof_ready"
        : hasWorkspace
          ? "setup_required"
          : paymentActive
            ? "workspace_created"
            : "payment_pending";
  const customerNextAction = stage === "operator_exception"
    ? "SMIRK support needs to finish this activation manually."
    : stage === "proof_complete"
      ? "Activation proof is complete. Keep the workspace live and monitor callbacks."
      : stage === "proof_ready"
        ? "Run the guarded proof call from the approved proof-call flow."
        : stage === "setup_required"
          ? (setupReadiness?.nextAction || "Finish workspace setup.")
          : stage === "workspace_created"
            ? "Open the workspace invite and finish setup."
            : "Complete checkout to create the workspace.";
  return {
    stage,
    readyForProofCall,
    customerNextAction,
    operatorException,
    exceptionReason,
    paymentActive,
    setupComplete,
    ownerAlertReady,
    callbackReady,
    workspaceId,
    inviteLink: provisioningRequest?.invite_link || null,
    checklist: setupReadiness?.items || [],
  };
};

const recordActivationStageEvent = async ({
  workspaceId,
  provisioningRequestId,
  activationStatus,
}: {
  workspaceId: number;
  provisioningRequestId?: number | null;
  activationStatus: ActivationStatus;
}): Promise<void> => {
  const stage = activationStatus.stage;
  const eventType = stage === "operator_exception"
    ? "operator_exception"
    : stage === "proof_complete"
      ? "proof_complete"
      : stage === "proof_ready"
        ? "proof_ready"
        : stage === "setup_required"
          ? "setup_required"
          : stage;
  const status = stage === "operator_exception"
    ? "blocked"
    : stage === "proof_complete"
      ? "complete"
      : "info";
  await createActivationEventIfChanged({
    workspace_id: workspaceId,
    provisioning_request_id: provisioningRequestId || null,
    event_type: eventType,
    status,
    actor: "system",
    detail: {
      activation_stage: stage,
      ready_for_proof_call: activationStatus.readyForProofCall,
      customer_next_action: activationStatus.customerNextAction,
      exception_reason: activationStatus.exceptionReason,
    },
  }).catch((err: any) => {
    log("warn", "Failed to record activation stage event", {
      workspaceId,
      stage,
      error: err?.message || String(err),
    });
  });
};

const sendOutboundCallConfirmationEmail = async ({
  workspaceId,
  to,
  reason,
  notes,
  callSid,
  source,
}: {
  workspaceId: number;
  to: string;
  reason?: string | null;
  notes?: string | null;
  callSid: string;
  source: string;
}): Promise<{ sent: boolean; recipientCount: number }> => {
  const resendKey = env.RESEND_API_KEY;
  const fromEmail = env.FROM_EMAIL || "SMIRK <alerts@smirkcalls.com>";
  if (!resendKey || !fromEmail) return { sent: false, recipientCount: 0 };

  const toList = await getOwnerAlertRecipients(workspaceId);
  if (toList.length === 0) return { sent: false, recipientCount: 0 };

  const reasonText = reason?.trim() || "Not specified";
  const notesText = notes?.trim() || "None";
  const dashboardUrl = `${getAppUrl()}/dashboard`;
  const html = [
    "<h2>Outbound call started</h2>",
    `<p><strong>To:</strong> ${to}</p>`,
    `<p><strong>Reason:</strong> ${reasonText.replace(/</g, "&lt;")}</p>`,
    `<p><strong>Notes:</strong> ${notesText.replace(/</g, "&lt;")}</p>`,
    `<p><strong>Source:</strong> ${source.replace(/</g, "&lt;")}</p>`,
    `<p><strong>Call SID:</strong> ${callSid}</p>`,
    `<p><a href="${dashboardUrl}">Open SMIRK dashboard</a></p>`,
  ].join("");
  const text = [
    "Outbound call started",
    `To: ${to}`,
    `Reason: ${reasonText}`,
    `Notes: ${notesText}`,
    `Source: ${source}`,
    `Call SID: ${callSid}`,
    `Dashboard: ${dashboardUrl}`,
  ].join("\n");

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: formatSenderEmail(fromEmail),
      to: toList,
      subject: `SMIRK outbound call started: ${to}`,
      text,
      html,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Resend returned ${resp.status}: ${await resp.text()}`);
  }
  return { sent: true, recipientCount: toList.length };
};

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

// ── Default System Prompt: Home Services Missed-Call Recovery ───────────────
const HOME_SERVICES_SYSTEM_PROMPT = `You are SMIRK, a missed-call recovery assistant for a home services company (HVAC, plumbing, roofing, electrical, and general repairs).

Your ONE job: answer missed calls, collect the caller's info, and prepare a callback-ready lead for the business owner.

CORE FLOW:
1. Greet warmly, state what you can do, and ask one specific question about what they need.
2. Collect: name, best callback number, service type (HVAC / plumbing / roofing / electrical / other), address or service area if relevant, and whether it's urgent or can wait.
3. Ask for any details the owner needs before calling back, such as symptoms, timing, access notes, or safety concerns.
4. Confirm the callback out loud: "Thanks, I have what we need. The owner will call you back as soon as possible."
5. Confirm the next step clearly: callback, owner review, or escalation.
6. Thank them and end the call.

TOOL USAGE:
- Use create_lead to capture caller info as soon as you have name + service type.
- Use set_callback once you have the best callback number and urgency.
- Use add_note to log anything unusual or important.
- Use book_appointment ONLY if this workspace explicitly supports booking and the caller gives a specific date + time window.
- Use escalate_to_human ONLY if: (a) the caller explicitly asks for a human, or (b) you have failed to help twice in a row. Never transfer for confusion or slow responses.

PERSONALITY:
- Friendly, efficient, and confident. No filler words.
- Never say "I cannot" — say what you CAN do.
- Do not end with vague phrases or question tails like "maybe?", "or something?", "I guess?", or "and that?".
- Every response must either ask one concrete next question or confirm one concrete saved next step.
- Never quote prices. "Our technician will discuss pricing when they arrive."
- Keep every response under 3 sentences.`;

const toOpenAiToolSchema = (schema: any): any => {
  if (!schema || typeof schema !== "object") return schema;
  const out: any = Array.isArray(schema) ? [] : {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type" && typeof value === "string") {
      out[key] = value.toLowerCase();
    } else if (key === "properties" && value && typeof value === "object") {
      out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toOpenAiToolSchema(v)]));
    } else if (Array.isArray(value)) {
      out[key] = value.map(toOpenAiToolSchema);
    } else if (value && typeof value === "object") {
      out[key] = toOpenAiToolSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
};

const builtInToolsToOpenRouter = () => TOOL_DECLARATIONS.map((tool: any) => ({
  name: tool.name,
  description: tool.description,
  parameters: toOpenAiToolSchema(tool.parameters || { type: "object", properties: {} }),
}));

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
/**
 * Strip markdown formatting so Polly/TTS doesn't read asterisks, underscores, etc. aloud.
 */
const stripMarkdownForTts = (text: string): string => {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold**
    .replace(/\*(.+?)\*/g, '$1')        // *italic*
    .replace(/\_\_(.+?)\_\__/g, '$1')  // __bold__
    .replace(/\_(.+?)\_/g, '$1')        // _italic_
    .replace(/`{1,3}[^`]*`{1,3}/g, '')  // `code` or ```code```
    .replace(/#+\s+/g, '')              // ## headings
    .replace(/^[-*+]\s+/gm, '')         // bullet points
    .replace(/^\d+\.\s+/gm, '')         // numbered lists
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [link text](url)
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '') // images
    .replace(/>{1,}\s?/g, '')           // blockquotes
    .replace(/---+/g, '')               // horizontal rules
    .replace(/\n{2,}/g, ' ')            // multiple newlines → space
    .replace(/\n/g, ' ')                // single newlines → space
    .trim();
};

const buildTwimlSay = async (
  node: { play: (url: string) => any; say: (opts: any, text?: string) => any },
  text: string,
  _voice: string,
  agentName?: string
): Promise<void> => {
  // Strip markdown so TTS doesn't read asterisks, underscores, etc. aloud
  text = stripMarkdownForTts(text);
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
  // NOTE: Disabled when ElevenLabs account is on free tier / flagged — wastes 2-3s on failed API calls
  if (elevenLabsConfig && process.env.ELEVENLABS_ENABLED !== 'false') {
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
  // NOTE: Disabled when Google Cloud billing is not enabled
  if (googleTTSConfig && process.env.GOOGLE_TTS_ENABLED !== 'false') {
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

const buildLiveCallSpeech = async (
  node: { play: (url: string) => any; say: (opts: any, text?: string) => any },
  text: string,
  voice: string,
  agentName?: string
): Promise<void> => {
  if (FAST_LIVE_CALLS) {
    node.say({ voice: FAST_LIVE_CALL_TTS_VOICE as any }, stripMarkdownForTts(text));
    return;
  }
  await buildTwimlSay(node, text, voice, agentName);
};

// ── Active Call Kill Timers (15-min watchdog) ────────────────────────────────
const activeCallTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Tracks consecutive dead-air turns per call (separate from global turn_count)
// Reset when real speech is received or call ends
const deadAirCounts = new Map<string, number>();
const callErrorCounts = new Map<string, number>(); // track consecutive AI errors per call

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



registerTwimlRoutes(app, {
  sql,
  dbEnabled: DB_ENABLED,
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
  agentName: string,
  wsAiKeys?: import("./src/workspace-ai-keys.js").WorkspaceAiKeys
): Promise<{ audioIds: string[]; fullText: string; latencyMs: number; firstChunkMs?: number }> {
  const effectiveStreamOpenRouterConfig = wsAiKeys
    ? buildWorkspaceOpenRouterConfig(wsAiKeys, openRouterConfig)
    : openRouterConfig;
  const effectiveElevenLabsConfig = wsAiKeys
    ? buildWorkspaceElevenLabsConfig(wsAiKeys, elevenLabsConfig)
    : elevenLabsConfig;
  if (!effectiveStreamOpenRouterConfig?.enabled && !openClawConfig?.enabled) {
    throw new Error("No streaming AI provider configured (OpenRouter or OpenClaw required)");
  }

  const start = Date.now();
  const audioIds: string[] = [];
  const sentences: string[] = [];
  let firstChunkMs: number | undefined;

  // Determine TTS synthesizer: Cartesia > ElevenLabs > Google > OpenAI
  // ElevenLabs/Google only attempted when explicitly enabled via env flag
  const synthesize = async (text: string): Promise<Buffer | null> => {
    if (cartesiaConfig) {
      try {
        return await generateCartesiaSpeech(text, cartesiaConfig, agentName);
      } catch { /* fall through */ }
    }
    if (effectiveElevenLabsConfig && process.env.ELEVENLABS_ENABLED !== 'false') {
      try {
        return await generateSpeech(text, effectiveElevenLabsConfig, agentName);
      } catch (err: any) {
        const classified = classifyAiKeyError(err, wsAiKeys?.elevenLabsIsWorkspaceKey ?? false, wsAiKeys?.workspaceId ?? 0, "elevenlabs");
        if (classified.isKeyError) throw new Error(classified.message);
        /* fall through */
      }
    }
    if (googleTTSConfig && process.env.GOOGLE_TTS_ENABLED !== 'false') {
      const googleVoice = getGoogleAgentVoice(agentName);
      try {
        return await generateGoogleSpeech(text, { ...googleTTSConfig, voice: googleVoice });
      } catch { /* fall through */ }
    }
    if (openAITTSConfig) {
      const openAIVoice = getAgentVoice(agentName);
      try {
        return await generateOpenAISpeech(text, { ...openAITTSConfig, voice: openAIVoice });
      } catch { /* fall through */ }
    }
    return null; // Caller in streamingTtsPipeline will fall back to Polly <Say>
  };

  // Fire TTS requests as sentences arrive, collect promises in order
  const ttsPromises: Promise<{ id: string | null; sentence: string }>[] = [];

  const stream = streamOpenRouter(
    effectiveStreamOpenRouterConfig!,
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
        
        const bridgeWsId = await getWorkspaceIdByToNumber(event.to || "").catch(() => 1) || 1;
        await sql`
          INSERT INTO calls (call_sid, direction, to_number, from_number, status, agent_name, contact_id, workspace_id)
          VALUES (${event.callId}, 'inbound', ${event.to || ""}, ${event.from || ""}, 'in-progress', ${agent?.name || "Default Assistant"}, ${contact.id}, ${bridgeWsId})
          ON CONFLICT (call_sid) DO UPDATE SET status = 'in-progress', contact_id = ${contact.id}, workspace_id = ${bridgeWsId}
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
          const rows = await sql`SELECT contact_id, workspace_id FROM calls WHERE call_sid = ${event.callId}`;
          const endedRecord = rows[0];
          const bridgeWsId = (endedRecord as any)?.workspace_id || 1;
          const bridgeKeys = await resolveWorkspaceAiKeys(bridgeWsId, {
            geminiApiKey: env.GEMINI_API_KEY,
            openrouterApiKey: env.OPENROUTER_API_KEY,
            elevenLabsApiKey: env.ELEVENLABS_API_KEY,
          });
          if (bridgeKeys.geminiApiKey) {
            runPostCallIntelligence(event.callId, (endedRecord as any)?.contact_id ?? null, bridgeKeys.geminiApiKey).catch((err: any) =>
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
  callerPhone: string,
  wsAiKeys?: import("./src/workspace-ai-keys.js").WorkspaceAiKeys
): Promise<{ text: string; latencyMs: number; toolsInvoked: string[]; shouldHangUp: boolean; transferPhone?: string | null; transferName?: string | null; source: "openclaw" | "gemini" }> {
  // Resolve effective AI keys: workspace-specific keys take priority over global env vars.
  // If a workspace key is set but fails (auth error), we throw workspace-scoped — no silent fallback.
  const effectiveGeminiKey = wsAiKeys?.geminiApiKey ?? geminiApiKey;
  const effectiveOpenRouterConfig = wsAiKeys
    ? buildWorkspaceOpenRouterConfig(wsAiKeys, openRouterConfig)
    : openRouterConfig;
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


  // ── OpenRouter — Primary Brain (no quota limits) ────────────────────────────
  if (effectiveOpenRouterConfig?.enabled) {
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
        ...builtInToolsToOpenRouter(),
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
            headers: { "Authorization": `Bearer ${effectiveOpenRouterConfig!.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: effectiveOpenRouterConfig!.model,
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
            logEvent(callSid, "OPENROUTER_RESPONSE", { latencyMs: Date.now() - loopStart, model: effectiveOpenRouterConfig!.model, toolsInvoked, rounds: round + 1 });
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
                    const transferData = r.data;
                    messages.push({ role: "tool", tool_call_id: tc.id, content: String(toolResult) });
                    // Get final text then hang up
                    const finalResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                      method: "POST",
                      headers: { "Authorization": `Bearer ${effectiveOpenRouterConfig!.apiKey}`, "Content-Type": "application/json" },
                      body: JSON.stringify({ model: effectiveOpenRouterConfig!.model, messages, temperature: 0.4, max_tokens: 128 }),
                    });
                    const finalData = await finalResp.json() as any;
                    return {
                      text: finalData.choices?.[0]?.message?.content || r.message,
                      latencyMs: Date.now() - loopStart,
                      toolsInvoked,
                      shouldHangUp: true,
                      transferPhone: typeof transferData?.transfer_phone === "string" ? transferData.transfer_phone : null,
                      transferName: typeof transferData?.transfer_name === "string" ? transferData.transfer_name : null,
                      source: "openclaw" as const,
                    };
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
          headers: { "Authorization": `Bearer ${effectiveOpenRouterConfig!.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: effectiveOpenRouterConfig!.model, messages, temperature: 0.4, max_tokens: 256 }),
        });
        const exhaustedData = await exhaustedResp.json() as any;
        const exhaustedText = exhaustedData.choices?.[0]?.message?.content || "I've handled everything. Is there anything else I can help with?";
        return { text: exhaustedText, latencyMs: Date.now() - loopStart, toolsInvoked, shouldHangUp: false, source: "openclaw" as const };
      }

      // No extra tools — plain query
      const result = await queryOpenRouter(effectiveOpenRouterConfig!, fullPrompt, history, speechText);
      logEvent(callSid, "OPENROUTER_RESPONSE", { latencyMs: result.latencyMs, model: result.model, tokensUsed: result.tokensUsed });
      return { text: result.text, latencyMs: result.latencyMs, toolsInvoked: [], shouldHangUp: false, source: "openclaw" as const };
    } catch (err: any) {
      const classified = classifyAiKeyError(err, wsAiKeys?.openrouterIsWorkspaceKey ?? false, wsAiKeys?.workspaceId ?? 0, "openrouter");
      if (classified.isKeyError) {
        log("error", classified.message, { callSid, requestId });
        logEvent(callSid, "OPENROUTER_KEY_ERROR", { workspaceId: wsAiKeys?.workspaceId, error: classified.message });
        throw new Error(classified.message);
      }
      log("warn", "OpenRouter failed — falling back to Gemini", { requestId, callSid, error: err.message });
      logEvent(callSid, "OPENROUTER_FALLBACK", { error: err.message });
    }
  }

  // ── Gemini function-calling (fallback if OpenRouter unavailable) ─────────────
  if (effectiveGeminiKey) {
    const result = await generateAiResponseWithTools(
      callSid,
      speechText,
      requestId,
      callerContext,
      systemPrompt,
      dispatchCtx,
      effectiveGeminiKey
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

registerOutboundCallRoutes(app, {
  dashboardAuth,
  callRateLimit,
  requireTestCallSecret,
  outboundCallSchema: OutboundCallSchema,
  env,
  sql,
  getWorkspaceId,
  checkOutboundCompliance,
  getTwilioClient,
  getAppUrl,
  getActiveAgent,
  resolveContact,
  sendOutboundCallConfirmationEmail,
  logEvent,
  log,
});

registerTwilioOpsRoutes(app, {
  dashboardAuth,
  requireOperator,
  env,
  getTwilioClient,
  getAppUrl,
  getActiveAgent,
  resolveContact,
  buildCallerContext,
  generateAiResponse,
  buildTwimlSay,
  logEvent,
  log,
});

registerSmsRoutes(app, {
  dashboardAuth,
  requireOperator,
  validateTwilio: twilioValidate,
  sql,
  dbEnabled: DB_ENABLED,
  env,
  getWorkspaceId,
  getWorkspaceIdByToNumber,
  getTwilioClient,
  getAppUrl,
  log,
});

registerTwilioStatusRoutes(app, {
  sql,
  env,
  getWorkspaceId,
  getWorkspaceMode,
  terminalCallStatuses: TERMINAL_CALL_STATUSES,
  deadAirCounts,
  activeCallTimers,
  finalizeCallBySid,
  incrementWorkspaceUsage,
  resolveWorkspaceAiKeys,
  runPostCallIntelligence,
  detectOptOut,
  fireCallWebhooks,
  getConfiguredCrms,
  syncAllCrms,
  cleanOwnerEmail,
  getOwnerAlertRecipients,
  formatSenderEmail,
  getAppUrl,
  logEvent,
  log,
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
  const prompt = `You are generating a phone greeting for a missed-call recovery assistant. Output ONLY the greeting — one sentence, max 25 words. Natural spoken English. No markdown, no quotes. Do not start with "Hello" or "Hi there". Use the caller's name if known. If there are open follow-up items, reference them briefly. Match tone to the agent persona.\n\n${lines.join("\n")}`;
  try {
    const result = await Promise.race([
      ai.models.generateContent({
        model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
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

async function bufferTwilioWebhookEvent(input: {
  callSid: string;
  webhookType: string;
  workspaceId?: number | null;
  from?: string | null;
  to?: string | null;
  direction?: string | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  if (!DB_ENABLED || !input.callSid) return;
  try {
    await sql`
      INSERT INTO webhook_event_buffer (
        call_sid,
        webhook_type,
        workspace_id,
        from_number,
        to_number,
        direction,
        payload,
        updated_at
      ) VALUES (
        ${input.callSid},
        ${input.webhookType},
        ${input.workspaceId ?? null},
        ${input.from || null},
        ${input.to || null},
        ${input.direction || null},
        ${sql.json(input.payload || {})},
        NOW()
      )
      ON CONFLICT (call_sid, webhook_type)
      DO UPDATE SET
        workspace_id = COALESCE(EXCLUDED.workspace_id, webhook_event_buffer.workspace_id),
        from_number = COALESCE(EXCLUDED.from_number, webhook_event_buffer.from_number),
        to_number = COALESCE(EXCLUDED.to_number, webhook_event_buffer.to_number),
        direction = COALESCE(EXCLUDED.direction, webhook_event_buffer.direction),
        payload = EXCLUDED.payload,
        updated_at = NOW()
    `;
  } catch (err: any) {
    log("warn", "Twilio webhook buffer write skipped", {
      callSid: input.callSid,
      webhookType: input.webhookType,
      error: err?.message || String(err),
    });
  }
}

// ── Twilio Webhook: Incoming / Outbound Connectedd ─────────────────────────────
app.post("/api/twilio/incoming", async (req: Request, res: Response) => {
  const webhookStartedAt = Date.now();
  try {
  const { CallSid, To, From, Direction } = req.body;
  log("info", "Incoming call webhook received", { callSid: CallSid, from: From, to: To, direction: Direction });
  bufferTwilioWebhookEvent({
    callSid: String(CallSid || ""),
    webhookType: "twilio.incoming",
    from: From ? String(From) : null,
    to: To ? String(To) : null,
    direction: Direction ? String(Direction) : null,
    payload: req.body as Record<string, unknown>,
  }).catch(() => {});

  // Dedicated-number per customer: route by the Twilio "To" number.
  // For outbound calls (Direction=outbound-api), Twilio sets To=destination and From=our number.
  // Workspace lookup must use our number (From on outbound, To on inbound).
  const lookupNumber = Direction === "outbound-api" ? String(From || "") : String(To || "");
  const routedWsId = await getWorkspaceIdByToNumber(lookupNumber).catch(() => null);
  if (routedWsId) {
    bufferTwilioWebhookEvent({
      callSid: String(CallSid || ""),
      webhookType: "twilio.incoming",
      workspaceId: routedWsId,
      from: From ? String(From) : null,
      to: To ? String(To) : null,
      direction: Direction ? String(Direction) : null,
      payload: req.body as Record<string, unknown>,
    }).catch(() => {});
  }
  if (!routedWsId) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("We're sorry, this line is not configured yet. Please try again later.");
    twiml.hangup();
    res.type("text/xml");
    return res.send(twiml.toString());
  }
  // Attach workspace id to request so downstream calls can use getWorkspaceId(req)
  (req.headers as any)["x-workspace-id"] = String(routedWsId);

  // Usage limit check — block call if workspace has hit monthly cap
  try {
    const usageLimits = await checkUsageLimits(routedWsId);
    if (!usageLimits.allowed) {
      log("info", "Call blocked by usage limits", { workspaceId: routedWsId, reason: usageLimits.reason, callSid: CallSid });
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say("We\'re sorry, we\'re unable to take your call right now. Please try again later or contact us directly.");
      twiml.hangup();
      res.type("text/xml");
      return res.send(twiml.toString());
    }
    if (usageLimits.billingWarning) {
      log("warn", "Call allowed with billing warning", {
        workspaceId: routedWsId,
        subscriptionStatus: usageLimits.subscriptionStatus,
        warning: usageLimits.billingWarning,
        callSid: CallSid,
      });
    }
  } catch (usageErr: any) {
    log("warn", "Usage limit check failed — allowing call", { workspaceId: routedWsId, error: usageErr.message });
  }

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
    INSERT INTO calls (call_sid, direction, to_number, from_number, status, agent_name, contact_id, workspace_id)
    VALUES (${CallSid}, ${Direction === "outbound-api" ? "outbound" : "inbound"}, ${To}, ${From}, 'in-progress', ${process.env.AGENT_NAME || agent?.name || "SMIRK"}, ${contact.id}, ${routedWsId})
    ON CONFLICT (call_sid) DO NOTHING
  `;

  await sql`UPDATE calls SET status = 'in-progress', contact_id = ${contact.id}, openclaw_agent_id = ${openclawAgentIdForCall} WHERE call_sid = ${CallSid}`;

  // ── Call Classification: determine personal vs professional vs spam ─────────
  classifyCallAtStart(CallSid, callerPhone, contact as any, isNew, 1)
    .then((callClassification) => {
      if (callClassification) {
        storeClassification(CallSid, callClassification.classification, callClassification.confidence).catch(() => {});
      }
    })
    .catch(() => {});

  // ── Context snapshot: freeze temporary_context at call start to prevent mid-call instability ──
  // Any Boss Mode briefings that expire or get rolled back AFTER this point won't affect this call.
  if (!FAST_LIVE_CALLS) {
    const snapshotCtx = await getActiveTemporaryContext(1);
    if (snapshotCtx) {
      await sql`UPDATE calls SET context_snapshot = ${snapshotCtx} WHERE call_sid = ${CallSid}`;
    }
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
  // ── Resolve per-workspace greeting identity (DB-first, env fallback) ──
  let _wsProfileForGreeting: Workspace | null = null;
  try { _wsProfileForGreeting = await getCachedWorkspaceById(routedWsId || 1); } catch { /* non-fatal */ }
  let _bizName = _wsProfileForGreeting?.business_name || process.env.BUSINESS_NAME || "";
  if (Direction === "outbound-api" && !_bizName) {
    const bizCtxRows = await sql<{ text: string }[]>`SELECT text FROM messages WHERE call_sid = ${CallSid} AND role = 'system' LIMIT 1`.catch(() => []);
    const bizMatch = bizCtxRows[0]?.text?.match(/\[BUSINESS_NAME\]\s*(.+)/)?.[1]?.trim();
    if (bizMatch) _bizName = bizMatch;
  }
  const _agentName = _wsProfileForGreeting?.agent_name || process.env.AGENT_NAME || agent?.name || "SMIRK";

  // ── Static fallback greeting (used if dynamic generation is disabled or times out) ──
  const staticGreeting = renderWorkspaceGreeting({
    direction: Direction === "outbound-api" ? "outbound" : "inbound",
    workspace: _wsProfileForGreeting,
    businessName: _bizName,
    agentName: _agentName,
    agentGreeting: agent?.greeting,
  });

  // ── Dynamic greeting: disabled by default for faster live-call pickup.
  // Set FAST_LIVE_CALLS=false to restore the LLM greeting path.
  let outboundCallReason: string | undefined;
  let dynamicGreeting: string | null = null;
  if (!FAST_LIVE_CALLS && Direction === "outbound-api") {
    const ctxForGreeting = await sql<{ text: string }[]>`
      SELECT text FROM messages WHERE call_sid = ${CallSid} AND role = 'system' LIMIT 1
    `.catch(() => []);
    outboundCallReason = ctxForGreeting[0]?.text?.match(/\[CALL REASON\]\s*(.+)/)?.[1]?.trim();
  }
  if (!FAST_LIVE_CALLS) {
    dynamicGreeting = await generateDynamicGreeting({
      contact,
      isNew,
      isOutbound: Direction === "outbound-api",
      agentName: _agentName,
      bizName: _bizName,
      callReason: outboundCallReason,
    });
  }
  const greeting = dynamicGreeting || staticGreeting;
  logEvent(CallSid, dynamicGreeting ? "DYNAMIC_GREETING_USED" : "STATIC_GREETING_USED", { greeting: greeting.slice(0, 80), fastLiveCalls: FAST_LIVE_CALLS });
  const voice = agent?.voice || "Polly.Matthew-Neural";
  const language = (agent?.language || "en-US") as any;

  // Barge-in friendly: put the prompt INSIDE <Gather> so caller speech is captured
  // even if they start talking over the greeting.
  const g: any = twiml.gather({
    input: ["speech"],
    action: `${appUrl}/api/twilio/process`,
    method: "POST",
    timeout: 12,                  // give caller time to respond after greeting finishes
    speechTimeout: "auto" as any, // Twilio decides when speech ends — more natural
    bargeIn: true as any,         // caller can interrupt the greeting immediately
    speechModel: "phone_call",
    enhanced: true,
    language,
    actionOnEmptyResult: true as any, // loop back instead of hanging up on silence
    hints: ["SMIRK", "demo", "pricing", "call", "appointment", "schedule", "AI", "phone agent", "Cameron", "sales", "support", "billing"] as any,
  });
  await buildLiveCallSpeech(g, greeting, voice, agentName);

  // actionOnEmptyResult:true on the Gather above handles the no-speech case —
  // it calls the action URL automatically. No Redirect needed here.
  res.type("text/xml");
  res.send(twiml.toString());
  log("info", "Incoming call TwiML sent", { callSid: CallSid, latencyMs: Date.now() - webhookStartedAt, fastLiveCalls: FAST_LIVE_CALLS });
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

const getLatestHandoffTransferTarget = async (callSid: string): Promise<{ phone: string | null; name: string | null } | null> => {
  try {
    const rows = await sql<{ assigned_to_phone: string | null; assigned_to_name: string | null }[]>`
      SELECT assigned_to_phone, assigned_to_name
      FROM handoffs
      WHERE call_sid = ${callSid}
        AND assigned_to_phone IS NOT NULL
        AND TRIM(assigned_to_phone) != ''
      ORDER BY id DESC
      LIMIT 1
    `;
    const row = rows[0];
    return row ? { phone: row.assigned_to_phone, name: row.assigned_to_name } : null;
  } catch {
    return null;
  }
};

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
    // Load context — always load by call_sid, not gated on contactId.
    // contactId can be null for outbound calls that haven't resolved a contact yet,
    // but the [CONTEXT] message is always stored by call_sid at call start.
    let callerContext = "";
    const ctxRows = await sql<{ text: string }[]>`
      SELECT text FROM messages WHERE call_sid = ${callSid} AND role = 'system' AND text LIKE '[CONTEXT]%' LIMIT 1
    `;
    callerContext = ctxRows[0]?.text?.replace("[CONTEXT]", "") || "";
    const callerPhoneRows = await sql`SELECT from_number, direction, to_number, workspace_id FROM calls WHERE call_sid = ${callSid}`;
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

    // ── Workspace-aware prompt selection ─────────────────────────────────────
    // If the call's workspace has its own active agent with a system_prompt set,
    // use that instead of the global AGENT_PERSONA env var (SOUL.md).
    // This allows per-workspace personas without changing Railway env vars.
    const callWorkspaceId = (callerPhone?.workspace_id as number) || 1;
    let wsProfile: Workspace | null = null;
    try { wsProfile = await getCachedWorkspaceById(callWorkspaceId); } catch { /* non-fatal */ }
    let workspaceAgentPrompt: string | null = null;
    if (callWorkspaceId) {
      try {
        const wsAgentRows = await sql<{ system_prompt: string | null }[]>`
          SELECT system_prompt FROM agent_configs
          WHERE workspace_id = ${callWorkspaceId} AND is_active = true
          ORDER BY id ASC LIMIT 1
        `;
        const wsPrompt = wsAgentRows[0]?.system_prompt?.trim();
        if (wsPrompt) workspaceAgentPrompt = wsPrompt;
      } catch { /* non-fatal — fall through to global prompt */ }
    }
    const workspacePersona = wsProfile?.agent_persona?.trim() || "";
    // Priority: workspace-specific agent prompt > workspace setup persona > AGENT_PERSONA (SOUL.md) > DB agent > fallback
    const soulPrompt = process.env.AGENT_PERSONA || "";
    const basePrompt = workspaceAgentPrompt || workspacePersona || soulPrompt || agent?.system_prompt || HOME_SERVICES_SYSTEM_PROMPT;

    // ── Per-workspace AI key resolution (cached, TTL 5 min) ─────────────────
    // Workspace-specific keys override global env vars. If a workspace key is
    // set but invalid, we fail fast (no silent fallback to global key).
    const wsAiKeys = await resolveWorkspaceAiKeys(callWorkspaceId, {
      geminiApiKey: env.GEMINI_API_KEY,
      openrouterApiKey: env.OPENROUTER_API_KEY,
      elevenLabsApiKey: env.ELEVENLABS_API_KEY,
    });

    // ── Identity injection: per-workspace DB fields, fall back to global env vars ──
    // Workspace DB fields take priority — this is what makes multi-tenancy work.
    // Global env vars are the operator fallback for workspaces that haven't completed setup.
    const bizName = wsProfile?.business_name || process.env.BUSINESS_NAME || "";
    const bizTagline = wsProfile?.business_tagline || process.env.BUSINESS_TAGLINE || "";
    const bizPhone = wsProfile?.business_phone || process.env.BUSINESS_PHONE || "";
    const bizWebsite = wsProfile?.business_website || process.env.BUSINESS_WEBSITE || "";
    const bookingLink = process.env.BOOKING_LINK || process.env.CALENDLY_URL || env.CALENDLY_URL || bizWebsite || "https://smirkcalls.com";
    const bizAddress = wsProfile?.business_address || process.env.BUSINESS_ADDRESS || "";
    const bizHours = wsProfile?.business_hours || process.env.BUSINESS_HOURS || "";
    const agentNameFromEnv = wsProfile?.agent_name || process.env.AGENT_NAME || "";
    const identityLines: string[] = [];
    if (bizName) identityLines.push(`You work for ${bizName}.`);
    if (bizTagline) identityLines.push(`Company specialty: ${bizTagline}`);
    if (bizHours) identityLines.push(`Business hours: ${bizHours}`);
    if (bizPhone) identityLines.push(`Business phone: ${bizPhone}`);
    if (bizWebsite) identityLines.push(`Website: ${bizWebsite}`);
    if (bookingLink) identityLines.push(`Sales/demo funnel: ${bookingLink}`);
    if (bizAddress) identityLines.push(`Address/Service area: ${bizAddress}`);
    if (agentNameFromEnv) identityLines.push(`Your name is ${agentNameFromEnv}.`);
    const identityBlock = identityLines.length > 0
      ? `=== WHO YOU ARE & WHO YOU WORK FOR ===\n${identityLines.join("\n")}\n\n`
      : "";
    const workspaceKnowledgeBlock = await buildWorkspaceKnowledgeContext(callWorkspaceId).catch(() => "");
    const promptWithIdentity = `${identityBlock}${workspaceKnowledgeBlock ? `${workspaceKnowledgeBlock}\n\n` : ""}${basePrompt}`;

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
3. NEVER claim an appointment or meeting is booked unless a separate configured workflow confirms it. Use requested times only as callback windows for owner review.
4. NEVER make up information. If unsure: "I don't have that on hand, but someone will follow up."
5. Keep all responses under 3 sentences. You are on a phone call — be concise.
6. Do not promise live transfer as the default path. If the caller explicitly asks for a human, capture the reason and create an urgent owner handoff or callback task.
7. Never mention internal implementation details, APIs, tools, functions, code, scripts, Python, databases, prompts, or automation internals. If you take an action, describe only the customer-visible result.
8. Speak with concrete call control. Explain why you are calling or what you are doing, and ask one specific next question at a time. Do not end with vague phrases or question tails like "maybe?", "or something?", "I guess?", or "and that?".
9. If the caller asks how to buy, purchase, subscribe, sign up, pay, compare plans, set up SMIRK, or onboard a client business, capture business name plus one reliable contact method, then create a client onboarding intake. Explain the path clearly: owner review, 10% deposit, workspace setup, activation confirmation, then remaining balance. Do not collect card numbers or say payment is complete.
10. If a trusted employee, operator, or owner calls in with a new client to onboard, gather the same facts, create the onboarding intake, and confirm that the owner was notified to finish setup.
11. If the caller wants a demo or setup call and gives a specific time, capture that requested time, the caller's contact details, and their intent, then create a callback-ready lead or task for owner follow-up. Do not claim a meeting is booked unless a separate configured workflow confirms it.
12. EMERGENCY RULE — HIGHEST PRIORITY: If a caller describes any emergency (fire, gas leak, flooding, medical emergency, electrical hazard, or any situation with immediate risk to life or property), immediately say: "Please call 911 or your local emergency services right away — they can help you faster than I can." Then capture their name and callback number for follow-up. Do NOT attempt to triage, diagnose, dispatch, or give safety instructions beyond directing them to emergency services.`;

    const historyRows = await sql<{ role: string; text: string }[]>`
      SELECT role, text FROM messages WHERE call_sid = ${callSid} AND role IN ('user','assistant') ORDER BY id ASC LIMIT 20
    `;
    const conversationHistory = historyRows.map((m) => ({ role: m.role as "user" | "assistant", content: m.text }));
    // ── Inject call classification and reward context ──────────────────────────
    let classificationBlock = "";
    try {
      const classRows = await sql<{ call_class: string | null; call_class_confidence: number | null }[]>`
        SELECT call_class, call_class_confidence FROM calls WHERE call_sid = ${callSid} LIMIT 1
      `;
      const storedClass = classRows[0]?.call_class;
      const storedConf = classRows[0]?.call_class_confidence || 0;
      if (storedClass) {
        const isPersonal = storedClass === 'personal' || storedClass === 'vip';
        const shouldForward = storedClass === 'vip';
        const routingHint = storedClass === 'personal' ? 'Screen then offer to connect to Cameron'
          : storedClass === 'vip' ? 'Connect to Cameron immediately'
          : storedClass === 'spam' ? 'End call quickly'
          : 'Handle as SMIRK business inquiry';
        classificationBlock = `\n\n=== CALL CLASSIFICATION ===\nType: ${storedClass}\nConfidence: ${Math.round(storedConf * 100)}%\nRouting: ${routingHint}\n${shouldForward ? 'Forward urgency: high' : 'Handle this call yourself.'}\n=== END CLASSIFICATION ===`;
      }
    } catch (e) { /* non-critical */ }
    // Reward context REMOVED from runtime prompt — evaluated out-of-band post-call only
    const fullSystemPrompt = `${systemPrompt}\n\nCaller context: ${callerContext || "New caller"}${classificationBlock}`;

    let aiText = "";
    let usedStreaming = false;

    // Deterministic human handoff: explicit transfer requests must not depend on
    // whether OpenClaw/OpenRouter/Gemini decides to call a tool.
    const explicitTransferRequest = detectExplicitHumanTransferRequest(speechResult);
    if (explicitTransferRequest) {
      logEvent(callSid, "EXPLICIT_HUMAN_TRANSFER_REQUESTED", {
        topic: explicitTransferRequest.topic || null,
        matchedPhrase: explicitTransferRequest.matchedPhrase,
      });

      const transferToolResult = await dispatchTool("escalate_to_human", {
        reason: explicitTransferRequest.reason,
        urgency: "normal",
        recommended_action: "Answer the live transfer. The caller explicitly asked to speak with a human.",
        topic: explicitTransferRequest.topic || speechResult,
      }, dispatchCtx);

      const transferData = transferToolResult.data as Record<string, unknown> | undefined;
      const handoffTarget = await getLatestHandoffTransferTarget(callSid);
      const bridgeCallerId = (
        callerPhone?.direction === "outbound"
          ? callerPhone?.from_number
          : callerPhone?.to_number
      ) || fromPhone || env.TWILIO_PHONE_NUMBER || null;
      const transferTarget = transferToolResult.success ? chooseSafeHumanTransferTarget([
        { phone: typeof transferData?.transfer_phone === "string" ? transferData.transfer_phone : null, name: typeof transferData?.transfer_name === "string" ? transferData.transfer_name : null, source: "tool" },
        { phone: handoffTarget?.phone, name: handoffTarget?.name, source: "handoff_record" },
        { phone: env.HUMAN_TRANSFER_NUMBER, name: "team member", source: "env" },
      ], [callerPhoneNumber, bridgeCallerId]) : null;

      if (transferTarget) {
        aiText = transferToolResult.message;
        await buildLiveCallSpeech(responseTwiml, aiText, voice, agentName);
        const dial = responseTwiml.dial({ timeout: 30, record: "record-from-answer", callerId: bridgeCallerId || undefined });
        dial.number(transferTarget.phone);
        await sql`INSERT INTO messages (call_sid, role, text) VALUES (${callSid}, 'assistant', ${aiText})`;
        logEvent(callSid, "CALL_TRANSFERRED", { to: transferTarget.phone, to_name: transferTarget.name ?? "team member", source: transferTarget.source, trigger: "explicit_request" });
        await sql`UPDATE handoffs SET status = 'transferred' WHERE call_sid = ${callSid} AND status = 'pending'`.catch(() => {});
        await sql`UPDATE tasks SET status = 'in_progress' WHERE call_sid = ${callSid} AND task_type = 'handoff' AND status = 'open'`.catch(() => {});
        const finalTwiml = responseTwiml.toString();
        const entry = pendingResponses.get(callSid);
        if (entry) { entry.twiml = finalTwiml; entry.ready = true; entry.resolve?.(); }
        upsertPendingTwimlDb(callSid, true, finalTwiml, Date.now() + 30_000).catch(() => {/* non-critical */});
        return;
      }

      logEvent(callSid, "CALL_TRANSFER_SKIPPED", {
        reason: transferToolResult.success ? "no_safe_transfer_target" : "handoff_tool_failed",
        error: transferToolResult.error || null,
        trigger: "explicit_request",
      });
      const noTransferMsg = transferToolResult.success
        ? "I wasn't able to connect you directly right now, but I've flagged this as urgent and a team member will call you back shortly. Is there anything else I can help you with in the meantime?"
        : transferToolResult.message || "I'm having trouble connecting you directly right now, but I can still capture what you need for a team member to follow up.";
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
      await buildLiveCallSpeech(g, noTransferMsg, voice, agentName);
      responseTwiml.redirect({ method: "POST" }, `${appUrl}/api/twilio/process`);
      const finalTwiml = responseTwiml.toString();
      const entry = pendingResponses.get(callSid);
      if (entry) { entry.twiml = finalTwiml; entry.ready = true; entry.resolve?.(); }
      upsertPendingTwimlDb(callSid, true, finalTwiml, Date.now() + 30_000).catch(() => {/* non-critical */});
      return;
    }

    // Detect if the caller is asking for a human — skip streaming, use tool-calling path
    const escalationPhrases = ["speak to a human", "talk to a person", "real person", "speak to someone", "transfer me", "connect me", "agent please", "representative"];
    const needsEscalation = escalationPhrases.some((p) => speechResult.toLowerCase().includes(p));

    // Try streaming pipeline (OpenRouter + TTS in parallel)
    // Only run streaming when a premium TTS provider is actually active.
    // elevenLabsConfig can be non-null even when ELEVENLABS_ENABLED=false (key is set but disabled),
    // so we must check the env flag explicitly to avoid a 5-second timeout on every call.
    const hasActivePremiumTts = cartesiaConfig
      || (googleTTSConfig && process.env.GOOGLE_TTS_ENABLED !== 'false')
      || openAITTSConfig
      || (elevenLabsConfig && process.env.ELEVENLABS_ENABLED !== 'false');
    if (!FAST_LIVE_CALLS && !needsEscalation && openRouterConfig?.enabled && hasActivePremiumTts) {
      try {
        const streamResult = await withTimeout(
        streamingTtsPipeline(fullSystemPrompt, conversationHistory, speechResult, agentName, wsAiKeys),
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
        callSid, speechResult, requestId, callerContext, systemPrompt, dispatchCtx, env.GEMINI_API_KEY, turnCount, callerPhoneNumber, wsAiKeys
      );
      aiText = text;
      logEvent(callSid, "AI_RESPONSE_GENERATED", { latencyMs, turnCount, responseLength: aiText.length, source });
      callErrorCounts.delete(callSid); // reset consecutive error count on success
      // Persist latency so analytics can report real numbers instead of 0
      if (latencyMs > 0) {
        sql`UPDATE calls SET ai_latency_ms = ${latencyMs} WHERE call_sid = ${callSid}`.catch(() => {});
      }

      // Human transfer — use routed team member phone, fall back to HUMAN_TRANSFER_NUMBER env var
      if (hangUp && toolsInvoked.includes("escalate_to_human")) {
        const handoffTarget = await getLatestHandoffTransferTarget(callSid);
        const bridgeCallerId = (
          callerPhone?.direction === "outbound"
            ? callerPhone?.from_number
            : callerPhone?.to_number
        ) || fromPhone || env.TWILIO_PHONE_NUMBER || null;
        const transferTarget = chooseSafeHumanTransferTarget([
          { phone: routedPhone, name: routedName, source: "tool" },
          { phone: handoffTarget?.phone, name: handoffTarget?.name, source: "handoff_record" },
          { phone: env.HUMAN_TRANSFER_NUMBER, name: "team member", source: "env" },
        ], [callerPhoneNumber, bridgeCallerId]);

        if (transferTarget) {
          // Speak the handoff message, then bridge to the team member
          await buildLiveCallSpeech(responseTwiml, aiText, voice, agentName);
          const dial = responseTwiml.dial({ timeout: 30, record: "record-from-answer", callerId: bridgeCallerId || undefined });
          dial.number(transferTarget.phone);
          await sql`INSERT INTO messages (call_sid, role, text) VALUES (${callSid}, 'assistant', ${aiText})`;
          logEvent(callSid, "CALL_TRANSFERRED", { to: transferTarget.phone, to_name: transferTarget.name ?? "team member", source: transferTarget.source });
          // Update handoff status to 'transferred'
          await sql`UPDATE handoffs SET status = 'transferred' WHERE call_sid = ${callSid} AND status = 'pending'`.catch(() => {});
          await sql`UPDATE tasks SET status = 'in_progress' WHERE call_sid = ${callSid} AND task_type = 'handoff' AND status = 'open'`.catch(() => {});
          const finalTwiml = responseTwiml.toString();
          const entry = pendingResponses.get(callSid);
          if (entry) { entry.twiml = finalTwiml; entry.ready = true; entry.resolve?.(); }
          upsertPendingTwimlDb(callSid, true, finalTwiml, Date.now() + 30_000).catch(() => {/* non-critical */});
          return;
        } else {
          // No transfer number available — tell caller we'll have someone call them back
          logEvent(callSid, "CALL_TRANSFER_SKIPPED", { reason: "no_safe_transfer_target" });
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
          await buildLiveCallSpeech(g, noTransferMsg, voice, agentName);
          responseTwiml.redirect({ method: "POST" }, `${appUrl}/api/twilio/process`);
          const finalTwiml = responseTwiml.toString();
          const entry = pendingResponses.get(callSid);
          if (entry) { entry.twiml = finalTwiml; entry.ready = true; entry.resolve?.(); }
          upsertPendingTwimlDb(callSid, true, finalTwiml, Date.now() + 30_000).catch(() => {/* non-critical */});
          return;
        }
      }

      // If we're ending the call, speak immediately and hang up.
      // Otherwise, we speak inside <Gather> below to enable barge-in capture.
      if (hangUp) {
        await buildLiveCallSpeech(responseTwiml, aiText, voice, agentName);
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
      await buildLiveCallSpeech(g, aiText, voice, agentName);
    }
    responseTwiml.redirect({ method: "POST" }, `${appUrl}/api/twilio/process`);
  } catch (error: any) {
    log("error", "AI generation failed (async)", { requestId, callSid, error: error.message });
    logEvent(callSid, "AI_ERROR", { error: error.message, turnCount });
    const errCount = (callErrorCounts.get(callSid) || 0) + 1;
    callErrorCounts.set(callSid, errCount);
    if (errCount >= 2) {
      // Two consecutive errors — hang up gracefully instead of looping
      callErrorCounts.delete(callSid);
      logEvent(callSid, "CALL_ENDED_ERROR_LOOP", { errCount });
      await buildLiveCallSpeech(responseTwiml as any, "I'm having trouble processing your request right now. I'll have someone follow up with you shortly. Thank you for your time!", voice, agentName);
      responseTwiml.hangup();
    } else {
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
      await buildLiveCallSpeech(g, "Sorry about that — could you say that again?", voice, agentName);
      responseTwiml.redirect({ method: "POST" }, `${appUrl}/api/twilio/process`);
    }
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
  const processCallRecordRows = await sql<{ contact_id: number | null; turn_count: number; agent_name: string | null }[]>`
    SELECT contact_id, turn_count, agent_name FROM calls WHERE call_sid = ${CallSid}
  `;
  const callRecord = processCallRecordRows[0];

  // DTMF customer text-back escape hatch disabled in callback-first MVP.
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
    await buildLiveCallSpeech(t, "We've been talking for a while. Let me have someone from our team follow up with you shortly. Have a great day!", voice, agentName);
    t.hangup();
    res.type("text/xml"); return res.send(t.toString());
  }

    logEvent(CallSid, "SPEECH_RECEIVED", { turnCount, speechLength: SpeechResult?.length || 0, confidence: Confidence });
  // Dead air — add escape hatch + longer timeouts + hard fallback to voicemail capture
  if (!SpeechResult) {
    // Track dead-air turns separately from global turn_count.
    // Global turn_count includes all gather loops (including actionOnEmptyResult loops
    // that fire while the AI is still generating a response), so using it as the
    // dead-air threshold causes false positives after just 1-2 real turns.
    const prevDeadAir = deadAirCounts.get(CallSid) || 0;
    const newDeadAir = prevDeadAir + 1;
    deadAirCounts.set(CallSid, newDeadAir);
    logEvent(CallSid, "DEAD_AIR_DETECTED", { turnCount, deadAirTurn: newDeadAir });
    // After 4 consecutive dead-air turns (not total turns), fall back to voicemail.
    if (newDeadAir >= 4) {
      deadAirCounts.delete(CallSid);
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
    await buildLiveCallSpeech(g, "Sorry, I didn't catch that. You can say it again, or press 1 to leave a voicemail for a callback.", voice, agentName);
    res.type("text/xml");
    return res.send(t.toString());
  }

  // End-of-call keyword detection
  const endKeywords = ["goodbye", "bye", "hang up", "end call", "stop", "quit", "that's all", "no more", "thank you goodbye"];
  if (endKeywords.some((kw) => SpeechResult.toLowerCase().includes(kw))) {
    await sql`INSERT INTO messages (call_sid, role, text) VALUES (${CallSid}, 'user', ${SpeechResult})`;
    await sql`INSERT INTO messages (call_sid, role, text) VALUES (${CallSid}, 'assistant', ${"Goodbye! Have a great day!"})`;
    const t = new twilio.twiml.VoiceResponse();
    await buildLiveCallSpeech(t, "Goodbye! Have a great day!", voice, agentName);
    t.hangup();
    res.type("text/xml"); return res.send(t.toString());
  }

  // Real speech received — reset dead-air counter
  deadAirCounts.delete(CallSid);
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
    await buildLiveCallSpeech(g, injectedText, voice, agentName);
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

registerTwilioLiveRoutes(app, {
  sql,
  env,
  pendingResponses,
  getPendingTwimlDb,
  getAppUrl,
  getOwnerAlertRecipients,
  formatSenderEmail,
  logEvent,
  log,
});

registerDashboardRoutes(app, {
  dashboardAuth,
  sql,
  dbEnabled: DB_ENABLED,
  getWorkspaceId,
  log,
});

registerCallRoutes(app, {
  dashboardAuth,
  requireOperator,
  sql,
  dbEnabled: DB_ENABLED,
  env,
  getWorkspaceId,
  fixStaleCalls,
  resolveWorkspaceAiKeys,
  runPostCallIntelligence,
  ttsAudioStore,
  log,
});

// ── API: Recovery Queue V1 (missed inbound calls needing recovery) ───────────
registerRecoveryRoutes(app, {
  dashboardAuth,
  requireOperator,
  sql,
  dbEnabled: DB_ENABLED,
  getWorkspaceId,
  isOnDNC,
  getTwilioClient,
  env,
  getActiveAgent,
  getAppUrl,
  logEvent,
  log,
});

app.all("/_disabled/*", (_req: Request, res: Response) => {
  res.status(410).json({ error: "Disabled legacy texting route.", code: "LEGACY_TEXTING_ROUTE_DISABLED" });
});

registerCalendlyRoutes(app, {
  dashboardAuth,
  sql,
  log,
});

registerContactRoutes(app, {
  dashboardAuth,
  requireOperator,
  sql,
  dbEnabled: DB_ENABLED,
  getWorkspaceId,
});

registerTaskRoutes(app, {
  dashboardAuth,
  sql,
  dbEnabled: DB_ENABLED,
  getWorkspaceId,
  log,
});

registerOperationsRoutes(app, {
  dashboardAuth,
  requireOperator,
  sql,
  dbEnabled: DB_ENABLED,
  getWorkspaceId,
});

registerAgentRoutes(app, {
  dashboardAuth,
  requireOperator,
  sql,
  dbEnabled: DB_ENABLED,
  getWorkspaceId,
  agentConfigSchema: AgentConfigSchema,
});

registerCalendarRoutes(app, {
  dashboardAuth,
  requireOperator,
  sql,
  dbEnabled: DB_ENABLED,
  getWorkspaceId,
});

registerSettingsRoutes(app, {
  dashboardAuth,
  requireOperator,
  sql,
  dbEnabled: DB_ENABLED,
  env,
  getAppUrl,
  reloadOpenClawConfig,
  testOpenClawConnection,
  log,
});

registerAdminMaintenanceRoutes(app, {
  dashboardAuth,
  requireOperator,
  requireProvisioningSecret,
  sql,
  dbEnabled: DB_ENABLED,
  resetMonthlyUsage,
  log,
});

registerProofRoutes(app, {
  dashboardAuth,
  requireOperator,
  sql,
  dbEnabled: DB_ENABLED,
  getWorkspaceId,
  buildProofFreshness,
  log,
});

registerWorkspaceOverviewRoutes(app, {
  dashboardAuth,
  sql,
  dbEnabled: DB_ENABLED,
  getWorkspaceId,
  buildProofFreshness,
  buildSetupReadiness,
});

registerOperatorRoutes(app, {
  dashboardAuth,
  requireOperator,
  sql,
  env,
  getOpenClawConfig: () => openClawConfig,
  testOpenClawConnection,
  queueInjectedMessage,
  log,
});

// ── Health Check ─────────────────────────────────────────────────────────────
// /livez is intentionally dependency-free so Railway can keep the container up
// even while Postgres is degraded or still attaching.
// /api/version is a stable lightweight alias for deploy freshness checks.
registerBuyerRoutes(app, {
  publicDemoRateLimit,
  env,
  isProd: IS_PROD,
  deployVersion: DEPLOY_VERSION,
  deployBranch: DEPLOY_BRANCH,
  getAppUrl,
  log,
  acceptInvite,
  getWorkspaceById,
  handleStripeWebhook,
});

registerLaunchRoutes(app, {
  dashboardAuth,
  requireOperator,
  sql,
  dbEnabled: DB_ENABLED,
  log,
});

registerTelegramApprovalRoutes(app, {
  dashboardAuth,
  requireOperator,
  sql,
  dbEnabled: DB_ENABLED,
  log,
});

app.get("/livez", (_req: Request, res: Response) => {
  res.setHeader("x-smirk-readiness", "1");
  res.setHeader("x-smirk-version", DEPLOY_VERSION);
  res.setHeader("x-smirk-branch", DEPLOY_BRANCH);
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: DEPLOY_VERSION,
    branch: DEPLOY_BRANCH,
  });
});

// /health remains the richer readiness view and may report degraded DB status.
// Use it to verify the tunnel is alive before making a call:
//   curl https://your-ngrok-url.ngrok.io/health
app.get("/health", async (_req: Request, res: Response) => {
  const appUrl = getAppUrl();
  const twilioConfigured = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER);
  const aiConfigured = !!(env.GEMINI_API_KEY || openClawConfig?.enabled || openRouterConfig?.enabled);
  const paymentLinksConfigured = !!((process.env.STRIPE_PAYMENT_LINK_STARTER || '').trim() && (process.env.STRIPE_PAYMENT_LINK_PRO || '').trim() && (process.env.STRIPE_PAYMENT_LINK_ENTERPRISE || '').trim());
  const fromEmail = String(env.FROM_EMAIL || '').trim();
  const senderDomainMatch = fromEmail.match(/@([^>\s]+)>?$/);
  const senderDomain = senderDomainMatch?.[1]?.toLowerCase() || null;
  const ownerEmailDeliveryConfigured = !!(env.RESEND_API_KEY && fromEmail && !/yourdomain\.com|example\.com/i.test(fromEmail));
  const ownerEmailNextAction = ownerEmailDeliveryConfigured ? null : senderDomain === 'smirkcalls.com'
    ? 'Verify smirkcalls.com in Resend, then keep FROM_EMAIL on alerts@smirkcalls.com.'
    : 'Run npm run cutover:sender-domain -- --dry-run, verify smirkcalls.com in Resend, then set FROM_EMAIL to alerts@smirkcalls.com.';

  res.setHeader("x-smirk-readiness", "1");
  res.setHeader("x-smirk-version", DEPLOY_VERSION);
  res.setHeader("x-smirk-branch", DEPLOY_BRANCH);

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
    twilioConfigured,
    aiConfigured,
    paymentLinksConfigured,
    ownerEmailDeliveryConfigured,
    ownerEmailSenderDomain: senderDomain,
    ownerEmailNextAction,
    db,
    uptime: Math.round(process.uptime()),
    version: DEPLOY_VERSION,
    branch: DEPLOY_BRANCH,
    appUrl,
  });
});

registerDemoRoutes(app, {
  requirePhoneAgentApiKey,
  sql,
  env,
  getTwilioClient,
  getAppUrl,
  log,
});

registerDebugRoutes(app, {
  dashboardAuth,
  requireOperator,
  getElevenLabsConfig: () => elevenLabsConfig,
  buildTwimlSay,
});

registerIntegrationsRoutes(app, {
  dashboardAuth,
  requireOperator,
  sql,
  dbEnabled: DB_ENABLED,
});

registerProvisioningRoutes(app, {
  publicDemoRateLimit,
  dashboardAuth,
  requireOperator,
  requireProvisioningSecret,
  sql,
  dbEnabled: DB_ENABLED,
  env,
  getAppUrl,
  provisionWorkspaceTelephony,
  buildProofFreshness,
  buildSetupReadiness,
  buildActivationStatus,
});

registerWorkspaceAdminRoutes(app, {
  dashboardAuth,
  requireOperator,
  dbEnabled: DB_ENABLED,
  provisionWorkspaceTelephony,
  getAppUrl,
  log,
});

registerProspectingRoutes(app, {
  dashboardAuth,
  requireOperator,
  sql,
  dbEnabled: DB_ENABLED,
  env,
  log,
  getTwilioClient,
  getAppUrl,
});

registerComplianceRoutes(app, {
  dashboardAuth,
  requireOperator,
  sql,
  dbEnabled: DB_ENABLED,
});

// ── System Health Check (10-point smoke test) ────────────────────────────────
type OpsServiceStatus = {
  id: string;
  label: string;
  category: "core" | "ai" | "voice" | "payments" | "email" | "leads" | "calendar" | "infra";
  status: "online" | "warn" | "offline" | "unknown";
  configured: boolean;
  detail: string;
  balanceLabel?: string;
  balanceValue?: string;
  latencyMs?: number;
  lastCheckedAt: string;
};

const formatOpsMoney = (amount: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);

const compactNumber = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);

async function withOpsTimeout<T>(label: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  return await Promise.race([
    fn(),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)),
  ]);
}

const sanitizeProviderError = (error: any): string => {
  const raw = String(error?.message || error || "unknown error");
  return raw.replace(/sk_[a-zA-Z0-9_]+/g, "sk_***").replace(/Bearer\s+[^\s]+/gi, "Bearer ***").slice(0, 180);
};

async function buildOpsMonitor(workspaceId: number): Promise<{ services: OpsServiceStatus[]; spend: any; config: any[]; generatedAt: string }> {
  const generatedAt = new Date().toISOString();
  const service = (input: Omit<OpsServiceStatus, "lastCheckedAt">): OpsServiceStatus => ({ ...input, lastCheckedAt: generatedAt });
  const configured = {
    twilio: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER),
    openrouter: !!env.OPENROUTER_API_KEY,
    gemini: !!env.GEMINI_API_KEY,
    elevenlabs: !!env.ELEVENLABS_API_KEY,
    googleTts: !!env.GOOGLE_TTS_API_KEY,
    googleCalendar: !!(env.GOOGLE_SERVICE_ACCOUNT_JSON && env.GOOGLE_CALENDAR_ID),
    googlePlaces: !!process.env.GOOGLE_PLACES_API_KEY,
    resend: !!env.RESEND_API_KEY,
    stripe: !!env.STRIPE_SECRET_KEY,
    database: DB_ENABLED,
  };

  const [twilioStatus, openRouterStatus, stripeStatus, resendStatus, elevenStatus] = await Promise.all([
    (async () => {
      if (!configured.twilio) {
        return service({ id: "twilio", label: "Twilio Voice", category: "core", status: "offline", configured: false, detail: "Missing Twilio SID, auth token, or phone number." });
      }
      const started = Date.now();
      try {
        const client = getTwilioClient();
        if (!client) throw new Error("Twilio client unavailable");
        const account: any = await withOpsTimeout("Twilio account fetch", 3500, () => (client.api.accounts(env.TWILIO_ACCOUNT_SID!) as any).fetch());
        let balanceValue: string | undefined;
        try {
          const bal: any = await withOpsTimeout("Twilio balance fetch", 3500, () => (client.api.v2010.account.balance as any).fetch());
          const amount = Number(bal.balance);
          balanceValue = Number.isFinite(amount) ? `${formatOpsMoney(amount, String(bal.currency || "USD").toUpperCase())}` : undefined;
        } catch {
          balanceValue = undefined;
        }
        return service({
          id: "twilio",
          label: "Twilio Voice",
          category: "core",
          status: account?.status === "active" ? "online" : "warn",
          configured: true,
          detail: `Account ${account?.friendlyName || env.TWILIO_ACCOUNT_SID} is ${account?.status || "reachable"}; number ${env.TWILIO_PHONE_NUMBER}.`,
          balanceLabel: "Balance",
          balanceValue,
          latencyMs: Date.now() - started,
        });
      } catch (e: any) {
        return service({ id: "twilio", label: "Twilio Voice", category: "core", status: "offline", configured: true, detail: sanitizeProviderError(e), latencyMs: Date.now() - started });
      }
    })(),
    (async () => {
      if (!configured.openrouter) {
        return service({ id: "openrouter", label: "OpenRouter", category: "ai", status: configured.gemini ? "warn" : "offline", configured: false, detail: configured.gemini ? "OpenRouter missing; Gemini fallback is configured." : "No OpenRouter API key configured." });
      }
      const started = Date.now();
      try {
        const resp = await withOpsTimeout("OpenRouter credits", 3500, () => fetch("https://openrouter.ai/api/v1/credits", { headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } }));
        if (!resp.ok) throw new Error(`OpenRouter returned ${resp.status}`);
        const data = await resp.json() as any;
        const remaining = Number(data?.data?.total_credits) - Number(data?.data?.total_usage || 0);
        return service({
          id: "openrouter",
          label: "OpenRouter",
          category: "ai",
          status: "online",
          configured: true,
          detail: `Model ${openRouterConfig?.model || env.OPENROUTER_MODEL || "default"} reachable.`,
          balanceLabel: "Credits left",
          balanceValue: Number.isFinite(remaining) ? formatOpsMoney(remaining) : undefined,
          latencyMs: Date.now() - started,
        });
      } catch (e: any) {
        return service({ id: "openrouter", label: "OpenRouter", category: "ai", status: "warn", configured: true, detail: sanitizeProviderError(e), latencyMs: Date.now() - started });
      }
    })(),
    (async () => {
      if (!configured.stripe) {
        return service({ id: "stripe", label: "Stripe", category: "payments", status: "offline", configured: false, detail: "STRIPE_SECRET_KEY is missing." });
      }
      const started = Date.now();
      try {
        const stripe = new Stripe(env.STRIPE_SECRET_KEY!);
        const balance = await withOpsTimeout("Stripe balance", 3500, () => stripe.balance.retrieve());
        const available = balance.available.reduce((sum, b) => sum + Number(b.amount || 0), 0) / 100;
        const pending = balance.pending.reduce((sum, b) => sum + Number(b.amount || 0), 0) / 100;
        return service({
          id: "stripe",
          label: "Stripe Billing",
          category: "payments",
          status: "online",
          configured: true,
          detail: `Available ${formatOpsMoney(available)}; pending ${formatOpsMoney(pending)}.`,
          balanceLabel: "Available",
          balanceValue: formatOpsMoney(available),
          latencyMs: Date.now() - started,
        });
      } catch (e: any) {
        return service({ id: "stripe", label: "Stripe Billing", category: "payments", status: "warn", configured: true, detail: sanitizeProviderError(e), latencyMs: Date.now() - started });
      }
    })(),
    (async () => {
      if (!configured.resend) {
        return service({ id: "resend", label: "Resend Email", category: "email", status: "offline", configured: false, detail: "RESEND_API_KEY is missing." });
      }
      const fromEmail = String(env.FROM_EMAIL || "").trim();
      const configuredSender = fromEmail || "missing FROM_EMAIL";
      const started = Date.now();
      try {
        const resp = await withOpsTimeout("Resend domains", 3500, () => fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` } }));
        if (!resp.ok) throw new Error(`Resend returned ${resp.status}`);
        return service({ id: "resend", label: "Resend Email", category: "email", status: fromEmail ? "online" : "warn", configured: true, detail: `API reachable; sender ${configuredSender}.`, latencyMs: Date.now() - started });
      } catch (e: any) {
        return service({ id: "resend", label: "Resend Email", category: "email", status: "warn", configured: true, detail: `${sanitizeProviderError(e)}; sender ${configuredSender}.`, latencyMs: Date.now() - started });
      }
    })(),
    (async () => {
      if (!configured.elevenlabs) {
        return service({ id: "elevenlabs", label: "ElevenLabs Voice", category: "voice", status: configured.googleTts ? "warn" : "unknown", configured: false, detail: configured.googleTts ? "ElevenLabs missing; Google TTS is configured." : "Not configured; live calls can still use Twilio/Polly fallback." });
      }
      const started = Date.now();
      try {
        const resp = await withOpsTimeout("ElevenLabs subscription", 3500, () => fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": env.ELEVENLABS_API_KEY! } }));
        if (!resp.ok) throw new Error(`ElevenLabs returned ${resp.status}`);
        const data = await resp.json() as any;
        const used = Number(data.character_count || 0);
        const limit = Number(data.character_limit || 0);
        return service({
          id: "elevenlabs",
          label: "ElevenLabs Voice",
          category: "voice",
          status: limit > 0 && used / limit > 0.9 ? "warn" : "online",
          configured: true,
          detail: `Characters ${compactNumber(used)} / ${limit ? compactNumber(limit) : "unknown"}.`,
          balanceLabel: "Characters left",
          balanceValue: limit ? compactNumber(Math.max(0, limit - used)) : undefined,
          latencyMs: Date.now() - started,
        });
      } catch (e: any) {
        return service({ id: "elevenlabs", label: "ElevenLabs Voice", category: "voice", status: "warn", configured: true, detail: sanitizeProviderError(e), latencyMs: Date.now() - started });
      }
    })(),
  ]);

  const staticServices: OpsServiceStatus[] = [
    service({ id: "database_ops", label: "Postgres", category: "infra", status: configured.database ? "online" : "offline", configured: configured.database, detail: configured.database ? "Database URL configured; core DB check runs above." : "DATABASE_URL missing." }),
    service({ id: "gemini", label: "Gemini Fallback", category: "ai", status: configured.gemini ? "online" : "warn", configured: configured.gemini, detail: configured.gemini ? `Configured with ${env.GEMINI_MODEL || "default model"}.` : "GEMINI_API_KEY missing; OpenRouter must carry AI traffic." }),
    service({ id: "google_calendar", label: "Google Calendar", category: "calendar", status: configured.googleCalendar ? "online" : "warn", configured: configured.googleCalendar, detail: configured.googleCalendar ? `Calendar ${env.GOOGLE_CALENDAR_ID} configured.` : "Calendar service account or calendar ID missing; booking tools may not create events." }),
    service({ id: "google_places", label: "Google Places", category: "leads", status: configured.googlePlaces ? "online" : "warn", configured: configured.googlePlaces, detail: configured.googlePlaces ? "Lead search key configured." : "GOOGLE_PLACES_API_KEY missing; prospect discovery is limited." }),
  ];

  let spend = {
    monthLabel: new Date().toISOString().slice(0, 7),
    calls: 0,
    minutes: 0,
    aiTokens: 0,
    ownerEmails: 0,
    estimated: {
      twilioVoice: 0,
      openRouter: 0,
      total: 0,
    },
    notes: [
      "Twilio and AI costs are estimates from local usage logs; provider invoices remain the source of truth.",
      "OpenRouter model pricing varies, so token cost uses a conservative blended estimate until per-model price capture is added.",
    ],
  };

  try {
    const monthRows = await sql`
      SELECT
        COUNT(*)::int AS calls,
        COALESCE(SUM(COALESCE(duration_seconds, 0)), 0)::int AS seconds
      FROM calls
      WHERE workspace_id = ${workspaceId}
        AND started_at >= date_trunc('month', NOW())
    `;
    const tokenRows = await sql`
      SELECT COALESCE(SUM((payload->>'tokensUsed')::int), 0)::int AS tokens
      FROM call_events ce
      JOIN calls c ON c.call_sid = ce.call_sid
      WHERE c.workspace_id = ${workspaceId}
        AND ce.event_type = 'OPENROUTER_RESPONSE'
        AND ce.created_at >= date_trunc('month', NOW())
        AND payload ? 'tokensUsed'
    `;
    const emailRows = await sql`
      SELECT COUNT(*)::int AS count
      FROM call_events ce
      JOIN calls c ON c.call_sid = ce.call_sid
      WHERE c.workspace_id = ${workspaceId}
        AND ce.event_type IN ('OWNER_EMAIL_ALERT_SENT', 'VOICEMAIL_EMAIL_SENT')
        AND ce.created_at >= date_trunc('month', NOW())
    `;
    const calls = Number(monthRows[0]?.calls || 0);
    const minutes = Math.ceil(Number(monthRows[0]?.seconds || 0) / 60);
    const aiTokens = Number(tokenRows[0]?.tokens || 0);
    const ownerEmails = Number(emailRows[0]?.count || 0);
    const twilioVoice = minutes * 0.015;
    const openRouter = (aiTokens / 1000) * 0.0003;
    spend = {
      ...spend,
      calls,
      minutes,
      aiTokens,
      ownerEmails,
      estimated: {
        twilioVoice: Math.round(twilioVoice * 100) / 100,
        openRouter: Math.round(openRouter * 10000) / 10000,
        total: Math.round((twilioVoice + openRouter) * 100) / 100,
      },
    };
  } catch (e: any) {
    spend.notes = [`Usage estimate unavailable: ${sanitizeProviderError(e)}`];
  }

  const config = [
    { key: "TWILIO_ACCOUNT_SID", label: "Twilio SID", set: !!env.TWILIO_ACCOUNT_SID, critical: true },
    { key: "TWILIO_AUTH_TOKEN", label: "Twilio token", set: !!env.TWILIO_AUTH_TOKEN, critical: true },
    { key: "TWILIO_PHONE_NUMBER", label: "Twilio number", set: !!env.TWILIO_PHONE_NUMBER, critical: true, value: env.TWILIO_PHONE_NUMBER || null },
    { key: "OPENROUTER_API_KEY", label: "OpenRouter key", set: !!env.OPENROUTER_API_KEY, critical: true },
    { key: "GEMINI_API_KEY", label: "Gemini fallback key", set: !!env.GEMINI_API_KEY, critical: false },
    { key: "RESEND_API_KEY", label: "Resend key", set: !!env.RESEND_API_KEY, critical: true },
    { key: "FROM_EMAIL", label: "Sender email", set: !!env.FROM_EMAIL, critical: true, value: env.FROM_EMAIL || null },
    { key: "STRIPE_SECRET_KEY", label: "Stripe secret", set: !!env.STRIPE_SECRET_KEY, critical: true },
    { key: "GOOGLE_SERVICE_ACCOUNT_JSON", label: "Calendar service account", set: !!env.GOOGLE_SERVICE_ACCOUNT_JSON, critical: false },
    { key: "GOOGLE_PLACES_API_KEY", label: "Google Places key", set: !!process.env.GOOGLE_PLACES_API_KEY, critical: false },
    { key: "ELEVENLABS_API_KEY", label: "ElevenLabs key", set: !!env.ELEVENLABS_API_KEY, critical: false },
  ];

  return { services: [twilioStatus, openRouterStatus, stripeStatus, resendStatus, elevenStatus, ...staticServices], spend, config, generatedAt };
}

registerSystemHealthRoutes(app, {
  dashboardAuth,
  requireOperator,
  sql,
  env,
  getWorkspaceId,
  getWorkspaceById,
  getOpenRouterModel: () => openRouterConfig?.model || null,
  buildOpsMonitor,
});

registerLeadRoutes(app, {
  dashboardAuth,
  requireOperator,
  sql,
  dbEnabled: DB_ENABLED,
  getWorkspaceId,
  getTwilioClient,
  getActiveAgent,
  getAppUrl,
  log,
});

// ── Team Member Routes (must be before 404 handler) ─────────────────────────
registerTeamRoutes(app, dashboardAuth, requireOperator, DB_ENABLED);
registerBossModeRoutes(app, dashboardAuth, requireOperator, DB_ENABLED);

// ── Workspace Profile API (module-level so they precede the /api/* 404 handler) ──
// GET  /api/workspace/profile  — returns workspace identity fields
// PATCH /api/workspace/profile — saves business identity + marks setup complete
// POST /api/workspace/generate-prompt — Gemini-powered system prompt generation
// POST /api/workspace/website-scan — review-only website facts extraction
// POST /api/workspace/provision-number — inline Twilio number provisioning
registerWorkspaceProfileRoutes(app, {
  dashboardAuth,
  sql,
  dbEnabled: DB_ENABLED,
  env,
  log,
  getWorkspaceId,
  getWorkspaceById,
  updateWorkspace,
  createActivationEventIfChanged,
  invalidateWorkspaceAiKeyCache,
  provisionWorkspaceTelephony,
  renderWorkspaceGreeting,
  buildProofFreshness,
  buildSetupReadiness,
  buildActivationStatus,
  workspaceProfileCache,
});

registerWorkspaceActivationRoutes(app, {
  dashboardAuth,
  sql,
  env,
  log,
  getWorkspaceId,
  getWorkspaceById,
  updateWorkspace,
  createActivationEvent,
  listActivationEvents,
  recordActivationStageEvent,
  buildProofFreshness,
  buildSetupReadiness,
  buildActivationStatus,
  maskPhoneForResponse,
  workspaceProfileCache,
});

registerWorkspaceKnowledgeRoutes(app, {
  dashboardAuth,
  dbEnabled: DB_ENABLED,
  getWorkspaceId,
  log,
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
    log("info", "SMIRK missed-call recovery started", {
      port: PORT,
      env: env.NODE_ENV || "development",
      webhookUrl: `${getAppUrl()}/api/twilio/incoming`,
      authEnabled: !!env.DASHBOARD_API_KEY,
      openClawEnabled: !!openClawConfig?.enabled,
      openClawGateway: openClawConfig?.gatewayUrl || "(disabled)",
      openClawModel: openClawConfig?.model || "(disabled)",
      gatewayBridgeActive: !!gatewayBridge?.isConnected,
      aiBrain: openClawConfig?.enabled ? "OpenClaw Gateway" : openRouterConfig?.enabled ? `OpenRouter (${openRouterConfig.model})` : env.GEMINI_API_KEY ? "Gemini 2.5 Flash" : "No AI configured",
      ttsEngine: openAITTSConfig ? `OpenAI TTS (${openAITTSConfig.voice})` : elevenLabsConfig ? `ElevenLabs (${elevenLabsConfig.voiceId})` : "Polly (fallback)",
    });
  });

  // Initialize Postgres schema in the background with retry (do not fail the process).
  if (DB_ENABLED) {
    (async () => {
      const maxAttempts = 30;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await initSaasSchema();
          await initSchema();
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
          const dbUrl = process.env.DATABASE_URL || "";
          const dbHost = (() => {
            try {
              return dbUrl ? new URL(dbUrl).hostname : undefined;
            } catch {
              return undefined;
            }
          })();
          const likelyCause = /CONNECT_TIMEOUT/i.test(msg) && /railway\.internal/i.test(dbHost || "")
            ? "Railway private Postgres host unreachable from app service; verify the Postgres service is attached in the same project/environment and DATABASE_URL is a Railway reference variable, not a pasted value."
            : undefined;
          log("warn", "Postgres init failed; retrying", { attempt, maxAttempts, error: msg, dbHost, likelyCause });
          await new Promise(r => setTimeout(r, Math.min(10_000, 500 * attempt)));
        }
      }
      log("error", "Postgres init failed permanently; app will stay up but DB-backed features will be degraded");
    })();
  } else {
    log("warn", "DATABASE_URL not set: running in no-db mode (dashboard loads, but persistence APIs will fail)");
  }

  // NOTE: SPA catch-all is registered at the END of startServer() so all API routes
  // (including workspace profile routes below) are registered first and take precedence.
  let _spaDistPath: string | null = null;
  if (!IS_PROD) {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    _spaDistPath = process.env.DIST_PATH || path.resolve(__dirname, "..", "dist");
    app.use(express.static(_spaDistPath));
    // Catch-all will be registered after all API routes (see end of startServer)
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

  // ── JSON 404 for API routes ──────────────────────────────────────────────
  app.use("/api/*", (_req: Request, res: Response) => {
    res.status(404).json({ error: "API endpoint not found." });
  });

  // ── SPA Catch-all ───────────────────────────────────────────────────────────
  // Registered here so all API routes above take precedence in Express route matching.
  if (_spaDistPath) {
    app.get(["/mission-control", "/mission-control/*"], dashboardAuth, requireOperator, (_req, res) => {
      res.sendFile(path.join(_spaDistPath!, "index.html"));
    });
    app.get("*", (_req, res) => res.sendFile(path.join(_spaDistPath!, "index.html")));
  }

  // ── Global Error Handler ────────────────────────────────────────────────────
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    log("error", "Unhandled error", {
      requestId: (req as any).requestId,
      error: err.message,
      stack: IS_PROD ? undefined : err.stack,
    });
    res.status(500).json({ error: IS_PROD ? "Internal server error." : err.message });
  });
}

startServer().catch((err) => {
  log("error", "Failed to start server", { error: err.message });
  process.exit(1);
});
// Railway cache bust 1773713745
