import express from "express";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import twilio from "twilio";
import cors from "cors";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

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
`);

// Seed a default agent config if none exists
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
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const getActiveAgent = () => {
  return db.prepare("SELECT * FROM agent_configs WHERE is_active = 1 ORDER BY id DESC LIMIT 1").get() as {
    id: number; name: string; system_prompt: string; greeting: string; voice: string; language: string;
  } | undefined;
};

const getAi = () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not configured.");
  return new GoogleGenAI({ apiKey: key });
};

const getTwilioClient = () => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) throw new Error("Twilio credentials not configured.");
  return twilio(accountSid, authToken);
};

const getAppUrl = () => {
  const url = process.env.APP_URL || `http://localhost:${PORT}`;
  // Support AI Studio's ais-dev -> ais-pre URL swap for webhooks
  return url.replace("ais-dev-", "ais-pre-");
};

const buildTwimlSay = (twiml: twilio.twiml.VoiceResponse, text: string, voice: string) => {
  // Use Polly voices for better quality
  if (voice.startsWith("Polly.")) {
    twiml.say({ voice: voice as any }, text);
  } else {
    twiml.say(text);
  }
};

const generateAiResponse = async (callSid: string, userSpeech: string): Promise<string> => {
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

  const ai = getAi();
  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: prompt,
  });

  return response.text?.trim() || "I'm sorry, I encountered an error processing your request.";
};

