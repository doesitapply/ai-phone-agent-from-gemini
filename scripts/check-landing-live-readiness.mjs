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
const fetchTimeoutMs = Number(process.env.SMIRK_LANDING_READINESS_FETCH_TIMEOUT_MS || 15000);
const fetchAttempts = Number(process.env.SMIRK_LANDING_READINESS_FETCH_ATTEMPTS || 2);
const fetchRetryDelayMs = Number(process.env.SMIRK_LANDING_READINESS_FETCH_RETRY_DELAY_MS || 750);

if (!baseUrl) {
  console.error('Usage: LANDING_APP_URL=https://smirkcalls.com node scripts/check-landing-live-readiness.mjs');
  process.exit(1);
}

const endpoint = `${baseUrl}/api/first-dollar-readiness`;
const expectedLandingDns = [
  { host: 'smirkcalls.com', type: 'CNAME', target: 'baq4ix5l.up.railway.app' },
  { host: 'www.smirkcalls.com', type: 'CNAME', target: '1i23mirh.up.railway.app' },
  { host: '_railway-verify.smirkcalls.com', type: 'TXT', target: 'railway-verify=47f70718a5d826f1c325d711cae423347256e210d90be5c2b488cf4c19191c9b' },
  { host: '_railway-verify.www.smirkcalls.com', type: 'TXT', target: 'railway-verify=92b3a65c7ab24f74a8aa9aabcd3b9704b17ae1075d969cb799bda04101a034ae' },
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeFetchError(error) {
  if (error?.name === 'AbortError') {
    return `fetch timed out after ${fetchTimeoutMs}ms`;
  }
  return String(error?.message || error || 'unknown fetch error');
}

async function fetchTextWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithRetry(url) {
  let lastError = null;
  const attempts = Math.max(1, fetchAttempts);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await fetchTextWithTimeout(url);
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(fetchRetryDelayMs);
      }
    }
  }
  return {
    error: 'landing-readiness-fetch-failed',
    detail: normalizeFetchError(lastError),
    attempts,
  };
}

const readinessResult = await fetchTextWithRetry(endpoint);
if (readinessResult.error) {
  console.error(`FAIL could not reach ${endpoint}`);
  console.error(JSON.stringify(readinessResult, null, 2));
  await printLandingDnsStatus();
  process.exit(1);
}

let payload = {};
const response = readinessResult.response;
const rawBody = readinessResult.text;
try {
  payload = JSON.parse(rawBody);
} catch {
  const contentType = String(response.headers.get('content-type') || 'unknown');
  console.error(`FAIL ${endpoint} did not return JSON`);
  console.error(`content-type=${contentType}`);
  console.error(rawBody.slice(0, 300));
  if (/text\/html/i.test(contentType) && /<html/i.test(rawBody)) {
    const railwayFallback = 'https://smirk-landing-web-production.up.railway.app/api/first-dollar-readiness';
    const fallbackResult = await fetchTextWithRetry(railwayFallback);
    if (fallbackResult.error) {
      console.error(JSON.stringify({
        ok: false,
        error: fallbackResult.error,
        detail: fallbackResult.detail,
        attempts: fallbackResult.attempts,
      }, null, 2));
      process.exit(1);
    }
    try {
      const fallbackPayload = JSON.parse(fallbackResult.text);
      if (fallbackResult.response?.ok && fallbackPayload?.checkoutReady) {
        console.error(`Diagnosis: landing service is healthy at ${railwayFallback}; production domain DNS is still routing ${baseUrl} to the static/old host.`);
        await printLandingDnsStatus();
        console.error('Current action required: complete the Namecheap DNS cutover for smirkcalls.com and www.smirkcalls.com.');
      }
    } catch (error) {
      // Keep the primary failure concise if the fallback probe also fails.
      console.error(JSON.stringify({
        ok: false,
        error: fallbackResult.error || 'landing-readiness-fallback-invalid-json',
        detail: fallbackResult.detail || normalizeFetchError(error),
        attempts: fallbackResult.attempts || 0,
      }, null, 2));
    }
  }
  process.exit(1);
}

const missing = Array.isArray(payload?.missing)
  ? payload.missing.filter((value) => typeof value === 'string' && value.trim().length > 0)
  : [];
const checkoutReady = Boolean(payload?.checkoutReady);
const activationReady = Boolean(payload?.activationReady);
const firstDollarReady = Boolean(payload?.firstDollarReady)
  && checkoutReady
  && activationReady
  && payload?.activationMode === 'automatic';

console.log(`Live landing readiness @ ${endpoint}`);
console.log(`HTTP ${response.status}`);
console.log(`attempts=${readinessResult.attempts}`);
console.log(`checkoutReady=${checkoutReady}`);
console.log(`activationReady=${activationReady}`);
console.log(`activationMode=${String(payload?.activationMode || 'unknown')}`);
console.log(`firstDollarReady=${firstDollarReady}`);
if (missing.length) console.log(`missing=${missing.join(', ')}`);

if (!response.ok || !firstDollarReady) {
  console.error(`FAIL landing readiness is not green (${response.status})`);
  process.exit(1);
}

console.log('OK live landing readiness is green');
