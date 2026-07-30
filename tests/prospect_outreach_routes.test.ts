import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { registerProspectOutreachRoutes } from "../src/routes/prospect-outreach-routes.ts";
import {
  PROSPECT_MANUAL_CALL_RECORD_CONFIRMATION,
  buildProspectOutreachPayload,
  hashProspectOutreachPayload,
} from "../src/prospect-outreach.ts";
import {
  PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION,
  buildProspectMessageContext,
  renderProspectMessageVariant,
} from "../src/prospect-message-variants.ts";
import {
  PROSPECT_MESSAGE_EXPERIMENT_ACTIVATION_CONFIRMATION,
  PROSPECT_MESSAGE_EXPERIMENT_CANCEL_CONFIRMATION,
  PROSPECT_MESSAGE_EXPERIMENT_CLOSE_CONFIRMATION,
  buildProspectMessageExperimentAssignment,
  buildProspectMessageExperimentDefinition,
  hashProspectMessageExperimentDefinition,
} from "../src/prospect-message-experiments.ts";
import {
  PROSPECT_INBOX_PLACEMENT_PREPARE_CONFIRMATION,
  buildProspectInboxPlacementDefinition,
  buildProspectInboxPlacementReceipt,
  hashProspectInboxPlacementValue,
  prepareProspectInboxPlacementSchema,
  type ProspectInboxPlacementEvaluationItem,
} from "../src/prospect-inbox-placement.ts";

const approvalId = "11111111-1111-4111-8111-111111111111";
const approvalPayload = buildProspectOutreachPayload({
  workspaceId: 7,
  campaignId: 2,
  prospectId: 3,
  recipient: "owner@example.invalid",
  evidenceHash: "e".repeat(64),
  preparedAt: "2026-07-30T16:00:00.000Z",
  qcContext: {
    businessName: "Synthetic Plumbing",
    industry: "plumbing",
    evidenceObservation: null,
  },
  draft: {
    channel: "email",
    subject: "Synthetic outreach review",
    body: "Synthetic review-only outreach draft for a human operator.",
    emailCompliance: {
      senderIdentity: "SMIRK",
      advertisementDisclosure:
        "This is a commercial message from SMIRK.",
      physicalPostalAddress: "1605 McKinley Drive, Reno, NV 89509",
      optOutInstructions:
        "If this is not relevant, reply no and I will not follow up.",
    },
    maxCostCents: 2,
    expiresInHours: 24,
  },
});
const payloadHash = hashProspectOutreachPayload(approvalPayload);

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

function makePreparationSql(options?: {
  activeExperiment?: Record<string, unknown>;
}) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const lead = {
    id: 3,
    campaign_id: 2,
    business_name: "Silver State Home Services Demo",
    industry: "plumbing",
    email: "owner@example.invalid",
    email_verification: "verified_owner_email",
    phone: "+12025550124",
    phone_contact_mode: "operator_review_only",
    status: "pending",
    review_state: "qualified",
    research_evidence: [
      {
        kind: "contact_path",
        basis: "observed",
        observation: "The public page offers emergency service contact.",
      },
    ],
    external_id: "synthetic-prospect-3",
    source: "manual",
  };
  const sql: any = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    if (text === "FOR UPDATE" || text === "") return [];
    if (
      text.includes("FROM prospect_leads l") &&
      text.includes("JOIN prospecting_campaigns c")
    ) {
      return [lead];
    }
    if (
      text.includes("FROM prospect_message_experiments") &&
      text.includes("state = 'ACTIVE'")
    ) {
      return options?.activeExperiment
        ? [options.activeExperiment]
        : [];
    }
    if (
      text.includes("SELECT approval_id, state, payload_hash, variant_key")
    ) {
      return [];
    }
    if (text.includes("INSERT INTO prospect_outreach_jobs")) {
      return [{ id: 71 }];
    }
    if (text.includes("INSERT INTO prospect_outreach_events")) {
      return [{ id: 72 }];
    }
    throw new Error(`Unexpected SQL in preparation test: ${text}`);
  };
  sql.begin = async (callback: (tx: any) => unknown) => callback(sql);
  sql.json = (value: unknown) => value;
  return { sql, queries, lead };
}

function compliantEmailDraft(input: {
  subject: string;
  body: string;
  variantKey: string;
}) {
  return {
    channel: "email" as const,
    subject: input.subject,
    body: input.body,
    emailCompliance: {
      senderIdentity: "SMIRK",
      advertisementDisclosure: "This is a commercial message from SMIRK.",
      physicalPostalAddress: "1605 McKinley Drive, Reno, NV 89509",
      optOutInstructions:
        "If this is not relevant, reply no and I will not follow up.",
    },
    variantKey: input.variantKey,
    maxCostCents: 2,
    expiresInHours: 24,
  };
}

test("actual registered copy determines stored variant attribution", async () => {
  const { sql, queries, lead } = makePreparationSql();
  const context = buildProspectMessageContext({
    businessName: lead.business_name,
    industry: lead.industry,
    researchEvidence: lead.research_evidence,
  });
  const rendered = renderProspectMessageVariant(
    "owner-language-v2",
    context
  );
  assert.ok(rendered?.subject);
  const routes = captureRoutes(sql);
  const handler = routes.get("POST /api/prospecting/leads/:id/outreach");
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { id: "3" },
      body: compliantEmailDraft({
        subject: rendered.subject,
        body: rendered.content,
        variantKey: "owner-language-v1",
      }),
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 201);
  assert.equal(state.body.variantKey, "owner-language-v2");
  assert.equal(state.body.externalAction, "none");
  const eventInsert = queries.find((query) =>
    query.text.includes("INSERT INTO prospect_outreach_events")
  );
  assert.ok(eventInsert);
  assert.equal(
    eventInsert.values.some(
      (value: any) =>
        value?.requestedVariantKey === "owner-language-v1" &&
        value?.attributedVariantKey === "owner-language-v2" &&
        value?.registeredVariantContentMatched === true
    ),
    true
  );
});

