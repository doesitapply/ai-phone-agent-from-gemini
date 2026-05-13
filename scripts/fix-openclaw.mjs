#!/usr/bin/env node
/**
 * fix-openclaw.mjs
 *
 * Fully wires SMIRK to local OpenClaw automation by:
 *   1. Enabling OpenResponses + voice-call config in ~/.openclaw/openclaw.json
 *   2. Syncing .env.local to the live OpenClaw Gateway token/url
 *   3. Clearing stale sessions via the Gateway RPC API
 *   4. Reloading the Gateway safely
 *   5. Verifying POST /v1/responses works with the synced config
 *
 * Usage:
 *   node scripts/fix-openclaw.mjs
 *   node scripts/fix-openclaw.mjs --gateway-url http://127.0.0.1:18789 --token YOUR_TOKEN
 *   node scripts/fix-openclaw.mjs --agent knot --model openclaw/knot
 *   node scripts/fix-openclaw.mjs --dry-run
 */

import fs from "fs";
import os from "os";
import path from "path";
import { execSync, spawnSync } from "child_process";

// ── Parse CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
};
const DRY_RUN = args.includes("--dry-run");
const GATEWAY_URL = getArg("--gateway-url") || process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
const REQUESTED_AGENT_ID = getArg("--agent") || process.env.OPENCLAW_AGENT_ID || "";
const REQUESTED_MODEL = getArg("--model") || process.env.OPENCLAW_MODEL || "";

const CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");
const ENV_PATH = path.resolve(process.cwd(), ".env.local");

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg) { console.log(`\x1b[36m[fix-openclaw]\x1b[0m ${msg}`); }
function ok(msg)  { console.log(`\x1b[32m[✓]\x1b[0m ${msg}`); }
function warn(msg){ console.log(`\x1b[33m[!]\x1b[0m ${msg}`); }
function err(msg) { console.log(`\x1b[31m[✗]\x1b[0m ${msg}`); }

function deepSet(obj, keyPath, value) {
  const keys = keyPath.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] === undefined || typeof cur[keys[i]] !== "object") {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function deepGet(obj, keyPath) {
  return keyPath.split(".").reduce((cur, k) => cur?.[k], obj);
}

function quoteEnv(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function syncEnvFile(filePath, updates) {
  const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const lines = original ? original.split(/\r?\n/) : [];
  const seen = new Set();
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match || !(match[1] in updates)) return line;
    seen.add(match[1]);
    return `${match[1]}=${quoteEnv(updates[match[1]])}`;
  });

  const missing = Object.entries(updates).filter(([key]) => !seen.has(key));
  if (missing.length > 0 && nextLines[nextLines.length - 1] !== "") {
    nextLines.push("");
  }
  for (const [key, value] of missing) {
    nextLines.push(`${key}=${quoteEnv(value)}`);
  }

  const next = `${nextLines.join("\n").replace(/\n+$/, "")}\n`;
  if (next === original) return false;
  if (!DRY_RUN) fs.writeFileSync(filePath, next, "utf8");
  return true;
}

