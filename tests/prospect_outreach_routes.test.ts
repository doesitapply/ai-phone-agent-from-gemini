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
  buildProspectCallComplianceReceipt,
  type ProspectCallComplianceEvidence,
} from "../src/prospect-call-compliance.ts";
import {
  PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION,
  buildProspectMessageContext,
  renderProspectMessageVariant,
} from "../src/prospect-message-variants.ts";
import {
  PROSPECT_MESSAGE_EXPERIMENT_ACTIVATION_CONFIRMATION,
  PROSPECT_MESSAGE_EXPERIMENT_CANCEL_CONFIRMATION,
  PROSPECT_MESSAGE_EXPERIMENT_CLOSE_CONFIRMATION,
  PROSPECT_MESSAGE_EXPERIMENT_PREPARE_DRAFTS_CONFIRMATION,
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
import { buildProspectQcReceipt } from "../src/prospect-qc.ts";
import {
  buildProspectQcRevisionPayload,
  hashProspectQcRevisionPayload,
} from "../src/prospect-qc-revision.ts";

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
const callApprovalPayload = buildProspectOutreachPayload({
  workspaceId: 7,
  campaignId: 2,
  prospectId: 3,
  recipient: "+17755550142",
  evidenceHash: "e".repeat(64),
  preparedAt: "2026-07-30T16:00:00.000Z",
  qcContext: {
    businessName: "Synthetic Plumbing",
    industry: "plumbing",
    evidenceObservation: null,
  },
  draft: {
    channel: "call",
    callBrief:
      "Review the synthetic plumbing record and decide whether to place one manual operator call.",
    maxCostCents: 10,
    expiresInHours: 8,
  },
});
const callPayloadHash = hashProspectOutreachPayload(
  callApprovalPayload
);
const revisionId = "22222222-2222-4222-8222-222222222222";
const revisionPreparedAt = "2026-08-01T16:00:00.000Z";
const revisionDraft = {
  channel: "email" as const,
  subject: "quick question [Company]",
  body:
    "Hi {{first_name}} - Cameron with SMIRK. How are after-hours calls handled?",
  emailCompliance: {
    senderIdentity: "SMIRK",
    advertisementDisclosure:
      "This is a commercial message from SMIRK.",
    physicalPostalAddress: "1605 McKinley Drive, Reno, NV 89509",
    optOutInstructions:
      "If this is not relevant, reply no and I will not follow up.",
  },
  variantKey: "micro-after-hours-v1",
  maxCostCents: 2,
  expiresInHours: 24,
};
const revisionContext = buildProspectMessageContext({
  businessName: "Silver State Home Services Demo",
  industry: "plumbing",
  researchEvidence: [
    {
      kind: "contact_path",
      basis: "observed",
      observation: "The public page offers emergency service contact.",
    },
  ],
});
const revisionQcReceipt = buildProspectQcReceipt({
  draft: revisionDraft,
  context: revisionContext,
  evidenceHash: "e".repeat(64),
  evaluatedAt: revisionPreparedAt,
});
const revisionPayload = buildProspectQcRevisionPayload({
  revisionId,
  workspaceId: 7,
  campaignId: 2,
  prospectId: 3,
  channel: "email",
  recipient: "owner@example.invalid",
  subject: revisionDraft.subject,
  content: revisionDraft.body,
  variantKey: revisionDraft.variantKey,
  evidenceHash: "e".repeat(64),
  emailCompliance: revisionDraft.emailCompliance,
  maxCostCents: revisionDraft.maxCostCents,
  expiresInHours: revisionDraft.expiresInHours,
  qcReceipt: revisionQcReceipt,
  preparedAt: revisionPreparedAt,
});
const revisionPayloadHash = hashProspectQcRevisionPayload(
  revisionPayload
);

type CapturedHandler = (
  req: Request,
  res: Response,
  next: () => void
) => unknown;

function captureRoutes(sql: any, now = () => new Date()) {
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
    now,
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
  leadId?: number;
  existingQcRevision?: {
    revision_id: string;
    state: "REVISION_REQUIRED" | "REJECTED" | "SUPERSEDED";
    payload: unknown;
    payload_hash: string;
  };
  racedQcRevision?: {
    revision_id: string;
    state: "REVISION_REQUIRED" | "REJECTED" | "SUPERSEDED";
    payload: unknown;
    payload_hash: string;
  };
}) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  let qcRevisionReadCount = 0;
  const lead = {
    id: options?.leadId || 3,
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
    external_id: `synthetic-prospect-${options?.leadId || 3}`,
    source: "manual",
  };
  const sql: any = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    if (text === "FOR UPDATE" || text === "") return [];
    if (text.includes("pg_advisory_xact_lock")) {
      return [{ pg_advisory_xact_lock: null }];
    }
    if (text.includes("FROM prospect_positive_outcome_reviews")) {
      return [{ pending_count: 0 }];
    }
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
      if (!options?.activeExperiment) return [];
      const requestedChannel = values.find(
        value => value === "email" || value === "call"
      );
      if (
        requestedChannel &&
        requestedChannel !== options.activeExperiment.channel
      ) {
        return [];
      }
      return [options.activeExperiment];
    }
    if (
      text.includes("FROM prospect_outreach_jobs") &&
      (text.includes("draft_fingerprint") ||
        text.includes("payload->'experimentAssignment'"))
    ) {
      return [];
    }
    if (
      text.includes("FROM prospect_qc_revision_items") &&
      text.includes("draft_fingerprint")
    ) {
      qcRevisionReadCount += 1;
      if (options?.racedQcRevision && qcRevisionReadCount > 1) {
        return [options.racedQcRevision];
      }
      return options?.existingQcRevision
        ? [options.existingQcRevision]
        : [];
    }
    if (text.includes("INSERT INTO prospect_qc_revision_items")) {
      if (options?.racedQcRevision) return [];
      return [{ id: 73 }];
    }
    if (text.includes("INSERT INTO prospect_qc_revision_events")) {
      return [{ id: 74 }];
    }
    if (text.includes("UPDATE prospect_qc_revision_items")) {
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

test("deterministic QC persists unresolved placeholders only in the revision ledger", async () => {
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
      authMode: "demo_operator",
      headers: { "x-api-key": "synthetic-demo-operator-key" },
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 201);
  assert.equal(state.body.outcome, "revision_required");
  assert.equal(state.body.state, "REVISION_REQUIRED");
  assert.equal(state.body.externalAction, "none");
  assert.match(
    state.body.qcReceipt.failureReasons.join("\n"),
    /PLACEHOLDERS_RESOLVED/
  );
  assert.equal(
    queries.some((query) =>
      query.text.includes("INSERT INTO prospect_outreach_jobs")
    ),
    false
  );
  assert.equal(
    queries.filter((query) =>
      query.text.includes("INSERT INTO prospect_qc_revision_items")
    ).length,
    1
  );
  assert.equal(
    queries.filter((query) =>
      query.text.includes("INSERT INTO prospect_qc_revision_events")
    ).length,
    1
  );
  assert.equal(
    queries
      .find(query =>
        query.text.includes("INSERT INTO prospect_qc_revision_items")
      )
      ?.values.some(value =>
        /^dashboard_demo_operator:[a-f0-9]{16}$/.test(String(value))
      ),
    true
  );
  assert.equal(
    queries.some(
      query =>
        query.text.includes("prospect_email_provider_events") &&
        /^(INSERT|UPDATE|DELETE)\b/.test(query.text)
    ),
    false
  );
});

