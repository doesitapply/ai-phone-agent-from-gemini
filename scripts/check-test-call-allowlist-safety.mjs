#!/usr/bin/env node
import fs from 'node:fs';

const files = {
  setter: 'scripts/set-test-call-allowlist.sh',
  checker: 'scripts/check-railway-test-call-allowlist.mjs',
};

const setter = fs.readFileSync(files.setter, 'utf8');
const checker = fs.readFileSync(files.checker, 'utf8');
const failures = [];

if (!setter.includes('CONFIRM_SMIRK_ALLOWLIST_MUTATION') || !setter.includes('update-proof-call-allowlist')) {
  failures.push(`${files.setter}: missing explicit allowlist mutation confirmation gate`);
}

for (const [label, text] of Object.entries({ setter, checker })) {
  if (/\+15551234567/.test(text)) {
    failures.push(`${files[label]}: contains fake placeholder proof-call target`);
  }
  if (/railway variable set "COMPLIANCE_ALWAYS_ALLOW_NUMBERS=.*\$\{?target/i.test(text)) {
    failures.push(`${files[label]}: prints a raw allowlist mutation command`);
  }
  if (/"(?:target|value)":/.test(text)) {
    failures.push(`${files[label]}: may expose raw allowlist values in JSON output`);
  }
}

if (!setter.includes('maskedTarget') || !checker.includes('maskedTarget')) {
  failures.push('allowlist helper output must expose maskedTarget instead of raw phone numbers');
}

if (failures.length > 0) {
  console.error('FAIL test-call allowlist helper is not safe enough for Gate 4 proof work:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('OK test-call allowlist helpers require confirmation, avoid fake targets, and mask outputs');
