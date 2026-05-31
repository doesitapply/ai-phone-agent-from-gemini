#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const appUrl = String(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');

function liveIsCurrent() {
  try {
    execFileSync('node', ['scripts/check-live-is-current.mjs'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: String(error?.stdout || error?.stderr || error?.message || '').trim(),
    };
  }
}

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
  String(process.env.DASHBOARD_API_KEY || '').trim(),
  readLocalEnvValue('DASHBOARD_API_KEY'),
  readRailwayEnvValue('DASHBOARD_API_KEY'),
].filter(Boolean);

if (apiKeyCandidates.length === 0) {
  console.error(JSON.stringify({
    ok: false,
    error: 'missing-dashboard-api-key',
    message: 'Set DASHBOARD_API_KEY in env, .env.local, or ~/.openclaw/workspace/.env.operator to verify live dashboard proof counters.',
  }, null, 2));
  process.exit(1);
}

const current = liveIsCurrent();
if (!current.ok) {
  console.error(JSON.stringify({
    ok: false,
    error: 'stale-production-deploy',
    message: 'Refusing to verify dashboard proof counters against stale production. Deploy local HEAD first.',
    detail: current.detail,
  }, null, 2));
  process.exit(1);
}

let res;
let text = '';
for (const apiKey of apiKeyCandidates) {
  res = await fetch(`${appUrl}/api/workspace-overview`, {
    headers: { 'x-api-key': apiKey },
  });
  text = await res.text();
  if (res.status !== 401) break;
}

let parsed = null;
try {
  parsed = JSON.parse(text);
} catch {
  console.error(JSON.stringify({ ok: false, status: res.status, error: 'invalid-json', sample: text.slice(0, 200) }, null, 2));
  process.exit(1);
}

const counters = [
  'totalCalls',
  'summariesGenerated',
  'callbackTasksCreated',
  'ownerEmailAlertsSent',
  'completeProofCalls',
];
const missing = counters.filter((key) => !(key in parsed));
const nonNumeric = counters.filter((key) => key in parsed && !Number.isFinite(Number(parsed[key])));
const negative = counters.filter((key) => Number(parsed[key]) < 0);
const impossibleCompleteProofCount =
  Number(parsed.completeProofCalls) > Math.min(
    Number(parsed.summariesGenerated),
    Number(parsed.callbackTasksCreated),
    Number(parsed.ownerEmailAlertsSent)
  );

const out = {
  ok: res.ok && missing.length === 0 && nonNumeric.length === 0 && negative.length === 0 && !impossibleCompleteProofCount,
  status: res.status,
  url: `${appUrl}/api/workspace-overview`,
  counters: Object.fromEntries(counters.map((key) => [key, Number(parsed[key] || 0)])),
  missing,
  nonNumeric,
  negative,
  impossibleCompleteProofCount,
};

console.log(JSON.stringify(out, null, 2));

if (!out.ok) {
  process.exit(1);
}
