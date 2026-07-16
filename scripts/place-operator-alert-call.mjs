#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import twilio from 'twilio';
import dotenv from 'dotenv';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const filtered = args.filter((arg) => arg !== '--dry-run');
const target = String(filtered[0] || '').trim();
const message = String(filtered.slice(1).join(' ') || '').trim();

const envFiles = [
  '.env.local',
  '.env',
  path.join(process.env.HOME || '', '.openclaw', 'workspace', '.env.operator'),
  path.join(process.env.HOME || '', '.openclaw', 'workspace', '.env.smirk'),
  path.join(process.env.HOME || '', '.openclaw', 'workspace', '.env'),
];

for (const file of envFiles) {
  const resolved = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  if (fs.existsSync(resolved)) dotenv.config({ path: resolved, override: false, quiet: true });
}

function maskPhone(value) {
  const s = String(value || '').trim();
  const digits = s.replace(/\D/g, '');
  const suffix = digits.slice(-4);
  return suffix ? `${s.startsWith('+') ? '+' : ''}***${suffix}` : '***';
}

function normalizeE164(value) {
  const raw = String(value || '').trim();
  if (/^\+\d{10,15}$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return '';
}

function allowlist() {
  return String(process.env.COMPLIANCE_ALWAYS_ALLOW_NUMBERS || '')
    .split(',')
    .map((s) => normalizeE164(s))
    .filter(Boolean);
}

function escapeXml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function die(error, nextAction, extra = {}) {
  console.error(JSON.stringify({ ok: false, error, nextAction, ...extra }, null, 2));
  process.exit(1);
}

const to = normalizeE164(target);
const approved = process.env.APPROVE_SMIRK_OPERATOR_ALERT_CALL === '1';
const allowed = allowlist();
const maskedTarget = maskPhone(to || target);

if (!to) die('missing-or-invalid-target', 'Pass an explicit safe E.164 target number: npm run -s alert:operator-call -- +15551234567 "message"');
if (!message) die('missing-message', 'Pass a short blocker message after the target number.');
if (message.length > 400) die('message-too-long', 'Keep operator alert calls under 400 characters.', { length: message.length });
if (!allowed.includes(to)) {
  die('target-not-allowlisted', 'Add/confirm the target in COMPLIANCE_ALWAYS_ALLOW_NUMBERS before any live alert call.', {
    maskedTarget,
    allowlistedTargetHints: allowed.map(maskPhone),
  });
}

const from = normalizeE164(process.env.TWILIO_PHONE_NUMBER || '');
const accountSid = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
const authToken = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
const voice = String(process.env.SMIRK_OPERATOR_ALERT_VOICE || 'alice').trim();
const safeVoice = /^[A-Za-z][A-Za-z0-9_-]*$/.test(voice) ? voice : 'alice';
const twiml = `<Response><Say voice="${safeVoice}">Important. ${escapeXml(message)}</Say></Response>`;

if (dryRun || !approved) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    approved,
    maskedTarget,
    from: maskPhone(from),
    message,
    wouldCall: approved && !!(accountSid && authToken && from),
    nextAction: approved
      ? 'Set Twilio env if missing, then rerun without --dry-run.'
      : 'Set APPROVE_SMIRK_OPERATOR_ALERT_CALL=1 and rerun without --dry-run to place the call.',
  }, null, 2));
  process.exit(0);
}

if (!accountSid || !authToken || !from) {
  die('missing-twilio-env', 'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in the SMIRK/operator env.', {
    hasAccountSid: !!accountSid,
    hasAuthToken: !!authToken,
    hasFrom: !!from,
  });
}

const client = twilio(accountSid, authToken);
const call = await client.calls.create({ to, from, twiml });
console.log(JSON.stringify({ ok: true, sid: call.sid, maskedTarget, from: maskPhone(from) }, null, 2));
