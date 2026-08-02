import assert from "node:assert/strict";
import test from "node:test";
import type { Request, RequestHandler, Response } from "express";
import { registerProspectOutreachRoutes } from "../src/routes/prospect-outreach-routes.ts";
import {
  PROSPECT_EMAIL_EXECUTION_CONFIRMATION,
  PROSPECT_EMAIL_EXECUTION_MODE,
} from "../src/prospect-email-provider.ts";
import {
  PROSPECT_EMAIL_RECEIVING_MODE,
} from "../src/prospect-email-receiving.ts";
import {
  buildProspectOutreachPayload,
  hashProspectOutreachPayload,
} from "../src/prospect-outreach.ts";
import {
  buildProspectQcModelReview,
} from "../src/prospect-qc.ts";
import {
  buildProspectQcModelReviewReceipt,
} from "../src/prospect-qc-model-provider.ts";

const approvalId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-07-30T18:00:00.000Z");
const evidenceHash = "a".repeat(64);

type CapturedRoute = {
  handlers: Array<
    (req: Request, res: Response, next: () => void) => unknown
  >;
};

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
    PROSPECT_EMAIL_WEBHOOK_ENABLED: "true",
    PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET:
      "whsec_abcdefghijklmnop",
    PROSPECT_EMAIL_RECEIVING_ENABLED: "true",
    PROSPECT_EMAIL_RECEIVING_MODE,
    PROSPECT_EMAIL_RESEND_RECEIVING_API_KEY:
      "re_receivingabcdefghijklmnop",
    PROSPECT_EMAIL_RECEIVING_WORKSPACE_ID: "7",
    ...overrides,
  };
}

function emailPayload() {
  return buildProspectOutreachPayload({
    workspaceId: 7,
    campaignId: 17,
    prospectId: 23,
    recipient: "owner@example.com",
    evidenceHash,
    preparedAt: "2026-07-30T16:00:00.000Z",
    qcContext: {
      businessName: "Synthetic Plumbing",
      industry: "plumbing",
      evidenceObservation:
        "a possible mobile booking issue that may be creating friction.",
    },
    draft: {
      channel: "email",
      subject: "Capturing urgent plumbing calls",
      body:
        "I noticed a possible mobile booking issue that may be creating friction. Would one review-only proof call be useful?",
      emailCompliance: {
        senderIdentity: "SMIRK",
        advertisementDisclosure:
          "This is a commercial message from SMIRK.",
        physicalPostalAddress: "100 Example Way, Reno, NV 89501",
        optOutInstructions:
          "If this is not relevant, reply no and I will not follow up.",
      },
      maxCostCents: 2,
      expiresInHours: 24,
    },
  });
}

function callPayload() {
  return buildProspectOutreachPayload({
    workspaceId: 7,
    campaignId: 17,
    prospectId: 23,
    recipient: "+17755550142",
    evidenceHash,
    preparedAt: "2026-07-30T16:00:00.000Z",
    qcContext: {
      businessName: "Synthetic Plumbing",
      industry: "plumbing",
      evidenceObservation: null,
    },
    draft: {
      channel: "call",
      callBrief:
        "Review the public business record. A human operator may decide whether to dial this business manually.",
      maxCostCents: 10,
      expiresInHours: 8,
    },
  });
}

function baseJob(
  overrides: Record<string, unknown> = {}
): Record<string, any> {
  const payload = emailPayload();
  return {
    id: 9,
    state: "APPROVED",
    channel: "email",
    lead_id: 23,
    recipient: payload.recipient,
    payload,
    payload_hash: hashProspectOutreachPayload(payload),
    max_cost_cents: 2,
    approved_at: "2026-07-30T17:55:00.000Z",
    approval_attestations: {
      recipientReviewed: true,
      suppressionChecked: true,
      emailComplianceReviewed: true,
    },
    expires_at: "2026-07-31T16:00:00.000Z",
    provider_name: null,
    provider_idempotency_key: null,
    provider_message_id: null,
    provider_cost_cents: null,
    provider_requested_at: null,
    provider_response_at: null,
    provider_attempts: 0,
    execution_proof_reference: null,
    failure_code: null,
    qc_model_review_id: null,
    qc_model_review_receipt_hash: null,
    current_email: payload.recipient,
    current_email_verification: "verified_owner_email",
    current_lead_status: "pending",
    current_review_state: "qualified",
    ...overrides,
  };
}

