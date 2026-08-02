import assert from "node:assert/strict";
import test from "node:test";
import type { Request, RequestHandler, Response } from "express";
import { Webhook } from "standardwebhooks";
import { registerProspectOutreachRoutes } from "../src/routes/prospect-outreach-routes.ts";

const webhookSecret = `whsec_${Buffer.from(
  "smirk-synthetic-webhook-secret-0001"
).toString("base64")}`;

function webhookEnv() {
  return {
    PROSPECT_EMAIL_WEBHOOK_ENABLED: "true",
    PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET: webhookSecret,
    PROSPECT_EMAIL_WORKSPACE_ID: "7",
    PROSPECT_EMAIL_FROM: "SMIRK <outreach@smirkcalls.com>",
    PROSPECT_EMAIL_REPLY_TO: "reply@smirkcalls.com",
    PROSPECT_EMAIL_RECEIVING_ENABLED: "true",
    PROSPECT_EMAIL_RECEIVING_MODE: "operator-reviewed-content-v1",
    PROSPECT_EMAIL_RESEND_RECEIVING_API_KEY:
      "re_synthetic_receiving_1234567890",
    PROSPECT_EMAIL_RECEIVING_WORKSPACE_ID: "7",
  };
}

function deliveredEvent() {
  return {
    type: "email.delivered",
    created_at: new Date().toISOString(),
    data: {
      created_at: new Date().toISOString(),
      email_id: "email_synthetic_0001",
      from: "SMIRK <outreach@smirkcalls.com>",
      to: ["owner@example.com"],
      subject: "Synthetic subject",
    },
  };
}

function receivedEvent() {
  return {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "email_inbound_synthetic_0001",
      created_at: new Date().toISOString(),
      from: "Owner <owner@example.com>",
      to: ["reply@smirkcalls.com"],
      bcc: [],
      cc: [],
      received_for: ["reply@smirkcalls.com"],
      message_id: "message_synthetic_0001",
      subject: "Re: Synthetic subject",
      attachments: [],
    },
  };
}

function signEvent(eventId: string, event: Record<string, unknown>) {
  const rawBody = Buffer.from(JSON.stringify(event));
  const timestamp = new Date();
  return {
    rawBody,
    headers: {
      "svix-id": eventId,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1_000)),
      "svix-signature": new Webhook(webhookSecret).sign(
        eventId,
        timestamp,
        rawBody
      ),
    },
  };
}

function defaultJob() {
  return {
    id: 9,
    lead_id: 23,
    approval_id: "11111111-1111-4111-8111-111111111111",
    recipient: "owner@example.com",
    state: "SENT",
    channel: "email",
    evidence_hash: "a".repeat(64),
    payload_hash: "b".repeat(64),
    is_seed: false,
    business_name: "Synthetic Plumbing",
    sent_at: "2026-08-01T18:00:00.000Z",
  };
}

