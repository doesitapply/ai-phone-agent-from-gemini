import assert from "node:assert/strict";
import test from "node:test";
import {
  PROSPECT_EMAIL_EXECUTION_CONFIRMATION,
  PROSPECT_EMAIL_EXECUTION_MODE,
  buildProspectEmailIdempotencyKey,
  readProspectEmailProviderConfig,
  sendApprovedProspectEmail,
} from "../src/prospect-email-provider.ts";
import {
  buildProspectOutreachPayload,
  hashProspectOutreachPayload,
} from "../src/prospect-outreach.ts";

const approvalId = "11111111-1111-4111-8111-111111111111";
const evidenceHash = "a".repeat(64);

function providerEnv(
  overrides: Record<string, string | undefined> = {}
) {
  return {
    PROSPECT_EMAIL_EXECUTION_ENABLED: "true",
    PROSPECT_EMAIL_EXECUTION_MODE,
    PROSPECT_EMAIL_RESEND_API_KEY: "re_abcdefghijklmnop",
    PROSPECT_EMAIL_FROM: "SMIRK <outreach@smirkcalls.com>",
    PROSPECT_EMAIL_REPLY_TO: "reply@smirkcalls.com",
    PROSPECT_EMAIL_WORKSPACE_ID: "7",
    PROSPECT_EMAIL_DAILY_RECIPIENT_CAP: "3",
    PROSPECT_EMAIL_DAILY_SPEND_CAP_CENTS: "10",
    PROSPECT_EMAIL_UNIT_COST_CENTS: "2",
    ...overrides,
  };
}

function emailPayload(overrides: {
  senderIdentity?: string;
  recipient?: string;
  maxCostCents?: number;
} = {}) {
  return buildProspectOutreachPayload({
    workspaceId: 7,
    campaignId: 17,
    prospectId: 23,
    recipient: overrides.recipient || "owner@example.com",
    evidenceHash,
    preparedAt: "2026-07-30T16:00:00.000Z",
    draft: {
      channel: "email",
      subject: "Capturing urgent plumbing calls",
      body:
        "I noticed a possible mobile booking issue that may be creating friction. Would one review-only proof call be useful?",
      emailCompliance: {
        senderIdentity: overrides.senderIdentity || "SMIRK",
        advertisementDisclosure:
          "This is a commercial message from SMIRK.",
        physicalPostalAddress: "100 Example Way, Reno, NV 89501",
        optOutInstructions:
          "If this is not relevant, reply no and I will not follow up.",
      },
      maxCostCents: overrides.maxCostCents ?? 2,
      expiresInHours: 24,
    },
  });
}

function executionInput(options: {
  payload?: ReturnType<typeof emailPayload>;
  config?: ReturnType<typeof readProspectEmailProviderConfig>;
  fetchImpl?: typeof fetch;
} = {}) {
  const payload = options.payload || emailPayload();
  const payloadHash = hashProspectOutreachPayload(payload);
  const idempotencyKey = buildProspectEmailIdempotencyKey({
    approvalId,
    payloadHash,
  });
  return {
    payload,
    payloadHash,
    approvalId,
    idempotencyKey,
    config:
      options.config ||
      readProspectEmailProviderConfig(providerEnv()),
    fetchImpl: options.fetchImpl,
  };
}

test("provider config is fail-closed and uses a dedicated execution mode", () => {
  const ready = readProspectEmailProviderConfig(providerEnv());
  assert.equal(ready.enabled, true);
  assert.equal(ready.configured, true);
  assert.equal(ready.mode, PROSPECT_EMAIL_EXECUTION_MODE);
  assert.equal(ready.workspaceId, 7);
  assert.equal(ready.dailyRecipientCap, 3);

  const disabled = readProspectEmailProviderConfig(
    providerEnv({ PROSPECT_EMAIL_EXECUTION_ENABLED: "false" })
  );
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.configured, true);

  const genericKey = readProspectEmailProviderConfig(
    providerEnv({ PROSPECT_EMAIL_RESEND_API_KEY: undefined })
  );
  assert.equal(genericKey.configured, false);
  assert.deepEqual(genericKey.missing, [
    "PROSPECT_EMAIL_RESEND_API_KEY",
  ]);

  const reusedTransactionalKey = readProspectEmailProviderConfig(
    providerEnv({ RESEND_API_KEY: "re_abcdefghijklmnop" })
  );
  assert.equal(reusedTransactionalKey.configured, false);
  assert.deepEqual(reusedTransactionalKey.missing, [
    "PROSPECT_EMAIL_RESEND_API_KEY",
  ]);
});

