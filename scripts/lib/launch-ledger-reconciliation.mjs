import {
  sha256Text,
  stableJson,
} from "./launch-touch-approval.mjs";

export const PRODUCTION_LAUNCH_LEDGER_SNAPSHOT_SCHEMA = "smirk.production-launch-ledger-snapshot.v1";

function clean(value) {
  return String(value ?? "").trim();
}

function companyKey(value) {
  return clean(value).toLowerCase();
}

function exactNonNegativeInteger(value) {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : null;
  const text = clean(value);
  return /^\d+$/.test(text) ? Number.parseInt(text, 10) : null;
}

function doNotContactSignal(row) {
  const fields = [
    row?.next_state,
    row?.response,
    row?.objection,
    row?.notes,
  ].map(clean);
  const exactSuppression = new Set([
    "dnc",
    "stop",
    "opt_out",
    "opted_out",
    "unsubscribe",
    "unsubscribed",
    "do_not_contact",
  ]);
  if (fields.some((value) => exactSuppression.has(value.toLowerCase()))) return true;
  return /\bdnc\b|\bstop\b|\bdo[-_\s]?not[-_\s]?contact\b|\bunsubscrib(?:e|ed)\b|\bopt(?:ed)?[-_\s]?out\b|\bremove me\b|\btake me off (?:the|your) list\b|\bnever (?:call|contact|email|message)(?: me)? again\b|\bdon'?t (?:call|contact|email|message)(?: me)?\b|\bno more (?:calls?|emails?|messages?)\b/i.test(fields.join(" "));
}

function liveState(row, matches) {
  if (!row) return { company: null, live_match_count: matches };
  const touchCount = exactNonNegativeInteger(row.touch_count);
  const spendCents = exactNonNegativeInteger(row.spend_cents);
  return {
    company: clean(row.company),
    live_match_count: matches,
    ledger_id: exactNonNegativeInteger(row.id),
    next_state: clean(row.next_state).toLowerCase(),
    touch_count: touchCount,
    spend_cents: spendCents,
    response: clean(row.response).toLowerCase(),
    proof_walkthrough_status: clean(row.proof_walkthrough_status).toLowerCase(),
    checkout_status: clean(row.checkout_status).toLowerCase(),
    activation_status: clean(row.activation_status).toLowerCase(),
    objection_present: Boolean(clean(row.objection)),
    last_touch_present: Boolean(clean(row.last_touch_at)),
    do_not_contact: doNotContactSignal(row),
  };
}

function addBlocker(blockers, condition, code, company, detail = {}) {
  if (!condition) blockers.push({ code, company, ...detail });
}

export function reconcileSelectedProspectsWithProductionLedger({
  selectedRows,
  liveRows,
  checkedAt = new Date().toISOString(),
  source,
  authSource = "unknown",
  windowDays = 90,
}) {
  const selected = Array.isArray(selectedRows) ? selectedRows : [];
  const ledger = Array.isArray(liveRows) ? liveRows : [];
  const blockers = [];
  const selectedStates = [];
  const seenSelected = new Set();

  for (const selectedRow of selected) {
    const company = clean(selectedRow?.company);
    const key = companyKey(company);
    if (!key || seenSelected.has(key)) {
      blockers.push({ code: key ? "selected-company-duplicate" : "selected-company-missing", company: company || null });
      continue;
    }
    seenSelected.add(key);
    const matches = ledger.filter((row) => companyKey(row?.company) === key);
    if (matches.length !== 1) {
      blockers.push({
        code: matches.length === 0 ? "production-ledger-company-missing" : "production-ledger-company-duplicate",
        company,
        live_match_count: matches.length,
      });
      selectedStates.push({ company, live_match_count: matches.length });
      continue;
    }

    const state = liveState(matches[0], 1);
    selectedStates.push(state);
    addBlocker(blockers, state.ledger_id !== null && state.ledger_id > 0, "production-ledger-id-invalid", company);
    addBlocker(blockers, state.touch_count !== null, "production-ledger-touch-count-invalid", company);
    addBlocker(blockers, state.spend_cents !== null, "production-ledger-spend-cents-invalid", company);
    addBlocker(blockers, state.do_not_contact !== true, "production-ledger-do-not-contact", company);
    addBlocker(
      blockers,
      state.touch_count === 0 && state.last_touch_present === false,
      "production-ledger-already-touched",
      company,
      { touch_count: state.touch_count, last_touch_present: state.last_touch_present },
    );
    addBlocker(blockers, state.next_state === "researched", "production-ledger-state-progressed", company, { next_state: state.next_state || null });
    addBlocker(blockers, state.spend_cents === 0, "production-ledger-spend-progressed", company, { spend_cents: state.spend_cents });
    addBlocker(
      blockers,
      state.response === "" || state.response === "no_response",
      "production-ledger-response-progressed",
      company,
      { response: state.response || null },
    );
    addBlocker(blockers, state.objection_present === false, "production-ledger-objection-present", company);
    addBlocker(
      blockers,
      state.proof_walkthrough_status === "not_requested",
      "production-ledger-proof-progressed",
      company,
      { proof_walkthrough_status: state.proof_walkthrough_status || null },
    );
    addBlocker(
      blockers,
      state.checkout_status === "not_started",
      "production-ledger-checkout-progressed",
      company,
      { checkout_status: state.checkout_status || null },
    );
    addBlocker(
      blockers,
      state.activation_status === "not_started",
      "production-ledger-activation-progressed",
      company,
      { activation_status: state.activation_status || null },
    );
  }

  const snapshotPayload = {
    source: clean(source),
    selected_states: selectedStates,
  };
  const canonicalSelectedState = stableJson(snapshotPayload);
  const snapshot = {
    schema: PRODUCTION_LAUNCH_LEDGER_SNAPSHOT_SCHEMA,
    checked_at: checkedAt,
    source: clean(source),
    request_method: "GET",
    write_performed: false,
    auth_source: clean(authSource) || "unknown",
    window_days: windowDays,
    rows_received: ledger.length,
    selected_company_count: selected.length,
    selected_states: selectedStates,
    canonical_selected_state: canonicalSelectedState,
    selected_state_sha256: sha256Text(canonicalSelectedState),
  };
  const snapshotValidation = validateProductionLaunchLedgerSnapshot(snapshot, selected.map((row) => clean(row?.company)));
  if (!snapshotValidation.ok) blockers.push(...snapshotValidation.failures);

  return {
    ok: blockers.length === 0,
    blockers,
    snapshot,
  };
}

