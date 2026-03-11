/**
 * AI Phone Agent — Main Server
 *
 * Architecture: Twilio → Gemini 2.0 Flash → Amazon Polly TTS
 * State: SQLite (calls, messages, contacts, summaries, events, tasks, tools, handoffs)
 * Security: helmet, rate-limit, zod validation, API key auth, Twilio sig verification
 * Observability: structured logging, request IDs, AI latency tracking
 */
import express, { Request, Response, NextFunction } from "express";
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

// ── Load env before importing modules that use it ─────────────────────────────
dotenv.config({ path: ".env.local" });
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Environment Schema Validation ─────────────────────────────────────────────
const EnvSchema = z.object({
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  APP_URL: z.string().optional(),
  PORT: z.string().optional(),
  DASHBOARD_API_KEY: z.string().optional(),
  NODE_ENV: z.enum(["development", "production", "test"]).optional(),
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
import { db } from "./src/db.js";
import { resolveContact, buildCallerContext } from "./src/contacts.js";
import { runPostCallIntelligence } from "./src/intelligence.js";
import { logEvent } from "./src/events.js";
import { generateAiResponseWithTools } from "./src/function-calling.js";

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
      try {
        db.prepare(`
          INSERT INTO request_logs (request_id, method, path, status_code, duration_ms, ip)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run((req as any).requestId, req.method, req.path, res.statusCode, duration, req.ip);
      } catch { /* non-critical */ }
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
const getActiveAgent = () => db.prepare(
  "SELECT * FROM agent_configs WHERE is_active = 1 ORDER BY id DESC LIMIT 1"
).get() as { id: number; name: string; system_prompt: string; greeting: string; voice: string; language: string; max_turns: number } | undefined;

const getAi = () => {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured.");
  return new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
};

const getTwilioClient = () => {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) throw new Error("Twilio credentials not configured.");
  return twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
};

const getAppUrl = () => (env.APP_URL || `http://localhost:${PORT}`).replace("ais-dev-", "ais-pre-");

const buildTwimlSay = (twiml: twilio.twiml.VoiceResponse, text: string, voice: string) => {
  twiml.say({ voice: voice.startsWith("Polly.") ? (voice as any) : "Polly.Joanna" }, text);
};

// ── AI Response Generation (now uses function-calling engine) ─────────────────
// The old plain-text generateAiResponse is replaced by generateAiResponseWithTools
// which runs the full Gemini function-calling loop per turn.

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
    });

    const agent = getActiveAgent();
    const { contact } = resolveContact(to);

    db.prepare(`
      INSERT OR IGNORE INTO calls (call_sid, direction, to_number, from_number, status, agent_name, contact_id)
      VALUES (?, 'outbound', ?, ?, 'initiated', ?, ?)
    `).run(call.sid, to, from, agent?.name || "Default Assistant", contact.id);

    logEvent(call.sid, "CALL_STARTED", { direction: "outbound", to, contactId: contact.id });
    log("info", "Outbound call initiated", { requestId, callSid: call.sid, to });
    res.json({ success: true, callSid: call.sid });
  } catch (error: any) {
    log("error", "Outbound call failed", { requestId, error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ── Twilio Webhook: Call Status ───────────────────────────────────────────────
app.post("/api/twilio/status", async (req: Request, res: Response) => {
  const { CallSid, CallStatus, CallDuration } = req.body;

  if (["completed", "failed", "busy", "no-answer"].includes(CallStatus)) {
    db.prepare(`
      UPDATE calls SET status = ?, ended_at = datetime('now'), duration_seconds = ?
      WHERE call_sid = ?
    `).run(CallStatus, CallDuration ? parseInt(CallDuration) : null, CallSid);

    // Run post-call intelligence asynchronously (don't block Twilio's webhook)
    if (CallStatus === "completed" && env.GEMINI_API_KEY) {
      const callRecord = db.prepare("SELECT contact_id FROM calls WHERE call_sid = ?").get(CallSid) as { contact_id: number | null } | undefined;
      setImmediate(async () => {
        try {
          await runPostCallIntelligence(CallSid, callRecord?.contact_id || null, env.GEMINI_API_KEY!);
          log("info", "Post-call intelligence complete", { callSid: CallSid });
        } catch (err: any) {
          log("error", "Post-call intelligence failed", { callSid: CallSid, error: err.message });
        }
      });
    }

    logEvent(CallSid, "CALL_ENDED", { status: CallStatus, duration: CallDuration });
  } else {
    db.prepare("UPDATE calls SET status = ? WHERE call_sid = ?").run(CallStatus, CallSid);
  }

  log("info", "Call status updated", { callSid: CallSid, status: CallStatus });
  res.sendStatus(200);
});

// ── Twilio Webhook: Incoming / Outbound Connected ─────────────────────────────
app.post("/api/twilio/incoming", (req: Request, res: Response) => {
  const { CallSid, To, From, Direction } = req.body;

  // Deduplication guard
  if (isDuplicateWebhook(CallSid, "incoming")) {
    const twiml = new twilio.twiml.VoiceResponse();
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  const agent = getActiveAgent();
  const callerPhone = Direction === "outbound-api" ? To : From;

  // Resolve caller identity
  const { contact, isNew } = resolveContact(callerPhone);
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

  db.prepare(`
    INSERT OR IGNORE INTO calls (call_sid, direction, to_number, from_number, status, agent_name, contact_id)
    VALUES (?, ?, ?, ?, 'in-progress', ?, ?)
  `).run(CallSid, Direction === "outbound-api" ? "outbound" : "inbound", To, From, agent?.name || "Default Assistant", contact.id);

  db.prepare("UPDATE calls SET status = 'in-progress', contact_id = ? WHERE call_sid = ?").run(contact.id, CallSid);

  // Store caller context for use during the call
  const callerContext = buildCallerContext(contact, isNew);
  if (callerContext) {
    db.prepare("INSERT INTO messages (call_sid, role, text) VALUES (?, 'system', ?)").run(CallSid, `[CONTEXT]${callerContext}`);
  }

  log("info", "Call connected", { callSid: CallSid, direction: Direction, contactId: contact.id, isNew });

  const twiml = new twilio.twiml.VoiceResponse();
  const greeting = agent?.greeting || "Hello! I'm your AI assistant. How can I help you today?";
  const voice = agent?.voice || "Polly.Joanna";
  const language = (agent?.language || "en-US") as any;

  buildTwimlSay(twiml, greeting, voice);
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
  const agent = getActiveAgent();
  const voice = agent?.voice || "Polly.Joanna";
  const language = (agent?.language || "en-US") as any;
  const maxTurns = agent?.max_turns || 20;
  const twiml = new twilio.twiml.VoiceResponse();

  // Get call record for context
  const callRecord = db.prepare("SELECT contact_id, turn_count FROM calls WHERE call_sid = ?").get(CallSid) as
    { contact_id: number | null; turn_count: number } | undefined;

  const contactId = callRecord?.contact_id || null;
  const turnCount = (callRecord?.turn_count || 0) + 1;

  // Update turn count
  db.prepare("UPDATE calls SET turn_count = ? WHERE call_sid = ?").run(turnCount, CallSid);

  // Max turns watchdog
  if (turnCount > maxTurns) {
    logEvent(CallSid, "MAX_TURNS_REACHED", { turnCount, maxTurns });
    log("warn", "Max turns reached", { callSid: CallSid, turnCount });
    buildTwimlSay(twiml, "We've been talking for a while. Let me connect you with someone from our team who can help you further. Have a great day!", voice);
    twiml.hangup();
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  logEvent(CallSid, "SPEECH_RECEIVED", { turnCount, speechLength: SpeechResult?.length || 0, confidence: Confidence });

  // Dead air / no speech detection
  if (!SpeechResult) {
    logEvent(CallSid, "DEAD_AIR_DETECTED", { turnCount });
    buildTwimlSay(twiml, "I didn't catch that. Could you please repeat?", voice);
    twiml.gather({ input: ["speech"], action: "/api/twilio/process", speechTimeout: "auto", speechModel: "phone_call", enhanced: true, language });
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // End-of-call keyword detection
  const endKeywords = ["goodbye", "bye", "hang up", "end call", "stop", "quit", "that's all", "no more", "thank you goodbye"];
  if (endKeywords.some((kw) => SpeechResult.toLowerCase().includes(kw))) {
    db.prepare("INSERT INTO messages (call_sid, role, text) VALUES (?, 'user', ?)").run(CallSid, SpeechResult);
    db.prepare("INSERT INTO messages (call_sid, role, text) VALUES (?, 'assistant', ?)").run(CallSid, "Goodbye! Have a great day!");
    buildTwimlSay(twiml, "Goodbye! Have a great day!", voice);
    twiml.hangup();
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Store user message
  db.prepare("INSERT INTO messages (call_sid, role, text) VALUES (?, 'user', ?)").run(CallSid, SpeechResult);

  // Load caller context for AI prompt
  let callerContext = "";
  if (contactId) {
    const ctxMsg = db.prepare(
      "SELECT text FROM messages WHERE call_sid = ? AND role = 'system' AND text LIKE '[CONTEXT]%' LIMIT 1"
    ).get(CallSid) as { text: string } | undefined;
    callerContext = ctxMsg?.text?.replace("[CONTEXT]", "") || "";
  }

  // Build dispatch context for live tool invocation
  const callerPhone = (db.prepare("SELECT from_number, direction FROM calls WHERE call_sid = ?").get(CallSid) as any);
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

  try {
    const agent = getActiveAgent();
    const systemPrompt = agent?.system_prompt || "You are a helpful AI assistant on a phone call. Be concise and conversational.";

    const { text: aiText, latencyMs, toolsInvoked, shouldHangUp } =
      await generateAiResponseWithTools(
        CallSid,
        SpeechResult,
        requestId,
        callerContext,
        systemPrompt,
        dispatchCtx,
        env.GEMINI_API_KEY!
      );

    db.prepare("INSERT INTO messages (call_sid, role, text) VALUES (?, 'assistant', ?)").run(CallSid, aiText);

    logEvent(CallSid, "AI_RESPONSE_GENERATED", {
      latencyMs,
      turnCount,
      responseLength: aiText.length,
      toolsInvoked,
    });
    log("info", "AI response delivered", {
      requestId,
      callSid: CallSid,
      latencyMs,
      turnCount,
      toolsInvoked,
    });

    buildTwimlSay(twiml, aiText, voice);

    if (shouldHangUp) {
      // After DNC or escalation, hang up gracefully
      twiml.hangup();
    } else {
      twiml.gather({ input: ["speech"], action: "/api/twilio/process", speechTimeout: "auto", speechModel: "phone_call", enhanced: true, language });
    }
  } catch (error: any) {
    log("error", "AI generation failed", { requestId, callSid: CallSid, error: error.message });
    logEvent(CallSid, "AI_ERROR", { error: error.message, turnCount });
    buildTwimlSay(twiml, "I'm sorry, I'm having trouble right now. Please hold while I connect you with someone from our team.", voice);
    twiml.hangup();
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// ── API: Get All Calls ────────────────────────────────────────────────────────
app.get("/api/calls", (req: Request, res: Response) => {
  const calls = db.prepare(`
    SELECT c.*, COUNT(m.id) as message_count,
           co.name as contact_name,
           cs.intent, cs.outcome, cs.summary as call_summary, cs.resolution_score as summary_score,
           cs.next_action, cs.sentiment
    FROM calls c
    LEFT JOIN messages m ON c.call_sid = m.call_sid AND m.role != 'system'
    LEFT JOIN contacts co ON c.contact_id = co.id
    LEFT JOIN call_summaries cs ON c.call_sid = cs.call_sid
    GROUP BY c.call_sid
    ORDER BY c.started_at DESC
    LIMIT 100
  `).all();
  res.json(calls);
});

// ── API: Get Call Messages ────────────────────────────────────────────────────
app.get("/api/calls/:callSid/messages", (req: Request, res: Response) => {
  const { callSid } = req.params;
  if (!/^CA[a-f0-9]{32}$/i.test(callSid)) return res.status(400).json({ error: "Invalid call SID format." });
  const call = db.prepare("SELECT * FROM calls WHERE call_sid = ?").get(callSid);
  if (!call) return res.status(404).json({ error: "Call not found." });
  const messages = db.prepare("SELECT * FROM messages WHERE call_sid = ? AND role != 'system' ORDER BY id ASC").all(callSid);
  const events = db.prepare("SELECT event_type, payload, created_at FROM call_events WHERE call_sid = ? ORDER BY id ASC").all(callSid);
  const summary = db.prepare("SELECT * FROM call_summaries WHERE call_sid = ?").get(callSid);
  res.json({ call, messages, events, summary });
});

// ── API: Contacts ─────────────────────────────────────────────────────────────
app.get("/api/contacts", (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string || "50"), 100);
  const offset = parseInt(req.query.offset as string || "0");
  const contacts = db.prepare(`
    SELECT c.*, COUNT(ca.id) as total_calls
    FROM contacts c
    LEFT JOIN calls ca ON c.id = ca.contact_id
    GROUP BY c.id
    ORDER BY c.last_seen DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  const total = (db.prepare("SELECT COUNT(*) as count FROM contacts").get() as any).count;
  res.json({ contacts, total });
});

app.get("/api/contacts/:id", (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid contact ID." });
  const contact = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id);
  if (!contact) return res.status(404).json({ error: "Contact not found." });
  const calls = db.prepare("SELECT * FROM calls WHERE contact_id = ? ORDER BY started_at DESC LIMIT 20").all(id);
  const tasks = db.prepare("SELECT * FROM tasks WHERE contact_id = ? ORDER BY created_at DESC").all(id);
  const appointments = db.prepare("SELECT * FROM appointments WHERE contact_id = ? ORDER BY scheduled_at DESC").all(id);
  res.json({ contact, calls, tasks, appointments });
});

// ── API: Tasks ────────────────────────────────────────────────────────────────
app.get("/api/tasks", (req: Request, res: Response) => {
  const status = req.query.status as string || "open";
  const tasks = db.prepare(`
    SELECT t.*, co.name as contact_name, co.phone_number
    FROM tasks t
    LEFT JOIN contacts co ON t.contact_id = co.id
    WHERE t.status = ?
    ORDER BY t.due_at ASC, t.created_at DESC
    LIMIT 100
  `).all(status);
  res.json(tasks);
});

app.put("/api/tasks/:id", (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid task ID." });
  const { status, notes } = req.body;
  if (!["open", "in_progress", "completed", "cancelled"].includes(status)) {
    return res.status(400).json({ error: "Invalid status." });
  }
  db.prepare("UPDATE tasks SET status = ?, notes = ?, completed_at = ? WHERE id = ?").run(
    status,
    notes || null,
    status === "completed" ? new Date().toISOString() : null,
    id
  );
  res.json({ success: true });
});

// ── API: Handoffs ─────────────────────────────────────────────────────────────
app.get("/api/handoffs", (req: Request, res: Response) => {
  const handoffs = db.prepare(`
    SELECT h.*, co.name as contact_name, co.phone_number
    FROM handoffs h
    LEFT JOIN contacts co ON h.contact_id = co.id
    WHERE h.status = 'pending'
    ORDER BY h.created_at DESC
    LIMIT 50
  `).all();
  res.json(handoffs);
});

app.put("/api/handoffs/:id/acknowledge", (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid handoff ID." });
  db.prepare("UPDATE handoffs SET status = 'acknowledged' WHERE id = ?").run(id);
  res.json({ success: true });
});

// ── API: Call Summaries ───────────────────────────────────────────────────────
app.get("/api/summaries", (req: Request, res: Response) => {
  const summaries = db.prepare(`
    SELECT cs.*, co.name as contact_name, co.phone_number
    FROM call_summaries cs
    LEFT JOIN contacts co ON cs.contact_id = co.id
    ORDER BY cs.created_at DESC
    LIMIT 50
  `).all();
  res.json(summaries);
});

// ── API: Agent Config CRUD ────────────────────────────────────────────────────
app.get("/api/agents", (_req: Request, res: Response) => {
  res.json(db.prepare("SELECT * FROM agent_configs ORDER BY id DESC").all());
});

app.post("/api/agents", (req: Request, res: Response) => {
  const parsed = AgentConfigSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { name, system_prompt, greeting, voice, language, vertical, max_turns } = parsed.data;
  db.prepare("UPDATE agent_configs SET is_active = 0").run();
  const result = db.prepare(`
    INSERT INTO agent_configs (name, system_prompt, greeting, voice, language, is_active, vertical, max_turns)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(name, system_prompt, greeting, voice, language, vertical, max_turns);
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put("/api/agents/:id/activate", (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid agent ID." });
  db.prepare("UPDATE agent_configs SET is_active = 0").run();
  db.prepare("UPDATE agent_configs SET is_active = 1 WHERE id = ?").run(id);
  res.json({ success: true });
});

app.put("/api/agents/:id", (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid agent ID." });
  const parsed = AgentConfigSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { name, system_prompt, greeting, voice, language, vertical, max_turns } = parsed.data;
  db.prepare(`
    UPDATE agent_configs SET name = ?, system_prompt = ?, greeting = ?, voice = ?, language = ?, vertical = ?, max_turns = ?
    WHERE id = ?
  `).run(name, system_prompt, greeting, voice, language, vertical, max_turns, id);
  res.json({ success: true });
});

app.delete("/api/agents/:id", (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid agent ID." });
  db.prepare("DELETE FROM agent_configs WHERE id = ?").run(id);
  res.json({ success: true });
});

// ── API: Stats ────────────────────────────────────────────────────────────────
app.get("/api/stats", (_req: Request, res: Response) => {
  const totalCalls = (db.prepare("SELECT COUNT(*) as count FROM calls").get() as any).count;
  const activeCalls = (db.prepare("SELECT COUNT(*) as count FROM calls WHERE status = 'in-progress'").get() as any).count;
  const completedCalls = (db.prepare("SELECT COUNT(*) as count FROM calls WHERE status = 'completed'").get() as any).count;
  const totalMessages = (db.prepare("SELECT COUNT(*) as count FROM messages WHERE role != 'system'").get() as any).count;
  const totalContacts = (db.prepare("SELECT COUNT(*) as count FROM contacts").get() as any).count;
  const avgDuration = (db.prepare("SELECT AVG(duration_seconds) as avg FROM calls WHERE duration_seconds IS NOT NULL").get() as any).avg;
  const inboundCalls = (db.prepare("SELECT COUNT(*) as count FROM calls WHERE direction = 'inbound'").get() as any).count;
  const outboundCalls = (db.prepare("SELECT COUNT(*) as count FROM calls WHERE direction = 'outbound'").get() as any).count;
  const avgAiLatency = (db.prepare("SELECT AVG(duration_ms) as avg FROM request_logs WHERE path = '/api/twilio/process' AND status_code = 200").get() as any).avg;
  const openTasks = (db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'open'").get() as any).count;
  const pendingHandoffs = (db.prepare("SELECT COUNT(*) as count FROM handoffs WHERE status = 'pending'").get() as any).count;
  const avgResolution = (db.prepare("SELECT AVG(resolution_score) as avg FROM call_summaries").get() as any).avg;
  const callsToday = (db.prepare("SELECT COUNT(*) as count FROM calls WHERE date(started_at) = date('now')").get() as any).count;
  const callsThisWeek = (db.prepare("SELECT COUNT(*) as count FROM calls WHERE started_at >= datetime('now', '-7 days')").get() as any).count;
  const transferRate = totalCalls > 0
    ? ((db.prepare("SELECT COUNT(*) as count FROM handoffs").get() as any).count / totalCalls)
    : 0;
  const bookingRate = totalCalls > 0
    ? ((db.prepare("SELECT COUNT(*) as count FROM appointments WHERE status = 'scheduled'").get() as any).count / totalCalls)
    : 0;

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

// ── API: Webhook URL ──────────────────────────────────────────────────────────
app.get("/api/webhook-url", (_req: Request, res: Response) => {
  const appUrl = getAppUrl();
  res.json({ incomingUrl: `${appUrl}/api/twilio/incoming`, statusUrl: `${appUrl}/api/twilio/status` });
});

// ── API: Request Logs ─────────────────────────────────────────────────────────
app.get("/api/logs", (_req: Request, res: Response) => {
  res.json(db.prepare("SELECT * FROM request_logs ORDER BY id DESC LIMIT 200").all());
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
  db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ── Vite Middleware / Static Files ────────────────────────────────────────────
async function startServer() {
  if (!IS_PROD) {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "dist", "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => {
    log("info", "AI Phone Agent started", {
      port: PORT,
      env: env.NODE_ENV || "development",
      webhookUrl: `${getAppUrl()}/api/twilio/incoming`,
      authEnabled: !!env.DASHBOARD_API_KEY,
    });
  });
}

startServer().catch((err) => {
  log("error", "Failed to start server", { error: err.message });
  process.exit(1);
});
