import assert from "node:assert/strict";
import test from "node:test";
import type {
  Request,
  RequestHandler,
  Response,
} from "express";
import {
  VELVET_LEAD_SOURCE_APPROVAL_CONFIRMATION,
  VELVET_LEAD_SOURCE_CANCEL_CONFIRMATION,
  VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION,
  VELVET_LEAD_SOURCE_RESPONSE_CONTRACT,
  hashVelvetLeadSourceValue,
} from "../src/velvet-lead-source.ts";
import {
  registerVelvetLeadSourceRoutes,
} from "../src/routes/velvet-lead-source-routes.ts";

const now = new Date("2026-07-30T19:00:00.000Z");
const configuredEnv = {
  VELVET_LEAD_SOURCE_ENABLED: "true",
  VELVET_LEAD_SOURCE_BASE_URL:
    "https://velvetalchemy.manus.space",
  VELVET_LEAD_SOURCE_API_KEY:
    "velvet-source-api-key-0000000000000001",
  VELVET_LEAD_SOURCE_WORKSPACE_ID: "7",
  VELVET_OUTCOME_API_KEY:
    "different-outcome-api-key-000000000001",
};

function makeSql(options: { pendingPositiveReviews?: number } = {}) {
  const state = {
    row: null as any,
    items: new Map<string, any>(),
    events: [] as string[],
    queries: [] as string[],
    pendingPositiveReviews:
      options.pendingPositiveReviews || 0,
  };
  const sql: any = (
    strings: TemplateStringsArray,
    ...values: any[]
  ) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    state.queries.push(text);
    if (text.includes("INSERT INTO velvet_lead_source_requests")) {
      state.row = {
        id: 44,
        request_id: values[0],
        workspace_id: values[1],
        state: "PREPARED",
        criteria: values[2],
        request_payload: values[3],
        request_payload_hash: values[4],
        prepared_by: values[5],
        approved_by: null,
        approved_at: null,
        approval_attestations: null,
        expires_at: values[6],
        attempts: 0,
        remote_batch_id: null,
        remote_original_state: null,
        remote_response: null,
        remote_response_hash: null,
        applied_learning_candidate: null,
        imported_count: 0,
        failed_count: 0,
        last_error: null,
        dispatch_requested_by: null,
        dispatch_requested_at: null,
        dispatch_response_at: null,
        completed_at: null,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      };
      return [{ id: 44 }];
    }
    if (text.includes("INSERT INTO velvet_lead_source_request_events")) {
      state.events.push(String(values[4]));
      return [{ id: state.events.length }];
    }
    if (text.includes("SELECT * FROM velvet_lead_source_requests")) {
      return state.row ? [state.row] : [];
    }
    if (
      text.includes("UPDATE velvet_lead_source_requests") &&
      text.includes("SET state = 'APPROVED'")
    ) {
      state.row.state = "APPROVED";
      state.row.approved_by = values[0];
      state.row.approved_at = values[1];
      state.row.approval_attestations = values[2];
      return [{ id: 44 }];
    }
    if (
      text.includes("UPDATE velvet_lead_source_requests") &&
      text.includes("SET state = 'EXPIRED'")
    ) {
      state.row.state = "EXPIRED";
      return [{ id: 44 }];
    }
    if (
      text.includes("UPDATE velvet_lead_source_requests") &&
      text.includes("SET state = 'CANCELLED'")
    ) {
      state.row.state = "CANCELLED";
      state.row.last_error = values[0];
      return [{ id: 44 }];
    }
    if (text.includes("SELECT pg_advisory_xact_lock")) {
      return [{ pg_advisory_xact_lock: null }];
    }
    if (
      text.includes("FROM prospect_positive_outcome_reviews")
    ) {
      return [
        {
          pending_count: state.pendingPositiveReviews,
        },
      ];
    }
    if (
      text.includes("UPDATE velvet_lead_source_requests") &&
      text.includes("SET state = 'SENDING'")
    ) {
      state.row.state = "SENDING";
      state.row.attempts += 1;
      state.row.dispatch_requested_by = values[0];
      state.row.dispatch_requested_at = values[1];
      return [{ id: 44 }];
    }
    if (
      text.includes("UPDATE velvet_lead_source_requests") &&
      text.includes("SET remote_batch_id")
    ) {
      state.row.remote_batch_id = values[0];
      state.row.remote_original_state = values[1];
      state.row.remote_response = values[2];
      state.row.remote_response_hash = values[3];
      state.row.applied_learning_candidate = values[4];
      state.row.dispatch_response_at = values[5];
      return [{ id: 44 }];
    }
    if (
      text.includes("SELECT import_state") &&
      text.includes("velvet_lead_source_request_items")
    ) {
      const item = state.items.get(String(values[2]));
      return item ? [{ import_state: item.import_state }] : [];
    }
    if (text.includes("INSERT INTO velvet_lead_source_request_items")) {
      const externalId = String(values[2]);
      const failed = text.includes("'FAILED'");
      state.items.set(externalId, {
        import_state: failed ? "FAILED" : String(values[4]),
        campaign_id: failed ? null : values[5],
        prospect_id: failed ? null : values[6],
      });
      return [{ id: state.items.size }];
    }
    if (
      text.includes("COUNT(*) FILTER") &&
      text.includes("velvet_lead_source_request_items")
    ) {
      const records = Array.from(state.items.values());
      return [
        {
          imported_count: records.filter(item =>
            ["IMPORTED", "DUPLICATE"].includes(item.import_state)
          ).length,
          failed_count: records.filter(
            item => item.import_state === "FAILED"
          ).length,
        },
      ];
    }
    if (
      text.includes("UPDATE velvet_lead_source_requests") &&
      text.includes("imported_count")
    ) {
      state.row.state = values[0];
      state.row.imported_count = values[1];
      state.row.failed_count = values[2];
      state.row.last_error = values[3];
      state.row.completed_at = values[4];
      return [{ id: 44 }];
    }
    if (
      text.includes("UPDATE velvet_lead_source_requests") &&
      text.includes("last_error") &&
      text.includes("dispatch_response_at")
    ) {
      state.row.state = values[0];
      state.row.last_error = values[1];
      state.row.dispatch_response_at = values[2];
      return [{ id: 44 }];
    }
    if (
      text.includes("UPDATE velvet_lead_source_requests") &&
      text.includes("attempts = attempts + 1")
    ) {
      state.row.attempts += 1;
      return [{ id: 44 }];
    }
    throw new Error(`Unexpected SQL in Velvet source route test: ${text}`);
  };
  sql.begin = async (callback: (tx: any) => unknown) => callback(sql);
  sql.json = (value: unknown) => value;
  return { sql, state };
}

