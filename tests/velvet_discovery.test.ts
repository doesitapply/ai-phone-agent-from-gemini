import assert from "node:assert/strict";
import test from "node:test";
import {
  VELVET_DISCOVERY_REQUEST_CONTRACT,
  buildVelvetDiscoveryRequest,
  getVelvetActiveAcquisitionExperiment,
  getVelvetDiscoveryStatus,
  hashVelvetDiscoveryValue,
  prepareVelvetDiscovery,
  readVelvetDiscoveryConfig,
  validateVelvetDiscoveryStatus,
  velvetDiscoveryPreparedResponseSchema,
  velvetDiscoveryRequestSchema,
} from "../src/velvet-discovery.ts";

const activeExperimentResponse = {
  ok: true as const,
  contractVersion: "velvet-smirk.acquisition-sourcing-active.v1" as const,
  state: "ACTIVE" as const,
  workspaceId: 7,
  experiment: {
    binding: {
      contractVersion: "smirk-velvet.acquisition-sourcing-binding.v1" as const,
      experimentId: "6356e39c-217c-43a5-8058-9262837aeb97",
      definitionHash: "a".repeat(64),
    },
    dimension: "category" as const,
    arms: {
      control: {
        label: "Reno plumbing",
        criteria: { category: "plumbing", city: "Reno", state: "NV" },
      },
      challenger: {
        label: "Reno HVAC",
        criteria: { category: "hvac", city: "Reno", state: "NV" },
      },
    },
    requestsPerArm: 1,
    leadsPerRequest: 10,
    totalRequestSlots: 2,
    assignedRequests: 0,
  },
  contactActionAllowed: false as const,
  spendAuthorized: false as const,
  policyChanged: false as const,
  externalAction: "experiment_status_only" as const,
};

const configuredEnv = {
  VELVET_DISCOVERY_ENABLED: "true",
  VELVET_LEAD_SOURCE_BASE_URL:
    "https://velvetalchemy.manus.space",
  VELVET_LEAD_SOURCE_API_KEY:
    "velvet-source-api-key-0000000000000001",
  VELVET_LEAD_SOURCE_WORKSPACE_ID: "7",
  VELVET_OUTCOME_API_KEY:
    "different-outcome-api-key-000000000001",
};

const request = buildVelvetDiscoveryRequest({
  requestId: "smirk-discovery-11111111-1111-4111-8111-111111111111",
  workspaceId: 7,
  criteria: {
    limit: 3,
    category: "plumbing",
    city: "Reno",
    state: "NV",
    learningMode: "none",
  },
});

function quote() {
  return {
    provider: "google_maps_proxy" as const,
    maximumRequests: 4,
    costCentsPerRequest: 2,
    maximumCostCents: 8,
    quotedAt: "2026-07-30T19:00:00.000Z",
  };
}

function preparedResponse(state: "PREPARED" | "DUPLICATE") {
  return {
    ok: true as const,
    contractVersion: "velvet-smirk.discovery-response.v1" as const,
    state,
    originalState: "PREPARED" as const,
    currentState: "PREPARED" as const,
    requestId: request.requestId,
    requestPayloadHash: hashVelvetDiscoveryValue(request),
    quotePayloadHash: hashVelvetDiscoveryValue(quote()),
    discoveryId: 42,
    effectiveCriteria: {
      limit: request.criteria.limit,
      category: request.criteria.category!,
      city: request.criteria.city!,
      state: request.criteria.state!,
    },
    appliedLearningCandidate: null,
    quote: quote(),
    approvalRequired: true,
    executionStarted: false,
    contactActionAllowed: false as const,
    spendAuthorized: false as const,
    externalAction: "discovery_approval_required" as const,
  };
}

