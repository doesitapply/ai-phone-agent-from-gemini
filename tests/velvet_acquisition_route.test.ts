import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import {
  VelvetAcquisitionStoreError,
  createVelvetAcquisitionHandler,
  type VelvetAcquisitionStore,
} from "../src/routes/velvet-acquisition-routes.ts";
import { readVelvetAcquisitionConfig } from "../src/velvet-acquisition.ts";

const configuredEnv = {
  VELVET_ALCHEMY_ACQUISITION_API_KEY: "velvet-synthetic-acquisition-test-token-0001",
  VELVET_ALCHEMY_ACQUISITION_MODE: "synthetic-fixture-only-v1",
  VELVET_ALCHEMY_WORKSPACE_ID: "42",
};

const validSyntheticPayload = {
  workspaceId: 42,
  recordKind: "synthetic",
  sourceRecordId: "velvet-manus-fake-lead-00000001",
  sourceEventId: "velvet-manus-fake-event-00000001",
  caller: {
    phone: "+12025550124",
    name: "Test Caller",
  },
  companyName: "Velvet Test Co",
  reason: "Synthetic callback handoff integration test.",
  urgency: "low",
};

function makeResponse() {
  const state: { statusCode: number; body: unknown } = { statusCode: 200, body: undefined };
  const response = {
    status(code: number) {
      state.statusCode = code;
      return response;
    },
    json(body: unknown) {
      state.body = body;
      return response;
    },
  };
  return { response: response as unknown as Response, state };
}

test("records a synthetic Velvet acquisition without creating sales-queue work", async () => {
  const received: unknown[] = [];
  const store: VelvetAcquisitionStore = {
    async receive(input) {
      received.push(input);
      return {
        outcome: "created",
        receiptId: "ace_abcdef0123456789abcdef0123456789abcdef01",
        acquisitionId: "acq_0123456789abcdef0123456789abcdef01234567",
        recordKind: "synthetic",
        contactPermission: "not_permitted",
        contactBasis: "synthetic_fixture",
      };
    },
  };
  const handler = createVelvetAcquisitionHandler({
    dbEnabled: true,
    isSchemaReady: () => true,
    env: configuredEnv,
    store,
    log: () => {},
  });
  const { response, state } = makeResponse();

  await handler({
    headers: { authorization: `Bearer ${configuredEnv.VELVET_ALCHEMY_ACQUISITION_API_KEY}` },
    body: validSyntheticPayload,
    ip: "127.0.0.1",
    requestId: "test-request",
  } as unknown as Request, response, () => undefined);

  assert.equal(state.statusCode, 201);
  assert.deepEqual(state.body, {
    ok: true,
    state: "RECEIVED",
    receiptId: "ace_abcdef0123456789abcdef0123456789abcdef01",
    acquisitionId: "acq_0123456789abcdef0123456789abcdef01234567",
    recordKind: "synthetic",
    contactPermission: "not_permitted",
    contactBasis: "synthetic_fixture",
    externalAction: "none",
    handoffId: null,
    taskId: null,
    feedbackIdentity: {
      acquisitionId: "acq_0123456789abcdef0123456789abcdef01234567",
      sourceSystem: "velvet_alchemy",
      sourceRecordId: "velvet-manus-fake-lead-00000001",
    },
  });
  assert.equal(received.length, 1);
  assert.equal((received[0] as any).sourceRecordId, "velvet-manus-fake-lead-00000001");
  assert.equal((received[0] as any).sourceEventId, "velvet-manus-fake-event-00000001");
});

test("rejects a changed replay under the same source event identity", async () => {
  const handler = createVelvetAcquisitionHandler({
    dbEnabled: true,
    isSchemaReady: () => true,
    env: configuredEnv,
    store: {
      async receive() {
        throw new VelvetAcquisitionStoreError(
          "This source event ID was already used for different evidence.",
          "VELVET_ALCHEMY_IDEMPOTENCY_CONFLICT",
          409,
        );
      },
    },
    log: () => {},
  });
  const { response, state } = makeResponse();

  await handler({
    headers: { authorization: `Bearer ${configuredEnv.VELVET_ALCHEMY_ACQUISITION_API_KEY}` },
    body: validSyntheticPayload,
    ip: "127.0.0.1",
    requestId: "test-request",
  } as unknown as Request, response, () => undefined);

  assert.equal(state.statusCode, 409);
  assert.deepEqual(state.body, {
    error: "This source event ID was already used for different evidence.",
    code: "VELVET_ALCHEMY_IDEMPOTENCY_CONFLICT",
  });
});