function captureRoutes(options: {
  sql: any;
  fetchImpl?: typeof fetch;
  store?: {
    receive(input: any): Promise<{
      outcome: "created" | "duplicate";
      campaignId: number;
      prospectId: number;
    }>;
  };
}) {
  const routes = new Map<string, any[]>();
  const app: any = {};
  for (const method of ["get", "post"]) {
    app[method] = (path: string, ...handlers: any[]) =>
      routes.set(`${method.toUpperCase()} ${path}`, handlers);
  }
  const dashboard: RequestHandler = (_req, _res, next) => next();
  const operator: RequestHandler = (_req, _res, next) => next();
  const fullOperator: RequestHandler = (_req, _res, next) => next();
  registerVelvetLeadSourceRoutes(app, {
    dashboardAuth: dashboard,
    requireOperator: operator,
    requireFullOperator: fullOperator,
    sql: options.sql,
    dbEnabled: true,
    getWorkspaceId: () => 7,
    store:
      options.store ||
      ({
        async receive() {
          return {
            outcome: "created" as const,
            campaignId: 17,
            prospectId: 23,
          };
        },
      } as any),
    env: configuredEnv,
    fetchImpl:
      options.fetchImpl ||
      (async () => {
        throw new Error("Unexpected network request.");
      }),
    now: () => new Date(now),
  });
  return { routes, fullOperator };
}

