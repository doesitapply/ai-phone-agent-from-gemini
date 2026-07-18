#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

const proofGuides = [
  { file: 'README.md', requireSnippets: true },
  { file: 'FIRST_HUMAN_RUN.md', requireSnippets: true },
  { file: 'scripts/print-real-call-setup.mjs', requireSnippets: true },
];

const requiredSnippets = [
  'npm run check:real-call-readiness',
  'allowlistedTargetHints',
  'npm run check:real-call-readiness -- <safe-number>',
  'APPROVE_SMIRK_REAL_PROOF_CALL: <exact-approved-e164>',
  'CONFIRM_SMIRK_REAL_PROOF_CALL=place-one-smirk-real-proof-call',
  "CONFIRM_SMIRK_REAL_PROOF_CALL_TARGET='<exact-approved-e164>'",
  "npm run -s proof:real-call -- '<exact-approved-e164>'",
  'Readiness alone',
  'check:pre-proof-call-live',
  'PROOF_STARTED_AT',
  'PROOF_CALL_SID',
  'totalCalls',
  'summariesGenerated',
  'callbackTasksCreated',
  'ownerEmailAlertsSent',
  'completeProofCalls',
];

const bannedPatterns = [
  ['isolated real-call helper in proof docs', /\bcall:real-test\b/],
  ['placeholder phone number in proof docs', /\+15551234567/],
  ['env-first proof-call target setup', /\b(?:TEST_CALL_TO|TWILIO_TEST_TO|ALLOWLIST_TEST_NUMBER)=/],
  ['direct production allowlist mutation in proof docs', /\bCOMPLIANCE_ALWAYS_ALLOW_NUMBERS=/],
];

const failures = [];

for (const guide of proofGuides) {
  const fullPath = path.join(repoRoot, guide.file);
  if (!fs.existsSync(fullPath)) {
    failures.push(`${guide.file}: missing`);
    continue;
  }

  const text = fs.readFileSync(fullPath, 'utf8');
  if (guide.requireSnippets) {
    for (const snippet of requiredSnippets) {
      if (!text.includes(snippet)) {
        failures.push(`${guide.file}: missing required proof-call instruction: ${snippet}`);
      }
    }
  }

  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [label, pattern] of bannedPatterns) {
      if (pattern.test(line)) {
        failures.push(`${guide.file}:${index + 1}: ${label}`);
      }
    }
  });
}

if (failures.length > 0) {
  console.error('FAIL real proof-call docs drifted away from the guarded Gate 4 path:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`OK real proof-call docs use guarded readiness + proof runner path in ${proofGuides.length} file(s)`);
