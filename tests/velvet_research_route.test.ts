import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import {
  VelvetResearchStoreError,
  createVelvetResearchHandler,
  type VelvetResearchStore,
} from "../src/routes/velvet-research-routes.ts";

const configuredEnv = {
  VELVET_ALCHEMY_RESEARCH_API_KEY: "velvet-research-test-token-0000000001",
  VELVET_ALCHEMY_RESEARCH_WORKSPACE_ID: "42",
};

const validPayload = {
  contractVersion: "velvet-smirk.prospect.v1",
  workspaceId: 42,
  externalId: "velvet-prospect-00000001",
  batch: {
    externalId: "velvet-batch-0001",
    name: "Reno Plumbers Review",
    targetIndustry: "plumbing",
    targetLocation: "Reno, NV",
  },
  prospect: {
    companyName: "Synthetic Plumbing Test",
    website: "https://example.com/synthetic-plumbing",
    evidence: [{
      url: "https://example.com/synthetic-plumbing/contact",
      observation: "Public contact page reviewed for a synthetic test.",
      observedAt: "2026-07-29T18:00:00.000Z",
      kind: "contact_path",
      basis: "observed",
      confidence: "high",
    }],
  },
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
  store?: VelvetResearchStore;
}) {
  let storeCalls = 0;
  const store = options.store || {
    async receive() {
      storeCalls += 1;
      return { outcome: "created" as const, campaignId: 17, prospectId: 23 };
    },
  };
  const handler = createVelvetResearchHandler({
    env: options.env ?? configuredEnv,
    dbEnabled: options.dbEnabled ?? true,
    store,
    log: () => {},
  });
  const { response, state } = makeResponse();
  await handler({
    headers: { authorization: options.authorization ?? "Bearer velvet-research-test-token-0000000001" },
    body: options.body ?? validPayload,
    ip: "127.0.0.1",
    requestId: "test-request",
  } as unknown as Request, response, () => undefined);
  return { ...state, storeCalls };
}

test("fails closed when the Velvet research receiver is not configured", async () => {
  const result = await invoke({ env: {} });
  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.body, {
    error: "Velvet Alchemy research intake is not configured.",
    code: "VELVET_ALCHEMY_RESEARCH_NOT_CONFIGURED",
    missing: ["VELVET_ALCHEMY_RESEARCH_API_KEY", "VELVET_ALCHEMY_RESEARCH_WORKSPACE_ID"],
  });
  assert.equal(result.storeCalls, 0);
});

test("treats a weak research token as unconfigured", async () => {
  const result = await invoke({
    env: {
      VELVET_ALCHEMY_RESEARCH_API_KEY: "too-short",
      VELVET_ALCHEMY_RESEARCH_WORKSPACE_ID: "42",
    },
  });
  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.body, {
    error: "Velvet Alchemy research intake is not configured.",
    code: "VELVET_ALCHEMY_RESEARCH_NOT_CONFIGURED",
    missing: ["VELVET_ALCHEMY_RESEARCH_API_KEY"],
  });
  assert.equal(result.storeCalls, 0);
});

test("rejects a forged bearer token before touching storage", async () => {
  const result = await invoke({ authorization: "Bearer forged-token" });
  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.body, {
    error: "Unauthorized",
    code: "VELVET_ALCHEMY_RESEARCH_UNAUTHORIZED",
  });
  assert.equal(result.storeCalls, 0);
});

test("rejects malformed research payloads before touching storage", async () => {
  const result = await invoke({
    body: { ...validPayload, externalId: "unsafe / external id" },
  });
  assert.equal(result.statusCode, 400);
  assert.equal((result.body as any).code, "VELVET_ALCHEMY_RESEARCH_INVALID_PAYLOAD");
  assert.equal(result.storeCalls, 0);
});

test("rejects unclassified evidence before touching storage", async () => {
  const result = await invoke({
    body: {
      ...validPayload,
      prospect: {
        ...validPayload.prospect,
        evidence: [
          {
            url: "https://example.com",
            observation: "Unclassified claim.",
          },
        ],
      },
    },
  });
  assert.equal(result.statusCode, 400);
  assert.equal((result.body as any).code, "VELVET_ALCHEMY_RESEARCH_INVALID_PAYLOAD");
  assert.equal(result.storeCalls, 0);
});

test("rejects contact details without explicit channel provenance", async () => {
  const result = await invoke({
    body: {
      ...validPayload,
      prospect: {
        ...validPayload.prospect,
        email: "owner@example.com",
      },
    },
  });
  assert.equal(result.statusCode, 400);
  assert.equal(
    (result.body as any).code,
    "VELVET_ALCHEMY_RESEARCH_INVALID_PAYLOAD"
  );
  assert.equal(result.storeCalls, 0);
});

test("rejects a valid token attempting to select another workspace", async () => {
  const result = await invoke({ body: { ...validPayload, workspaceId: 43 } });
  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.body, {
    error: "Workspace is not authorized for this integration.",
    code: "VELVET_ALCHEMY_RESEARCH_WORKSPACE_MISMATCH",
  });
  assert.equal(result.storeCalls, 0);
});

test("reports an imported prospect only after durable storage returns its IDs", async () => {
  const result = await invoke({});
  assert.equal(result.statusCode, 201);
  assert.deepEqual(result.body, {
    ok: true,
    state: "IMPORTED",
    campaignId: 17,
    prospectId: 23,
    externalAction: "none",
  });
  assert.equal(result.storeCalls, 1);
});

test("reports a replay as a single idempotent duplicate", async () => {
  const result = await invoke({
    store: {
      async receive() {
        return { outcome: "duplicate", campaignId: 17, prospectId: 23 };
      },
    },
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {
    ok: true,
    state: "DUPLICATE",
    campaignId: 17,
    prospectId: 23,
    externalAction: "none",
  });
});

test("does not claim success when durable storage rejects an import", async () => {
  const result = await invoke({
    store: {
      async receive() {
        throw new VelvetResearchStoreError(
          "The configured SMIRK workspace was not found.",
          "VELVET_ALCHEMY_RESEARCH_WORKSPACE_NOT_FOUND",
          404,
        );
      },
    },
  });
  assert.equal(result.statusCode, 404);
  assert.deepEqual(result.body, {
    error: "The configured SMIRK workspace was not found.",
    code: "VELVET_ALCHEMY_RESEARCH_WORKSPACE_NOT_FOUND",
  });
});

test("does not attempt an import without durable storage", async () => {
  const result = await invoke({ dbEnabled: false });
  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.body, {
    error: "Velvet Alchemy research intake requires durable SMIRK storage.",
    code: "VELVET_ALCHEMY_RESEARCH_STORAGE_REQUIRED",
  });
  assert.equal(result.storeCalls, 0);
});
