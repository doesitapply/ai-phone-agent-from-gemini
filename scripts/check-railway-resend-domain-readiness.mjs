#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import dns from 'node:dns/promises';

const fetchTimeoutMs = Number(process.env.SMIRK_RAILWAY_RESEND_DOMAIN_FETCH_TIMEOUT_MS || 15000);
const fetchAttempts = Number(process.env.SMIRK_RAILWAY_RESEND_DOMAIN_FETCH_ATTEMPTS || 2);
const fetchRetryDelayMs = Number(process.env.SMIRK_RAILWAY_RESEND_DOMAIN_FETCH_RETRY_DELAY_MS || 750);

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeFetchError(error) {
  if (error?.name === 'AbortError') {
    return `fetch timed out after ${fetchTimeoutMs}ms`;
  }
  return String(error?.message || error || 'unknown fetch error');
}

async function fetchResendTextWithTimeout(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const response = await fetch(`https://api.resend.com${path}`, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        Accept: 'application/json',
      },
    });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchResendTextWithRetry(path) {
  let lastError = null;
  const attempts = Math.max(1, fetchAttempts);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await fetchResendTextWithTimeout(path);
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(fetchRetryDelayMs);
      }
    }
  }
  return {
    error: 'railway-resend-domain-fetch-failed',
    detail: normalizeFetchError(lastError),
    attempts,
  };
}

async function getResendJson(path) {
  const result = await fetchResendTextWithRetry(path);

  if (result.error) {
    console.error(JSON.stringify({
      ok: false,
      error: result.error,
      path,
      detail: result.detail,
      attempts: result.attempts,
    }, null, 2));
    process.exit(1);
  }

  const { response, text, attempts } = result;

  if (!response.ok) {
    console.error(`FAIL Resend API ${path} returned HTTP ${response.status}`);
    if (text) console.error(text);
    process.exit(1);
  }

  try {
    return { payload: JSON.parse(text), attempts };
  } catch {
    console.error(JSON.stringify({
      ok: false,
      error: 'railway-resend-domain-invalid-json',
      path,
      status: response.status,
      attempts,
      bodySample: text.slice(0, 240),
    }, null, 2));
    process.exit(1);
  }
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

const { payload, attempts: domainListAttempts } = await getResendJson('/domains');

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
console.log(`Resend domains API attempts: ${domainListAttempts}`);
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
      const { payload: detailPayload } = await getResendJson(`/domains/${candidate.id}`);
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
