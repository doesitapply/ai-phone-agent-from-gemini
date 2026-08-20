import assert from "node:assert/strict";
import test from "node:test";
import type { Request, RequestHandler, Response } from "express";
import { registerProspectOutreachRoutes } from "../src/routes/prospect-outreach-routes.ts";
import {
  VELVET_OUTCOME_DISPATCH_CONFIRMATION,
  buildVelvetOutcomePayload,
  hashVelvetOutcomePayload,
} from "../src/velvet-outcome.ts";

const now = new Date("2026-07-30T19:00:00.000Z");

function dispatchEnv(
  overrides: Record<string, string | undefined> = {}
) {
  return {
    VELVET_BASE_URL: "https://velvetalchemy.manus.space",
    VELVET_OUTCOME_API_KEY: "velvet-outcome-api-key-000000000001",
    VELVET_OUTCOME_SIGNING_SECRET:
      "smirk-outcome-test-secret-000000000001",
    VELVET_OUTCOME_WORKSPACE_ID: "7",
    VELVET_OUTCOME_DISPATCH_ENABLED: "true",
    ...overrides,
  };
}

function payload() {
  return buildVelvetOutcomePayload({
    workspaceId: 7,
    externalProspectId: "velvet-owner-7-lead-42",
    externalEventId: "resend:synthetic-event-00000001",
    outreachApprovalId: "11111111-1111-4111-8111-111111111111",
    channel: "email",
    outcome: "delivered",
    occurredAt: "2026-07-30T18:55:00.000Z",
    evidenceHash: "a".repeat(64),
    outreachPayloadHash: "b".repeat(64),
  });
}

function outboxRow(overrides: Record<string, unknown> = {}) {
  const body = payload();
  return {
    id: 44,
    state: "PREPARED",
    payload: body,
    payload_hash: hashVelvetOutcomePayload(body),
    attempts: 0,
    last_error: null,
    dispatch_idempotency_key: null,
    dispatch_requested_at: null,
    dispatch_response_at: null,
    remote_event_id: null,
    dispatched_at: null,
    ...overrides,
  } as Record<string, any>;
}

function makeSql(
  row = outboxRow(),
  options: {
    claimVisible?: boolean;
    pause?: { pendingCount: number };
  } = {}
) {
  const state = {
    row,
    auditEvents: [] as string[],
    queries: [] as Array<{ text: string; values: unknown[] }>,
  };
  const sql: any = (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    state.queries.push({ text, values });
    if (text.includes("pg_advisory_xact_lock")) {
      return [{ pg_advisory_xact_lock: null }];
    }
    if (
      text.includes("FROM velvet_outcome_outbox o") &&
      text.includes("LIMIT 1 FOR UPDATE")
    ) {
      return options.claimVisible === false ? [] : [state.row];
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
    if (
      text.includes("UPDATE velvet_outcome_outbox") &&
      text.includes("SET state = 'SENDING'")
    ) {
      state.row.state = "SENDING";
      state.row.dispatch_idempotency_key = values.find(
        (value) =>
          typeof value === "string" &&
          value.startsWith("smirk-velvet-outcome/")
      );
      state.row.dispatch_requested_at = now.toISOString();
      state.row.dispatch_response_at = null;
      state.row.attempts = 1;
      return [{ id: 44 }];
    }
    if (
      text.includes("SELECT id, state, payload_hash") &&
      text.includes("dispatch_idempotency_key")
    ) {
      return [state.row];
    }
    if (
      text.includes("UPDATE velvet_outcome_outbox") &&
      text.includes("SET state = 'DISPATCHED'")
    ) {
      state.row.state = "DISPATCHED";
      state.row.remote_event_id = values.find(
        (value) => value === 17
      );
      return [{ id: 44 }];
    }
    if (
      text.includes("UPDATE velvet_outcome_outbox") &&
      text.includes("SET dispatch_response_at") &&
      !text.includes("SET state = 'FAILED'")
    ) {
      state.row.dispatch_response_at = now.toISOString();
      return [{ id: 44 }];
    }
    if (
      text.includes("UPDATE velvet_outcome_outbox") &&
      text.includes("SET state = 'FAILED'")
    ) {
      state.row.state = "FAILED";
      return [{ id: 44 }];
    }
    if (text.includes("INSERT INTO velvet_outcome_dispatch_events")) {
      const toState = String(values[4]);
      state.auditEvents.push(toState);
      return [{ id: state.auditEvents.length + 200 }];
    }
    throw new Error(`Unexpected SQL in Velvet dispatch test: ${text}`);
  };
  sql.begin = async (callback: (tx: any) => unknown) => callback(sql);
  sql.json = (value: unknown) => value;
  return { sql, state };
}

function captureRoute(options: {
  sql: any;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}) {
  const routes = new Map<
    string,
    Array<(req: Request, res: Response, next: () => void) => unknown>
  >();
  const app: any = {};
  for (const method of ["get", "post", "patch"]) {
    app[method] = (
      path: string,
      ...handlers: Array<
        (req: Request, res: Response, next: () => void) => unknown
      >
    ) => routes.set(`${method.toUpperCase()} ${path}`, handlers);
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
    env: options.env || dispatchEnv(),
    fetchImpl:
      options.fetchImpl ||
      (async () => {
        throw new Error("Unexpected Velvet request.");
      }),
    now: () => new Date(now),
  });
  const handlers = routes.get(
    "POST /api/prospecting/velvet-outcomes/:id/dispatch"
  );
  assert.ok(handlers);
  assert.equal(handlers[1], fullOperator);
  return handlers.at(-1)!;
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
  const { response, state } = makeResponse();
  await captureRoute(options)(
    {
      params: { id: "44" },
      body: {
        payloadHash: options.payloadHash,
        confirmation:
          options.confirmation ??
          VELVET_OUTCOME_DISPATCH_CONFIRMATION,
      },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );
  return state;
}

test("dispatch requires an exact second confirmation", async () => {
  const setup = makeSql();
  const result = await invoke({
    sql: setup.sql,
    payloadHash: setup.state.row.payload_hash,
    confirmation: "dispatch",
  });
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.code, "VELVET_OUTCOME_DISPATCH_INVALID");
  assert.equal(setup.state.queries.length, 0);
});