test("exact failed-draft replay reuses the immutable QC revision", async () => {
  const { sql, queries } = makePreparationSql({
    existingQcRevision: {
      revision_id: revisionId,
      state: "REVISION_REQUIRED",
      payload: revisionPayload,
      payload_hash: revisionPayloadHash,
    },
  });
  const handler = captureRoutes(sql).get(
    "POST /api/prospecting/leads/:id/outreach"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { id: "3" },
      body: revisionDraft,
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 200);
  assert.equal(state.body.outcome, "revision_duplicate");
  assert.equal(state.body.revisionId, revisionId);
  assert.equal(state.body.payloadHash, revisionPayloadHash);
  assert.equal(state.body.externalAction, "none");
  assert.equal(
    queries.some(query =>
      query.text.includes("INSERT INTO prospect_qc_revision_items")
    ),
    false
  );
  assert.equal(
    queries.some(query =>
      query.text.includes("INSERT INTO prospect_outreach_jobs")
    ),
    false
  );
});

test("concurrent failed-draft preparation converges on one immutable QC revision", async () => {
  const { sql, queries } = makePreparationSql({
    racedQcRevision: {
      revision_id: revisionId,
      state: "REVISION_REQUIRED",
      payload: revisionPayload,
      payload_hash: revisionPayloadHash,
    },
  });
  const handler = captureRoutes(sql).get(
    "POST /api/prospecting/leads/:id/outreach"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { id: "3" },
      body: revisionDraft,
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 200);
  assert.equal(state.body.outcome, "revision_duplicate");
  assert.equal(state.body.revisionId, revisionId);
  assert.equal(state.body.payloadHash, revisionPayloadHash);
  assert.equal(
    queries.filter(query =>
      query.text.includes("INSERT INTO prospect_qc_revision_items")
    ).length,
    1
  );
  assert.equal(
    queries.filter(query =>
      query.text.includes("FROM prospect_qc_revision_items")
    ).length,
    2
  );
  assert.equal(
    queries.some(query =>
      query.text.includes("INSERT INTO prospect_qc_revision_events")
    ),
    false
  );
});

test("QC revision rejection rejects malformed and cross-workspace identifiers before mutation", async () => {
  let calls = 0;
  const sql: any = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    calls += 1;
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    assert.match(text, /FROM prospect_qc_revision_items/);
    assert.ok(values.includes(7));
    return [];
  };
  sql.begin = async (callback: (tx: any) => unknown) => callback(sql);
  sql.json = (value: unknown) => value;
  const handler = captureRoutes(sql).get(
    "POST /api/prospecting/qc-revisions/:revisionId/reject"
  );
  assert.ok(handler);

  const malformed = makeResponse();
  await handler(
    {
      params: { revisionId: "public-target-id" },
      body: { payloadHash: revisionPayloadHash, reason: "Not suitable." },
      authMode: "operator",
    } as unknown as Request,
    malformed.response,
    () => undefined
  );
  assert.equal(malformed.state.statusCode, 400);
  assert.equal(calls, 0);

  const missing = makeResponse();
  await handler(
    {
      params: { revisionId },
      body: { payloadHash: revisionPayloadHash, reason: "Not suitable." },
      authMode: "operator",
    } as unknown as Request,
    missing.response,
    () => undefined
  );
  assert.equal(missing.state.statusCode, 404);
  assert.equal(
    missing.state.body.code,
    "PROSPECT_QC_REVISION_NOT_FOUND"
  );
  assert.equal(calls, 1);
});

test("QC revision rejection fails closed on a tampered stored payload", async () => {
  const queries: string[] = [];
  const sql: any = async (strings: TemplateStringsArray) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    queries.push(text);
    if (text.includes("FROM prospect_qc_revision_items")) {
      return [
        {
          id: 19,
          state: "REVISION_REQUIRED",
          payload: {
            ...revisionPayload,
            content: `${revisionPayload.content} tampered`,
          },
          payload_hash: revisionPayloadHash,
          rejected_by: null,
          rejection_reason: null,
        },
      ];
    }
    throw new Error(`Unexpected revision rejection SQL: ${text}`);
  };
  sql.begin = async (callback: (tx: any) => unknown) => callback(sql);
  sql.json = (value: unknown) => value;
  const handler = captureRoutes(sql).get(
    "POST /api/prospecting/qc-revisions/:revisionId/reject"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { revisionId },
      body: { payloadHash: revisionPayloadHash, reason: "Not suitable." },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 409);
  assert.equal(
    state.body.code,
    "PROSPECT_QC_REVISION_PAYLOAD_INVALID"
  );
  assert.equal(
    queries.some(query => query.includes("UPDATE prospect_qc_revision_items")),
    false
  );
});

