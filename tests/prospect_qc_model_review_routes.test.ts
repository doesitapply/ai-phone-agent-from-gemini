import assert from "node:assert/strict";
import test from "node:test";
import type {
  Request,
  RequestHandler,
  Response,
} from "express";
import {
  registerProspectOutreachRoutes,
} from "../src/routes/prospect-outreach-routes.ts";
import {
  PROSPECT_QC_MODEL_REVIEW_CONFIRMATION,
  PROSPECT_QC_MODEL_REVIEW_MODE,
} from "../src/prospect-qc-model-provider.ts";
import {
  buildProspectOutreachPayload,
  hashProspectEvidence,
  hashProspectOutreachPayload,
  prospectOutreachPayloadSchema,
} from "../src/prospect-outreach.ts";

const approvalId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-07-31T18:00:00.000Z");
const evidence = [
  {
    kind: "service_page",
    basis: "observed",
    observation:
      "The synthetic public page lists plumbing service in Reno.",
    url: "https://example.invalid/services",
  },
];

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

function outreachPayload(options: {
  deterministicFailure?: boolean;
} = {}) {
  const payload = buildProspectOutreachPayload({
    workspaceId: 7,
    campaignId: 17,
    prospectId: 23,
    recipient: "owner@example.invalid",
    evidenceHash: hashProspectEvidence(evidence),
    preparedAt: "2026-07-31T17:00:00.000Z",
    qcContext: {
      businessName: "Silver State Demo",
      industry: "plumbing",
      evidenceObservation: null,
    },
    draft: {
      channel: "email",
      subject: "After-hours calls in Reno",
      body:
        "Hi Alex, SMIRK builds overflow phone systems for local plumbing contractors. Does Silver State Demo use staff after hours?",
      emailCompliance: {
        senderIdentity: "SMIRK",
        advertisementDisclosure:
          "This is a commercial message from SMIRK.",
        physicalPostalAddress:
          "1605 McKinley Drive, Reno, NV 89509",
        optOutInstructions:
          "If this is not relevant, reply no and I will not follow up.",
      },
      variantKey: "operator-reviewed-v1",
      maxCostCents: 2,
      expiresInHours: 24,
    },
  });
  if (options.deterministicFailure && payload.qcReceipt) {
    const ruleResults = payload.qcReceipt.ruleResults.map(
      (rule, index) =>
        index === 0
          ? {
              ...rule,
              passed: false,
              detail:
                "Synthetic deterministic fixture failure.",
            }
          : rule
    );
    return prospectOutreachPayloadSchema.parse({
      ...payload,
      qcReceipt: {
        ...payload.qcReceipt,
        deterministicPassed: false,
        verdict: "REVISION_REQUIRED",
        reviewPriority: "elevated",
        ruleResults,
        failureReasons: [
          "PLACEHOLDERS_RESOLVED: Synthetic deterministic fixture failure.",
        ],
      },
    });
  }
  return payload;
}

function baseJob(options: {
  deterministicFailure?: boolean;
} = {}) {
  const payload = outreachPayload(options);
  return {
    id: 9,
    lead_id: payload.prospectId,
    state: "PREPARED",
    recipient: payload.recipient,
    payload,
    payload_hash: hashProspectOutreachPayload(payload),
    evidence_hash: payload.evidenceHash,
    variant_key: payload.variantKey,
    channel: payload.channel,
    is_seed: false,
    expires_at: "2026-08-01T18:00:00.000Z",
    qc_model_review_id: null,
    qc_model_review_receipt_hash: null,
    business_name: "Silver State Demo",
    industry: "plumbing",
    contact_name: "Alex",
    city: "Reno",
    lead_state: "NV",
    website: "https://example.invalid",
    research_evidence: evidence,
  };
}

type ModelReviewRow = Record<string, any>;