test("disabled and workspace-mismatched dispatch stop before transport", async () => {
  for (const [overrides, expectedCode] of [
    [
      { VELVET_OUTCOME_DISPATCH_ENABLED: "false" },
      "VELVET_OUTCOME_DISPATCH_DISABLED",
    ],
    [
      { VELVET_OUTCOME_WORKSPACE_ID: "99" },
      "VELVET_OUTCOME_WORKSPACE_MISMATCH",
    ],
  ] as const) {
    const setup = makeSql();
    let requests = 0;
    const result = await invoke({
      sql: setup.sql,
      payloadHash: setup.state.row.payload_hash,
      env: dispatchEnv(overrides),
      fetchImpl: (async () => {
        requests += 1;
        throw new Error("must not run");
      }) as typeof fetch,
    });
    assert.equal(result.body.code, expectedCode);
    assert.equal(setup.state.queries.length, 0);
    assert.equal(requests, 0);
  }
});

test("forged payload hashes never reach Velvet", async () => {
  const setup = makeSql();
  let requests = 0;
  const result = await invoke({
    sql: setup.sql,
    payloadHash: "c".repeat(64),
    fetchImpl: (async () => {
      requests += 1;
      throw new Error("must not run");
    }) as typeof fetch,
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "VELVET_OUTCOME_PAYLOAD_MISMATCH");
  assert.equal(requests, 0);
});

test("seed-qualified outbox rows cannot be claimed for Velvet dispatch", async () => {
  const setup = makeSql(outboxRow(), { claimVisible: false });
  let requests = 0;
  const result = await invoke({
    sql: setup.sql,
    payloadHash: setup.state.row.payload_hash,
    fetchImpl: (async () => {
      requests += 1;
      throw new Error("must not run");
    }) as typeof fetch,
  });
  assert.equal(result.statusCode, 404);
  assert.equal(result.body.code, "VELVET_OUTCOME_NOT_FOUND");
  assert.equal(requests, 0);
  const claimQuery =
    setup.state.queries.find((query) =>
      query.text.includes("JOIN prospect_outcome_events e")
    )?.text || "";
  assert.match(claimQuery, /JOIN prospect_outcome_events e/);
  assert.match(claimQuery, /JOIN prospect_outreach_jobs j/);
  assert.match(claimQuery, /j\.is_seed = FALSE/);
});

test("one queued outcome becomes one verified remote receipt", async () => {
  const setup = makeSql();
  let requests = 0;
  const result = await invoke({
    sql: setup.sql,
    payloadHash: setup.state.row.payload_hash,
    fetchImpl: (async () => {
      requests += 1;
      return new Response(
        JSON.stringify({
          success: true,
          state: "RECORDED",
          eventId: 17,
          externalAction: "none",
        }),
        { status: 201 }
      );
    }) as typeof fetch,
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.state, "DISPATCHED");
  assert.equal(result.body.remoteState, "RECORDED");
  assert.equal(result.body.remoteEventId, 17);
  assert.equal(result.body.externalAction, "velvet_outcome_recorded");
  assert.equal(requests, 1);
  assert.equal(setup.state.row.state, "DISPATCHED");
  assert.deepEqual(setup.state.auditEvents, [
    "SENDING",
    "DISPATCHED",
  ]);
});

test("a pending positive interaction blocks a first Velvet outcome dispatch", async () => {
  const pause = { pendingCount: 1 };
  const setup = makeSql(outboxRow(), { pause });
  let requests = 0;
  const result = await invoke({
    sql: setup.sql,
    payloadHash: setup.state.row.payload_hash,
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
  assert.equal(setup.state.row.state, "PREPARED");
  assert.equal(requests, 0);
});

test("a pending positive interaction preserves SENDING outcome reconciliation", async () => {
  const pause = { pendingCount: 0 };
  const setup = makeSql(outboxRow(), { pause });
  const first = await invoke({
    sql: setup.sql,
    payloadHash: setup.state.row.payload_hash,
    fetchImpl: (async () => {
      throw new Error("synthetic timeout");
    }) as typeof fetch,
  });
  assert.equal(first.statusCode, 503);
  assert.equal(setup.state.row.state, "SENDING");
  const pauseQueriesBefore = setup.state.queries.filter(query =>
    query.text.includes(
      "FROM prospect_positive_outcome_reviews"
    )
  ).length;

  pause.pendingCount = 1;
  const second = await invoke({
    sql: setup.sql,
    payloadHash: setup.state.row.payload_hash,
    fetchImpl: (async () => {
      throw new Error("must not run during retry cooldown");
    }) as typeof fetch,
  });

  assert.equal(second.statusCode, 409);
  assert.equal(
    second.body.code,
    "VELVET_OUTCOME_REQUEST_IN_FLIGHT"
  );
  assert.equal(setup.state.row.state, "SENDING");
  assert.equal(
    setup.state.queries.filter(query =>
      query.text.includes(
        "FROM prospect_positive_outcome_reviews"
      )
    ).length,
    pauseQueriesBefore,
    "SENDING reconciliation must not be blocked by a new pause check"
  );
});

test("uncertain transport stays SENDING for idempotent retry", async () => {
  const setup = makeSql();
  const result = await invoke({
    sql: setup.sql,
    payloadHash: setup.state.row.payload_hash,
    fetchImpl: (async () => {
      throw new Error("synthetic timeout");
    }) as typeof fetch,
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.state, "SENDING");
  assert.equal(result.body.retryable, true);
  assert.equal(result.body.externalAction, "velvet_outcome_unknown");
  assert.equal(setup.state.row.state, "SENDING");
});

test("definitive remote rejection becomes FAILED", async () => {
  const setup = makeSql();
  const result = await invoke({
    sql: setup.sql,
    payloadHash: setup.state.row.payload_hash,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          code: "SMIRK_OUTCOME_SIGNATURE_INVALID",
          error: "Signature invalid",
        }),
        { status: 401 }
      )) as typeof fetch,
  });
  assert.equal(result.statusCode, 502);
  assert.equal(result.body.state, "FAILED");
  assert.equal(result.body.retryable, false);
  assert.equal(setup.state.row.state, "FAILED");
});

test("a dispatched outbox row replays without another network request", async () => {
  const setup = makeSql(
    outboxRow({
      state: "DISPATCHED",
      remote_event_id: 17,
      dispatch_idempotency_key:
        "smirk-velvet-outcome/44/aaaaaaaaaaaaaaaaaaaaaaaa",
    })
  );
  let requests = 0;
  const result = await invoke({
    sql: setup.sql,
    payloadHash: setup.state.row.payload_hash,
    fetchImpl: (async () => {
      requests += 1;
      throw new Error("must not run");
    }) as typeof fetch,
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.outcome, "duplicate");
  assert.equal(result.body.externalAction, "none");
  assert.equal(requests, 0);
});