function makeSql(options: {
  job?: Record<string, any> | null;
  suppressed?: boolean;
  recipientCount?: number;
  reservedSpendCents?: number;
  pause?: { pendingCount: number };
  qcReview?: Record<string, any>;
}) {
  const job =
    options.job === undefined ? baseJob() : options.job;
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const sql: any = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    if (text.includes("pg_advisory_xact_lock")) {
      return [{ pg_advisory_xact_lock: null }];
    }
    if (text.includes("SELECT j.id, j.state, j.channel")) {
      return job ? [job] : [];
    }
    if (
      text.includes("FROM prospect_positive_outcome_reviews")
    ) {
      return [
        {
          pending_count: options.pause?.pendingCount || 0,
        },
      ];
    }
    if (text.includes("FROM prospect_qc_model_reviews")) {
      return options.qcReview ? [options.qcReview] : [];
    }
    if (text.includes("FROM prospect_email_suppressions")) {
      return options.suppressed ? [{ id: 41 }] : [];
    }
    if (text.includes("AS recipient_count")) {
      return [
        {
          recipient_count: options.recipientCount || 0,
          reserved_spend_cents: options.reservedSpendCents || 0,
        },
      ];
    }
    if (
      text.includes("UPDATE prospect_outreach_jobs") &&
      text.includes("SET state = 'SENDING'")
    ) {
      if (job) {
        job.state = "SENDING";
        job.provider_name = "resend";
        job.provider_idempotency_key = values.find(
          (value) =>
            typeof value === "string" &&
            value.startsWith("smirk-prospect-email/")
        );
        job.provider_cost_cents = 2;
        job.provider_requested_at = now.toISOString();
        job.provider_response_at = null;
        job.provider_attempts = 1;
      }
      return [{ id: 9 }];
    }
    if (
      text.includes("SELECT id, state, payload_hash, provider_name")
    ) {
      return job ? [job] : [];
    }
    if (
      text.includes("UPDATE prospect_outreach_jobs") &&
      text.includes("SET state = 'SENT'")
    ) {
      if (job) {
        job.state = "SENT";
        job.provider_message_id = values.find(
          (value) =>
            typeof value === "string" &&
            value.startsWith("email_")
        );
        job.execution_proof_reference = values.find(
          (value) =>
            typeof value === "string" &&
            value.startsWith("provider:resend/")
        );
      }
      return [{ id: 9 }];
    }
    if (
      text.includes("UPDATE prospect_outreach_jobs") &&
      text.includes("provider_response_at") &&
      !text.includes("SET state = 'FAILED'")
    ) {
      if (job) {
        job.provider_response_at = now.toISOString();
        job.failure_code = values.find(
          (value) =>
            typeof value === "string" &&
            value.startsWith("PROSPECT_EMAIL_")
        );
      }
      return [{ id: 9 }];
    }
    if (
      text.includes("UPDATE prospect_outreach_jobs") &&
      text.includes("SET state = 'FAILED'")
    ) {
      if (job) job.state = "FAILED";
      return [{ id: 9 }];
    }
    if (text.includes("INSERT INTO prospect_outreach_events")) {
      return [{ id: queries.length + 100 }];
    }
    throw new Error(`Unexpected SQL in provider route test: ${text}`);
  };
  sql.begin = async (callback: (tx: any) => unknown) => callback(sql);
  sql.json = (value: unknown) => value;
  return { sql, queries, job };
}