test("QC revision rejection is single-use and exact-replay idempotent", async () => {
  const queries: string[] = [];
  let storedState: "REVISION_REQUIRED" | "REJECTED" =
    "REVISION_REQUIRED";
  let storedReason: string | null = null;
  const sql: any = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    queries.push(text);
    if (text.includes("FROM prospect_qc_revision_items")) {
      return [
        {
          id: 19,
          state: storedState,
          payload: revisionPayload,
          payload_hash: revisionPayloadHash,
          rejected_by:
            storedState === "REJECTED" ? "dashboard_operator" : null,
          rejection_reason: storedReason,
        },
      ];
    }
    if (text.includes("UPDATE prospect_qc_revision_items")) {
      storedState = "REJECTED";
      storedReason = String(
        values.find(value => value === "Unsupported positioning.")
      );
      return [{ id: 19 }];
    }
    if (text.includes("INSERT INTO prospect_qc_revision_events")) {
      return [{ id: 20 }];
    }
    throw new Error(`Unexpected revision rejection SQL: ${text}`);
  };
  sql.begin = async (callback: (tx: any) => unknown) => callback(sql);
  sql.json = (value: unknown) => value;
  const handler = captureRoutes(sql).get(
    "POST /api/prospecting/qc-revisions/:revisionId/reject"
  );
  assert.ok(handler);
  const request = {
    params: { revisionId },
    body: {
      payloadHash: revisionPayloadHash,
      reason: "Unsupported positioning.",
    },
    authMode: "operator",
  } as unknown as Request;

  const first = makeResponse();
  await handler(request, first.response, () => undefined);
  assert.equal(first.state.statusCode, 200);
  assert.equal(first.state.body.outcome, "rejected");
  assert.equal(first.state.body.externalAction, "none");

  const replay = makeResponse();
  await handler(request, replay.response, () => undefined);
  assert.equal(replay.state.statusCode, 200);
  assert.equal(replay.state.body.outcome, "duplicate");

  const changed = makeResponse();
  await handler(
    {
      ...request,
      body: {
        payloadHash: revisionPayloadHash,
        reason: "A different immutable reason.",
      },
    } as Request,
    changed.response,
    () => undefined
  );
  assert.equal(changed.state.statusCode, 409);
  assert.equal(
    changed.state.body.code,
    "PROSPECT_QC_REVISION_REPLAY_MISMATCH"
  );
  assert.equal(
    queries.filter(query =>
      query.includes("UPDATE prospect_qc_revision_items")
    ).length,
    1
  );
  assert.equal(
    queries.filter(query =>
      query.includes("INSERT INTO prospect_qc_revision_events")
    ).length,
    1
  );
  assert.equal(
    queries.some(query => /provider|resend|twilio/i.test(query)),
    false
  );
});

