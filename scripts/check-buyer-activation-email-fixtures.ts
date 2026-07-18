import assert from "node:assert/strict";
import { sendBuyerActivationEmail, sendManualSetupReceipt, sendPromoActivationEmail, sendProvisioningAlert } from "../src/monetization-alerts.js";
import {
  firstSafePublicHttpsUrl,
  normalizePublicHttpsUrl,
  normalizeTrustedProductionAppUrl,
  resolveTrustedProductionAppOrigin,
} from "../src/public-url-safety.js";
import { evaluateCanonicalMailboxAliases, normalizeStrictMailbox, parseStrictMailboxList } from "../src/email-safety.js";

const originalFetch = globalThis.fetch;
const originalEnv = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  FROM_EMAIL: process.env.FROM_EMAIL,
  FROM_NAME: process.env.FROM_NAME,
  APP_URL: process.env.APP_URL,
  NOTIFICATION_EMAIL: process.env.NOTIFICATION_EMAIL,
  OWNER_ALERT_EMAIL: process.env.OWNER_ALERT_EMAIL,
  OWNER_EMAIL: process.env.OWNER_EMAIL,
  OPERATOR_EMAIL: process.env.OPERATOR_EMAIL,
};

const restoreEnv = () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

try {
  process.env.RESEND_API_KEY = "re_fixture";
  process.env.FROM_EMAIL = "hello@smirkcalls.com";
  process.env.FROM_NAME = "SMIRK";
  process.env.APP_URL = "https://smirkcalls.com";
  delete process.env.NOTIFICATION_EMAIL;
  process.env.OWNER_ALERT_EMAIL = "not-an-email; operator@smirkcalls.com, owner@example.com; second@localhost";
  delete process.env.OWNER_EMAIL;
  delete process.env.OPERATOR_EMAIL;

  const calls: Array<{ headers: Headers; body: any; signal: AbortSignal | null }> = [];
  const successfulFetch = async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body || "{}")),
      signal: init?.signal || null,
    });
    return new Response(JSON.stringify({ id: "email_fixture_123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = successfulFetch;

  assert.equal(normalizePublicHttpsUrl("javascript:alert(1)"), null);
  assert.equal(normalizePublicHttpsUrl("http://calendly.com/smirkcalls/setup"), null);
  assert.equal(normalizePublicHttpsUrl("https://user:pass@calendly.com/smirkcalls/setup"), null);
  assert.equal(normalizePublicHttpsUrl("https://127.0.0.1/setup"), null);
  assert.equal(firstSafePublicHttpsUrl("not a url", "https://calendly.com/smirkcalls/setup"), "https://calendly.com/smirkcalls/setup");
  assert.equal(normalizeTrustedProductionAppUrl("https://attacker.example.net/invite/token"), null);
  assert.equal(resolveTrustedProductionAppOrigin("https://attacker.example.net"), "https://ai-phone-agent-production-6811.up.railway.app");
  assert.equal(normalizeStrictMailbox("SMIRK <alerts@smirkcalls.com>"), "alerts@smirkcalls.com");
  assert.equal(normalizeStrictMailbox("a@b..com"), null);
  assert.equal(normalizeStrictMailbox("a@-bad.com"), null);
  assert.deepEqual(parseStrictMailboxList("a@b..com; valid@smirkcalls.com, owner@example.com"), ["valid@smirkcalls.com"]);
  const alertAliasKeys = ["NOTIFICATION_EMAIL", "OWNER_ALERT_EMAIL", "OWNER_EMAIL", "OPERATOR_EMAIL"];
  assert.equal(evaluateCanonicalMailboxAliases({
    NOTIFICATION_EMAIL: "operator@smirkcalls.com",
    OWNER_ALERT_EMAIL: "operator@smirkcalls.com",
    OWNER_EMAIL: "operator@smirkcalls.com",
    OPERATOR_EMAIL: "operator@smirkcalls.com",
  }, alertAliasKeys).ready, true);
  const divergentAlertAliases = evaluateCanonicalMailboxAliases({
    NOTIFICATION_EMAIL: "operator@smirkcalls.com",
    OWNER_ALERT_EMAIL: "operator@smirkcalls.com",
    OWNER_EMAIL: "stale-recipient@smirkcalls.com",
    OPERATOR_EMAIL: "operator@smirkcalls.com",
  }, alertAliasKeys);
  assert.equal(divergentAlertAliases.ready, false);
  assert.match(divergentAlertAliases.blockers.join("; "), /exactly equal/);
  assert.equal(evaluateCanonicalMailboxAliases({
    NOTIFICATION_EMAIL: "operator@smirkcalls.com",
    OWNER_ALERT_EMAIL: "operator@smirkcalls.com",
    OWNER_EMAIL: "operator@smirkcalls.com",
  }, alertAliasKeys).ready, false);

  const buyerInput = {
    checkoutSessionId: "cs_live_fixture_12345678",
    businessName: "Fixture Plumbing",
    ownerEmail: "buyer@example.net",
    plan: "starter",
    inviteLink: `https://smirkcalls.com/invite/${"a".repeat(64)}`,
    inviteExpiresAt: "2030-01-02T03:04:05.000Z",
    source: "stripe_checkout_completed",
  };
  const first = await sendBuyerActivationEmail(buyerInput);
  const second = await sendBuyerActivationEmail(buyerInput);
  assert.equal(first.sent, true);
  assert.equal(first.providerMessageId, "email_fixture_123");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body.to, [buyerInput.ownerEmail]);
  assert.equal(JSON.stringify(calls[0].body).includes("operator@smirkcalls.com"), false);
  assert.equal(calls[0].body.text.includes(buyerInput.inviteLink), true);
  assert.equal(calls[0].body.text.includes(buyerInput.inviteExpiresAt), true);
  assert.equal(calls[0].body.text.includes(`https://smirkcalls.com/success?session_id=${buyerInput.checkoutSessionId}`), true);
  assert.equal(calls[0].headers.get("idempotency-key"), calls[1].headers.get("idempotency-key"));
  assert.match(String(calls[0].headers.get("idempotency-key")), /^smirk_buyer_activation_cs_live_fixture_12345678_[a-f0-9]{24}$/);

  const callsBeforeInvalidSender = calls.length;
  process.env.FROM_EMAIL = "SMIRK <a@b..com>";
  const invalidSender = await sendBuyerActivationEmail({ ...buyerInput, checkoutSessionId: "cs_live_fixture_invalid_sender" });
  assert.equal(invalidSender.sent, false);
  assert.equal(invalidSender.retryable, true);
  assert.equal(invalidSender.skippedReason, "valid FROM_EMAIL missing");
  assert.equal(calls.length, callsBeforeInvalidSender);
  process.env.FROM_EMAIL = "SMIRK <hello@smirkcalls.com>";

  const rotatedInvite = await sendBuyerActivationEmail({
    ...buyerInput,
    inviteLink: `https://smirkcalls.com/invite/${"b".repeat(64)}`,
  });
  assert.equal(rotatedInvite.sent, true);
  assert.notEqual(calls[1].headers.get("idempotency-key"), calls[2].headers.get("idempotency-key"));

  const promoInput = {
    provisioningRequestId: 41,
    businessName: buyerInput.businessName,
    ownerEmail: buyerInput.ownerEmail,
    inviteLink: `https://smirkcalls.com/invite/${"c".repeat(64)}`,
    inviteExpiresAt: "2030-01-02T03:04:05.000Z",
    promoExpiresAt: "2030-01-01T04:00:00.000Z",
  };
  const firstPromo = await sendPromoActivationEmail(promoInput);
  const retryPromo = await sendPromoActivationEmail(promoInput);
  assert.equal(firstPromo.sent, true);
  assert.equal(retryPromo.sent, true);
  assert.equal(calls[3].headers.get("idempotency-key"), calls[4].headers.get("idempotency-key"));
  assert.match(String(calls[3].headers.get("idempotency-key")), /^smirk_promo_activation_41_[a-f0-9]{24}$/);
  assert.equal(calls[3].body.text.includes(promoInput.inviteLink), true);
  assert.equal(calls[3].body.text.includes(promoInput.promoExpiresAt), true);
  assert.equal(calls[3].body.text.includes("No payment was collected"), true);
  const rotatedPromo = await sendPromoActivationEmail({ ...promoInput, inviteLink: `https://smirkcalls.com/invite/${"d".repeat(64)}` });
  assert.equal(rotatedPromo.sent, true);
  assert.notEqual(calls[4].headers.get("idempotency-key"), calls[5].headers.get("idempotency-key"));

  const operatorAlertInput = {
    event: "stripe_workspace_created" as const,
    businessName: buyerInput.businessName,
    ownerEmail: buyerInput.ownerEmail,
    plan: buyerInput.plan,
    source: buyerInput.source,
    status: "workspace_created",
    provisioningRequestId: 17,
    workspaceId: 29,
    deliveryScope: "cs_live_fixture_operator_1",
  };
  const firstOperatorAlert = await sendProvisioningAlert(operatorAlertInput);
  const secondOperatorAlert = await sendProvisioningAlert(operatorAlertInput);
  assert.equal(firstOperatorAlert.sent, true);
  assert.equal(secondOperatorAlert.sent, true);
  assert.deepEqual(calls[6].body.to, ["operator@smirkcalls.com"]);
  assert.equal(calls[6].headers.get("idempotency-key"), calls[7].headers.get("idempotency-key"));
  assert.match(String(calls[6].headers.get("idempotency-key")), /^smirk_operator_alert_[a-f0-9]{32}$/);
  assert.ok(calls[6].signal instanceof AbortSignal, "Resend delivery must have a bounded timeout signal");
  await sendProvisioningAlert({ ...operatorAlertInput, deliveryScope: "cs_live_fixture_operator_2" });
  assert.notEqual(calls[7].headers.get("idempotency-key"), calls[8].headers.get("idempotency-key"), "distinct Checkout Sessions must not collide on operator-alert idempotency");

  const manualReceiptInput = {
    deliveryScope: "manual_setup_73",
    businessName: buyerInput.businessName,
    ownerEmail: buyerInput.ownerEmail,
    ownerPhone: "+17755550123",
    intakeNotes: "Morning callback; main business line needs missed-call coverage.",
    bookingLink: "https://calendly.com/smirkcalls/setup",
  };
  const callsBeforeManualReceipt = calls.length;
  const manualReceipt = await sendManualSetupReceipt(manualReceiptInput);
  const repeatedManualReceipt = await sendManualSetupReceipt(manualReceiptInput);
  assert.equal(manualReceipt.sent, true);
  assert.equal(repeatedManualReceipt.sent, true);
  assert.equal(calls.length, callsBeforeManualReceipt + 2);
  assert.deepEqual(calls.at(-2)?.body.to, [buyerInput.ownerEmail]);
  assert.equal(calls.at(-2)?.body.text.includes("did not create a charge or an active workspace"), true);
  assert.equal(calls.at(-2)?.body.text.includes("setup notes were saved"), true);
  assert.equal(calls.at(-2)?.body.text.includes(manualReceiptInput.bookingLink), true);
  assert.equal(calls.at(-2)?.headers.get("idempotency-key"), calls.at(-1)?.headers.get("idempotency-key"));
  assert.match(String(calls.at(-2)?.headers.get("idempotency-key")), /^smirk_manual_setup_receipt_[a-f0-9]{32}$/);
  const unsafeBookingReceipt = await sendManualSetupReceipt({
    ...manualReceiptInput,
    deliveryScope: "manual_setup_74",
    bookingLink: "http://127.0.0.1/operator",
  });
  assert.equal(unsafeBookingReceipt.sent, true);
  assert.equal(calls.at(-1)?.body.text.includes("127.0.0.1"), false);

  process.env.OWNER_ALERT_EMAIL = "a@b..com; a@-bad.com; owner@example.com";
  const callsBeforeMalformedRecipients = calls.length;
  const malformedOnlyRecipients = await sendProvisioningAlert({ ...operatorAlertInput, deliveryScope: "evt_live_malformed_recipients" });
  assert.equal(malformedOnlyRecipients.sent, false);
  assert.equal(malformedOnlyRecipients.retryable, true);
  assert.equal(malformedOnlyRecipients.skippedReason, "no valid operator alert recipients configured");
  assert.equal(calls.length, callsBeforeMalformedRecipients);
  process.env.OWNER_ALERT_EMAIL = "a@b..com; operator@smirkcalls.com, owner@example.com";

  const callsBeforeAdversarialSmokeText = calls.length;
  const realBuyerWithSmokeText = await sendBuyerActivationEmail({
    ...buyerInput,
    ownerEmail: "smoke+stripe-fixture@example.net",
    businessName: "SMIRK Smoke Plumbing",
    source: "gate3-stripe-webhook-smoke",
  });
  assert.equal(realBuyerWithSmokeText.sent, true);
  assert.equal(calls.length, callsBeforeAdversarialSmokeText + 1, "buyer-controlled smoke-looking text must not suppress delivery");

  const callsBeforeSmoke = calls.length;
  const smoke = await sendBuyerActivationEmail({
    ...buyerInput,
    approvedSyntheticSmoke: true,
  });
  assert.equal(smoke.sent, false);
  assert.equal(smoke.skippedReason, "approved synthetic smoke");
  assert.equal(calls.length, callsBeforeSmoke);

  const realAlertWithSmokeText = await sendProvisioningAlert({
    ...operatorAlertInput,
    ownerEmail: "smoke+stripe-fixture@example.net",
    businessName: "SMIRK Smoke Plumbing",
    source: "gate3-stripe-webhook-smoke",
    deliveryScope: "evt_live_real_buyer_smoke_text",
  });
  assert.equal(realAlertWithSmokeText.sent, true);
  const callsBeforeApprovedAlertSmoke = calls.length;
  const approvedAlertSmoke = await sendProvisioningAlert({
    ...operatorAlertInput,
    approvedSyntheticSmoke: true,
    deliveryScope: "evt_smirk_paid_handoff_fixture",
  });
  assert.equal(approvedAlertSmoke.sent, false);
  assert.equal(approvedAlertSmoke.skippedReason, "approved synthetic smoke");
  assert.equal(calls.length, callsBeforeApprovedAlertSmoke);

  process.env.APP_URL = "https://attacker.example.net";
  const callsBeforeUnsafeAppUrl = calls.length;
  const safeRecoveryDelivery = await sendBuyerActivationEmail({
    ...buyerInput,
    checkoutSessionId: "cs_live_fixture_safe_app_url",
    inviteLink: `https://smirkcalls.com/invite/${"e".repeat(64)}`,
  });
  assert.equal(safeRecoveryDelivery.sent, true);
  assert.equal(calls.length, callsBeforeUnsafeAppUrl + 1);
  assert.equal(calls.at(-1)?.body.text.includes("attacker.example.net"), false);
  assert.equal(calls.at(-1)?.body.text.includes("https://ai-phone-agent-production-6811.up.railway.app/success?session_id=cs_live_fixture_safe_app_url"), true);
  process.env.APP_URL = "https://smirkcalls.com";

  delete process.env.RESEND_API_KEY;
  const missingConfig = await sendBuyerActivationEmail(buyerInput);
  assert.equal(missingConfig.sent, false);
  assert.equal(missingConfig.retryable, true);
  assert.equal(missingConfig.skippedReason, "RESEND_API_KEY missing");

  process.env.RESEND_API_KEY = "re_fixture";
  globalThis.fetch = async () => new Response("temporary outage", { status: 503 });
  const transient = await sendBuyerActivationEmail(buyerInput);
  assert.equal(transient.sent, false);
  assert.equal(transient.retryable, true);
  const transientAlert = await sendProvisioningAlert({ ...operatorAlertInput, deliveryScope: "evt_live_transient_alert" });
  assert.equal(transientAlert.sent, false);
  assert.equal(transientAlert.retryable, true);
  const transientPromo = await sendPromoActivationEmail(promoInput);
  assert.equal(transientPromo.sent, false);
  assert.equal(transientPromo.retryable, true);
  const transientManualReceipt = await sendManualSetupReceipt(manualReceiptInput);
  assert.equal(transientManualReceipt.sent, false);
  assert.equal(transientManualReceipt.retryable, true);

  globalThis.fetch = async () => new Response("invalid recipient", { status: 422 });
  const permanent = await sendBuyerActivationEmail(buyerInput);
  assert.equal(permanent.sent, false);
  assert.equal(permanent.retryable, false);
  const permanentAlert = await sendProvisioningAlert({ ...operatorAlertInput, deliveryScope: "evt_live_permanent_alert" });
  assert.equal(permanentAlert.sent, false);
  assert.equal(permanentAlert.retryable, false);
  const permanentPromo = await sendPromoActivationEmail(promoInput);
  assert.equal(permanentPromo.sent, false);
  assert.equal(permanentPromo.retryable, false);
  const permanentManualReceipt = await sendManualSetupReceipt(manualReceiptInput);
  assert.equal(permanentManualReceipt.sent, false);
  assert.equal(permanentManualReceipt.retryable, false);

  globalThis.fetch = async () => new Response("sender domain needs repair", { status: 403 });
  const repairableConfig = await sendBuyerActivationEmail(buyerInput);
  assert.equal(repairableConfig.sent, false);
  assert.equal(repairableConfig.retryable, true);

  const invalidInvite = await sendBuyerActivationEmail({ ...buyerInput, inviteLink: "https://smirkcalls.com/dashboard" });
  assert.equal(invalidInvite.sent, false);
  assert.equal(invalidInvite.retryable, true);
  assert.equal(invalidInvite.skippedReason, "valid trusted HTTPS invite link missing");
  const untrustedInvite = await sendBuyerActivationEmail({ ...buyerInput, inviteLink: `https://attacker.example.net/invite/${"f".repeat(64)}` });
  assert.equal(untrustedInvite.sent, false);
  assert.equal(untrustedInvite.retryable, true);
  assert.equal(untrustedInvite.skippedReason, "valid trusted HTTPS invite link missing");
  const inviteWithUntrustedParameters = await sendBuyerActivationEmail({
    ...buyerInput,
    inviteLink: `https://smirkcalls.com/invite/${"f".repeat(64)}?redirect=https://attacker.example.net`,
  });
  assert.equal(inviteWithUntrustedParameters.sent, false);
  assert.equal(inviteWithUntrustedParameters.retryable, true);
  assert.equal(inviteWithUntrustedParameters.skippedReason, "valid trusted HTTPS invite link missing");

  console.log("OK buyer activation, manual receipts, and operator alerts use trusted URLs, validated recipients, explicit smoke authority, and bounded idempotent retry semantics");
} finally {
  globalThis.fetch = originalFetch;
  restoreEnv();
}