function makeWebhookSql(options: {
  job?: ReturnType<typeof defaultJob> | null;
  replyJobs?: Array<
    Pick<
      ReturnType<typeof defaultJob>,
      "id" | "lead_id" | "approval_id" | "is_seed"
    > & {
      business_name?: string;
      sent_at?: string;
    }
  >;
  failOnReceiptInsert?: boolean;
  failOnSuppressionInsert?: boolean;
  failOnContentUpdate?: boolean;
  failOnResolutionUpdate?: boolean;
} = {}) {
  const state = {
    receipt: null as null | {
      id: number;
      workspace_id: number;
      provider_event_id: string;
      provider_message_id: string | null;
      event_type: string;
      payload_hash: string;
      process_status: string;
      details: Record<string, unknown>;
      outreach_job_id: number | null;
      received_at: string;
      processed_at: string | null;
    },
    outcomes: [] as Array<{
      outcome: string;
      externalEventId: string;
      occurredAt: string;
    }>,
    suppressions: [] as string[],
    outboxWrites: 0,
    positiveReviewWrites: 0,
    positiveReviewAuditEvents: 0,
    leadUpdates: 0,
    providerReads: 0,
    queries: [] as Array<{ text: string; values: unknown[] }>,
  };
  const job =
    options.job === undefined ? defaultJob() : options.job;
  const sql: any = (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    if (text === "FOR UPDATE" || text === "") return text;
    state.queries.push({ text, values });
    if (text.includes("pg_advisory_xact_lock")) {
      return [{ pg_advisory_xact_lock: null }];
    }

    if (text.includes("INSERT INTO prospect_email_provider_events")) {
      if (options.failOnReceiptInsert) {
        throw new Error("synthetic database failure");
      }
      if (state.receipt) return [];
      const eventType = String(
        values.find(
          (value) =>
            typeof value === "string" &&
            (value.startsWith("email.") ||
              value.startsWith("suppression."))
        )
      );
      const payloadHash = String(
        values.find(
          (value) =>
            typeof value === "string" &&
            /^[a-f0-9]{64}$/.test(value)
        )
      );
      state.receipt = {
        id: 71,
        workspace_id: 7,
        provider_event_id: String(
          values.find(
            (value) =>
              typeof value === "string" &&
              value.startsWith("evt_")
          )
        ),
        provider_message_id:
          (values.find(
            (value) =>
              typeof value === "string" &&
              value.startsWith("email_")
          ) as string | undefined) || null,
        event_type: eventType,
        payload_hash: payloadHash,
        process_status: "RECEIVED",
        details: {},
        outreach_job_id: null,
        received_at: new Date().toISOString(),
        processed_at: null,
      };
      return [{ id: 71 }];
    }
    if (
      text.includes("FROM prospect_email_provider_events") &&
      text.includes("LIMIT 1 FOR UPDATE") &&
      !text.includes("JOIN prospect_outreach_jobs")
    ) {
      if (text.includes("details->'replyReview'")) {
        const reviewId = (state.receipt?.details.replyReview as any)
          ?.reviewId;
        if (!values.includes(7) || !values.includes(reviewId)) return [];
      }
      return state.receipt ? [state.receipt] : [];
    }
    if (
      text.includes("FROM prospect_email_provider_events e") &&
      text.includes("e.details ? 'replyReview'") &&
      text.includes("ORDER BY")
    ) {
      return state.receipt && values.includes(7)
        ? [state.receipt]
        : [];
    }
    if (
      text.includes("FROM prospect_email_provider_events e") &&
      text.includes("JOIN prospect_outreach_jobs j")
    ) {
      if (!state.receipt || !job || !values.includes(7)) return [];
      if (
        text.includes("FOR UPDATE") &&
        !values.includes(
          (state.receipt.details.replyReview as any)?.reviewId
        )
      ) {
        return [];
      }
      return [
        {
          ...state.receipt,
          approval_id: job.approval_id,
          lead_id: job.lead_id,
          recipient: job.recipient,
          state: job.state,
          channel: job.channel,
          is_seed: job.is_seed,
          business_name: "Synthetic Plumbing",
        },
      ];
    }
    if (
      text.includes("UPDATE prospect_email_provider_events") &&
      text.includes("SET details")
    ) {
      const details = values.find(
        (value) =>
          value &&
          typeof value === "object" &&
          Object.hasOwn(value, "replyContentReceipt")
      ) as Record<string, unknown> | undefined;
      if (options.failOnContentUpdate) return [];
      if (state.receipt && details) {
        state.receipt.details = details;
      }
      return details ? [{ id: 71 }] : [];
    }
    if (
      text.includes("UPDATE prospect_email_provider_events") &&
      text.includes("SET process_status")
    ) {
      const status = text.includes("process_status = 'PROCESSED'")
        ? "PROCESSED"
        : values.find((value) =>
            [
              "PROCESSED",
              "IGNORED",
              "RETRY",
              "REVIEW_REQUIRED",
            ].includes(String(value))
          );
      const details = values.find(
        (value) =>
          value &&
          typeof value === "object" &&
          Object.hasOwn(value, "action")
      ) as Record<string, unknown> | undefined;
      if (
        options.failOnResolutionUpdate &&
        details?.action === "inbound_reply_human_resolved"
      ) {
        return [];
      }
      if (state.receipt) {
        state.receipt.process_status = String(status);
        if (details) state.receipt.details = details;
        const candidateJobIds = (
          options.replyJobs || (job ? [job] : [])
        ).map(candidate => candidate.id);
        const jobId = values.find(
          value => candidateJobIds.includes(Number(value))
        );
        if (jobId) state.receipt.outreach_job_id = Number(jobId);
        if (status === "PROCESSED") {
          state.receipt.processed_at = new Date().toISOString();
        }
      }
      return [{ id: 71 }];
    }
    if (
      text.includes(
        "SELECT id, lead_id, approval_id, recipient, state"
      )
    ) {
      if (text.includes("AND approval_id")) {
        const candidates = options.replyJobs || (job ? [job] : []);
        const selectedIndex = candidates.findIndex(
          candidate =>
            values.includes(candidate.id) &&
            values.includes(candidate.approval_id)
        );
        const selected = candidates[selectedIndex];
        return selected
          ? [
              {
                ...selected,
                recipient: "owner@example.com",
                state: "SENT",
                channel: "email",
                sent_at:
                  selected.sent_at ||
                  new Date(
                    Date.parse("2026-08-01T18:00:00.000Z") -
                      selectedIndex * 60_000
                  ).toISOString(),
              },
            ]
          : [];
      }
      return job ? [job] : [];
    }
    if (
      text.includes("SELECT j.id, j.lead_id, j.approval_id") &&
      text.includes("ORDER BY j.sent_at DESC")
    ) {
      const replies = options.replyJobs || (job ? [job] : []);
      return replies.map((reply, index) => ({
        ...reply,
        business_name:
          reply.business_name || `Synthetic Plumbing ${index + 1}`,
        sent_at:
          reply.sent_at ||
          new Date(
            Date.parse("2026-08-01T18:00:00.000Z") -
              index * 60_000
          ).toISOString(),
      }));
    }
    if (text.includes("INSERT INTO prospect_email_suppressions")) {
      if (options.failOnSuppressionInsert) {
        throw new Error("synthetic suppression database failure");
      }
      const email = values.find(
        (value) =>
          typeof value === "string" && value.includes("@")
      );
      state.suppressions.push(String(email));
      return [{ id: 81 }];
    }
    if (
      text.includes("SELECT l.id, l.campaign_id") &&
      text.includes("FROM prospect_leads l")
    ) {
      return [
        {
          id: 23,
          campaign_id: 17,
          business_name: "Synthetic Plumbing",
          industry: "plumbing",
          email: "owner@example.com",
          email_verification: "verified_owner_email",
          phone: "+17755550142",
          phone_contact_mode: "operator_review_only",
          status: "pending",
          review_state: "qualified",
          research_evidence: [],
          external_id: "velvet-synthetic-prospect-0001",
          source: "velvet_alchemy_research",
        },
      ];
    }
    if (
      text.includes(
        "SELECT id, state, approval_id, channel, evidence_hash, payload_hash"
      )
    ) {
      return job ? [job] : [];
    }
    if (text.includes("INSERT INTO prospect_outcome_events")) {
      const outcome = String(
        values.find((value) =>
          [
            "delivered",
            "bounced",
            "replied",
            "dnc",
            "failed",
          ].includes(String(value))
        )
      );
      const externalEventId = String(
        values.find(
          (value) =>
            typeof value === "string" &&
            value.startsWith("resend:")
        )
      );
      state.outcomes.push({
        outcome,
        externalEventId,
        occurredAt: String(values[7]),
      });
      return [{ id: 91 }];
    }
    if (
      text.includes(
        "SELECT external_event_id, outcome, occurred_at"
      ) &&
      text.includes("FROM prospect_outcome_events")
    ) {
      return state.outcomes.map(outcome => ({
        external_event_id: outcome.externalEventId,
        outcome: outcome.outcome,
        occurred_at: outcome.occurredAt,
      }));
    }
    if (
      text.includes(
        "INSERT INTO prospect_positive_outcome_reviews"
      )
    ) {
      state.positiveReviewWrites += 1;
      return [{ id: 96 }];
    }
    if (
      text.includes(
        "INSERT INTO prospect_positive_outcome_review_events"
      )
    ) {
      state.positiveReviewAuditEvents += 1;
      return [{ id: 97 }];
    }
    if (
      text.includes("UPDATE prospect_leads") &&
      text.includes("SET status")
    ) {
      state.leadUpdates += 1;
      return [{ id: 23 }];
    }
    if (text.includes("INSERT INTO velvet_outcome_outbox")) {
      state.outboxWrites += 1;
      return [{ id: 101 }];
    }
    throw new Error(`Unexpected SQL in webhook route test: ${text}`);
  };
  sql.begin = async (callback: (tx: any) => unknown) => callback(sql);
  sql.json = (value: unknown) => value;
  sql.testState = state;
  return { sql, state };
}

