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
    id: "identity",
    label: "Business Identity",
    description: "Who your AI agent is and who it works for — injected into every call automatically",
    required: false,
    fields: [
      { key: "BUSINESS_NAME", label: "Business Name", type: "text", placeholder: "Smith HVAC", help: "Your company name. The agent will say this when answering calls." },
      { key: "BUSINESS_TAGLINE", label: "Tagline / Specialty", type: "text", placeholder: "Fast, honest HVAC service since 2008", help: "One-line description of what you do. Used in the agent's intro and pitch." },
      { key: "BUSINESS_PHONE", label: "Business Phone", type: "text", placeholder: "+15551234567", help: "Your main business number (may differ from your Twilio number)." },
      { key: "BUSINESS_WEBSITE", label: "Website", type: "text", placeholder: "https://smithhvac.com", help: "Your website URL — the agent can share this when asked." },
      { key: "BUSINESS_ADDRESS", label: "Address", type: "text", placeholder: "123 Main St, Austin TX 78701", help: "Your physical address or service area." },
      { key: "BUSINESS_HOURS", label: "Business Hours", type: "text", placeholder: "Mon–Fri 8am–6pm, Sat 9am–2pm", help: "Your operating hours. The agent will quote these when asked." },
      { key: "AGENT_NAME", label: "Agent Name", type: "text", placeholder: "Aria", help: "The name your AI agent uses on calls. Default: SMIRK." },
      { key: "AGENT_PERSONA", label: "Agent Persona", type: "textarea", placeholder: "Friendly, professional, and concise. Always empathetic with frustrated callers. Never pushy.", help: "Describe the agent's personality and communication style. This shapes every response." },
      { key: "INBOUND_GREETING", label: "Inbound greeting", type: "textarea", placeholder: "Thanks for calling {business_name}! This is {agent_name}. How can I help you today?", help: "What the caller hears when they call you. Placeholders: {business_name}, {agent_name}." },
      { key: "OUTBOUND_GREETING", label: "Outbound opening", type: "textarea", placeholder: "Hi, this is {business_name}. I’m following up on your request. Is now a good time?", help: "What the callee hears on outbound calls. Placeholders: {business_name}, {agent_name}." },
      { key: "VOICEMAIL_MESSAGE", label: "Voicemail message", type: "textarea", placeholder: "Please leave your service address and what’s going on after the beep. We’ll text you right after.", help: "Used when the agent can’t hear the caller and switches to recording." },
      { key: "SMS_FOLLOWUP_TEMPLATE", label: "SMS follow-up", type: "textarea", placeholder: "Got it. What’s the service address, and what’s going on?", help: "Sent after press-1 fallback and voicemail capture." },
      { key: "INTAKE_FIRST_QUESTION", label: "Intake first question", type: "text", placeholder: "What’s the service address?", help: "The first intake question the agent asks after opening." },
      { key: "OBJECTION_STYLE", label: "Objection style", type: "text", placeholder: "Calm, direct, no pressure", help: "Short instruction for handling price-shopping, urgency, and hesitation." },
    ],
  },
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
    required: false,
    fields: [
      { key: "OPENROUTER_ENABLED", label: "Enable OpenRouter", type: "toggle", help: "Turn on to use OpenRouter as the AI brain. Recommended.", required: false },
      { key: "OPENROUTER_API_KEY", label: "OpenRouter API Key", type: "password", placeholder: "sk-or-...", help: "Get a free key at openrouter.ai/keys", required: true },
      { key: "OPENROUTER_MODEL", label: "Model", type: "text", placeholder: "google/gemini-flash-1.5", help: "Any model on OpenRouter. Recommended: google/gemini-flash-1.5 (fast + cheap) or openai/gpt-4o (highest quality)" },
    ],
  },
  {
    id: "gemini",
    label: "AI Brain (Gemini)",
    description: "Use Google Gemini directly as the AI brain (no OpenRouter required)",
    required: true,
    fields: [
      { key: "GEMINI_API_KEY", label: "Gemini API Key", type: "password", placeholder: "AIza...", help: "Create in Google AI Studio. Required if you want Gemini as the AI brain.", required: true },
      { key: "GEMINI_MODEL", label: "Gemini Model", type: "text", placeholder: "gemini-2.5-flash", help: "Recommended: gemini-2.5-flash" },
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
      { key: "COMPLIANCE_ALWAYS_ALLOW_NUMBERS", label: "Test Allowlist Numbers", type: "text", placeholder: "+17754204485,+15551234567", help: "Comma-separated E.164 numbers that bypass outbound compliance checks (quiet hours/DNC). Use only for internal test lines." },
    ],
  },
  {
    id: "missed_call",
    label: "Missed Call Text Back",
    description: "Automatically text callers who you missed — the fastest revenue recovery feature",
    required: false,
    fields: [
      { key: "MISSED_CALL_TEXT_BACK", label: "Enable Missed Call Text Back", type: "toggle", help: "When ON, SMIRK instantly texts any inbound caller you missed. Turn this on." },
      { key: "MISSED_CALL_TEXT_MESSAGE", label: "Text Message", type: "textarea", placeholder: "Hey — sorry we missed your call! What were you looking to book? Reply here or use this link: {booking_link}", help: "Use {booking_link} to insert your booking URL. Use {name} if the caller is a known contact." },
      { key: "BOOKING_LINK", label: "Booking Link", type: "text", placeholder: "https://calendly.com/your-business", help: "Your booking/scheduling link — inserted into missed call texts and review requests" },
    ],
  },
  {
    id: "review_sms",
    label: "Review Request SMS",
    description: "Automatically ask happy customers for a Google review after their appointment",
    required: false,
    fields: [
      { key: "REVIEW_SMS_ENABLED", label: "Enable Review Requests", type: "toggle", help: "When ON, SMIRK texts customers after completed calls asking for a review." },
      { key: "REVIEW_LINK", label: "Google Review Link", type: "text", placeholder: "https://g.page/r/YOUR_PLACE_ID/review", help: "Your Google Business review link. Find it in Google Business Profile → Get more reviews." },
      { key: "REVIEW_SMS_DELAY_MINUTES", label: "Delay (minutes)", type: "text", placeholder: "30", help: "How many minutes after a completed call to send the review request. Default: 30" },
      { key: "REVIEW_SMS_MESSAGE", label: "Review Request Message", type: "textarea", placeholder: "Thanks for calling {business_name}! If you had a great experience, we'd love a quick review: {review_link} — it means the world to us!", help: "Use {review_link} and {business_name} as placeholders." },
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
  if (raw.COMPLIANCE_ALWAYS_ALLOW_NUMBERS) {
    warnings.push("Test Allowlist Numbers bypass compliance checks. Keep this list limited to internal test numbers only.");
  }

  return {
    isConfigured: missingRequired.length === 0,
    missingRequired,
    warnings,
  };
}