function findGatewayPid() {
  const statusResult = spawnSync("openclaw", ["gateway", "status", "--json"], {
    encoding: "utf8",
    timeout: 8000,
  });
  if (statusResult.status === 0) {
    try {
      const statusJson = JSON.parse(statusResult.stdout);
      const pid = statusJson?.service?.runtime?.pid || statusJson?.pid || statusJson?.service?.pid;
      if (pid) return Number(pid);
    } catch {
      // Fall through to lsof.
    }
  }

  const lsofResult = spawnSync("lsof", ["-nP", "-iTCP:18789", "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const pid = lsofResult.stdout.trim().split(/\s+/)[0];
  return pid ? Number(pid) : null;
}

async function waitForGatewayListening(timeoutMs = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const pid = findGatewayPid();
    if (pid) return pid;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

// ── Step 1: Read openclaw.json ────────────────────────────────────────────────
log("Reading openclaw.json...");
if (!fs.existsSync(CONFIG_PATH)) {
  err(`Config not found at ${CONFIG_PATH}`);
  err("Is OpenClaw installed? Run: openclaw doctor");
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  ok(`Loaded config from ${CONFIG_PATH}`);
} catch (e) {
  err(`Failed to parse openclaw.json: ${e.message}`);
  process.exit(1);
}

const TOKEN =
  getArg("--token") ||
  process.env.OPENCLAW_GATEWAY_TOKEN ||
  deepGet(config, "gateway.auth.token") ||
  "";
const configDefaultAgent = Array.isArray(config.agents?.list)
  ? config.agents.list.find((agent) => agent?.default)?.id || config.agents.list[0]?.id
  : "";
const AGENT_ID = REQUESTED_AGENT_ID || configDefaultAgent || "knot";
const MODEL = REQUESTED_MODEL || `openclaw/${AGENT_ID}`;

// ── Step 2: Apply the voice-call config patches ───────────────────────────────
log("Applying Gateway/OpenResponses/voice-call config patches...");

const BASE = "plugins.entries.voice-call.config";

const patches = {
  // Required for SMIRK's HTTP adapter: src/openclaw.ts -> POST /v1/responses
  "gateway.http.endpoints.responses.enabled": true,

  // Required for OpenClaw's call-side automation path.
  "plugins.entries.voice-call.enabled": true,

  // Tell the plugin to use Codex 5.3 for AI responses instead of the general agent queue
  [`${BASE}.responseModel`]: "openai-codex/gpt-5.3-codex",

  // System prompt for the AI during calls — concise, phone-optimized
  [`${BASE}.responseSystemPrompt`]:
    "You are a professional AI phone assistant. Keep every response under 2 sentences. " +
    "You are speaking on a live phone call — be direct, warm, and helpful. " +
    "Never mention that you are an AI unless directly asked.",

  // Greeting spoken immediately when the call is answered
  [`${BASE}.inboundGreeting`]:
    "Hello! Thanks for calling. How can I help you today?",

  // Timeout for AI response generation (ms)
  [`${BASE}.responseTimeoutMs`]: 8000,

  // Max call duration: 10 minutes
  [`${BASE}.maxDurationSeconds`]: 600,

  // Stale call reaper: kill calls that never get a terminal webhook (prevents queue buildup)
  [`${BASE}.staleCallReaperSeconds`]: 660,

  // Streaming must be enabled for real-time transcription
  [`${BASE}.streaming.enabled`]: true,
  [`${BASE}.streaming.streamPath`]: "/voice/stream",
  [`${BASE}.streaming.preStartTimeoutMs`]: 5000,
  [`${BASE}.streaming.maxPendingConnections`]: 32,
  [`${BASE}.streaming.maxPendingConnectionsPerIp`]: 4,
  [`${BASE}.streaming.maxConnections`]: 128,
};

let changed = false;
for (const [keyPath, value] of Object.entries(patches)) {
  const configKey = keyPath.replace(/^plugins\.entries\.voice-call\.config\./, "");
  const current = deepGet(config, keyPath);
  if (JSON.stringify(current) !== JSON.stringify(value)) {
    log(`  Setting ${keyPath} = ${JSON.stringify(value)}`);
    deepSet(config, keyPath, value);
    changed = true;
  } else {
    log(`  Already set: ${keyPath}`);
  }
}

// ── Step 3: Write the patched config ─────────────────────────────────────────
if (changed) {
  if (DRY_RUN) {
    warn("DRY RUN — would write the following config:");
    console.log(JSON.stringify(config.plugins?.entries?.["voice-call"]?.config, null, 2));
  } else {
    // Backup first
    const backupPath = `${CONFIG_PATH}.bak.${Date.now()}`;
    fs.copyFileSync(CONFIG_PATH, backupPath);
    log(`Backup saved to ${backupPath}`);

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
    ok("Config patched and saved.");
  }
} else {
  ok("Config already up to date — no changes needed.");
}

// ── Step 4: Sync SMIRK local env to the live OpenClaw config ──────────────────
log("Syncing .env.local OpenClaw settings...");
if (!TOKEN) {
  warn("No Gateway token found in CLI args, env, or openclaw.json.");
} else {
  const envChanged = syncEnvFile(ENV_PATH, {
    OPENCLAW_ENABLED: "true",
    OPENCLAW_BRIDGE_ENABLED: "true",
    OPENCLAW_GATEWAY_URL: GATEWAY_URL.replace(/\/$/, ""),
    OPENCLAW_GATEWAY_TOKEN: TOKEN,
    OPENCLAW_AGENT_ID: AGENT_ID,
    OPENCLAW_MODEL: MODEL,
    OPENCLAW_TIMEOUT_MS: "10000",
  });
  if (DRY_RUN && envChanged) {
    warn(`DRY RUN — would update ${ENV_PATH}`);
  } else if (envChanged) {
    ok(`Synced OpenClaw settings into ${ENV_PATH}`);
  } else {
    ok(".env.local OpenClaw settings already synced.");
  }
}

// ── Step 5: Clear stale sessions via Gateway RPC ──────────────────────────────
log("Clearing stale sessions via Gateway RPC...");

if (!TOKEN) {
  warn("No OPENCLAW_GATEWAY_TOKEN set — skipping session clear.");
  warn("Set it via: export OPENCLAW_GATEWAY_TOKEN=your_token");
  warn("Or pass it via: node scripts/fix-openclaw.mjs --token YOUR_TOKEN");
} else if (!DRY_RUN) {
  try {
    const clearRes = await fetch(`${GATEWAY_URL}/rpc/sessions.clear`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ agentId: "main", confirm: true }),
    });

    if (clearRes.ok) {
      const body = await clearRes.json().catch(() => ({}));
      ok(`Cleared sessions: ${JSON.stringify(body)}`);
    } else {
      const body = await clearRes.text().catch(() => "");
      // 404 means the endpoint doesn't exist in this version — that's fine, use CLI fallback
      if (clearRes.status === 404) {
        warn("sessions.clear RPC not available in this version — running session cleanup instead...");
        const result = spawnSync("openclaw", ["sessions", "cleanup", "--agent", AGENT_ID], {
          encoding: "utf8",
          timeout: 10000,
        });
        if (result.status === 0) {
          ok("Session cleanup completed via CLI.");
        } else {
          warn(`CLI session cleanup failed: ${result.stderr || result.stdout}`);
          warn(`You can inspect sessions manually: openclaw sessions --agent ${AGENT_ID}`);
        }
      } else {
        warn(`Session clear returned ${clearRes.status}: ${body.slice(0, 200)}`);
      }
    }
  } catch (e) {
    warn(`Session clear failed: ${e.message}`);
    warn("Trying CLI cleanup fallback...");
    const result = spawnSync("openclaw", ["sessions", "cleanup", "--agent", AGENT_ID], {
      encoding: "utf8",
      timeout: 10000,
    });
    if (result.status === 0) {
      ok("Session cleanup completed via CLI.");
    } else {
      warn("Could not clean sessions automatically. Inspect manually:");
      warn(`  openclaw sessions --agent ${AGENT_ID}`);
    }
  }
} else {
  warn("DRY RUN — skipping session clear.");
}

