import { GoogleGenAI } from "@google/genai";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { google } from "googleapis";
import twilio from "twilio";
import { generateGoogleSpeech } from "../google-tts.js";
import type { OpenClawConfig } from "../openclaw.js";
import { generateOpenAISpeech, type OpenAITTSConfig } from "../openai-tts.js";
import {
  SETTINGS_GROUPS,
  getConfigStatus,
  getMaskedSettings,
  writeEnvFile,
} from "../settings.js";

type SettingsRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: (req: Request, res: Response, next: NextFunction) => void;
  sql: any;
  dbEnabled: boolean;
  env: Record<string, string | undefined>;
  getAppUrl: () => string;
  reloadOpenClawConfig: () => Promise<void>;
  testOpenClawConnection: (config: OpenClawConfig) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

const IDENTITY_KEYS = [
  "BUSINESS_NAME",
  "BUSINESS_TAGLINE",
  "BUSINESS_PHONE",
  "BUSINESS_WEBSITE",
  "BUSINESS_ADDRESS",
  "BUSINESS_HOURS",
  "AGENT_NAME",
  "AGENT_PERSONA",
  "BUSINESS_TIMEZONE",
  "BOOKING_LINK",
  "INBOUND_GREETING",
  "OUTBOUND_GREETING",
];

