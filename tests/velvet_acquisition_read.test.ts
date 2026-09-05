import assert from "node:assert/strict";
import test from "node:test";
import type { Express, Request, RequestHandler, Response } from "express";
import { registerOperationsRoutes } from "../src/routes/operations-routes.ts";

const acquisition = {
  acquisition_id: "acq_0123456789abcdef0123456789abcdef01234567",
  source_system: "velvet_alchemy",
  source_record_id: "velvet-manus-fake-lead-00000001",
  first_payload_hash: "a".repeat(64),
  record_kind: "synthetic",
  contact_permission: "not_permitted",
  contact_basis: "synthetic_fixture",
  route_decision: "hold",
  source_observed_at: null,
  first_received_at: "2026-08-21T12:00:00.000Z",
};

const acquisitionDetail = {
  ...acquisition,
  source_snapshot: {
    companyName: "Synthetic Fixture Plumbing",
    reason: "Synthetic fixture for the evidence inbox",
    urgency: "low",
    callerName: "Synthetic Fixture Caller",
    callerPhoneLast4: "0124",
  },
};

function makeResponse() {
  const state: { statusCode: number; body: unknown } = { statusCode: 200, body: undefined };
  const response = {
    setHeader() {
      return response;
    },
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

function makeRegisteredRoutes(acquisitionSchemaReady = true, receiverWorkspaceExists = true) {
  const routes = new Map<string, RequestHandler[]>();
  const app = {
    get(path: string, ...handlers: RequestHandler[]) {
      routes.set(`GET ${path}`, handlers);
    },
    post(path: string, ...handlers: RequestHandler[]) {
      routes.set(`POST ${path}`, handlers);
    },
  } as unknown as Express;
  const sql: any = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    if (query.includes("COUNT(*)::TEXT AS count FROM handoffs")) return [{ count: "0" }];
    if (query.includes("FROM handoffs h")) return [];
    if (query.includes("FROM handoffs")) return [];
    if (query.includes("COUNT(*) FILTER (WHERE record_kind = 'real')")) {
      return [{ real_count: "0", synthetic_count: "1", quarantined_count: "0" }];
    }
    if (query.includes("SELECT EXISTS") && query.includes("FROM workspaces")) {
      return [{ workspace_exists: receiverWorkspaceExists && Number(values[0]) === 42 }];
    }
    if (query.includes("FROM acquisition_records") && query.includes("LIMIT 20")) return [acquisition];
    if (query.includes("FROM acquisition_records") && query.includes("LIMIT 1")) {
      return values[0] === acquisition.acquisition_id && values[1] === 42 ? [acquisitionDetail] : [];
    }
    if (query.includes("FROM acquisition_events")) return [];
    if (query.includes("FROM acquisition_reviews")) return [];
    if (query.includes("FROM calls c")) return [];
    if (query.includes("FROM launch_outreach_approvals")) return [];
    if (query.includes("FROM stripe_checkout_fulfillments")) return [];
    if (query.includes("FROM provisioning_requests")) return [];
    if (query.includes("FROM activation_events")) return [];
    throw new Error(`Unhandled operations fixture query: ${query}`);
  };
  const middleware: RequestHandler = (_req, _res, next) => next();
  registerOperationsRoutes(app, {
    dashboardAuth: middleware,
    requireOperator: middleware,
    sql,
    dbEnabled: true,
    getWorkspaceId: (req) => Number((req as any).workspaceId),
    velvet: {
      receiverConfigured: true,
      isAcquisitionSchemaReady: () => acquisitionSchemaReady,
      workspaceId: "42",
      portalUrl: "https://velvet.example.test",
    },
  });
  return routes;
}

test("Velvet portal separates synthetic acquisition evidence from the handoff queue", async () => {
  const routes = makeRegisteredRoutes();
  const handler = routes.get("GET /api/velvet/portal")?.at(-1);
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler({ workspaceId: 42 } as unknown as Request, response, () => undefined);

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, {
    receiverConfigured: true,
    receiverReady: true,
    workspaceId: "42",
    receiverWorkspaceId: "42",
    portalUrl: "https://velvet.example.test",
    sourceAttributionAvailable: false,
    acquisitionInboxAvailable: true,
    acquisitionSchemaReady: true,
    pendingCount: 0,
    acquisitionCounts: { real: 0, synthetic: 1, quarantined: 0 },
    recentAcquisitions: [acquisition],
    recentHandoffs: [],
  });
});