test("fails closed until the acquisition schema is ready", async () => {
  let storeCalls = 0;
  const handler = createVelvetAcquisitionHandler({
    dbEnabled: true,
    isSchemaReady: () => false,
    env: configuredEnv,
    store: {
      async receive() {
        storeCalls += 1;
        throw new Error("must not store");
      },
    },
    log: () => {},
  });
  const { response, state } = makeResponse();

  await handler({
    headers: { authorization: `Bearer ${configuredEnv.VELVET_ALCHEMY_ACQUISITION_API_KEY}` },
    body: validSyntheticPayload,
  } as unknown as Request, response, () => undefined);

  assert.equal(state.statusCode, 503);
  assert.deepEqual(state.body, {
    error: "Velvet Alchemy acquisition schema is not ready.",
    code: "VELVET_ALCHEMY_ACQUISITION_SCHEMA_NOT_READY",
  });
  assert.equal(storeCalls, 0);
});

test("rejects configuration, authentication, tenant, and synthetic-boundary failures before storage", async () => {
  const cases = [
    { env: {}, authorization: "Bearer anything", body: validSyntheticPayload, status: 503, code: "VELVET_ALCHEMY_ACQUISITION_NOT_CONFIGURED" },
    { env: configuredEnv, authorization: "Bearer forged-token", body: validSyntheticPayload, status: 401, code: "VELVET_ALCHEMY_ACQUISITION_UNAUTHORIZED" },
    { env: configuredEnv, authorization: `Bearer ${configuredEnv.VELVET_ALCHEMY_ACQUISITION_API_KEY}`, body: { ...validSyntheticPayload, workspaceId: 43 }, status: 403, code: "VELVET_ALCHEMY_WORKSPACE_MISMATCH" },
    {
      env: configuredEnv,
      authorization: `Bearer ${configuredEnv.VELVET_ALCHEMY_ACQUISITION_API_KEY}`,
      body: { ...validSyntheticPayload, caller: { ...validSyntheticPayload.caller, phone: "+17755550142" } },
      status: 409,
      code: "VELVET_ALCHEMY_ACQUISITION_CLASSIFICATION_CONFLICT",
    },
    {
      env: { ...configuredEnv, VELVET_ALCHEMY_READ_KEY: configuredEnv.VELVET_ALCHEMY_ACQUISITION_API_KEY },
      authorization: `Bearer ${configuredEnv.VELVET_ALCHEMY_ACQUISITION_API_KEY}`,
      body: validSyntheticPayload,
      status: 503,
      code: "VELVET_ALCHEMY_ACQUISITION_NOT_CONFIGURED",
    },
  ];

  for (const fixture of cases) {
    let storeCalls = 0;
    const handler = createVelvetAcquisitionHandler({
      dbEnabled: true,
      isSchemaReady: () => true,
      env: fixture.env,
      store: {
        async receive() {
          storeCalls += 1;
          throw new Error("must not store");
        },
      },
      log: () => {},
    });
    const { response, state } = makeResponse();
    await handler({
      headers: { authorization: fixture.authorization },
      body: fixture.body,
      ip: "127.0.0.1",
      requestId: "test-request",
    } as unknown as Request, response, () => undefined);

    assert.equal(state.statusCode, fixture.status);
    assert.equal((state.body as any).code, fixture.code);
    assert.equal(storeCalls, 0);
  }
});

test("returns the original receipt and feedback identity for an exact replay", async () => {
  const handler = createVelvetAcquisitionHandler({
    dbEnabled: true,
    isSchemaReady: () => true,
    env: configuredEnv,
    store: {
      async receive() {
        return {
          outcome: "duplicate",
          receiptId: "ace_abcdef0123456789abcdef0123456789abcdef01",
          acquisitionId: "acq_0123456789abcdef0123456789abcdef01234567",
          recordKind: "synthetic",
          contactPermission: "not_permitted",
          contactBasis: "synthetic_fixture",
        };
      },
    },
    log: () => {},
  });
  const { response, state } = makeResponse();
  await handler({
    headers: { authorization: `Bearer ${configuredEnv.VELVET_ALCHEMY_ACQUISITION_API_KEY}` },
    body: validSyntheticPayload,
  } as unknown as Request, response, () => undefined);

  assert.equal(state.statusCode, 200);
  assert.equal((state.body as any).state, "DUPLICATE");
  assert.equal((state.body as any).receiptId, "ace_abcdef0123456789abcdef0123456789abcdef01");
  assert.deepEqual((state.body as any).feedbackIdentity, {
    acquisitionId: "acq_0123456789abcdef0123456789abcdef01234567",
    sourceSystem: "velvet_alchemy",
    sourceRecordId: "velvet-manus-fake-lead-00000001",
  });
});

