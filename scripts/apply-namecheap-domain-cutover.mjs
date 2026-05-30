#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const apply = process.argv.includes('--apply');
const sld = 'smirkcalls';
const tld = 'com';
const apiEndpoint = 'https://api.namecheap.com/xml.response';
const envFiles = [
  path.join(os.homedir(), '.openclaw', 'workspace', '.env.operator'),
  path.join(os.homedir(), '.openclaw', 'workspace', '.env.smirk'),
  '.env.local',
];
const required = ['NAMECHEAP_API_USER', 'NAMECHEAP_API_KEY', 'NAMECHEAP_USERNAME', 'NAMECHEAP_CLIENT_IP'];

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

function currentCutoverPayload() {
  const result = spawnSync('node', ['scripts/check-domain-cutover.mjs', '--authoritative', '--json'], {
    encoding: 'utf8',
  });
  if (!result.stdout.trim()) {
    throw new Error(`Could not build DNS payload: ${result.stderr || 'empty output'}`);
  }
  return JSON.parse(result.stdout);
}

function valueForRecord(record) {
  if (record.type === 'MX') {
    const [priority, ...exchange] = record.current[0].split(/\s+/);
    return { address: exchange.join(' '), mxPref: priority };
  }

  return { address: record.expected || record.current[0], mxPref: null };
}

function desiredHosts(payload) {
  const changeRecords = payload.records.map((record) => ({
    host: record.namecheapHost,
    type: record.type,
    address: record.expected,
    mxPref: null,
    ttl: '300',
  }));
  const keepRecords = payload.keepRecords.map((record) => {
    const value = valueForRecord(record);
    return {
      host: record.namecheapHost,
      type: record.type,
      address: value.address,
      mxPref: value.mxPref,
      ttl: '300',
    };
  });

  return [...changeRecords, ...keepRecords];
}

function buildParams(hosts, values) {
  const params = new URLSearchParams({
    ApiUser: values.NAMECHEAP_API_USER,
    ApiKey: values.NAMECHEAP_API_KEY,
    UserName: values.NAMECHEAP_USERNAME,
    ClientIp: values.NAMECHEAP_CLIENT_IP,
    Command: 'namecheap.domains.dns.setHosts',
    SLD: sld,
    TLD: tld,
  });

  hosts.forEach((record, index) => {
    const n = index + 1;
    params.set(`HostName${n}`, record.host);
    params.set(`RecordType${n}`, record.type);
    params.set(`Address${n}`, record.address);
    params.set(`TTL${n}`, record.ttl);
    if (record.mxPref) params.set(`MXPref${n}`, record.mxPref);
  });

  return params;
}

const fileEnv = Object.assign({}, ...envFiles.map(parseEnvFile));
const values = Object.fromEntries(required.map((key) => [key, String(process.env[key] || fileEnv[key] || '').trim()]));
const missing = required.filter((key) => !values[key]);
const payload = currentCutoverPayload();
const hosts = desiredHosts(payload);

console.log('Namecheap DNS setHosts payload');
for (const record of hosts) {
  const mx = record.mxPref ? ` pref=${record.mxPref}` : '';
  console.log(`${record.type}\t${record.host}\t${record.address}${mx}\tTTL=${record.ttl}`);
}

if (!apply) {
  console.log('');
  console.log('Dry run only. To apply after NAMECHEAP_* credentials are present: CONFIRM_NAMECHEAP_DNS_CUTOVER=smirkcalls.com npm run -s apply:domain-cutover -- --apply');
  process.exit(0);
}

if (missing.length > 0) {
  console.error('');
  console.error(`FAIL missing Namecheap API credentials: ${missing.join(', ')}`);
  process.exit(1);
}

if (process.env.CONFIRM_NAMECHEAP_DNS_CUTOVER !== 'smirkcalls.com') {
  console.error('');
  console.error('FAIL refusing to apply live Namecheap DNS without explicit confirmation.');
  console.error('Set CONFIRM_NAMECHEAP_DNS_CUTOVER=smirkcalls.com after approval, then rerun the apply command.');
  process.exit(1);
}

const response = await fetch(`${apiEndpoint}?${buildParams(hosts, values).toString()}`);
const body = await response.text();
if (!response.ok || !/Status="OK"/.test(body)) {
  console.error(`FAIL Namecheap setHosts did not succeed (HTTP ${response.status})`);
  console.error(body.slice(0, 1000));
  process.exit(1);
}

console.log('OK Namecheap setHosts accepted the SMIRK landing DNS cutover payload');