test("operator-edited copy receives a content-specific custom variant", async () => {
  const { sql, lead } = makePreparationSql();
  const context = buildProspectMessageContext({
    businessName: lead.business_name,
    industry: lead.industry,
    researchEvidence: lead.research_evidence,
  });
  const rendered = renderProspectMessageVariant(
    "owner-language-v2",
    context
  );
  assert.ok(rendered?.subject);
  const routes = captureRoutes(sql);
  const handler = routes.get("POST /api/prospecting/leads/:id/outreach");
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { id: "3" },
      body: compliantEmailDraft({
        subject: rendered.subject,
        body: `${rendered.content}\n\nOperator-reviewed custom sentence.`,
        variantKey: "owner-language-v2",
      }),
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 201);
  assert.match(
    state.body.variantKey,
    /^operator-custom-[a-f0-9]{16}$/
  );
  assert.equal(state.body.externalAction, "none");
});

test("deterministic QC blocks unresolved placeholders before ledger creation", async () => {
  const { sql, queries } = makePreparationSql();
  const handler = captureRoutes(sql).get(
    "POST /api/prospecting/leads/:id/outreach"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { id: "3" },
      body: compliantEmailDraft({
        subject: "quick question [Company]",
        body:
          "Hi {{first_name}} - Cameron with SMIRK. How are after-hours calls handled?",
        variantKey: "micro-after-hours-v1",
      }),
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 422);
  assert.equal(state.body.code, "PROSPECT_QC_REVISION_REQUIRED");
  assert.match(state.body.error, /PLACEHOLDERS_RESOLVED/);
  assert.equal(
    queries.some((query) =>
      query.text.includes("INSERT INTO prospect_outreach_jobs")
    ),
    false
  );
});

test("active experiment assignment is server-generated and stored with matching copy", async () => {
  const fixture = makeExperimentFixture({ state: "ACTIVE" });
  const assignment = buildProspectMessageExperimentAssignment({
    definition: fixture.definition,
    prospectId: 3,
    actualVariantKey: fixture.definition.controlVariantKey,
  });
  const { sql, lead } = makePreparationSql({
    activeExperiment: fixture.experiment,
  });
  const context = buildProspectMessageContext({
    businessName: lead.business_name,
    industry: lead.industry,
    researchEvidence: lead.research_evidence,
  });
  const rendered = renderProspectMessageVariant(
    assignment.assignedVariantKey,
    context
  );
  assert.ok(rendered?.subject);
  const handler = captureRoutes(sql).get(
    "POST /api/prospecting/leads/:id/outreach"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { id: "3" },
      body: compliantEmailDraft({
        subject: rendered.subject,
        body: rendered.content,
        variantKey: rendered.key,
      }),
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 201, JSON.stringify(state.body));
  assert.equal(state.body.experimentAssignment.experimentId, experimentId);
  assert.equal(
    state.body.experimentAssignment.assignedVariantKey,
    assignment.assignedVariantKey
  );
  assert.equal(state.body.experimentAssignment.protocolCompliant, true);
  assert.equal(state.body.externalAction, "none");
});

test("human copy override remains possible but is marked off protocol", async () => {
  const fixture = makeExperimentFixture({ state: "ACTIVE" });
  const assignment = buildProspectMessageExperimentAssignment({
    definition: fixture.definition,
    prospectId: 3,
    actualVariantKey: fixture.definition.controlVariantKey,
  });
  const overrideKey =
    assignment.assignedVariantKey === "owner-language-v1"
      ? "owner-language-v2"
      : "owner-language-v1";
  const { sql, lead } = makePreparationSql({
    activeExperiment: fixture.experiment,
  });
  const context = buildProspectMessageContext({
    businessName: lead.business_name,
    industry: lead.industry,
    researchEvidence: lead.research_evidence,
  });
  const rendered = renderProspectMessageVariant(overrideKey, context);
  assert.ok(rendered?.subject);
  const handler = captureRoutes(sql).get(
    "POST /api/prospecting/leads/:id/outreach"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { id: "3" },
      body: compliantEmailDraft({
        subject: rendered.subject,
        body: rendered.content,
        variantKey: rendered.key,
      }),
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 201, JSON.stringify(state.body));
  assert.equal(
    state.body.experimentAssignment.assignedVariantKey,
    assignment.assignedVariantKey
  );
  assert.equal(
    state.body.experimentAssignment.actualVariantKey,
    overrideKey
  );
  assert.equal(state.body.experimentAssignment.protocolCompliant, false);
  assert.equal(state.body.externalAction, "none");
});

