import assert from "node:assert/strict";
import test from "node:test";
import type {
  Request,
  RequestHandler,
  Response,
} from "express";
import { registerProspectRevenueLoopRoutes } from "../src/routes/prospect-revenue-loop-routes.ts";

const zeroRow = {
  campaigns: 0,
  discovery_prepared: 0,
  discovery_approved: 0,
  discovery_in_flight: 0,
  discovery_ready_for_import: 0,
  discovery_failed: 0,
  source_prepared: 0,
  source_approved: 0,
  source_in_flight: 0,
  pending_review_leads: 0,
  qualified_leads: 0,
  qualified_email_leads_without_outreach: 0,
  qualified_call_leads_without_outreach: 0,
  outreach_prepared: 0,
  outreach_approved_email: 0,
  outreach_approved_call: 0,
  outreach_sending: 0,
  outreach_sent_without_outcome: 0,
  outcome_events: 0,
  positive_outcome_jobs: 0,
  unreviewed_positive_outcome_jobs: 0,
  velvet_callbacks_prepared: 0,
  velvet_callbacks_sending: 0,
  passing_inbox_tests: 0,
  email_experiments_prepared: 0,
  email_experiments_prepared_with_matching_inbox_test: 0,
  email_experiments_active: 0,
  email_experiment_unenrolled: 0,
  call_experiments_prepared: 0,
  call_experiments_active: 0,
  call_experiment_unenrolled: 0,
  closed_experiments: 0,
  learning_candidates_pending: 0,
  learning_candidates_approved: 0,
  learning_candidates_approved_unapplied: 0,
};

function configuredEnv() {
  return {
    VELVET_DISCOVERY_ENABLED: "true",
    VELVET_LEAD_SOURCE_ENABLED: "true",
    VELVET_LEAD_SOURCE_BASE_URL:
      "https://velvetalchemy.manus.space",
    VELVET_LEAD_SOURCE_API_KEY: `research-${"a".repeat(32)}`,
    VELVET_LEAD_SOURCE_WORKSPACE_ID: "7",
    PROSPECT_EMAIL_EXECUTION_ENABLED: "true",
    PROSPECT_EMAIL_EXECUTION_MODE:
      "single-recipient-reviewed-v1",
    PROSPECT_EMAIL_RESEND_API_KEY: `re_${"b".repeat(24)}`,
    PROSPECT_EMAIL_FROM: "SMIRK <outreach@smirkcalls.com>",
    PROSPECT_EMAIL_REPLY_TO: "reply@smirkcalls.com",
    PROSPECT_EMAIL_WORKSPACE_ID: "7",
    PROSPECT_EMAIL_DAILY_RECIPIENT_CAP: "2",
    PROSPECT_EMAIL_DAILY_SPEND_CAP_CENTS: "2",
    PROSPECT_EMAIL_UNIT_COST_CENTS: "1",
    PROSPECT_INBOX_SEED_ALLOWLIST: [
      "google-one@example.invalid",
      "google-two@example.invalid",
      "microsoft-one@example.invalid",
      "microsoft-two@example.invalid",
      "yahoo-one@example.invalid",
    ].join(","),
    VELVET_BASE_URL: "https://velvetalchemy.manus.space",
    VELVET_OUTCOME_API_KEY: `outcome-${"c".repeat(32)}`,
    VELVET_OUTCOME_SIGNING_SECRET: `signing-${"d".repeat(32)}`,
    VELVET_OUTCOME_WORKSPACE_ID: "7",
    VELVET_OUTCOME_DISPATCH_ENABLED: "true",
  };
}

