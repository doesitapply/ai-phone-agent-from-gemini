import express, { Request, Response, NextFunction } from "express";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import twilio from "twilio";
import cors from "cors";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import morgan from "morgan";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

dotenv.config({ path: ".env.local" });
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Environment Schema Validation ───────────────────────────────────────────
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
  envResult.error.issues.forEach((issue) => {
    console.error(`   ${issue.path.join(".")}: ${issue.message}`);
  });
  process.exit(1);
}

const env = envResult.data;
const PORT = parseInt(env.PORT || "3000", 10);
const IS_PROD = env.NODE_ENV === "production";

// ─── Structured Logger ────────────────────────────────────────────────────────
type LogLevel = "info" | "warn" | "error" | "debug";

const log = (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  if (IS_PROD) {
    console.log(JSON.stringify(entry));
  } else {
    const color = { info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m", debug: "\x1b[90m" }[level];
    const reset = "\x1b[0m";
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    console.log(`${color}[${level.toUpperCase()}]${reset} ${message}${metaStr}`);
  }
};

// ─── SQLite Database Setup ────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, "calls.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_sid TEXT UNIQUE NOT NULL,
    direction TEXT NOT NULL DEFAULT 'inbound',
    to_number TEXT,
    from_number TEXT,
    status TEXT NOT NULL DEFAULT 'initiated',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    duration_seconds INTEGER,
    agent_name TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_sid TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (call_sid) REFERENCES calls(call_sid)
  );

  CREATE TABLE IF NOT EXISTS agent_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    greeting TEXT NOT NULL,
    voice TEXT NOT NULL DEFAULT 'Polly.Joanna',
    language TEXT NOT NULL DEFAULT 'en-US',
    is_active INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status_code INTEGER,
    duration_ms INTEGER,
    ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Seed default agent config if none exists
const existingConfig = db.prepare("SELECT COUNT(*) as count FROM agent_configs").get() as { count: number };
if (existingConfig.count === 0) {
  db.prepare(`
    INSERT INTO agent_configs (name, system_prompt, greeting, voice, language, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(
    "Default Assistant",
    "You are a helpful, friendly AI assistant on a phone call. Keep your answers concise, conversational, and easy to understand when spoken aloud. Do not use markdown, bullet points, or special formatting. Speak naturally as if in a real phone conversation. Be empathetic and professional.",
    "Hello! I'm your AI assistant. How can I help you today?",
    "Polly.Joanna",
    "en-US"
  );
  log("info", "Seeded default agent configuration");
}

// ─── Express App Setup ────────────────────────────────────────────────────────
const app = express();

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: false, // Disabled to allow Vite dev server
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(cors());

// HTTP request logging via morgan
app.use(
  morgan(IS_PROD ? "combined" : "dev", {
    stream: { write: (msg) => log("info", msg.trim(), { type: "http" }) },
  })
);

// ─── Request ID Middleware ────────────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = uuidv4();
  (req as any).requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  next();
});

// ─── Request Logging Middleware ───────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    const requestId = (req as any).requestId;
    // Only log API routes to avoid noise from Vite assets
    if (req.path.startsWith("/api/")) {
      log("info", `${req.method} ${req.path}`, {
        requestId,
        status: res.statusCode,
        durationMs: duration,
        ip: req.ip,
      });
      try {
        db.prepare(`
          INSERT INTO request_logs (request_id, method, path, status_code, duration_ms, ip)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(requestId, req.method, req.path, res.statusCode, duration, req.ip);
      } catch {
        // Non-critical — don't crash on log failure
      }
    }
  });
  next();
});

// ─── Rate Limiting ────────────────────────────────────────────────────────────
// Strict limit for outbound call initiation (prevent abuse)
const callRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { error: "Too many call requests. Please wait before trying again." },
  standardHeaders: true,
  legacyHeaders: false,
});

