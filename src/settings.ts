/**
 * Settings Manager
 * Reads and writes .env.local at runtime so non-technical users can
 * configure everything from the browser without touching Railway.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In production on Railway, /app is read-only. Use a writable path.
// SETTINGS_PATH env var can override (e.g. a mounted volume).
const WRITABLE_DIR = process.env.SETTINGS_PATH ||
  (process.env.NODE_ENV === "production" ? "/tmp" : path.resolve(__dirname, ".."));

const ENV_FILE = path.join(WRITABLE_DIR, ".env.local");

// ── Sensitive key groups for the UI ──────────────────────────────────────────
export const SETTINGS_GROUPS = [
  {
    id: "core",
    label: "Core Phone",
    description: "Required to answer and make calls",
    required: true,
    fields: [
      { key: "TWILIO_ACCOUNT_SID", label: "Twilio Account SID", type: "password", placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", help: "Found on twilio.com/console", required: true },
      { key: "TWILIO_AUTH_TOKEN", label: "Twilio Auth Token", type: "password", placeholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", help: "Found on twilio.com/console", required: true },
      { key: "TWILIO_PHONE_NUMBER", label: "Twilio Phone Number", type: "text", placeholder: "+15551234567", help: "Your Twilio number in E.164 format", required: true },
    ],
  },
  {
    id: "openrouter",
    label: "AI Brain (OpenRouter)",
    description: "Primary AI engine — routes calls through GPT-4o, Claude, Gemini, and 100+ models via a single key",
    required: true,
    fields: [
      { key: "OPENROUTER_ENABLED", label: "Enable OpenRouter", type: "toggle", help: "Turn on to use OpenRouter as the AI brain. Recommended.", required: false },
      { key: "OPENROUTER_API_KEY", label: "OpenRouter API Key", type: "password", placeholder: "sk-or-...", help: "Get a free key at openrouter.ai/keys", required: true },
      { key: "OPENROUTER_MODEL", label: "Model", type: "text", placeholder: "google/gemini-2.0-flash-001", help: "Any model on OpenRouter. Recommended: google/gemini-2.0-flash-001 (fast + cheap) or openai/gpt-4o (highest quality)" },
    ],
  },
  {
    id: "google_tts",
    label: "Voice Engine (Google TTS)",
    description: "Primary voice — Google Neural2 voices sound nearly human on phone calls",
    required: false,
    fields: [
      { key: "GOOGLE_TTS_API_KEY", label: "Google Cloud API Key", type: "password", placeholder: "AIza...", help: "Create at console.cloud.google.com → APIs & Services → Credentials. Enable the Cloud Text-to-Speech API first." },
      { key: "GOOGLE_TTS_VOICE", label: "Default Voice", type: "text", placeholder: "en-US-Neural2-C", help: "Neural2 voices are highest quality. Options: en-US-Neural2-C (female), en-US-Neural2-D (male), en-US-Neural2-F (bright female), en-US-Neural2-J (professional male)" },
      { key: "GOOGLE_TTS_LANGUAGE", label: "Language Code", type: "text", placeholder: "en-US", help: "BCP-47 language code. Default: en-US" },
      { key: "GOOGLE_TTS_SPEED", label: "Speaking Rate", type: "text", placeholder: "1.0", help: "0.25–4.0. Default 1.0. Try 1.05–1.1 for a slightly more energetic feel." },
    ],
  },
  {
    id: "deployment",
    label: "Deployment",
    description: "Your public URL and security settings",
    required: false,
    fields: [
      { key: "APP_URL", label: "Public App URL", type: "text", placeholder: "https://your-app.railway.app", help: "Your Railway or custom domain URL — used to generate webhook URLs" },
      { key: "DASHBOARD_USER", label: "Dashboard Username", type: "text", placeholder: "admin", help: "Set to password-protect the dashboard (browser login popup)" },
      { key: "DASHBOARD_PASS", label: "Dashboard Password", type: "password", placeholder: "••••••••", help: "Required if Dashboard Username is set" },
      { key: "DASHBOARD_API_KEY", label: "API Key", type: "password", placeholder: "sk-...", help: "Optional: require X-Api-Key header on all API requests" },
    ],
  },
  {
    id: "openclaw",
    label: "OpenClaw Gateway (Advanced)",
    description: "Connect a local OpenClaw instance as an alternative AI brain",
    required: false,
    fields: [
      { key: "OPENCLAW_ENABLED", label: "Enable OpenClaw", type: "toggle", help: "Route calls through OpenClaw. Overrides OpenRouter when enabled." },
      { key: "OPENCLAW_GATEWAY_URL", label: "Gateway URL", type: "text", placeholder: "http://127.0.0.1:18789", help: "URL of your running OpenClaw Gateway" },
      { key: "OPENCLAW_GATEWAY_TOKEN", label: "Gateway Token", type: "password", placeholder: "oc_...", help: "From ~/.openclaw/openclaw.json → gateway.auth.token" },
      { key: "OPENCLAW_AGENT_ID", label: "Agent ID", type: "text", placeholder: "main", help: "The OpenClaw agent to use for phone calls" },
      { key: "OPENCLAW_MODEL", label: "Model", type: "text", placeholder: "openclaw:main", help: "Model identifier passed to the Gateway" },
    ],
  },
  {
    id: "openai_tts",
    label: "Voice Fallback (OpenAI TTS)",
    description: "Secondary voice engine if Google TTS is not configured",
    required: false,
    fields: [
      { key: "OPENAI_API_KEY", label: "OpenAI API Key", type: "password", placeholder: "sk-...", help: "Get from platform.openai.com/api-keys. Used for TTS fallback (nova voice)." },
      { key: "OPENAI_TTS_VOICE", label: "Voice", type: "text", placeholder: "nova", help: "Options: alloy, echo, fable, onyx, nova, shimmer. nova = warm female (recommended)." },
      { key: "OPENAI_TTS_MODEL", label: "Model", type: "text", placeholder: "tts-1", help: "tts-1 = faster, tts-1-hd = higher quality" },
    ],
  },
  {
    id: "elevenlabs",
    label: "Voice Fallback (ElevenLabs)",
    description: "Tertiary voice engine fallback",
    required: false,
    fields: [
      { key: "ELEVENLABS_API_KEY", label: "ElevenLabs API Key", type: "password", placeholder: "sk_...", help: "Get from elevenlabs.io/app/settings/api-keys" },
      { key: "ELEVENLABS_VOICE_ID", label: "Voice ID", type: "text", placeholder: "IKne3meq5aSn9XLyUdCD", help: "ElevenLabs voice ID. Find IDs at elevenlabs.io/app/voice-lab" },
      { key: "ELEVENLABS_MODEL_ID", label: "Model", type: "text", placeholder: "eleven_turbo_v2_5", help: "eleven_turbo_v2_5 = fastest. eleven_multilingual_v2 = highest quality." },
    ],
  },
  {
    id: "google_calendar",
    label: "Google Calendar",
    description: "Sync booked appointments to your calendar automatically",
    required: false,
    fields: [
      { key: "GOOGLE_CALENDAR_ID", label: "Calendar ID", type: "text", placeholder: "primary or your-calendar@group.calendar.google.com", help: "Found in Google Calendar settings → Integrate calendar" },
      { key: "GOOGLE_CALENDAR_TZ", label: "Calendar Timezone", type: "text", placeholder: "America/Los_Angeles", help: "IANA timezone name for appointment times" },
      { key: "GOOGLE_SERVICE_ACCOUNT_JSON", label: "Service Account JSON", type: "textarea", placeholder: '{"type":"service_account",...}', help: "Paste the full JSON from your Google Cloud service account key file" },
    ],
  },
  {
    id: "business",
    label: "Business Settings",
    description: "Timezone and behavior configuration",
    required: false,
    fields: [
      { key: "BUSINESS_TIMEZONE", label: "Business Timezone", type: "text", placeholder: "America/Los_Angeles", help: "Used to inject the correct local time into every AI prompt" },
    ],
  },
];

// ── Read current .env.local ───────────────────────────────────────────────────
export function readEnvFile(): Record<string, string> {
  try {
    if (!fs.existsSync(ENV_FILE)) return {};
    const content = fs.readFileSync(ENV_FILE, "utf-8");
    const result: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

// ── Write/update .env.local ───────────────────────────────────────────────────
export function writeEnvFile(updates: Record<string, string>): void {
  const existing = readEnvFile();
  const merged = { ...existing, ...updates };

  // Remove empty values
  for (const [k, v] of Object.entries(merged)) {
    if (v === "" || v === null || v === undefined) delete merged[k];
  }

  const lines = [
    "# AI Phone Agent — Environment Configuration",
    "# Managed by the in-app Settings page. Do not edit manually while the server is running.",
    "",
  ];

  for (const [key, value] of Object.entries(merged)) {
    // Quote values that contain spaces or special chars
    const needsQuote = /[\s#"'\\]/.test(value) || value.includes("\n");
    const serialized = needsQuote ? `"${value.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"` : value;
    lines.push(`${key}=${serialized}`);
  }

  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n", "utf-8");

  // Hot-reload: update process.env so changes take effect without restart
  for (const [key, value] of Object.entries(updates)) {
    if (value === "" || value === null || value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

// ── Get masked settings for the UI ───────────────────────────────────────────
export function getMaskedSettings(): Record<string, string> {
  const raw = readEnvFile();
  const masked: Record<string, string> = {};

  for (const group of SETTINGS_GROUPS) {
    for (const field of group.fields) {
      const value = raw[field.key] || process.env[field.key] || "";
      if (field.type === "password" && value) {
        // Show first 4 chars + mask the rest
        masked[field.key] = value.length > 8
          ? value.slice(0, 4) + "•".repeat(Math.min(value.length - 4, 20))
          : "•".repeat(value.length);
      } else {
        masked[field.key] = value;
      }
    }
  }

  return masked;
}

// ── Get raw settings (for server-side use only) ───────────────────────────────
export function getRawSettings(): Record<string, string> {
  const fileVars = readEnvFile();
  const result: Record<string, string> = {};
  for (const group of SETTINGS_GROUPS) {
    for (const field of group.fields) {
      result[field.key] = fileVars[field.key] || process.env[field.key] || "";
    }
  }
  return result;
}

// ── Configuration status check ────────────────────────────────────────────────
export function getConfigStatus(): {
  isConfigured: boolean;
  missingRequired: string[];
  warnings: string[];
} {
  const raw = getRawSettings();
  const missingRequired: string[] = [];
  const warnings: string[] = [];

  for (const group of SETTINGS_GROUPS) {
    if (!group.required) continue;
    for (const field of group.fields) {
      if ((field as any).required && !raw[field.key]) {
        missingRequired.push(field.label);
      }
    }
  }

  if (raw.OPENCLAW_ENABLED === "true" && !raw.OPENCLAW_GATEWAY_URL) {
    warnings.push("OpenClaw is enabled but Gateway URL is not set");
  }
  if (raw.OPENROUTER_ENABLED === "true" && !raw.OPENROUTER_API_KEY) {
    warnings.push("OpenRouter is enabled but API key is not set");
  }
  // Warn if no AI brain is configured at all
  const hasAI = raw.OPENROUTER_API_KEY || raw.GEMINI_API_KEY || raw.OPENCLAW_ENABLED === "true";
  if (!hasAI) {
    warnings.push("No AI configured: add an OpenRouter API key (recommended) or Gemini API key");
  }
  // Warn if no voice engine is configured
  const hasVoice = raw.GOOGLE_TTS_API_KEY || raw.OPENAI_API_KEY || raw.ELEVENLABS_API_KEY;
  if (!hasVoice) {
    warnings.push("No voice engine configured: add a Google TTS API key for best quality, or OpenAI API key as fallback");
  }
  if (raw.GOOGLE_CALENDAR_ID && !raw.GOOGLE_SERVICE_ACCOUNT_JSON) {
    warnings.push("Google Calendar ID is set but Service Account JSON is missing");
  }

  return {
    isConfigured: missingRequired.length === 0,
    missingRequired,
    warnings,
  };
}
