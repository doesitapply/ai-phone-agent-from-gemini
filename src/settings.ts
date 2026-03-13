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
    label: "Core AI & Phone",
    description: "Required to answer and make calls",
    required: true,
    fields: [
      { key: "GEMINI_API_KEY", label: "Gemini API Key", type: "password", placeholder: "AIza...", help: "Get from console.cloud.google.com → APIs → Gemini API", required: true },
      { key: "TWILIO_ACCOUNT_SID", label: "Twilio Account SID", type: "password", placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", help: "Found on twilio.com/console", required: true },
      { key: "TWILIO_AUTH_TOKEN", label: "Twilio Auth Token", type: "password", placeholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", help: "Found on twilio.com/console", required: true },
      { key: "TWILIO_PHONE_NUMBER", label: "Twilio Phone Number", type: "text", placeholder: "+15551234567", help: "Your Twilio number in E.164 format", required: true },
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
    label: "OpenClaw Gateway",
    description: "Connect your local OpenClaw instance as the AI brain",
    required: false,
    fields: [
      { key: "OPENCLAW_ENABLED", label: "Enable OpenClaw", type: "toggle", help: "Route calls through OpenClaw instead of Gemini directly" },
      { key: "OPENCLAW_GATEWAY_URL", label: "Gateway URL", type: "text", placeholder: "http://127.0.0.1:18789", help: "URL of your running OpenClaw Gateway" },
      { key: "OPENCLAW_GATEWAY_TOKEN", label: "Gateway Token", type: "password", placeholder: "oc_...", help: "From ~/.openclaw/openclaw.json → gateway.auth.token" },
      { key: "OPENCLAW_AGENT_ID", label: "Agent ID", type: "text", placeholder: "main", help: "The OpenClaw agent to use for phone calls" },
      { key: "OPENCLAW_MODEL", label: "Model", type: "text", placeholder: "openclaw:main", help: "Model identifier passed to the Gateway" },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter Failover",
    description: "Backup AI brain if OpenClaw and Gemini are unavailable",
    required: false,
    fields: [
      { key: "OPENROUTER_ENABLED", label: "Enable OpenRouter", type: "toggle", help: "Use OpenRouter as a second fallback after Gemini" },
      { key: "OPENROUTER_API_KEY", label: "OpenRouter API Key", type: "password", placeholder: "sk-or-...", help: "Get from openrouter.ai/keys" },
      { key: "OPENROUTER_MODEL", label: "Model", type: "text", placeholder: "openai/gpt-4o", help: "Any model available on OpenRouter" },
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
  if (raw.GOOGLE_CALENDAR_ID && !raw.GOOGLE_SERVICE_ACCOUNT_JSON) {
    warnings.push("Google Calendar ID is set but Service Account JSON is missing");
  }

  return {
    isConfigured: missingRequired.length === 0,
    missingRequired,
    warnings,
  };
}
