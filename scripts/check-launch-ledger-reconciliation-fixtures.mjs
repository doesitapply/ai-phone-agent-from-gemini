#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  fetchProductionLaunchLedger,
  reconcileSelectedProspectsWithProductionLedger,
  validateProductionLaunchLedgerSnapshot,
} from "./lib/launch-ledger-reconciliation.mjs";

const selectedRows = [
  { company: "Fixture Plumbing" },
  { company: "Fixture Electric" },
];
const liveRow = (id, company, overrides = {}) => ({
  id,
  company,
  next_state: "researched",
  touch_count: 0,
  spend_cents: 0,
  response: "no_response",
  objection: null,
  proof_walkthrough_status: "not_requested",
  checkout_status: "not_started",
  activation_status: "not_started",
  last_touch_at: null,
  notes: "Public research; no message sent",
  ...overrides,
});
const eligibleRows = [liveRow(1, "Fixture Plumbing"), liveRow(2, "Fixture Electric")];
const reconcile = (rows) => reconcileSelectedProspectsWithProductionLedger({
  selectedRows,
  liveRows: rows,
  checkedAt: "2026-07-18T20:00:00.000Z",
  source: "https://production.example/api/launch/ledger?days=90&limit=500",
  authSource: "fixture",
  windowDays: 90,
});

const eligible = reconcile(eligibleRows);
assert.equal(eligible.ok, true);
assert.equal(eligible.snapshot.request_method, "GET");
assert.equal(eligible.snapshot.write_performed, false);
assert.equal(validateProductionLaunchLedgerSnapshot(eligible.snapshot, selectedRows.map((row) => row.company)).ok, true);

const missing = reconcile(eligibleRows.slice(0, 1));
assert.equal(missing.ok, false);
assert.ok(missing.blockers.some((failure) => failure.code === "production-ledger-company-missing"));

const duplicate = reconcile([...eligibleRows, liveRow(3, "Fixture Plumbing")]);
assert.equal(duplicate.ok, false);
assert.ok(duplicate.blockers.some((failure) => failure.code === "production-ledger-company-duplicate"));

for (const [label, overrides, expectedCode] of [
  ["touch count", { touch_count: 1 }, "production-ledger-already-touched"],
  ["last touch", { last_touch_at: "2026-07-18T19:00:00.000Z" }, "production-ledger-already-touched"],
  ["malformed touch", { touch_count: "unknown" }, "production-ledger-touch-count-invalid"],
  ["progressed state", { next_state: "contacted" }, "production-ledger-state-progressed"],
  ["response", { response: "interested" }, "production-ledger-response-progressed"],
  ["objection", { objection: "price" }, "production-ledger-objection-present"],
  ["proof", { proof_walkthrough_status: "requested" }, "production-ledger-proof-progressed"],
  ["checkout", { checkout_status: "started" }, "production-ledger-checkout-progressed"],
  ["activation", { activation_status: "activated" }, "production-ledger-activation-progressed"],
  ["spend", { spend_cents: 1 }, "production-ledger-spend-progressed"],
  ["do not contact state", { next_state: "do_not_contact" }, "production-ledger-do-not-contact"],
  ["do not contact response", { response: "do_not_contact" }, "production-ledger-do-not-contact"],
  ["unsubscribe note", { notes: "Customer unsubscribed" }, "production-ledger-do-not-contact"],
  ["STOP response", { response: "STOP" }, "production-ledger-do-not-contact"],
  ["DNC note", { notes: "DNC" }, "production-ledger-do-not-contact"],
  ["STOP sentence note", { notes: "Customer asked us to STOP" }, "production-ledger-do-not-contact"],
  ["DNC sentence note", { notes: "Customer is DNC" }, "production-ledger-do-not-contact"],
  ["stop sentence objection", { objection: "Prospect wrote stop" }, "production-ledger-do-not-contact"],
  ["remove me objection", { objection: "Please remove me" }, "production-ledger-do-not-contact"],
  ["never call again note", { notes: "Never call me again" }, "production-ledger-do-not-contact"],
]) {
  const result = reconcile([liveRow(1, "Fixture Plumbing", overrides), eligibleRows[1]]);
  assert.equal(result.ok, false, `${label} must fail closed`);
  assert.ok(result.blockers.some((failure) => failure.code === expectedCode), `${label} must emit ${expectedCode}`);
}

const tamperedSnapshot = structuredClone(eligible.snapshot);
tamperedSnapshot.selected_states[0].touch_count = 1;
assert.equal(validateProductionLaunchLedgerSnapshot(tamperedSnapshot, selectedRows.map((row) => row.company)).ok, false);

const fetchCalls = [];
const fetched = await fetchProductionLaunchLedger({
  appUrl: "https://production.example",
  apiKeyCandidates: [{ source: "fixture key", apiKey: "secret-never-output" }],
  fetchImpl: async (url, init) => {
    fetchCalls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === "cache-control" ? "no-store" : null },
      text: async () => JSON.stringify({ ok: true, rows: eligibleRows, traction: { companies: eligibleRows.length } }),
    };
  },
});
assert.equal(fetched.ok, true);
assert.equal(fetchCalls.length, 1);
assert.equal(fetchCalls[0].init.method, "GET");
assert.equal(fetched.writePerformed, false);
assert.equal(JSON.stringify(fetched).includes("secret-never-output"), false, "result must never expose operator credentials");

const cacheable = await fetchProductionLaunchLedger({
  appUrl: "https://production.example",
  apiKeyCandidates: [{ source: "fixture", apiKey: "secret" }],
  fetchImpl: async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "public, max-age=300" },
    text: async () => JSON.stringify({ ok: true, rows: eligibleRows, traction: { companies: eligibleRows.length } }),
  }),
});
assert.equal(cacheable.ok, false, "cacheable operator ledger responses must fail closed");

const privateButCacheable = await fetchProductionLaunchLedger({
  appUrl: "https://production.example",
  apiKeyCandidates: [{ source: "fixture", apiKey: "secret" }],
  fetchImpl: async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "private, max-age=300" },
    text: async () => JSON.stringify({ ok: true, rows: eligibleRows, traction: { companies: eligibleRows.length } }),
  }),
});
assert.equal(privateButCacheable.ok, false, "private but freshness-cacheable ledger responses must fail closed");

const incomplete = await fetchProductionLaunchLedger({
  appUrl: "https://production.example",
  apiKeyCandidates: [{ source: "fixture", apiKey: "secret" }],
  fetchImpl: async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "no-store" },
    text: async () => JSON.stringify({ ok: true, rows: eligibleRows, traction: { companies: eligibleRows.length + 1 } }),
  }),
});
assert.equal(incomplete.ok, false, "a truncated production ledger window must fail closed");
assert.equal(incomplete.failures[0].error, "production-ledger-window-incomplete");

console.log("OK production launch-ledger reconciliation is GET-only and rejects missing, duplicate, touched, progressed, DNC, malformed, cacheable, or tampered state without exposing credentials");