function syntheticReceivingResponse(
  overrides: Record<string, unknown> = {}
) {
  return new Response(
    JSON.stringify({
      object: "email",
      id: "email_inbound_synthetic_0001",
      to: ["reply@smirkcalls.com"],
      from: "Owner <owner@example.com>",
      created_at: "2026-08-02T23:00:00.000Z",
      subject: "Re: Synthetic subject",
      bcc: null,
      cc: null,
      reply_to: null,
      received_for: ["reply@smirkcalls.com"],
      html: "<p>Ignored HTML.</p>",
      text: "Yes, this is a synthetic reply.",
      headers: { "x-test": "not-retained" },
      message_id: "message_synthetic_0001",
      attachments: [],
      ...overrides,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    }
  );
}

function captureRoutes(
  sql: any,
  workspaceId = 7,
  fetchImpl: typeof fetch = async () => {
    sql.testState.providerReads += 1;
    return syntheticReceivingResponse();
  }
) {
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
  registerProspectOutreachRoutes(app, {
    dashboardAuth: pass,
    requireOperator: pass,
    requireFullOperator: pass,
    sql,
    dbEnabled: true,
    getWorkspaceId: () => workspaceId,
    env: webhookEnv(),
    fetchImpl,
    now: () => new Date("2026-08-02T23:05:00.000Z"),
  });
  return routes;
}

function captureWebhookHandler(sql: any) {
  const routes = captureRoutes(sql);
  const handlers = routes.get(
    "POST /api/prospecting/resend/webhook"
  );
  assert.ok(handlers);
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

async function invokeWebhook(options: {
  sql: any;
  eventId: string;
  event: Record<string, unknown>;
  forgeSignature?: boolean;
}) {
  const signed = signEvent(options.eventId, options.event);
  if (options.forgeSignature) {
    signed.headers["svix-signature"] = "v1,forged-signature";
  }
  const { response, state } = makeResponse();
  await captureWebhookHandler(options.sql)(
    {
      body: signed.rawBody,
      headers: signed.headers,
    } as unknown as Request,
    response,
    () => undefined
  );
  return state;
}

function inboundReplyResolutionBody(
  setup: ReturnType<typeof makeWebhookSql>,
  resolution: "reply" | "opt_out" | "not_actionable" = "reply"
) {
  const payloadHash = String(
    setup.state.receipt?.details.replyReviewPayloadHash || ""
  );
  return {
    payloadHash,
    contentReceiptHash: String(
      setup.state.receipt?.details.replyContentReceiptHash || ""
    ),
    confirmation: "resolve-one-inbound-reply-v1",
    resolution,
    ...(resolution === "not_actionable"
      ? {}
      : {
          selectedOutreachApprovalId: String(
            (
              setup.state.receipt?.details.replyReview as any
            )?.candidates?.[0]?.outreachApprovalId || ""
          ),
        }),
    notes: `Reviewed synthetic ${resolution} message.`,
    attestations: {
      messageContentReviewed: true,
      senderIdentityMatched: true,
      ...(resolution === "opt_out"
        ? { recipientOptOutVerified: true }
        : {}),
      noContactExecutedByResolution: true,
      followUpRemainsSeparate: true,
    },
  } as const;
}

function inboundReplyContentBody(
  setup: ReturnType<typeof makeWebhookSql>
) {
  return {
    payloadHash: String(
      setup.state.receipt?.details.replyReviewPayloadHash || ""
    ),
    confirmation: "retrieve-one-inbound-email-content-v1",
    attestations: {
      noContactAuthorized: true,
      noSendAuthorized: true,
      attachmentsNotRequested: true,
      htmlWillNotBeStored: true,
    },
  } as const;
}

async function invokeInboundReplyContent(options: {
  setup: ReturnType<typeof makeWebhookSql>;
  body?: Record<string, unknown>;
  workspaceId?: number;
  fetchImpl?: typeof fetch;
}) {
  const reviewId = String(
    (options.setup.state.receipt?.details.replyReview as any)
      ?.reviewId || ""
  );
  const handlers = captureRoutes(
    options.setup.sql,
    options.workspaceId || 7,
    options.fetchImpl
  ).get(
    "POST /api/prospecting/email-replies/:reviewId/content"
  );
  assert.ok(handlers);
  const { response, state } = makeResponse();
  await handlers.at(-1)!(
    {
      params: { reviewId },
      body: options.body || inboundReplyContentBody(options.setup),
      headers: { "x-api-key": "synthetic-full-operator-key" },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );
  return state;
}

async function invokeInboundReplyResolution(options: {
  setup: ReturnType<typeof makeWebhookSql>;
  body: Record<string, unknown>;
  workspaceId?: number;
  retrieveContent?: boolean;
}) {
  if (
    options.retrieveContent !== false &&
    !options.setup.state.receipt?.details.replyContentReceiptHash
  ) {
    const retrieved = await invokeInboundReplyContent({
      setup: options.setup,
    });
    assert.equal(retrieved.statusCode, 201);
  }
  const reviewId = String(
    (options.setup.state.receipt?.details.replyReview as any)
      ?.reviewId || ""
  );
  const handlers = captureRoutes(
    options.setup.sql,
    options.workspaceId || 7
  ).get(
    "POST /api/prospecting/email-replies/:reviewId/resolve"
  );
  assert.ok(handlers);
  const { response, state } = makeResponse();
  await handlers.at(-1)!(
    {
      params: { reviewId },
      body: {
        ...options.body,
        ...(options.retrieveContent === false
          ? {}
          : {
              contentReceiptHash: String(
                options.setup.state.receipt?.details
                  .replyContentReceiptHash || ""
              ),
            }),
      },
      headers: { "x-api-key": "synthetic-full-operator-key" },
      authMode: "operator",
    } as unknown as Request,
    response,
    () => undefined
  );
  return state;
}

test("forged webhook requests fail before any storage access", async () => {
  const setup = makeWebhookSql();
  const result = await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_forged_webhook_0001",
    event: deliveredEvent(),
    forgeSignature: true,
  });
  assert.equal(result.statusCode, 401);
  assert.equal(
    result.body.code,
    "PROSPECT_EMAIL_WEBHOOK_SIGNATURE_INVALID"
  );
  assert.equal(setup.state.queries.length, 0);
});

test("one signed delivery writes one outcome and one Velvet callback", async () => {
  const setup = makeWebhookSql();
  const result = await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_delivery_webhook_0001",
    event: deliveredEvent(),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, "PROCESSED");
  assert.equal(setup.state.outcomes.length, 1);
  assert.equal(setup.state.outcomes[0].outcome, "delivered");
  assert.equal(setup.state.leadUpdates, 1);
  assert.equal(setup.state.outboxWrites, 1);
  assert.equal(setup.state.receipt?.process_status, "PROCESSED");
});