export function validateProductionLaunchLedgerSnapshot(snapshot, selectedCompanies = []) {
  const failures = [];
  const companies = Array.isArray(selectedCompanies) ? selectedCompanies.map(clean) : [];
  const states = Array.isArray(snapshot?.selected_states) ? snapshot.selected_states : [];
  const canonical = stableJson({
    source: clean(snapshot?.source),
    selected_states: states,
  });
  addBlocker(failures, snapshot?.schema === PRODUCTION_LAUNCH_LEDGER_SNAPSHOT_SCHEMA, "production-ledger-snapshot-schema-invalid", null);
  addBlocker(failures, Number.isFinite(Date.parse(clean(snapshot?.checked_at))), "production-ledger-snapshot-time-invalid", null);
  addBlocker(failures, /^https:\/\//i.test(clean(snapshot?.source)), "production-ledger-snapshot-source-invalid", null);
  addBlocker(failures, snapshot?.request_method === "GET", "production-ledger-snapshot-method-invalid", null);
  addBlocker(failures, snapshot?.write_performed === false, "production-ledger-snapshot-write-flag-invalid", null);
  addBlocker(failures, Number.isInteger(snapshot?.rows_received) && snapshot.rows_received >= 0, "production-ledger-snapshot-row-count-invalid", null);
  addBlocker(failures, snapshot?.selected_company_count === states.length, "production-ledger-snapshot-selected-count-invalid", null);
  addBlocker(failures, snapshot?.canonical_selected_state === canonical, "production-ledger-snapshot-canonical-state-invalid", null);
  addBlocker(failures, snapshot?.selected_state_sha256 === sha256Text(canonical), "production-ledger-snapshot-hash-invalid", null);
  if (companies.length > 0) {
    addBlocker(failures, companies.length === states.length, "production-ledger-snapshot-company-count-mismatch", null);
    companies.forEach((company, index) => {
      addBlocker(
        failures,
        companyKey(states[index]?.company) === companyKey(company),
        "production-ledger-snapshot-company-order-mismatch",
        company || null,
      );
    });
  }
  return { ok: failures.length === 0, failures };
}

function normalizeFetchError(error) {
  return {
    name: error?.name || null,
    message: clean(error?.message || error),
    code: error?.cause?.code || error?.code || null,
  };
}

export async function fetchProductionLaunchLedger({
  appUrl,
  apiKeyCandidates,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  windowDays = 90,
  limit = 500,
}) {
  const baseUrl = clean(appUrl).replace(/\/$/, "");
  const endpoint = `${baseUrl}/api/launch/ledger?days=${windowDays}&limit=${limit}`;
  if (!/^https:\/\//i.test(baseUrl)) {
    return { ok: false, error: "production-ledger-app-url-not-https", endpoint, failures: [] };
  }
  const candidates = [];
  const seenKeys = new Set();
  for (const candidate of Array.isArray(apiKeyCandidates) ? apiKeyCandidates : []) {
    const apiKey = clean(candidate?.apiKey);
    if (!apiKey || seenKeys.has(apiKey)) continue;
    seenKeys.add(apiKey);
    candidates.push({ source: clean(candidate?.source) || "unknown", apiKey });
  }
  if (candidates.length === 0) {
    return { ok: false, error: "production-ledger-operator-auth-unavailable", endpoint, failures: [] };
  }

  const failures = [];
  for (const candidate of candidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "GET",
        headers: { "x-api-key": candidate.apiKey },
        signal: controller.signal,
      });
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      const cacheControl = clean(response.headers?.get?.("cache-control"));
      const cacheProtected = /no-store|no-cache/i.test(cacheControl);
      const reportedCompanies = exactNonNegativeInteger(body?.traction?.companies);
      const completeWindow = reportedCompanies !== null && Array.isArray(body?.rows) && reportedCompanies === body.rows.length;
      if (response.ok && body?.ok === true && Array.isArray(body.rows) && cacheProtected && completeWindow) {
        return {
          ok: true,
          endpoint,
          source: endpoint,
          authSource: candidate.source,
          windowDays,
          rows: body.rows,
          reportedCompanies,
          cacheProtected,
          requestMethod: "GET",
          writePerformed: false,
        };
      }
      failures.push({
        auth_source: candidate.source,
        status: response.status,
        error: body?.error
          || (!cacheProtected
            ? "production-ledger-response-cacheable"
            : !completeWindow
              ? "production-ledger-window-incomplete"
              : "production-ledger-response-invalid"),
        rows_received: Array.isArray(body?.rows) ? body.rows.length : null,
        reported_companies: reportedCompanies,
      });
    } catch (error) {
      failures.push({ auth_source: candidate.source, status: 0, error: normalizeFetchError(error) });
    } finally {
      clearTimeout(timeout);
    }
  }
  return { ok: false, error: "production-ledger-read-failed", endpoint, failures };
}
