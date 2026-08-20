import assert from "node:assert/strict";
import test from "node:test";
import {
  PROSPECT_EMAIL_RECEIVING_CONFIRMATION,
  buildProspectInboundReplyContentReceipt,
  hashProspectInboundReplyContentReceipt,
  readProspectEmailReceivingConfig,
  retrieveProspectInboundReplyContentSchema,
  retrieveProspectReceivedEmail,
} from "../src/prospect-email-receiving.ts";

function configuredEnv() {
  return {
    PROSPECT_EMAIL_RECEIVING_ENABLED: "true",
    PROSPECT_EMAIL_RECEIVING_MODE: "operator-reviewed-content-v1",
    PROSPECT_EMAIL_RESEND_RECEIVING_API_KEY:
      "re_synthetic_receiving_1234567890",
    PROSPECT_EMAIL_RECEIVING_WORKSPACE_ID: "7",
    PROSPECT_EMAIL_REPLY_TO: "reply@smirkcalls.com",
    PROSPECT_EMAIL_RESEND_API_KEY: "re_synthetic_sender_123456789012",
    RESEND_API_KEY: "re_synthetic_alerts_123456789012",
    DASHBOARD_API_KEY: "synthetic-dashboard-key-123456789012",
  };
}

function providerBody(overrides: Record<string, unknown> = {}) {
  return {
    object: "email",
    id: "email_inbound_synthetic_0001",
    to: ["reply@smirkcalls.com"],
    from: "Owner <owner@example.com>",
    created_at: "2026-08-02T23:00:00.000Z",
    subject: "Re: Synthetic question",
    bcc: null,
    cc: null,
    reply_to: null,
    received_for: ["reply@smirkcalls.com"],
    html: "<strong>Do not retain this.</strong>",
    text: "  Yes, please send details.\r\nThanks.  ",
    headers: { "x-sensitive": "do-not-retain" },
    message_id: "message_synthetic_0001",
    raw: { download_url: "https://example.invalid/raw" },
    attachments: [{ id: "attachment-do-not-fetch" }],
    ...overrides,
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify(providerBody(overrides)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("receiving configuration is disabled by default and rejects reused keys", () => {
  const disabled = readProspectEmailReceivingConfig({});
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.configured, false);

  const env = configuredEnv();
  const configured = readProspectEmailReceivingConfig(env);
  assert.equal(configured.enabled, true);
  assert.equal(configured.configured, true);
  assert.deepEqual(configured.missing, []);

  env.PROSPECT_EMAIL_RESEND_RECEIVING_API_KEY =
    env.PROSPECT_EMAIL_RESEND_API_KEY;
  const reused = readProspectEmailReceivingConfig(env);
  assert.equal(reused.configured, false);
  assert.ok(
    reused.missing.includes(
      "PROSPECT_EMAIL_RECEIVING_API_KEY_SEPARATION"
    )
  );
});

test("one bounded GET returns normalized plain text and discards rich content", async () => {
  const config = readProspectEmailReceivingConfig(configuredEnv());
  let requests = 0;
  const content = await retrieveProspectReceivedEmail({
    config,
    inboundMessageId: "email_inbound_synthetic_0001",
    expectedSender: "owner@example.com",
    fetchImpl: async (input, init) => {
      requests += 1;
      const url = new URL(String(input));
      assert.equal(init?.method, "GET");
      assert.equal(
        url.pathname,
        "/emails/receiving/email_inbound_synthetic_0001"
      );
      assert.equal(url.searchParams.get("html_format"), "cid");
      assert.match(
        String((init?.headers as Record<string, string>).authorization),
        /^Bearer re_/
      );
      return response();
    },
  });
  assert.equal(requests, 1);
  assert.equal(content.sender, "owner@example.com");
  assert.equal(
    content.plainText,
    "Yes, please send details.\nThanks."
  );
  assert.match(content.contentHash, /^[a-f0-9]{64}$/);
  assert.equal("html" in content, false);
  assert.equal("headers" in content, false);
  assert.equal("attachments" in content, false);
  assert.equal("raw" in content, false);
});

test("provider identity, sender, and receiver drift fail closed", async () => {
  const config = readProspectEmailReceivingConfig(configuredEnv());
  for (const overrides of [
    { id: "different_email_id" },
    { from: "different@example.com" },
    { to: ["other@smirkcalls.com"], received_for: [] },
  ]) {
    await assert.rejects(
      retrieveProspectReceivedEmail({
        config,
        inboundMessageId: "email_inbound_synthetic_0001",
        expectedSender: "owner@example.com",
        fetchImpl: async () => response(overrides),
      }),
      (error: any) =>
        error?.code ===
        "PROSPECT_EMAIL_RECEIVING_BINDING_MISMATCH"
    );
  }
});

test("missing, oversized, malformed, and failed provider responses fail closed", async () => {
  const config = readProspectEmailReceivingConfig(configuredEnv());
  await assert.rejects(
    retrieveProspectReceivedEmail({
      config,
      inboundMessageId: "email_inbound_synthetic_0001",
      expectedSender: "owner@example.com",
      fetchImpl: async () => response({ text: null }),
    }),
    (error: any) =>
      error?.code === "PROSPECT_EMAIL_RECEIVING_TEXT_REQUIRED"
  );
  await assert.rejects(
    retrieveProspectReceivedEmail({
      config,
      inboundMessageId: "email_inbound_synthetic_0001",
      expectedSender: "owner@example.com",
      fetchImpl: async () => response({ text: "x".repeat(21_000) }),
    }),
    (error: any) =>
      error?.code === "PROSPECT_EMAIL_RECEIVING_TEXT_TOO_LARGE"
  );
  await assert.rejects(
    retrieveProspectReceivedEmail({
      config,
      inboundMessageId: "email_inbound_synthetic_0001",
      expectedSender: "owner@example.com",
      fetchImpl: async () =>
        new Response("not json", { status: 200 }),
    }),
    (error: any) =>
      error?.code === "PROSPECT_EMAIL_RECEIVING_RESPONSE_INVALID"
  );
  await assert.rejects(
    retrieveProspectReceivedEmail({
      config,
      inboundMessageId: "email_inbound_synthetic_0001",
      expectedSender: "owner@example.com",
      fetchImpl: async () =>
        new Response("provider unavailable", { status: 503 }),
    }),
    (error: any) =>
      error?.code === "PROSPECT_EMAIL_RECEIVING_PROVIDER_REJECTED"
  );
});

test("content receipts bind the exact request, actor, and normalized text", async () => {
  const config = readProspectEmailReceivingConfig(configuredEnv());
  const request = retrieveProspectInboundReplyContentSchema.parse({
    payloadHash: "a".repeat(64),
    confirmation: PROSPECT_EMAIL_RECEIVING_CONFIRMATION,
    attestations: {
      noContactAuthorized: true,
      noSendAuthorized: true,
      attachmentsNotRequested: true,
      htmlWillNotBeStored: true,
    },
  });
  const content = await retrieveProspectReceivedEmail({
    config,
    inboundMessageId: "email_inbound_synthetic_0001",
    expectedSender: "owner@example.com",
    fetchImpl: async () => response(),
  });
  const receipt = buildProspectInboundReplyContentReceipt({
    reviewId: "11111111-1111-4111-8111-111111111111",
    workspaceId: 7,
    providerEventId: "evt_inbound_reply_synthetic_0001",
    replyReviewPayloadHash: "a".repeat(64),
    request,
    content,
    retrievedBy: "dashboard_operator:synthetic",
    retrievedAt: "2026-08-02T23:05:00.000Z",
  });
  assert.equal(receipt.contactAuthorized, false);
  assert.equal(receipt.sendAuthorized, false);
  assert.equal(receipt.htmlStored, false);
  assert.equal(receipt.attachmentsFetched, false);
  assert.match(
    hashProspectInboundReplyContentReceipt(receipt),
    /^[a-f0-9]{64}$/
  );
  assert.throws(() =>
    hashProspectInboundReplyContentReceipt({
      ...receipt,
      plainText: `${receipt.plainText} changed`,
    })
  );
});
