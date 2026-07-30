import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { registerProspectOutreachRoutes } from "../src/routes/prospect-outreach-routes.ts";
import { PROSPECT_MANUAL_CALL_RECORD_CONFIRMATION } from "../src/prospect-outreach.ts";

const approvalId = "11111111-1111-4111-8111-111111111111";
const payloadHash = "a".repeat(64);

type CapturedHandler = (
  req: Request,
  res: Response,
  next: () => void
) => unknown;

function captureRoutes(sql: any) {
  const routes = new Map<string, CapturedHandler>();
  const app: any = {};
  for (const method of ["get", "post", "patch"]) {
    app[method] = (path: string, ...handlers: CapturedHandler[]) => {
      routes.set(`${method.toUpperCase()} ${path}`, handlers.at(-1)!);
    };
  }
  const pass = (_req: Request, _res: Response, next: () => void) => next();
  registerProspectOutreachRoutes(app, {
    dashboardAuth: pass as any,
    requireOperator: pass as any,
    requireFullOperator: pass as any,
    sql,
    dbEnabled: true,
    getWorkspaceId: () => 7,
  });
  return routes;
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

function makeApprovalSql(job: Record<string, unknown> | null) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const sql: any = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    if (text.includes("SELECT id, state, channel, payload_hash, expires_at")) {
      return job ? [job] : [];
    }
    if (
      text.includes("UPDATE prospect_outreach_jobs") &&
      text.includes("state = 'APPROVED'")
    ) {
      return [{ id: 9 }];
    }
    if (text.includes("INSERT INTO prospect_outreach_events")) {
      return [{ id: 10 }];
    }
    throw new Error(`Unexpected SQL in approval test: ${text}`);
  };
  sql.begin = async (callback: (tx: any) => unknown) => callback(sql);
  sql.json = (value: unknown) => value;
  return { sql, queries };
}

async function invokeApproval(options: {
  job: Record<string, unknown> | null;
  body?: unknown;
  routeId?: string;
}) {
  const { sql, queries } = makeApprovalSql(options.job);
  const routes = captureRoutes(sql);
  const handler = routes.get(
    "POST /api/prospecting/outreach/:approvalId/approve"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();
  await handler(
    {
      params: { approvalId: options.routeId ?? approvalId },
      body:
        options.body ??
        ({
          payloadHash,
          attestations: {
            recipientReviewed: true,
            suppressionChecked: true,
            emailComplianceReviewed: true,
          },
        } as const),
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );
  return { ...state, queries };
}

function makeExecutionSql(job: Record<string, unknown> | null) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const sql: any = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    if (
      text.includes(
        "SELECT j.id, j.state, j.channel, j.recipient, j.payload_hash"
      )
    ) {
      return job ? [job] : [];
    }
    if (
      text.includes("UPDATE prospect_outreach_jobs") &&
      text.includes("state = 'SENT'")
    ) {
      return [{ id: 9 }];
    }
    if (text.includes("INSERT INTO prospect_outreach_events")) {
      return [{ id: 10 }];
    }
    throw new Error(`Unexpected SQL in execution test: ${text}`);
  };
  sql.begin = async (callback: (tx: any) => unknown) => callback(sql);
  sql.json = (value: unknown) => value;
  return { sql, queries };
}

async function invokeExecution(options: {
  job: Record<string, unknown> | null;
  body: {
    payloadHash: string;
    occurredAt: string;
    confirmation: typeof PROSPECT_MANUAL_CALL_RECORD_CONFIRMATION;
    proofReference: string;
  };
}) {
  const { sql, queries } = makeExecutionSql(options.job);
  const routes = captureRoutes(sql);
  const handler = routes.get(
    "POST /api/prospecting/outreach/:approvalId/record-execution"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();
  await handler(
    {
      params: { approvalId },
      body: options.body,
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );
  return { ...state, queries };
}

function preparedEmailJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 9,
    state: "PREPARED",
    channel: "email",
    payload_hash: payloadHash,
    expires_at: "2099-07-30T12:00:00.000Z",
    ...overrides,
  };
}

test("approval rejects malformed opaque IDs before storage", async () => {
  const result = await invokeApproval({
    job: preparedEmailJob(),
    routeId: "public-target-id",
  });
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.code, "PROSPECT_OUTREACH_INVALID_APPROVAL");
  assert.equal(result.queries.length, 0);
});

test("approval reports a missing workspace-scoped row", async () => {
  const result = await invokeApproval({ job: null });
  assert.equal(result.statusCode, 404);
  assert.equal(result.body.code, "PROSPECT_OUTREACH_NOT_FOUND");
});

