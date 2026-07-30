import assert from "node:assert/strict";
import test from "node:test";
import type {
  Request,
  RequestHandler,
  Response,
} from "express";
import {
  VELVET_DISCOVERY_APPROVAL_CONFIRMATION,
  VELVET_DISCOVERY_CANCEL_CONFIRMATION,
  VELVET_DISCOVERY_DISPATCH_CONFIRMATION,
  VELVET_DISCOVERY_IMPORT_CONFIRMATION,
  VELVET_DISCOVERY_REFRESH_CONFIRMATION,
  hashVelvetDiscoveryValue,
} from "../src/velvet-discovery.ts";
import { registerVelvetDiscoveryRoutes } from "../src/routes/velvet-discovery-routes.ts";

const now = new Date("2026-07-30T20:00:00.000Z");
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

function makeSql() {
  const state = {
    row: null as any,
    sourceRow: null as any,
    discoveryEvents: [] as string[],
    sourceEvents: [] as string[],
    queries: [] as string[],
  };
  const sql: any = (
    strings: TemplateStringsArray,
    ...values: any[]
  ) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    state.queries.push(text);

    if (text.includes("INSERT INTO velvet_discovery_requests")) {
      state.row = {
        id: 51,
        request_id: values[0],
        workspace_id: values[1],
        state: values[2],
        criteria: values[3],
        request_payload: values[4],
        request_payload_hash: values[5],
        prepared_by: values[6],
        approved_by: null,
        approved_at: null,
        approval_attestations: null,
        expires_at: values[7],
        attempts: 0,
        remote_discovery_id: null,
        remote_state: null,
        remote_prepared_response: null,
        remote_prepared_hash: null,
        remote_status_response: null,
        remote_status_hash: null,
        quote_payload: null,
        quote_payload_hash: null,
        effective_criteria: null,
        created_lead_count: 0,
        ready_lead_count: 0,
        skipped_lead_count: 0,
        failed_lead_count: 0,
        provider_requests: 0,
        approved_max_spend_cents: null,
        last_error: null,
        dispatch_requested_by: null,
        dispatch_requested_at: null,
        dispatch_response_at: null,
        status_checked_by: null,
        status_checked_at: null,
        completed_at: null,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      };
      return [{ id: 51 }];
    }
    if (text.includes("INSERT INTO velvet_discovery_request_events")) {
      state.discoveryEvents.push(values[4]);
      return [];
    }
    if (text.includes("INSERT INTO velvet_lead_source_request_events")) {
      state.sourceEvents.push(values[4]);
      return [];
    }
    if (text.includes("SELECT pg_advisory_xact_lock")) return [];
    if (
      text.includes("SELECT *") &&
      text.includes("FROM velvet_discovery_requests")
    ) {
      return state.row ? [{ ...state.row }] : [];
    }
    if (
      text.includes("SELECT id, request_id, state, request_payload_hash") &&
      text.includes("FROM velvet_lead_source_requests")
    ) {
      return state.sourceRow ? [{ ...state.sourceRow }] : [];
    }
    if (text.includes("INSERT INTO velvet_lead_source_requests")) {
      state.sourceRow = {
        id: 61,
        request_id: values[0],
        workspace_id: values[1],
        state: values[2],
        criteria: values[3],
        request_payload: values[4],
        request_payload_hash: values[5],
        prepared_by: values[6],
        expires_at: values[7],
        discovery_request_id: values[8],
      };
      return [{ id: 61 }];
    }
    if (
      text.includes("UPDATE velvet_discovery_requests") &&
      text.includes("remote_discovery_id")
    ) {
      state.row.state = values[0];
      state.row.remote_discovery_id = values[1];
      state.row.remote_state = values[2];
      state.row.remote_prepared_response = values[3];
      state.row.remote_prepared_hash = values[4];
      state.row.quote_payload = values[5];
      state.row.quote_payload_hash = values[6];
      state.row.effective_criteria = values[7];
      state.row.dispatch_response_at = values[8];
      state.row.last_error = null;
      return [{ id: 51 }];
    }
    if (
      text.includes("UPDATE velvet_discovery_requests") &&
      text.includes("remote_status_response")
    ) {
      state.row.remote_state = values[0];
      state.row.remote_status_response = values[1];
      state.row.remote_status_hash = values[2];
      state.row.created_lead_count = values[3];
      state.row.ready_lead_count = values[4];
      state.row.skipped_lead_count = values[5];
      state.row.failed_lead_count = values[6];
      state.row.provider_requests = values[7];
      state.row.approved_max_spend_cents = values[8];
      state.row.last_error = values[9];
      state.row.status_checked_by = values[10];
      state.row.status_checked_at = values[11];
      state.row.completed_at = values[12];
      return [{ id: 51 }];
    }
    if (
      text.includes("UPDATE velvet_discovery_requests") &&
      text.includes("status_checked_by") &&
      text.includes("last_error")
    ) {
      state.row.last_error = values[0];
      state.row.status_checked_by = values[1];
      state.row.status_checked_at = values[2];
      return [{ id: 51 }];
    }
    if (
      text.includes("UPDATE velvet_discovery_requests") &&
      text.includes("attempts = attempts + 1")
    ) {
      state.row.state = values[0];
      state.row.attempts += 1;
      state.row.dispatch_requested_by = values[1];
      state.row.dispatch_requested_at = values[2];
      state.row.dispatch_response_at = null;
      state.row.last_error = null;
      return [{ id: 51 }];
    }
    if (
      text.includes("UPDATE velvet_discovery_requests") &&
      text.includes("dispatch_response_at") &&
      text.includes("last_error")
    ) {
      state.row.state = values[0];
      state.row.last_error = values[1];
      state.row.dispatch_response_at = values[2];
      state.row.completed_at = values[3];
      return [{ id: 51 }];
    }
    if (
      text.includes("UPDATE velvet_discovery_requests") &&
      text.includes("approval_attestations")
    ) {
      state.row.state = values[0];
      state.row.approved_by = values[1];
      state.row.approved_at = values[2];
      state.row.approval_attestations = values[3];
      return [{ id: 51 }];
    }
    if (
      text.includes("UPDATE velvet_discovery_requests") &&
      text.includes("last_error") &&
      text.includes("completed_at")
    ) {
      state.row.state = values[0];
      state.row.last_error = values[1];
      state.row.completed_at = now.toISOString();
      return [{ id: 51 }];
    }
    if (
      text.includes("UPDATE velvet_discovery_requests") &&
      text.includes("completed_at")
    ) {
      state.row.state = values[0];
      state.row.completed_at = now.toISOString();
      return [{ id: 51 }];
    }
    throw new Error(`Unexpected SQL in discovery route test: ${text}`);
  };
  sql.begin = async (callback: (tx: any) => unknown) => callback(sql);
  sql.json = (value: unknown) => value;
  return { sql, state };
}

