import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVelvetOutcomePayload,
  dispatchVelvetOutcome,
  hashVelvetOutcomePayload,
  readVelvetOutcomeDispatchConfig,
  signVelvetOutcomePayload,
} from "../src/velvet-outcome.ts";

const payload = buildVelvetOutcomePayload({
  workspaceId: 1,
  externalProspectId: "velvet-owner-7-lead-42",
  externalEventId: "smirk-outcome-00000001",
  outreachApprovalId: "0dbe230c-9f38-4c2c-9496-6fdd0f0605b6",
  channel: "email",
  outcome: "replied",
  occurredAt: "2026-07-30T16:00:00.000Z",
  evidenceHash: "a".repeat(64),
  outreachPayloadHash: "b".repeat(64),
});

test("builds a source-linked Velvet outcome payload", () => {
  assert.equal(payload.contractVersion, "smirk-velvet.outcome.v1");
  assert.equal(payload.externalProspectId, "velvet-owner-7-lead-42");
  assert.equal(
    hashVelvetOutcomePayload(payload),
    "1e24065d987b4c58e3c670a6d8ee42e9624d5da2a2d250d6c95736bf9e6cfc6d"
  );
});

test("signs the same canonical event contract Velvet verifies", () => {
  const signature = signVelvetOutcomePayload(
    payload,
    "1785427260",
    "smirk-outcome-test-secret-000000000001"
  );
  assert.equal(
    signature,
    "sha256=8adf6534e6c6c9de90aa10681620f63f90c0d275303afed3d21621ffda5b3bd0"
  );
});

test("refuses to sign with a weak secret", () => {
  assert.throws(() =>
    signVelvetOutcomePayload(payload, "1785427260", "weak")
  );
});

test("dispatch remains fail-closed until explicitly configured and enabled", async () => {
  let calls = 0;
  const result = await dispatchVelvetOutcome(
    payload,
    readVelvetOutcomeDispatchConfig({}),
    async () => {
      calls += 1;
      return new Response();
    }
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "VELVET_OUTCOME_DISPATCH_DISABLED");
  assert.equal(calls, 0);
});

test("maps recorded and duplicate Velvet receipts as success", async () => {
  const config = readVelvetOutcomeDispatchConfig({
    VELVET_BASE_URL: "https://velvetalchemy.manus.space",
    VELVET_OUTCOME_API_KEY: "velvet-outcome-api-key-000000000001",
    VELVET_OUTCOME_SIGNING_SECRET:
      "smirk-outcome-test-secret-000000000001",
    VELVET_OUTCOME_WORKSPACE_ID: "1",
    VELVET_OUTCOME_DISPATCH_ENABLED: "true",
  });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await dispatchVelvetOutcome(
    payload,
    config,
    async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          success: true,
          state: "DUPLICATE",
          eventId: 17,
          externalAction: "none",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
    new Date("2026-07-30T16:01:00.000Z")
  );
  assert.deepEqual(result, {
    success: true,
    state: "DUPLICATE",
    eventId: 17,
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://velvetalchemy.manus.space/api/v1/leads/42/outcome"
  );
  assert.match(
    String((calls[0].init?.headers as Record<string, string>)["X-SMIRK-Signature"]),
    /^sha256=[a-f0-9]{64}$/
  );
});

test("workspace mismatch blocks before transport", async () => {
  const config = readVelvetOutcomeDispatchConfig({
    VELVET_BASE_URL: "https://velvetalchemy.manus.space",
    VELVET_OUTCOME_API_KEY: "velvet-outcome-api-key-000000000001",
    VELVET_OUTCOME_SIGNING_SECRET:
      "smirk-outcome-test-secret-000000000001",
    VELVET_OUTCOME_WORKSPACE_ID: "99",
    VELVET_OUTCOME_DISPATCH_ENABLED: "true",
  });
  let calls = 0;
  const result = await dispatchVelvetOutcome(
    payload,
    config,
    async () => {
      calls += 1;
      return new Response();
    }
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "VELVET_OUTCOME_WORKSPACE_MISMATCH");
  assert.equal(calls, 0);
});

test("uncertain and definitive callback failures remain distinct", async () => {
  const config = readVelvetOutcomeDispatchConfig({
    VELVET_BASE_URL: "https://velvetalchemy.manus.space",
    VELVET_OUTCOME_API_KEY: "velvet-outcome-api-key-000000000001",
    VELVET_OUTCOME_SIGNING_SECRET:
      "smirk-outcome-test-secret-000000000001",
    VELVET_OUTCOME_WORKSPACE_ID: "1",
    VELVET_OUTCOME_DISPATCH_ENABLED: "true",
  });
  const uncertain = await dispatchVelvetOutcome(
    payload,
    config,
    async () =>
      new Response(JSON.stringify({ error: "Try later" }), {
        status: 503,
      })
  );
  assert.equal(uncertain.success, false);
  assert.equal(uncertain.outcomeUnknown, true);
  assert.equal(uncertain.retryable, true);

  const definitive = await dispatchVelvetOutcome(
    payload,
    config,
    async () =>
      new Response(
        JSON.stringify({
          code: "SMIRK_OUTCOME_SIGNATURE_INVALID",
          error: "Signature invalid",
        }),
        { status: 401 }
      )
  );
  assert.equal(definitive.success, false);
  assert.equal(definitive.outcomeUnknown, false);
  assert.equal(definitive.retryable, false);

  const redacted = await dispatchVelvetOutcome(
    payload,
    config,
    async () =>
      new Response(
        JSON.stringify({
          code: "REMOTE_ERROR",
          error: `Do not expose ${config.apiKey} or ${config.signingSecret}`,
        }),
        { status: 400 }
      )
  );
  assert.equal(redacted.success, false);
  assert.doesNotMatch(String(redacted.error), /velvet-outcome-api-key/);
  assert.doesNotMatch(String(redacted.error), /smirk-outcome-test-secret/);
  assert.match(String(redacted.error), /\[redacted\]/);

  const timedOut = await dispatchVelvetOutcome(
    payload,
    config,
    async () => {
      throw new Error("synthetic timeout");
    }
  );
  assert.equal(timedOut.success, false);
  assert.equal(timedOut.outcomeUnknown, true);
  assert.equal(timedOut.retryable, true);
});