function statusResponse(state: "PREPARED" | "COMPLETED" = "PREPARED") {
  return {
    ok: true as const,
    contractVersion: "velvet-smirk.discovery-status.v1" as const,
    requestId: request.requestId,
    requestPayloadHash: hashVelvetDiscoveryValue(request),
    quotePayloadHash: hashVelvetDiscoveryValue(quote()),
    discoveryId: 42,
    state,
    effectiveCriteria: {
      limit: request.criteria.limit,
      category: request.criteria.category!,
      city: request.criteria.city!,
      state: request.criteria.state!,
    },
    appliedLearningCandidate: null,
    quote: quote(),
    createdLeadCount: state === "COMPLETED" ? 2 : 0,
    readyLeadCount: state === "COMPLETED" ? 2 : 0,
    skippedLeadCount: 0,
    failedLeadCount: 0,
    providerRequests: state === "COMPLETED" ? 4 : 0,
    approvedMaxSpendCents: state === "COMPLETED" ? 8 : null,
    error: null,
    contactActionAllowed: false as const,
    externalAction: "discovery_status_only" as const,
  };
}

test("Velvet discovery request is bounded, no-contact, and no-spend", () => {
  assert.equal(request.contractVersion, VELVET_DISCOVERY_REQUEST_CONTRACT);
  assert.equal(request.contactActionAllowed, false);
  assert.equal(request.spendAuthorized, false);
  assert.equal(
    velvetDiscoveryRequestSchema.safeParse({
      ...request,
      spendAuthorized: true,
    }).success,
    false
  );
  assert.equal(
    velvetDiscoveryRequestSchema.safeParse({
      ...request,
      criteria: { ...request.criteria, limit: 21 },
    }).success,
    false
  );
});

test("learned discovery requires one complementary operator dimension", () => {
  const base = {
    contractVersion: VELVET_DISCOVERY_REQUEST_CONTRACT,
    requestId:
      "smirk-discovery-22222222-2222-4222-8222-222222222222",
    workspaceId: 7,
    contactActionAllowed: false,
    spendAuthorized: false,
  };
  assert.equal(
    velvetDiscoveryRequestSchema.safeParse({
      ...base,
      criteria: {
        limit: 3,
        city: "Reno",
        state: "NV",
        learningMode: "latest_released",
      },
    }).success,
    true
  );
  assert.equal(
    velvetDiscoveryRequestSchema.safeParse({
      ...base,
      criteria: {
        limit: 3,
        learningMode: "latest_released",
      },
    }).success,
    false
  );
});

test("a learned discovery response requires a released-policy receipt", () => {
  const body = {
    ...preparedResponse("PREPARED"),
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
    velvetDiscoveryPreparedResponseSchema.safeParse(body).success,
    false
  );
  assert.equal(
    velvetDiscoveryPreparedResponseSchema.safeParse({
      ...body,
      appliedLearningCandidate: {
        ...body.appliedLearningCandidate,
        policyReleaseId:
          "6356e39c-217c-43a5-8058-9262837aeb97",
        policyReleaseReceiptHash: "f".repeat(64),
      },
    }).success,
    true
  );
});

test("Velvet discovery config is separately enabled and workspace locked", () => {
  assert.deepEqual(readVelvetDiscoveryConfig(configuredEnv), {
    enabled: true,
    configured: true,
    baseUrl: "https://velvetalchemy.manus.space",
    apiKey: "velvet-source-api-key-0000000000000001",
    workspaceId: 7,
    missing: [],
  });
  assert.equal(
    readVelvetDiscoveryConfig({
      ...configuredEnv,
      VELVET_DISCOVERY_ENABLED: "false",
    }).configured,
    false
  );
  assert.equal(
    readVelvetDiscoveryConfig({
      ...configuredEnv,
      VELVET_LEAD_SOURCE_API_KEY:
        configuredEnv.VELVET_OUTCOME_API_KEY,
    }).configured,
    false
  );
});

