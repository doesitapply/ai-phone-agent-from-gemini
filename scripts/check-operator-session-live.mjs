#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

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

const apiKey = String(process.env.DASHBOARD_API_KEY || readLocalEnvValue('DASHBOARD_API_KEY') || '').trim();
if (!apiKey) {
  console.error(JSON.stringify({ ok: false, error: 'missing-dashboard-api-key', message: 'Set DASHBOARD_API_KEY in env or .env.local to verify live operator auth.' }, null, 2));
  process.exit(1);
}

const res = await fetch(`${appUrl}/api/operator/session`, {
  headers: { 'x-api-key': apiKey },
});
const text = await res.text();
let parsed = null;
try {
  parsed = JSON.parse(text);
} catch {
  console.error(JSON.stringify({ ok: false, status: res.status, error: 'invalid-json', sample: text.slice(0, 200) }, null, 2));
  process.exit(1);
}

const ok = res.ok && parsed?.ok === true && parsed?.role === 'operator';
const out = {
  ok,
  status: res.status,
  role: parsed?.role || null,
  capabilities: parsed?.capabilities || null,
  url: `${appUrl}/api/operator/session`,
};

if (!ok) {
  console.error(JSON.stringify({ ...out, error: 'operator-session-check-failed' }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(out, null, 2));
