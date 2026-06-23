#!/usr/bin/env node
import fs from 'node:fs';

const fetchTimeoutMs = Number(process.env.SMIRK_RESEND_DOMAIN_FETCH_TIMEOUT_MS || 10_000);
const fetchRetries = Number(process.env.SMIRK_RESEND_DOMAIN_FETCH_RETRIES || 2);

function stripWrappingQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseEnvFile(path) {
  const out = {};
  for (const rawLine of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = stripWrappingQuotes(line.slice(eq + 1).trim());
    if (key) out[key] = value;
  }
  return out;
}

const fileEnv = process.env.ENV_FILE ? parseEnvFile(process.env.ENV_FILE) : {};
const pick = (key) => {
  const runtime = String(process.env[key] || '').trim();
  if (runtime) return runtime;
  return String(fileEnv[key] || '').trim();
};

const resendApiKey = pick('RESEND_API_KEY');
const fromEmail = pick('FROM_EMAIL');

function fail(message, detail = {}) {
  console.error(JSON.stringify({ ok: false, error: message, ...detail }, null, 2));
  process.exit(1);
}

if (!resendApiKey) {
  fail('missing-resend-api-key');
}

if (!fromEmail) {
  fail('missing-from-email');
}

const emailMatch = fromEmail.match(/<([^>]+)>/) || fromEmail.match(/([^\s]+@[^\s]+)/);
const senderEmail = emailMatch?.[1] || emailMatch?.[0] || '';
const senderDomain = senderEmail.includes('@') ? senderEmail.split('@').pop().toLowerCase() : '';

if (!senderDomain) {
  fail('invalid-from-email', { fromEmail });
}

async function fetchResendDomainsWithTimeout() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    return await fetch('https://api.resend.com/domains', {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        Accept: 'application/json',
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchResendDomainsWithRetry() {
  let lastError = null;
  for (let attempt = 1; attempt <= fetchRetries + 1; attempt += 1) {
    try {
      return { response: await fetchResendDomainsWithTimeout(), attempts: attempt };
    } catch (error) {
      lastError = error;
    }
  }

  fail('resend-domain-fetch-failed', {
    attempts: fetchRetries + 1,
    timeoutMs: fetchTimeoutMs,
    detail: String(lastError?.message || lastError || 'unknown fetch failure'),
  });
}

const { response, attempts } = await fetchResendDomainsWithRetry();

if (!response.ok) {
  const body = await response.text().catch(() => '');
  fail('resend-domain-api-http-error', {
    status: response.status,
    body: body ? body.slice(0, 500) : null,
  });
}

let payload;
try {
  payload = await response.json();
} catch (error) {
  fail('resend-domain-invalid-json', {
    detail: String(error?.message || error || 'invalid json'),
  });
}
const domains = Array.isArray(payload?.data) ? payload.data : [];
const verifiedDomains = domains.filter((domain) => {
  const status = String(domain?.status || '').toLowerCase();
  return status === 'verified';
});

console.log(`Resend domains API attempts: ${attempts}`);
console.log(`Resend domains found: ${domains.length}`);
console.log(`Verified domains: ${verifiedDomains.length}`);
console.log(`FROM_EMAIL sender domain: ${senderDomain}`);

if (verifiedDomains.length === 0) {
  fail('no-verified-resend-domains');
}

const verifiedNames = verifiedDomains
  .map((domain) => String(domain?.name || '').trim().toLowerCase())
  .filter(Boolean);
const senderMatchesVerified = verifiedNames.some((name) => senderDomain === name || senderDomain.endsWith(`.${name}`));

if (!senderMatchesVerified) {
  fail('from-email-domain-not-verified', { senderDomain, verifiedNames });
}

console.log('OK Resend sending domain is verified and matches FROM_EMAIL');