export function registerSettingsRoutes(app: Express, deps: SettingsRouteDeps): void {
  const {
    dashboardAuth,
    requireOperator,
    sql,
    dbEnabled,
    env,
    getAppUrl,
    reloadOpenClawConfig,
    testOpenClawConnection,
    log,
  } = deps;

  app.get("/api/settings/groups", dashboardAuth, requireOperator, (_req: Request, res: Response) => {
    res.json({ groups: SETTINGS_GROUPS });
  });

  app.get("/api/webhook-url", dashboardAuth, (_req: Request, res: Response) => {
    const appUrl = getAppUrl();
    res.json({ incomingUrl: `${appUrl}/api/twilio/incoming`, statusUrl: `${appUrl}/api/twilio/status` });
  });

  app.get("/api/logs", dashboardAuth, requireOperator, async (_req: Request, res: Response) => {
    if (!dbEnabled) {
      return res.json({ logs: [] });
    }
    const logs = await sql`SELECT * FROM request_logs ORDER BY id DESC LIMIT 200`;
    res.json({ logs });
  });

  app.get("/api/settings", dashboardAuth, requireOperator, (_req: Request, res: Response) => {
    res.json({
      groups: SETTINGS_GROUPS,
      values: getMaskedSettings(),
      status: getConfigStatus(),
    });
  });

  app.get("/api/agent/identity", dashboardAuth, requireOperator, (_req: Request, res: Response) => {
    const raw: Record<string, string> = {};
    for (const k of IDENTITY_KEYS) {
      raw[k] = process.env[k] || "";
    }
    res.json(raw);
  });

  app.post("/api/agent/identity", dashboardAuth, requireOperator, (req: Request, res: Response) => {
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

  app.post("/api/settings", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
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
      for (const [key, value] of Object.entries(updates)) {
        if (value === "" || value === null || value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = String(value);
        }
      }
      await reloadOpenClawConfig();
      log("info", "Settings updated via dashboard", { keys: Object.keys(updates) });
      res.json({ ok: true, status: getConfigStatus() });
    } catch (e: any) {
      log("error", "Failed to write settings", { error: e.message });
      res.status(500).json({ error: `Failed to save settings: ${e.message}` });
    }
  });

  app.post("/api/settings/test/:service", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const { service } = req.params;
    const body = (req.body || {}) as Record<string, string>;

    try {
      if (service === "twilio") {
        const sid = body.TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID;
        const token = body.TWILIO_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN;
        if (!sid || !token) return res.json({ ok: false, error: "Account SID and Auth Token are required." });
        const client = twilio(sid, token);
        const account = await (client.api.accounts(sid) as any).fetch();
        res.json({ ok: true, message: `Connected - Account: ${account.friendlyName} (${account.status})` });
      } else if (service === "gemini") {
        const key = body.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
        if (!key) return res.json({ ok: false, error: "Gemini API Key is required." });
        const testAi = new GoogleGenAI({ apiKey: key });
        const model = body.GEMINI_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";
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
          enabled: true,
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
          let credsText = saJson.trim();
          if (!credsText.startsWith("{")) {
            credsText = Buffer.from(credsText, "base64").toString("utf8");
          }
          const credentials = JSON.parse(credsText);
          const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
          });
          const calendar = google.calendar({ version: "v3", auth });
          const start = new Date();
          const end = new Date(start.getTime() + 60 * 60 * 1000);
          await calendar.events.list({
            calendarId: calId,
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            maxResults: 1,
            singleEvents: true,
          });
          res.json({ ok: true, message: `Google Calendar connected for ${calId}.` });
        } catch (calendarErr: any) {
          res.json({ ok: false, error: `Google Calendar test failed: ${calendarErr.message}` });
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
        res.json({ ok: true, message: `ElevenLabs connected - voice ${voiceId}, model ${modelId}, ${bytes} bytes returned.` });
      } else if (service === "openai_tts") {
        const key = body.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
        if (!key) return res.json({ ok: false, error: "OPENAI_API_KEY is required." });
        const buffer = await generateOpenAISpeech("SMIRK voice test.", {
          apiKey: key,
          voice: (body.OPENAI_TTS_VOICE || process.env.OPENAI_TTS_VOICE || "nova") as OpenAITTSConfig["voice"],
          model: (body.OPENAI_TTS_MODEL || process.env.OPENAI_TTS_MODEL || "tts-1") as OpenAITTSConfig["model"],
          speed: Number(body.OPENAI_TTS_SPEED || process.env.OPENAI_TTS_SPEED || 1),
        });
        if (!buffer) return res.json({ ok: false, error: "OpenAI TTS did not return audio." });
        res.json({ ok: true, message: `OpenAI TTS connected - ${buffer.length} bytes returned.` });
      } else if (service === "google_tts") {
        const apiKey = body.GOOGLE_TTS_API_KEY || process.env.GOOGLE_TTS_API_KEY;
        const serviceAccountJson = body.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
        if (!apiKey && !serviceAccountJson) return res.json({ ok: false, error: "GOOGLE_TTS_API_KEY or Service Account JSON is required." });
        const buffer = await generateGoogleSpeech("SMIRK voice test.", {
          apiKey,
          serviceAccountJson,
          voice: body.GOOGLE_TTS_VOICE || process.env.GOOGLE_TTS_VOICE || "en-US-Neural2-C",
          languageCode: body.GOOGLE_TTS_LANGUAGE || process.env.GOOGLE_TTS_LANGUAGE || "en-US",
          speakingRate: Number(body.GOOGLE_TTS_SPEED || process.env.GOOGLE_TTS_SPEED || 1),
          pitch: Number(body.GOOGLE_TTS_PITCH || process.env.GOOGLE_TTS_PITCH || 0),
        });
        if (!buffer) return res.json({ ok: false, error: "Google TTS did not return audio." });
        res.json({ ok: true, message: `Google TTS connected - ${buffer.length} bytes returned.` });
      } else if (service === "email") {
        const resendKey = body.RESEND_API_KEY || env.RESEND_API_KEY;
        const toEmail = body.email || body.to || body.NOTIFICATION_EMAIL || process.env.NOTIFICATION_EMAIL;
        const fromEmail = env.FROM_EMAIL || "SMIRK <alerts@smirkcalls.com>";
        if (!resendKey) return res.json({ ok: false, error: "RESEND_API_KEY is not configured." });
        if (!toEmail) return res.json({ ok: false, error: "No notification email address provided." });
        const resp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: fromEmail,
            to: [toEmail],
            subject: "SMIRK - Test Notification Email",
            html: `<p>This is a test notification from your SMIRK workspace. Email delivery is working correctly.</p><p style="color:#888;font-size:12px">Sent at ${new Date().toISOString()}</p>`,
          }),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          return res.json({ ok: false, error: `Resend returned ${resp.status}: ${errText}` });
        }
        res.json({ ok: true, message: `Test email sent to ${toEmail} via Resend.` });
      } else if (service === "deployment") {
        const rawUrl = body.APP_URL || process.env.APP_URL || getAppUrl();
        if (!rawUrl) return res.json({ ok: false, error: "APP_URL is required." });
        const baseUrl = rawUrl.replace(/\/$/, "");
        const healthUrl = `${baseUrl}/health`;
        const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(6_000) });
        if (!resp.ok) return res.json({ ok: false, error: `${healthUrl} returned HTTP ${resp.status}.` });
        const contentType = resp.headers.get("content-type") || "";
        const bodyText = await resp.text();
        const parsed = contentType.includes("json") ? JSON.parse(bodyText) : {};
        res.json({ ok: true, message: `Deployment health reachable at ${healthUrl}${parsed.status ? ` (${parsed.status})` : ""}.` });
      } else {
        res.status(400).json({ error: `Unknown service: ${service}. Valid: twilio, gemini, openclaw, openrouter, google_calendar, elevenlabs, openai_tts, google_tts, email, deployment` });
      }
    } catch (e: any) {
      res.json({ ok: false, error: e.message });
    }
  });

  app.get("/api/config-status", dashboardAuth, requireOperator, (_req: Request, res: Response) => {
    res.json(getConfigStatus());
  });
}
