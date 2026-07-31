import assert from "node:assert/strict";
import test from "node:test";
import type {
  Request,
  RequestHandler,
  Response,
} from "express";
import { registerProspectOutreachRoutes } from "../src/routes/prospect-outreach-routes.ts";
import {
  PROSPECT_POSITIVE_OUTCOME_ACKNOWLEDGMENT_CONFIRMATION,
  buildProspectPositiveOutcomeReviewPayload,
  hashProspectPositiveOutcomeAcknowledgmentReceipt,
  hashProspectPositiveOutcomeAcknowledgmentRequest,
  hashProspectPositiveOutcomeReviewPayload,
} from "../src/prospect-positive-outcome-review.ts";

const reviewId = "11111111-1111-4111-8111-111111111111";
const payload = buildProspectPositiveOutcomeReviewPayload({
  reviewId,
  workspaceId: 7,
  campaignId: 2,
  prospectId: 3,
  businessName: "Synthetic Plumbing",
  outreachJobId: 4,
  outreachApprovalId: "22222222-2222-4222-8222-222222222222",
  channel: "email",
  outcomeEventId: 5,
  outcome: "replied",
  eventSource: "resend_webhook",
  externalEventId: "synthetic-reply-1",
  occurredAt: "2026-07-30T18:00:00.000Z",
  recordedBy: "synthetic_operator",
  notes: "Interested in a demo.",
});
const payloadHash =
  hashProspectPositiveOutcomeReviewPayload(payload);

function acknowledgment(
  resolution:
    | "continue_guarded_loop"
    | "handled_outside_smirk"
    | "escalated_to_owner"
    | "not_actionable" = "continue_guarded_loop"
) {
  return {
    payloadHash,
    confirmation:
      PROSPECT_POSITIVE_OUTCOME_ACKNOWLEDGMENT_CONFIRMATION,
    resolution,
    notes: "Reviewed synthetic interaction.",
    attestations: {
      interactionReviewed: true,
      noContactExecutedByAcknowledgment: true,
      followUpRemainsSeparate: true,
    },
  } as const;
}

function makeReviewSql() {
  const state = {
    row: {
      id: 31,
      review_id: reviewId,
      state: "PENDING" as "PENDING" | "ACKNOWLEDGED",
      payload,
      payload_hash: payloadHash,
      acknowledgment_request_hash: null as string | null,
      acknowledgment_receipt: null as unknown,
      acknowledgment_receipt_hash: null as string | null,
      acknowledged_by: null as string | null,
      acknowledged_at: null as string | null,
      created_at: "2026-07-30T18:00:01.000Z",
      updated_at: "2026-07-30T18:00:01.000Z",
    },
    updates: 0,
    auditEvents: 0,
    queries: [] as Array<{ text: string; values: unknown[] }>,
  };
  const sql: any = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    state.queries.push({ text, values });
    if (
      text.includes("FROM prospect_positive_outcome_reviews") &&
      text.includes("ORDER BY")
    ) {
      return values.includes(7) ? [state.row] : [];
    }
    if (
      text.includes("FROM prospect_positive_outcome_reviews") &&
      text.includes("FOR UPDATE")
    ) {
      return values.includes(7) && values.includes(reviewId)
        ? [state.row]
        : [];
    }
    if (
      text.includes("UPDATE prospect_positive_outcome_reviews")
    ) {
      const request = values.find(
        (value: any) =>
          value?.confirmation ===
          PROSPECT_POSITIVE_OUTCOME_ACKNOWLEDGMENT_CONFIRMATION
      ) as ReturnType<typeof acknowledgment> | undefined;
      const receipt = values.find(
        (value: any) =>
          value?.contractVersion ===
          "smirk.prospect-positive-outcome-acknowledgment.v1"
      ) as any;
      assert.ok(request);
      assert.ok(receipt);
      state.row.state = "ACKNOWLEDGED";
      state.row.acknowledgment_request_hash =
        hashProspectPositiveOutcomeAcknowledgmentRequest(request);
      state.row.acknowledgment_receipt = receipt;
      state.row.acknowledgment_receipt_hash =
        hashProspectPositiveOutcomeAcknowledgmentReceipt(receipt);
      state.row.acknowledged_by = receipt.acknowledgedBy;
      state.row.acknowledged_at = receipt.acknowledgedAt;
      state.updates += 1;
      return [{ id: state.row.id }];
    }
    if (
      text.includes(
        "INSERT INTO prospect_positive_outcome_review_events"
      )
    ) {
      state.auditEvents += 1;
      return [{ id: 41 }];
    }
    throw new Error(`Unexpected review SQL: ${text}`);
  };
  sql.begin = async (callback: (tx: any) => unknown) =>
    callback(sql);
  sql.json = (value: unknown) => value;
  return { sql, state };
}

function captureRoutes(sql: any, workspaceId = 7) {
  const routes = new Map<string, Function>();
  const app: any = {};
  for (const method of ["get", "post", "patch"]) {
    app[method] = (path: string, ...handlers: Function[]) => {
      routes.set(`${method.toUpperCase()} ${path}`, handlers.at(-1)!);
    };
  }
  const pass: RequestHandler = (_req, _res, next) => next();
  registerProspectOutreachRoutes(app, {
    dashboardAuth: pass,
    requireOperator: pass,
    requireFullOperator: pass,
    sql,
    dbEnabled: true,
    getWorkspaceId: () => workspaceId,
    now: () => new Date("2026-07-30T18:05:00.000Z"),
  });
  return routes;
}