function captureRoutes(options: {
  sql: any;
  fetchImpl?: typeof fetch;
  workspaceId?: number;
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
  registerVelvetDiscoveryRoutes(app, {
    dashboardAuth: dashboard,
    requireOperator: operator,
    requireFullOperator: fullOperator,
    sql: options.sql,
    dbEnabled: true,
    getWorkspaceId: () => options.workspaceId || 7,
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
      "POST /api/prospecting/velvet-discovery/requests"
    )!,
    {
      body: {
        criteria: {
          limit: 2,
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

async function approve(setup: ReturnType<typeof makeSql>) {
  const captured = captureRoutes({ sql: setup.sql });
  return invoke(
    captured.routes.get(
      "POST /api/prospecting/velvet-discovery/requests/:id/approve"
    )!,
    {
      params: { id: "51" },
      body: {
        payloadHash: setup.state.row.request_payload_hash,
        confirmation: VELVET_DISCOVERY_APPROVAL_CONFIRMATION,
        attestations: {
          noContactAuthorized: true,
          requestOnlyNoProviderSpend: true,
        },
      },
    }
  );
}

function quote() {
  return {
    provider: "google_maps_proxy" as const,
    maximumRequests: 3,
    costCentsPerRequest: 2,
    maximumCostCents: 6,
    quotedAt: "2026-07-30T20:00:00.000Z",
  };
}

function preparedResponse(request: any) {
  return {
    ok: true,
    contractVersion: "velvet-smirk.discovery-response.v1",
    state: "PREPARED",
    originalState: "PREPARED",
    currentState: "PREPARED",
    requestId: request.requestId,
    requestPayloadHash: hashVelvetDiscoveryValue(request),
    quotePayloadHash: hashVelvetDiscoveryValue(quote()),
    discoveryId: 71,
    effectiveCriteria: {
      limit: 2,
      category: "plumbing",
      city: "Reno",
      state: "NV",
    },
    appliedLearningCandidate: null,
    quote: quote(),
    approvalRequired: true,
    executionStarted: false,
    contactActionAllowed: false,
    spendAuthorized: false,
    externalAction: "discovery_approval_required",
  };
}

function statusResponse(request: any, state = "COMPLETED") {
  return {
    ok: true,
    contractVersion: "velvet-smirk.discovery-status.v1",
    requestId: request.requestId,
    requestPayloadHash: hashVelvetDiscoveryValue(request),
    quotePayloadHash: hashVelvetDiscoveryValue(quote()),
    discoveryId: 71,
    state,
    effectiveCriteria: {
      limit: 2,
      category: "plumbing",
      city: "Reno",
      state: "NV",
    },
    appliedLearningCandidate: null,
    quote: quote(),
    createdLeadCount: state === "COMPLETED" ? 2 : 0,
    readyLeadCount: state === "COMPLETED" ? 2 : 0,
    skippedLeadCount: 0,
    failedLeadCount: 0,
    providerRequests: state === "COMPLETED" ? 3 : 0,
    approvedMaxSpendCents: state === "COMPLETED" ? 6 : null,
    error: null,
    contactActionAllowed: false,
    externalAction: "discovery_status_only",
  };
}

async function dispatch(
  setup: ReturnType<typeof makeSql>,
  fetchImpl: typeof fetch
) {
  const captured = captureRoutes({ sql: setup.sql, fetchImpl });
  return invoke(
    captured.routes.get(
      "POST /api/prospecting/velvet-discovery/requests/:id/dispatch"
    )!,
    {
      params: { id: "51" },
      body: {
        payloadHash: setup.state.row.request_payload_hash,
        confirmation: VELVET_DISCOVERY_DISPATCH_CONFIRMATION,
      },
    }
  );
}

test("prepare is full-operator-only and creates no-contact no-spend intent", async () => {
  const setup = makeSql();
  const { routes, fullOperator, result } = await prepare(setup);
  assert.equal(
    routes.get(
      "POST /api/prospecting/velvet-discovery/requests"
    )![2],
    fullOperator
  );
  assert.equal(result.statusCode, 201);
  assert.equal(setup.state.row.request_payload.contactActionAllowed, false);
  assert.equal(setup.state.row.request_payload.spendAuthorized, false);
  assert.equal(setup.state.row.state, "PREPARED");
  assert.deepEqual(setup.state.discoveryEvents, ["PREPARED"]);
});

test("malformed discovery is rejected before storage or network", async () => {
  const setup = makeSql();
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
      "POST /api/prospecting/velvet-discovery/requests"
    )!,
    {
      body: {
        criteria: {
          limit: 21,
          category: "plumbing",
          city: "Reno",
          state: "NV",
          learningMode: "none",
        },
      },
    }
  );
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.code, "VELVET_DISCOVERY_PREPARE_INVALID");
  assert.equal(setup.state.row, null);
  assert.equal(networkCalls, 0);
});

test("storage failure cannot claim a prepared discovery", async () => {
  const sql: any = () => {
    throw new Error("must not query outside transaction");
  };
  sql.begin = async () => {
    throw new Error("synthetic database failure");
  };
  sql.json = (value: unknown) => value;
  const captured = captureRoutes({ sql });
  const result = await invoke(
    captured.routes.get(
      "POST /api/prospecting/velvet-discovery/requests"
    )!,
    {
      body: {
        criteria: {
          limit: 2,
          category: "plumbing",
          city: "Reno",
          state: "NV",
          learningMode: "none",
        },
      },
    }
  );
  assert.equal(result.statusCode, 500);
  assert.equal(result.body.code, "VELVET_DISCOVERY_PREPARE_FAILED");
});

test("dispatch is blocked until the exact request is separately approved", async () => {
  const setup = makeSql();
  await prepare(setup);
  let networkCalls = 0;
  const result = await dispatch(
    setup,
    (async () => {
      networkCalls += 1;
      throw new Error("must not run");
    }) as typeof fetch
  );
  assert.equal(result.statusCode, 409);
  assert.equal(
    result.body.code,
    "VELVET_DISCOVERY_DISPATCH_STATE_CONFLICT"
  );
  assert.equal(networkCalls, 0);
});

test("a forged payload hash is rejected before network", async () => {
  const setup = makeSql();
  await prepare(setup);
  await approve(setup);
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
      "POST /api/prospecting/velvet-discovery/requests/:id/dispatch"
    )!,
    {
      params: { id: "51" },
      body: {
        payloadHash: "a".repeat(64),
        confirmation: VELVET_DISCOVERY_DISPATCH_CONFIRMATION,
      },
    }
  );
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "VELVET_DISCOVERY_PAYLOAD_MISMATCH");
  assert.equal(networkCalls, 0);
});

