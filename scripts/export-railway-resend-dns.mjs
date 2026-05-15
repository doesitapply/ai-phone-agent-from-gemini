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
    // Let Railway CLI surface auth failures.
  }
}

loadRailwayAuth();

function getVars() {
  const raw = execFileSync('railway', ['variable', 'list', '--json'], { encoding: 'utf8' });
  return JSON.parse(raw);
}

const vars = getVars();
const resendApiKey = String(vars.RESEND_API_KEY || '').trim();
const fromEmail = String(vars.FROM_EMAIL || '').trim();
if (!resendApiKey) throw new Error('RESEND_API_KEY missing in Railway');

const senderMatch = fromEmail.match(/<([^>]+)>/) || fromEmail.match(/([^\s]+@[^\s]+)/);
const senderEmail = senderMatch?.[1] || senderMatch?.[0] || '';
const senderDomain = senderEmail.includes('@') ? senderEmail.split('@').pop().toLowerCase() : '';

async function getResendJson(path) {
  const response = await fetch(`https://api.resend.com${path}`, {
    headers: { Authorization: `Bearer ${resendApiKey}`, Accept: 'application/json' },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Resend API ${path} failed: HTTP ${response.status}${body ? ` ${body}` : ''}`);
  }
  return response.json();
}

const domainsPayload = await getResendJson('/domains');
const domains = Array.isArray(domainsPayload?.data) ? domainsPayload.data : [];
const candidate = domains
  .map((d) => ({ id: String(d?.id || '').trim(), name: String(d?.name || '').trim().toLowerCase(), status: String(d?.status || '').trim().toLowerCase() || 'unknown' }))
  .find((d) => d.name && (d.name === senderDomain || (senderDomain && senderDomain.endsWith(`.${d.name}`)))) || domains[0];

if (!candidate?.id) throw new Error('No Resend domain found');

const detail = await getResendJson(`/domains/${candidate.id}`);
const records = Array.isArray(detail?.records) ? detail.records : [];

console.log(`# Resend DNS export for ${candidate.name}`);
console.log(`# Status: ${candidate.status}`);
if (senderDomain) console.log(`# Railway FROM_EMAIL domain: ${senderDomain}`);
console.log('');
console.log('| Type | Host/Name | Value | Priority | Status |');
console.log('|---|---|---|---:|---|');
for (const record of records) {
  const type = String(record?.type || '').trim().toUpperCase();
  const name = String(record?.name || '').trim();
  const value = String(record?.value || '').trim();
  const priority = record?.priority != null ? String(record.priority) : '';
  const status = String(record?.status || '').trim().toLowerCase() || 'unknown';
  console.log(`| ${type} | ${name} | ${value.replace(/\|/g, '\\|')} | ${priority} | ${status} |`);
}

console.log('\n# Zone-file style copy');
for (const record of records) {
  const type = String(record?.type || '').trim().toUpperCase();
  const name = String(record?.name || '').trim();
  const value = String(record?.value || '').trim();
  const priority = record?.priority != null ? ` ${record.priority}` : '';
  console.log(`${name} ${type}${priority} ${value}`);
}
