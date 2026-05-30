#!/usr/bin/env node
import fs from 'node:fs';
import dns from 'node:dns/promises';
import os from 'node:os';
import path from 'node:path';

function stripWrappingQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
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

const envFiles = [
  path.join(os.homedir(), '.openclaw', 'workspace', '.env.smirk'),
  path.join(os.homedir(), '.openclaw', 'workspace', '.env.operator'),
  '.env.local',
];
const fileEnv = Object.assign({}, ...envFiles.map(parseEnvFile));
const rawBaseUrl = String(process.env.LANDING_APP_URL || process.argv[2] || fileEnv.LANDING_APP_URL || '').trim();
const baseUrl = rawBaseUrl.replace(/\/+$/, '');

if (!baseUrl) {
  console.error('Usage: LANDING_APP_URL=https://smirkcalls.com node scripts/check-landing-live-readiness.mjs');
  process.exit(1);
}

const endpoint = `${baseUrl}/api/first-dollar-readiness`;
const expectedLandingDns = [
  { host: 'smirkcalls.com', type: 'CNAME', target: 'gprq27xc.up.railway.app' },
  { host: 'www.smirkcalls.com', type: 'CNAME', target: 'ps6cal9l.up.railway.app' },
  { host: '_railway-verify.smirkcalls.com', type: 'TXT', target: 'railway-verify=23d206fd4eb677fab6fe3589077a599680a0f1321ae74bbb1b7deb077047f364' },
  { host: '_railway-verify.www.smirkcalls.com', type: 'TXT', target: 'railway-verify=1797adc87b003a6c2f4f4ad977f9afdd5dd125740fe69a2f3e3ec30a167eb3d7' },
];
const namecheapUrl = 'https://ap.www.namecheap.com/domains/domaincontrolpanel/smirkcalls.com/advancedns';

function namecheapHost(host) {
  return host
    .replace(/\.smirkcalls\.com$/, '')
    .replace(/^smirkcalls\.com$/, '@');
}

function normalizeDnsValue(value) {
  return String(value || '').trim().replace(/\.$/, '').toLowerCase();
}

async function resolveExpectedRecord(record) {
  try {
    if (record.type === 'TXT') {
      const values = (await dns.resolveTxt(record.host)).map((chunks) => chunks.join(''));
      return {
        ...record,
        values,
        ok: values.some((value) => normalizeDnsValue(value) === normalizeDnsValue(record.target)),
      };
    }

    const values = await dns.resolveCname(record.host);
    return {
      ...record,
      values,
      ok: values.some((value) => normalizeDnsValue(value) === normalizeDnsValue(record.target)),
    };
  } catch {
    return { ...record, values: [], ok: false };
  }
}

async function printLandingDnsStatus() {
  const results = await Promise.all(expectedLandingDns.map(resolveExpectedRecord));
  console.error('DNS status for landing cutover:');
  for (const result of results) {
    const current = result.values.length ? result.values.join(' | ') : 'missing';
    const status = result.ok ? 'OK' : 'FAIL';
    console.error(`${status} ${result.host} ${result.type} expected ${result.target}; current ${current}`);
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    console.error('');
    console.error('Namecheap Advanced DNS:');
    console.error(namecheapUrl);
  }

  const replacements = failures.filter((result) => result.values.length);
  if (replacements.length > 0) {
    console.error('');
    console.error('Replace these current records:');
    for (const result of replacements) {
      console.error(`${result.type}\t${namecheapHost(result.host)}\tcurrent ${result.values.join(' | ')}\t-> expected ${result.target}`);
    }
  }

  const missing = failures.filter((result) => result.values.length === 0);
  if (missing.length > 0) {
    console.error('');
    console.error('Add these missing records:');
    for (const result of missing) {
      console.error(`${result.type}\t${namecheapHost(result.host)}\t${result.target}`);
    }
  }
}

let response;
try {
  response = await fetch(endpoint, {
    headers: { Accept: 'application/json' },
  });
} catch (error) {
  console.error(`FAIL could not reach ${endpoint}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

let payload = {};
let rawBody = '';
try {
  rawBody = await response.text();
  payload = JSON.parse(rawBody);
} catch {
  const contentType = String(response.headers.get('content-type') || 'unknown');
  console.error(`FAIL ${endpoint} did not return JSON`);
  console.error(`content-type=${contentType}`);
  console.error(rawBody.slice(0, 300));
  if (/text\/html/i.test(contentType) && /<html/i.test(rawBody)) {
    const railwayFallback = 'https://smirk-landing-web-production.up.railway.app/api/first-dollar-readiness';
    try {
      const fallbackRes = await fetch(railwayFallback, { headers: { Accept: 'application/json' } });
      const fallbackPayload = await fallbackRes.json();
      if (fallbackRes.ok && fallbackPayload?.checkoutReady) {
        console.error(`Diagnosis: landing service is healthy at ${railwayFallback}; production domain DNS is still routing ${baseUrl} to the static/old host.`);
        await printLandingDnsStatus();
        console.error('Current action required: complete the Namecheap DNS cutover for smirkcalls.com and www.smirkcalls.com.');
      }
    } catch {
      // Keep the primary failure concise if the fallback probe also fails.
    }
  }
  process.exit(1);
}

const missing = Array.isArray(payload?.missing)
  ? payload.missing.filter((value) => typeof value === 'string' && value.trim().length > 0)
  : [];
const checkoutReady = Boolean(payload?.checkoutReady);

console.log(`Live landing readiness @ ${endpoint}`);
console.log(`HTTP ${response.status}`);
console.log(`checkoutReady=${checkoutReady}`);
if (missing.length) console.log(`missing=${missing.join(', ')}`);

if (!response.ok || !checkoutReady) {
  console.error(`FAIL landing readiness is not green (${response.status})`);
  process.exit(1);
}

console.log('OK live landing readiness is green');