test("a missing durable request is reported without network", async () => {
  const setup = makeSql();
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
      "POST /api/prospecting/velvet-discovery/requests/:id/dispatch"
    )!,
    {
      params: { id: "51" },
      body: {
        payloadHash: "a".repeat(64),
        confirmation: VELVET_DISCOVERY_DISPATCH_CONFIRMATION,
      },
    }
  );
  assert.equal(result.statusCode, 404);
  assert.equal(
    result.body.code,
    "VELVET_DISCOVERY_REQUEST_NOT_FOUND"
  );
  assert.equal(networkCalls, 0);
});

test("dispatch is locked to the configured SMIRK workspace", async () => {
  const setup = makeSql();
  await prepare(setup);
  await approve(setup);
  let networkCalls = 0;
  const captured = captureRoutes({
    sql: setup.sql,
    workspaceId: 8,
    fetchImpl: (async () => {
      networkCalls += 1;
      throw new Error("must not run");
    }) as typeof fetch,
  });
  const result = await invoke(
    captured.routes.get(
      "POST /api/prospecting/velvet-discovery/requests/:id/dispatch"
    )!,
    {
      params: { id: "51" },
      body: {
        payloadHash: setup.state.row.request_payload_hash,
        confirmation: VELVET_DISCOVERY_DISPATCH_CONFIRMATION,
      },
    }
  );
  assert.equal(result.statusCode, 403);
  assert.equal(
    result.body.code,
    "VELVET_DISCOVERY_WORKSPACE_LOCKED"
  );
  assert.equal(networkCalls, 0);
});

