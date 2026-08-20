import assert from "node:assert/strict";
import test from "node:test";
import type { Request, RequestHandler, Response } from "express";
import {
  PROSPECT_REVENUE_LOOP_PREPARER_CONFIRMATION,
  PROSPECT_REVENUE_LOOP_PREPARER_PATH,
  prospectRevenueLoopPreparerReceiptSchema,
} from "../src/prospect-revenue-loop-preparer.ts";
import { registerVelvetDiscoveryRoutes } from "../src/routes/velvet-discovery-routes.ts";

const now = new Date("2026-08-02T03:00:00.000Z");
const env = {
  VELVET_DISCOVERY_ENABLED: "true",
  VELVET_LEAD_SOURCE_BASE_URL:
    "https://velvetalchemy.manus.space",
  VELVET_LEAD_SOURCE_API_KEY:
    "velvet-source-api-key-0000000000000001",
  VELVET_LEAD_SOURCE_WORKSPACE_ID: "7",
  VELVET_OUTCOME_API_KEY:
    "different-outcome-api-key-000000000001",
  PROSPECT_REVENUE_LOOP_PREPARER_ENABLED: "true",
  PROSPECT_REVENUE_LOOP_PREPARER_API_KEY:
    "preparer-api-key-0000000000000000000001",
  PROSPECT_REVENUE_LOOP_PREPARER_WORKSPACE_ID: "7",
  PROSPECT_REVENUE_LOOP_DISCOVERY_LIMIT: "10",
  PROSPECT_REVENUE_LOOP_DISCOVERY_CATEGORY: "plumbing",
  PROSPECT_REVENUE_LOOP_DISCOVERY_CITY: "Reno",
  PROSPECT_REVENUE_LOOP_DISCOVERY_STATE: "NV",
};

function makeRow(input: {
  id: number;
  requestId: string;
  workspaceId: number;
  state?: string;
  criteria: unknown;
  payload: unknown;
  payloadHash: string;
  expiresAt: string;
}) {
  return {
    id: input.id,
    request_id: input.requestId,
    workspace_id: input.workspaceId,
    state: input.state || "PREPARED",
    criteria: input.criteria,
    request_payload: input.payload,
    request_payload_hash: input.payloadHash,
    prepared_by: "revenue_loop_preparer",
    approved_by: null,
    approved_at: null,
    approval_attestations: null,
    expires_at: input.expiresAt,
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
}

function makeSql(options: {
  pendingPositiveReviews?: number;
  fail?: boolean;
} = {}) {
  const state = {
    rows: [] as any[],
    events: [] as any[],
    queries: [] as string[],
    insertAttempts: 0,
    pendingPositiveReviews: options.pendingPositiveReviews || 0,
  };
  const sql: any = (
    strings: TemplateStringsArray,
    ...values: any[]
  ) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    state.queries.push(text);
    if (options.fail) throw new Error("synthetic database failure");
    if (text.includes("SELECT pg_advisory_xact_lock")) return [];
    if (text.includes("FROM prospect_positive_outcome_reviews")) {
      return [{ pending_count: state.pendingPositiveReviews }];
    }
    if (
      text.includes("FROM velvet_discovery_requests") &&
      text.includes("state IN")
    ) {
      return state.rows.filter((row) =>
        ["PREPARED", "APPROVED", "SENDING", "SUBMITTED"].includes(
          row.state
        )
      ).slice(0, 1);
    }
    if (text.includes("INSERT INTO velvet_discovery_requests")) {
      state.insertAttempts += 1;
      if (state.rows.some((row) => row.request_id === values[0])) return [];
      const row = makeRow({
        id: 51,
        requestId: values[0],
        workspaceId: values[1],
        state: values[2],
        criteria: values[3],
        payload: values[4],
        payloadHash: values[5],
        expiresAt: values[7],
      });
      state.rows.push(row);
      return [{ id: row.id }];
    }
    if (text.includes("INSERT INTO velvet_discovery_request_events")) {
      state.events.push({
        requestRowId: values[1],
        toState: values[3],
        payloadHash: values[5],
        details: values[6],
      });
      return [];
    }
    if (
      text.includes("FROM velvet_discovery_requests") &&
      text.includes("request_id =")
    ) {
      return state.rows.filter(
        (row) =>
          row.request_id === values[0] &&
          row.workspace_id === values[1]
      ).slice(0, 1);
    }
    throw new Error(`Unexpected SQL in preparer route test: ${text}`);
  };
  sql.json = (value: unknown) => value;
  let previous = Promise.resolve();
  sql.begin = async (callback: (tx: any) => Promise<unknown>) => {
    let release = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waitFor = previous;
    previous = current;
    await waitFor;
    try {
      return await callback(sql);
    } finally {
      release();
    }
  };
  return { sql, state };
}