function makeSql(options: {
  job?: Record<string, any> | null;
  reviewCount?: number;
  reservedSpendCents?: number;
  failReservation?: boolean;
} = {}) {
  const job =
    options.job === undefined ? baseJob() : options.job;
  const reviews: ModelReviewRow[] = [];
  const events: string[] = [];
  const queries: Array<{
    text: string;
    values: unknown[];
  }> = [];
  let nextId = 41;
  const sql: any = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    queries.push({ text, values });
    if (text.includes("pg_advisory_xact_lock")) {
      return [{ pg_advisory_xact_lock: null }];
    }
    if (
      text.includes(
        "FROM prospect_positive_outcome_reviews"
      )
    ) {
      return [{ pending_count: 0 }];
    }
    if (
      text.includes("SELECT j.id, j.state, j.payload") &&
      text.includes("l.business_name")
    ) {
      return job ? [job] : [];
    }
    if (
      text.includes(
        "SELECT id, lead_id, state, channel, recipient, variant_key"
      )
    ) {
      return job ? [job] : [];
    }
    if (
      text.includes("FROM prospect_qc_model_reviews") &&
      text.includes("request_hash")
    ) {
      const requestHash = values.find(
        value =>
          typeof value === "string" &&
          /^[a-f0-9]{64}$/.test(value) &&
          value !== job?.payload_hash
      );
      return reviews.filter(
        review =>
          !requestHash ||
          review.request_hash === requestHash
      );
    }
    if (
      text.includes("FROM prospect_qc_model_reviews") &&
      text.includes("ORDER BY requested_at DESC")
    ) {
      return [...reviews].reverse();
    }
    if (
      text.includes("AS review_count") &&
      text.includes("reserved_spend_cents")
    ) {
      return [
        {
          review_count:
            options.reviewCount ?? reviews.length,
          reserved_spend_cents:
            options.reservedSpendCents ??
            reviews.reduce(
              (sum, review) =>
                sum + Number(review.reserved_cost_cents),
              0
            ),
        },
      ];
    }
    if (
      text.includes(
        "INSERT INTO prospect_qc_model_reviews"
      )
    ) {
      if (options.failReservation) return [];
      const [
        reviewId,
        workspaceId,
        outreachJobId,
        requestHash,
        payloadHash,
        draftHash,
        evidenceHash,
        model,
        reservedCostCents,
        requestedBy,
      ] = values;
      const row = {
        id: nextId++,
        review_id: reviewId,
        workspace_id: workspaceId,
        outreach_job_id: outreachJobId,
        state: "SENDING",
        request_hash: requestHash,
        payload_hash: payloadHash,
        draft_hash: draftHash,
        evidence_hash: evidenceHash,
        provider: "openrouter",
        model,
        reserved_cost_cents: reservedCostCents,
        provider_request_id: null,
        provider_response_hash: null,
        provider_reported_cost_usd: null,
        total_tokens: null,
        review: null,
        receipt: null,
        receipt_hash: null,
        failure_code: null,
        requested_by: requestedBy,
        requested_at: now.toISOString(),
        completed_at: null,
      };
      reviews.push(row);
      events.push("sql:reservation");
      return [{ id: row.id }];
    }
    if (
      text.includes("FROM prospect_qc_model_reviews") &&
      text.includes("WHERE id =")
    ) {
      const id = values.find(value =>
        Number.isSafeInteger(value)
      );
      return reviews.filter(review => review.id === id);
    }
    if (
      text.includes(
        "UPDATE prospect_qc_model_reviews"
      ) &&
      text.includes("state = 'COMPLETED'")
    ) {
      const row = reviews.find(
        review =>
          review.id === values[values.length - 1]
      );
      if (!row) return [];
      const [
        providerRequestId,
        providerResponseHash,
        providerReportedCostUsd,
        totalTokens,
        modelReview,
        receipt,
        receiptHash,
      ] = values;
      Object.assign(row, {
        state: "COMPLETED",
        provider_request_id: providerRequestId,
        provider_response_hash: providerResponseHash,
        provider_reported_cost_usd:
          providerReportedCostUsd,
        total_tokens: totalTokens,
        review: modelReview,
        receipt,
        receipt_hash: receiptHash,
        completed_at: now.toISOString(),
      });
      events.push("sql:completed");
      return [{ id: row.id }];
    }
    if (
      text.includes("UPDATE prospect_outreach_jobs") &&
      text.includes("SET state = 'APPROVED'")
    ) {
      if (!job) return [];
      job.state = "APPROVED";
      job.qc_model_review_id =
        values.find(
          value =>
            typeof value === "string" &&
            /^[a-f0-9-]{36}$/.test(value) &&
            value !== approvalId
        ) || null;
      const hashes = values.filter(
        value =>
          typeof value === "string" &&
          /^[a-f0-9]{64}$/.test(value)
      );
      job.qc_model_review_receipt_hash =
        hashes.find(value => value !== job.payload_hash) ||
        null;
      return [{ id: job.id }];
    }
    if (
      text.includes("INSERT INTO prospect_outreach_events")
    ) {
      return [{ id: 81 }];
    }
    if (
      text.includes(
        "UPDATE prospect_qc_model_reviews"
      ) &&
      text.includes("failure_code")
    ) {
      const row = reviews.find(
        review =>
          review.id === values[values.length - 1]
      );
      if (!row) return [];
      row.state = values[0];
      row.failure_code = values[1];
      row.completed_at = now.toISOString();
      events.push(`sql:${String(values[0]).toLowerCase()}`);
      return [{ id: row.id }];
    }
    throw new Error(
      `Unexpected SQL in advisory QC route test: ${text}`
    );
  };
  sql.begin = async (callback: (tx: any) => unknown) =>
    callback(sql);
  sql.json = (value: unknown) => value;
  return { sql, job, reviews, events, queries };
}