function makeExperimentLifecycleSql(input?: {
  state?: "PREPARED" | "ACTIVE" | "CLOSED" | "CANCELLED";
  pendingJobs?: number;
  updateRows?: Array<{ id: number }>;
  throwOnRead?: boolean;
}) {
  const fixture = makeExperimentFixture({
    state: input?.state || "PREPARED",
  });
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const sql: any = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    if (
      input?.throwOnRead &&
      text.includes("FROM prospect_message_experiments")
    ) {
      throw new Error("synthetic experiment storage failure");
    }
    if (
      text.includes("FROM prospecting_campaigns") &&
      text.includes("FOR UPDATE")
    ) {
      return [{ id: 2 }];
    }
    if (
      text.includes("SELECT experiment_id") &&
      text.includes("state = 'ACTIVE'")
    ) {
      return [];
    }
    if (text.includes("FROM prospect_inbox_placement_tests")) {
      return [fixture.inboxPlacement];
    }
    if (
      text.includes("FROM prospect_message_experiments") &&
      text.includes("experiment_id")
    ) {
      return [fixture.experiment];
    }
    if (text.includes("INSERT INTO prospect_message_experiments")) {
      return [{ id: 81 }];
    }
    if (text.includes("INSERT INTO prospect_message_experiment_events")) {
      return [{ id: 82 }];
    }
    if (
      text.includes("SELECT COUNT(*)::int AS pending_count") &&
      text.includes("prospect_outreach_jobs")
    ) {
      return [{ pending_count: input?.pendingJobs || 0 }];
    }
    if (text.includes("UPDATE prospect_message_experiments")) {
      return input?.updateRows ?? [{ id: 81 }];
    }
    throw new Error(`Unexpected SQL in experiment route test: ${text}`);
  };
  sql.begin = async (callback: (tx: any) => unknown) => callback(sql);
  sql.json = (value: unknown) => value;
  return { ...fixture, sql, queries };
}

test("prepares a registered experiment without authorizing contact or spend", async () => {
  const { sql, queries } = makeExperimentLifecycleSql();
  const routes = captureRoutes(sql);
  const handler = routes.get("POST /api/prospecting/learning/experiments");
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      body: {
        campaignId: 2,
        channel: "email",
        controlVariantKey: "owner-language-v1",
        challengerVariantKey: "owner-language-v2",
      },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 201, JSON.stringify(state.body));
  assert.equal(state.body.state, "PREPARED");
  assert.equal(state.body.externalAction, "none");
  assert.equal(state.body.policyChanged, false);
  const event = queries.find((query) =>
    query.text.includes("INSERT INTO prospect_message_experiment_events")
  );
  assert.ok(event);
  assert.equal(
    event.values.some(
      (value: any) =>
        value?.contactAuthorized === false &&
        value?.spendAuthorized === false
    ),
    true
  );
});

test("experiment activation rejects a forged definition hash before mutation", async () => {
  const { sql, queries } = makeExperimentLifecycleSql();
  const routes = captureRoutes(sql);
  const handler = routes.get(
    "POST /api/prospecting/learning/experiments/:experimentId/activate"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { experimentId },
      body: {
        definitionHash: "f".repeat(64),
        confirmation: PROSPECT_MESSAGE_EXPERIMENT_ACTIVATION_CONFIRMATION,
        attestations: {
          registeredContentReviewed: true,
          deterministicAssignmentReviewed: true,
          noContactOrSpendAuthorized: true,
        },
      },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 409);
  assert.equal(
    state.body.code,
    "PROSPECT_MESSAGE_EXPERIMENT_HASH_MISMATCH"
  );
  assert.equal(
    queries.some((query) =>
      query.text.includes("UPDATE prospect_message_experiments")
    ),
    false
  );
});

test("experiment activation is single-row and replay-idempotent", async () => {
  const first = makeExperimentLifecycleSql({ state: "PREPARED" });
  const handler = captureRoutes(first.sql).get(
    "POST /api/prospecting/learning/experiments/:experimentId/activate"
  );
  assert.ok(handler);
  const firstResponse = makeResponse();
  const request = {
    params: { experimentId },
    body: {
      definitionHash: first.definitionHash,
      confirmation: PROSPECT_MESSAGE_EXPERIMENT_ACTIVATION_CONFIRMATION,
      attestations: {
        registeredContentReviewed: true,
        deterministicAssignmentReviewed: true,
        noContactOrSpendAuthorized: true,
      },
    },
    authMode: "operator",
  } as unknown as Request;

  await handler(request, firstResponse.response, () => undefined);
  assert.equal(firstResponse.state.statusCode, 200);
  assert.equal(firstResponse.state.body.outcome, "activated");
  assert.equal(firstResponse.state.body.externalAction, "none");
  assert.equal(
    first.queries.filter((query) =>
      query.text.includes("UPDATE prospect_message_experiments")
    ).length,
    1
  );

  const replay = makeExperimentLifecycleSql({ state: "ACTIVE" });
  const replayHandler = captureRoutes(replay.sql).get(
    "POST /api/prospecting/learning/experiments/:experimentId/activate"
  );
  assert.ok(replayHandler);
  const replayResponse = makeResponse();
  await replayHandler(request, replayResponse.response, () => undefined);
  assert.equal(replayResponse.state.statusCode, 200);
  assert.equal(replayResponse.state.body.outcome, "duplicate");
  assert.equal(
    replay.queries.some((query) =>
      query.text.includes("UPDATE prospect_message_experiments")
    ),
    false
  );
});

test("experiment closure refuses nonterminal enrolled jobs", async () => {
  const fixture = makeExperimentLifecycleSql({
    state: "ACTIVE",
    pendingJobs: 1,
  });
  const handler = captureRoutes(fixture.sql).get(
    "POST /api/prospecting/learning/experiments/:experimentId/close"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { experimentId },
      body: {
        definitionHash: fixture.definitionHash,
        confirmation: PROSPECT_MESSAGE_EXPERIMENT_CLOSE_CONFIRMATION,
        attestations: {
          enrollmentStopped: true,
          allJobsTerminal: true,
          outcomeWindowReviewed: true,
        },
      },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 409);
  assert.equal(
    state.body.code,
    "PROSPECT_MESSAGE_EXPERIMENT_JOBS_NOT_TERMINAL"
  );
  assert.equal(
    fixture.queries.some((query) =>
      query.text.includes("UPDATE prospect_message_experiments")
    ),
    false
  );
});