test("one signed reply creates one fail-closed human review item", async () => {
  const setup = makeWebhookSql();
  const result = await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_reply_webhook_0001",
    event: receivedEvent(),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, "REVIEW_REQUIRED");
  assert.equal(result.body.outcome, "review_required");
  assert.match(result.body.reviewId, /^[0-9a-f-]{36}$/);
  assert.equal(result.body.positiveOutcomeRecorded, false);
  assert.equal(result.body.suppressionRecorded, false);
  assert.equal(setup.state.receipt?.process_status, "REVIEW_REQUIRED");
  assert.equal(
    setup.state.receipt?.details.action,
    "inbound_reply_queued_for_human_classification"
  );
  assert.equal(setup.state.outcomes.length, 0);
  assert.equal(setup.state.positiveReviewWrites, 0);
  assert.equal(setup.state.positiveReviewAuditEvents, 0);
  assert.equal(setup.state.outboxWrites, 0);
});

test("pending inbound reply reviews are workspace-scoped and immutable", async () => {
  const setup = makeWebhookSql();
  await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_reply_list_0001",
    event: receivedEvent(),
  });
  const handlers = captureRoutes(setup.sql).get(
    "GET /api/prospecting/email-replies"
  );
  assert.ok(handlers);
  const { response, state } = makeResponse();
  await handlers.at(-1)!(
    { query: { state: "pending" } } as unknown as Request,
    response,
    () => undefined
  );
  assert.equal(state.statusCode, 200);
  assert.equal(state.body.reviews.length, 1);
  assert.equal(state.body.reviews[0].state, "PENDING");
  assert.equal(
    state.body.reviews[0].payload.sender,
    "owner@example.com"
  );
  assert.equal(
    state.body.controls.exactProviderContentRequiredBeforeClassification,
    true
  );
  assert.equal(state.body.reviews[0].contentReceipt, null);
  assert.equal(state.body.controls.contactAuthorized, false);
  assert.equal(state.body.externalAction, "none");
});

