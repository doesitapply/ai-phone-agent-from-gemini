#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  REAL_PROOF_CALL_CONFIRMATION_VALUE,
  evaluateRealProofCallApproval,
  realProofCallApprovalCommand,
} from './lib/real-proof-call-approval.mjs';

const target = '+14155550123';
const evaluate = (overrides = {}) => evaluateRealProofCallApproval({
  target,
  machineConfirmation: REAL_PROOF_CALL_CONFIRMATION_VALUE,
  targetConfirmation: target,
  ...overrides,
});

assert.equal(evaluate().ok, true, 'the exact machine and same-target confirmations must pass');
assert.deepEqual(
  evaluate({ machineConfirmation: '' }).failures,
  ['machine-confirmation-missing-or-invalid'],
  'readiness without the machine confirmation must not authorize a call',
);
assert.deepEqual(
  evaluate({ machineConfirmation: 'yes' }).failures,
  ['machine-confirmation-missing-or-invalid'],
  'a loose confirmation must not authorize a call',
);
assert.deepEqual(
  evaluate({ targetConfirmation: '' }).failures,
  ['target-confirmation-must-be-exact-e164'],
  'the target needs a separate exact confirmation',
);
assert.deepEqual(
  evaluate({ targetConfirmation: '+14155550124' }).failures,
  ['target-confirmation-does-not-match-cli-target'],
  'approval for a different number must not authorize the CLI target',
);
assert.equal(
  evaluate({ target: '415-555-0123' }).failures.includes('target-must-be-exact-e164'),
  true,
  'the dial target must be explicit E.164',
);

const command = realProofCallApprovalCommand();
assert.match(command, /CONFIRM_SMIRK_REAL_PROOF_CALL=place-one-smirk-real-proof-call/);
assert.match(command, /CONFIRM_SMIRK_REAL_PROOF_CALL_TARGET='<exact-approved-e164>'/);
assert.match(command, /proof:real-call -- '<exact-approved-e164>'/);

console.log('OK real proof-call approval requires an exact machine token and matching E.164 target confirmation');