// General API rate limit
const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: "Too many requests. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Twilio webhooks — no rate limit (Twilio controls these)
app.use("/api/twilio", (req: Request, res: Response, next: NextFunction) => next());

// Apply rate limits to all other API routes
app.use("/api/calls", apiRateLimit);
app.use("/api/agents", apiRateLimit);
app.use("/api/stats", apiRateLimit);

// ─── Dashboard API Key Authentication ────────────────────────────────────────
// Optional: set DASHBOARD_API_KEY in .env.local to protect the dashboard API
const dashboardAuth = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = env.DASHBOARD_API_KEY;
  if (!apiKey) return next(); // No key configured = open access (dev mode)

  const provided = req.headers["x-api-key"] || req.query.apiKey;
  if (provided !== apiKey) {
    log("warn", "Unauthorized API access attempt", {
      requestId: (req as any).requestId,
      path: req.path,
      ip: req.ip,
    });
    return res.status(401).json({ error: "Unauthorized. Provide a valid X-Api-Key header." });
  }
  next();
};

// Protect dashboard API routes (not Twilio webhooks)
app.use("/api/calls", dashboardAuth);
app.use("/api/agents", dashboardAuth);
app.use("/api/stats", dashboardAuth);
app.use("/api/logs", dashboardAuth);
app.use("/api/webhook-url", dashboardAuth);

// ─── Input Validation Schemas ─────────────────────────────────────────────────
const OutboundCallSchema = z.object({
  to: z.string().regex(/^\+[1-9]\d{7,14}$/, "Phone number must be in E.164 format (e.g. +15551234567)"),
});

const AgentConfigSchema = z.object({
  name: z.string().min(1).max(100),
  system_prompt: z.string().min(10).max(4000),
  greeting: z.string().min(5).max(500),
  voice: z.string().regex(/^Polly\.|^alice$|^man$|^woman$/).optional().default("Polly.Joanna"),
  language: z.string().min(2).max(10).optional().default("en-US"),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
const getActiveAgent = () => {
  return db.prepare("SELECT * FROM agent_configs WHERE is_active = 1 ORDER BY id DESC LIMIT 1").get() as {
    id: number; name: string; system_prompt: string; greeting: string; voice: string; language: string;
  } | undefined;
};

const getAi = () => {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not configured.");
  return new GoogleGenAI({ apiKey: key });
};

const getTwilioClient = () => {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) throw new Error("Twilio credentials not configured.");
  return twilio(accountSid, authToken);
};

const getAppUrl = () => {
  const url = env.APP_URL || `http://localhost:${PORT}`;
  return url.replace("ais-dev-", "ais-pre-");
};

const buildTwimlSay = (twiml: twilio.twiml.VoiceResponse, text: string, voice: string) => {
  if (voice.startsWith("Polly.")) {
    twiml.say({ voice: voice as any }, text);
  } else {
    twiml.say(text);
  }
};

const generateAiResponse = async (
  callSid: string,
  userSpeech: string,
  requestId: string
): Promise<{ text: string; latencyMs: number }> => {
  const agent = getActiveAgent();
  const systemPrompt = agent?.system_prompt || "You are a helpful AI assistant on a phone call. Be concise and conversational.";

  const history = db.prepare(
    "SELECT role, text FROM messages WHERE call_sid = ? ORDER BY id ASC"
  ).all(callSid) as { role: string; text: string }[];

  const historyText = history
    .map((msg) => `${msg.role === "user" ? "Caller" : "Assistant"}: ${msg.text}`)
    .join("\n");

  const prompt = `${systemPrompt}

${historyText ? `Conversation so far:\n${historyText}\n` : ""}Caller: ${userSpeech}
Assistant:`;

  const aiStart = Date.now();
  const ai = getAi();
  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: prompt,
  });
  const latencyMs = Date.now() - aiStart;

  log("info", "Gemini response generated", {
    requestId,
    callSid,
    latencyMs,
    inputTokens: prompt.length,
    outputLength: response.text?.length || 0,
  });

  return {
    text: response.text?.trim() || "I'm sorry, I encountered an error processing your request.",
    latencyMs,
  };
};

