#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const appUrl = String(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');

function readLocalEnvValue(key) {
  const files = [
    '.env.local',
    '.env',
    path.join(process.env.HOME || '', '.openclaw', 'workspace', '.env.operator'),
    path.join(process.env.HOME || '', '.openclaw', 'workspace', '.env.smirk'),
    path.join(process.env.HOME || '', '.openclaw', 'workspace', '.env'),
  ];
  for (const file of files) {
    const p = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
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

const apiKeyCandidates = [
  ['process env', String(process.env.DASHBOARD_API_KEY || '').trim()],
  ['local/operator env file', readLocalEnvValue('DASHBOARD_API_KEY')],
  ['railway variables', readRailwayEnvValue('DASHBOARD_API_KEY')],
].filter(([, value]) => String(value || '').trim().length > 0);
if (apiKeyCandidates.length === 0) {
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
    message: 'Refusing to run the Twilio webhook smoke check against stale production.',
    detail: text || null,
  }, null, 2));
  process.exit(1);
}

const payload = {
  from: '+15550000001',
  speech: 'Hi, I missed your call and need help with a sewer backup at my house.',
};

let res;
let text = '';
let authSource = null;
for (const [source, apiKey] of apiKeyCandidates) {
  res = await fetch(`${appUrl}/api/twilio/test-webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(payload),
  });
  text = await res.text();
  if (res.status !== 401 && res.status !== 403) {
    authSource = source;
    break;
  }
}

let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  console.error(JSON.stringify({ ok: false, status: res.status, error: 'invalid-json', sample: text.slice(0, 200) }, null, 2));
  process.exit(1);
}

const step1 = parsed?.results?.step1_caller_resolved;
const step2 = parsed?.results?.step2_ai_response;
const step3 = parsed?.results?.step3_twiml;
const ok = res.ok && parsed?.success === true && parsed?.results?.overall?.startsWith('PASS') && step1?.contactId && step2?.text && step3?.valid === true;

const out = {
  ok,
  authSource,
  status: res.status,
  url: `${appUrl}/api/twilio/test-webhook`,
  testCallSid: parsed?.testCallSid || null,
  overall: parsed?.results?.overall || null,
  callerResolved: Boolean(step1?.contactId),
  aiPreview: step2?.text ? String(step2.text).slice(0, 160) : null,
  aiSource: step2?.source || null,
  twimlValid: step3?.valid === true,
};

console.log(JSON.stringify(out, null, 2));
if (!ok) process.exit(1);