type CapturedRoute = {
  handlers: Array<
    (
      req: Request,
      res: Response,
      next: () => void
    ) => unknown
  >;
};

function captureRoute(options: {
  sql: any;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  events?: string[];
}) {
  const routes = new Map<string, CapturedRoute>();
  const app: any = {};
  for (const method of ["get", "post", "patch"]) {
    app[method] = (
      path: string,
      ...handlers: CapturedRoute["handlers"]
    ) => {
      routes.set(`${method.toUpperCase()} ${path}`, {
        handlers,
      });
    };
  }
  const pass: RequestHandler = (_req, _res, next) =>
    next();
  const fullOperator: RequestHandler = (
    _req,
    _res,
    next
  ) => next();
  registerProspectOutreachRoutes(app, {
    dashboardAuth: pass,
    requireOperator: pass,
    requireFullOperator: fullOperator,
    sql: options.sql,
    dbEnabled: true,
    getWorkspaceId: () => 7,
    env: options.env || providerEnv(),
    fetchImpl:
      options.fetchImpl ||
      (async () => {
        throw new Error("Unexpected provider request.");
      }),
    now: () => new Date(now),
  });
  const route = routes.get(
    "POST /api/prospecting/outreach/:approvalId/qc-model-review"
  );
  assert.ok(route);
  return { route, fullOperator, routes };
}

function makeResponse() {
  const state: {
    statusCode: number;
    body: any;
  } = {
    statusCode: 200,
    body: undefined,
  };
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
  return {
    response: response as unknown as Response,
    state,
  };
}

async function invoke(options: {
  sql: any;
  payloadHash: string;
  confirmation?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  events?: string[];
}) {
  const { route, fullOperator } = captureRoute(options);
  assert.equal(route.handlers[1], fullOperator);
  const handler = route.handlers.at(-1)!;
  const { response, state } = makeResponse();
  await handler(
    {
      params: { approvalId },
      body: {
        payloadHash: options.payloadHash,
        confirmation:
          options.confirmation ??
          PROSPECT_QC_MODEL_REVIEW_CONFIRMATION,
      },
      authMode: "operator",
      operatorRole: "owner",
      operatorIdentity: "synthetic-owner",
    } as unknown as Request,
    response,
    () => undefined
  );
  return state;
}