// ─── API: Make Outbound Call ──────────────────────────────────────────────────
app.post("/api/calls", callRateLimit, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  const parsed = OutboundCallSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { to } = parsed.data;
  const from = env.TWILIO_PHONE_NUMBER;
  if (!from) return res.status(400).json({ error: "TWILIO_PHONE_NUMBER is not configured." });

  const appUrl = getAppUrl();

  try {
    const client = getTwilioClient();
    const call = await client.calls.create({
      url: `${appUrl}/api/twilio/incoming`,
      to,
      from,
      statusCallback: `${appUrl}/api/twilio/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });

    const agent = getActiveAgent();
    db.prepare(`
      INSERT OR IGNORE INTO calls (call_sid, direction, to_number, from_number, status, agent_name)
      VALUES (?, 'outbound', ?, ?, 'initiated', ?)
    `).run(call.sid, to, from, agent?.name || "Default Assistant");

    log("info", "Outbound call initiated", { requestId, callSid: call.sid, to });
    res.json({ success: true, callSid: call.sid });
  } catch (error: any) {
    log("error", "Outbound call failed", { requestId, error: error.message, to });
    res.status(500).json({ error: error.message });
  }
});

// ─── Twilio Webhook: Call Status Updates ─────────────────────────────────────
app.post("/api/twilio/status", (req: Request, res: Response) => {
  const { CallSid, CallStatus, CallDuration } = req.body;

  if (["completed", "failed", "busy", "no-answer"].includes(CallStatus)) {
    db.prepare(`
      UPDATE calls SET status = ?, ended_at = datetime('now'), duration_seconds = ?
      WHERE call_sid = ?
    `).run(CallStatus, CallDuration ? parseInt(CallDuration) : null, CallSid);
  } else {
    db.prepare("UPDATE calls SET status = ? WHERE call_sid = ?").run(CallStatus, CallSid);
  }

  log("info", "Call status updated", { callSid: CallSid, status: CallStatus, duration: CallDuration });
  res.sendStatus(200);
});

// ─── Twilio Webhook: Incoming / Outbound Connected ───────────────────────────
app.post("/api/twilio/incoming", (req: Request, res: Response) => {
  const { CallSid, To, From, Direction } = req.body;
  const agent = getActiveAgent();

  db.prepare(`
    INSERT OR IGNORE INTO calls (call_sid, direction, to_number, from_number, status, agent_name)
    VALUES (?, ?, ?, ?, 'in-progress', ?)
  `).run(CallSid, Direction === "outbound-api" ? "outbound" : "inbound", To, From, agent?.name || "Default Assistant");

  db.prepare("UPDATE calls SET status = 'in-progress' WHERE call_sid = ?").run(CallSid);

  log("info", "Call connected", { callSid: CallSid, direction: Direction, from: From, to: To });

  const twiml = new twilio.twiml.VoiceResponse();
  const greeting = agent?.greeting || "Hello! I'm your AI assistant. How can I help you today?";
  const voice = agent?.voice || "Polly.Joanna";

  buildTwimlSay(twiml, greeting, voice);
  twiml.gather({
    input: ["speech"],
    action: "/api/twilio/process",
    speechTimeout: "auto",
    speechModel: "phone_call",
    enhanced: true,
    language: (agent?.language || "en-US") as any,
  });

  twiml.say("I didn't hear anything. Goodbye!");
  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

// ─── Twilio Webhook: Process Speech ──────────────────────────────────────────
app.post("/api/twilio/process", async (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  const { CallSid, SpeechResult, Confidence } = req.body;
  const agent = getActiveAgent();
  const voice = agent?.voice || "Polly.Joanna";
  const language = (agent?.language || "en-US") as any;
  const twiml = new twilio.twiml.VoiceResponse();

  log("info", "Speech received", {
    requestId,
    callSid: CallSid,
    speechLength: SpeechResult?.length || 0,
    confidence: Confidence,
  });

  // Handle end-of-call keywords
  const endKeywords = ["goodbye", "bye", "hang up", "end call", "stop", "quit", "that's all", "no more"];
  if (SpeechResult && endKeywords.some((kw) => SpeechResult.toLowerCase().includes(kw))) {
    db.prepare("INSERT INTO messages (call_sid, role, text) VALUES (?, 'user', ?)").run(CallSid, SpeechResult);
    db.prepare("INSERT INTO messages (call_sid, role, text) VALUES (?, 'assistant', ?)").run(CallSid, "Goodbye! Have a great day!");
    log("info", "Call ended by keyword", { requestId, callSid: CallSid, keyword: SpeechResult });
    buildTwimlSay(twiml, "Goodbye! Have a great day!", voice);
    twiml.hangup();
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  if (!SpeechResult) {
    buildTwimlSay(twiml, "I didn't catch that. Could you please repeat?", voice);
    twiml.gather({ input: ["speech"], action: "/api/twilio/process", speechTimeout: "auto", speechModel: "phone_call", enhanced: true, language });
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  db.prepare("INSERT INTO messages (call_sid, role, text) VALUES (?, 'user', ?)").run(CallSid, SpeechResult);

  try {
    const { text: aiText, latencyMs } = await generateAiResponse(CallSid, SpeechResult, requestId);
    db.prepare("INSERT INTO messages (call_sid, role, text) VALUES (?, 'assistant', ?)").run(CallSid, aiText);

    log("info", "AI response delivered", { requestId, callSid: CallSid, latencyMs, responseLength: aiText.length });

    buildTwimlSay(twiml, aiText, voice);
    twiml.gather({ input: ["speech"], action: "/api/twilio/process", speechTimeout: "auto", speechModel: "phone_call", enhanced: true, language });
  } catch (error: any) {
    log("error", "AI generation failed", { requestId, callSid: CallSid, error: error.message });
    buildTwimlSay(twiml, "I'm sorry, I'm having trouble processing that right now. Please try again.", voice);
    twiml.gather({ input: ["speech"], action: "/api/twilio/process", speechTimeout: "auto", speechModel: "phone_call", enhanced: true, language });
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// ─── API: Get All Calls ───────────────────────────────────────────────────────
app.get("/api/calls", (req: Request, res: Response) => {
  const calls = db.prepare(`
    SELECT c.*, COUNT(m.id) as message_count
    FROM calls c
    LEFT JOIN messages m ON c.call_sid = m.call_sid
    GROUP BY c.call_sid
    ORDER BY c.started_at DESC
    LIMIT 100
  `).all();
  res.json(calls);
});

// ─── API: Get Messages for a Call ────────────────────────────────────────────
app.get("/api/calls/:callSid/messages", (req: Request, res: Response) => {
  const { callSid } = req.params;
  // Validate callSid format (Twilio SIDs start with CA)
  if (!/^CA[a-f0-9]{32}$/i.test(callSid)) {
    return res.status(400).json({ error: "Invalid call SID format." });
  }
  const call = db.prepare("SELECT * FROM calls WHERE call_sid = ?").get(callSid);
  if (!call) return res.status(404).json({ error: "Call not found." });
  const messages = db.prepare("SELECT * FROM messages WHERE call_sid = ? ORDER BY id ASC").all(callSid);
  res.json({ call, messages });
});

// ─── API: Agent Config CRUD ───────────────────────────────────────────────────
app.get("/api/agents", (_req: Request, res: Response) => {
  res.json(db.prepare("SELECT * FROM agent_configs ORDER BY id DESC").all());
});

app.post("/api/agents", (req: Request, res: Response) => {
  const parsed = AgentConfigSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { name, system_prompt, greeting, voice, language } = parsed.data;
  db.prepare("UPDATE agent_configs SET is_active = 0").run();
  const result = db.prepare(`
    INSERT INTO agent_configs (name, system_prompt, greeting, voice, language, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(name, system_prompt, greeting, voice, language);
  log("info", "Agent config created", { name, id: result.lastInsertRowid });
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put("/api/agents/:id/activate", (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid agent ID." });
  db.prepare("UPDATE agent_configs SET is_active = 0").run();
  db.prepare("UPDATE agent_configs SET is_active = 1 WHERE id = ?").run(id);
  log("info", "Agent activated", { id });
  res.json({ success: true });
});

app.put("/api/agents/:id", (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid agent ID." });
  const parsed = AgentConfigSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { name, system_prompt, greeting, voice, language } = parsed.data;
  db.prepare(`
    UPDATE agent_configs SET name = ?, system_prompt = ?, greeting = ?, voice = ?, language = ?
    WHERE id = ?
  `).run(name, system_prompt, greeting, voice, language, id);
  log("info", "Agent config updated", { id, name });
  res.json({ success: true });
});

app.delete("/api/agents/:id", (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid agent ID." });
  db.prepare("DELETE FROM agent_configs WHERE id = ?").run(id);
  log("info", "Agent config deleted", { id });
  res.json({ success: true });
});

// ─── API: Stats ───────────────────────────────────────────────────────────────
app.get("/api/stats", (_req: Request, res: Response) => {
  const totalCalls = (db.prepare("SELECT COUNT(*) as count FROM calls").get() as any).count;
  const activeCalls = (db.prepare("SELECT COUNT(*) as count FROM calls WHERE status = 'in-progress'").get() as any).count;
  const completedCalls = (db.prepare("SELECT COUNT(*) as count FROM calls WHERE status = 'completed'").get() as any).count;
  const totalMessages = (db.prepare("SELECT COUNT(*) as count FROM messages").get() as any).count;
  const avgDuration = (db.prepare("SELECT AVG(duration_seconds) as avg FROM calls WHERE duration_seconds IS NOT NULL").get() as any).avg;
  const inboundCalls = (db.prepare("SELECT COUNT(*) as count FROM calls WHERE direction = 'inbound'").get() as any).count;
  const outboundCalls = (db.prepare("SELECT COUNT(*) as count FROM calls WHERE direction = 'outbound'").get() as any).count;
  const avgAiLatency = (db.prepare(`
    SELECT AVG(duration_ms) as avg FROM request_logs WHERE path = '/api/twilio/process' AND status_code = 200
  `).get() as any).avg;

  res.json({
    totalCalls,
    activeCalls,
    completedCalls,
    totalMessages,
    avgDurationSeconds: avgDuration ? Math.round(avgDuration) : 0,
    inboundCalls,
    outboundCalls,
    avgAiLatencyMs: avgAiLatency ? Math.round(avgAiLatency) : 0,
  });
});

// ─── API: Webhook URL ─────────────────────────────────────────────────────────
app.get("/api/webhook-url", (_req: Request, res: Response) => {
  const appUrl = getAppUrl();
  res.json({
    incomingUrl: `${appUrl}/api/twilio/incoming`,
    statusUrl: `${appUrl}/api/twilio/status`,
  });
});

// ─── API: Recent Request Logs ─────────────────────────────────────────────────
app.get("/api/logs", (_req: Request, res: Response) => {
  const logs = db.prepare(`
    SELECT * FROM request_logs ORDER BY id DESC LIMIT 200
  `).all();
  res.json(logs);
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  log("error", "Unhandled error", {
    requestId: (req as any).requestId,
    error: err.message,
    stack: IS_PROD ? undefined : err.stack,
  });
  res.status(500).json({ error: IS_PROD ? "Internal server error." : err.message });
});

// ─── Vite Middleware / Static Files ──────────────────────────────────────────
async function startServer() {
  if (!IS_PROD) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    log("info", `AI Phone Agent started`, {
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