test("prepared experiment cancellation changes one row and never contacts anyone", async () => {
  const fixture = makeExperimentLifecycleSql({ state: "PREPARED" });
  const handler = captureRoutes(fixture.sql).get(
    "POST /api/prospecting/learning/experiments/:experimentId/cancel"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { experimentId },
      body: {
        definitionHash: fixture.definitionHash,
        confirmation: PROSPECT_MESSAGE_EXPERIMENT_CANCEL_CONFIRMATION,
      },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 200);
  assert.equal(state.body.state, "CANCELLED");
  assert.equal(state.body.externalAction, "none");
  assert.equal(
    fixture.queries.filter((query) =>
      query.text.includes("UPDATE prospect_message_experiments")
    ).length,
    1
  );
  assert.equal(
    fixture.queries.some((query) =>
      /resend|twilio|sms|dial/i.test(query.text)
    ),
    false
  );
});

test("experiment reads fail closed on storage failure", async () => {
  const { sql } = makeExperimentLifecycleSql({ throwOnRead: true });
  const handler = captureRoutes(sql).get(
    "GET /api/prospecting/learning/experiments"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    { authMode: "operator" } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 503);
  assert.equal(state.body.code, "PROSPECT_OUTREACH_STORAGE_UNAVAILABLE");
});