function makeResponse() {
  const state = { statusCode: 200, body: undefined as any };
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

async function invoke(
  handlers: any[],
  input: { body?: unknown; params?: Record<string, string> }
) {
  const { response, state } = makeResponse();
  await handlers.at(-1)(
    {
      body: input.body || {},
      params: input.params || {},
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );
  return state;
}

async function prepare(setup: ReturnType<typeof makeSql>) {
  const captured = captureRoutes({ sql: setup.sql });
  const result = await invoke(
    captured.routes.get(
      "POST /api/prospecting/velvet-source/requests"
    )!,
    {
      body: {
        criteria: {
          limit: 1,
          category: "plumbing",
          city: "Reno",
          state: "NV",
          learningMode: "none",
        },
      },
    }
  );
  return { ...captured, result };
}

async function approve(
  setup: ReturnType<typeof makeSql>,
  confirmation: string = VELVET_LEAD_SOURCE_APPROVAL_CONFIRMATION
) {
  const captured = captureRoutes({ sql: setup.sql });
  return invoke(
    captured.routes.get(
      "POST /api/prospecting/velvet-source/requests/:id/approve"
    )!,
    {
      params: { id: "44" },
      body: {
        payloadHash: setup.state.row.request_payload_hash,
        confirmation,
        attestations: {
          noContactAuthorized: true,
          zeroSpendAuthorized: true,
        },
      },
    }
  );
}

function responseForRequest(request: any) {
  const prospects = [
    {
      contractVersion: "velvet-smirk.prospect.v1",
      workspaceId: 7,
      externalId: "velvet-owner-1-lead-42",
      batch: {
        externalId: request.requestId,
        name: "Synthetic reviewed batch",
      },
      prospect: {
        companyName: "Synthetic Plumbing Test",
        phone: "+17755550142",
        phoneContactMode: "operator_review_only",
        website: "https://example.com/synthetic",
        evidence: [
          {
            url: "https://example.com/synthetic",
            observation: "Public website recorded for operator review.",
            observedAt: "2026-07-30T18:00:00.000Z",
            kind: "website",
            basis: "observed",
            confidence: "high",
          },
        ],
        notes:
          "Research-only import. No outreach, SMS, call, handoff, or callback task is authorized.",
      },
    },
  ];
  return {
    ok: true,
    contractVersion: VELVET_LEAD_SOURCE_RESPONSE_CONTRACT,
    state: "EXPORTED",
    originalState: "EXPORTED",
    requestId: request.requestId,
    requestPayloadHash: hashVelvetLeadSourceValue(request),
    batchId: 9,
    prospectsHash: hashVelvetLeadSourceValue(prospects),
    prospects,
    appliedLearningCandidate: null,
    contactActionAllowed: false,
    spendAuthorized: false,
    externalAction: "research_export_only",
  };
}

test("prepare is full-operator-only and creates no-contact zero-spend payload", async () => {
  const setup = makeSql();
  const { routes, fullOperator, result } = await prepare(setup);
  const handlers = routes.get(
    "POST /api/prospecting/velvet-source/requests"
  )!;
  assert.equal(handlers[2], fullOperator);
  assert.equal(result.statusCode, 201);
  assert.equal(setup.state.row.request_payload.contactActionAllowed, false);
  assert.equal(setup.state.row.request_payload.maxSpendCents, 0);
  assert.equal(setup.state.row.state, "PREPARED");
  assert.deepEqual(setup.state.events, ["PREPARED"]);
});

test("transaction-level source pause reports 409 after an optimistic middleware pass", async () => {
  const blockedPrepare = makeSql({ pendingPositiveReviews: 1 });
  const prepareRoutes = captureRoutes({ sql: blockedPrepare.sql });
  const prepareResult = await invoke(
    prepareRoutes.routes.get(
      "POST /api/prospecting/velvet-source/requests"
    )!,
    {
      body: {
        criteria: {
          limit: 1,
          category: "plumbing",
          city: "Reno",
          state: "NV",
          learningMode: "none",
        },
      },
    }
  );
  assert.equal(prepareResult.statusCode, 409);
  assert.equal(
    prepareResult.body.code,
    "PROSPECT_ACQUISITION_PAUSED_FOR_INTERACTION_REVIEW"
  );
  assert.equal(
    prepareResult.body.pendingPositiveOutcomeReviews,
    1
  );
  assert.equal(prepareResult.body.externalAction, "none");
  assert.equal(blockedPrepare.state.row, null);

  const blockedApproval = makeSql();
  await prepare(blockedApproval);
  blockedApproval.state.pendingPositiveReviews = 1;
  const approvalResult = await approve(blockedApproval);
  assert.equal(approvalResult.statusCode, 409);
  assert.equal(
    approvalResult.body.code,
    "PROSPECT_ACQUISITION_PAUSED_FOR_INTERACTION_REVIEW"
  );
  assert.equal(
    approvalResult.body.pendingPositiveOutcomeReviews,
    1
  );
  assert.equal(approvalResult.body.externalAction, "none");
  assert.equal(blockedApproval.state.row.state, "PREPARED");
});

test("approval requires the exact confirmation and attestations", async () => {
  const setup = makeSql();
  await prepare(setup);
  const result = await approve(setup, "approve");
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.code, "VELVET_LEAD_SOURCE_APPROVAL_INVALID");
  assert.equal(setup.state.row.state, "PREPARED");
});

test("dispatch cannot run before separate approval", async () => {
  const setup = makeSql();
  await prepare(setup);
  const captured = captureRoutes({ sql: setup.sql });
  const result = await invoke(
    captured.routes.get(
      "POST /api/prospecting/velvet-source/requests/:id/dispatch"
    )!,
    {
      params: { id: "44" },
      body: {
        payloadHash: setup.state.row.request_payload_hash,
        confirmation: VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION,
      },
    }
  );
  assert.equal(result.statusCode, 409);
  assert.equal(
    result.body.code,
    "VELVET_LEAD_SOURCE_DISPATCH_STATE_CONFLICT"
  );
  assert.equal(setup.state.row.state, "PREPARED");
});

test("a full operator can cancel one prepared request without dispatch", async () => {
  const setup = makeSql();
  const { routes, fullOperator } = await prepare(setup);
  const handlers = routes.get(
    "POST /api/prospecting/velvet-source/requests/:id/cancel"
  )!;
  assert.equal(handlers[2], fullOperator);
  const result = await invoke(handlers, {
    params: { id: "44" },
    body: {
      payloadHash: setup.state.row.request_payload_hash,
      confirmation: VELVET_LEAD_SOURCE_CANCEL_CONFIRMATION,
      reason: "Synthetic operator cancellation.",
    },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.state, "CANCELLED");
  assert.equal(result.body.externalAction, "none");
  assert.equal(setup.state.row.state, "CANCELLED");
  assert.deepEqual(setup.state.events, ["PREPARED", "CANCELLED"]);
});

test("an expired approval commits EXPIRED instead of rolling it back", async () => {
  const setup = makeSql();
  await prepare(setup);
  setup.state.row.expires_at = "2026-07-30T18:59:00.000Z";
  const result = await approve(setup);
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.state, "EXPIRED");
  assert.equal(setup.state.row.state, "EXPIRED");
  assert.deepEqual(setup.state.events, ["PREPARED", "EXPIRED"]);
});

test("one approved request imports one reviewed prospect without contact", async () => {
  const setup = makeSql();
  await prepare(setup);
  const approval = await approve(setup);
  assert.equal(approval.statusCode, 200);
  let networkCalls = 0;
  let importCalls = 0;
  const captured = captureRoutes({
    sql: setup.sql,
    fetchImpl: (async (_url, init) => {
      networkCalls += 1;
      const sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(responseForRequest(sent)), {
        status: 201,
      });
    }) as typeof fetch,
    store: {
      async receive() {
        importCalls += 1;
        return {
          outcome: "created",
          campaignId: 17,
          prospectId: 23,
        };
      },
    },
  });
  const result = await invoke(
    captured.routes.get(
      "POST /api/prospecting/velvet-source/requests/:id/dispatch"
    )!,
    {
      params: { id: "44" },
      body: {
        payloadHash: setup.state.row.request_payload_hash,
        confirmation: VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION,
      },
    }
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.state, "COMPLETED");
  assert.equal(result.body.importedCount, 1);
  assert.equal(result.body.contactActionAllowed, false);
  assert.equal(result.body.spendAuthorized, false);
  assert.equal(networkCalls, 1);
  assert.equal(importCalls, 1);
  assert.deepEqual(setup.state.events, [
    "PREPARED",
    "APPROVED",
    "SENDING",
    "COMPLETED",
  ]);
});

