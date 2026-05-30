#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const writeRequest = process.argv.includes('--write-request');
const requestPath = path.join(os.homedir(), '.openclaw', 'workspace', 'output', 'namecheap-api-credential-request.md');
const namecheapApiPage = 'https://ap.www.namecheap.com/settings/tools/apiaccess/';
const namecheapDnsPage = 'https://ap.www.namecheap.com/domains/domaincontrolpanel/smirkcalls.com/advancedns';
const envFiles = [
  path.join(os.homedir(), '.openclaw', 'workspace', '.env.operator'),
  path.join(os.homedir(), '.openclaw', 'workspace', '.env.smirk'),
  '.env.local',
];
const required = ['NAMECHEAP_API_USER', 'NAMECHEAP_API_KEY', 'NAMECHEAP_USERNAME', 'NAMECHEAP_CLIENT_IP'];

async function detectPublicIp() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch('https://api.ipify.org', { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return '';
    const ip = (await res.text()).trim();
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : '';
  } catch {
    return '';
  }
}

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

const fileEnv = Object.assign({}, ...envFiles.map(parseEnvFile));
const values = Object.fromEntries(required.map((key) => [key, String(process.env[key] || fileEnv[key] || '').trim()]));
const detectedPublicIp = await detectPublicIp();

console.log('Namecheap API automation readiness');
for (const key of required) {
  console.log(`${values[key] ? 'OK  ' : 'MISS'} ${key}`);
}
if (!values.NAMECHEAP_CLIENT_IP && detectedPublicIp) {
  console.log(`INFO detected current public IP for Namecheap whitelist: ${detectedPublicIp}`);
}
if (values.NAMECHEAP_CLIENT_IP && detectedPublicIp && values.NAMECHEAP_CLIENT_IP !== detectedPublicIp) {
  console.log(`WARN NAMECHEAP_CLIENT_IP is ${values.NAMECHEAP_CLIENT_IP}, but current public IP is ${detectedPublicIp}`);
  console.log('WARN Namecheap API calls may fail unless the stored client IP is allowlisted and this is the same outbound network.');
}

const missing = required.filter((key) => !values[key]);
if (missing.length > 0) {
  if (writeRequest) {
    fs.mkdirSync(path.dirname(requestPath), { recursive: true });
    fs.writeFileSync(requestPath, [
      '# Namecheap API credential request',
      '',
      '## Why this is needed',
      'SMIRK landing DNS is still pointed at Manus. These credentials are required only if DNS cutover should be automated instead of completed manually in Namecheap Advanced DNS.',
      '',
      '## Missing values',
      ...missing.map((key) => `- \`${key}\``),
      '',
      '## Approval boundary',
      'Creating/enabling Namecheap API credentials or applying DNS records changes live infrastructure. Do not paste raw API secrets into chat. Store them with `scripts/set-operator-secret.sh` or apply the DNS records manually in Namecheap.',
      '',
      '## Where to get or apply them',
      `- Namecheap API access: ${namecheapApiPage}`,
      `- Manual Advanced DNS cutover: ${namecheapDnsPage}`,
      ...(missing.includes('NAMECHEAP_CLIENT_IP') && detectedPublicIp ? [
        '',
        '## Detected client IP',
        `Use \`${detectedPublicIp}\` for \`NAMECHEAP_CLIENT_IP\` if this machine/network is the one that will run the Namecheap API cutover.`,
      ] : []),
      '',
      '## Setup commands',
      '```bash',
      ...missing.map((key) => {
        const placeholder = key === 'NAMECHEAP_CLIENT_IP' && detectedPublicIp ? detectedPublicIp : `<${key.toLowerCase()}>`;
        return `SECRET_VALUE='${placeholder}' bash scripts/set-operator-secret.sh ${key} operator`;
      }),
      '```',
      '',
      '## Verify',
      '```bash',
      'npm run -s check:namecheap-api-env',
      'CONFIRM_NAMECHEAP_DNS_CUTOVER=smirkcalls.com npm run -s prepare:domain-cutover:finish-wait',
      'npm run -s wait:domain-cutover',
      '```',
      '',
    ].join('\n'));
    console.error(`Wrote Namecheap API credential request: ${requestPath}`);
  }

  console.error('');
  console.error(`FAIL Namecheap API credentials are incomplete: ${missing.join(', ')}`);
  console.error('Current action required: add the missing NAMECHEAP_* values via scripts/set-operator-secret.sh, or complete the DNS cutover manually in Namecheap Advanced DNS.');
  console.error(`Namecheap API access: ${namecheapApiPage}`);
  console.error(`Manual Advanced DNS: ${namecheapDnsPage}`);
  console.error('');
  console.error('Credential setup commands:');
  for (const key of missing) {
    const placeholder = key === 'NAMECHEAP_CLIENT_IP' && detectedPublicIp ? detectedPublicIp : `<${key.toLowerCase()}>`;
    console.error(`SECRET_VALUE='${placeholder}' bash scripts/set-operator-secret.sh ${key} operator`);
  }
  console.error('');
  console.error('After credentials are present, rerun: npm run -s check:namecheap-api-env');
  console.error('After explicit approval to change live DNS, apply with: CONFIRM_NAMECHEAP_DNS_CUTOVER=smirkcalls.com npm run -s prepare:domain-cutover:finish-wait');
  process.exit(1);
}

console.log('OK Namecheap API credentials are present for DNS automation');
