#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const appUrl = 'https://ai-phone-agent-production-6811.up.railway.app';
const fetchTimeoutMs = Number(process.env.SMIRK_REPROCESS_FETCH_TIMEOUT_MS || 10_000);
const fetchRetries = Number(process.env.SMIRK_REPROCESS_FETCH_RETRIES || 2);

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
  console.error(JSON.stringify({ ok: false, error: 'missing-dashboard-api-key' }, null, 2));
  process.exit(1);
}

try {
  execFileSync('npm', ['run', '-s', 'check:live-is-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  const text = String(error?.stdout || error?.stderr || '').trim();
  console.error(JSON.stringify({
    ok: false,
    error: 'live-version-mismatch',
    message: 'Refusing to reprocess against stale production. Deploy local HEAD first.',
    detail: text || null,
  }, null, 2));
  process.exit(1);
}

function fail(error, detail = {}) {
  console.error(JSON.stringify({ ok: false, error, ...detail }, null, 2));
  process.exit(1);
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function getJson(pathname, init = {}) {
  const url = `${appUrl}${pathname}`;
  let lastError = null;

  for (let attempt = 1; attempt <= fetchRetries + 1; attempt += 1) {
    try {
      const res = await fetchWithTimeout(url, {
        ...init,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          ...(init.headers || {}),
        },
      });
      const text = await res.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
      return { res, parsed, attempts: attempt };
    } catch (error) {
      lastError = error;
    }
  }

  fail('reprocess-latest-call-fetch-failed', {
    url,
    attempts: fetchRetries + 1,
    timeoutMs: fetchTimeoutMs,
    detail: String(lastError?.message || lastError || 'unknown fetch failure'),
  });
}

const callsResp = await getJson('/api/calls?limit=1');
const latest = callsResp.parsed?.calls?.[0];
if (!latest?.call_sid) {
  console.error(JSON.stringify({ ok: false, error: 'no-latest-call-found' }, null, 2));
  process.exit(1);
}

const reprocessResp = await getJson(`/api/calls/${latest.call_sid}/reprocess`, { method: 'POST', body: '{}' });
const out = {
  ok: reprocessResp.res.ok && reprocessResp.parsed?.status === 'reprocessing',
  callSid: latest.call_sid,
  previousSummary: latest.call_summary || null,
  status: reprocessResp.res.status,
  response: reprocessResp.parsed,
};
console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