test("a pending positive interaction blocks first reviewed-source dispatch", async () => {
  const setup = makeSql();
  await prepare(setup);
  await approve(setup);
  setup.state.pendingPositiveReviews = 1;
  let networkCalls = 0;
  const captured = captureRoutes({
    sql: setup.sql,
    fetchImpl: (async () => {
      networkCalls += 1;
      throw new Error("must not run");
    }) as typeof fetch,
  });
  const result = await invoke(
    captured.routes.get(
      "POST /api/prospecting/velvet-source/requests/:id/dispatch"
    )!,
    {
      params: { id: "44" },
      body: {
        payloadHash: setup.state.row.request_payload_hash,
        confirmation: VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION,
      },
    }
  );

  assert.equal(result.statusCode, 409);
  assert.equal(
    result.body.code,
    "PROSPECT_ACQUISITION_PAUSED_FOR_INTERACTION_REVIEW"
  );
  assert.equal(result.body.pendingPositiveOutcomeReviews, 1);
  assert.equal(result.body.externalAction, "none");
  assert.equal(setup.state.row.state, "APPROVED");
  assert.equal(networkCalls, 0);
});

test("a pending positive interaction preserves SENDING source reconciliation", async () => {
  const setup = makeSql();
  await prepare(setup);
  await approve(setup);
  const first = captureRoutes({
    sql: setup.sql,
    fetchImpl: (async () => {
      throw new Error("synthetic timeout");
    }) as typeof fetch,
  });
  const firstResult = await invoke(
    first.routes.get(
      "POST /api/prospecting/velvet-source/requests/:id/dispatch"
    )!,
    {
      params: { id: "44" },
      body: {
        payloadHash: setup.state.row.request_payload_hash,
        confirmation: VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION,
      },
    }
  );
  assert.equal(firstResult.statusCode, 503);
  assert.equal(setup.state.row.state, "SENDING");
  const pauseQueriesBefore = setup.state.queries.filter(query =>
    query.includes(
      "FROM prospect_positive_outcome_reviews"
    )
  ).length;

  setup.state.pendingPositiveReviews = 1;
  let networkCalls = 0;
  const retry = captureRoutes({
    sql: setup.sql,
    fetchImpl: (async (_url, init) => {
      networkCalls += 1;
      const sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(responseForRequest(sent)), {
        status: 201,
      });
    }) as typeof fetch,
  });
  const retryResult = await invoke(
    retry.routes.get(
      "POST /api/prospecting/velvet-source/requests/:id/dispatch"
    )!,
    {
      params: { id: "44" },
      body: {
        payloadHash: setup.state.row.request_payload_hash,
        confirmation: VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION,
      },
    }
  );

  assert.equal(retryResult.statusCode, 200);
  assert.equal(retryResult.body.state, "COMPLETED");
  assert.equal(networkCalls, 1);
  assert.equal(
    setup.state.queries.filter(query =>
      query.includes(
        "FROM prospect_positive_outcome_reviews"
      )
    ).length,
    pauseQueriesBefore,
    "SENDING reconciliation must not be blocked by a new pause check"
  );
});

