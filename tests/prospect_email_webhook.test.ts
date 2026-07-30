import assert from "node:assert/strict";
import test from "node:test";
import { Webhook } from "standardwebhooks";
import {
  classifyProspectEmailWebhookEvent,
  readProspectEmailWebhookConfig,
  verifyProspectEmailWebhook,
} from "../src/prospect-email-webhook.ts";

const webhookSecret = `whsec_${Buffer.from(
  "smirk-synthetic-webhook-secret-0001"
).toString("base64")}`;
const eventId = "evt_synthetic_resend_0001";

function webhookConfig(
  overrides: Record<string, string | undefined> = {}
) {
  return readProspectEmailWebhookConfig({
    PROSPECT_EMAIL_WEBHOOK_ENABLED: "true",
    PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET: webhookSecret,
    PROSPECT_EMAIL_WORKSPACE_ID: "7",
    PROSPECT_EMAIL_FROM: "SMIRK <outreach@smirkcalls.com>",
    PROSPECT_EMAIL_REPLY_TO: "reply@smirkcalls.com",
    ...overrides,
  });
}

function signedWebhook(payload: Record<string, unknown>) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const timestamp = new Date();
  const signature = new Webhook(webhookSecret).sign(
    eventId,
    timestamp,
    rawBody
  );
  return {
    rawBody,
    headers: {
      "svix-id": eventId,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1_000)),
      "svix-signature": signature,
    },
  };
}

function outboundEvent(type: string) {
  return {
    type,
    created_at: new Date().toISOString(),
    data: {
      created_at: new Date().toISOString(),
      email_id: "email_synthetic_0001",
      from: "SMIRK <outreach@smirkcalls.com>",
      to: ["owner@example.com"],
      subject: "Synthetic subject",
      ...(type === "email.bounced"
        ? {
            bounce: {
              message: "Synthetic bounce",
              subType: "General",
              type: "Permanent",
            },
          }
        : {}),
      ...(type === "email.failed"
        ? { failed: { reason: "Synthetic failure" } }
        : {}),
      ...(type === "email.suppressed"
        ? {
            suppressed: {
              message: "Synthetic suppression",
              type: "Suppressed",
            },
          }
        : {}),
    },
  };
}

test("webhook configuration is fail-closed", () => {
  const ready = webhookConfig();
  assert.equal(ready.enabled, true);
  assert.equal(ready.configured, true);
  assert.equal(ready.workspaceId, 7);
  assert.equal(ready.fromAddress, "outreach@smirkcalls.com");
  assert.equal(ready.replyToAddress, "reply@smirkcalls.com");

  const disabled = webhookConfig({
    PROSPECT_EMAIL_WEBHOOK_ENABLED: "false",
  });
  assert.equal(disabled.enabled, false);

  const missingSecret = webhookConfig({
    PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET: undefined,
  });
  assert.equal(missingSecret.configured, false);
  assert.equal(
    missingSecret.missing.includes(
      "PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET"
    ),
    true
  );
});

test("valid raw-body signatures verify and forged signatures fail", () => {
  const signed = signedWebhook(outboundEvent("email.delivered"));
  const verified = verifyProspectEmailWebhook({
    ...signed,
    config: webhookConfig(),
  });
  assert.equal(verified.eventId, eventId);
  assert.equal(verified.event.type, "email.delivered");
  assert.match(verified.payloadHash, /^[a-f0-9]{64}$/);

  assert.throws(() =>
    verifyProspectEmailWebhook({
      rawBody: signed.rawBody,
      headers: {
        ...signed.headers,
        "svix-signature": "v1,forged-signature",
      },
      config: webhookConfig(),
    })
  );
  assert.throws(() =>
    verifyProspectEmailWebhook({
      rawBody: Buffer.from(
        signed.rawBody.toString("utf8").replace("delivered", "bounced")
      ),
      headers: signed.headers,
      config: webhookConfig(),
    })
  );
});

test("outbound delivery and negative events map without claiming more", () => {
  const delivered = classifyProspectEmailWebhookEvent(
    outboundEvent("email.delivered") as any,
    "outreach@smirkcalls.com",
    "reply@smirkcalls.com"
  );
  assert.deepEqual(
    {
      kind: delivered.kind,
      outcome:
        delivered.kind === "outbound_outcome"
          ? delivered.outcome
          : null,
    },
    { kind: "outbound_outcome", outcome: "delivered" }
  );

  const bounced = classifyProspectEmailWebhookEvent(
    outboundEvent("email.bounced") as any,
    "outreach@smirkcalls.com",
    "reply@smirkcalls.com"
  );
  assert.equal(
    bounced.kind === "outbound_outcome"
      ? bounced.suppressionReason
      : null,
    "bounce"
  );

  const complaint = classifyProspectEmailWebhookEvent(
    outboundEvent("email.complained") as any,
    "outreach@smirkcalls.com",
    "reply@smirkcalls.com"
  );
  assert.equal(
    complaint.kind === "outbound_outcome"
      ? complaint.outcome
      : null,
    "dnc"
  );

  const wrongSender = classifyProspectEmailWebhookEvent(
    {
      ...outboundEvent("email.delivered"),
      data: {
        ...outboundEvent("email.delivered").data,
        from: "alerts@smirkcalls.com",
      },
    } as any,
    "outreach@smirkcalls.com",
    "reply@smirkcalls.com"
  );
  assert.equal(wrongSender.kind, "ignored");
});

test("inbound reply candidates require the dedicated reply mailbox", () => {
  const received = {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "email_inbound_0001",
      created_at: new Date().toISOString(),
      from: "Owner <owner@example.com>",
      to: ["reply@smirkcalls.com"],
      received_for: ["reply@smirkcalls.com"],
      bcc: [],
      cc: [],
      message_id: "message_synthetic_0001",
      subject: "Re: Synthetic subject",
      attachments: [],
    },
  };
  const candidate = classifyProspectEmailWebhookEvent(
    received as any,
    "outreach@smirkcalls.com",
    "reply@smirkcalls.com"
  );
  assert.equal(candidate.kind, "inbound_reply_candidate");
  assert.equal(
    candidate.kind === "inbound_reply_candidate"
      ? candidate.sender
      : null,
    "owner@example.com"
  );

  const unrelated = classifyProspectEmailWebhookEvent(
    {
      ...received,
      data: {
        ...received.data,
        to: ["other@smirkcalls.com"],
        received_for: ["other@smirkcalls.com"],
      },
    } as any,
    "outreach@smirkcalls.com",
    "reply@smirkcalls.com"
  );
  assert.equal(unrelated.kind, "ignored");
});

test("provider suppression additions are explicit suppression facts", () => {
  const classification = classifyProspectEmailWebhookEvent(
    {
      type: "suppression.added",
      created_at: new Date().toISOString(),
      data: {
        id: "suppression_synthetic_0001",
        email: "OWNER@EXAMPLE.COM",
        origin: "complaint",
        source_id: "email_synthetic_0001",
        created_at: new Date().toISOString(),
      },
    } as any,
    "outreach@smirkcalls.com",
    "reply@smirkcalls.com"
  );
  assert.deepEqual(
    classification.kind === "suppression_added"
      ? {
          email: classification.email,
          reason: classification.reason,
        }
      : null,
    { email: "owner@example.com", reason: "complaint" }
  );
});