function completedQcModelReviewRow(payload: ReturnType<typeof emailPayload>) {
  const result = {
    status: "accepted" as const,
    provider: "openrouter" as const,
    model: "google/gemini-2.5-flash",
    review: buildProspectQcModelReview({
      rawOutput: {
        pass: true,
        confidence_score: 0.99,
        failure_reasons: [],
      },
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
      latencyMs: 20,
      estimatedCostCents: 1,
    }),
    responseHash: "d".repeat(64),
    providerRequestId: "gen-synthetic-bound-review",
    providerReportedCostUsd: 0.0001,
    totalTokens: 80,
  };
  const built = buildProspectQcModelReviewReceipt({
    reviewId: "22222222-2222-4222-8222-222222222222",
    workspaceId: 7,
    approvalId,
    outreachJobId: 9,
    requestHash: "c".repeat(64),
    payloadHash: hashProspectOutreachPayload(payload),
    draftHash: payload.qcReceipt!.draftHash,
    evidenceHash: payload.qcReceipt!.evidenceHash,
    result,
    reservedCostCents: 1,
    reviewedAt: "2026-07-30T17:50:00.000Z",
  });
  return {
    id: 51,
    review_id: built.receipt.reviewId,
    workspace_id: 7,
    outreach_job_id: 9,
    state: "COMPLETED",
    request_hash: built.receipt.requestHash,
    payload_hash: built.receipt.payloadHash,
    draft_hash: built.receipt.draftHash,
    evidence_hash: built.receipt.evidenceHash,
    provider: built.receipt.provider,
    model: built.receipt.model,
    reserved_cost_cents: 1,
    provider_request_id: built.receipt.providerRequestId,
    provider_response_hash: built.receipt.responseHash,
    provider_reported_cost_usd:
      built.receipt.providerReportedCostUsd,
    total_tokens: built.receipt.totalTokens,
    review: built.receipt.review,
    receipt: built.receipt,
    receipt_hash: built.receiptHash,
    failure_code: null,
    requested_by: "synthetic-owner",
    requested_at: "2026-07-30T17:49:00.000Z",
    completed_at: "2026-07-30T17:50:00.000Z",
  };
}

function captureExecutionRoute(options: {
  sql: any;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}) {
  const routes = new Map<string, CapturedRoute>();
  const app: any = {};
  for (const method of ["get", "post", "patch"]) {
    app[method] = (
      path: string,
      ...handlers: CapturedRoute["handlers"]
    ) => routes.set(`${method.toUpperCase()} ${path}`, { handlers });
  }
  const pass: RequestHandler = (_req, _res, next) => next();
  const fullOperator: RequestHandler = (_req, _res, next) => next();
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
    "POST /api/prospecting/outreach/:approvalId/execute"
  );
  assert.ok(route);
  return { route, fullOperator };
}

function makeResponse() {
  const state: { statusCode: number; body: any } = {
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
  return { response: response as unknown as Response, state };
}

async function invoke(options: {
  sql: any;
  payloadHash: string;
  confirmation?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}) {
  const { route, fullOperator } = captureExecutionRoute(options);
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
          PROSPECT_EMAIL_EXECUTION_CONFIRMATION,
      },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );
  return state;
}

test("provider execution requires the exact second confirmation", async () => {
  const { sql, queries, job } = makeSql({});
  const result = await invoke({
    sql,
    payloadHash: job!.payload_hash,
    confirmation: "approve",
  });
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.code, "PROSPECT_EMAIL_EXECUTION_INVALID");
  assert.equal(queries.length, 0);
});

test("disabled and workspace-mismatched config stop before storage or fetch", async () => {
  for (const [overrides, expectedCode] of [
    [
      { PROSPECT_EMAIL_EXECUTION_ENABLED: "false" },
      "PROSPECT_EMAIL_EXECUTION_DISABLED",
    ],
    [
      { PROSPECT_EMAIL_WORKSPACE_ID: "99" },
      "PROSPECT_EMAIL_WORKSPACE_LOCKED",
    ],
  ] as const) {
    const { sql, queries, job } = makeSql({});
    let requests = 0;
    const result = await invoke({
      sql,
      payloadHash: job!.payload_hash,
      env: providerEnv(overrides),
      fetchImpl: (async () => {
        requests += 1;
        throw new Error("must not run");
      }) as typeof fetch,
    });
    assert.equal(result.body.code, expectedCode);
    assert.equal(queries.length, 0);
    assert.equal(requests, 0);
  }
});

