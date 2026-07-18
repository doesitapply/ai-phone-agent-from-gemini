#!/usr/bin/env node
import dns from 'node:dns/promises';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const copyToClipboard = process.argv.includes('--copy');
const openNamecheap = process.argv.includes('--open');
const writeRunbook = process.argv.includes('--write-runbook');
const writeJson = process.argv.includes('--write-json');
const jsonOutput = process.argv.includes('--json');
const authoritative = process.argv.includes('--authoritative');
const railwayFetchTimeoutMs = Number(process.env.SMIRK_DOMAIN_CUTOVER_RAILWAY_FETCH_TIMEOUT_MS || 15_000);
const railwayFetchAttempts = Number(process.env.SMIRK_DOMAIN_CUTOVER_RAILWAY_FETCH_ATTEMPTS || 2);
const railwayFetchRetryDelayMs = Number(process.env.SMIRK_DOMAIN_CUTOVER_RAILWAY_FETCH_RETRY_DELAY_MS || 750);

let expectedRecords = [
  { host: 'smirkcalls.com', type: 'CNAME', target: 'baq4ix5l.up.railway.app' },
  { host: 'www.smirkcalls.com', type: 'CNAME', target: '1i23mirh.up.railway.app' },
  { host: '_railway-verify.smirkcalls.com', type: 'TXT', target: 'railway-verify=47f70718a5d826f1c325d711cae423347256e210d90be5c2b488cf4c19191c9b' },
  { host: '_railway-verify.www.smirkcalls.com', type: 'TXT', target: 'railway-verify=92b3a65c7ab24f74a8aa9aabcd3b9704b17ae1075d969cb799bda04101a034ae' },
];
let expectedRecordsSource = 'checked-in fallback';
const keepRecords = [
  { host: 'resend._domainkey.smirkcalls.com', type: 'TXT' },
  { host: 'send.smirkcalls.com', type: 'TXT' },
  { host: 'send.smirkcalls.com', type: 'MX' },
];

const namecheapUrl = 'https://ap.www.namecheap.com/domains/domaincontrolpanel/smirkcalls.com/advancedns';
let recordRows = [
  { type: 'CNAME', host: '@', value: 'baq4ix5l.up.railway.app', ttl: 'Automatic' },
  { type: 'CNAME', host: 'www', value: '1i23mirh.up.railway.app', ttl: 'Automatic' },
  { type: 'TXT', host: '_railway-verify', value: 'railway-verify=47f70718a5d826f1c325d711cae423347256e210d90be5c2b488cf4c19191c9b', ttl: 'Automatic' },
  { type: 'TXT', host: '_railway-verify.www', value: 'railway-verify=92b3a65c7ab24f74a8aa9aabcd3b9704b17ae1075d969cb799bda04101a034ae', ttl: 'Automatic' },
];

function stripWrappingQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function readEnvFile(filePath) {
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

function railwayToken() {
  if (process.env.RAILWAY_API_TOKEN) return process.env.RAILWAY_API_TOKEN;
  if (process.env.RAILWAY_TOKEN) return process.env.RAILWAY_TOKEN;

  const envFiles = [
    path.join(os.homedir(), '.openclaw', 'workspace', '.env.operator'),
    path.join(os.homedir(), '.openclaw', 'workspace', '.env.smirk'),
    path.join(os.homedir(), '.openclaw', 'workspace', '.env'),
  ];
  const fileEnv = Object.assign({}, ...envFiles.map(readEnvFile));
  return fileEnv.RAILWAY_API_TOKEN || fileEnv.RAILWAY_TOKEN || '';
}

function railwayRecordType(value) {
  if (value === 'DNS_RECORD_TYPE_CNAME') return 'CNAME';
  if (value === 'DNS_RECORD_TYPE_TXT') return 'TXT';
  return value.replace(/^DNS_RECORD_TYPE_/, '');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeFetchError(error) {
  if (error?.name === 'AbortError') {
    return `Timed out after ${railwayFetchTimeoutMs}ms`;
  }
  return error?.message || String(error);
}

async function fetchRailwayGraphql(body, token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), railwayFetchTimeoutMs);
  try {
    return await fetch('https://backboard.railway.app/graphql/v2', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRailwayGraphqlWithRetry(body, token) {
  let lastError = null;
  for (let attempt = 1; attempt <= railwayFetchAttempts; attempt += 1) {
    try {
      return { response: await fetchRailwayGraphql(body, token), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < railwayFetchAttempts) {
        await sleep(railwayFetchRetryDelayMs);
      }
    }
  }

  return {
    error: lastError,
    attempts: railwayFetchAttempts,
    detail: normalizeFetchError(lastError),
  };
}

function verificationHostLabel(domain) {
  if (domain === 'smirkcalls.com') return '_railway-verify';
  if (domain.endsWith('.smirkcalls.com')) return `_railway-verify.${domain.replace(/\.smirkcalls\.com$/, '')}`;
  return '_railway-verify';
}

async function loadRailwayExpectedRecords() {
  const token = railwayToken();
  if (!token) return;

  const query = `
    query DomainStatus($id: String!) {
      project(id: $id) {
        environments {
          edges {
            node {
              name
              serviceInstances {
                edges {
                  node {
                    serviceName
                    domains {
                      customDomains {
                        domain
                        status {
                          verificationDnsHost
                          verificationToken
                          dnsRecords {
                            fqdn
                            hostlabel
                            recordType
                            requiredValue
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const fetched = await fetchRailwayGraphqlWithRetry(JSON.stringify({
      query,
      variables: { id: '90599f03-6d6f-4044-8933-e0301be67a82' },
    }), token);
  if (!fetched.response) {
    console.error(JSON.stringify({
      ok: false,
      warning: 'domain-cutover-railway-fetch-failed',
      message: 'Could not load live Railway custom-domain records after bounded retries; using checked-in DNS fallback.',
      attempts: fetched.attempts,
      detail: fetched.detail,
    }, null, 2));
    return;
  }

  const { response } = fetched;
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) return;

  const edges = payload?.data?.project?.environments?.edges || [];
  const service = edges
    .flatMap((edge) => edge?.node?.serviceInstances?.edges || [])
    .map((edge) => edge?.node)
    .find((node) => node?.serviceName === 'ai-phone-agent');
  const domains = service?.domains?.customDomains || [];
  const records = [];

  for (const domain of domains.filter((item) => ['smirkcalls.com', 'www.smirkcalls.com'].includes(item?.domain))) {
    const traffic = domain.status?.dnsRecords?.find((record) => record?.requiredValue);
    if (traffic) {
      records.push({
        host: traffic.fqdn || domain.domain,
        type: railwayRecordType(traffic.recordType),
        target: traffic.requiredValue,
      });
    }

    if (domain.status?.verificationToken) {
      const hostLabel = domain.status.verificationDnsHost || verificationHostLabel(domain.domain);
      records.push({
        host: `${hostLabel}.smirkcalls.com`,
        type: 'TXT',
        target: domain.status.verificationToken,
      });
    }
  }

  if (records.length < 4) return;
  expectedRecords = records.sort((a, b) => a.host.localeCompare(b.host) || a.type.localeCompare(b.type));
  recordRows = expectedRecords.map((record) => ({
    type: record.type,
    host: namecheapHost(record.host),
    value: record.target,
    ttl: 'Automatic',
  }));
  expectedRecordsSource = 'Railway GraphQL live custom-domain status';
}

function namecheapHost(host) {
  return host
    .replace(/\.smirkcalls\.com$/, '')
    .replace(/^smirkcalls\.com$/, '@');
}

function fullRecordTable() {
  return [
    ['Type', 'Host', 'Value', 'TTL'].join('\t'),
    ...recordRows.map((row) => [row.type, row.host, row.value, row.ttl].join('\t')),
  ].join('\n');
}

function clipboardHandoff(results) {
  const lines = [
    'SMIRK Namecheap DNS cutover',
    '',
    namecheapUrl,
    '',
  ];

  const replacements = results.filter((result) => !result.ok && result.values.length);
  if (replacements.length > 0) {
    lines.push('Replace these current records:');
    for (const result of replacements) {
      lines.push(`${result.type}\t${namecheapHost(result.host)}\tcurrent ${result.values.join(' | ')}\t-> expected ${result.target}`);
    }
    lines.push('');
  }

  const missing = results.filter((result) => !result.ok && result.values.length === 0);
  if (missing.length > 0) {
    lines.push('Add these missing records:');
    for (const result of missing) {
      lines.push(`${result.type}\t${namecheapHost(result.host)}\t${result.target}`);
    }
    lines.push('');
  }

  lines.push('Final desired records:');
  lines.push(fullRecordTable());
  return lines.join('\n');
}

function markdownRunbook(results, keepResults = []) {
  const replacements = results.filter((result) => !result.ok && result.values.length);
  const missing = results.filter((result) => !result.ok && result.values.length === 0);
  const lines = [
    '# SMIRK domain cutover click path',
    '',
    '## Highest-leverage blocker',
    'Namecheap DNS for `smirkcalls.com` still points public traffic to Manus, so `https://smirkcalls.com/api/first-dollar-readiness` returns the static landing HTML instead of the Railway landing API.',
    '',
    '## Open',
    `\`${namecheapUrl}\``,
    '',
  ];

  if (replacements.length > 0) {
    lines.push('## Replace');
    replacements.forEach((result, index) => {
      lines.push(`${index + 1}. Host \`${namecheapHost(result.host)}\``);
      lines.push(`   - Current: \`${result.type}\` -> \`${result.values.join(' | ')}\``);
      lines.push(`   - Set to: \`${result.type}\` -> \`${result.target}\``);
      lines.push('   - TTL: `Automatic`');
      lines.push('');
    });
  }

  if (missing.length > 0) {
    lines.push('## Add');
    missing.forEach((result, index) => {
      lines.push(`${index + 1}. Host \`${namecheapHost(result.host)}\``);
      lines.push(`   - Type: \`${result.type}\``);
      lines.push(`   - Value: \`${result.target}\``);
      lines.push('   - TTL: `Automatic`');
      lines.push('');
    });
  }

  lines.push('## Keep');
  if (keepResults.length > 0) {
    for (const result of keepResults) {
      const value = result.values.length ? result.values.join(' | ') : 'missing';
      lines.push(`- \`${result.type}\` host \`${namecheapHost(result.host)}\` -> \`${value}\``);
    }
  } else {
    lines.push('- `TXT` host `resend._domainkey`');
    lines.push('- `TXT` host `send`');
    lines.push('- `MX` host `send`');
  }
  lines.push('');
  lines.push('## Automation option');
  lines.push('Use this only if Namecheap API access is enabled and the current machine IP is allowlisted.');
  lines.push('Do not paste raw Namecheap API secrets into chat or committed files.');
  lines.push('');
  lines.push('```bash');
  lines.push('cd /Users/cameronchurch/OpenClaw/workspace/ai-phone-agent-from-gemini');
  lines.push('npm run -s write:namecheap-api-request');
  lines.push('# Store missing NAMECHEAP_* values with scripts/set-operator-secret.sh, then:');
  lines.push('npm run -s prepare:domain-cutover:finish-wait');
  lines.push('```');
  lines.push('');
  lines.push('Credential request file: `/Users/cameronchurch/.openclaw/workspace/output/namecheap-api-credential-request.md`');
  lines.push('');
  lines.push('## Verify');
  lines.push('```bash');
  lines.push('cd /Users/cameronchurch/OpenClaw/workspace/ai-phone-agent-from-gemini');
  lines.push('npm run -s check:domain-cutover:authoritative');
  lines.push('npm run -s wait:domain-cutover');
  lines.push('```');
  lines.push('');
  lines.push('## Success condition');
  for (const row of recordRows) {
    lines.push(`- \`${row.host}\` ${row.type} resolves to \`${row.value}\``);
  }
  lines.push('- `/api/first-dollar-readiness` returns JSON with `checkoutReady=true`, `activationReady=true`, and `firstDollarReady=true`');
  lines.push('');

  return lines.join('\n');
}

async function writeCutoverRunbook(results, resolver) {
  const outPath = path.join(os.homedir(), '.openclaw', 'workspace', 'output', 'smirk-domain-cutover-click-path.md');
  const keepResults = await Promise.all(keepRecords.map((record) => resolveKeepRecord(record, resolver)));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, markdownRunbook(results, keepResults));
  console.error(`Wrote DNS cutover runbook: ${outPath}`);
}

function cutoverPayload(results, keepResults, resolverInfo) {
  const failed = results.filter((result) => !result.ok);
  return {
    ok: failed.length === 0,
    namecheapUrl,
    resolver: {
      source: resolverInfo.source,
      nameservers: resolverInfo.nameservers,
    },
    records: results.map((result) => ({
      host: result.host,
      namecheapHost: namecheapHost(result.host),
      type: result.type,
      expected: result.target,
      current: result.values,
      ok: result.ok,
      action: result.ok ? 'keep' : result.values.length > 0 ? 'replace' : 'add',
    })),
    keepRecords: keepResults.map((result) => ({
      host: result.host,
      namecheapHost: namecheapHost(result.host),
      type: result.type,
      current: result.values,
      ok: result.values.length > 0,
      action: 'preserve',
    })),
  };
}

async function writeCutoverJson(results, resolver, resolverInfo) {
  const outPath = path.join(os.homedir(), '.openclaw', 'workspace', 'output', 'smirk-domain-cutover.json');
  const keepResults = await Promise.all(keepRecords.map((record) => resolveKeepRecord(record, resolver)));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(cutoverPayload(results, keepResults, resolverInfo), null, 2)}\n`);
  console.error(`Wrote DNS cutover JSON: ${outPath}`);
}

function copyRecordTable(results) {
  const copied = spawnSync('pbcopy', { input: clipboardHandoff(results), encoding: 'utf8' });
  if (copied.status === 0) {
    console.error('Copied Namecheap DNS cutover checklist to clipboard.');
    return;
  }

  console.error('WARN could not copy DNS records to clipboard; pbcopy was unavailable or failed.');
}

function openNamecheapDns() {
  const opened = spawnSync('open', [namecheapUrl], { encoding: 'utf8' });
  if (opened.status === 0) {
    console.error('Opened Namecheap Advanced DNS page.');
    return;
  }

  console.error('WARN could not open Namecheap Advanced DNS page automatically.');
}

function normalize(value) {
  return String(value || '').trim().replace(/\.$/, '').toLowerCase();
}

async function buildResolver() {
  if (!authoritative) return { resolver: dns, source: 'system', nameservers: [] };

  let nameservers = [];
  try {
    nameservers = await dns.resolveNs('smirkcalls.com');
  } catch (error) {
    console.error(`WARN could not resolve authoritative NS records for smirkcalls.com (${error?.code || error?.message || 'unknown error'}); using system resolver.`);
    return { resolver: dns, source: 'system-fallback', nameservers: [] };
  }
  const addresses = [];
  for (const nameserver of nameservers) {
    try {
      const { address } = await dns.lookup(nameserver);
      addresses.push(address);
    } catch {
      // Try the remaining authoritative nameservers.
    }
  }

  if (addresses.length === 0) {
    console.error('WARN could not resolve authoritative nameserver addresses; using system resolver.');
    return { resolver: dns, source: 'system-fallback', nameservers };
  }

  const resolver = new dns.Resolver();
  resolver.setServers(addresses);
  console.error(`Using authoritative nameservers for smirkcalls.com: ${nameservers.join(', ')}`);
  return { resolver, source: 'authoritative', nameservers };
}

async function resolveRecord(record, resolver) {
  try {
    if (record.type === 'TXT') {
      const values = (await resolver.resolveTxt(record.host)).map((chunks) => chunks.join(''));
      return {
        ...record,
        values,
        ok: values.some((value) => normalize(value) === normalize(record.target)),
      };
    }

    const values = await resolver.resolveCname(record.host);
    return {
      ...record,
      values,
      ok: values.some((value) => normalize(value) === normalize(record.target)),
    };
  } catch {
    return { ...record, values: [], ok: false };
  }
}

async function resolveKeepRecord(record, resolver) {
  try {
    if (record.type === 'TXT') {
      const values = (await resolver.resolveTxt(record.host)).map((chunks) => chunks.join(''));
      return { ...record, values };
    }

    if (record.type === 'MX') {
      const values = (await resolver.resolveMx(record.host)).map((value) => `${value.priority} ${normalize(value.exchange)}`);
      return { ...record, values };
    }
  } catch {
    return { ...record, values: [] };
  }

  return { ...record, values: [] };
}

await loadRailwayExpectedRecords();
const resolverInfo = await buildResolver();
const { resolver } = resolverInfo;
const results = await Promise.all(expectedRecords.map((record) => resolveRecord(record, resolver)));
let failures = 0;

if (jsonOutput) {
  const failed = results.filter((result) => !result.ok);
  const keepResults = await Promise.all(keepRecords.map((record) => resolveKeepRecord(record, resolver)));
  console.log(JSON.stringify(cutoverPayload(results, keepResults, resolverInfo), null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
}

console.log('SMIRK landing domain cutover');
console.log(`Expected records source: ${expectedRecordsSource}`);
for (const result of results) {
  const current = result.values.length ? result.values.join(' | ') : 'missing';
  if (result.ok) {
    console.log(`OK ${result.host} ${result.type} -> ${result.target}`);
  } else {
    failures += 1;
    console.error(`FAIL ${result.host} ${result.type} expected ${result.target}; current ${current}`);
  }
}

if (failures > 0) {
  if (copyToClipboard) copyRecordTable(results);
  if (openNamecheap) openNamecheapDns();
  if (writeRunbook) await writeCutoverRunbook(results, resolver);
  if (writeJson) await writeCutoverJson(results, resolver, resolverInfo);
  console.error('');
  console.error('Namecheap Advanced DNS:');
  console.error(namecheapUrl);
  console.error('');
  console.error('Replace these current records:');
  for (const result of results.filter((result) => !result.ok && result.values.length)) {
    console.error(`${result.type}\t${namecheapHost(result.host)}\tcurrent ${result.values.join(' | ')}\t-> expected ${result.target}`);
  }
  const missing = results.filter((result) => !result.ok && result.values.length === 0);
  if (missing.length > 0) {
    console.error('');
    console.error('Add these missing records:');
    for (const result of missing) {
      console.error(`${result.type}\t${namecheapHost(result.host)}\t${result.target}`);
    }
  }
  console.error('');
  console.error('Add/replace these records:');
  for (const row of recordRows) {
    console.error(`${row.type}\t${row.host}\t${row.value}\tTTL=${row.ttl}`);
  }
  console.error('');
  console.error('Current action required: update Namecheap DNS for smirkcalls.com and www.smirkcalls.com to the Railway records above.');
  process.exit(1);
}

console.log('OK smirkcalls.com landing DNS is cut over to Railway');