test("exact inbound plain text is retrieved once and stored as an immutable receipt", async () => {
  const setup = makeWebhookSql();
  await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_reply_content_0001",
    event: receivedEvent(),
  });
  const first = await invokeInboundReplyContent({ setup });
  assert.equal(first.statusCode, 201);
  assert.equal(first.body.outcome, "retrieved");
  assert.equal(
    first.body.externalAction,
    "resend_received_email_read"
  );
  assert.equal(first.body.receipt.contactAuthorized, false);
  assert.equal(first.body.receipt.sendAuthorized, false);
  assert.equal(first.body.receipt.htmlStored, false);
  assert.equal(first.body.receipt.attachmentsFetched, false);
  assert.equal(
    first.body.receipt.plainText,
    "Yes, this is a synthetic reply."
  );
  assert.match(first.body.receiptHash, /^[a-f0-9]{64}$/);
  assert.equal(setup.state.providerReads, 1);
  assert.equal(
    JSON.stringify(setup.state.receipt?.details).includes(
      "Ignored HTML"
    ),
    false
  );
  assert.equal(
    JSON.stringify(setup.state.receipt?.details).includes(
      "not-retained"
    ),
    false
  );

  const replay = await invokeInboundReplyContent({ setup });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.outcome, "duplicate");
  assert.equal(replay.body.receiptHash, first.body.receiptHash);
  assert.equal(replay.body.externalAction, "none");
  assert.equal(setup.state.providerReads, 1);
});

test("classification cannot run without an exact content receipt", async () => {
  const setup = makeWebhookSql();
  await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_reply_content_required_0001",
    event: receivedEvent(),
  });
  const result = await invokeInboundReplyResolution({
    setup,
    retrieveContent: false,
    body: {
      ...inboundReplyResolutionBody(setup, "reply"),
      contentReceiptHash: "f".repeat(64),
    },
  });
  assert.equal(result.statusCode, 409);
  assert.equal(
    result.body.code,
    "PROSPECT_INBOUND_REPLY_CONTENT_REQUIRED"
  );
  assert.equal(setup.state.providerReads, 0);
  assert.equal(setup.state.outcomes.length, 0);
});

test("forged content requests and provider binding drift fail before durable classification", async () => {
  const setup = makeWebhookSql();
  await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_reply_content_forged_0001",
    event: receivedEvent(),
  });
  const forged = await invokeInboundReplyContent({
    setup,
    body: {
      ...inboundReplyContentBody(setup),
      payloadHash: "f".repeat(64),
    },
  });
  assert.equal(forged.statusCode, 409);
  assert.equal(
    forged.body.code,
    "PROSPECT_INBOUND_REPLY_REVIEW_HASH_MISMATCH"
  );
  assert.equal(setup.state.providerReads, 0);

  const mismatch = await invokeInboundReplyContent({
    setup,
    fetchImpl: async () => {
      setup.state.providerReads += 1;
      return syntheticReceivingResponse({
        from: "different@example.com",
      });
    },
  });
  assert.equal(mismatch.statusCode, 409);
  assert.equal(
    mismatch.body.code,
    "PROSPECT_EMAIL_RECEIVING_BINDING_MISMATCH"
  );
  assert.equal(setup.state.providerReads, 1);
  assert.equal(
    setup.state.receipt?.details.replyContentReceipt,
    undefined
  );
});

test("a provider read is not reported as successful when the expected database row does not change", async () => {
  const setup = makeWebhookSql({ failOnContentUpdate: true });
  await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_reply_content_write_failure_0001",
    event: receivedEvent(),
  });
  const result = await invokeInboundReplyContent({ setup });
  assert.equal(result.statusCode, 409);
  assert.equal(
    result.body.code,
    "PROSPECT_INBOUND_REPLY_CONTENT_WRITE_FAILED"
  );
  assert.equal(
    result.body.externalAction,
    "resend_received_email_read_attempted_without_durable_receipt"
  );
  assert.equal(setup.state.providerReads, 1);
  assert.equal(
    setup.state.receipt?.details.replyContentReceipt,
    undefined
  );
});