async function invokeApproval(options: {
  sql: any;
  payloadHash: string;
  env?: Record<string, string | undefined>;
  qcAdvisoryFlagsReviewed?: boolean;
}) {
  const { routes } = captureRoute({
    sql: options.sql,
    env: options.env,
  });
  const route = routes.get(
    "POST /api/prospecting/outreach/:approvalId/approve"
  );
  assert.ok(route);
  const handler = route.handlers.at(-1)!;
  const { response, state } = makeResponse();
  await handler(
    {
      params: { approvalId },
      body: {
        payloadHash: options.payloadHash,
        attestations: {
          recipientReviewed: true,
          suppressionChecked: true,
          emailComplianceReviewed: true,
          qcAdvisoryFlagsReviewed:
            options.qcAdvisoryFlagsReviewed,
        },
      },
      authMode: "operator",
      operatorRole: "owner",
      operatorIdentity: "synthetic-owner",
    } as unknown as Request,
    response,
    () => undefined
  );
  return state;
}

function acceptedProviderResponse(
  output: {
    pass: boolean;
    confidence_score: number;
    failure_reasons: string[];
  } = {
    pass: true,
    confidence_score: 0.99,
    failure_reasons: [],
  }
) {
  return new Response(
    JSON.stringify({
      id: "gen-route-synthetic-1",
      choices: [
        {
          message: {
            content: JSON.stringify(output),
          },
        },
      ],
      usage: { cost: 0.0001, total_tokens: 90 },
    }),
    { status: 200 }
  );
}

test("invalid confirmation and disabled config stop before storage or provider", async () => {
  for (const [confirmation, env, expectedCode] of [
    [
      "review-all-drafts",
      providerEnv(),
      "PROSPECT_QC_MODEL_REVIEW_INVALID",
    ],
    [
      PROSPECT_QC_MODEL_REVIEW_CONFIRMATION,
      providerEnv({
        PROSPECT_QC_MODEL_REVIEW_ENABLED: "false",
      }),
      "PROSPECT_QC_MODEL_DISABLED",
    ],
  ] as const) {
    const { sql, job, queries } = makeSql();
    let requests = 0;
    const result = await invoke({
      sql,
      payloadHash: job!.payload_hash,
      confirmation,
      env,
      fetchImpl: (async () => {
        requests += 1;
        throw new Error("must not run");
      }) as typeof fetch,
    });
    assert.equal(result.body.code, expectedCode);
    assert.equal(requests, 0);
    assert.equal(
      queries.some(query =>
        query.text.includes(
          "INSERT INTO prospect_qc_model_reviews"
        )
      ),
      false
    );
  }
});

test("deterministic QC failure stops before token reservation", async () => {
  const { sql, job, reviews } = makeSql({
    job: baseJob({ deterministicFailure: true }),
  });
  let requests = 0;
  const result = await invoke({
    sql,
    payloadHash: job!.payload_hash,
    fetchImpl: (async () => {
      requests += 1;
      throw new Error("must not run");
    }) as typeof fetch,
  });
  assert.equal(result.statusCode, 409);
  assert.equal(
    result.body.code,
    "PROSPECT_QC_MODEL_DETERMINISTIC_GATE"
  );
  assert.equal(reviews.length, 0);
  assert.equal(requests, 0);
});

test("missing jobs, forged payload hashes, and reservation failure never reach the provider", async () => {
  for (const setup of [
    {
      sqlOptions: { job: null },
      payloadHash: "a".repeat(64),
      expectedCode: "PROSPECT_OUTREACH_NOT_FOUND",
    },
    {
      sqlOptions: {},
      payloadHash: "f".repeat(64),
      expectedCode: "PROSPECT_OUTREACH_PAYLOAD_MISMATCH",
    },
    {
      sqlOptions: { failReservation: true },
      payloadHash: null,
      expectedCode: "PROSPECT_QC_MODEL_RESERVATION_FAILED",
    },
  ] as const) {
    const { sql, job, reviews } = makeSql(
      setup.sqlOptions
    );
    let requests = 0;
    const result = await invoke({
      sql,
      payloadHash:
        setup.payloadHash || job!.payload_hash,
      fetchImpl: (async () => {
        requests += 1;
        throw new Error("must not run");
      }) as typeof fetch,
    });
    assert.equal(result.body.code, setup.expectedCode);
    assert.equal(requests, 0);
    assert.equal(reviews.length, 0);
  }
});

