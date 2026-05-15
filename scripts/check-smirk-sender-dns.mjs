#!/usr/bin/env node
import dns from 'node:dns/promises';

const checks = [
  {
    label: 'DKIM TXT',
    host: 'resend._domainkey.smirkcalls.com',
    type: 'TXT',
    expected: 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC0edc1B1uu/AYprgFJ/7/aTkb5yd5fUvz0sLNnBR7Gf+BKQjZH1yg81+u2iUx5a4LXLozYbdg2lVhaZMj5xxysAU6KiouZnNhWIAElPxQfmwIutQ5fB/pSBfRRU6Ej+VM0Ye/+GVqffn3iqifVPIlbN/Ulfhv8VVymhZt6EszPMQIDAQAB',
  },
  {
    label: 'Send MX',
    host: 'send.smirkcalls.com',
    type: 'MX',
    expectedExchange: 'feedback-smtp.us-east-1.amazonses.com',
    expectedPriority: 10,
  },
  {
    label: 'Send SPF TXT',
    host: 'send.smirkcalls.com',
    type: 'TXT',
    expected: 'v=spf1 include:amazonses.com ~all',
  },
];

let failures = 0;

for (const check of checks) {
  try {
    if (check.type === 'TXT') {
      const rows = await dns.resolveTxt(check.host);
      const values = rows.map(parts => parts.join(''));
      const ok = values.includes(check.expected);
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${check.label} ${check.host}`);
      if (!ok) {
        failures += 1;
        console.log(`  expected: ${check.expected}`);
        console.log(`  got: ${values.length ? values.join(' | ') : 'none'}`);
      }
    } else if (check.type === 'MX') {
      const rows = await dns.resolveMx(check.host);
      const ok = rows.some(r => r.exchange.replace(/\.$/, '') === check.expectedExchange && Number(r.priority) === check.expectedPriority);
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${check.label} ${check.host}`);
      if (!ok) {
        failures += 1;
        const got = rows.map(r => `${r.exchange.replace(/\.$/, '')} priority=${r.priority}`).join(' | ') || 'none';
        console.log(`  expected: ${check.expectedExchange} priority=${check.expectedPriority}`);
        console.log(`  got: ${got}`);
      }
    }
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${check.label} ${check.host}`);
    console.log(`  ${error.code || error.message}`);
  }
}

if (failures > 0) {
  console.error(`\nFAIL smirkcalls.com sender DNS incomplete (${failures} issue${failures === 1 ? '' : 's'})`);
  process.exit(1);
}

console.log('\nOK smirkcalls.com sender DNS is live');
