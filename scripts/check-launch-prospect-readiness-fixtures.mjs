#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  LAUNCH_PROSPECT_READINESS_SCHEMA,
  evaluateLaunchProspectReadiness,
  summarizeLaunchProspectReadiness,
} from "./lib/launch-prospect-readiness.mjs";

const referenceTime = Date.parse("2026-07-18T12:00:00.000Z");
const base = {
  company: "Fixture Plumbing",
  vertical: "plumbing",
  region: "Reno NV",
  owner_contact: "Jamie Owner",
  channel: "website_form",
  next_state: "researched",
  touch_count: "0",
  spend_cents: "0",
  source_url: "https://fixture.example/about-us/",
  contact_url: "https://fixture.example/contact-us/",
  notes: "Official site identifies owner Jamie, 24/7 availability, and a public contact form; refreshed 2026-07-18; no message sent",
};

const ready = evaluateLaunchProspectReadiness(base, { referenceTime });
assert.equal(ready.schema, LAUNCH_PROSPECT_READINESS_SCHEMA);
assert.equal(ready.execution_ready, true);
assert.deepEqual(ready.blockers, []);

const importedLedgerShape = evaluateLaunchProspectReadiness({
  ...base,
  source_url: "",
  contact_url: "",
  notes: `${base.notes}; source_url=${base.source_url}; contact_url=${base.contact_url}; research_batch=fixture`,
}, { referenceTime });
assert.equal(importedLedgerShape.execution_ready, true, "tagged live-ledger URLs must preserve local readiness evidence");

const verifiedTeamWithDemand = evaluateLaunchProspectReadiness({
  ...base,
  owner_contact: "public_contact_team",
  notes: "Official site describes a local family-owned operator with 24/7 repair service and a public contact form; refreshed 2026-07-18; no message sent",
}, { referenceTime });
assert.equal(verifiedTeamWithDemand.execution_ready, true, "explicit demand evidence may support a verified public team contact");

const namedOwnerWithDirectForm = evaluateLaunchProspectReadiness({
  ...base,
  notes: "Official site identifies owner Jamie and provides a public project contact form; refreshed 2026-07-18; no message sent",
}, { referenceTime });
assert.equal(namedOwnerWithDirectForm.execution_ready, true, "a named owner plus verified direct form may qualify without inventing phone-demand evidence");

const homepageOnly = evaluateLaunchProspectReadiness({
  ...base,
  contact_url: "https://fixture.example/",
}, { referenceTime });
assert.equal(homepageOnly.execution_ready, false);
assert.ok(homepageOnly.blockers.includes("direct-contact-path-unverified"));

const genericResearchRow = {
  ...base,
  owner_contact: "public_contact_page",
  source_url: "https://fixture.example/",
  contact_url: "https://fixture.example/",
  notes: "Public official site from launch research; no message sent",
};
const genericResearch = evaluateLaunchProspectReadiness(genericResearchRow, { referenceTime });
assert.equal(genericResearch.execution_ready, false);
assert.ok(genericResearch.blockers.includes("direct-contact-path-unverified"));
assert.ok(genericResearch.blockers.includes("public-contact-evidence-missing"));
assert.ok(genericResearch.blockers.includes("owner-or-phone-demand-evidence-missing"));
assert.ok(genericResearch.blockers.includes("research-verification-date-missing"));

const stale = evaluateLaunchProspectReadiness({
  ...base,
  notes: base.notes.replace("2026-07-18", "2025-01-01"),
}, { referenceTime });
assert.equal(stale.execution_ready, false);
assert.ok(stale.blockers.includes("research-verification-not-current"));

const touched = evaluateLaunchProspectReadiness({ ...base, touch_count: "1" }, { referenceTime });
assert.equal(touched.execution_ready, false);
assert.ok(touched.blockers.includes("not-researched-zero-touch-zero-spend"));

const malformedCounters = evaluateLaunchProspectReadiness({ ...base, touch_count: "not-a-number" }, { referenceTime });
assert.equal(malformedCounters.execution_ready, false, "malformed counters must not coerce to zero");
assert.ok(malformedCounters.blockers.includes("not-researched-zero-touch-zero-spend"));

const mismatchedContactHost = evaluateLaunchProspectReadiness({
  ...base,
  contact_url: "https://unrelated.example/contact-us/",
}, { referenceTime });
assert.equal(mismatchedContactHost.execution_ready, false, "a direct-looking path on another host must fail closed");
assert.ok(mismatchedContactHost.blockers.includes("contact-source-host-mismatch"));

const unsupportedChannel = evaluateLaunchProspectReadiness({ ...base, channel: "sms" }, { referenceTime });
assert.equal(unsupportedChannel.execution_ready, false);
assert.ok(unsupportedChannel.blockers.includes("unsupported-channel"));

const progressedRow = { ...base, next_state: "contacted", touch_count: "1" };
const progressedWithoutCounter = { ...base, response: "interested" };
const proofProgressed = { ...base, proof_walkthrough_status: "requested" };
const checkoutProgressed = { ...base, checkout_status: "started" };
const activationProgressed = { ...base, activation_status: "activated" };
const lastTouchProgressed = { ...base, last_touch_at: "2026-07-18T10:00:00.000Z" };
for (const row of [progressedWithoutCounter, proofProgressed, checkoutProgressed, activationProgressed, lastTouchProgressed]) {
  const evaluation = evaluateLaunchProspectReadiness(row, { referenceTime });
  assert.equal(evaluation.execution_ready, false, "progressed first-touch state must not remain execution-ready");
  assert.ok(evaluation.blockers.includes("first-touch-state-progressed"));
}
const summary = summarizeLaunchProspectReadiness([
  base,
  genericResearchRow,
  progressedRow,
  progressedWithoutCounter,
  proofProgressed,
  checkoutProgressed,
  activationProgressed,
  lastTouchProgressed,
], { referenceTime });
assert.equal(summary.rows_reviewed, 8);
assert.equal(summary.researched_prospects, 2);
assert.equal(summary.candidate_prospects, 2);
assert.equal(summary.execution_ready_prospects, 1);
assert.equal(summary.researched_only_prospects, 1);
assert.equal(summary.progressed_or_non_candidate_prospects, 6, "progressed rows must not be mislabeled researched-only");
assert.equal(summary.by_blocker["research-verification-date-missing"], 1);

console.log("OK launch prospect readiness separates evidence-backed execution-ready rows from generic researched rows and fails closed on stale, homepage-only, touched, or unsupported targets");
