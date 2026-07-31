import assert from "node:assert/strict";
import test from "node:test";
import {
  PROSPECT_QC_MODEL_REVIEW_CONFIRMATION,
  PROSPECT_QC_MODEL_REVIEW_MODE,
  buildProspectQcModelReviewReceipt,
  hashProspectQcModelRequest,
  hashProspectQcModelReviewReceipt,
  prospectQcModelReviewActionSchema,
  publicProspectQcModelProviderConfig,
  readProspectQcModelProviderConfig,
  requestProspectQcModelReview,
  type ProspectQcModelProviderInput,
} from "../src/prospect-qc-model-provider.ts";

const approvalId = "11111111-1111-4111-8111-111111111111";
const reviewId = "22222222-2222-4222-8222-222222222222";

function providerEnv(
  overrides: Record<string, string | undefined> = {}
) {
  return {
    PROSPECT_QC_MODEL_REVIEW_ENABLED: "true",
    PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL: "false",
    PROSPECT_QC_MODEL_REVIEW_MODE,
    PROSPECT_QC_OPENROUTER_API_KEY:
      "sk-or-v1-abcdefghijklmnop",
    PROSPECT_QC_OPENROUTER_MODEL:
      "google/gemini-2.5-flash",
    PROSPECT_QC_MODEL_WORKSPACE_ID: "7",
    PROSPECT_QC_MODEL_DAILY_REVIEW_CAP: "3",
    PROSPECT_QC_MODEL_DAILY_SPEND_CAP_CENTS: "5",
    PROSPECT_QC_MODEL_RESERVED_COST_CENTS: "1",
    PROSPECT_QC_MODEL_TIMEOUT_MS: "5000",
    ...overrides,
  };
}

function providerPayload(
  overrides: Partial<ProspectQcModelProviderInput> = {}
): ProspectQcModelProviderInput {
  return {
    workspaceId: 7,
    approvalId,
    payloadHash: "a".repeat(64),
    draftHash: "b".repeat(64),
    evidenceHash: "c".repeat(64),
    channel: "email",
    variantKey: "micro-after-hours-v1",
    subject: "After-hours calls in Reno",
    content:
      "Hi Alex, SMIRK builds overflow phone systems for local trade contractors. Does Silver State Demo use staff after hours?",
    prospect: {
      businessName: "Silver State Demo",
      industry: "plumbing",
      contactName: "Alex",
      city: "Reno",
      state: "NV",
      website: "https://example.invalid",
      evidence: [
        {
          kind: "service_page",
          basis: "observed",
          observation:
            "The synthetic public page lists plumbing service in Reno.",
          url: "https://example.invalid/services",
        },
      ],
    },
    ...overrides,
  };
}

test("advisory QC config is workspace-scoped, capped, and uses a dedicated key", () => {
  const ready = readProspectQcModelProviderConfig(providerEnv());
  assert.equal(ready.enabled, true);
  assert.equal(ready.configured, true);
  assert.equal(ready.workspaceId, 7);
  assert.equal(ready.dailyReviewCap, 3);
  assert.equal(ready.dailySpendCapCents, 5);
  assert.equal(ready.reservedCostCents, 1);

  const reused = readProspectQcModelProviderConfig(
    providerEnv({
      OPENROUTER_API_KEY: "sk-or-v1-abcdefghijklmnop",
    })
  );
  assert.equal(reused.configured, false);
  assert.ok(
    reused.missing.includes(
      "PROSPECT_QC_OPENROUTER_API_KEY_SEPARATION"
    )
  );

  const unsupportedModel =
    readProspectQcModelProviderConfig(
      providerEnv({
        PROSPECT_QC_OPENROUTER_MODEL:
          "unreviewed/provider-model",
      })
    );
  assert.equal(unsupportedModel.configured, false);
  assert.ok(
    unsupportedModel.missing.includes(
      "PROSPECT_QC_OPENROUTER_MODEL"
    )
  );

  const publicConfig =
    publicProspectQcModelProviderConfig(ready, 7);
  assert.equal(publicConfig.availableForWorkspace, true);
  assert.equal("apiKey" in publicConfig, false);
  assert.equal(publicConfig.contactAuthorized, false);
  assert.equal(publicConfig.executionAuthorized, false);
});

test("one exact advisory confirmation is required", () => {
  assert.equal(
    PROSPECT_QC_MODEL_REVIEW_CONFIRMATION,
    "review-one-prospect-draft-with-advisory-model-v1"
  );
  assert.equal(
    prospectQcModelReviewActionSchema.safeParse({
      payloadHash: "a".repeat(64),
      confirmation: PROSPECT_QC_MODEL_REVIEW_CONFIRMATION,
    }).success,
    true
  );
  assert.equal(
    prospectQcModelReviewActionSchema.safeParse({
      payloadHash: "a".repeat(64),
      confirmation: "review-all-drafts",
    }).success,
    false
  );
});

test("disabled or mismatched configuration never calls OpenRouter", async () => {
  let requests = 0;
  const fetchImpl = (async () => {
    requests += 1;
    throw new Error("must not run");
  }) as typeof fetch;
  const disabled = await requestProspectQcModelReview({
    config: readProspectQcModelProviderConfig(
      providerEnv({
        PROSPECT_QC_MODEL_REVIEW_ENABLED: "false",
      })
    ),
    payload: providerPayload(),
    fetchImpl,
  });
  assert.equal(disabled.status, "blocked");

  const wrongWorkspace =
    await requestProspectQcModelReview({
      config: readProspectQcModelProviderConfig(
        providerEnv()
      ),
      payload: providerPayload({ workspaceId: 8 }),
      fetchImpl,
    });
  assert.equal(wrongWorkspace.status, "blocked");
  assert.equal(requests, 0);
});

