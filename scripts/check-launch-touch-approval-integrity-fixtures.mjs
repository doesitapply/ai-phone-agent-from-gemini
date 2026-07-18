#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LAUNCH_TOUCH_APPROVAL_SCHEMA,
  buildLaunchTouchApproval,
  launchTouchDraftSubject,
  validateLaunchTouchExecutionApproval,
} from "./lib/launch-touch-approval.mjs";

const tempRoot = mkdtempSync(path.join(tmpdir(), "smirk-launch-touch-approval-"));
const repoRoot = process.cwd();
const executionFile = path.join(tempRoot, "first-2-fixture-manual-touch-execution.csv");
const approvalFile = executionFile.replace(/-execution\.csv$/, "-approval.json");

const sourceRows = [
  {
    company: "Fixture Plumbing",
    channel: "website_form",
    contact_url: "https://fixture-plumbing.example/contact",
    draft: "Subject: Fixture plumbing proof\n\nExact first fixture draft.",
  },
  {
    company: "Fixture Electric",
    channel: "website_form",
    contact_url: "https://fixture-electric.example/contact",
    draft: "Subject: Fixture electric proof\n\nExact second fixture draft.",
  },
];

function productionLedgerSnapshot(selectedStateSha256 = "a".repeat(64)) {
  return {
    source: "https://production.example/api/launch/ledger?days=90&limit=500",
    selected_state_sha256: selectedStateSha256,
    selected_company_count: sourceRows.length,
  };
}

function buildFixture() {
  const built = buildLaunchTouchApproval(sourceRows, (row) => row.draft, {
    productionLedgerSnapshot: productionLedgerSnapshot(),
  });
  const rows = built.approval.payload.targets.map((target, index) => ({
    send_order: String(index + 1),
    company: target.company,
    channel: target.channel,
    contact_url: target.contact_url,
    draft_subject: launchTouchDraftSubject(target.draft),
    draft_sha256: target.draft_sha256,
    approval_batch_sha256: built.approval.payload_sha256,
    vertical: index === 0 ? "plumbing" : "electrician",
    launch_region: "Fixture Region",
    message_variant: "fixture_integrity",
    human_sender: "",
    actual_contact_path: "",
    sent_at: "",
    touch_logged_at: "",
    next_state_after_send: "researched",
    touch_count_delta: "0",
    spend_cents_delta: "0",
    response_status: "no_response",
    qualified_reason: "",
    objection: "",
    proof_walkthrough_status: "not_requested",
    checkout_status: "not_started",
    activation_status: "not_started",
    skip_reason: "",
    notes: "Fixture row",
  }));
  return { manifest: built.manifest, rows };
}

