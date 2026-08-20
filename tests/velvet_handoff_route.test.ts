import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import {
  VelvetHandoffStoreError,
  createPostgresVelvetHandoffStore,
  createVelvetHandoffHandler,
  type VelvetHandoffStore,
} from "../src/routes/velvet-handoff-routes.ts";
import { velvetHandoffPayloadSchema } from "../src/velvet-handoff.ts";

const configuredEnv = {
  VELVET_ALCHEMY_HANDOFF_API_KEY:
    "velvet-synthetic-handoff-test-token-0001",
  VELVET_ALCHEMY_HANDOFF_MODE: "synthetic-fixture-only-v1",
  VELVET_ALCHEMY_WORKSPACE_ID: "42",
};

const validPayload = {
  workspaceId: 42,
  externalId: "velvet-manus-fake-00000001",
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
    headers: {
      authorization:
        options.authorization ??
        "Bearer velvet-synthetic-handoff-test-token-0001",
    },
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
    missing: [
      "VELVET_ALCHEMY_HANDOFF_API_KEY",
      "VELVET_ALCHEMY_HANDOFF_MODE",
      "VELVET_ALCHEMY_WORKSPACE_ID",
    ],
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

test("rejects real-shaped prospects before touching storage", async () => {
  for (const body of [
    {
      ...validPayload,
      externalId: "velvet-lead-00000001",
    },
    {
      ...validPayload,
      caller: { ...validPayload.caller, phone: "+17755550142" },
    },
    {
      ...validPayload,
      urgency: "high",
    },
    {
      ...validPayload,
      caller: {
        ...validPayload.caller,
        email: "owner@real-business.test.example",
      },
    },
    {
      ...validPayload,
      companyName: "Actual Plumbing Company",
    },
  ]) {
    const result = await invoke({ body });
    assert.equal(result.statusCode, 409);
    assert.deepEqual(result.body, {
      error:
        "The call-shaped Velvet handoff accepts reserved synthetic fixtures only. Use the research intake for business prospects.",
      code: "VELVET_ALCHEMY_HANDOFF_SYNTHETIC_FIXTURE_REQUIRED",
      externalAction: "none",
    });
    assert.equal(result.storeCalls, 0);
  }
});

test("the Postgres store also rejects a real-shaped payload before opening a transaction", async () => {
  let transactions = 0;
  const sql: any = () => {
    throw new Error("must not query");
  };
  sql.begin = async () => {
    transactions += 1;
    throw new Error("must not begin");
  };
  const payload = velvetHandoffPayloadSchema.parse({
    ...validPayload,
    externalId: "velvet-lead-00000001",
    caller: { ...validPayload.caller, phone: "+17755550142" },
  });

  await assert.rejects(
    createPostgresVelvetHandoffStore(sql).receive({
      ...payload,
      payloadHash: "f".repeat(64),
    }),
    (error: unknown) =>
      error instanceof VelvetHandoffStoreError &&
      error.code ===
        "VELVET_ALCHEMY_HANDOFF_SYNTHETIC_FIXTURE_REQUIRED"
  );
  assert.equal(transactions, 0);
});

test("requires explicit fixture mode and a separated strong token", async () => {
  for (const env of [
    {
      ...configuredEnv,
      VELVET_ALCHEMY_HANDOFF_MODE: "",
    },
    {
      ...configuredEnv,
      VELVET_ALCHEMY_HANDOFF_API_KEY: "weak-token",
    },
    {
      ...configuredEnv,
      DASHBOARD_API_KEY:
        configuredEnv.VELVET_ALCHEMY_HANDOFF_API_KEY,
    },
  ]) {
    const result = await invoke({ env });
    assert.equal(result.statusCode, 503);
    assert.equal(
      (result.body as any).code,
      "VELVET_ALCHEMY_HANDOFF_NOT_CONFIGURED"
    );
    assert.equal(result.storeCalls, 0);
  }
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
  assert.deepEqual(result.body, { ok: true, state: "RECEIVED", handoffId: 71, taskId: 91 });
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
  assert.deepEqual(result.body, { ok: true, state: "DUPLICATE", handoffId: 71, taskId: 91 });
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
