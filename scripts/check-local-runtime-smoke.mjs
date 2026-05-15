#!/usr/bin/env node
import { spawn } from 'node:child_process';

const port = Number(process.env.PORT || 3210);
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

async function fetchText(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

try {
  let started = false;
  for (let i = 0; i < 20; i += 1) {
    await wait(500);
    if (/Server running on http:\/\/localhost:|AI Phone Agent started/i.test(logs)) {
      started = true;
      break;
    }
  }

  if (!started) {
    throw new Error(`Server did not start in time. Logs:\n${logs.trim()}`);
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
    throw new Error(`Local runtime smoke failed. healthOk=${healthOk} versionOk=${versionOk}`);
  }

  console.log('OK local runtime smoke passed for /health and /api/version');
} finally {
  child.kill('SIGTERM');
  await wait(300);
}