test("one approved dispatch submits only a quote request to Velvet", async () => {
  const setup = makeSql();
  await prepare(setup);
  const approval = await approve(setup);
  assert.equal(approval.statusCode, 200);
  let networkCalls = 0;
  const result = await dispatch(
    setup,
    (async (_input, init) => {
      networkCalls += 1;
      const sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(preparedResponse(sent)), {
        status: 201,
      });
    }) as typeof fetch
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.state, "SUBMITTED");
  assert.equal(result.body.approvalRequiredInVelvet, true);
  assert.equal(result.body.spendAuthorized, false);
  assert.equal(networkCalls, 1);
  assert.equal(setup.state.row.remote_state, "PREPARED");
  assert.deepEqual(setup.state.discoveryEvents, [
    "PREPARED",
    "APPROVED",
    "SENDING",
    "SUBMITTED",
  ]);
});

test("an exact submitted replay returns the durable receipt without network", async () => {
  const setup = makeSql();
  await prepare(setup);
  await approve(setup);
  await dispatch(
    setup,
    (async (_input, init) => {
      const sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(preparedResponse(sent)), {
        status: 201,
      });
    }) as typeof fetch
  );
  let networkCalls = 0;
  const replay = await dispatch(
    setup,
    (async () => {
      networkCalls += 1;
      throw new Error("must not run");
    }) as typeof fetch
  );
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.state, "SUBMITTED");
  assert.equal(replay.body.replay, true);
  assert.equal(networkCalls, 0);
});