// ── Step 6: Reload the Gateway (SIGUSR1 — safe, no bootout) ──────────────────
log("Reloading OpenClaw Gateway (SIGUSR1 — no daemon deletion)...");

if (DRY_RUN) {
  warn("DRY RUN — would send SIGUSR1 to Gateway process.");
} else {
  // Try SIGUSR1 first (safe reload, no LaunchAgent deletion)
  let reloaded = false;

  // Method 1: openclaw gateway reload (if available)
  const reloadResult = spawnSync("openclaw", ["gateway", "reload"], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (reloadResult.status === 0) {
    ok("Gateway reloaded via 'openclaw gateway reload'.");
    reloaded = true;
  }

  // Method 2: SIGUSR1 to the Gateway PID
  if (!reloaded) {
    try {
      const pid = findGatewayPid();
      if (pid) {
        process.kill(pid, "SIGUSR1");
        ok(`Sent SIGUSR1 to Gateway PID ${pid}.`);
        const readyPid = await waitForGatewayListening();
        if (readyPid) {
          ok(`Gateway is listening after reload on PID ${readyPid}.`);
          reloaded = true;
        }
      }
    } catch (e) {
      warn(`SIGUSR1 method failed: ${e.message}`);
    }
  }

  // Method 3: Last resort — restart (but warn about the LaunchAgent bug)
  if (!reloaded) {
    warn("Could not confirm SIGUSR1 reload. Trying 'openclaw gateway start' to ensure service is up...");
    const startResult = spawnSync("openclaw", ["gateway", "start"], {
      encoding: "utf8",
      timeout: 15000,
    });
    if (startResult.status === 0) {
      ok("Gateway service is started.");
    } else {
      warn(`Gateway start returned non-zero: ${startResult.stderr || startResult.stdout}`);
    }
  }
}

// ── Step 7: Verify OpenResponses ─────────────────────────────────────────────
log("Verifying OpenClaw OpenResponses endpoint...");
if (!TOKEN) {
  warn("No token available — skipping /v1/responses verification.");
} else if (DRY_RUN) {
  warn("DRY RUN — skipping /v1/responses verification.");
} else {
  try {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    const verifyRes = await fetch(`${GATEWAY_URL.replace(/\/$/, "")}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
        "x-openclaw-agent-id": AGENT_ID,
      },
      body: JSON.stringify({
        model: MODEL,
        input: "Reply with only: SMIRK_OPENCLAW_READY",
        max_output_tokens: 20,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const body = await verifyRes.text().catch(() => "");
    if (verifyRes.ok) {
      ok("OpenResponses endpoint accepted a test request.");
    } else {
      warn(`/v1/responses model verification returned HTTP ${verifyRes.status}: ${body.slice(0, 300)}`);
    }
  } catch (e) {
    warn(`/v1/responses model verification did not complete: ${e.message}`);
    warn("Gateway config is still applied; this usually means the selected model backend timed out.");
  }
}

// ── Done ──────────────────────────────────────────────────────────────────────
console.log("");
ok("OpenClaw automation complete. Restart SMIRK if it is already running so it reloads .env.local.");
console.log("");
console.log("  \x1b[36mExpected behavior:\x1b[0m");
console.log("  1. Call your Twilio number");
console.log("  2. Hear: \"Hello! Thanks for calling. How can I help you today?\"");
console.log("  3. Say something — get a real AI response from Codex 5.3");
console.log("");
console.log("  \x1b[36mIf it still plays hold music:\x1b[0m");
console.log("  - Check Gateway logs: tail -f ~/.openclaw/logs/gateway.log | grep voice-call");
console.log("  - Verify Twilio webhook: curl https://your-ngrok-url/health");
console.log("  - Run the smoke test: curl -X POST http://localhost:3000/api/twilio/test-webhook");