test("QC revision rejection reports database failure without false success", async () => {
  const sql: any = async () => {
    throw new Error("synthetic revision database failure");
  };
  sql.begin = async (callback: (tx: any) => unknown) => callback(sql);
  sql.json = (value: unknown) => value;
  const handler = captureRoutes(sql).get(
    "POST /api/prospecting/qc-revisions/:revisionId/reject"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();
  await handler(
    {
      params: { revisionId },
      body: { payloadHash: revisionPayloadHash, reason: "Not suitable." },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );
  assert.equal(state.statusCode, 503);
  assert.equal(
    state.body.code,
    "PROSPECT_OUTREACH_STORAGE_UNAVAILABLE"
  );
});

test("lead outreach read exposes only the hash-verified workspace QC revision", async () => {
  const queryValues: unknown[][] = [];
  const lead = makePreparationSql().lead;
  const sql: any = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    queryValues.push(values);
    if (text === "") return [];
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
      return [];
    }
    if (text.includes("FROM prospect_qc_revision_items r")) {
      return [
        {
          revision_id: revisionId,
          state: "REVISION_REQUIRED",
          payload: revisionPayload,
          payload_hash: revisionPayloadHash,
          prepared_by: "dashboard_operator",
          prepared_at: revisionPreparedAt,
          rejected_by: null,
          rejected_at: null,
          rejection_reason: null,
          superseded_by_approval_id: null,
          superseded_at: null,
          created_at: revisionPreparedAt,
          updated_at: revisionPreparedAt,
        },
      ];
    }
    if (
      text.includes("FROM prospect_outreach_jobs") ||
      text.includes("FROM prospect_outcome_events") ||
      text.includes("FROM prospect_qc_model_reviews")
    ) {
      return [];
    }
    throw new Error(`Unexpected revision list SQL: ${text}`);
  };
  sql.begin = async (callback: (tx: any) => unknown) => callback(sql);
  sql.json = (value: unknown) => value;
  const handler = captureRoutes(sql).get(
    "GET /api/prospecting/leads/:id/outreach"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { id: "3" },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 200, JSON.stringify(state.body));
  assert.equal(state.body.jobs.length, 0);
  assert.equal(state.body.qcRevisions.length, 1);
  assert.equal(state.body.qcRevisions[0].revision_id, revisionId);
  assert.equal(state.body.qcRevisions[0].approvalAuthorized, false);
  assert.equal(state.body.qcRevisions[0].contactAuthorized, false);
  assert.equal(state.body.qcRevisions[0].executionAuthorized, false);
  assert.equal(state.body.qcRevisions[0].providerRequestAuthorized, false);
  assert.ok(queryValues.flat().includes(7));
  assert.doesNotMatch(JSON.stringify(state.body), /re_[A-Za-z0-9]{16,}/);
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

test("active experiment rejects preparation outside its frozen cohort", async () => {
  const fixture = makeExperimentFixture({ state: "ACTIVE" });
  const outsideLeadId = 999;
  assert.equal(
    fixture.definition.cohort.some(
      entry => entry.prospectId === outsideLeadId
    ),
    false
  );
  const { sql, queries, lead } = makePreparationSql({
    activeExperiment: fixture.experiment,
    leadId: outsideLeadId,
  });
  const context = buildProspectMessageContext({
    businessName: lead.business_name,
    industry: lead.industry,
    researchEvidence: lead.research_evidence,
  });
  const rendered = renderProspectMessageVariant(
    fixture.definition.controlVariantKey,
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
      params: { id: String(outsideLeadId) },
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

  assert.equal(state.statusCode, 409, JSON.stringify(state.body));
  assert.equal(
    state.body.code,
    "PROSPECT_MESSAGE_EXPERIMENT_PROSPECT_NOT_SELECTED"
  );
  assert.equal(
    queries.some(query =>
      query.text.includes("INSERT INTO prospect_outreach_jobs")
    ),
    false
  );
});

test("a frozen prospect cannot enter a competing outreach channel", async () => {
  const fixture = makeExperimentFixture({ state: "ACTIVE" });
  const { sql, queries, lead } = makePreparationSql({
    activeExperiment: fixture.experiment,
  });
  const context = buildProspectMessageContext({
    businessName: lead.business_name,
    industry: lead.industry,
    researchEvidence: lead.research_evidence,
  });
  const rendered = renderProspectMessageVariant(
    "manual-owner-call-v1",
    context
  );
  assert.ok(rendered);
  const handler = captureRoutes(sql).get(
    "POST /api/prospecting/leads/:id/outreach"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { id: String(lead.id) },
      body: {
        channel: "call",
        callBrief: rendered.content,
        variantKey: rendered.key,
        maxCostCents: 1,
        expiresInHours: 24,
      },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(
    state.statusCode,
    409,
    JSON.stringify(state.body)
  );
  assert.equal(
    state.body.code,
    "PROSPECT_MESSAGE_EXPERIMENT_COHORT_RESERVED"
  );
  assert.equal(
    queries.some(query =>
      query.text.includes("INSERT INTO prospect_outreach_jobs")
    ),
    false
  );
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
  sentJobs?: number;
  sentWithoutTimestampJobs?: number;
  sentWithoutOutcomeJobs?: number;
  latestSentAt?: string | null;
  observedAt?: string;
  updateRows?: Array<{ id: number }>;
  throwOnRead?: boolean;
  enrolledProspectIds?: number[];
  eligibleProspectIds?: number[];
  activeReservations?: Array<Record<string, unknown>>;
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
    if (text.includes("pg_advisory_xact_lock")) {
      return [{ pg_advisory_xact_lock: null }];
    }
    if (text.includes("FROM prospect_positive_outcome_reviews")) {
      return [{ pending_count: 0 }];
    }
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
    if (text.includes("FROM prospect_message_policy_releases")) {
      return [];
    }
    if (
      text.includes("SELECT experiment_id") &&
      text.includes("state = 'ACTIVE'")
    ) {
      return [];
    }
    if (
      text.includes("ORDER BY activated_at ASC") &&
      text.includes("state = 'ACTIVE'")
    ) {
      return input?.activeReservations || [];
    }
    if (
      text.includes("FROM prospect_leads l") &&
      text.includes("ORDER BY l.id ASC")
    ) {
      return (
        input?.eligibleProspectIds ||
        fixture.definition.eligibleProspectIds
      ).map(id => ({ id }));
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
      text.includes("SELECT lead_id") &&
      text.includes("prospect_outreach_jobs") &&
      text.includes("ORDER BY lead_id ASC")
    ) {
      return (
        input?.enrolledProspectIds ||
        fixture.definition.cohort.map(entry => entry.prospectId)
      ).map(lead_id => ({
        lead_id,
        campaign_id: 2,
        channel: "email",
      }));
    }
    if (
      text.includes("AS sent_without_outcome_count") &&
      text.includes("FROM prospect_outreach_jobs j")
    ) {
      return [{
        pending_count: input?.pendingJobs || 0,
        sent_count: input?.sentJobs ?? 20,
        sent_without_timestamp_count:
          input?.sentWithoutTimestampJobs || 0,
        sent_without_outcome_count:
          input?.sentWithoutOutcomeJobs || 0,
        latest_sent_at:
          input?.latestSentAt === undefined
            ? "2026-07-20T17:00:00.000Z"
            : input.latestSentAt,
        observed_at:
          input?.observedAt || "2026-08-10T17:00:00.000Z",
      }];
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
  assert.equal(
    state.body.definition.studyDesign,
    "deterministic-eligible-cohort-v1"
  );
  assert.equal(state.body.definition.eligiblePopulationSize, 20);
  assert.equal(state.body.definition.cohortSize, 20);
  assert.equal(
    state.body.definition.cohort.filter(
      (entry: { arm: string }) => entry.arm === "control"
    ).length,
    10
  );
  assert.equal(
    state.body.definition.cohort.filter(
      (entry: { arm: string }) => entry.arm === "challenger"
    ).length,
    10
  );
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

test("experiment preparation fails closed when the untouched eligible cohort is too small", async () => {
  const fixture = makeExperimentLifecycleSql({
    eligibleProspectIds: Array.from(
      { length: 19 },
      (_, index) => index + 1
    ),
  });
  const handler = captureRoutes(fixture.sql).get(
    "POST /api/prospecting/learning/experiments"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      body: {
        campaignId: 2,
        channel: "email",
        controlVariantKey: "owner-language-v1",
        challengerVariantKey: "owner-language-v2",
        cohortSize: 20,
      },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 409);
  assert.equal(
    state.body.code,
    "PROSPECT_MESSAGE_EXPERIMENT_ELIGIBLE_COHORT_TOO_SMALL"
  );
  assert.equal(
    fixture.queries.some(query =>
      query.text.includes("INSERT INTO prospect_message_experiments")
    ),
    false
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

test("experiment activation rejects selected-prospect eligibility drift", async () => {
  const fixture = makeExperimentLifecycleSql({
    state: "PREPARED",
    eligibleProspectIds: [3],
  });
  const handler = captureRoutes(fixture.sql).get(
    "POST /api/prospecting/learning/experiments/:experimentId/activate"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { experimentId },
      body: {
        definitionHash: fixture.definitionHash,
        confirmation:
          PROSPECT_MESSAGE_EXPERIMENT_ACTIVATION_CONFIRMATION,
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
    "PROSPECT_MESSAGE_EXPERIMENT_COHORT_ELIGIBILITY_DRIFT"
  );
  assert.equal(
    fixture.queries.some(query =>
      query.text.includes("UPDATE prospect_message_experiments")
    ),
    false
  );
});

test("experiment activation rejects an overlapping active frozen cohort", async () => {
  const reservedDefinition = buildProspectMessageExperimentDefinition({
    experimentId: "66666666-6666-4666-8666-666666666666",
    workspaceId: 7,
    campaignId: 2,
    channel: "call",
    controlVariantKey: "manual-owner-call-v1",
    challengerVariantKey: "manual-direct-question-v1",
    preparedAt: "2026-07-29T15:00:00.000Z",
    eligibleProspectIds: [
      3,
      ...Array.from({ length: 19 }, (_, index) => index + 100),
    ],
    cohortSize: 20,
  });
  const fixture = makeExperimentLifecycleSql({
    state: "PREPARED",
    activeReservations: [
      {
        id: 80,
        experiment_id: reservedDefinition.experimentId,
        workspace_id: reservedDefinition.workspaceId,
        campaign_id: reservedDefinition.campaignId,
        channel: reservedDefinition.channel,
        state: "ACTIVE",
        control_variant_key: reservedDefinition.controlVariantKey,
        challenger_variant_key:
          reservedDefinition.challengerVariantKey,
        allocation_basis_points:
          reservedDefinition.allocationBasisPoints,
        definition: reservedDefinition,
        definition_hash:
          hashProspectMessageExperimentDefinition(
            reservedDefinition
          ),
      },
    ],
  });
  const handler = captureRoutes(fixture.sql).get(
    "POST /api/prospecting/learning/experiments/:experimentId/activate"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { experimentId },
      body: {
        definitionHash: fixture.definitionHash,
        confirmation:
          PROSPECT_MESSAGE_EXPERIMENT_ACTIVATION_CONFIRMATION,
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

  assert.equal(state.statusCode, 409, JSON.stringify(state.body));
  assert.equal(
    state.body.code,
    "PROSPECT_MESSAGE_EXPERIMENT_COHORT_RESERVATION_CONFLICT"
  );
  assert.equal(
    fixture.queries.some(query =>
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
  const campaignLockIndex = first.queries.findIndex(
    query =>
      query.text.includes("FROM prospecting_campaigns") &&
      query.text.includes("FOR UPDATE")
  );
  const reservationReadIndex = first.queries.findIndex(query =>
    query.text.includes("ORDER BY activated_at ASC")
  );
  assert.ok(campaignLockIndex >= 0);
  assert.ok(reservationReadIndex > campaignLockIndex);

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

test("frozen-cohort feeder rejects malformed authority before storage access", async () => {
  const fixture = makeExperimentLifecycleSql({ state: "ACTIVE" });
  const handler = captureRoutes(fixture.sql).get(
    "POST /api/prospecting/learning/experiments/:experimentId/prepare-drafts"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { experimentId },
      body: {
        channel: "email",
        definitionHash: fixture.definitionHash,
        confirmation: "send-the-entire-cohort",
        emailCompliance: {
          senderIdentity: "SMIRK",
          advertisementDisclosure:
            "This is a commercial message from SMIRK.",
          physicalPostalAddress:
            "1605 McKinley Drive, Reno, NV 89509",
          optOutInstructions:
            "Reply no and SMIRK will not follow up.",
        },
        attestations: {
          frozenCohortReviewed: true,
          recipientApprovalStillRequired: true,
          noContactOrSpendAuthorized: true,
        },
      },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );

  assert.equal(state.statusCode, 400);
  assert.equal(
    state.body.code,
    "PROSPECT_MESSAGE_EXPERIMENT_DRAFTS_INVALID"
  );
  assert.equal(fixture.queries.length, 0);
});

test("frozen-cohort feeder binds preparation to the immutable active definition", async () => {
  const fixture = makeExperimentLifecycleSql({ state: "ACTIVE" });
  const handler = captureRoutes(fixture.sql).get(
    "POST /api/prospecting/learning/experiments/:experimentId/prepare-drafts"
  );
  assert.ok(handler);
  const { response, state } = makeResponse();

  await handler(
    {
      params: { experimentId },
      body: {
        channel: "email",
        definitionHash: "f".repeat(64),
        confirmation:
          PROSPECT_MESSAGE_EXPERIMENT_PREPARE_DRAFTS_CONFIRMATION,
        emailCompliance: {
          senderIdentity: "SMIRK",
          advertisementDisclosure:
            "This is a commercial message from SMIRK.",
          physicalPostalAddress:
            "1605 McKinley Drive, Reno, NV 89509",
          optOutInstructions:
            "Reply no and SMIRK will not follow up.",
        },
        attestations: {
          frozenCohortReviewed: true,
          recipientApprovalStillRequired: true,
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
    fixture.queries.some(query =>
      query.text.includes("INSERT INTO prospect_outreach_jobs")
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

test("experiment closure requires a measured outcome for every sent job", async () => {
  const fixture = makeExperimentLifecycleSql({
    state: "ACTIVE",
    sentWithoutOutcomeJobs: 1,
  });
  const handler = captureRoutes(
    fixture.sql,
    () => new Date("2026-08-10T17:00:00.000Z")
  ).get(
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
    "PROSPECT_MESSAGE_EXPERIMENT_OUTCOMES_INCOMPLETE"
  );
  assert.equal(
    fixture.queries.some(query =>
      query.text.includes("UPDATE prospect_message_experiments")
    ),
    false
  );
});

test("experiment closure enforces the channel outcome observation window", async () => {
  const fixture = makeExperimentLifecycleSql({
    state: "ACTIVE",
    latestSentAt: "2026-07-30T17:00:00.000Z",
    observedAt: "2026-07-31T17:00:00.000Z",
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
    "PROSPECT_MESSAGE_EXPERIMENT_OBSERVATION_WINDOW_OPEN"
  );
  assert.match(state.body.error, /2026-08-06T17:00:00.000Z/);
});

test("experiment closure records the enforced observation-window evidence", async () => {
  const fixture = makeExperimentLifecycleSql({
    state: "ACTIVE",
    latestSentAt: "2026-07-30T17:00:00.000Z",
    observedAt: "2026-08-06T17:00:00.000Z",
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

  assert.equal(state.statusCode, 200, JSON.stringify(state.body));
  assert.equal(state.body.state, "CLOSED");
  assert.deepEqual(state.body.observationWindow, {
    channel: "email",
    hours: 168,
    sentJobCount: 20,
    measuredSentJobCount: 20,
    latestSentAt: "2026-07-30T17:00:00.000Z",
    endsAt: "2026-08-06T17:00:00.000Z",
    observedAt: "2026-08-06T17:00:00.000Z",
  });
  const audit = fixture.queries.find(query =>
    query.text.includes("INSERT INTO prospect_message_experiment_events")
  );
  assert.ok(audit);
  assert.equal(
    audit.values.some((value: any) =>
      value?.observationWindow?.endsAt ===
        "2026-08-06T17:00:00.000Z"
    ),
    true
  );
});

test("experiment closure refuses a partially enrolled frozen cohort", async () => {
  const fixture = makeExperimentLifecycleSql({
    state: "ACTIVE",
    enrolledProspectIds: [3],
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
    "PROSPECT_MESSAGE_EXPERIMENT_FROZEN_COHORT_INCOMPLETE"
  );
  assert.equal(
    fixture.queries.some(query =>
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
    if (text.includes("pg_advisory_xact_lock")) {
      return [{ pg_advisory_xact_lock: null }];
    }
    if (text.includes("FROM prospect_positive_outcome_reviews")) {
      return [{ pending_count: 0 }];
    }
    if (
      text.includes("SELECT id, lead_id, state, channel, payload")
    ) {
      return job ? [job] : [];
    }
    if (text.includes("FROM prospect_qc_model_reviews")) {
      return [];
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
  now?: Date;
}) {
  const { sql, queries } = makeApprovalSql(options.job);
  const routes = captureRoutes(
    sql,
    () => options.now || new Date()
  );
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
    if (text.includes("pg_advisory_xact_lock")) {
      return [{ pg_advisory_xact_lock: null }];
    }
    if (text.includes("FROM prospect_positive_outcome_reviews")) {
      return [{ pending_count: 0 }];
    }
    if (
      text.includes(
        "SELECT j.id, j.lead_id, j.state, j.channel, j.recipient"
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

function recipientTimezoneFor(date: Date): string {
  const offsetHours = 12 - date.getUTCHours();
  if (offsetHours === 0) return "Etc/UTC";
  return offsetHours > 0
    ? `Etc/GMT-${offsetHours}`
    : `Etc/GMT+${Math.abs(offsetHours)}`;
}

function callComplianceEvidence(
  checkedAt: string,
  recipientTimezone: string
): ProspectCallComplianceEvidence {
  return {
    checkedAt,
    recipientTimezone,
    dncChecks: [
      {
        scope: "federal",
        status: "clear",
        source: "Synthetic federal registry fixture",
        reference: "federal-fixture-reference",
      },
      {
        scope: "state",
        status: "clear",
        source: "Synthetic state registry fixture",
        reference: "state-fixture-reference",
      },
      {
        scope: "internal",
        status: "clear",
        source: "Synthetic SMIRK suppression fixture",
        reference: "internal-fixture-reference",
      },
    ],
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

test("call approval stores a fresh hash-bound three-scope compliance receipt", async () => {
  const approvedAt = new Date();
  const checkedAt = new Date(
    approvedAt.getTime() - 60_000
  ).toISOString();
  const expiresAt = new Date(
    approvedAt.getTime() + 60 * 60_000
  ).toISOString();
  const evidence = callComplianceEvidence(
    checkedAt,
    recipientTimezoneFor(approvedAt)
  );
  const result = await invokeApproval({
    now: approvedAt,
    job: {
      id: 9,
      lead_id: 3,
      state: "PREPARED",
      channel: "call",
      payload: callApprovalPayload,
      payload_hash: callPayloadHash,
      expires_at: expiresAt,
    },
    body: {
      payloadHash: callPayloadHash,
      attestations: {
        recipientReviewed: true,
        suppressionChecked: true,
        doNotCallChecked: true,
        callingWindowChecked: true,
        manualDialOnly: true,
        callCompliance: evidence,
      },
    },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.outcome, "approved");
  assert.match(
    result.body.callComplianceReceiptHash,
    /^[a-f0-9]{64}$/
  );
  const update = result.queries.find(query =>
    query.text.includes("UPDATE prospect_outreach_jobs")
  );
  const stored = update?.values.find(
    (value: any) => value?.callComplianceReceipt
  ) as any;
  assert.equal(
    stored.callComplianceReceipt.contactAuthorizedByReceipt,
    false
  );
  assert.equal(
    stored.callComplianceReceipt.automatedDialingAuthorized,
    false
  );
  assert.equal(stored.callComplianceReceipt.dncChecks.length, 3);
});

test("replayed approval is idempotent and does not append another event", async () => {
  const result = await invokeApproval({
    job: preparedEmailJob({ state: "APPROVED" }),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.outcome, "duplicate");
  assert.equal(result.body.state, "APPROVED");
  assert.equal(
    result.queries.filter((query) =>
      query.text.includes("pg_advisory_xact_lock")
    ).length,
    1
  );
  assert.equal(
    result.queries.filter((query) =>
      query.text.includes("FROM prospect_positive_outcome_reviews")
    ).length,
    1
  );
  assert.equal(
    result.queries.some((query) =>
      query.text.includes("UPDATE prospect_outreach_jobs")
    ),
    false
  );
  assert.equal(
    result.queries.some((query) =>
      query.text.includes("INSERT INTO prospect_outreach_events")
    ),
    false
  );
});

test("records a manually completed action only inside the approved window", async () => {
  const now = Date.now();
  const occurredAt = new Date(now).toISOString();
  const approvedAt = new Date(now - 60_000).toISOString();
  const expiresAt = new Date(now + 60 * 60_000).toISOString();
  const callCompliance = callComplianceEvidence(
    new Date(now - 2 * 60_000).toISOString(),
    recipientTimezoneFor(new Date(now))
  );
  const compliance = buildProspectCallComplianceReceipt({
    workspaceId: 7,
    approvalId,
    outreachJobId: 9,
    leadId: 3,
    recipient: "+17755550142",
    evidence: callCompliance,
    actor: "dashboard_operator",
    approvedAt,
    jobExpiresAt: expiresAt,
  });
  const proofReference = "manual:phone-log-reference";
  const result = await invokeExecution({
    job: {
      id: 9,
      lead_id: 3,
      state: "APPROVED",
      channel: "call",
      recipient: "+17755550142",
      payload: callApprovalPayload,
      payload_hash: callPayloadHash,
      qc_model_review_id: null,
      qc_model_review_receipt_hash: null,
      approved_by: "dashboard_operator",
      approved_at: approvedAt,
      approval_attestations: {
        recipientReviewed: true,
        suppressionChecked: true,
        doNotCallChecked: true,
        callingWindowChecked: true,
        manualDialOnly: true,
        callCompliance,
        callComplianceReceipt: compliance.receipt,
        callComplianceReceiptHash: compliance.receiptHash,
      },
      expires_at: expiresAt,
      sent_at: null,
      execution_proof_reference: null,
      current_phone: "+17755550142",
      current_phone_contact_mode: "operator_review_only",
      current_lead_status: "pending",
      current_review_state: "qualified",
    },
    body: {
      payloadHash: callPayloadHash,
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
  cohortSize?: number;
  executedPerArm?: number;
  perArm?: number;
  controlPositive?: number;
  challengerPositive?: number;
  executedProtocolDeviation?: boolean;
}) {
  const cohortSize = input?.cohortSize ?? 20;
  const eligibleProspectIds = [
    3,
    ...Array.from(
      { length: Math.max(19, cohortSize - 1) },
      (_, index) => index + 100
    ),
  ];
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
    eligibleProspectIds,
    cohortSize,
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
  const assignedPerArm = cohortSize / 2;
  const executedPerArm = input?.executedPerArm ?? assignedPerArm;
  const perArm = input?.perArm ?? executedPerArm;
  const selected = {
    control: definition.cohort
      .filter(entry => entry.arm === "control")
      .map(entry => entry.prospectId),
    challenger: definition.cohort
      .filter(entry => entry.arm === "challenger")
      .map(entry => entry.prospectId),
  };
  assert.equal(selected.control.length, assignedPerArm);
  assert.equal(selected.challenger.length, assignedPerArm);

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
      const executed = index < executedPerArm;
      const measured = executed && index < perArm;
      const positive =
        measured &&
        (arm === "control"
          ? index < (input?.controlPositive ?? 1)
          : index < (input?.challengerPositive ?? 6));
      return {
        outreach_job_id: prospectId + 1_000,
        campaign_id: 2,
        lead_id: prospectId,
        channel: "email",
        state: executed ? "SENT" : "CANCELLED",
        variant_key: actualVariantKey,
        payload,
        payload_hash: hashProspectOutreachPayload(payload),
        outcome: measured
          ? positive
            ? "replied"
            : "delivered"
          : null,
        occurred_at: measured
          ? new Date(
              Date.UTC(
                2026,
                6,
                arm === "control" ? 30 : 31,
                9,
                index
              )
            ).toISOString()
          : null,
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
        studyDesign: "deterministic-eligible-cohort-v1",
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
          positive: 1,
          positiveRate: 0.1,
        },
        challenger: {
          channel: fixture.definition.channel,
          variantKey: fixture.definition.challengerVariantKey,
          sampleSize: 10,
          positive: 6,
          positiveRate: 0.6,
        },
        studyDesign: "deterministic-eligible-cohort-v1",
        experimentId: fixture.definition.experimentId,
        experimentDefinitionHash: fixture.definitionHash,
        registryVersion: PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION,
        executedProtocolDeviationCount: 0,
        absoluteLift: 0.5,
        statisticalTest: "fisher-exact-one-sided-v1",
        oneSidedFisherPValue: 0.028638,
        maximumOneSidedFisherPValue: 0.05,
        armStats: {
          control: {
            assigned: 10,
            executed: 10,
            measured: 10,
            outcomeEvents: 10,
          },
          challenger: {
            assigned: 10,
            executed: 10,
            measured: 10,
            outcomeEvents: 10,
          },
        },
        assignedProspects: 20,
        executedProspects: 20,
        measuredProspects: 20,
        outcomeEventCount: 20,
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
    if (text.includes("pg_advisory_xact_lock")) {
      return [{ pg_advisory_xact_lock: null }];
    }
    if (text.includes("FROM prospect_positive_outcome_reviews")) {
      return [{ pending_count: 0 }];
    }
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
  const decisionFixture = makeEligibleCandidateDecisionFixture();
  const candidate = {
    id: 44,
    candidate_key: `experiment:${experimentId}`,
    state: "APPROVED",
    recommendation_eligible: true,
    proposal: decisionFixture.candidate.proposal,
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
  assert.equal(state.body.candidates.length, 1);
  assert.deepEqual(
    {
      ...state.body.candidates[0],
      proposal_hash: undefined,
    },
    {
      ...candidate,
      proposal_hash: undefined,
    }
  );
  assert.match(
    state.body.candidates[0].proposal_hash,
    /^[a-f0-9]{64}$/
  );
  assert.equal(state.body.policyChanged, false);
  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /recommendation_eligible/);
  assert.match(
    queries[0].text,
    /LEFT JOIN prospect_message_experiments/
  );
  assert.match(queries[0].text, /assignedProspects/);
  assert.match(queries[0].text, /executedProspects/);
  assert.match(queries[0].text, /measuredProspects/);
  assert.match(queries[0].text, /jsonb_array_length/);
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

test("message-policy mutations reject partial authority before storage access", async () => {
  let storageAccesses = 0;
  const sql: any = async () => {
    storageAccesses += 1;
    return [];
  };
  sql.begin = async (callback: (tx: any) => unknown) => {
    storageAccesses += 1;
    return callback(sql);
  };
  sql.json = (value: unknown) => value;
  const routes = captureRoutes(sql);
  const applyHandler = routes.get(
    "POST /api/prospecting/learning/candidates/:id/apply-policy"
  );
  const rollbackHandler = routes.get(
    "POST /api/prospecting/learning/policies/:releaseId/rollback"
  );
  assert.ok(applyHandler);
  assert.ok(rollbackHandler);

  const applyResponse = makeResponse();
  await applyHandler(
    {
      params: { id: "44" },
      body: {
        proposalHash: "a".repeat(64),
        confirmation: "approve",
        attestations: {
          approvedCandidateReviewed: true,
          measuredEvidenceReviewed: true,
          futureExperimentsOnly: true,
          noContactOrSpendAuthorized: true,
        },
      },
      authMode: "operator",
    } as unknown as Request,
    applyResponse.response,
    () => undefined
  );
  assert.equal(applyResponse.state.statusCode, 400);
  assert.equal(
    applyResponse.state.body.code,
    "PROSPECT_MESSAGE_POLICY_APPLICATION_INVALID"
  );

  const rollbackResponse = makeResponse();
  await rollbackHandler(
    {
      params: {
        releaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      body: {
        releaseHash: "b".repeat(64),
        reason: "Restore prior control.",
        confirmation: "rollback",
        attestations: {
          currentPolicyReviewed: true,
          rollbackTargetReviewed: true,
          futureExperimentsOnly: true,
          noContactOrSpendAuthorized: true,
        },
      },
      authMode: "operator",
    } as unknown as Request,
    rollbackResponse.response,
    () => undefined
  );
  assert.equal(rollbackResponse.state.statusCode, 400);
  assert.equal(
    rollbackResponse.state.body.code,
    "PROSPECT_MESSAGE_POLICY_ROLLBACK_INVALID"
  );
  assert.equal(storageAccesses, 0);
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
        value?.studyDesign ===
          "deterministic-eligible-cohort-v1" &&
        value?.runtimePolicyChange === false
    ),
    true
  );
  assert.equal(
    insert.values.some(
      (value: any) =>
        value?.experimentId === experimentId &&
        value?.studyDesign ===
          "deterministic-eligible-cohort-v1" &&
        value?.executedProtocolDeviationCount === 0 &&
        value?.statisticalTest ===
          "fisher-exact-one-sided-v1" &&
        value?.oneSidedFisherPValue === 0.028638 &&
        value?.maximumOneSidedFisherPValue === 0.05 &&
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

test("refuses a closed experiment with unmeasured assigned prospects", async () => {
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
  assert.equal(state.body.code, "PROSPECT_LEARNING_COHORT_ATTRITION");
  assert.equal(
    queries.some((query) =>
      query.text.includes("INSERT INTO prospect_learning_candidates")
    ),
    false
  );
});

test("refuses a closed experiment with lift but insufficient exact confidence", async () => {
  const fixture = makeExperimentFixture({
    controlPositive: 1,
    challengerPositive: 2,
  });
  const { sql, queries } = makeLearningSql({
    experiment: fixture.experiment,
    cohortRows: fixture.cohortRows,
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

  assert.equal(state.statusCode, 409);
  assert.equal(
    state.body.code,
    "PROSPECT_LEARNING_INSUFFICIENT_CONFIDENCE"
  );
  assert.equal(
    queries.some(query =>
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

test("assigned cohort attrition cannot produce a learning candidate", async () => {
  const fixture = makeExperimentFixture({
    cohortSize: 40,
    executedPerArm: 10,
    perArm: 10,
  });
  const { sql, queries } = makeLearningSql({
    experiment: fixture.experiment,
    cohortRows: fixture.cohortRows,
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

  assert.equal(state.statusCode, 409);
  assert.equal(state.body.code, "PROSPECT_LEARNING_COHORT_ATTRITION");
  assert.equal(
    queries.some(query =>
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
  assert.match(
    state.body.note,
    /next-experiment control remains unchanged/
  );
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

test("learning approval recomputes and rejects tampered confidence evidence", async () => {
  const fixture = makeEligibleCandidateDecisionFixture();
  const tamperedCandidate = {
    ...fixture.candidate,
    evidence: {
      ...fixture.candidate.evidence,
      oneSidedFisherPValue: 0.01,
    },
  };
  const { sql, queries } = makeLearningSql({
    decisionCandidate: tamperedCandidate,
    experiment: fixture.experiment,
  });
  const handler = captureRoutes(sql).get(
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
    queries.some(query =>
      query.text.includes("UPDATE prospect_learning_candidates")
    ),
    false
  );
});

test("learning approval rejects incomplete assigned-cohort coverage", async () => {
  const fixture = makeEligibleCandidateDecisionFixture();
  const incompleteCandidate = {
    ...fixture.candidate,
    evidence: {
      ...fixture.candidate.evidence,
      executedProspects: 19,
      measuredProspects: 19,
      armStats: {
        ...fixture.candidate.evidence.armStats,
        challenger: {
          ...fixture.candidate.evidence.armStats.challenger,
          executed: 9,
          measured: 9,
          outcomeEvents: 9,
        },
      },
    },
    sample_size: 19,
  };
  const { sql, queries } = makeLearningSql({
    decisionCandidate: incompleteCandidate,
    experiment: fixture.experiment,
  });
  const handler = captureRoutes(sql).get(
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
    queries.some(query =>
      query.text.includes("UPDATE prospect_learning_candidates")
    ),
    false
  );
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