test("daily review and reserved-spend caps stop before provider", async () => {
  for (const options of [
    { reviewCount: 3, reservedSpendCents: 0 },
    { reviewCount: 0, reservedSpendCents: 5 },
  ]) {
    const { sql, job, reviews } = makeSql(options);
    let requests = 0;
    const result = await invoke({
      sql,
      payloadHash: job!.payload_hash,
      fetchImpl: (async () => {
        requests += 1;
        throw new Error("must not run");
      }) as typeof fetch,
    });
    assert.equal(result.statusCode, 429);
    assert.equal(
      result.body.code,
      "PROSPECT_QC_MODEL_DAILY_CAP"
    );
    assert.equal(reviews.length, 0);
    assert.equal(requests, 0);
  }
});

test("reservation precedes one provider request and produces an immutable no-contact receipt", async () => {
  const { sql, job, reviews, events } = makeSql();
  let requests = 0;
  const result = await invoke({
    sql,
    payloadHash: job!.payload_hash,
    events,
    fetchImpl: (async () => {
      requests += 1;
      events.push("provider:request");
      return acceptedProviderResponse();
    }) as typeof fetch,
  });
  assert.equal(result.statusCode, 201);
  assert.equal(result.body.outcome, "reviewed");
  assert.equal(result.body.providerRequestPerformed, true);
  assert.equal(result.body.contactAuthorized, false);
  assert.equal(result.body.executionAuthorized, false);
  assert.equal(requests, 1);
  assert.deepEqual(events, [
    "sql:reservation",
    "provider:request",
    "sql:completed",
  ]);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].state, "COMPLETED");
  assert.equal(reviews[0].receipt.review.status, "PASSED");
  assert.equal(
    reviews[0].receipt.humanApprovalRequired,
    true
  );
  assert.equal(reviews[0].receipt.contactAuthorized, false);
  assert.equal(
    reviews[0].receipt.executionAuthorized,
    false
  );

  const replay = await invoke({
    sql,
    payloadHash: job!.payload_hash,
    events,
    fetchImpl: (async () => {
      requests += 1;
      throw new Error("must not replay");
    }) as typeof fetch,
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.outcome, "duplicate");
  assert.equal(replay.body.providerRequestPerformed, false);
  assert.equal(requests, 1);
  assert.equal(reviews.length, 1);
});

test("uncertain provider result is durable and cannot automatically replay", async () => {
  const { sql, job, reviews } = makeSql();
  let requests = 0;
  const first = await invoke({
    sql,
    payloadHash: job!.payload_hash,
    fetchImpl: (async () => {
      requests += 1;
      return new Response(
        JSON.stringify({ error: "rate limited" }),
        { status: 429 }
      );
    }) as typeof fetch,
  });
  assert.equal(first.statusCode, 503);
  assert.equal(first.body.state, "OUTCOME_UNKNOWN");
  assert.equal(first.body.automaticRetryAllowed, false);
  assert.equal(reviews[0].state, "OUTCOME_UNKNOWN");

  const replay = await invoke({
    sql,
    payloadHash: job!.payload_hash,
    fetchImpl: (async () => {
      requests += 1;
      throw new Error("must not replay");
    }) as typeof fetch,
  });
  assert.equal(replay.statusCode, 409);
  assert.equal(
    replay.body.code,
    "PROSPECT_QC_MODEL_REVIEW_REPLAY_BLOCKED"
  );
  assert.equal(requests, 1);
});

test("required advisory policy blocks approval when no exact receipt exists", async () => {
  const { sql, job } = makeSql();
  const result = await invokeApproval({
    sql,
    payloadHash: job!.payload_hash,
    env: providerEnv({
      PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL:
        "true",
    }),
  });
  assert.equal(result.statusCode, 409);
  assert.equal(
    result.body.code,
    "PROSPECT_QC_MODEL_REVIEW_REQUIRED"
  );
  assert.equal(job!.state, "PREPARED");
  assert.equal(job!.qc_model_review_id, null);
});