test("uncertain transport remains SENDING for exact idempotent replay", async () => {
  const setup = makeSql();
  await prepare(setup);
  await approve(setup);
  const captured = captureRoutes({
    sql: setup.sql,
    fetchImpl: (async () => {
      throw new Error("synthetic timeout");
    }) as typeof fetch,
  });
  const result = await invoke(
    captured.routes.get(
      "POST /api/prospecting/velvet-source/requests/:id/dispatch"
    )!,
    {
      params: { id: "44" },
      body: {
        payloadHash: setup.state.row.request_payload_hash,
        confirmation: VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION,
      },
    }
  );
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.state, "SENDING");
  assert.equal(result.body.retryable, true);
  assert.equal(setup.state.row.state, "SENDING");
  assert.equal(setup.state.items.size, 0);
});

test("an active dispatch lease blocks a simultaneous export", async () => {
  const setup = makeSql();
  await prepare(setup);
  await approve(setup);
  setup.state.row.state = "SENDING";
  setup.state.row.last_error = null;
  setup.state.row.dispatch_requested_at = now.toISOString();
  let networkCalls = 0;
  const captured = captureRoutes({
    sql: setup.sql,
    fetchImpl: (async () => {
      networkCalls += 1;
      throw new Error("must not run");
    }) as typeof fetch,
  });
  const result = await invoke(
    captured.routes.get(
      "POST /api/prospecting/velvet-source/requests/:id/dispatch"
    )!,
    {
      params: { id: "44" },
      body: {
        payloadHash: setup.state.row.request_payload_hash,
        confirmation: VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION,
      },
    }
  );
  assert.equal(result.statusCode, 409);
  assert.equal(
    result.body.code,
    "VELVET_LEAD_SOURCE_DISPATCH_IN_PROGRESS"
  );
  assert.equal(networkCalls, 0);
});

