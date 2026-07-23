#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUTHORITATIVE_LANDING_ORIGIN,
  evaluateLegacyLandingBootstrapReadiness,
} from './lib/legacy-landing-bootstrap-readiness.mjs';

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
const fetchTimeoutMs = Number(process.env.SMIRK_LANDING_READINESS_FETCH_TIMEOUT_MS || 15000);
const fetchAttempts = Math.max(1, Number(process.env.SMIRK_LANDING_READINESS_FETCH_ATTEMPTS || 2));
const fetchRetryDelayMs = Number(process.env.SMIRK_LANDING_READINESS_FETCH_RETRY_DELAY_MS || 750);

let parsedBaseUrl = null;
try {
  parsedBaseUrl = new URL(rawBaseUrl);
} catch {
  // The evaluator emits the fail-closed diagnosis below.
}

const origin = parsedBaseUrl?.origin || rawBaseUrl;
const hasOnlyOrigin = parsedBaseUrl
  && (parsedBaseUrl.pathname === '/' || parsedBaseUrl.pathname === '')
  && !parsedBaseUrl.search
  && !parsedBaseUrl.hash;

if (!hasOnlyOrigin || origin !== AUTHORITATIVE_LANDING_ORIGIN) {
  const evaluation = evaluateLegacyLandingBootstrapReadiness({
    origin: hasOnlyOrigin ? origin : rawBaseUrl,
    status: 0,
    contentType: '',
    payload: null,
  });
  console.error(JSON.stringify(evaluation, null, 2));
  process.exit(1);
}

const endpoint = `${AUTHORITATIVE_LANDING_ORIGIN}/api/first-dollar-readiness`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchReadiness() {
  let lastError = null;
  for (let attempt = 1; attempt <= fetchAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      const response = await fetch(endpoint, {
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-cache',
        },
        signal: controller.signal,
      });
      const text = await response.text();
      return { response, text, attempt };
    } catch (error) {
      lastError = error;
      if (attempt < fetchAttempts) await sleep(fetchRetryDelayMs);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('unknown readiness fetch failure');
}

let result;
try {
  result = await fetchReadiness();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    mode: 'exact-legacy-landing-readiness-bootstrap',
    origin: AUTHORITATIVE_LANDING_ORIGIN,
    failures: [error?.name === 'AbortError'
      ? `readiness fetch timed out after ${fetchTimeoutMs}ms`
      : 'readiness fetch failed'],
  }, null, 2));
  process.exit(1);
}

let payload = null;
try {
  payload = JSON.parse(result.text);
} catch {
  payload = null;
}

const evaluation = evaluateLegacyLandingBootstrapReadiness({
  origin: AUTHORITATIVE_LANDING_ORIGIN,
  status: result.response.status,
  contentType: result.response.headers.get('content-type'),
  payload,
});

console.log(JSON.stringify({
  ...evaluation,
  endpoint,
  attempts: result.attempt,
}, null, 2));
if (!evaluation.ok) process.exit(1);