test("records real Velvet evidence as unverified and held without creating contact work", async () => {
  const evidenceEnv = {
    ...configuredEnv,
    VELVET_ALCHEMY_ACQUISITION_MODE: "evidence-inbox-v1",
  };
  const realPayload = {
    workspaceId: 42,
    recordKind: "real",
    sourceRecordId: "velvet-lead-00000001",
    sourceEventId: "velvet-event-00000001",
    caller: { phone: "+17755550142", name: "Prospect Owner" },
    companyName: "Sample Plumbing Company",
    reason: "Qualified prospect needs a water-quality test and operator review.",
    urgency: "normal",
  };
  let received: any;
  const handler = createVelvetAcquisitionHandler({
    dbEnabled: true,
    isSchemaReady: () => true,
    env: evidenceEnv,
    store: {
      async receive(input) {
        received = input;
        return {
          outcome: "created",
          receiptId: "ace_1111111111111111111111111111111111111111",
          acquisitionId: "acq_2222222222222222222222222222222222222222",
          recordKind: "real",
          contactPermission: "unverified",
          contactBasis: "not_evaluated",
        };
      },
    },
    log: () => {},
  });
  const { response, state } = makeResponse();

  await handler({
    headers: { authorization: `Bearer ${evidenceEnv.VELVET_ALCHEMY_ACQUISITION_API_KEY}` },
    body: realPayload,
  } as unknown as Request, response, () => undefined);

  assert.equal(state.statusCode, 201);
  assert.equal((state.body as any).recordKind, "real");
  assert.equal((state.body as any).contactPermission, "unverified");
  assert.equal((state.body as any).contactBasis, "not_evaluated");
  assert.equal((state.body as any).externalAction, "none");
  assert.equal((state.body as any).handoffId, null);
  assert.equal((state.body as any).taskId, null);
  assert.equal(received.recordKind, "real");
});

test("authenticates before exposing degraded storage or schema state", async () => {
  for (const fixture of [
    { dbEnabled: false, isSchemaReady: () => false },
    { dbEnabled: true, isSchemaReady: () => false },
  ]) {
    const handler = createVelvetAcquisitionHandler({
      ...fixture,
      env: configuredEnv,
      store: { async receive() { throw new Error("must not store"); } },
      log: () => {},
    });
    const { response, state } = makeResponse();
    await handler({
      headers: { authorization: "Bearer forged-token" },
      body: validSyntheticPayload,
    } as unknown as Request, response, () => undefined);
    assert.equal(state.statusCode, 401);
    assert.deepEqual(state.body, {
      error: "Unauthorized",
      code: "VELVET_ALCHEMY_ACQUISITION_UNAUTHORIZED",
    });
  }
});

test("rejects published placeholders and reused provider secrets", () => {
  const base = {
    VELVET_ALCHEMY_ACQUISITION_MODE: "evidence-inbox-v1",
    VELVET_ALCHEMY_WORKSPACE_ID: "42",
  };
  assert.equal(readVelvetAcquisitionConfig({
    ...base,
    VELVET_ALCHEMY_ACQUISITION_API_KEY: "generate-a-distinct-32-plus-character-key",
  }).configured, false);
  for (const secretName of [
    "TWILIO_AUTH_TOKEN",
    "WORKSPACE_SECRET_ENCRYPTION_KEY",
    "OPENCLAW_GATEWAY_TOKEN",
    "STRIPE_BILLING_PORTAL_KEY",
    "TEST_CALL_SECRET",
  ]) {
    const reused = "velvet-provider-secret-with-enough-entropy-9081726354";
    assert.equal(readVelvetAcquisitionConfig({
      ...base,
      VELVET_ALCHEMY_ACQUISITION_API_KEY: reused,
      [secretName]: reused,
    }).configured, false, secretName);
  }
});

test("rejects obvious fixture evidence mislabelled as real", async () => {
  let storeCalls = 0;
  const handler = createVelvetAcquisitionHandler({
    dbEnabled: true,
    isSchemaReady: () => true,
    env: { ...configuredEnv, VELVET_ALCHEMY_ACQUISITION_MODE: "evidence-inbox-v1" },
    store: { async receive() { storeCalls += 1; throw new Error("must not store"); } },
    log: () => {},
  });
  const { response, state } = makeResponse();
  await handler({
    headers: { authorization: `Bearer ${configuredEnv.VELVET_ALCHEMY_ACQUISITION_API_KEY}` },
    body: {
      ...validSyntheticPayload,
      recordKind: "real",
      sourceRecordId: "test-fixture-lead-00000001",
      sourceEventId: "test-fixture-event-00000001",
      caller: { phone: "+17755550142", name: "Synthetic Test Caller", email: "lead@example.com" },
    },
  } as unknown as Request, response, () => undefined);
  assert.equal(state.statusCode, 409);
  assert.equal((state.body as any).code, "VELVET_ALCHEMY_ACQUISITION_CLASSIFICATION_CONFLICT");
  assert.equal(storeCalls, 0);
});