test("flagged advisory receipt requires human acknowledgment and binds approval to the receipt", async () => {
  const { sql, job, reviews } = makeSql();
  const env = providerEnv({
    PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL:
      "true",
  });
  const reviewed = await invoke({
    sql,
    payloadHash: job!.payload_hash,
    env,
    fetchImpl: (async () =>
      acceptedProviderResponse({
        pass: false,
        confidence_score: 0.94,
        failure_reasons: [
          "The operator should verify the overflow-system wording.",
        ],
      })) as typeof fetch,
  });
  assert.equal(reviewed.statusCode, 201);
  assert.equal(reviews[0].receipt.review.status, "FLAGGED");

  const unacknowledged = await invokeApproval({
    sql,
    payloadHash: job!.payload_hash,
    env,
  });
  assert.equal(unacknowledged.statusCode, 409);
  assert.equal(
    unacknowledged.body.code,
    "PROSPECT_OUTREACH_COMPLIANCE_ATTESTATION_REQUIRED"
  );
  assert.equal(job!.state, "PREPARED");

  const approved = await invokeApproval({
    sql,
    payloadHash: job!.payload_hash,
    env,
    qcAdvisoryFlagsReviewed: true,
  });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.body.outcome, "approved");
  assert.equal(approved.body.externalAction, "none");
  assert.equal(job!.state, "APPROVED");
  assert.equal(
    job!.qc_model_review_id,
    reviews[0].review_id
  );
  assert.equal(
    job!.qc_model_review_receipt_hash,
    reviews[0].receipt_hash
  );
});

test("changed advisory receipt hash fails approval closed", async () => {
  const { sql, job, reviews } = makeSql();
  const env = providerEnv({
    PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL:
      "true",
  });
  await invoke({
    sql,
    payloadHash: job!.payload_hash,
    env,
    fetchImpl: (async () =>
      acceptedProviderResponse()) as typeof fetch,
  });
  reviews[0].receipt_hash = "f".repeat(64);
  const result = await invokeApproval({
    sql,
    payloadHash: job!.payload_hash,
    env,
  });
  assert.equal(result.statusCode, 409);
  assert.equal(
    result.body.code,
    "PROSPECT_QC_MODEL_RECEIPT_INVALID"
  );
  assert.equal(job!.state, "PREPARED");
});

test("a later failed model attempt cannot hide an earlier completed flag", async () => {
  const { sql, job, reviews } = makeSql();
  await invoke({
    sql,
    payloadHash: job!.payload_hash,
    fetchImpl: (async () =>
      acceptedProviderResponse({
        pass: false,
        confidence_score: 0.9,
        failure_reasons: [
          "The earlier completed review requires operator acknowledgment.",
        ],
      })) as typeof fetch,
  });
  assert.equal(reviews[0].state, "COMPLETED");

  const alternateModelEnv = providerEnv({
    PROSPECT_QC_OPENROUTER_MODEL:
      "google/gemini-2.5-flash-lite",
  });
  const failedLater = await invoke({
    sql,
    payloadHash: job!.payload_hash,
    env: alternateModelEnv,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({ error: "synthetic unavailable" }),
        { status: 503 }
      )) as typeof fetch,
  });
  assert.equal(failedLater.statusCode, 503);
  assert.equal(reviews.at(-1)?.state, "OUTCOME_UNKNOWN");

  const unacknowledged = await invokeApproval({
    sql,
    payloadHash: job!.payload_hash,
    env: alternateModelEnv,
  });
  assert.equal(unacknowledged.statusCode, 409);
  assert.equal(
    unacknowledged.body.code,
    "PROSPECT_OUTREACH_COMPLIANCE_ATTESTATION_REQUIRED"
  );
  assert.equal(job!.state, "PREPARED");
});
