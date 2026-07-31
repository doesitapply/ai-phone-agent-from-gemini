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
  };
}

function makeWebhookSql(options: {
  job?: ReturnType<typeof defaultJob> | null;
  replyJobs?: Array<
    Pick<
      ReturnType<typeof defaultJob>,
      "id" | "lead_id" | "approval_id" | "is_seed"
    >
  >;
  failOnReceiptInsert?: boolean;
} = {}) {
  const state = {
    receipt: null as null | {
      id: number;
      workspace_id: number;
      event_type: string;
      payload_hash: string;
      process_status: string;
    },
    outcomes: [] as Array<{
      outcome: string;
      externalEventId: string;
      occurredAt: string;
    }>,
    suppressions: [] as string[],
    outboxWrites: 0,
    leadUpdates: 0,
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
        event_type: eventType,
        payload_hash: payloadHash,
        process_status: "RECEIVED",
      };
      return [{ id: 71 }];
    }
    if (
      text.includes("FROM prospect_email_provider_events") &&
      text.includes("LIMIT 1 FOR UPDATE")
    ) {
      return state.receipt ? [state.receipt] : [];
    }
    if (
      text.includes("UPDATE prospect_email_provider_events") &&
      text.includes("SET process_status")
    ) {
      const status = values.find((value) =>
        [
          "PROCESSED",
          "IGNORED",
          "RETRY",
          "REVIEW_REQUIRED",
        ].includes(String(value))
      );
      if (state.receipt) state.receipt.process_status = String(status);
      return [{ id: 71 }];
    }
    if (
      text.includes(
        "SELECT id, lead_id, approval_id, recipient, state"
      )
    ) {
      return job ? [job] : [];
    }
    if (
      text.includes("SELECT id, lead_id, approval_id") &&
      text.includes("ORDER BY sent_at DESC")
    ) {
      return options.replyJobs || (job ? [job] : []);
    }
    if (text.includes("INSERT INTO prospect_email_suppressions")) {
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
  return { sql, state };
}

function captureWebhookHandler(sql: any) {
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
    getWorkspaceId: () => 7,
    env: webhookEnv(),
  });
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
  assert.equal(setup.state.outcomes.length, 0);
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