test("approval rejects a forged payload hash", async () => {
  const result = await invokeApproval({
    job: preparedEmailJob(),
    body: {
      payloadHash: "b".repeat(64),
      attestations: {
        recipientReviewed: true,
        suppressionChecked: true,
        emailComplianceReviewed: true,
      },
    },
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "PROSPECT_OUTREACH_PAYLOAD_MISMATCH");
  assert.equal(
    result.queries.some((query) =>
      query.text.includes("UPDATE prospect_outreach_jobs")
    ),
    false
  );
});

test("approval fails closed when channel attestations are incomplete", async () => {
  const result = await invokeApproval({
    job: preparedEmailJob(),
    body: {
      payloadHash,
      attestations: {
        recipientReviewed: true,
        suppressionChecked: true,
      },
    },
  });
  assert.equal(result.statusCode, 409);
  assert.equal(
    result.body.code,
    "PROSPECT_OUTREACH_COMPLIANCE_ATTESTATION_REQUIRED"
  );
  assert.equal(
    result.queries.some((query) =>
      query.text.includes("UPDATE prospect_outreach_jobs")
    ),
    false
  );
});

test("approval stores attestations and reports success only after one row changes", async () => {
  const result = await invokeApproval({ job: preparedEmailJob() });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.outcome, "approved");
  assert.equal(result.body.state, "APPROVED");
  assert.equal(result.body.externalAction, "none");
  const update = result.queries.find((query) =>
    query.text.includes("UPDATE prospect_outreach_jobs")
  );
  assert.ok(update);
  assert.equal(
    update.values.some(
      (value: any) =>
        value?.recipientReviewed === true &&
        value?.emailComplianceReviewed === true
    ),
    true
  );
  assert.equal(
    result.queries.some((query) =>
      query.text.includes("INSERT INTO prospect_outreach_events")
    ),
    true
  );
});

test("replayed approval is idempotent and does not append another event", async () => {
  const result = await invokeApproval({
    job: preparedEmailJob({ state: "APPROVED" }),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.outcome, "duplicate");
  assert.equal(result.body.state, "APPROVED");
  assert.equal(result.queries.length, 1);
});

test("records a manually completed action only inside the approved window", async () => {
  const now = Date.now();
  const occurredAt = new Date(now).toISOString();
  const proofReference = "manual:phone-log-reference";
  const result = await invokeExecution({
    job: {
      id: 9,
      state: "APPROVED",
      channel: "call",
      recipient: "+17755550142",
      payload_hash: payloadHash,
      approved_at: new Date(now - 60_000).toISOString(),
      approval_attestations: {
        recipientReviewed: true,
        suppressionChecked: true,
        doNotCallChecked: true,
        callingWindowChecked: true,
        manualDialOnly: true,
      },
      expires_at: new Date(now + 60 * 60_000).toISOString(),
      sent_at: null,
      execution_proof_reference: null,
      current_phone: "+17755550142",
      current_phone_contact_mode: "operator_review_only",
      current_lead_status: "pending",
      current_review_state: "qualified",
    },
    body: {
      payloadHash,
      occurredAt,
      confirmation: PROSPECT_MANUAL_CALL_RECORD_CONFIRMATION,
      proofReference,
    },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.outcome, "recorded");
  assert.equal(result.body.externalAction, "recorded_only");
  assert.equal(
    result.queries[0]?.text.includes(
      "approval_attestations"
    ),
    true
  );
  assert.equal(
    result.queries.some((query) =>
      query.text.includes("INSERT INTO prospect_outreach_events")
    ),
    true
  );
});

test("manual execution replay is idempotent only for exact stored facts", async () => {
  const occurredAt = new Date().toISOString();
  const proofReference = "manual:phone-log-reference";
  const exact = await invokeExecution({
    job: {
      id: 9,
      state: "SENT",
      channel: "call",
      recipient: "+17755550142",
      payload_hash: payloadHash,
      approved_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      sent_at: occurredAt,
      execution_proof_reference: proofReference,
    },
    body: {
      payloadHash,
      occurredAt,
      confirmation: PROSPECT_MANUAL_CALL_RECORD_CONFIRMATION,
      proofReference,
    },
  });
  assert.equal(exact.statusCode, 200);
  assert.equal(exact.body.outcome, "duplicate");
  assert.equal(exact.queries.length, 1);

  const changed = await invokeExecution({
    job: {
      id: 9,
      state: "SENT",
      channel: "call",
      recipient: "+17755550142",
      payload_hash: payloadHash,
      approved_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      sent_at: occurredAt,
      execution_proof_reference: proofReference,
    },
    body: {
      payloadHash,
      occurredAt,
      confirmation: PROSPECT_MANUAL_CALL_RECORD_CONFIRMATION,
      proofReference: "manual:different-proof-reference",
    },
  });
  assert.equal(changed.statusCode, 409);
  assert.equal(
    changed.body.code,
    "PROSPECT_OUTREACH_EXECUTION_IDEMPOTENCY_CONFLICT"
  );
});

test("email execution cannot be recorded through the manual-call route", async () => {
  const result = await invokeExecution({
    job: {
      id: 9,
      state: "APPROVED",
      channel: "email",
      recipient: "owner@example.com",
      payload_hash: payloadHash,
      approved_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      sent_at: null,
      execution_proof_reference: null,
    },
    body: {
      payloadHash,
      occurredAt: new Date().toISOString(),
      confirmation: PROSPECT_MANUAL_CALL_RECORD_CONFIRMATION,
      proofReference: "manual:gmail-sent-message-id",
    },
  });
  assert.equal(result.statusCode, 409);
  assert.equal(
    result.body.code,
    "PROSPECT_EMAIL_EXECUTION_ROUTE_REQUIRED"
  );
  assert.equal(
    result.queries.some((query) =>
      query.text.includes("UPDATE prospect_outreach_jobs")
    ),
    false
  );
});
