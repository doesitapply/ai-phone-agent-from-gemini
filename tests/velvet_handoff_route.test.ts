import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import {
  VelvetHandoffStoreError,
  createVelvetHandoffHandler,
  type VelvetHandoffStore,
} from "../src/routes/velvet-handoff-routes.ts";

const configuredEnv = {
  VELVET_ALCHEMY_HANDOFF_API_KEY: "velvet-test-token",
  VELVET_ALCHEMY_WORKSPACE_ID: "42",
};

const validPayload = {
  workspaceId: 42,
  externalId: "velvet-lead-00000001",
  caller: {
    phone: "+17754204485",
    name: "Test Caller",
  },
  companyName: "Velvet Test Co",
  reason: "Requested a callback about a service inquiry.",
  urgency: "normal",
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

async function invoke(options: {
  env?: Record<string, string | undefined>;
  dbEnabled?: boolean;
  authorization?: string;
  body?: unknown;
  store?: VelvetHandoffStore;
}) {
  let storeCalls = 0;
  const store = options.store || {
    async receive() {
      storeCalls += 1;
      return { outcome: "created" as const, handoffId: 71, taskId: 91 };
    },
  };
  const handler = createVelvetHandoffHandler({
    env: options.env ?? configuredEnv,
    dbEnabled: options.dbEnabled ?? true,
    store,
    log: () => {},
  });
  const { response, state } = makeResponse();
  await handler({
    headers: { authorization: options.authorization ?? "Bearer velvet-test-token" },
    body: options.body ?? validPayload,
    ip: "127.0.0.1",
    requestId: "test-request",
  } as unknown as Request, response, () => undefined);
  return { ...state, storeCalls };
}

test("fails closed when the Velvet handoff receiver is not configured", async () => {
  const result = await invoke({ env: {} });
  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.body, {
    error: "Velvet Alchemy handoff is not configured.",
    code: "VELVET_ALCHEMY_HANDOFF_NOT_CONFIGURED",
    missing: ["VELVET_ALCHEMY_HANDOFF_API_KEY", "VELVET_ALCHEMY_WORKSPACE_ID"],
  });
  assert.equal(result.storeCalls, 0);
});

test("rejects a forged bearer token before touching storage", async () => {
  const result = await invoke({ authorization: "Bearer forged-token" });
  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.body, { error: "Unauthorized", code: "VELVET_ALCHEMY_HANDOFF_UNAUTHORIZED" });
  assert.equal(result.storeCalls, 0);
});

test("rejects malformed callback payloads before touching storage", async () => {
  const result = await invoke({ body: { ...validPayload, externalId: "not safe / external id" } });
  assert.equal(result.statusCode, 400);
  assert.equal((result.body as any).code, "VELVET_ALCHEMY_HANDOFF_INVALID_PAYLOAD");
  assert.equal(result.storeCalls, 0);
});

test("rejects an otherwise safe external ID when no durable Velvet lead identity can be resolved", async () => {
  const result = await invoke({ body: { ...validPayload, externalId: "velvet-manus-fake-check" } });
  assert.equal(result.statusCode, 400);
  assert.equal((result.body as any).code, "VELVET_ALCHEMY_HANDOFF_INVALID_PAYLOAD");
  assert.equal(result.storeCalls, 0);
});

test("accepts a dedicated leadId when the external receipt ID does not encode one", async () => {
  const result = await invoke({ body: { ...validPayload, externalId: "velvet-manus-real-event", leadId: 73 } });
  assert.equal(result.statusCode, 201);
  assert.deepEqual((result.body as any).feedbackIdentity, { externalId: "velvet-manus-real-event", leadId: 73 });
  assert.equal(result.storeCalls, 1);
});

test("rejects a valid token attempting to select another workspace", async () => {
  const result = await invoke({ body: { ...validPayload, workspaceId: 43 } });
  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.body, {
    error: "Workspace is not authorized for this integration.",
    code: "VELVET_ALCHEMY_WORKSPACE_MISMATCH",
  });
  assert.equal(result.storeCalls, 0);
});

test("reports a newly persisted handoff only after the store returns its record", async () => {
  const result = await invoke({});
  assert.equal(result.statusCode, 201);
  assert.deepEqual(result.body, { ok: true, state: "RECEIVED", handoffId: 71, taskId: 91, feedbackIdentity: { externalId: "velvet-lead-00000001", leadId: 1 } });
  assert.equal(result.storeCalls, 1);
});

test("reports a replay as a single idempotent duplicate", async () => {
  const result = await invoke({
    store: {
      async receive() {
        return { outcome: "duplicate", handoffId: 71, taskId: 91 };
      },
    },
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { ok: true, state: "DUPLICATE", handoffId: 71, taskId: 91, feedbackIdentity: { externalId: "velvet-lead-00000001", leadId: 1 } });
});

test("does not claim success when durable storage rejects a handoff", async () => {
  const result = await invoke({
    store: {
      async receive() {
        throw new VelvetHandoffStoreError("The configured SMIRK workspace was not found.", "VELVET_ALCHEMY_WORKSPACE_NOT_FOUND", 404);
      },
    },
  });
  assert.equal(result.statusCode, 404);
  assert.deepEqual(result.body, {
    error: "The configured SMIRK workspace was not found.",
    code: "VELVET_ALCHEMY_WORKSPACE_NOT_FOUND",
  });
});

test("does not attempt a handoff without durable storage", async () => {
  const result = await invoke({ dbEnabled: false });
  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.body, {
    error: "Velvet Alchemy handoff requires durable SMIRK storage.",
    code: "VELVET_ALCHEMY_HANDOFF_STORAGE_REQUIRED",
  });
  assert.equal(result.storeCalls, 0);
});