test("a human-classified reply records one outcome and remains replay-idempotent", async () => {
  const setup = makeWebhookSql();
  await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_reply_resolution_0001",
    event: receivedEvent(),
  });
  const body = inboundReplyResolutionBody(setup, "reply");
  const first = await invokeInboundReplyResolution({ setup, body });
  assert.equal(first.statusCode, 201);
  assert.equal(first.body.outcome, "resolved");
  assert.equal(first.body.receipt.resolution, "reply");
  assert.equal(first.body.receipt.resultingOutcome, "replied");
  assert.equal(first.body.receipt.suppressionRecorded, false);
  assert.equal(first.body.externalAction, "none");
  assert.equal(setup.state.outcomes.length, 1);
  assert.equal(setup.state.outcomes[0].outcome, "replied");
  assert.equal(setup.state.positiveReviewWrites, 1);
  assert.equal(setup.state.positiveReviewAuditEvents, 1);
  assert.equal(setup.state.outboxWrites, 1);
  assert.equal(setup.state.suppressions.length, 0);
  assert.equal(setup.state.receipt?.process_status, "PROCESSED");

  const replay = await invokeInboundReplyResolution({ setup, body });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.outcome, "duplicate");
  assert.equal(setup.state.outcomes.length, 1);
  assert.equal(setup.state.positiveReviewWrites, 1);
  assert.equal(setup.state.outboxWrites, 1);

  const conflict = await invokeInboundReplyResolution({
    setup,
    body: inboundReplyResolutionBody(setup, "not_actionable"),
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(
    conflict.body.code,
    "PROSPECT_INBOUND_REPLY_RESOLUTION_CONFLICT"
  );
});

test("a human-verified opt-out atomically suppresses email and records DNC", async () => {
  const setup = makeWebhookSql();
  await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_reply_opt_out_0001",
    event: receivedEvent(),
  });
  const result = await invokeInboundReplyResolution({
    setup,
    body: inboundReplyResolutionBody(setup, "opt_out"),
  });
  assert.equal(result.statusCode, 201);
  assert.equal(result.body.receipt.resolution, "opt_out");
  assert.equal(result.body.receipt.resultingOutcome, "dnc");
  assert.equal(result.body.receipt.suppressionRecorded, true);
  assert.equal(result.body.externalAction, "none");
  assert.deepEqual(setup.state.suppressions, ["owner@example.com"]);
  assert.equal(setup.state.outcomes.length, 1);
  assert.equal(setup.state.outcomes[0].outcome, "dnc");
  assert.equal(setup.state.positiveReviewWrites, 0);
  assert.equal(setup.state.outboxWrites, 1);
  assert.equal(setup.state.leadUpdates, 1);
  assert.equal(setup.state.receipt?.process_status, "PROCESSED");
});

test("forged reply hashes, missing opt-out attestation, and workspace mismatch fail closed", async () => {
  const setup = makeWebhookSql();
  await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_reply_fail_closed_0001",
    event: receivedEvent(),
  });

  const forged = await invokeInboundReplyResolution({
    setup,
    body: {
      ...inboundReplyResolutionBody(setup, "reply"),
      payloadHash: "f".repeat(64),
    },
  });
  assert.equal(forged.statusCode, 409);
  assert.equal(
    forged.body.code,
    "PROSPECT_INBOUND_REPLY_REVIEW_HASH_MISMATCH"
  );

  const invalidOptOut = inboundReplyResolutionBody(
    setup,
    "opt_out"
  ) as any;
  delete invalidOptOut.attestations.recipientOptOutVerified;
  const malformed = await invokeInboundReplyResolution({
    setup,
    body: invalidOptOut,
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(
    malformed.body.code,
    "PROSPECT_INBOUND_REPLY_RESOLUTION_INVALID"
  );

  const wrongWorkspace = await invokeInboundReplyResolution({
    setup,
    body: inboundReplyResolutionBody(setup, "reply"),
    workspaceId: 8,
  });
  assert.equal(wrongWorkspace.statusCode, 404);
  assert.equal(
    wrongWorkspace.body.code,
    "PROSPECT_INBOUND_REPLY_REVIEW_NOT_FOUND"
  );
  assert.equal(setup.state.outcomes.length, 0);
  assert.equal(setup.state.suppressions.length, 0);
  assert.equal(setup.state.receipt?.process_status, "REVIEW_REQUIRED");
});

test("suppression storage failure leaves an opt-out unresolved and unsent", async () => {
  const setup = makeWebhookSql({ failOnSuppressionInsert: true });
  await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_reply_suppression_failure_0001",
    event: receivedEvent(),
  });
  const result = await invokeInboundReplyResolution({
    setup,
    body: inboundReplyResolutionBody(setup, "opt_out"),
  });
  assert.equal(result.statusCode, 503);
  assert.equal(
    result.body.code,
    "PROSPECT_OUTREACH_STORAGE_UNAVAILABLE"
  );
  assert.equal(setup.state.receipt?.process_status, "REVIEW_REQUIRED");
  assert.equal(setup.state.outcomes.length, 0);
  assert.equal(setup.state.outboxWrites, 0);
});

