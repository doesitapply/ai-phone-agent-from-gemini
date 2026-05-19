#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const appUrl = String(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');

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

const payload = {
  from: '+15550000001',
  speech: 'Hi, I missed your call and need help with a sewer backup at my house.',
};

const res = await fetch(`${appUrl}/api/twilio/test-webhook`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': apiKey,
  },
  body: JSON.stringify(payload),
});

const text = await res.text();
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
