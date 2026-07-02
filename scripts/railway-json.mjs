import { execFileSync, spawnSync } from "node:child_process";

const defaultAttempts = Number(process.env.SMIRK_RAILWAY_JSON_ATTEMPTS || 4);
const defaultDelayMs = Number(process.env.SMIRK_RAILWAY_JSON_RETRY_DELAY_MS || 3000);

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function loadRailwayAuth() {
  try {
    execFileSync(
      "bash",
      ["-lc", 'source ./scripts/load-railway-auth.sh >/dev/null 2>&1 && env | grep -E "^(RAILWAY_API_TOKEN|RAILWAY_TOKEN)="'],
      { encoding: "utf8" },
    )
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => {
        const eq = line.indexOf("=");
        if (eq === -1) return;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key && value && !process.env[key]) process.env[key] = value;
      });
  } catch {
    // Let the Railway CLI surface auth issues normally.
  }
}

function isRetryableRailwayOutput(text) {
  return /rate\s*limit|ratelimit|ratelimited|too many requests|econnreset|etimedout|timeout/i.test(String(text || ""));
}

function normalizeCliFailure(result, label) {
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  return {
    ok: false,
    label,
    status: result.status,
    signal: result.signal || null,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

export function railwayJson(args, options = {}) {
  loadRailwayAuth();
  const attempts = Math.max(1, Number(options.attempts || defaultAttempts));
  const delayMs = Math.max(0, Number(options.delayMs || defaultDelayMs));
  const label = options.label || `railway ${args.join(" ")}`;
  let lastFailure = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync("railway", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: options.maxBuffer || 1024 * 1024 * 8,
    });

    if (result.status === 0) {
      try {
        return JSON.parse(String(result.stdout || ""));
      } catch (error) {
        lastFailure = {
          ok: false,
          label,
          status: 0,
          error: "invalid-json",
          message: String(error?.message || error),
          stdout: String(result.stdout || "").trim(),
          stderr: String(result.stderr || "").trim(),
        };
      }
    } else {
      lastFailure = normalizeCliFailure(result, label);
    }

    const combined = `${lastFailure?.stdout || ""}\n${lastFailure?.stderr || ""}\n${lastFailure?.message || ""}`;
    if (attempt < attempts && isRetryableRailwayOutput(combined)) {
      if (options.quiet !== true) {
        console.error(`WARN ${label} failed with retryable Railway CLI output; retrying in ${delayMs}ms (${attempt}/${attempts})`);
      }
      sleepSync(delayMs);
      continue;
    }
    break;
  }

  const error = new Error(`${label} failed after ${attempts} attempt${attempts === 1 ? "" : "s"}`);
  error.detail = lastFailure;
  throw error;
}

export function railwayVariables(options = {}) {
  return railwayJson(["variable", "list", "--json"], { ...options, label: options.label || "railway variable list --json" });
}

export function readRailwayEnvValue(key, options = {}) {
  try {
    const vars = railwayVariables(options);
    return String(vars[key] || "").trim();
  } catch (error) {
    if (options.quiet !== true) {
      const detail = error?.detail ? JSON.stringify(error.detail) : String(error?.message || error);
      console.error(`WARN unable to read Railway variable ${key}: ${detail}`);
    }
    return "";
  }
}
