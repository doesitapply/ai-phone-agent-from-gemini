#!/usr/bin/env node
import fs from 'node:fs';
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