function captureRoute(options: {
  sql: any;
  workspaceId?: number;
  fetchImpl?: typeof fetch;
}) {
  const routes = new Map<string, any[]>();
  const app: any = {};
  for (const method of ["get", "post"]) {
    app[method] = (path: string, ...handlers: any[]) =>
      routes.set(`${method.toUpperCase()} ${path}`, handlers);
  }
  const pass: RequestHandler = (_req, _res, next) => next();
  registerVelvetDiscoveryRoutes(app, {
    dashboardAuth: pass,
    requireOperator: pass,
    requireFullOperator: pass,
    sql: options.sql,
    dbEnabled: true,
    getWorkspaceId: () => options.workspaceId || 7,
    env,
    fetchImpl: options.fetchImpl,
    now: () => new Date(now),
  });
  const handlers = routes.get(`POST ${PROSPECT_REVENUE_LOOP_PREPARER_PATH}`);
  assert.ok(handlers);
  return handlers;
}

function responseCapture() {
  const state = { status: 200, body: undefined as any };
  const response = {
    status(status: number) {
      state.status = status;
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
  body: unknown = {
    confirmation: PROSPECT_REVENUE_LOOP_PREPARER_CONFIRMATION,
  }
) {
  const { response, state } = responseCapture();
  await handlers.at(-1)(
    {
      body,
      authMode: "prospect_revenue_loop_preparer",
    } as unknown as Request,
    response
  );
  return state;
}

test("preparer writes one review-only discovery receipt without provider contact", async () => {
  const setup = makeSql();
  let fetchCalls = 0;
  const handlers = captureRoute({
    sql: setup.sql,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("network should not be reached");
    },
  });
  const result = await invoke(handlers);
  assert.equal(result.status, 201);
  const receipt = prospectRevenueLoopPreparerReceiptSchema.parse(result.body);
  assert.equal(receipt.outcome, "PREPARED");
  assert.equal(receipt.controls.humanApprovalRequired, true);
  assert.equal(receipt.controls.contactAuthorized, false);
  assert.equal(receipt.controls.spendAuthorized, false);
  assert.equal(receipt.controls.providerRequestAuthorized, false);
  assert.equal(receipt.externalAction, "none");
  assert.equal(setup.state.rows.length, 1);
  assert.equal(setup.state.events.length, 1);
  assert.equal(fetchCalls, 0);
});

test("concurrent and repeated preparation converges on one row and one event", async () => {
  const setup = makeSql();
  const handlers = captureRoute({ sql: setup.sql });
  const [first, second] = await Promise.all([
    invoke(handlers),
    invoke(handlers),
  ]);
  assert.deepEqual(
    [first.status, second.status].sort(),
    [200, 201]
  );
  const replay = await invoke(handlers);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.outcome, "DUPLICATE");
  assert.equal(setup.state.rows.length, 1);
  assert.equal(setup.state.events.length, 1);
  assert.equal(setup.state.insertAttempts, 1);
  assert.ok(
    setup.state.queries.some((query) =>
      query.includes("SELECT pg_advisory_xact_lock")
    )
  );
  assert.ok(
    setup.state.queries.some((query) =>
      query.includes("ON CONFLICT (request_id) DO NOTHING")
    )
  );
});

test("malformed, paused, cross-workspace, active, and failed database states fail closed", async () => {
  const malformedSetup = makeSql();
  const malformed = await invoke(
    captureRoute({ sql: malformedSetup.sql }),
    { confirmation: "wrong" }
  );
  assert.equal(malformed.status, 400);
  assert.equal(malformedSetup.state.rows.length, 0);

  const pausedSetup = makeSql({ pendingPositiveReviews: 1 });
  const paused = await invoke(captureRoute({ sql: pausedSetup.sql }));
  assert.equal(paused.status, 409);
  assert.equal(
    paused.body.code,
    "PROSPECT_ACQUISITION_PAUSED_FOR_INTERACTION_REVIEW"
  );
  assert.equal(pausedSetup.state.rows.length, 0);

  const crossWorkspaceSetup = makeSql();
  const crossWorkspace = await invoke(
    captureRoute({ sql: crossWorkspaceSetup.sql, workspaceId: 8 })
  );
  assert.equal(crossWorkspace.status, 403);
  assert.equal(crossWorkspaceSetup.state.rows.length, 0);

  const activeSetup = makeSql();
  activeSetup.state.rows.push(
    makeRow({
      id: 99,
      requestId: "smirk-manual-discovery-request-0001",
      workspaceId: 7,
      criteria: {},
      payload: {},
      payloadHash: "a".repeat(64),
      expiresAt: "2026-08-03T03:00:00.000Z",
    })
  );
  const active = await invoke(captureRoute({ sql: activeSetup.sql }));
  assert.equal(active.status, 409);
  assert.equal(
    active.body.code,
    "PROSPECT_REVENUE_LOOP_PREPARER_ACTIVE_REQUEST"
  );
  assert.equal(activeSetup.state.rows.length, 1);

  const failedSetup = makeSql({ fail: true });
  const failed = await invoke(captureRoute({ sql: failedSetup.sql }));
  assert.equal(failed.status, 500);
  assert.equal(failed.body.externalAction, "none");
  assert.equal(failed.body.ok, undefined);
});