test("one draft produces one bounded strict-schema OpenRouter request", async () => {
  const requests: Array<{
    input: string;
    init?: RequestInit;
  }> = [];
  const config = readProspectQcModelProviderConfig(
    providerEnv()
  );
  const result = await requestProspectQcModelReview({
    config,
    payload: providerPayload(),
    fetchImpl: (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      requests.push({ input: String(input), init });
      return new Response(
        JSON.stringify({
          id: "gen-synthetic-1",
          model: "google/gemini-2.5-flash",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  pass: false,
                  confidence_score: 0.92,
                  failure_reasons: [
                    "The claim about overflow systems needs operator review.",
                  ],
                }),
              },
            },
          ],
          usage: {
            cost: 0.00019,
            total_tokens: 143,
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }
      );
    }) as typeof fetch,
  });

  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.equal(result.review.status, "FLAGGED");
  assert.equal(result.review.authority, "advisory-only");
  assert.equal(result.providerReportedCostUsd, 0.00019);
  assert.equal(result.totalTokens, 143);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].input,
    "https://openrouter.ai/api/v1/chat/completions"
  );
  assert.equal(requests[0].init?.method, "POST");
  assert.equal(requests[0].init?.redirect, "manual");
  const headers = requests[0].init
    ?.headers as Record<string, string>;
  assert.equal(
    headers.authorization,
    "Bearer sk-or-v1-abcdefghijklmnop"
  );
  const body = JSON.parse(
    String(requests[0].init?.body)
  );
  assert.equal(body.model, "google/gemini-2.5-flash");
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 300);
  assert.equal(body.provider.require_parameters, true);
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(
    body.response_format.json_schema.strict,
    true
  );
  assert.equal(
    body.response_format.json_schema.schema
      .additionalProperties,
    false
  );
  assert.equal("tools" in body, false);
  assert.equal("recipients" in body, false);
  assert.doesNotMatch(
    JSON.stringify(result),
    /sk-or-v1-/
  );
});

test("invalid, rejected, and uncertain provider outcomes never authorize retry", async () => {
  const config = readProspectQcModelProviderConfig(
    providerEnv()
  );
  const malformed =
    await requestProspectQcModelReview({
      config,
      payload: providerPayload(),
      fetchImpl: (async () =>
        new Response("{", {
          status: 200,
        })) as typeof fetch,
    });
  assert.equal(malformed.status, "outcome_unknown");
  assert.equal(malformed.retryable, false);

  const unauthorized =
    await requestProspectQcModelReview({
      config,
      payload: providerPayload(),
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ error: "unauthorized" }),
          { status: 401 }
        )) as typeof fetch,
    });
  assert.equal(unauthorized.status, "definitive_failure");
  assert.equal(unauthorized.retryable, false);

  const rateLimited =
    await requestProspectQcModelReview({
      config,
      payload: providerPayload(),
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ error: "rate limited" }),
          { status: 429 }
        )) as typeof fetch,
    });
  assert.equal(rateLimited.status, "outcome_unknown");
  assert.equal(rateLimited.retryable, false);

  const networkFailure =
    await requestProspectQcModelReview({
      config,
      payload: providerPayload(),
      fetchImpl: (async () => {
        throw new Error("synthetic network uncertainty");
      }) as typeof fetch,
    });
  assert.equal(networkFailure.status, "outcome_unknown");
  assert.equal(networkFailure.retryable, false);
});

test("request and receipt hashes bind the exact draft, evidence, model, and cost", async () => {
  const config = readProspectQcModelProviderConfig(
    providerEnv()
  );
  const payload = providerPayload();
  const requestHash = hashProspectQcModelRequest(
    payload,
    config
  );
  assert.equal(
    requestHash,
    hashProspectQcModelRequest(payload, config)
  );
  assert.notEqual(
    requestHash,
    hashProspectQcModelRequest(
      {
        ...payload,
        evidenceHash: "d".repeat(64),
      },
      config
    )
  );
  assert.notEqual(
    requestHash,
    hashProspectQcModelRequest(
      payload,
      readProspectQcModelProviderConfig(
        providerEnv({
          PROSPECT_QC_OPENROUTER_MODEL:
            "google/gemini-2.5-flash-lite",
        })
      )
    )
  );

  const providerResult =
    await requestProspectQcModelReview({
      config,
      payload,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            id: "gen-synthetic-2",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    pass: true,
                    confidence_score: 0.98,
                    failure_reasons: [],
                  }),
                },
              },
            ],
            usage: { cost: 0.00012, total_tokens: 99 },
          }),
          { status: 200 }
        )) as typeof fetch,
    });
  assert.equal(providerResult.status, "accepted");
  if (providerResult.status !== "accepted") return;
  const built = buildProspectQcModelReviewReceipt({
    reviewId,
    workspaceId: 7,
    approvalId,
    outreachJobId: 9,
    requestHash,
    payloadHash: payload.payloadHash,
    draftHash: payload.draftHash,
    evidenceHash: payload.evidenceHash,
    result: providerResult,
    reservedCostCents: 1,
    reviewedAt: "2026-07-31T17:00:00.000Z",
  });
  assert.equal(
    built.receiptHash,
    hashProspectQcModelReviewReceipt(built.receipt)
  );
  assert.equal(built.receipt.review.status, "PASSED");
  assert.equal(built.receipt.humanApprovalRequired, true);
  assert.equal(built.receipt.contactAuthorized, false);
  assert.equal(built.receipt.executionAuthorized, false);
});