function makeResponse() {
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

test("pending positive reviews are workspace-scoped and hash-verified", async () => {
  const setup = makeReviewSql();
  const handler = captureRoutes(setup.sql).get(
    "GET /api/prospecting/positive-outcomes"
  ) as Function;
  assert.ok(handler);
  const { response, state } = makeResponse();
  await handler(
    { query: { state: "pending" } } as unknown as Request,
    response
  );
  assert.equal(state.status, 200);
  assert.equal(state.body.reviews.length, 1);
  assert.equal(state.body.reviews[0].reviewId, reviewId);
  assert.equal(state.body.controls.contactAuthorized, false);
  assert.equal(state.body.controls.providerRequestAuthorized, false);
  assert.equal(state.body.externalAction, "none");
});

test("positive review storage failure never returns a false empty queue", async () => {
  const sql: any = async () => {
    throw new Error("synthetic review storage failure");
  };
  sql.begin = async (callback: (tx: any) => unknown) =>
    callback(sql);
  sql.json = (value: unknown) => value;
  const handler = captureRoutes(sql).get(
    "GET /api/prospecting/positive-outcomes"
  ) as Function;
  const { response, state } = makeResponse();
  await handler(
    { query: { state: "pending" } } as unknown as Request,
    response
  );
  assert.equal(state.status, 503);
  assert.equal(
    state.body.code,
    "PROSPECT_OUTREACH_STORAGE_UNAVAILABLE"
  );
  assert.equal(Object.hasOwn(state.body, "reviews"), false);
});

test("one full-operator acknowledgment is durable and replay-idempotent", async () => {
  const setup = makeReviewSql();
  const handler = captureRoutes(setup.sql).get(
    "POST /api/prospecting/positive-outcomes/:reviewId/acknowledge"
  ) as Function;
  assert.ok(handler);

  const first = makeResponse();
  await handler(
    {
      params: { reviewId },
      body: acknowledgment(),
      headers: { "x-api-key": "synthetic-full-operator-key" },
      authMode: "operator",
    } as unknown as Request,
    first.response
  );
  assert.equal(first.state.status, 201);
  assert.equal(first.state.body.outcome, "acknowledged");
  assert.equal(first.state.body.reviewState, "ACKNOWLEDGED");
  assert.equal(first.state.body.controls.contactAuthorized, false);
  assert.equal(first.state.body.externalAction, "none");
  assert.equal(setup.state.updates, 1);
  assert.equal(setup.state.auditEvents, 1);
  assert.match(
    first.state.body.receipt.acknowledgedBy,
    /^dashboard_operator:[a-f0-9]{16}$/
  );

  const replay = makeResponse();
  await handler(
    {
      params: { reviewId },
      body: acknowledgment(),
      headers: { "x-api-key": "synthetic-full-operator-key" },
      authMode: "operator",
    } as unknown as Request,
    replay.response
  );
  assert.equal(replay.state.status, 200);
  assert.equal(replay.state.body.outcome, "duplicate");
  assert.equal(setup.state.updates, 1);
  assert.equal(setup.state.auditEvents, 1);
});

test("forged hashes and conflicting replays fail without another write", async () => {
  const setup = makeReviewSql();
  const handler = captureRoutes(setup.sql).get(
    "POST /api/prospecting/positive-outcomes/:reviewId/acknowledge"
  ) as Function;
  const forged = makeResponse();
  await handler(
    {
      params: { reviewId },
      body: {
        ...acknowledgment(),
        payloadHash: "f".repeat(64),
      },
      headers: { "x-api-key": "synthetic-full-operator-key" },
      authMode: "operator",
    } as unknown as Request,
    forged.response
  );
  assert.equal(forged.state.status, 409);
  assert.equal(
    forged.state.body.code,
    "PROSPECT_POSITIVE_OUTCOME_REVIEW_HASH_MISMATCH"
  );
  assert.equal(setup.state.updates, 0);

  const first = makeResponse();
  await handler(
    {
      params: { reviewId },
      body: acknowledgment(),
      headers: { "x-api-key": "synthetic-full-operator-key" },
      authMode: "operator",
    } as unknown as Request,
    first.response
  );
  const conflict = makeResponse();
  await handler(
    {
      params: { reviewId },
      body: acknowledgment("not_actionable"),
      headers: { "x-api-key": "synthetic-full-operator-key" },
      authMode: "operator",
    } as unknown as Request,
    conflict.response
  );
  assert.equal(conflict.state.status, 409);
  assert.equal(
    conflict.state.body.code,
    "PROSPECT_POSITIVE_OUTCOME_ACKNOWLEDGMENT_CONFLICT"
  );
  assert.equal(setup.state.updates, 1);
  assert.equal(setup.state.auditEvents, 1);
});

test("opaque IDs and workspace boundaries fail closed", async () => {
  const setup = makeReviewSql();
  const routes = captureRoutes(setup.sql, 8);
  const handler = routes.get(
    "POST /api/prospecting/positive-outcomes/:reviewId/acknowledge"
  ) as Function;
  const missing = makeResponse();
  await handler(
    {
      params: { reviewId },
      body: acknowledgment(),
      headers: { "x-api-key": "synthetic-full-operator-key" },
      authMode: "operator",
    } as unknown as Request,
    missing.response
  );
  assert.equal(missing.state.status, 404);
  assert.equal(setup.state.updates, 0);

  const malformed = makeResponse();
  await handler(
    {
      params: { reviewId: "public-lead-3" },
      body: acknowledgment(),
      headers: { "x-api-key": "synthetic-full-operator-key" },
      authMode: "operator",
    } as unknown as Request,
    malformed.response
  );
  assert.equal(malformed.state.status, 400);
  assert.equal(setup.state.updates, 0);
});