function writeManifest(manifest) {
  writeFileSync(approvalFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

const executionHeaders = [
  "send_order",
  "company",
  "vertical",
  "launch_region",
  "channel",
  "message_variant",
  "contact_url",
  "draft_subject",
  "draft_sha256",
  "approval_batch_sha256",
  "human_sender",
  "actual_contact_path",
  "sent_at",
  "touch_logged_at",
  "next_state_after_send",
  "touch_count_delta",
  "spend_cents_delta",
  "response_status",
  "qualified_reason",
  "objection",
  "proof_walkthrough_status",
  "checkout_status",
  "activation_status",
  "skip_reason",
  "notes",
];

function csvEscape(value) {
  const text = String(value || "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeExecution(rows) {
  const lines = [executionHeaders.join(",")];
  for (const row of rows) lines.push(executionHeaders.map((header) => csvEscape(row[header])).join(","));
  writeFileSync(executionFile, `${lines.join("\n")}\n`);
}

function runIntegration(script, args = []) {
  return spawnSync(process.execPath, [script, ...args, executionFile], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function validate(fixture) {
  writeManifest(fixture.manifest);
  return validateLaunchTouchExecutionApproval({ rows: fixture.rows, executionFile });
}

function expectFailure(code, mutate) {
  const fixture = structuredClone(buildFixture());
  mutate(fixture);
  const result = validate(fixture);
  assert.equal(result.ok, false, `${code} mutation must fail closed`);
  assert.ok(result.failures.some((failure) => failure.code === code), `${code} must be reported: ${JSON.stringify(result.failures)}`);
}

try {
  const valid = buildFixture();
  assert.equal(valid.manifest.approval.payload.schema, LAUNCH_TOUCH_APPROVAL_SCHEMA);
  assert.match(valid.manifest.approval.exact_approval_token, /ledger=sha256:a{64}/);
  const changedLiveState = buildLaunchTouchApproval(sourceRows, (row) => row.draft, {
    productionLedgerSnapshot: productionLedgerSnapshot("b".repeat(64)),
  });
  assert.notEqual(
    changedLiveState.approval.payload_sha256,
    valid.manifest.approval.payload_sha256,
    "a changed production selected-state hash must invalidate the exact approval payload",
  );
  assert.notEqual(
    changedLiveState.approval.exact_approval_token,
    valid.manifest.approval.exact_approval_token,
    "a changed production selected-state hash must require a new approval token",
  );
  writeManifest(valid.manifest);
  const validResult = validateLaunchTouchExecutionApproval({ rows: valid.rows, executionFile });
  assert.equal(validResult.ok, true, JSON.stringify(validResult.failures));
  assert.equal(validResult.ownerApprovalProven, false, "artifact integrity must never be presented as owner approval");
  writeExecution(valid.rows);
  const checkerPass = runIntegration("scripts/check-launch-touch-execution.mjs");
  assert.equal(checkerPass.status, 0, `${checkerPass.stdout}\n${checkerPass.stderr}`);
  assert.match(checkerPass.stdout, /"approval_integrity_verified": true/);
  assert.match(checkerPass.stdout, /"owner_approval_proven": false/);
  const importerPass = runIntegration("scripts/import-launch-touch-execution.mjs", ["--validate-only"]);
  assert.equal(importerPass.status, 0, `${importerPass.stdout}\n${importerPass.stderr}`);
  assert.match(importerPass.stdout, /"approval_integrity_verified": true/);
  assert.match(importerPass.stdout, /"owner_approval_proven": false/);

  const tamperedIntegration = structuredClone(valid.rows);
  tamperedIntegration[0].contact_url = "https://unapproved.example/contact";
  writeExecution(tamperedIntegration);
  const checkerFail = runIntegration("scripts/check-launch-touch-execution.mjs");
  assert.notEqual(checkerFail.status, 0, "execution checker must fail on a changed approved contact path");
  assert.match(`${checkerFail.stdout}\n${checkerFail.stderr}`, /execution-contact-path-mismatch/);
  const importerFail = runIntegration("scripts/import-launch-touch-execution.mjs", ["--validate-only"]);
  assert.notEqual(importerFail.status, 0, "execution importer must fail on a changed approved contact path");
  assert.match(`${importerFail.stdout}\n${importerFail.stderr}`, /execution-contact-path-mismatch/);

  const sent = structuredClone(valid);
  sent.rows[0].sent_at = "2026-07-18T18:00:00.000Z";
  sent.rows[0].actual_contact_path = sent.rows[0].contact_url;
  assert.equal(validate(sent).ok, true, "an exact approved contact path must remain valid after a human send");

  expectFailure("approval-schema-invalid", ({ manifest }) => {
    manifest.approval.payload.schema = "smirk.outreach-batch-approval.v1";
  });
  expectFailure("approval-production-ledger-hash-invalid", ({ manifest }) => {
    manifest.approval.payload.production_ledger_binding.selected_state_sha256 = "not-a-hash";
  });
  expectFailure("approval-manifest-status-invalid", ({ manifest }) => {
    manifest.status = "approved";
  });
  expectFailure("approval-target-draft-hash-mismatch", ({ manifest }) => {
    manifest.approval.payload.targets[0].draft = "Changed after packet creation";
  });
  expectFailure("execution-send-order-mismatch", ({ rows }) => {
    [rows[0], rows[1]] = [rows[1], rows[0]];
  });
  expectFailure("execution-contact-path-mismatch", ({ rows }) => {
    rows[0].contact_url = "https://different.example/contact";
  });
  expectFailure("execution-draft-hash-mismatch", ({ rows }) => {
    rows[0].draft_sha256 = "0".repeat(64);
  });
  expectFailure("execution-batch-hash-mismatch", ({ rows }) => {
    rows[0].approval_batch_sha256 = "f".repeat(64);
  });
  expectFailure("execution-actual-contact-path-not-approved", ({ rows }) => {
    rows[0].sent_at = "2026-07-18T18:00:00.000Z";
    rows[0].actual_contact_path = "https://unapproved.example/contact";
  });

  rmSync(approvalFile, { force: true });
  const missing = validateLaunchTouchExecutionApproval({ rows: valid.rows, executionFile });
  assert.equal(missing.ok, false);
  assert.ok(missing.failures.some((failure) => failure.code === "approval-manifest-missing"));

  console.log("OK launch touch approval integrity fixtures reject legacy/tampered manifests, row reorder, hash drift, and unapproved contact-path changes without implying owner approval or sending outreach");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