function captureHandler(options: {
  sql: any;
  dbEnabled?: boolean;
  env?: Record<string, string | undefined>;
}) {
  let handler:
    | ((req: Request, res: Response) => unknown)
    | undefined;
  const app = {
    get(
      path: string,
      ...handlers: Array<
        (req: Request, res: Response) => unknown
      >
    ) {
      if (path === "/api/prospecting/revenue-loop") {
        handler = handlers.at(-1);
      }
    },
  };
  const pass: RequestHandler = (_req, _res, next) => next();
  registerProspectRevenueLoopRoutes(app as any, {
    dashboardAuth: pass,
    requireOperator: pass,
    sql: options.sql,
    dbEnabled: options.dbEnabled ?? true,
    getWorkspaceId: () => 7,
    env: options.env || configuredEnv(),
  });
  assert.ok(handler);
  return handler;
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

test("revenue-loop status is read-only and workspace-scoped", async () => {
  let queryText = "";
  let queryValues: unknown[] = [];
  const sql = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    queryText = strings.join(" ").replace(/\s+/g, " ").trim();
    queryValues = values;
    return [{ ...zeroRow, discovery_prepared: 1 }];
  };
  const { response, state } = responseCapture();
  await captureHandler({ sql })(
    {} as Request,
    response
  );

  assert.equal(state.status, 200);
  assert.equal(
    state.body.nextAction.code,
    "APPROVE_VELVET_DISCOVERY"
  );
  assert.equal(state.body.externalAction, "none");
  assert.equal(state.body.guardrails.smsAllowed, false);
  assert.equal(
    state.body.guardrails.automatedProspectDialingAllowed,
    false
  );
  assert.match(queryText, /FROM velvet_discovery_requests/);
  assert.match(queryText, /FROM prospect_outreach_jobs/);
  assert.match(
    queryText,
    /FROM prospect_message_policy_releases/
  );
  assert.match(
    queryText,
    /t\.target_campaign_id = e\.campaign_id/
  );
  assert.match(
    queryText,
    /t\.control_variant_key =\s*e\.control_variant_key/
  );
  assert.match(
    queryText,
    /t\.challenger_variant_key =\s*e\.challenger_variant_key/
  );
  assert.doesNotMatch(
    queryText,
    /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/i
  );
  assert.ok(queryValues.filter((value) => value === 7).length > 20);
  assert.ok(
    queryValues.every(
      (value) =>
        value === 7 ||
        value === "smirk_inbox_placement_seed"
    )
  );
  assert.equal(
    JSON.stringify(state.body).includes(
      configuredEnv().VELVET_LEAD_SOURCE_API_KEY
    ),
    false
  );
});

test("an unrelated inbox PASS cannot make a prepared experiment activation-ready", async () => {
  const sql = async () => [{
    ...zeroRow,
    qualified_leads: 20,
    qualified_email_leads_without_outreach: 20,
    passing_inbox_tests: 1,
    email_experiments_prepared: 1,
    email_experiments_prepared_with_matching_inbox_test: 0,
  }];
  const { response, state } = responseCapture();
  await captureHandler({ sql })({} as Request, response);

  assert.equal(state.status, 200);
  assert.equal(state.body.nextAction.code, "RUN_INBOX_PLACEMENT");
  assert.match(
    state.body.nextAction.detail,
    /Unrelated inbox tests cannot authorize activation/
  );
  assert.equal(
    state.body.counts
      .emailExperimentsPreparedWithMatchingInboxTest,
    0
  );
});

test("revenue-loop status fails closed without durable storage", async () => {
  let queryCount = 0;
  const { response, state } = responseCapture();
  await captureHandler({
    sql: async () => {
      queryCount += 1;
      return [];
    },
    dbEnabled: false,
  })({} as Request, response);
  assert.equal(state.status, 503);
  assert.equal(
    state.body.code,
    "PROSPECT_REVENUE_LOOP_STORAGE_REQUIRED"
  );
  assert.equal(queryCount, 0);
});

test("revenue-loop database failure never returns a false status", async () => {
  const { response, state } = responseCapture();
  await captureHandler({
    sql: async () => {
      throw new Error("synthetic database failure");
    },
  })({} as Request, response);
  assert.equal(state.status, 503);
  assert.equal(
    state.body.code,
    "PROSPECT_REVENUE_LOOP_STATUS_FAILED"
  );
  assert.equal(state.body.externalAction, "none");
});
