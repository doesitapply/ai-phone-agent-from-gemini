#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import dns from 'node:dns/promises';

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
    // Let the Railway CLI surface auth failures normally.
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

if (!resendApiKey) {
  console.error('FAIL live Railway RESEND_API_KEY is not set');
  process.exit(1);
}

if (!fromEmail) {
  console.error('FAIL live Railway FROM_EMAIL is not set');
  process.exit(1);
}

const emailMatch = fromEmail.match(/<([^>]+)>/) || fromEmail.match(/([^\s]+@[^\s]+)/);
const senderEmail = emailMatch?.[1] || emailMatch?.[0] || '';
const senderDomain = senderEmail.includes('@') ? senderEmail.split('@').pop().toLowerCase() : '';

if (!senderDomain) {
  console.error(`FAIL could not parse sender domain from live Railway FROM_EMAIL=${fromEmail}`);
  process.exit(1);
}

async function getResendJson(path) {
  const response = await fetch(`https://api.resend.com${path}`, {
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`FAIL Resend API ${path} returned HTTP ${response.status}`);
    if (body) console.error(body);
    process.exit(1);
  }

  return response.json();
}

async function resolveDnsRecord(type, host) {
  try {
    if (type === 'TXT') {
      return (await dns.resolveTxt(host)).map((parts) => parts.join(''));
    }
    if (type === 'MX') {
      return (await dns.resolveMx(host)).map((entry) => `${entry.exchange} priority=${entry.priority}`);
    }
    if (type === 'CNAME') {
      return await dns.resolveCname(host);
    }
  } catch {
    return [];
  }
  return [];
}

const payload = await getResendJson('/domains');

const domains = Array.isArray(payload?.data) ? payload.data : [];
const normalizedDomains = domains.map((domain) => ({
  id: String(domain?.id || '').trim(),
  name: String(domain?.name || '').trim().toLowerCase(),
  status: String(domain?.status || '').trim().toLowerCase() || 'unknown',
  region: String(domain?.region || '').trim(),
}));
const verifiedDomains = normalizedDomains.filter((domain) => domain.status === 'verified');

console.log(`Live Railway FROM_EMAIL sender domain: ${senderDomain}`);
console.log(`Resend domains found: ${domains.length}`);
console.log(`Verified domains: ${verifiedDomains.length}`);
if (normalizedDomains.length) {
  console.log('Resend domain statuses:');
  for (const domain of normalizedDomains) {
    console.log(`- ${domain.name || '(unnamed)'} [${domain.status}]${domain.region ? ` region=${domain.region}` : ''}`);
  }
}

if (verifiedDomains.length === 0) {
  console.error('FAIL no verified Resend sending domains found for the live Railway RESEND_API_KEY');

  const candidate = normalizedDomains.find((domain) => domain.name === senderDomain || senderDomain.endsWith(`.${domain.name}`)) || normalizedDomains[0];
  if (candidate?.id) {
    try {
      const detailPayload = await getResendJson(`/domains/${candidate.id}`);
      const records = Array.isArray(detailPayload?.records) ? detailPayload.records : [];
      if (records.length) {
        console.error(`DNS records needed for ${candidate.name}:`);
        for (const record of records) {
          const type = String(record?.type || '').trim().toUpperCase();
          const name = String(record?.name || '').trim();
          const value = String(record?.value || '').trim();
          const status = String(record?.status || '').trim().toLowerCase() || 'unknown';
          const priority = record?.priority != null ? ` priority=${record.priority}` : '';
          console.error(`- ${type} ${name} -> ${value}${priority} [${status}]`);

          const liveValues = await resolveDnsRecord(type, name);
          const expected = `${value}${priority}`.trim().toLowerCase();
          const matches = liveValues.some((entry) => String(entry).trim().toLowerCase() === expected || String(entry).trim().toLowerCase() === value.toLowerCase());
          if (liveValues.length === 0) {
            console.error(`  DNS now: missing (${type} lookup returned no records)`);
          } else if (matches) {
            console.error(`  DNS now: OK ${liveValues.join(' | ')}`);
          } else {
            console.error(`  DNS now: mismatch ${liveValues.join(' | ')}`);
          }
        }
      }
    } catch {
      // Best-effort detail fetch only.
    }
  }

  console.error('Next action: run npm run cutover:sender-domain -- --dry-run, add/fix the DNS records above until each "DNS now" line is OK, verify the domain in Resend, then rerun this check.');
  console.error('Operator helper: npm run cutover:sender-domain -- --dry-run');
  console.error('Namecheap DNS: https://ap.www.namecheap.com/domains/domaincontrolpanel/smirkcalls.com/advancedns');
  console.error('Resend domains: https://resend.com/domains');
  console.error(`Operator runbook: ${process.env.HOME}/.openclaw/workspace/output/smirk-domain-cutover-click-path.md`);
  process.exit(1);
}

const verifiedNames = verifiedDomains
  .map((domain) => domain.name)
  .filter(Boolean);
const senderMatchesVerified = verifiedNames.some((name) => senderDomain === name || senderDomain.endsWith(`.${name}`));

if (!senderMatchesVerified) {
  console.error(`FAIL live Railway FROM_EMAIL domain ${senderDomain} is not among verified Resend domains: ${verifiedNames.join(', ')}`);
  console.error('Next action: run npm run cutover:sender-domain -- --dry-run, then either verify the current sender domain in Resend or change FROM_EMAIL in Railway to use one of the verified domains above.');
  console.error('Operator helper: npm run cutover:sender-domain -- --dry-run');
  console.error('Resend domains: https://resend.com/domains');
  console.error(`Operator runbook: ${process.env.HOME}/.openclaw/workspace/output/smirk-domain-cutover-click-path.md`);
  process.exit(1);
}

console.log('OK live Railway Resend sending domain is verified and matches FROM_EMAIL');