test("execution confirmation is explicit and stable", () => {
  assert.equal(
    PROSPECT_EMAIL_EXECUTION_CONFIRMATION,
    "send-one-approved-email-v1"
  );
  const payload = emailPayload();
  const payloadHash = hashProspectOutreachPayload(payload);
  assert.equal(
    buildProspectEmailIdempotencyKey({ approvalId, payloadHash }),
    buildProspectEmailIdempotencyKey({ approvalId, payloadHash })
  );
  assert.throws(() =>
    buildProspectEmailIdempotencyKey({
      approvalId: "public-target-id",
      payloadHash,
    })
  );
});

test("disabled execution never calls the provider", async () => {
  let requests = 0;
  const result = await sendApprovedProspectEmail(
    executionInput({
      config: readProspectEmailProviderConfig(
        providerEnv({ PROSPECT_EMAIL_EXECUTION_ENABLED: "false" })
      ),
      fetchImpl: (async () => {
        requests += 1;
        throw new Error("must not run");
      }) as typeof fetch,
    })
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "PROSPECT_EMAIL_EXECUTION_DISABLED");
  assert.equal(requests, 0);
});

test("one approved recipient produces one bounded Resend request", async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  const input = executionInput({
    fetchImpl: (async (
      rawInput: string | URL | Request,
      init?: RequestInit
    ) => {
      requests.push({ input: String(rawInput), init });
      return new Response(
        JSON.stringify({ id: "email_synthetic_0001" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }) as typeof fetch,
  });
  const result = await sendApprovedProspectEmail(input);

  assert.equal(result.status, "accepted");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, "https://api.resend.com/emails");
  assert.equal(requests[0].init?.method, "POST");
  const headers = requests[0].init?.headers as Record<string, string>;
  assert.equal(headers["Idempotency-Key"], input.idempotencyKey);
  const body = JSON.parse(String(requests[0].init?.body));
  assert.deepEqual(body.to, ["owner@example.com"]);
  assert.equal(body.from, "SMIRK <outreach@smirkcalls.com>");
  assert.equal(body.reply_to, "reply@smirkcalls.com");
  assert.equal("cc" in body, false);
  assert.equal("bcc" in body, false);
  assert.equal("sms" in body, false);
});

test("payload and sender mismatches are blocked before fetch", async () => {
  let requests = 0;
  const result = await sendApprovedProspectEmail(
    executionInput({
      payload: emailPayload({ senderIdentity: "Different Sender" }),
      fetchImpl: (async () => {
        requests += 1;
        throw new Error("must not run");
      }) as typeof fetch,
    })
  );
  assert.equal(result.status, "blocked");
  assert.equal(
    result.code,
    "PROSPECT_EMAIL_INVALID_APPROVED_PAYLOAD"
  );
  assert.equal(requests, 0);

  const validPayload = emailPayload();
  const mismatchedHash = await sendApprovedProspectEmail({
    ...executionInput({
      payload: validPayload,
      fetchImpl: (async () => {
        requests += 1;
        throw new Error("must not run");
      }) as typeof fetch,
    }),
    payloadHash: "b".repeat(64),
    idempotencyKey: buildProspectEmailIdempotencyKey({
      approvalId,
      payloadHash: "b".repeat(64),
    }),
  });
  assert.equal(mismatchedHash.status, "blocked");
  assert.equal(requests, 0);
});

test("definitive failures and uncertain outcomes remain distinct", async () => {
  const invalid = await sendApprovedProspectEmail(
    executionInput({
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            name: "validation_error",
            message: "Recipient is invalid.",
          }),
          { status: 422 }
        )) as typeof fetch,
    })
  );
  assert.equal(invalid.status, "definitive_failure");
  assert.equal(invalid.retryable, false);

  const rateLimited = await sendApprovedProspectEmail(
    executionInput({
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            name: "rate_limit_exceeded",
            message: "Try later.",
          }),
          { status: 429 }
        )) as typeof fetch,
    })
  );
  assert.equal(rateLimited.status, "outcome_unknown");
  assert.equal(rateLimited.retryable, true);

  const missingId = await sendApprovedProspectEmail(
    executionInput({
      fetchImpl: (async () =>
        new Response(JSON.stringify({}), { status: 200 })) as typeof fetch,
    })
  );
  assert.equal(missingId.status, "outcome_unknown");
  assert.equal(
    missingId.code,
    "PROSPECT_EMAIL_PROVIDER_ID_MISSING"
  );

  const networkUncertain = await sendApprovedProspectEmail(
    executionInput({
      fetchImpl: (async () => {
        throw new Error("synthetic timeout");
      }) as typeof fetch,
    })
  );
  assert.equal(networkUncertain.status, "outcome_unknown");
  assert.equal(networkUncertain.retryable, true);
});
