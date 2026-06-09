#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

function loadRailwayAuth() {
  try {
    execFileSync('bash', ['-lc', 'source ./scripts/load-railway-auth.sh >/dev/null 2>&1 && env | grep -E "^(RAILWAY_API_TOKEN|RAILWAY_TOKEN)="'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => {
        const eq = line.indexOf('=');
        if (eq === -1) return;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key && value && !process.env[key]) process.env[key] = value;
      });
  } catch {
    // Railway CLI will report auth issues.
  }
}

function getVars() {
  loadRailwayAuth();
  const raw = execFileSync('railway', ['variable', 'list', '--json'], { encoding: 'utf8' });
  return JSON.parse(raw);
}

const target = String(process.argv[2] || '').trim();
if (!target) {
  console.error(JSON.stringify({
    ok: false,
    error: 'missing-target',
    usage: 'npm run check:railway:test-call-allowlist -- <safe-number>',
    nextAction: 'Run npm run print:real-call-setup first and choose a safe proof-call target from the masked readiness hints.',
  }, null, 2));
  process.exit(1);
}

function maskPhone(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  const suffix = digits.slice(-4);
  return suffix ? `${s.startsWith('+') ? '+' : ''}***${suffix}` : '***';
}

const vars = getVars();
const rawAllowlist = String(vars.COMPLIANCE_ALWAYS_ALLOW_NUMBERS || '').trim();
const allowlist = rawAllowlist.split(',').map((s) => s.trim()).filter(Boolean);
const allowlisted = allowlist.includes(target);

const out = {
  ok: allowlisted,
  maskedTarget: maskPhone(target),
  allowlistConfigured: allowlist.length > 0,
  allowlistedTargetCount: allowlist.length,
  allowlisted,
  nextAction: allowlisted
    ? 'Target is already allowlisted in Railway. Rerun npm run check:real-call-readiness -- <safe-number> before the proof call.'
    : 'Do not mutate the production allowlist from this check. Prefer an existing allowlisted target from npm run check:real-call-readiness, or use the confirmed allowlist setter only after explicit approval.',
};

console.log(JSON.stringify(out, null, 2));
if (!allowlisted) process.exit(1);