function makeApprovalSql(job: Record<string, unknown> | null) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const sql: any = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    if (
      text.includes(
        "SELECT id, state, channel, payload, payload_hash, expires_at"
      )
    ) {
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
    payload: approvalPayload,
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

test("legacy drafts remain readable but cannot receive a new approval", async () => {
  const { qcReceipt: _qcReceipt, ...legacyPayload } = approvalPayload;
  const legacyPayloadHash = hashProspectOutreachPayload(legacyPayload as any);
  const result = await invokeApproval({
    job: preparedEmailJob({
      payload: legacyPayload,
      payload_hash: legacyPayloadHash,
    }),
    body: {
      payloadHash: legacyPayloadHash,
      attestations: {
        recipientReviewed: true,
        suppressionChecked: true,
        emailComplianceReviewed: true,
      },
    },
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "PROSPECT_QC_RECEIPT_REQUIRED");
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

function measuredLearningRows() {
  return [
    ...Array.from({ length: 10 }, (_, index) => ({
      outreach_job_id: index + 1,
      channel: "email",
      variant_key: "owner-language-v1",
      outcome: index < 2 ? "replied" : "delivered",
      occurred_at: new Date(
        Date.UTC(2026, 6, 1, 9, index)
      ).toISOString(),
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      outreach_job_id: index + 11,
      channel: "email",
      variant_key: "owner-language-v2",
      outcome: index < 4 ? "replied" : "delivered",
      occurred_at: new Date(
        Date.UTC(2026, 6, 2, 9, index)
      ).toISOString(),
    })),
  ];
}

const experimentId = "22222222-2222-4222-8222-222222222222";
const inboxPlacementTestId =
  "33333333-3333-4333-8333-333333333333";

function makeInboxPlacementProofFixture(input: {
  controlVariantKey: string;
  challengerVariantKey: string;
}) {
  const data = prepareProspectInboxPlacementSchema.parse({
    campaignId: 2,
    controlVariantKey: input.controlVariantKey,
    challengerVariantKey: input.challengerVariantKey,
    mailboxes: [
      {
        label: "Google seed 1",
        provider: "google_workspace",
        email: "google-one@example.invalid",
      },
      {
        label: "Microsoft seed 1",
        provider: "microsoft_365",
        email: "microsoft-one@example.invalid",
      },
      {
        label: "Google seed 2",
        provider: "google_workspace",
        email: "google-two@example.invalid",
      },
      {
        label: "Microsoft seed 2",
        provider: "microsoft_365",
        email: "microsoft-two@example.invalid",
      },
      {
        label: "Yahoo seed",
        provider: "yahoo_aol",
        email: "yahoo-one@example.invalid",
      },
    ],
    emailCompliance: {
      senderIdentity: "SMIRK",
      advertisementDisclosure:
        "This is a commercial message from SMIRK.",
      physicalPostalAddress: "1605 McKinley Drive, Reno, NV 89509",
      optOutInstructions:
        "If this is not relevant, reply no and I will not follow up.",
    },
    maxCostCents: 2,
    expiresInHours: 72,
    confirmation: PROSPECT_INBOX_PLACEMENT_PREPARE_CONFIRMATION,
    attestations: {
      controlledMailboxesOnly: true,
      mailboxAccessVerified: true,
      noRealProspectsIncluded: true,
      noContactOrSpendAuthorized: true,
    },
  });
  const definition = buildProspectInboxPlacementDefinition({
    testId: inboxPlacementTestId,
    workspaceId: 7,
    preparedAt: "2026-07-30T14:00:00.000Z",
    data,
  });
  const definitionHash =
    hashProspectInboxPlacementValue(definition);
  const items: ProspectInboxPlacementEvaluationItem[] =
    definition.mailboxes.map((mailbox) => {
      const payloadHash = String(mailbox.slot).repeat(64);
      const providerMessageId = `seed-provider-${mailbox.slot}`;
      const inspection = {
        definitionHash,
        payloadHash,
        providerMessageId,
        inspectedAt: "2026-07-30T14:45:00.000Z",
        folder: "primary" as const,
        smtpAccepted: true,
        spf: "PASS" as const,
        dkim: "PASS" as const,
        dmarc: "PASS" as const,
        fromAligned: true,
        plainTextOnly: true,
        trackingPixelAbsent: true,
        unexpectedLinksAbsent: true,
        complianceFooterRendered: true,
        confirmation:
          "record-one-controlled-inbox-inspection-v1" as const,
        attestations: {
          mailboxOpenedByOperator: true as const,
          folderLocationObserved: true as const,
          rawHeadersReviewed: true as const,
        },
      };
      return {
        slot: mailbox.slot,
        label: mailbox.label,
        provider: mailbox.provider,
        approvalId: `00000000-0000-4000-8000-${String(
          mailbox.slot
        ).padStart(12, "0")}`,
        payloadHash,
        jobState: "SENT",
        storedProviderMessageId: providerMessageId,
        inspection,
        inspectionHash:
          hashProspectInboxPlacementValue(inspection),
      };
    });
  const receipt = buildProspectInboxPlacementReceipt({
    definition,
    definitionHash,
    finalizedAt: "2026-07-30T15:00:00.000Z",
    items,
  });
  return {
    test_id: inboxPlacementTestId,
    definition,
    definition_hash: definitionHash,
    receipt,
    receipt_hash: hashProspectInboxPlacementValue(receipt),
    valid_until: receipt.validUntil,
  };
}

function makeExperimentFixture(input?: {
  state?: "PREPARED" | "ACTIVE" | "CLOSED" | "CANCELLED";
  controlVariantKey?: string;
  challengerVariantKey?: string;
  perArm?: number;
  executedProtocolDeviation?: boolean;
}) {
  const definition = buildProspectMessageExperimentDefinition({
    experimentId,
    workspaceId: 7,
    campaignId: 2,
    channel: "email",
    controlVariantKey:
      input?.controlVariantKey || "owner-language-v1",
    challengerVariantKey:
      input?.challengerVariantKey || "owner-language-v2",
    preparedAt: "2026-07-29T16:00:00.000Z",
  });
  const definitionHash =
    hashProspectMessageExperimentDefinition(definition);
  const inboxPlacement = makeInboxPlacementProofFixture({
    controlVariantKey: definition.controlVariantKey,
    challengerVariantKey: definition.challengerVariantKey,
  });
  const experiment = {
    id: 81,
    experiment_id: definition.experimentId,
    workspace_id: definition.workspaceId,
    campaign_id: definition.campaignId,
    channel: definition.channel,
    state: input?.state || "CLOSED",
    control_variant_key: definition.controlVariantKey,
    challenger_variant_key: definition.challengerVariantKey,
    allocation_basis_points: definition.allocationBasisPoints,
    definition,
    definition_hash: definitionHash,
    inbox_placement_test_id: inboxPlacement.test_id,
    inbox_placement_receipt_hash:
      inboxPlacement.receipt_hash,
    inbox_placement_state: "PASSED",
    inbox_placement_valid_until: inboxPlacement.valid_until,
    inbox_placement_fresh: true,
  };
  const perArm = input?.perArm ?? 10;
  const selected = {
    control: [] as number[],
    challenger: [] as number[],
  };
  for (
    let prospectId = 100;
    prospectId < 10_000 &&
    (selected.control.length < perArm ||
      selected.challenger.length < perArm);
    prospectId += 1
  ) {
    const assignment = buildProspectMessageExperimentAssignment({
      definition,
      prospectId,
      actualVariantKey: definition.controlVariantKey,
    });
    if (selected[assignment.arm].length < perArm) {
      selected[assignment.arm].push(prospectId);
    }
  }
  assert.equal(selected.control.length, perArm);
  assert.equal(selected.challenger.length, perArm);

  let deviationAdded = false;
  const cohortRows = (
    ["control", "challenger"] as const
  ).flatMap((arm) =>
    selected[arm].map((prospectId, index) => {
      const assignedVariantKey =
        arm === "control"
          ? definition.controlVariantKey
          : definition.challengerVariantKey;
      const actualVariantKey =
        input?.executedProtocolDeviation && !deviationAdded
          ? arm === "control"
            ? definition.challengerVariantKey
            : definition.controlVariantKey
          : assignedVariantKey;
      if (actualVariantKey !== assignedVariantKey) deviationAdded = true;
      const assignment = buildProspectMessageExperimentAssignment({
        definition,
        prospectId,
        actualVariantKey,
      });
      const payload = buildProspectOutreachPayload({
        workspaceId: 7,
        campaignId: 2,
        prospectId,
        recipient: `owner-${prospectId}@example.invalid`,
        evidenceHash: "e".repeat(64),
        preparedAt: "2026-07-29T16:30:00.000Z",
        qcContext: {
          businessName: `Synthetic Prospect ${prospectId}`,
          industry: "plumbing",
          evidenceObservation: null,
        },
        experimentAssignment: assignment,
        draft: compliantEmailDraft({
          subject: `Synthetic experiment ${prospectId}`,
          body: `Synthetic review-only message for prospect ${prospectId}.`,
          variantKey: actualVariantKey,
        }),
      });
      const positive = arm === "control" ? index < 2 : index < 4;
      return {
        outreach_job_id: prospectId + 1_000,
        campaign_id: 2,
        lead_id: prospectId,
        channel: "email",
        state: "SENT",
        variant_key: actualVariantKey,
        payload,
        payload_hash: hashProspectOutreachPayload(payload),
        outcome: positive ? "replied" : "delivered",
        occurred_at: new Date(
          Date.UTC(2026, 6, arm === "control" ? 30 : 31, 9, index)
        ).toISOString(),
      };
    })
  );
  return {
    definition,
    definitionHash,
    experiment,
    cohortRows,
    inboxPlacement,
  };
}

function makeEligibleCandidateDecisionFixture() {
  const fixture = makeExperimentFixture();
  return {
    experiment: fixture.experiment,
    candidate: {
      id: 44,
      candidate_key: `experiment:${fixture.definition.experimentId}`,
      state: "CANDIDATE",
      proposal: {
        channel: fixture.definition.channel,
        promoteVariant: fixture.definition.challengerVariantKey,
        replaceVariant: fixture.definition.controlVariantKey,
        studyDesign: "deterministic-assignment-v1",
        experimentId: fixture.definition.experimentId,
        experimentDefinitionHash: fixture.definitionHash,
        registryVersion: PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION,
        runtimePolicyChange: false,
      },
      evidence: {
        current: {
          channel: fixture.definition.channel,
          variantKey: fixture.definition.controlVariantKey,
          sampleSize: 10,
        },
        challenger: {
          channel: fixture.definition.channel,
          variantKey: fixture.definition.challengerVariantKey,
          sampleSize: 10,
        },
        studyDesign: "deterministic-assignment-v1",
        experimentId: fixture.definition.experimentId,
        experimentDefinitionHash: fixture.definitionHash,
        registryVersion: PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION,
        executedProtocolDeviationCount: 0,
      },
      sample_size: 20,
    },
  };
}

function makeLearningSql(options: {
  observations?: Array<Record<string, unknown>>;
  candidateRows?: Array<Record<string, unknown>>;
  decisionCandidate?: Record<string, unknown>;
  insertedRows?: Array<{ id: number }>;
  decidedRows?: Array<{ id: number }>;
  experiment?: Record<string, unknown>;
  cohortRows?: Array<Record<string, unknown>>;
  existingExperimentCandidate?: Record<string, unknown>;
  throwOnCandidateList?: boolean;
  throwOnDecision?: boolean;
}) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const sql: any = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    if (
      text.includes("FROM prospect_message_experiments") &&
      text.includes("experiment_id")
    ) {
      return options.experiment ? [options.experiment] : [];
    }
    if (
      text.includes("FROM prospect_outreach_jobs j") &&
      text.includes("LEFT JOIN prospect_outcome_events")
    ) {
      return options.cohortRows ?? [];
    }
    if (text.includes("SELECT j.id AS outreach_job_id")) {
      return options.observations ?? measuredLearningRows();
    }
    if (
      text.includes("SELECT id, candidate_key, state, proposal, evidence") &&
      text.includes("FOR UPDATE")
    ) {
      return options.decisionCandidate
        ? [options.decisionCandidate]
        : [];
    }
    if (
      text.includes("FROM prospect_learning_candidates c") &&
      text.includes("recommendation_eligible")
    ) {
      if (options.throwOnCandidateList) {
        throw new Error("synthetic candidate list failure");
      }
      return options.candidateRows ?? [];
    }
    if (
      text.includes("SELECT id, version, state, sample_size") &&
      text.includes("FROM prospect_learning_candidates")
    ) {
      return options.existingExperimentCandidate
        ? [options.existingExperimentCandidate]
        : [];
    }
    if (text.includes("SELECT COALESCE(MAX(version), 0) + 1 AS version")) {
      return [{ version: 3 }];
    }
    if (text.includes("INSERT INTO prospect_learning_candidates")) {
      return options.insertedRows ?? [{ id: 44 }];
    }
    if (text.includes("UPDATE prospect_learning_candidates")) {
      if (options.throwOnDecision) {
        throw new Error("synthetic candidate decision failure");
      }
      return options.decidedRows ?? [{ id: 44 }];
    }
    throw new Error(`Unexpected SQL in learning route test: ${text}`);
  };
  sql.begin = async (callback: (tx: any) => unknown) => callback(sql);
  sql.json = (value: unknown) => value;
  return { sql, queries };
}

test("lists only workspace-scoped measured candidates", async () => {
  const candidate = {
    id: 44,
    candidate_key: `experiment:${experimentId}`,
    state: "APPROVED",
    recommendation_eligible: true,
  };
  const { sql, queries } = makeLearningSql({ candidateRows: [candidate] });
  const routes = captureRoutes(sql);
  const handler = routes.get("GET /api/prospecting/learning/candidates");
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    { authMode: "operator" } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body.candidates, [candidate]);
  assert.equal(state.body.policyChanged, false);
  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /recommendation_eligible/);
  assert.match(
    queries[0].text,
    /LEFT JOIN prospect_message_experiments/
  );
  assert.match(queries[0].text, /WHERE c\.workspace_id/);
  assert.equal(queries[0].values.includes(7), true);
});

