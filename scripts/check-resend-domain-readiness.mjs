#!/usr/bin/env node
import fs from 'node:fs';

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

if (!resendApiKey) {
  console.error('FAIL RESEND_API_KEY is not set');
  process.exit(1);
}

if (!fromEmail) {
  console.error('FAIL FROM_EMAIL is not set');
  process.exit(1);
}

const emailMatch = fromEmail.match(/<([^>]+)>/) || fromEmail.match(/([^\s]+@[^\s]+)/);
const senderEmail = emailMatch?.[1] || emailMatch?.[0] || '';
const senderDomain = senderEmail.includes('@') ? senderEmail.split('@').pop().toLowerCase() : '';

if (!senderDomain) {
  console.error(`FAIL could not parse sender domain from FROM_EMAIL=${fromEmail}`);
  process.exit(1);
}

const response = await fetch('https://api.resend.com/domains', {
  headers: {
    Authorization: `Bearer ${resendApiKey}`,
    Accept: 'application/json',
  },
});

if (!response.ok) {
  const body = await response.text().catch(() => '');
  console.error(`FAIL Resend domains API returned HTTP ${response.status}`);
  if (body) console.error(body);
  process.exit(1);
}

const payload = await response.json();
const domains = Array.isArray(payload?.data) ? payload.data : [];
const verifiedDomains = domains.filter((domain) => {
  const status = String(domain?.status || '').toLowerCase();
  return status === 'verified';
});

console.log(`Resend domains found: ${domains.length}`);
console.log(`Verified domains: ${verifiedDomains.length}`);
console.log(`FROM_EMAIL sender domain: ${senderDomain}`);

if (verifiedDomains.length === 0) {
  console.error('FAIL no verified Resend sending domains found');
  process.exit(1);
}

const verifiedNames = verifiedDomains
  .map((domain) => String(domain?.name || '').trim().toLowerCase())
  .filter(Boolean);
const senderMatchesVerified = verifiedNames.some((name) => senderDomain === name || senderDomain.endsWith(`.${name}`));

if (!senderMatchesVerified) {
  console.error(`FAIL FROM_EMAIL domain ${senderDomain} is not among verified Resend domains: ${verifiedNames.join(', ')}`);
  process.exit(1);
}

console.log('OK Resend sending domain is verified and matches FROM_EMAIL');