test("uncertain submission stays SENDING for explicit exact replay", async () => {
  const setup = makeSql();
  await prepare(setup);
  await approve(setup);
  const result = await dispatch(
    setup,
    (async () => {
      throw new Error("synthetic timeout");
    }) as typeof fetch
  );
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.state, "SENDING");
  assert.equal(result.body.retryable, true);
  assert.equal(setup.state.row.state, "SENDING");
  assert.equal(setup.state.row.attempts, 1);
});

test("refresh records completed status but does not import leads", async () => {
  const setup = makeSql();
  await prepare(setup);
  await approve(setup);
  await dispatch(
    setup,
    (async (_input, init) => {
      const sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(preparedResponse(sent)), {
        status: 201,
      });
    }) as typeof fetch
  );
  const captured = captureRoutes({
    sql: setup.sql,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify(
          statusResponse(setup.state.row.request_payload)
        ),
        { status: 200 }
      )) as typeof fetch,
  });
  const result = await invoke(
    captured.routes.get(
      "POST /api/prospecting/velvet-discovery/requests/:id/refresh"
    )!,
    {
      params: { id: "51" },
      body: {
        payloadHash: setup.state.row.request_payload_hash,
        confirmation: VELVET_DISCOVERY_REFRESH_CONFIRMATION,
      },
    }
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.remoteState, "COMPLETED");
  assert.equal(result.body.canPrepareImport, true);
  assert.equal(setup.state.row.ready_lead_count, 2);
  assert.equal(setup.state.sourceRow, null);
});

test("completed discovery prepares one linked zero-spend pull only", async () => {
  const setup = makeSql();
  await prepare(setup);
  await approve(setup);
  await dispatch(
    setup,
    (async (_input, init) => {
      const sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(preparedResponse(sent)), {
        status: 201,
      });
    }) as typeof fetch
  );
  setup.state.row.remote_state = "COMPLETED";
  setup.state.row.remote_status_response = statusResponse(
    setup.state.row.request_payload
  );
  setup.state.row.remote_status_hash = hashVelvetDiscoveryValue(
    setup.state.row.remote_status_response
  );
  setup.state.row.ready_lead_count = 2;
  const captured = captureRoutes({ sql: setup.sql });
  const result = await invoke(
    captured.routes.get(
      "POST /api/prospecting/velvet-discovery/requests/:id/prepare-import"
    )!,
    {
      params: { id: "51" },
      body: {
        payloadHash: setup.state.row.request_payload_hash,
        confirmation: VELVET_DISCOVERY_IMPORT_CONFIRMATION,
      },
    }
  );
  assert.equal(result.statusCode, 201);
  assert.equal(result.body.sourceState, "PREPARED");
  assert.equal(result.body.contactActionAllowed, false);
  assert.equal(result.body.spendAuthorized, false);
  assert.equal(setup.state.sourceRow.discovery_request_id, 51);
  assert.equal(
    setup.state.sourceRow.request_payload.maxSpendCents,
    0
  );
  assert.equal(
    setup.state.sourceRow.request_payload.sourceDiscoveryRequestId,
    setup.state.row.request_id
  );
  assert.equal(setup.state.sourceRow.state, "PREPARED");
  assert.deepEqual(setup.state.sourceEvents, ["PREPARED"]);

  const replay = await invoke(
    captured.routes.get(
      "POST /api/prospecting/velvet-discovery/requests/:id/prepare-import"
    )!,
    {
      params: { id: "51" },
      body: {
        payloadHash: setup.state.row.request_payload_hash,
        confirmation: VELVET_DISCOVERY_IMPORT_CONFIRMATION,
      },
    }
  );
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.replay, true);
});

test("a full operator can cancel locally before remote submission", async () => {
  const setup = makeSql();
  const { routes, fullOperator } = await prepare(setup);
  const handlers = routes.get(
    "POST /api/prospecting/velvet-discovery/requests/:id/cancel"
  )!;
  assert.equal(handlers[2], fullOperator);
  const result = await invoke(handlers, {
    params: { id: "51" },
    body: {
      payloadHash: setup.state.row.request_payload_hash,
      confirmation: VELVET_DISCOVERY_CANCEL_CONFIRMATION,
      reason: "Synthetic operator cancellation.",
    },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.state, "CANCELLED");
  assert.equal(setup.state.row.state, "CANCELLED");
});