test("acquisition detail reads fail closed across workspace boundaries", async () => {
  const routes = makeRegisteredRoutes();
  const handler = routes.get("GET /api/acquisitions/:id")?.at(-1);
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler({
    workspaceId: 43,
    params: { id: acquisition.acquisition_id },
  } as unknown as Request, response, () => undefined);

  assert.equal(state.statusCode, 404);
  assert.deepEqual(state.body, { error: "Acquisition not found.", code: "ACQUISITION_NOT_FOUND" });
});

test("acquisition detail exposes one evidence lifecycle without inferring downstream work", async () => {
  const routes = makeRegisteredRoutes();
  const handler = routes.get("GET /api/acquisitions/:id")?.at(-1);
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler({
    workspaceId: 42,
    params: { id: acquisition.acquisition_id },
  } as unknown as Request, response, () => undefined);

  assert.equal(state.statusCode, 200);
  const body = state.body as any;
  assert.equal(body.acquisition.acquisitionId, acquisition.acquisition_id);
  assert.equal(body.acquisition.sourceEvidence.companyName, "Synthetic Fixture Plumbing");
  assert.equal(body.currentReview, null);
  assert.equal(body.stages.source.state, "received");
  assert.equal(body.stages.handoff.state, "none_recorded");
  assert.equal(body.stages.approval.state, "none_recorded");
  assert.equal(body.stages.touch.state, "none_recorded");
  assert.equal(body.stages.checkout.state, "none_recorded");
  assert.equal(body.stages.provisioning.state, "none_recorded");
  assert.equal(body.stages.activation.state, "none_recorded");
  assert.equal(body.stages.feedback.state, "not_implemented");
  assert.deepEqual(body.capabilities, {
    mode: "evidence_only",
    canRecordReview: false,
    canPrepareOutreach: false,
    canPlaceCall: false,
    canStartCheckout: false,
    canWriteProvider: false,
  });
  assert.equal(body.attribution.complete, false);
  assert.ok(body.attribution.missingLinks.includes("handoff"));
  assert.ok(body.attribution.missingLinks.includes("feedback"));
});

test("invalid acquisition filters fail closed instead of widening the read", async () => {
  const routes = makeRegisteredRoutes();
  const handler = routes.get("GET /api/acquisitions")?.at(-1);
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler({
    workspaceId: 42,
    query: { kind: "synthetc" },
  } as unknown as Request, response, () => undefined);

  assert.equal(state.statusCode, 400);
  assert.deepEqual(state.body, {
    error: "Invalid acquisition kind filter.",
    code: "INVALID_ACQUISITION_KIND",
  });
});

test("pre-migration handoff reads remain available while the new column is absent", async () => {
  const routes = makeRegisteredRoutes(false);
  const handler = routes.get("GET /api/handoffs")?.at(-1);
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler({ workspaceId: 42 } as unknown as Request, response, () => undefined);

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, { handoffs: [] });
});

test("portal receiver state is scoped to the workspace actually queried", async () => {
  const routes = makeRegisteredRoutes();
  const handler = routes.get("GET /api/velvet/portal")?.at(-1);
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler({ workspaceId: 43 } as unknown as Request, response, () => undefined);

  assert.equal((state.body as any).workspaceId, "43");
  assert.equal((state.body as any).receiverWorkspaceId, "42");
  assert.equal((state.body as any).receiverConfigured, false);
  assert.equal((state.body as any).receiverReady, false);
  assert.equal((state.body as any).acquisitionInboxAvailable, false);
});

test("portal does not report an available inbox for a missing configured workspace", async () => {
  const routes = makeRegisteredRoutes(true, false);
  const handler = routes.get("GET /api/velvet/portal")?.at(-1);
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler({ workspaceId: 42 } as unknown as Request, response, () => undefined);

  assert.equal((state.body as any).receiverConfigured, true);
  assert.equal((state.body as any).receiverReady, false);
  assert.equal((state.body as any).acquisitionInboxAvailable, false);
});
