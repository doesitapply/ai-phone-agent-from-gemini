#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const appUrl = (process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');

function readLocalEnvValue(key) {
  for (const file of ['.env.local', '.env']) {
    const p = path.resolve(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith(`${key}=`)) continue;
      return line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return '';
}

function readRailwayEnvValue(key) {
  try {
    const raw = execFileSync(
      'bash',
      ['-lc', 'source ./scripts/load-railway-auth.sh >/dev/null 2>&1 || true; railway variable list --json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const vars = JSON.parse(raw);
    return String(vars[key] || '').trim();
  } catch {
    return '';
  }
}

const candidates = [
  ['process env', String(process.env.DASHBOARD_API_KEY || '').trim()],
  ['local env file', readLocalEnvValue('DASHBOARD_API_KEY')],
  ['railway variables', readRailwayEnvValue('DASHBOARD_API_KEY')],
].filter(([, value]) => String(value || '').trim().length > 0);

if (candidates.length === 0) {
  console.error(JSON.stringify({ ok: false, error: 'missing-dashboard-api-key', message: 'Set DASHBOARD_API_KEY in env, .env.local, or live Railway variables to verify live operator auth.' }, null, 2));
  process.exit(1);
}

let lastFailure = null;

for (const [source, apiKey] of candidates) {
  const res = await fetch(`${appUrl}/api/operator/session`, {
    headers: { 'x-api-key': apiKey },
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    lastFailure = { source, status: res.status, error: 'invalid-json', sample: text.slice(0, 200) };
    continue;
  }

  const ok = res.ok && parsed?.ok === true && parsed?.role === 'operator';
  const out = {
    ok,
    source,
    status: res.status,
    role: parsed?.role || null,
    capabilities: parsed?.capabilities || null,
    url: `${appUrl}/api/operator/session`,
  };

  if (ok) {
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  lastFailure = { ...out, error: 'operator-session-check-failed' };
}

console.error(JSON.stringify(lastFailure || { ok: false, error: 'operator-session-check-failed' }, null, 2));
process.exit(1);