test("learning candidate reads fail closed on database failure", async () => {
  const { sql } = makeLearningSql({ throwOnCandidateList: true });
  const routes = captureRoutes(sql);
  const handler = routes.get("GET /api/prospecting/learning/candidates");
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    { authMode: "operator" } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 503);
  assert.equal(state.body.code, "PROSPECT_OUTREACH_STORAGE_UNAVAILABLE");
});

test("scorecards exclude unregistered and operator-custom copy", async () => {
  const { sql } = makeLearningSql({
    observations: [
      ...measuredLearningRows(),
      {
        outreach_job_id: 101,
        channel: "email",
        variant_key: "operator-custom-deadbeefdeadbeef",
        outcome: "replied",
        occurred_at: "2026-07-03T09:00:00.000Z",
      },
      {
        outreach_job_id: 102,
        channel: "call",
        variant_key: "unregistered-call-v9",
        outcome: "call_connected",
        occurred_at: "2026-07-03T09:05:00.000Z",
      },
    ],
  });
  const routes = captureRoutes(sql);
  const handler = routes.get("GET /api/prospecting/learning/scorecard");
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    { authMode: "operator" } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 200);
  assert.equal(state.body.sampleSize, 20);
  assert.equal(state.body.eventCount, 20);
  assert.deepEqual(
    state.body.variants.map((variant: any) => variant.variantKey).sort(),
    ["owner-language-v1", "owner-language-v2"]
  );
});

