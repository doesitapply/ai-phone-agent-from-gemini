import assert from "node:assert/strict";
import test from "node:test";
import {
  VELVET_LEAD_SOURCE_REQUEST_CONTRACT,
  VELVET_LEAD_SOURCE_RESPONSE_CONTRACT,
  buildVelvetLeadSourceRequest,
  hashVelvetLeadSourceValue,
  readVelvetLeadSourceConfig,
  requestVelvetLeadBatch,
  validateVelvetLeadSourceResponse,
  velvetLeadSourceRequestSchema,
} from "../src/velvet-lead-source.ts";

const configuredEnv = {
  VELVET_LEAD_SOURCE_ENABLED: "true",
  VELVET_LEAD_SOURCE_BASE_URL: "https://velvetalchemy.manus.space",
  VELVET_LEAD_SOURCE_API_KEY:
    "velvet-source-api-key-0000000000000001",
  VELVET_LEAD_SOURCE_WORKSPACE_ID: "7",
  VELVET_OUTCOME_API_KEY: "different-outcome-key-000000000000001",
};

const request = buildVelvetLeadSourceRequest({
  requestId: "smirk-source-11111111-1111-4111-8111-111111111111",
  workspaceId: 7,
  criteria: {
    limit: 5,
    category: "plumbing",
    city: "Reno",
    state: "NV",
    learningMode: "none",
  },
});

const prospect = {
  contractVersion: "velvet-smirk.prospect.v1",
  workspaceId: 7,
  externalId: "velvet-owner-1-lead-42",
  batch: {
    externalId: request.requestId,
    name: "Velvet reviewed leads: plumbing / Reno, NV",
  },
  prospect: {
    companyName: "Synthetic Plumbing Test",
    phone: "+17755550142",
    phoneContactMode: "operator_review_only",
    email: "owner@example.com",
    emailVerification: "verified_owner_email",
    website: "https://example.com/synthetic",
    evidence: [
      {
        url: "https://example.com/synthetic",
        observation: "Public business website recorded for operator review.",
        observedAt: "2026-07-30T18:00:00.000Z",
        kind: "website",
        basis: "observed",
        confidence: "high",
      },
    ],
    notes:
      "Research-only import. No outreach, SMS, call, handoff, or callback task is authorized.",
  },
};

function responseBody(state: "EXPORTED" | "DUPLICATE" = "EXPORTED") {
  return {
    ok: true,
    contractVersion: VELVET_LEAD_SOURCE_RESPONSE_CONTRACT,
    state,
    originalState: "EXPORTED",
    requestId: request.requestId,
    requestPayloadHash: hashVelvetLeadSourceValue(request),
    batchId: 9,
    prospectsHash: hashVelvetLeadSourceValue([prospect]),
    prospects: [prospect],
    appliedLearningCandidate: null,
    contactActionAllowed: false,
    spendAuthorized: false,
    externalAction: "research_export_only",
  };
}

test("Velvet source request is bounded, no-contact, and zero-spend", () => {
  assert.equal(request.contractVersion, VELVET_LEAD_SOURCE_REQUEST_CONTRACT);
  assert.equal(request.criteria.limit, 5);
  assert.equal(request.contactActionAllowed, false);
  assert.equal(request.maxSpendCents, 0);
  for (const invalid of [
    { ...request, contactActionAllowed: true },
    { ...request, maxSpendCents: 1 },
    { ...request, criteria: { ...request.criteria, limit: 21 } },
  ]) {
    assert.equal(velvetLeadSourceRequestSchema.safeParse(invalid).success, false);
  }
});

test("a discovery-bound pull requires exact manual segment provenance", () => {
  const sourceDiscoveryRequestId =
    "smirk-discovery-22222222-2222-4222-8222-222222222222";
  const bound = buildVelvetLeadSourceRequest({
    requestId:
      "smirk-source-22222222-2222-4222-8222-222222222222",
    workspaceId: 7,
    sourceDiscoveryRequestId,
    criteria: {
      limit: 5,
      category: "plumbing",
      city: "Reno",
      state: "NV",
      learningMode: "none",
    },
  });
  assert.equal(bound.sourceDiscoveryRequestId, sourceDiscoveryRequestId);
  assert.equal(
    velvetLeadSourceRequestSchema.safeParse({
      ...bound,
      criteria: {
        limit: 5,
        learningMode: "latest_released",
      },
    }).success,
    false
  );
});

test("Velvet source configuration is explicit, dedicated, and workspace locked", () => {
  assert.deepEqual(readVelvetLeadSourceConfig(configuredEnv), {
    enabled: true,
    configured: true,
    baseUrl: "https://velvetalchemy.manus.space",
    apiKey: configuredEnv.VELVET_LEAD_SOURCE_API_KEY,
    workspaceId: 7,
    missing: [],
  });
  assert.equal(
    readVelvetLeadSourceConfig({
      ...configuredEnv,
      VELVET_LEAD_SOURCE_API_KEY:
        configuredEnv.VELVET_OUTCOME_API_KEY,
    }).configured,
    false
  );
  assert.equal(
    readVelvetLeadSourceConfig({
      ...configuredEnv,
      DASHBOARD_API_KEY:
        configuredEnv.VELVET_LEAD_SOURCE_API_KEY,
    }).configured,
    false
  );
  assert.equal(
    readVelvetLeadSourceConfig({
      ...configuredEnv,
      VELVET_LEAD_SOURCE_BASE_URL: "https://example.com",
    }).configured,
    false
  );
});