test("active sourcing experiment lookup is read-only and workspace bound", async () => {
  let requests = 0;
  const result = await getVelvetActiveAcquisitionExperiment(
    readVelvetDiscoveryConfig(configuredEnv),
    async (input, init) => {
      requests += 1;
      assert.equal(
        input,
        "https://velvetalchemy.manus.space/api/v1/smirk/acquisition-sourcing-experiments/active?workspaceId=7",
      );
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      return new Response(JSON.stringify(activeExperimentResponse), {
        status: 200,
      });
    },
  );
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(requests, 1);
  if (result.success) {
    assert.equal(result.response.experiment?.assignedRequests, 0);
    assert.equal(result.response.contactActionAllowed, false);
    assert.equal(result.response.spendAuthorized, false);
    assert.equal(result.response.policyChanged, false);
  }

  const mismatch = await getVelvetActiveAcquisitionExperiment(
    readVelvetDiscoveryConfig(configuredEnv),
    async () =>
      new Response(
        JSON.stringify({ ...activeExperimentResponse, workspaceId: 8 }),
        { status: 200 },
      ),
  );
  assert.equal(mismatch.success, false);
  if (!mismatch.success) {
    assert.equal(
      mismatch.code,
      "VELVET_ACQUISITION_EXPERIMENT_RESPONSE_MISMATCH",
    );
  }
});

test("prepare sends one idempotent no-spend request and never retries", async () => {
  let requests = 0;
  const result = await prepareVelvetDiscovery(
    request,
    readVelvetDiscoveryConfig(configuredEnv),
    async (input, init) => {
      requests += 1;
      assert.equal(
        input,
        "https://velvetalchemy.manus.space/api/v1/smirk/discovery-requests"
      );
      assert.equal(init?.method, "POST");
      assert.equal(
        new Headers(init?.headers).get("Idempotency-Key"),
        request.requestId
      );
      assert.deepEqual(JSON.parse(String(init?.body)), request);
      return new Response(JSON.stringify(preparedResponse("PREPARED")), {
        status: 201,
      });
    }
  );
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(requests, 1);
  if (result.success) {
    assert.equal(result.response.approvalRequired, true);
    assert.equal(result.response.executionStarted, false);
  }
});

test("exact prepare replay is a success and changed proof is rejected", async () => {
  const replay = await prepareVelvetDiscovery(
    request,
    readVelvetDiscoveryConfig(configuredEnv),
    async () =>
      new Response(JSON.stringify(preparedResponse("DUPLICATE")), {
        status: 200,
      })
  );
  assert.equal(replay.success, true);

  const changed = await prepareVelvetDiscovery(
    request,
    readVelvetDiscoveryConfig(configuredEnv),
    async () =>
      new Response(
        JSON.stringify({
          ...preparedResponse("PREPARED"),
          quotePayloadHash: "a".repeat(64),
        }),
        { status: 201 }
      )
  );
  assert.equal(changed.success, false);
  if (!changed.success) {
    assert.equal(changed.code, "VELVET_DISCOVERY_RESPONSE_MISMATCH");
  }
});

test("status binds the stored request and does not grant contact", async () => {
  const validated = validateVelvetDiscoveryStatus({
    body: statusResponse("COMPLETED"),
    request,
  });
  assert.equal(validated.success, true);
  if (validated.success) {
    assert.equal(validated.response.readyLeadCount, 2);
    assert.equal(validated.response.contactActionAllowed, false);
  }

  const result = await getVelvetDiscoveryStatus(
    request,
    readVelvetDiscoveryConfig(configuredEnv),
    async (input, init) => {
      assert.equal(
        input,
        `https://velvetalchemy.manus.space/api/v1/smirk/discovery-requests/${request.requestId}`
      );
      assert.equal(init?.method, "GET");
      return new Response(JSON.stringify(statusResponse("COMPLETED")), {
        status: 200,
      });
    }
  );
  assert.equal(result.success, true);
});

test("disabled discovery stops before network", async () => {
  let requests = 0;
  const result = await prepareVelvetDiscovery(
    request,
    readVelvetDiscoveryConfig({}),
    async () => {
      requests += 1;
      throw new Error("must not run");
    }
  );
  assert.equal(result.success, false);
  assert.equal(requests, 0);
});