test("a new approved email cannot execute without the signed outcome webhook", async () => {
  const { sql, job } = makeSql({});
  let requests = 0;
  const result = await invoke({
    sql,
    payloadHash: job!.payload_hash,
    env: providerEnv({
      PROSPECT_EMAIL_WEBHOOK_ENABLED: "false",
    }),
    fetchImpl: (async () => {
      requests += 1;
      throw new Error("must not run");
    }) as typeof fetch,
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "PROSPECT_EMAIL_WEBHOOK_DISABLED");
  assert.equal(job!.state, "APPROVED");
  assert.equal(requests, 0);
});

test("a new approved email cannot bypass inbound content retrieval readiness", async () => {
  for (const [overrides, expectedStatus, expectedCode] of [
    [
      { PROSPECT_EMAIL_RECEIVING_ENABLED: "false" },
      409,
      "PROSPECT_EMAIL_RECEIVING_DISABLED",
    ],
    [
      { PROSPECT_EMAIL_RESEND_RECEIVING_API_KEY: "" },
      503,
      "PROSPECT_EMAIL_RECEIVING_NOT_CONFIGURED",
    ],
    [
      { PROSPECT_EMAIL_RECEIVING_WORKSPACE_ID: "99" },
      403,
      "PROSPECT_EMAIL_RECEIVING_WORKSPACE_MISMATCH",
    ],
  ] as const) {
    const { sql, queries, job } = makeSql({});
    let requests = 0;
    const result = await invoke({
      sql,
      payloadHash: job!.payload_hash,
      env: providerEnv(overrides),
      fetchImpl: (async () => {
        requests += 1;
        throw new Error("must not run");
      }) as typeof fetch,
    });
    assert.equal(result.statusCode, expectedStatus);
    assert.equal(result.body.code, expectedCode);
    assert.equal(job!.state, "APPROVED");
    assert.equal(
      queries.some((query) =>
        query.text.includes("SET state = 'SENDING'")
      ),
      false
    );
    assert.equal(requests, 0);
  }
});

test("forged hashes, call jobs, suppressions, and caps never reach Resend", async () => {
  const cases = [
    {
      make: () => makeSql({}),
      hash: "b".repeat(64),
      code: "PROSPECT_OUTREACH_PAYLOAD_MISMATCH",
    },
    {
      make: () => {
        const payload = callPayload();
        return makeSql({
          job: baseJob({
            channel: "call",
            recipient: payload.recipient,
            payload,
            payload_hash: hashProspectOutreachPayload(payload),
          }),
        });
      },
      hash: null,
      code: "PROSPECT_CALL_PROVIDER_EXECUTION_DISABLED",
    },
    {
      make: () => makeSql({ suppressed: true }),
      hash: null,
      code: "PROSPECT_EMAIL_RECIPIENT_SUPPRESSED",
    },
    {
      make: () => makeSql({ recipientCount: 3 }),
      hash: null,
      code: "PROSPECT_EMAIL_DAILY_CAP_REACHED",
    },
  ];

  for (const testCase of cases) {
    const setup = testCase.make();
    let requests = 0;
    const result = await invoke({
      sql: setup.sql,
      payloadHash: testCase.hash || setup.job!.payload_hash,
      fetchImpl: (async () => {
        requests += 1;
        throw new Error("must not run");
      }) as typeof fetch,
    });
    assert.equal(result.body.code, testCase.code);
    assert.equal(requests, 0);
  }
});

test("a changed advisory receipt blocks the later provider request", async () => {
  const payload = emailPayload();
  const review = completedQcModelReviewRow(payload);
  const originalReceiptHash = review.receipt_hash;
  review.receipt_hash = "f".repeat(64);
  const { sql, job } = makeSql({
    job: baseJob({
      payload,
      payload_hash: hashProspectOutreachPayload(payload),
      qc_model_review_id: review.review_id,
      qc_model_review_receipt_hash: originalReceiptHash,
    }),
    qcReview: review,
  });
  let requests = 0;
  const result = await invoke({
    sql,
    payloadHash: job!.payload_hash,
    fetchImpl: (async () => {
      requests += 1;
      throw new Error("must not reach Resend");
    }) as typeof fetch,
  });
  assert.equal(result.statusCode, 409);
  assert.equal(
    result.body.code,
    "PROSPECT_QC_MODEL_APPROVAL_BINDING_INVALID"
  );
  assert.equal(requests, 0);
  assert.equal(job!.state, "APPROVED");
});

test("one approved email is claimed and recorded as provider accepted, not delivered", async () => {
  const setup = makeSql({});
  let requests = 0;
  const result = await invoke({
    sql: setup.sql,
    payloadHash: setup.job!.payload_hash,
    fetchImpl: (async () => {
      requests += 1;
      return new Response(
        JSON.stringify({ id: "email_synthetic_0001" }),
        { status: 200 }
      );
    }) as typeof fetch,
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.outcome, "accepted");
  assert.equal(result.body.state, "SENT");
  assert.equal(result.body.providerAccepted, true);
  assert.equal(result.body.delivered, false);
  assert.equal(result.body.externalAction, "provider_request_accepted");
  assert.equal(requests, 1);
  assert.equal(setup.job!.state, "SENT");
  assert.equal(
    setup.queries.filter((query) =>
      query.text.includes("SET state = 'SENDING'")
    ).length,
    1
  );
  assert.equal(
    setup.queries.some((query) =>
      query.text.includes("pg_advisory_xact_lock")
    ),
    true
  );
});

test("a pending positive interaction blocks a first email provider request", async () => {
  const pause = { pendingCount: 1 };
  const setup = makeSql({ pause });
  let requests = 0;
  const result = await invoke({
    sql: setup.sql,
    payloadHash: setup.job!.payload_hash,
    fetchImpl: (async () => {
      requests += 1;
      throw new Error("must not run");
    }) as typeof fetch,
  });

  assert.equal(result.statusCode, 409);
  assert.equal(
    result.body.code,
    "PROSPECT_ACQUISITION_PAUSED_FOR_INTERACTION_REVIEW"
  );
  assert.equal(result.body.pendingPositiveOutcomeReviews, 1);
  assert.equal(result.body.externalAction, "none");
  assert.equal(setup.job!.state, "APPROVED");
  assert.equal(requests, 0);
});

test("a pending positive interaction preserves same-key SENDING reconciliation", async () => {
  const pause = { pendingCount: 0 };
  const setup = makeSql({ pause });
  const first = await invoke({
    sql: setup.sql,
    payloadHash: setup.job!.payload_hash,
    fetchImpl: (async () => {
      throw new Error("synthetic timeout");
    }) as typeof fetch,
  });
  assert.equal(first.statusCode, 503);
  assert.equal(setup.job!.state, "SENDING");
  const pauseQueriesBefore = setup.queries.filter(query =>
    query.text.includes(
      "FROM prospect_positive_outcome_reviews"
    )
  ).length;

  pause.pendingCount = 1;
  const second = await invoke({
    sql: setup.sql,
    payloadHash: setup.job!.payload_hash,
    env: providerEnv({
      PROSPECT_EMAIL_WEBHOOK_ENABLED: "false",
    }),
    fetchImpl: (async () => {
      throw new Error("must not run during retry cooldown");
    }) as typeof fetch,
  });

  assert.equal(second.statusCode, 409);
  assert.equal(
    second.body.code,
    "PROSPECT_EMAIL_PROVIDER_REQUEST_IN_FLIGHT"
  );
  assert.equal(setup.job!.state, "SENDING");
  assert.equal(
    setup.queries.filter(query =>
      query.text.includes(
        "FROM prospect_positive_outcome_reviews"
      )
    ).length,
    pauseQueriesBefore,
    "SENDING reconciliation must not be blocked by a new pause check"
  );
});

test("an uncertain provider response stays SENDING for same-key reconciliation", async () => {
  const setup = makeSql({});
  const result = await invoke({
    sql: setup.sql,
    payloadHash: setup.job!.payload_hash,
    fetchImpl: (async () => {
      throw new Error("synthetic timeout");
    }) as typeof fetch,
  });

  assert.equal(result.statusCode, 503);
  assert.equal(result.body.state, "SENDING");
  assert.equal(
    result.body.externalAction,
    "provider_request_outcome_unknown"
  );
  assert.equal(result.body.retryable, true);
  assert.equal(setup.job!.state, "SENDING");
});

test("a stored provider acceptance replays without another provider call", async () => {
  const payload = emailPayload();
  const payloadHash = hashProspectOutreachPayload(payload);
  const setup = makeSql({
    job: baseJob({
      state: "SENT",
      payload,
      payload_hash: payloadHash,
      provider_name: "resend",
      provider_idempotency_key:
        "smirk-prospect-email/11111111-1111-4111-8111-111111111111/aaaaaaaaaaaaaaaaaaaaaaaa",
      provider_message_id: "email_synthetic_0001",
      execution_proof_reference:
        "provider:resend/email_synthetic_0001",
    }),
  });
  let requests = 0;
  const result = await invoke({
    sql: setup.sql,
    payloadHash,
    fetchImpl: (async () => {
      requests += 1;
      throw new Error("must not run");
    }) as typeof fetch,
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.outcome, "duplicate");
  assert.equal(result.body.delivered, false);
  assert.equal(requests, 0);
});