test("a controlled inbox delivery remains placement evidence only", async () => {
  const setup = makeWebhookSql({
    job: { ...defaultJob(), is_seed: true },
  });
  const result = await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_seed_delivery_webhook_0001",
    event: deliveredEvent(),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, "PROCESSED");
  assert.equal(result.body.outcome, "controlled_seed_processed");
  assert.equal(result.body.controlledSeed, true);
  assert.equal(result.body.marketOutcomeRecorded, false);
  assert.equal(result.body.velvetCallbackPrepared, false);
  assert.equal(setup.state.outcomes.length, 0);
  assert.equal(setup.state.leadUpdates, 0);
  assert.equal(setup.state.outboxWrites, 0);
  assert.equal(setup.state.receipt?.process_status, "PROCESSED");
});

test("a controlled inbox reply remains placement evidence only", async () => {
  const setup = makeWebhookSql({
    job: { ...defaultJob(), is_seed: true },
  });
  const result = await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_seed_reply_webhook_0001",
    event: receivedEvent(),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, "PROCESSED");
  assert.equal(result.body.outcome, "controlled_seed_processed");
  assert.equal(result.body.controlledSeed, true);
  assert.equal(result.body.marketOutcomeRecorded, false);
  assert.equal(result.body.velvetCallbackPrepared, false);
  assert.equal(setup.state.outcomes.length, 0);
  assert.equal(setup.state.leadUpdates, 0);
  assert.equal(setup.state.outboxWrites, 0);
});

test("a replayed provider event is idempotent", async () => {
  const setup = makeWebhookSql();
  const event = deliveredEvent();
  const first = await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_replayed_webhook_0001",
    event,
  });
  const second = await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_replayed_webhook_0001",
    event,
  });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.outcome, "duplicate");
  assert.equal(setup.state.outcomes.length, 1);
  assert.equal(setup.state.outboxWrites, 1);
});

test("a relevant event with no finalized provider job requests retry", async () => {
  const setup = makeWebhookSql({ job: null });
  const result = await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_missing_job_webhook_0001",
    event: deliveredEvent(),
  });
  assert.equal(result.statusCode, 503);
  assert.equal(
    result.body.code,
    "PROSPECT_EMAIL_WEBHOOK_RETRY_REQUIRED"
  );
  assert.equal(setup.state.receipt?.process_status, "RETRY");
  assert.equal(setup.state.outcomes.length, 0);
});

test("ambiguous inbound replies stop for human review", async () => {
  const setup = makeWebhookSql({
    replyJobs: [
      {
        id: 9,
        lead_id: 23,
        approval_id: defaultJob().approval_id,
        is_seed: false,
      },
      {
        id: 10,
        lead_id: 23,
        approval_id: "22222222-2222-4222-8222-222222222222",
        is_seed: false,
      },
    ],
  });
  const result = await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_ambiguous_reply_0001",
    event: receivedEvent(),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, "REVIEW_REQUIRED");
  const replyReview = setup.state.receipt?.details.replyReview as any;
  assert.equal(replyReview.matchState, "ambiguous");
  assert.equal(replyReview.candidates.length, 2);
  assert.equal(setup.state.outcomes.length, 0);

  const secondCandidate = replyReview.candidates[1];
  const resolution = await invokeInboundReplyResolution({
    setup,
    body: {
      ...inboundReplyResolutionBody(setup, "reply"),
      selectedOutreachApprovalId:
        secondCandidate.outreachApprovalId,
    },
  });
  assert.equal(resolution.statusCode, 201);
  assert.equal(
    resolution.body.receipt.selectedOutreachApprovalId,
    secondCandidate.outreachApprovalId
  );
  assert.equal(setup.state.receipt?.outreach_job_id, 10);
  assert.equal(setup.state.outcomes.length, 1);
  assert.ok(
    setup.state.queries.some(
      query =>
        query.text.includes("AND approval_id") &&
        query.values.includes(10) &&
        query.values.includes(secondCandidate.outreachApprovalId)
    )
  );
});

