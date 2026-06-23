#!/usr/bin/env node
import { spawn } from 'node:child_process';

const port = Number(process.env.PORT || 3210);
const fetchTimeoutMs = Number(process.env.SMIRK_LOCAL_RUNTIME_FETCH_TIMEOUT_MS || 5_000);
const startupTimeoutMs = Number(process.env.SMIRK_LOCAL_RUNTIME_STARTUP_TIMEOUT_MS || 10_000);
const env = {
  ...process.env,
  PORT: String(port),
  NODE_ENV: 'production',
};

const child = spawn('node', ['dist-server/server.mjs'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let logs = '';
child.stdout.on('data', (d) => { logs += String(d); });
child.stderr.on('data', (d) => { logs += String(d); });

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(error, detail = {}) {
  console.error(JSON.stringify({ ok: false, error, ...detail }, null, 2));
  process.exit(1);
}

async function fetchText(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: controller.signal });
    const text = await res.text();
    return { status: res.status, text, headers: res.headers };
  } catch (error) {
    fail('local-runtime-fetch-failed', {
      path,
      port,
      timeoutMs: fetchTimeoutMs,
      detail: String(error?.message || error || 'unknown fetch failure'),
    });
  } finally {
    clearTimeout(timeout);
  }
}

try {
  let started = false;
  const startChecks = Math.max(1, Math.ceil(startupTimeoutMs / 500));
  for (let i = 0; i < startChecks; i += 1) {
    await wait(500);
    if (/Server running on http:\/\/localhost:|SMIRK missed-call recovery started/i.test(logs)) {
      started = true;
      break;
    }
  }

  if (!started) {
    fail('local-runtime-startup-timeout', {
      port,
      timeoutMs: startupTimeoutMs,
      logs: logs.trim().slice(-2000),
    });
  }

  const health = await fetchText('/health');
  const version = await fetchText('/api/version');

  const healthOk = health.status === 200 && /"status"\s*:/i.test(health.text);
  const versionOk = version.status === 200 && /"version"\s*:/i.test(version.text);

  console.log(`GET /health -> ${health.status}`);
  console.log(health.text.slice(0, 200));
  console.log(`GET /api/version -> ${version.status}`);
  console.log(version.text.slice(0, 200));

  if (!healthOk || !versionOk) {
    fail('local-runtime-smoke-failed', {
      healthOk,
      versionOk,
      healthStatus: health.status,
      versionStatus: version.status,
    });
  }

  console.log('OK local runtime smoke passed for /health and /api/version');
} finally {
  child.kill('SIGTERM');
  await wait(300);
}
