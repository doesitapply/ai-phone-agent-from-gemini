import assert from "node:assert/strict";
import test from "node:test";
import {
  auditLegacyOutboundArchive,
  parseLegacyOutboundCsv,
} from "../scripts/lib/legacy-outbound-archive.mjs";

const header = "sent_at,company,vertical,region,email,touch_number,subject,message_variant,resend_id,status,response,notes,batch,contact_url";

function row(overrides: Record<string, string> = {}) {
  const values = {
    sent_at: "2026-07-20T10:00:00.000Z",
    company: "Synthetic Plumbing",
    vertical: "plumbing",
    region: "Reno NV",
    email: "owner@example.invalid",
    touch_number: "1",
    subject: "Synthetic subject",
    message_variant: "historical-a",
    resend_id: "provider_fixture_1",
    status: "sent",
    response: "no_response",
    notes: "Synthetic fixture only",
    batch: "fixture",
    contact_url: "https://example.invalid/contact",
    ...overrides,
  };
  return [
    values.sent_at,
    values.company,
    values.vertical,
    values.region,
    values.email,
    values.touch_number,
    values.subject,
    values.message_variant,
    values.resend_id,
    values.status,
    values.response,
    values.notes,
    values.batch,
    values.contact_url,
  ].join(",");
}

test("legacy archive audit reports only aggregate observational evidence", () => {
  const ledgerText = [
    header,
    row(),
    row({
      sent_at: "2026-07-23T10:00:00.000Z",
      email: "second@example.invalid",
      touch_number: "2",
      resend_id: "provider_fixture_2",
      response: "interested",
    }),
    row({
      sent_at: "2026-07-24T10:00:00.000Z",
      email: "third@example.invalid",
      resend_id: "provider_fixture_3",
      status: "bounced",
    }),
  ].join("\n");
  const result = auditLegacyOutboundArchive({
    ledgerText,
    suppressionText: "third@example.invalid\n",
  });
  assert.equal(result.ok, true);
  assert.equal(result.counts.providerAttempts, 3);
  assert.equal(result.counts.providerAcceptedNotDeliveryProven, 2);
  assert.equal(result.counts.bounced, 1);
  assert.equal(result.counts.measuredResponses, 1);
  assert.equal(result.counts.positiveResponses, 1);
  assert.equal(result.interpretation.canonicalSmirkReconciliation, "NOT_RECONCILED");
  assert.equal(result.interpretation.eligibleForFrozenExperiment, false);
  assert.equal(result.controls.contactAuthorized, false);
  assert.equal(result.externalAction, "none");
  assert.doesNotMatch(JSON.stringify(result), /owner@example\.invalid|Synthetic Plumbing/);
});

test("legacy archive parser handles quoted commas and newlines", () => {
  const parsed = parseLegacyOutboundCsv([
    header,
    '2026-07-20T10:00:00.000Z,"Synthetic, Inc.",plumbing,"Reno, NV",owner@example.invalid,1,"Question, briefly",historical-a,provider_fixture_1,sent,no_response,"line one',
    'line two",fixture,https://example.invalid/contact',
  ].join("\n"));
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].value.company, "Synthetic, Inc.");
  assert.equal(parsed.rows[0].value.notes, "line one\nline two");
});

test("legacy archive audit rejects duplicate execution identities", () => {
  const base = row();
  const duplicateProvider = auditLegacyOutboundArchive({
    ledgerText: [
      header,
      base,
      row({
        email: "second@example.invalid",
        touch_number: "2",
      }),
    ].join("\n"),
    suppressionText: "",
  });
  assert.equal(duplicateProvider.ok, false);
  assert.ok(duplicateProvider.blockers.some(code =>
    code.startsWith("LEGACY_LEDGER_PROVIDER_ID_DUPLICATE")
  ));

  const duplicateTouch = auditLegacyOutboundArchive({
    ledgerText: [
      header,
      base,
      row({ resend_id: "provider_fixture_2" }),
    ].join("\n"),
    suppressionText: "",
  });
  assert.equal(duplicateTouch.ok, false);
  assert.ok(duplicateTouch.blockers.some(code =>
    code.startsWith("LEGACY_LEDGER_RECIPIENT_TOUCH_DUPLICATE")
  ));
});
