#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const port = Number(process.env.PORT || 3210);
const fetchTimeoutMs = Number(process.env.SMIRK_LOCAL_RUNTIME_FETCH_TIMEOUT_MS || 5_000);
const startupTimeoutMs = Number(process.env.SMIRK_LOCAL_RUNTIME_STARTUP_TIMEOUT_MS || 10_000);
const env = {
  ...process.env,
  PORT: String(port),
  NODE_ENV: 'production',
};

function readLocalEnvValue(key) {
  const direct = process.env[key];
  if (direct) return direct;
  for (const file of ['.env.local', '.env']) {
    if (!fs.existsSync(file)) continue;
    const line = fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .find((entry) => entry.trim().startsWith(`${key}=`));
    if (!line) continue;
    return line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return '';
}

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

async function fetchText(path, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: controller.signal, headers });
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
  const dashboardApiKey = readLocalEnvValue('DASHBOARD_API_KEY');
  const tasks = dashboardApiKey
    ? await fetchText('/api/tasks', { 'X-Api-Key': dashboardApiKey })
    : null;

  const healthOk = health.status === 200 && /"status"\s*:/i.test(health.text);
  const versionOk = version.status === 200 && /"version"\s*:/i.test(version.text);
  const tasksOk = !tasks || (tasks.status === 200 && /"tasks"\s*:/i.test(tasks.text));

  console.log(`GET /health -> ${health.status}`);
  console.log(health.text.slice(0, 200));
  console.log(`GET /api/version -> ${version.status}`);
  console.log(version.text.slice(0, 200));
  if (tasks) {
    console.log(`GET /api/tasks -> ${tasks.status}`);
    console.log(tasks.text.slice(0, 200));
  } else {
    console.log('SKIP /api/tasks smoke: DASHBOARD_API_KEY not configured');
  }

  if (!healthOk || !versionOk || !tasksOk) {
    fail('local-runtime-smoke-failed', {
      healthOk,
      versionOk,
      tasksOk,
      healthStatus: health.status,
      versionStatus: version.status,
      tasksStatus: tasks?.status,
    });
  }

  console.log('OK local runtime smoke passed for /health, /api/version, and authenticated /api/tasks when configured');
} finally {
  child.kill('SIGTERM');
  await wait(300);
}
