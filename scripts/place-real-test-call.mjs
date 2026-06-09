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

function pick(...keys) {
  for (const key of keys) {
    const value = String(process.env[key] || readLocalEnvValue(key) || '').trim();
    if (value) return value;
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

function pickLiveFirst(...keys) {
  for (const key of keys) {
    const value = String(process.env[key] || readRailwayEnvValue(key) || readLocalEnvValue(key) || '').trim();
    if (value) return value;
  }
  return '';
}

const apiKey = pickLiveFirst('DASHBOARD_API_KEY');
if (!apiKey) {
  console.error(JSON.stringify({ ok: false, error: 'missing-dashboard-api-key' }, null, 2));
  process.exit(1);
}

function maskPhone(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  const suffix = digits.slice(-4);
  return suffix ? `${s.startsWith('+') ? '+' : ''}***${suffix}` : '***';
}

if (process.env.SMIRK_PROOF_RUNNER !== '1') {
  console.error(JSON.stringify({
    ok: false,
    error: 'proof-runner-required',
    nextAction: 'Use npm run -s proof:real-call -- <safe-number> so live parity, target readiness, dashboard baseline, artifacts, owner email, callback task, and dashboard proof are verified.',
  }, null, 2));
  process.exit(1);
}

const cliTarget = String(process.argv[2] || '').trim();
try {
  execFileSync('npm', ['run', '-s', 'check:live-is-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  const text = String(error?.stdout || error?.stderr || '').trim();
  console.error(JSON.stringify({
    ok: false,
    error: 'live-version-mismatch',
    message: 'Refusing to place a real test call against stale production. Deploy local HEAD first.',
    detail: text || null,
  }, null, 2));
  process.exit(1);
}

const to = cliTarget;
if (!to) {
  console.error(JSON.stringify({
    ok: false,
    error: 'missing-test-call-target',
    acceptedTargetSource: 'cli-argument-only',
    setupCommand: 'npm run print:real-call-setup',
    nextAction: 'Run the no-argument readiness check, choose a safe allowlisted target from the masked hints, rerun readiness with the full target, then use npm run proof:real-call -- <safe-number> for the full Gate 4 proof.',
  }, null, 2));
  process.exit(1);
}

try {
  execFileSync('npm', ['run', '-s', 'check:real-call-readiness', '--', to], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  const text = String(error?.stdout || error?.stderr || '').trim();
  console.error(JSON.stringify({
    ok: false,
    error: 'real-call-readiness-failed',
    message: 'Refusing to place a real test call until the target passes live readiness, allowlist, and dashboard proof checks.',
    maskedTarget: maskPhone(to),
    detail: text || null,
  }, null, 2));
  process.exit(1);
}

const res = await fetch(`${appUrl}/api/test-call`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': apiKey,
  },
  body: JSON.stringify({ to }),
});

const text = await res.text();
let parsed = null;
try {
  parsed = JSON.parse(text);
} catch {
  console.error(JSON.stringify({ ok: false, status: res.status, error: 'invalid-json', sample: text.slice(0, 200) }, null, 2));
  process.exit(1);
}

const out = {
  ok: res.ok && parsed?.ok === true && !!parsed?.callSid,
  status: res.status,
  url: `${appUrl}/api/test-call`,
  maskedTarget: maskPhone(to),
  callSid: parsed?.callSid || null,
  error: parsed?.error || null,
};

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