test("an unmatched inbound email cannot be attributed as a positive reply", async () => {
  const setup = makeWebhookSql({ job: null, replyJobs: [] });
  const result = await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_unmatched_reply_0001",
    event: receivedEvent(),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, "REVIEW_REQUIRED");
  const replyReview = setup.state.receipt?.details.replyReview as any;
  assert.equal(replyReview.matchState, "no_match");
  assert.deepEqual(replyReview.candidates, []);

  const forgedAttribution = await invokeInboundReplyResolution({
    setup,
    body: {
      ...inboundReplyResolutionBody(setup, "not_actionable"),
      resolution: "reply",
      selectedOutreachApprovalId:
        "44444444-4444-4444-8444-444444444444",
    },
  });
  assert.equal(forgedAttribution.statusCode, 409);
  assert.equal(
    forgedAttribution.body.code,
    "PROSPECT_INBOUND_REPLY_CANDIDATE_MISMATCH"
  );
  assert.equal(setup.state.receipt?.process_status, "REVIEW_REQUIRED");

  const dismissal = await invokeInboundReplyResolution({
    setup,
    body: inboundReplyResolutionBody(setup, "not_actionable"),
  });
  assert.equal(dismissal.statusCode, 201);
  assert.equal(dismissal.body.receipt.resolution, "not_actionable");
  assert.equal(
    dismissal.body.receipt.selectedOutreachApprovalId,
    null
  );
  assert.equal(dismissal.body.receipt.resultingOutcome, null);
  assert.equal(setup.state.receipt?.outreach_job_id, null);
  assert.equal(setup.state.outcomes.length, 0);
  assert.equal(setup.state.suppressions.length, 0);
  assert.equal(setup.state.outboxWrites, 0);
});

test("an unmatched verified opt-out suppresses without fabricating an outcome", async () => {
  const setup = makeWebhookSql({ job: null, replyJobs: [] });
  await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_unmatched_opt_out_0001",
    event: receivedEvent(),
  });
  const body = inboundReplyResolutionBody(setup, "opt_out") as any;
  delete body.selectedOutreachApprovalId;
  const resolution = await invokeInboundReplyResolution({
    setup,
    body,
  });
  assert.equal(resolution.statusCode, 201);
  assert.equal(resolution.body.receipt.resolution, "opt_out");
  assert.equal(
    resolution.body.receipt.selectedOutreachApprovalId,
    null
  );
  assert.equal(resolution.body.receipt.resultingOutcome, null);
  assert.equal(resolution.body.receipt.suppressionRecorded, true);
  assert.deepEqual(setup.state.suppressions, ["owner@example.com"]);
  assert.equal(setup.state.outcomes.length, 0);
  assert.equal(setup.state.outboxWrites, 0);
  assert.equal(setup.state.receipt?.outreach_job_id, null);
  assert.equal(setup.state.receipt?.process_status, "PROCESSED");
});

test("an unexpected durable queue state fails closed", async () => {
  const setup = makeWebhookSql();
  await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_invalid_reply_state_0001",
    event: receivedEvent(),
  });
  assert.ok(setup.state.receipt);
  setup.state.receipt.process_status = "RETRY";
  const handlers = captureRoutes(setup.sql).get(
    "GET /api/prospecting/email-replies"
  );
  assert.ok(handlers);
  const { response, state } = makeResponse();
  await handlers.at(-1)!(
    { query: { state: "all" } } as unknown as Request,
    response,
    () => undefined
  );
  assert.equal(state.statusCode, 503);
  assert.equal(
    state.body.code,
    "PROSPECT_INBOUND_REPLY_REVIEW_CORRUPT"
  );
});

test("tampered stored message content fails its immutable receipt check", async () => {
  const setup = makeWebhookSql();
  await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_reply_content_tamper_0001",
    event: receivedEvent(),
  });
  const retrieved = await invokeInboundReplyContent({ setup });
  assert.equal(retrieved.statusCode, 201);
  const stored = setup.state.receipt?.details
    .replyContentReceipt as Record<string, unknown>;
  stored.plainText = "Changed after retrieval.";

  const handlers = captureRoutes(setup.sql).get(
    "GET /api/prospecting/email-replies"
  );
  assert.ok(handlers);
  const { response, state } = makeResponse();
  await handlers.at(-1)!(
    { query: { state: "pending" } } as unknown as Request,
    response,
    () => undefined
  );
  assert.equal(state.statusCode, 503);
  assert.equal(
    state.body.code,
    "PROSPECT_INBOUND_REPLY_CONTENT_CORRUPT"
  );
});

test("a zero-row resolution update never reports success", async () => {
  const setup = makeWebhookSql({ failOnResolutionUpdate: true });
  await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_reply_zero_row_update_0001",
    event: receivedEvent(),
  });
  const result = await invokeInboundReplyResolution({
    setup,
    body: inboundReplyResolutionBody(setup, "not_actionable"),
  });
  assert.equal(result.statusCode, 409);
  assert.equal(
    result.body.code,
    "PROSPECT_INBOUND_REPLY_RESOLUTION_WRITE_FAILED"
  );
  assert.equal(setup.state.receipt?.process_status, "REVIEW_REQUIRED");
  assert.equal(setup.state.outcomes.length, 0);
  assert.equal(setup.state.suppressions.length, 0);
  assert.equal(setup.state.outboxWrites, 0);
});

test("database failure returns retryable server failure without a false success", async () => {
  const setup = makeWebhookSql({ failOnReceiptInsert: true });
  const result = await invokeWebhook({
    sql: setup.sql,
    eventId: "evt_database_failure_0001",
    event: deliveredEvent(),
  });
  assert.equal(result.statusCode, 503);
  assert.equal(
    result.body.code,
    "PROSPECT_OUTREACH_STORAGE_UNAVAILABLE"
  );
  assert.equal(setup.state.outcomes.length, 0);
  assert.equal(setup.state.outboxWrites, 0);
});
