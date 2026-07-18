export const REAL_PROOF_CALL_APPROVAL_TOKEN = 'APPROVE_SMIRK_REAL_PROOF_CALL';
export const REAL_PROOF_CALL_CONFIRMATION_ENV = 'CONFIRM_SMIRK_REAL_PROOF_CALL';
export const REAL_PROOF_CALL_CONFIRMATION_VALUE = 'place-one-smirk-real-proof-call';
export const REAL_PROOF_CALL_TARGET_CONFIRMATION_ENV = 'CONFIRM_SMIRK_REAL_PROOF_CALL_TARGET';

export const isExactE164 = (value) => /^\+[1-9]\d{7,14}$/.test(String(value || '').trim());

export function evaluateRealProofCallApproval({
  target,
  machineConfirmation,
  targetConfirmation,
}) {
  const exactTarget = String(target || '').trim();
  const exactMachineConfirmation = String(machineConfirmation || '').trim();
  const exactTargetConfirmation = String(targetConfirmation || '').trim();
  const failures = [];

  if (!isExactE164(exactTarget)) failures.push('target-must-be-exact-e164');
  if (exactMachineConfirmation !== REAL_PROOF_CALL_CONFIRMATION_VALUE) {
    failures.push('machine-confirmation-missing-or-invalid');
  }
  if (!isExactE164(exactTargetConfirmation)) {
    failures.push('target-confirmation-must-be-exact-e164');
  } else if (exactTargetConfirmation !== exactTarget) {
    failures.push('target-confirmation-does-not-match-cli-target');
  }

  return { ok: failures.length === 0, failures };
}

export function realProofCallApprovalCommand(targetPlaceholder = '<exact-approved-e164>') {
  return `${REAL_PROOF_CALL_CONFIRMATION_ENV}=${REAL_PROOF_CALL_CONFIRMATION_VALUE} ${REAL_PROOF_CALL_TARGET_CONFIRMATION_ENV}='${targetPlaceholder}' npm run -s proof:real-call -- '${targetPlaceholder}'`;
}