// ─── API: Make Outbound Call ──────────────────────────────────────────────────
app.post("/api/calls", async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: "Phone number is required." });

  const from = process.env.TWILIO_PHONE_NUMBER;
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

    res.json({ success: true, callSid: call.sid });
  } catch (error: any) {
    console.error("Outbound call error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Twilio Webhook: Call Status Updates ─────────────────────────────────────
app.post("/api/twilio/status", (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;

  if (CallStatus === "completed" || CallStatus === "failed" || CallStatus === "busy" || CallStatus === "no-answer") {
    db.prepare(`
      UPDATE calls SET status = ?, ended_at = datetime('now'), duration_seconds = ?
      WHERE call_sid = ?
    `).run(CallStatus, CallDuration ? parseInt(CallDuration) : null, CallSid);
  } else {
    db.prepare("UPDATE calls SET status = ? WHERE call_sid = ?").run(CallStatus, CallSid);
  }

  res.sendStatus(200);
});

// ─── Twilio Webhook: Incoming / Outbound Connected ───────────────────────────
app.post("/api/twilio/incoming", (req, res) => {
  const { CallSid, To, From, Direction } = req.body;
  const agent = getActiveAgent();

  // Upsert call record
  db.prepare(`
    INSERT OR IGNORE INTO calls (call_sid, direction, to_number, from_number, status, agent_name)
    VALUES (?, ?, ?, ?, 'in-progress', ?)
  `).run(CallSid, Direction === "outbound-api" ? "outbound" : "inbound", To, From, agent?.name || "Default Assistant");

  db.prepare("UPDATE calls SET status = 'in-progress' WHERE call_sid = ?").run(CallSid);

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

  // Fallback if no speech detected
  twiml.say("I didn't hear anything. Goodbye!");
  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

// ─── Twilio Webhook: Process Speech ──────────────────────────────────────────
app.post("/api/twilio/process", async (req, res) => {
  const { CallSid, SpeechResult, Confidence } = req.body;
  const agent = getActiveAgent();
  const voice = agent?.voice || "Polly.Joanna";
  const language = (agent?.language || "en-US") as any;
  const twiml = new twilio.twiml.VoiceResponse();

  // Handle end-of-call keywords
  const endKeywords = ["goodbye", "bye", "hang up", "end call", "stop", "quit"];
  if (SpeechResult && endKeywords.some((kw) => SpeechResult.toLowerCase().includes(kw))) {
    db.prepare(`
      INSERT INTO messages (call_sid, role, text) VALUES (?, 'user', ?)
    `).run(CallSid, SpeechResult);
    db.prepare(`
      INSERT INTO messages (call_sid, role, text) VALUES (?, 'assistant', ?)
    `).run(CallSid, "Goodbye! Have a great day!");
    buildTwimlSay(twiml, "Goodbye! Have a great day!", voice);
    twiml.hangup();
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  if (!SpeechResult) {
    buildTwimlSay(twiml, "I didn't catch that. Could you please repeat?", voice);
    twiml.gather({
      input: ["speech"],
      action: "/api/twilio/process",
      speechTimeout: "auto",
      speechModel: "phone_call",
      enhanced: true,
      language,
    });
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Store user message
  db.prepare("INSERT INTO messages (call_sid, role, text) VALUES (?, 'user', ?)").run(CallSid, SpeechResult);

  try {
    const aiText = await generateAiResponse(CallSid, SpeechResult);

    // Store AI response
    db.prepare("INSERT INTO messages (call_sid, role, text) VALUES (?, 'assistant', ?)").run(CallSid, aiText);

    buildTwimlSay(twiml, aiText, voice);
    twiml.gather({
      input: ["speech"],
      action: "/api/twilio/process",
      speechTimeout: "auto",
      speechModel: "phone_call",
      enhanced: true,
      language,
    });
  } catch (error: any) {
    console.error("AI processing error:", error);
    buildTwimlSay(twiml, "I'm sorry, I'm having trouble processing that right now. Please try again.", voice);
    twiml.gather({
      input: ["speech"],
      action: "/api/twilio/process",
      speechTimeout: "auto",
      speechModel: "phone_call",
      enhanced: true,
      language,
    });
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// ─── API: Get All Calls ───────────────────────────────────────────────────────
app.get("/api/calls", (req, res) => {
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
app.get("/api/calls/:callSid/messages", (req, res) => {
  const { callSid } = req.params;
  const call = db.prepare("SELECT * FROM calls WHERE call_sid = ?").get(callSid);
  if (!call) return res.status(404).json({ error: "Call not found." });

  const messages = db.prepare(
    "SELECT * FROM messages WHERE call_sid = ? ORDER BY id ASC"
  ).all(callSid);
  res.json({ call, messages });
});

// ─── API: Get Agent Configs ───────────────────────────────────────────────────
app.get("/api/agents", (req, res) => {
  const agents = db.prepare("SELECT * FROM agent_configs ORDER BY id DESC").all();
  res.json(agents);
});

// ─── API: Create Agent Config ─────────────────────────────────────────────────
app.post("/api/agents", (req, res) => {
  const { name, system_prompt, greeting, voice, language } = req.body;
  if (!name || !system_prompt || !greeting) {
    return res.status(400).json({ error: "name, system_prompt, and greeting are required." });
  }

  // Deactivate all others
  db.prepare("UPDATE agent_configs SET is_active = 0").run();

  const result = db.prepare(`
    INSERT INTO agent_configs (name, system_prompt, greeting, voice, language, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(name, system_prompt, greeting, voice || "Polly.Joanna", language || "en-US");

  res.json({ success: true, id: result.lastInsertRowid });
});

// ─── API: Activate Agent Config ───────────────────────────────────────────────
app.put("/api/agents/:id/activate", (req, res) => {
  const { id } = req.params;
  db.prepare("UPDATE agent_configs SET is_active = 0").run();
  db.prepare("UPDATE agent_configs SET is_active = 1 WHERE id = ?").run(id);
  res.json({ success: true });
});

// ─── API: Update Agent Config ─────────────────────────────────────────────────
app.put("/api/agents/:id", (req, res) => {
  const { id } = req.params;
  const { name, system_prompt, greeting, voice, language } = req.body;
  db.prepare(`
    UPDATE agent_configs SET name = ?, system_prompt = ?, greeting = ?, voice = ?, language = ?
    WHERE id = ?
  `).run(name, system_prompt, greeting, voice || "Polly.Joanna", language || "en-US", id);
  res.json({ success: true });
});

// ─── API: Delete Agent Config ─────────────────────────────────────────────────
app.delete("/api/agents/:id", (req, res) => {
  const { id } = req.params;
  db.prepare("DELETE FROM agent_configs WHERE id = ?").run(id);
  res.json({ success: true });
});

// ─── API: Get Stats ───────────────────────────────────────────────────────────
app.get("/api/stats", (req, res) => {
  const totalCalls = (db.prepare("SELECT COUNT(*) as count FROM calls").get() as any).count;
  const activeCalls = (db.prepare("SELECT COUNT(*) as count FROM calls WHERE status = 'in-progress'").get() as any).count;
  const completedCalls = (db.prepare("SELECT COUNT(*) as count FROM calls WHERE status = 'completed'").get() as any).count;
  const totalMessages = (db.prepare("SELECT COUNT(*) as count FROM messages").get() as any).count;
  const avgDuration = (db.prepare("SELECT AVG(duration_seconds) as avg FROM calls WHERE duration_seconds IS NOT NULL").get() as any).avg;
  const inboundCalls = (db.prepare("SELECT COUNT(*) as count FROM calls WHERE direction = 'inbound'").get() as any).count;
  const outboundCalls = (db.prepare("SELECT COUNT(*) as count FROM calls WHERE direction = 'outbound'").get() as any).count;

  res.json({
    totalCalls,
    activeCalls,
    completedCalls,
    totalMessages,
    avgDurationSeconds: avgDuration ? Math.round(avgDuration) : 0,
    inboundCalls,
    outboundCalls,
  });
});

// ─── API: Get Webhook URL ─────────────────────────────────────────────────────
app.get("/api/webhook-url", (req, res) => {
  const appUrl = getAppUrl();
  res.json({
    incomingUrl: `${appUrl}/api/twilio/incoming`,
    statusUrl: `${appUrl}/api/twilio/status`,
  });
});

// ─── Vite Middleware / Static Files ──────────────────────────────────────────
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
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
    console.log(`\n🚀 AI Phone Agent running on http://localhost:${PORT}`);
    console.log(`📞 Twilio webhook URL: ${getAppUrl()}/api/twilio/incoming`);
    console.log(`📊 Status callback URL: ${getAppUrl()}/api/twilio/status\n`);
  });
}

startServer().catch(console.error);
