#!/usr/bin/env node
/**
 * fix-openclaw.mjs
 *
 * Fixes the "all agents busy / hold music" problem by:
 *   1. Patching ~/.openclaw/openclaw.json with the correct voice-call plugin config
 *   2. Clearing stale sessions via the Gateway RPC API
 *   3. Triggering a Gateway reload via SIGUSR1 (no bootout/bootload — avoids the LaunchAgent deletion bug)
 *
 * Usage:
 *   node scripts/fix-openclaw.mjs
 *   node scripts/fix-openclaw.mjs --gateway-url http://127.0.0.1:18789 --token YOUR_TOKEN
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
const TOKEN = getArg("--token") || process.env.OPENCLAW_GATEWAY_TOKEN || "";

const CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");

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

// ── Step 2: Apply the voice-call config patches ───────────────────────────────
log("Applying voice-call plugin config patches...");

const BASE = "plugins.entries.voice-call.config";

const patches = {
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

// ── Step 4: Clear stale sessions via Gateway RPC ──────────────────────────────
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
        warn("sessions.clear RPC not available in this version — trying CLI fallback...");
        const result = spawnSync("openclaw", ["sessions", "clear", "--agent", "main", "--confirm"], {
          encoding: "utf8",
          timeout: 10000,
        });
        if (result.status === 0) {
          ok("Sessions cleared via CLI.");
        } else {
          warn(`CLI session clear failed: ${result.stderr || result.stdout}`);
          warn("You can clear sessions manually: openclaw sessions clear --agent main --confirm");
        }
      } else {
        warn(`Session clear returned ${clearRes.status}: ${body.slice(0, 200)}`);
      }
    }
  } catch (e) {
    warn(`Session clear failed: ${e.message}`);
    warn("Trying CLI fallback...");
    const result = spawnSync("openclaw", ["sessions", "clear", "--agent", "main", "--confirm"], {
      encoding: "utf8",
      timeout: 10000,
    });
    if (result.status === 0) {
      ok("Sessions cleared via CLI.");
    } else {
      warn("Could not clear sessions automatically. Run manually:");
      warn("  openclaw sessions clear --agent main --confirm");
    }
  }
} else {
  warn("DRY RUN — skipping session clear.");
}

// ── Step 5: Reload the Gateway (SIGUSR1 — safe, no bootout) ──────────────────
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
      const pidResult = spawnSync("openclaw", ["gateway", "status", "--json"], {
        encoding: "utf8",
        timeout: 5000,
      });
      if (pidResult.status === 0) {
        const statusJson = JSON.parse(pidResult.stdout);
        const pid = statusJson?.pid || statusJson?.service?.pid;
        if (pid) {
          process.kill(pid, "SIGUSR1");
          ok(`Sent SIGUSR1 to Gateway PID ${pid} — config will reload in ~2s.`);
          reloaded = true;
        }
      }
    } catch (e) {
      warn(`SIGUSR1 method failed: ${e.message}`);
    }
  }

  // Method 3: Last resort — restart (but warn about the LaunchAgent bug)
  if (!reloaded) {
    warn("Could not reload via SIGUSR1. Trying 'openclaw gateway restart'...");
    warn("NOTE: If this deletes your LaunchAgent, run: openclaw gateway install && openclaw gateway start");
    const restartResult = spawnSync("openclaw", ["gateway", "restart"], {
      encoding: "utf8",
      timeout: 15000,
    });
    if (restartResult.status === 0) {
      ok("Gateway restarted.");
    } else {
      err("Gateway restart failed. Run manually: openclaw gateway restart");
    }
  }
}

// ── Done ──────────────────────────────────────────────────────────────────────
console.log("");
ok("Fix complete! Wait 3 seconds for the Gateway to reload, then make a test call.");
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
