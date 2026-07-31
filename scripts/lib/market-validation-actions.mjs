function asNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

export function buildMarketValidationNextActions({
  traction = {},
  ledgerSummary = {},
  prospectReadiness = {},
  spendGate = {},
  liveCurrent = false,
  selectedLedgerAlignment = null,
}) {
  const actions = [];
  const checkoutStarts = asNumber(traction.checkout_starts);
  const paidActivations = asNumber(traction.paid_activations);
  const touches = asNumber(traction.touches);
  const executionReadyProspects = asNumber(prospectReadiness.execution_ready_prospects);
  const exactSelectionAligned = selectedLedgerAlignment?.ok === true;
  const outboundPreparationReady =
    liveCurrent === true
    && executionReadyProspects > 0
    && exactSelectionAligned;

  if (asNumber(ledgerSummary.blocked_activation_count) > 0) {
    actions.push("Pause promotion and fix the blocked self-serve activation rows before scaling launch channels.");
  }
  if (checkoutStarts > paidActivations) {
    actions.push("Investigate checkout starts without activation as product/onboarding defects before adding paid spend.");
  }
  if (paidActivations < 1) {
    actions.push("Keep the self-serve claim gated until a paid or explicitly approved production activation proves checkout, workspace access, dashboard, proof call, owner alert, and callback task.");
  }
  if (liveCurrent !== true) {
    actions.push("Keep outbound preparation and execution paused: production is not running the current guarded Velvet -> SMIRK loop.");
  }
  if (asNumber(traction.companies) === 0) {
    actions.push("Add the first researched home-service prospects to /dashboard/launch before reporting outreach progress.");
  }
  if (executionReadyProspects === 0) {
    actions.push("Verify a direct public contact path, current research date, and owner/operator or phone-demand evidence before preparing any outreach approval packet.");
  } else if (liveCurrent === true && !exactSelectionAligned) {
    actions.push(`Reconcile the exact ${executionReadyProspects} locally execution-ready prospect(s) against the current production ledger; count parity alone does not authorize outreach.`);
  } else if (outboundPreparationReady && touches === 0) {
    actions.push(`Prepare a narrow exact-approval packet from the ${executionReadyProspects} execution-ready checked-in prospect(s); researched-only rows are not send-ready.`);
  }
  if (touches < 200 && outboundPreparationReady) {
    actions.push("After exact owner approval, work toward the first 200 human-reviewed manual touches using only execution-ready prospects and the approved no-SMS, no-auto-dial outreach playbook.");
  }
  if (spendGate?.paid_spend_allowed !== true) {
    actions.push("Do not start paid spend until the approval phrase and self-serve proof gate are both satisfied.");
  }
  return actions.slice(0, 5);
}