test("Velvet response must bind request, workspace, state, and prospect hash", () => {
  assert.equal(
    validateVelvetLeadSourceResponse({
      httpStatus: 201,
      body: responseBody(),
      request,
    }).success,
    true
  );
  assert.equal(
    validateVelvetLeadSourceResponse({
      httpStatus: 200,
      body: responseBody("DUPLICATE"),
      request,
    }).success,
    true
  );
  assert.equal(
    validateVelvetLeadSourceResponse({
      httpStatus: 201,
      body: {
        ...responseBody(),
        prospectsHash: "a".repeat(64),
      },
      request,
    }).success,
    false
  );
  assert.equal(
    validateVelvetLeadSourceResponse({
      httpStatus: 201,
      body: {
        ...responseBody(),
        contactActionAllowed: true,
      },
      request,
    }).success,
    false
  );
});

test("a learned source response requires a released-policy receipt", () => {
  const body = {
    ...responseBody(),
    appliedLearningCandidate: {
      id: 7,
      candidateKey: "category:plumbing",
      version: 1,
      proposal: {
        action: "prioritize_for_next_research_batch",
        dimension: "category",
        value: "plumbing",
        maximumNextBatchSize: 20,
      },
    },
  };
  assert.equal(
    validateVelvetLeadSourceResponse({
      httpStatus: 201,
      body,
      request,
    }).success,
    false
  );
  assert.equal(
    validateVelvetLeadSourceResponse({
      httpStatus: 201,
      body: {
        ...body,
        appliedLearningCandidate: {
          ...body.appliedLearningCandidate,
          policyReleaseId:
            "6356e39c-217c-43a5-8058-9262837aeb97",
          policyReleaseReceiptHash: "f".repeat(64),
        },
      },
      request,
    }).success,
    true
  );
});

test("a discovery-bound response must echo the exact discovery request", () => {
  const sourceDiscoveryRequestId =
    "smirk-discovery-22222222-2222-4222-8222-222222222222";
  const boundRequest = buildVelvetLeadSourceRequest({
    requestId:
      "smirk-source-33333333-3333-4333-8333-333333333333",
    workspaceId: 7,
    sourceDiscoveryRequestId,
    criteria: {
      limit: 5,
      category: "plumbing",
      city: "Reno",
      state: "NV",
      learningMode: "none",
    },
  });
  const base = {
    ...responseBody(),
    requestId: boundRequest.requestId,
    requestPayloadHash: hashVelvetLeadSourceValue(boundRequest),
    sourceDiscoveryRequestId,
  };
  assert.equal(
    validateVelvetLeadSourceResponse({
      httpStatus: 201,
      body: base,
      request: boundRequest,
    }).success,
    true
  );
  assert.equal(
    validateVelvetLeadSourceResponse({
      httpStatus: 201,
      body: {
        ...base,
        sourceDiscoveryRequestId:
          "smirk-discovery-99999999-9999-4999-8999-999999999999",
      },
      request: boundRequest,
    }).success,
    false
  );
});

test("Velvet response rejects duplicate prospect identities", () => {
  const prospects = [prospect, prospect];
  const result = validateVelvetLeadSourceResponse({
    httpStatus: 201,
    body: {
      ...responseBody(),
      prospects,
      prospectsHash: hashVelvetLeadSourceValue(prospects),
    },
    request,
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.code, "VELVET_LEAD_SOURCE_INVALID_RESPONSE");
  }
});

test("only an explicit in-progress conflict is retryable", () => {
  const inProgress = validateVelvetLeadSourceResponse({
    httpStatus: 409,
    body: {
      code: "SMIRK_LEAD_BATCH_IN_PROGRESS",
      error: "Synthetic request is still processing.",
    },
    request,
  });
  const conflict = validateVelvetLeadSourceResponse({
    httpStatus: 409,
    body: {
      code: "SMIRK_LEAD_BATCH_IDEMPOTENCY_CONFLICT",
      error: "Synthetic request ID changed payloads.",
    },
    request,
  });
  assert.equal(inProgress.success, false);
  assert.equal(conflict.success, false);
  if (!inProgress.success && !conflict.success) {
    assert.equal(inProgress.retryable, true);
    assert.equal(conflict.retryable, false);
  }
});

test("Velvet transport sends one exact idempotent request and never auto-retries", async () => {
  let calls = 0;
  const result = await requestVelvetLeadBatch(
    request,
    readVelvetLeadSourceConfig(configuredEnv),
    (async (url, init) => {
      calls += 1;
      assert.equal(
        url,
        "https://velvetalchemy.manus.space/api/v1/smirk/lead-batches"
      );
      assert.equal(init?.method, "POST");
      assert.equal(
        (init?.headers as Record<string, string>)["Idempotency-Key"],
        request.requestId
      );
      return new Response(JSON.stringify(responseBody()), { status: 201 });
    }) as typeof fetch
  );
  assert.equal(result.success, true);
  assert.equal(calls, 1);
});

test("Velvet transport stops before network when sourcing is disabled", async () => {
  let calls = 0;
  const result = await requestVelvetLeadBatch(
    request,
    readVelvetLeadSourceConfig({}),
    (async () => {
      calls += 1;
      throw new Error("must not run");
    }) as typeof fetch
  );
  assert.equal(result.success, false);
  assert.equal(calls, 0);
});