test("a partial import retries from the stored response without another export", async () => {
  const setup = makeSql();
  await prepare(setup);
  await approve(setup);
  let networkCalls = 0;
  const first = captureRoutes({
    sql: setup.sql,
    fetchImpl: (async (_url, init) => {
      networkCalls += 1;
      const sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(responseForRequest(sent)), {
        status: 201,
      });
    }) as typeof fetch,
    store: {
      async receive() {
        throw Object.assign(new Error("synthetic import failure"), {
          code: "SYNTHETIC_IMPORT_FAILURE",
        });
      },
    },
  });
  const firstResult = await invoke(
    first.routes.get(
      "POST /api/prospecting/velvet-source/requests/:id/dispatch"
    )!,
    {
      params: { id: "44" },
      body: {
        payloadHash: setup.state.row.request_payload_hash,
        confirmation: VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION,
      },
    }
  );
  assert.equal(firstResult.statusCode, 502);
  assert.equal(firstResult.body.state, "PARTIAL");
  assert.equal(setup.state.row.state, "PARTIAL");

  let importCalls = 0;
  const retry = captureRoutes({
    sql: setup.sql,
    fetchImpl: (async () => {
      networkCalls += 1;
      throw new Error("must not export again");
    }) as typeof fetch,
    store: {
      async receive() {
        importCalls += 1;
        return {
          outcome: "created",
          campaignId: 17,
          prospectId: 23,
        };
      },
    },
  });
  const retryResult = await invoke(
    retry.routes.get(
      "POST /api/prospecting/velvet-source/requests/:id/dispatch"
    )!,
    {
      params: { id: "44" },
      body: {
        payloadHash: setup.state.row.request_payload_hash,
        confirmation: VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION,
      },
    }
  );
  assert.equal(retryResult.statusCode, 200);
  assert.equal(retryResult.body.state, "COMPLETED");
  assert.equal(networkCalls, 1);
  assert.equal(importCalls, 1);
});

test("a pending positive interaction pauses PARTIAL source continuation", async () => {
  const setup = makeSql();
  await prepare(setup);
  await approve(setup);
  setup.state.row.state = "PARTIAL";
  const response = responseForRequest(setup.state.row.request_payload);
  setup.state.row.remote_response = response;
  setup.state.row.remote_response_hash =
    hashVelvetLeadSourceValue(response);
  setup.state.pendingPositiveReviews = 1;
  let imports = 0;
  const captured = captureRoutes({
    sql: setup.sql,
    store: {
      async receive() {
        imports += 1;
        throw new Error("must not run");
      },
    },
  });
  const result = await invoke(
    captured.routes.get(
      "POST /api/prospecting/velvet-source/requests/:id/dispatch"
    )!,
    {
      params: { id: "44" },
      body: {
        payloadHash: setup.state.row.request_payload_hash,
        confirmation: VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION,
      },
    }
  );

  assert.equal(result.statusCode, 409);
  assert.equal(
    result.body.code,
    "PROSPECT_ACQUISITION_PAUSED_FOR_INTERACTION_REVIEW"
  );
  assert.equal(setup.state.row.state, "PARTIAL");
  assert.equal(imports, 0);
});

test("a changed stored Velvet response is rejected before import", async () => {
  const setup = makeSql();
  await prepare(setup);
  await approve(setup);
  setup.state.row.state = "PARTIAL";
  const response = responseForRequest(setup.state.row.request_payload);
  setup.state.row.remote_response = {
    ...response,
    prospects: [],
  };
  setup.state.row.remote_response_hash =
    hashVelvetLeadSourceValue(response);
  let imports = 0;
  const captured = captureRoutes({
    sql: setup.sql,
    store: {
      async receive() {
        imports += 1;
        throw new Error("must not run");
      },
    },
  });
  const result = await invoke(
    captured.routes.get(
      "POST /api/prospecting/velvet-source/requests/:id/dispatch"
    )!,
    {
      params: { id: "44" },
      body: {
        payloadHash: setup.state.row.request_payload_hash,
        confirmation: VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION,
      },
    }
  );
  assert.equal(result.statusCode, 409);
  assert.equal(
    result.body.code,
    "VELVET_LEAD_SOURCE_STORED_RESPONSE_INVALID"
  );
  assert.equal(imports, 0);
});

test("a completed request replays without another network or import", async () => {
  const setup = makeSql();
  await prepare(setup);
  await approve(setup);
  setup.state.row.state = "COMPLETED";
  setup.state.row.imported_count = 1;
  let networkCalls = 0;
  let importCalls = 0;
  const captured = captureRoutes({
    sql: setup.sql,
    fetchImpl: (async () => {
      networkCalls += 1;
      throw new Error("must not run");
    }) as typeof fetch,
    store: {
      async receive() {
        importCalls += 1;
        throw new Error("must not run");
      },
    },
  });
  const result = await invoke(
    captured.routes.get(
      "POST /api/prospecting/velvet-source/requests/:id/dispatch"
    )!,
    {
      params: { id: "44" },
      body: {
        payloadHash: setup.state.row.request_payload_hash,
        confirmation: VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION,
      },
    }
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.replay, true);
  assert.equal(networkCalls, 0);
  assert.equal(importCalls, 0);
});