test("scorecards count executed jobs instead of raw lifecycle events", async () => {
  const { sql } = makeLearningSql({
    observations: [
      {
        outreach_job_id: 1,
        channel: "email",
        variant_key: "owner-language-v1",
        outcome: "delivered",
        occurred_at: "2026-07-01T09:00:00.000Z",
      },
      {
        outreach_job_id: 1,
        channel: "email",
        variant_key: "owner-language-v1",
        outcome: "replied",
        occurred_at: "2026-07-01T09:05:00.000Z",
      },
      {
        outreach_job_id: 1,
        channel: "email",
        variant_key: "owner-language-v1",
        outcome: "qualified",
        occurred_at: "2026-07-01T09:10:00.000Z",
      },
    ],
  });
  const routes = captureRoutes(sql);
  const handler = routes.get("GET /api/prospecting/learning/scorecard");
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    { authMode: "operator" } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 200);
  assert.equal(state.body.sampleSize, 1);
  assert.equal(state.body.eventCount, 3);
  assert.equal(state.body.variants[0].sampleSize, 1);
  assert.equal(state.body.variants[0].eventCount, 3);
  assert.equal(state.body.variants[0].positiveRate, 1);
  assert.deepEqual(state.body.variants[0].outcomes, { qualified: 1 });
});

test("candidate creation rejects an experiment with an unregistered strategy", async () => {
  const fixture = makeExperimentFixture({
    challengerVariantKey: "invented-v9",
  });
  const { sql, queries } = makeLearningSql({
    experiment: fixture.experiment,
  });
  const routes = captureRoutes(sql);
  const handler = routes.get("POST /api/prospecting/learning/candidates");
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      body: { experimentId },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 409);
  assert.equal(state.body.code, "PROSPECT_LEARNING_UNREGISTERED_VARIANT");
  assert.equal(
    queries.some((query) =>
      query.text.includes("INSERT INTO prospect_learning_candidates")
    ),
    false
  );
});

test("creates a candidate only from a closed, assigned cohort without external action", async () => {
  const fixture = makeExperimentFixture();
  const { sql, queries } = makeLearningSql({
    experiment: fixture.experiment,
    cohortRows: fixture.cohortRows,
  });
  const routes = captureRoutes(sql);
  const handler = routes.get("POST /api/prospecting/learning/candidates");
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      body: { experimentId },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 201, JSON.stringify(state.body));
  assert.equal(state.body.state, "CANDIDATE");
  assert.equal(state.body.id, 44);
  assert.equal(state.body.version, 3);
  assert.equal(state.body.sampleSize, 20);
  assert.equal(state.body.experimentId, experimentId);
  assert.equal(state.body.candidateKey, `experiment:${experimentId}`);
  assert.equal(state.body.policyChanged, false);
  assert.equal(state.body.externalAction, "none");
  const insert = queries.find((query) =>
    query.text.includes("INSERT INTO prospect_learning_candidates")
  );
  assert.ok(insert);
  assert.equal(insert.values.includes(7), true);
  assert.equal(
    insert.values.some(
      (value: any) =>
        value?.promoteVariant === "owner-language-v2" &&
        value?.replaceVariant === "owner-language-v1" &&
        value?.promoteLabel === "Owner workflow question" &&
        value?.registryVersion === "smirk.prospect-message-variants.v1" &&
        value?.studyDesign === "deterministic-assignment-v1" &&
        value?.runtimePolicyChange === false
    ),
    true
  );
  assert.equal(
    insert.values.some(
      (value: any) =>
        value?.experimentId === experimentId &&
        value?.studyDesign === "deterministic-assignment-v1" &&
        value?.executedProtocolDeviationCount === 0 &&
        value?.assignedProspects === 20 &&
        value?.measuredProspects === 20
    ),
    true
  );
});

test("candidate creation replay returns the frozen experiment result", async () => {
  const fixture = makeExperimentFixture();
  const { sql, queries } = makeLearningSql({
    experiment: fixture.experiment,
    existingExperimentCandidate: {
      id: 44,
      version: 1,
      state: "CANDIDATE",
      sample_size: 20,
      evidence: {
        armStats: {
          control: { assigned: 10, executed: 10, measured: 10 },
          challenger: { assigned: 10, executed: 10, measured: 10 },
        },
      },
    },
  });
  const handler = captureRoutes(sql).get(
    "POST /api/prospecting/learning/candidates"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      body: { experimentId },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 200);
  assert.equal(state.body.outcome, "duplicate");
  assert.equal(state.body.id, 44);
  assert.equal(state.body.sampleSize, 20);
  assert.equal(
    queries.some((query) =>
      query.text.includes("LEFT JOIN prospect_outcome_events")
    ),
    false
  );
});

