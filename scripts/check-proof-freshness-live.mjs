#!/usr/bin/env node

const appUrl = String(process.env.APP_URL || 'https://smirkcalls.com').replace(/\/$/, '');
const allowStale = process.argv.includes('--allow-stale');

function fail(message, detail = {}) {
  console.error(JSON.stringify({ ok: false, message, detail }, null, 2));
  process.exit(1);
}

const response = await fetch(`${appUrl}/api/public-proof-snapshot`);
const text = await response.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  fail('public proof snapshot did not return JSON', {
    status: response.status,
    sample: text.slice(0, 500),
  });
}

const proofFreshness = body?.proofFreshness;
if (!response.ok || !proofFreshness || typeof proofFreshness !== 'object') {
  fail('public proof snapshot is missing proofFreshness', {
    status: response.status,
    body,
  });
}

const completeProofCalls = Number(body.completeProofCalls || 0);
const fresh = proofFreshness.fresh === true;
const output = {
  ok: response.ok && completeProofCalls > 0 && (fresh || allowStale),
  appUrl,
  completeProofCalls,
  proofFreshness,
  freshnessGate: fresh ? 'pass' : 'stale-or-missing',
  allowStale,
};

console.log(JSON.stringify(output, null, 2));

if (!output.ok) {
  process.exit(1);
}