test("refuses a closed experiment before the measured sample gate", async () => {
  const fixture = makeExperimentFixture({ perArm: 9 });
  const { sql, queries } = makeLearningSql({
    experiment: fixture.experiment,
    cohortRows: fixture.cohortRows,
  });
  const routes = captureRoutes(sql);
  const handler = routes.get("POST /api/prospecting/learning/candidates");
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      body: { experimentId },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 409);
  assert.equal(state.body.code, "PROSPECT_LEARNING_INSUFFICIENT_SAMPLE");
  assert.equal(
    queries.some((query) =>
      query.text.includes("INSERT INTO prospect_learning_candidates")
    ),
    false
  );
});

test("refuses candidate evaluation while the experiment is active", async () => {
  const fixture = makeExperimentFixture({ state: "ACTIVE" });
  const { sql, queries } = makeLearningSql({
    experiment: fixture.experiment,
  });
  const routes = captureRoutes(sql);
  const handler = routes.get("POST /api/prospecting/learning/candidates");
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      body: { experimentId },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 409);
  assert.equal(state.body.code, "PROSPECT_LEARNING_EXPERIMENT_NOT_CLOSED");
  assert.equal(
    queries.some((query) =>
      query.text.includes("FROM prospect_outreach_jobs j")
    ),
    false
  );
});

test("executed off-protocol content blocks a learning candidate", async () => {
  const fixture = makeExperimentFixture({
    executedProtocolDeviation: true,
  });
  const { sql, queries } = makeLearningSql({
    experiment: fixture.experiment,
    cohortRows: fixture.cohortRows,
  });
  const routes = captureRoutes(sql);
  const handler = routes.get("POST /api/prospecting/learning/candidates");
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      body: { experimentId },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 409);
  assert.equal(state.body.code, "PROSPECT_LEARNING_PROTOCOL_DEVIATION");
  assert.equal(
    queries.some((query) =>
      query.text.includes("INSERT INTO prospect_learning_candidates")
    ),
    false
  );
});

test("learning decisions are workspace-scoped, single-use, and advisory", async () => {
  const fixture = makeEligibleCandidateDecisionFixture();
  const { sql, queries } = makeLearningSql({
    decisionCandidate: fixture.candidate,
    experiment: fixture.experiment,
  });
  const routes = captureRoutes(sql);
  const handler = routes.get(
    "POST /api/prospecting/learning/candidates/:id/decision"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { id: "44" },
      body: { decision: "APPROVED" },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 200);
  assert.equal(state.body.state, "APPROVED");
  assert.equal(state.body.policyChanged, false);
  assert.equal(state.body.externalAction, "none");
  assert.match(state.body.note, /Runtime outreach policy is unchanged/);
  const update = queries.find((query) =>
    query.text.includes("UPDATE prospect_learning_candidates")
  );
  assert.ok(update);
  assert.match(update.text, /workspace_id/);
  assert.match(update.text, /state = 'CANDIDATE'/);
  assert.equal(update.values.includes(44), true);
  assert.equal(update.values.includes(7), true);
  assert.equal(update.values.includes("APPROVED"), true);
});

test("legacy observational candidates cannot be approved", async () => {
  const { sql, queries } = makeLearningSql({
    decisionCandidate: {
      id: 44,
      candidate_key: "variant:email:v1:to:v2",
      state: "CANDIDATE",
      proposal: {
        channel: "email",
        promoteVariant: "owner-language-v2",
        replaceVariant: "owner-language-v1",
      },
      evidence: {},
      sample_size: 20,
    },
  });
  const routes = captureRoutes(sql);
  const handler = routes.get(
    "POST /api/prospecting/learning/candidates/:id/decision"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { id: "44" },
      body: { decision: "APPROVED" },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 409);
  assert.equal(
    state.body.code,
    "PROSPECT_LEARNING_CANDIDATE_INELIGIBLE"
  );
  assert.equal(
    queries.some((query) =>
      query.text.includes("UPDATE prospect_learning_candidates")
    ),
    false
  );
});

test("legacy observational candidates can be rejected from the queue", async () => {
  const { sql } = makeLearningSql({
    decisionCandidate: {
      id: 44,
      candidate_key: "variant:email:v1:to:v2",
      state: "CANDIDATE",
      proposal: {},
      evidence: {},
      sample_size: 20,
    },
  });
  const routes = captureRoutes(sql);
  const handler = routes.get(
    "POST /api/prospecting/learning/candidates/:id/decision"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { id: "44" },
      body: { decision: "REJECTED" },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 200);
  assert.equal(state.body.state, "REJECTED");
  assert.equal(state.body.policyChanged, false);
  assert.equal(state.body.externalAction, "none");
});

test("learning decision reports a conflict when no candidate row changes", async () => {
  const { sql } = makeLearningSql({});
  const routes = captureRoutes(sql);
  const handler = routes.get(
    "POST /api/prospecting/learning/candidates/:id/decision"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { id: "44" },
      body: { decision: "APPROVED" },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 409);
  assert.equal(state.body.code, "PROSPECT_LEARNING_STATE_CONFLICT");
  assert.equal(state.body.policyChanged, false);
});

test("learning decisions fail closed on database failure", async () => {
  const fixture = makeEligibleCandidateDecisionFixture();
  const { sql } = makeLearningSql({
    decisionCandidate: fixture.candidate,
    experiment: fixture.experiment,
    throwOnDecision: true,
  });
  const routes = captureRoutes(sql);
  const handler = routes.get(
    "POST /api/prospecting/learning/candidates/:id/decision"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { id: "44" },
      body: { decision: "APPROVED" },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 503);
  assert.equal(state.body.code, "PROSPECT_OUTREACH_STORAGE_UNAVAILABLE");
});
