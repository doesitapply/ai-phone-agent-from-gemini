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
  qc_revisions_required: 0,
  outreach_prepared: 0,
  outreach_approved_email: 0,
  outreach_approved_call: 0,
  outreach_sending: 0,
  outreach_sent_without_outcome: 0,
  outreach_sent_email_without_outcome: 0,
  outreach_sent_call_without_outcome: 0,
  outcome_events: 0,
  positive_outcome_jobs: 0,
  unreviewed_positive_outcome_jobs: 0,
  velvet_callbacks_prepared: 0,
  velvet_callbacks_sending: 0,
  passing_inbox_tests: 0,
  email_experiments_prepared: 0,
  email_experiments_prepared_with_matching_inbox_test: 0,
  email_experiments_active: 0,
  email_experiments_ready_to_close: 0,
  email_experiment_unenrolled: 0,
  call_experiments_prepared: 0,
  call_experiments_active: 0,
  call_experiments_ready_to_close: 0,
  call_experiment_unenrolled: 0,
  closed_experiments: 0,
  learning_candidates_pending: 0,
  learning_candidates_approved: 0,
  learning_candidates_approved_unapplied: 0,
};

function configuredEnv(
  overrides: Record<string, string | undefined> = {}
) {
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
    PROSPECT_EMAIL_WEBHOOK_ENABLED: "true",
    PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET:
      "whsec_synthetic_revenue_loop_secret",
    PROSPECT_QC_MODEL_REVIEW_ENABLED: "true",
    PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL: "true",
    PROSPECT_QC_MODEL_REVIEW_MODE:
      "single-draft-advisory-v1",
    PROSPECT_QC_OPENROUTER_API_KEY:
      "sk-or-synthetic-revenue-loop-key",
    PROSPECT_QC_OPENROUTER_MODEL:
      "google/gemini-2.5-flash",
    PROSPECT_QC_MODEL_WORKSPACE_ID: "7",
    PROSPECT_QC_MODEL_DAILY_REVIEW_CAP: "2",
    PROSPECT_QC_MODEL_DAILY_SPEND_CAP_CENTS: "2",
    PROSPECT_QC_MODEL_RESERVED_COST_CENTS: "1",
    PROSPECT_QC_MODEL_TIMEOUT_MS: "5000",
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
    ...overrides,
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
  const queryTexts: string[] = [];
  const queryValues: unknown[][] = [];
  const sql = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    queryTexts.push(
      strings.join(" ").replace(/\s+/g, " ").trim()
    );
    queryValues.push(values);
    return queryTexts.length === 1
      ? [{ ...zeroRow, discovery_prepared: 1 }]
      : [{ request_id: 91 }];
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
  assert.equal(
    state.body.connections.advisoryQc.availableForWorkspace,
    true
  );
  assert.equal(
    state.body.connections.emailWebhook.availableForWorkspace,
    true
  );
  const countQuery = queryTexts[0];
  const focusQuery = queryTexts[1];
  assert.match(countQuery, /FROM velvet_discovery_requests/);
  assert.match(countQuery, /FROM prospect_outreach_jobs/);
  assert.match(
    countQuery,
    /FROM prospect_message_policy_releases/
  );
  assert.match(
    countQuery,
    /t\.target_campaign_id = e\.campaign_id/
  );
  assert.match(
    countQuery,
    /t\.control_variant_key =\s*e\.control_variant_key/
  );
  assert.match(
    countQuery,
    /t\.challenger_variant_key =\s*e\.challenger_variant_key/
  );
  assert.match(
    countQuery,
    /email_experiments_ready_to_close/
  );
  assert.match(
    countQuery,
    /call_experiments_ready_to_close/
  );
  assert.match(
    countQuery,
    /j\.state IN \('PREPARED', 'APPROVED', 'SENDING'\)/
  );
  assert.match(
    countQuery,
    /j\.sent_at > NOW\(\).+INTERVAL '1 hour'/s
  );
  assert.match(
    countQuery,
    /FROM prospect_outcome_events o/
  );
  assert.ok(
    queryValues.flat().includes("fisher-exact-one-sided-v1")
  );
  assert.match(
    countQuery,
    /e\.state = 'CLOSED'.+executedProtocolDeviationCount/s
  );
  assert.doesNotMatch(
    queryTexts.join(" "),
    /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/i
  );
  assert.match(focusQuery, /state = 'PREPARED'/);
  assert.deepEqual(state.body.nextAction.focus, {
    kind: "velvet_discovery_request",
    requestId: 91,
  });
  assert.ok(
    queryValues[0].filter((value) => value === 7).length > 20
  );
  assert.ok(
    queryValues.flat().every(
      (value) =>
        value === 7 ||
        value === 168 ||
        value === 72 ||
        value === 0.05 ||
        value === "smirk_inbox_placement_seed" ||
        typeof value === "string"
    )
  );
  assert.equal(
    JSON.stringify(state.body).includes(
      configuredEnv().VELVET_LEAD_SOURCE_API_KEY
    ),
    false
  );
  assert.equal(
    JSON.stringify(state.body).includes(
      configuredEnv().PROSPECT_QC_OPENROUTER_API_KEY
    ),
    false
  );
  assert.equal(
    JSON.stringify(state.body).includes(
      configuredEnv().PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET
    ),
    false
  );
});

test("prepared outreach points to mandatory advisory QC before review", async () => {
  let callCount = 0;
  let focusQuery = "";
  let focusValues: unknown[] = [];
  const sql = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    callCount += 1;
    if (callCount === 1) {
      return [{ ...zeroRow, outreach_prepared: 1 }];
    }
    focusQuery = strings.join(" ").replace(/\s+/g, " ").trim();
    focusValues = values;
    return [{ campaign_id: 12, lead_id: 34 }];
  };
  const { response, state } = responseCapture();
  await captureHandler({
    sql,
    env: configuredEnv({
      PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL: "false",
    }),
  })({} as Request, response);

  assert.equal(state.status, 200);
  assert.equal(
    state.body.nextAction.code,
    "CONFIGURE_ADVISORY_QC"
  );
  assert.equal(
    state.body.connections.advisoryQc.availableForWorkspace,
    false
  );
  assert.ok(
    state.body.connections.advisoryQc.missing.includes(
      "PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL"
    )
  );
  assert.match(focusQuery, /j\.state =/);
  assert.ok(focusValues.includes("PREPARED"));
});

test("approved and sent emails point to the signed outcome webhook", async () => {
  for (const scenario of [
    {
      row: { outreach_approved_email: 1 },
      expectedState: "APPROVED",
    },
    {
      row: {
        outreach_sent_without_outcome: 1,
        outreach_sent_email_without_outcome: 1,
      },
      expectedState: "SENT",
    },
  ]) {
    let callCount = 0;
    let focusQuery = "";
    let focusValues: unknown[] = [];
    const sql = async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      callCount += 1;
      if (callCount === 1) {
        return [{ ...zeroRow, ...scenario.row }];
      }
      focusQuery = strings.join(" ").replace(/\s+/g, " ").trim();
      focusValues = values;
      return [{ campaign_id: 56, lead_id: 78 }];
    };
    const { response, state } = responseCapture();
    await captureHandler({
      sql,
      env: configuredEnv({
        PROSPECT_EMAIL_WEBHOOK_ENABLED: "false",
      }),
    })({} as Request, response);

    assert.equal(state.status, 200);
    assert.equal(
      state.body.nextAction.code,
      "CONFIGURE_EMAIL_OUTCOME_WEBHOOK"
    );
    assert.equal(
      state.body.connections.emailWebhook.availableForWorkspace,
      false
    );
    assert.match(focusQuery, /j\.channel =/);
    if (scenario.expectedState === "APPROVED") {
      assert.ok(focusValues.includes("email"));
      assert.ok(focusValues.includes("APPROVED"));
    } else {
      assert.match(focusQuery, /j\.channel = 'email'/);
      assert.match(focusQuery, /j\.state = 'SENT'/);
      assert.match(focusQuery, /NOT EXISTS/);
    }
  }
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

test("active experiment closure readiness comes from the durable preflight", async () => {
  const sql = async () => [{
    ...zeroRow,
    email_experiments_active: 1,
    email_experiments_ready_to_close: 0,
    email_experiment_unenrolled: 0,
  }];
  const { response, state } = responseCapture();
  await captureHandler({ sql })({} as Request, response);

  assert.equal(state.status, 200);
  assert.equal(
    state.body.nextAction.code,
    "RECONCILE_ACTIVE_EXPERIMENT"
  );
  assert.equal(
    state.body.counts.emailExperimentsReadyToClose,
    0
  );
});

test("prospect actions return an exact tenant-scoped drawer focus", async () => {
  let callCount = 0;
  let focusQuery = "";
  const sql = async (
    strings: TemplateStringsArray,
    ..._values: unknown[]
  ) => {
    callCount += 1;
    if (callCount === 1) {
      return [{
        ...zeroRow,
        pending_review_leads: 1,
      }];
    }
    focusQuery = strings.join(" ").replace(/\s+/g, " ").trim();
    return [{
      campaign_id: 12,
      lead_id: 34,
      approval_id: null,
    }];
  };
  const { response, state } = responseCapture();
  await captureHandler({ sql })({} as Request, response);

  assert.equal(state.status, 200);
  assert.equal(
    state.body.nextAction.code,
    "REVIEW_IMPORTED_PROSPECT"
  );
  assert.deepEqual(state.body.nextAction.focus, {
    kind: "prospect",
    campaignId: 12,
    leadId: 34,
  });
  assert.match(focusQuery, /l\.workspace_id =/);
  assert.match(focusQuery, /l\.review_state = 'pending_review'/);
  assert.doesNotMatch(
    focusQuery,
    /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/i
  );
});

test("QC revision action focuses the exact tenant-scoped immutable receipt", async () => {
  let callCount = 0;
  let focusQuery = "";
  let focusValues: unknown[] = [];
  const revisionId = "c14ec466-fc26-4b3b-b9fe-aa6f76489a32";
  const sql = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    callCount += 1;
    if (callCount === 1) {
      return [{ ...zeroRow, qc_revisions_required: 1 }];
    }
    focusQuery = strings.join(" ").replace(/\s+/g, " ").trim();
    focusValues = values;
    return [{
      campaign_id: 12,
      lead_id: 34,
      approval_id: null,
      revision_id: revisionId,
    }];
  };
  const { response, state } = responseCapture();
  await captureHandler({ sql })({} as Request, response);

  assert.equal(state.status, 200);
  assert.equal(
    state.body.nextAction.code,
    "REVISE_RECIPIENT_OUTREACH"
  );
  assert.deepEqual(state.body.nextAction.focus, {
    kind: "prospect",
    campaignId: 12,
    leadId: 34,
    revisionId,
  });
  assert.match(focusQuery, /FROM prospect_qc_revision_items r/);
  assert.match(focusQuery, /r\.state = 'REVISION_REQUIRED'/);
  assert.ok(focusValues.includes(7));
  assert.doesNotMatch(
    focusQuery,
    /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/i
  );
});

test("manual-call outcome focus never selects an email job", async () => {
  let callCount = 0;
  let focusQuery = "";
  const approvalId = "f5ec805c-9179-4ea8-a378-20221142818d";
  const sql = async (strings: TemplateStringsArray) => {
    callCount += 1;
    if (callCount === 1) {
      return [{
        ...zeroRow,
        outreach_sent_without_outcome: 1,
        outreach_sent_call_without_outcome: 1,
      }];
    }
    focusQuery = strings.join(" ").replace(/\s+/g, " ").trim();
    return [{
      campaign_id: 56,
      lead_id: 78,
      approval_id: approvalId,
    }];
  };
  const { response, state } = responseCapture();
  await captureHandler({ sql })({} as Request, response);

  assert.equal(state.status, 200);
  assert.equal(
    state.body.nextAction.code,
    "WAIT_FOR_MEASURED_OUTCOME"
  );
  assert.deepEqual(state.body.nextAction.focus, {
    kind: "prospect",
    campaignId: 56,
    leadId: 78,
    approvalId,
  });
  assert.match(focusQuery, /j\.channel = 'call'/);
  assert.match(focusQuery, /j\.state = 'SENT'/);
  assert.match(focusQuery, /NOT EXISTS/);
});

test("positive interaction pause targets the exact tenant-scoped review", async () => {
  let callCount = 0;
  let focusQuery = "";
  const reviewId = "11ec14f9-d4f0-4c3e-89fb-846d9be1f4a6";
  const sql = async (strings: TemplateStringsArray) => {
    callCount += 1;
    if (callCount === 1) {
      return [{
        ...zeroRow,
        positive_outcome_jobs: 1,
        unreviewed_positive_outcome_jobs: 1,
      }];
    }
    focusQuery = strings.join(" ").replace(/\s+/g, " ").trim();
    return [{ review_id: reviewId }];
  };
  const { response, state } = responseCapture();
  await captureHandler({ sql })({} as Request, response);

  assert.equal(state.status, 200);
  assert.equal(
    state.body.nextAction.code,
    "REVIEW_POSITIVE_OUTCOME"
  );
  assert.deepEqual(state.body.nextAction.focus, {
    kind: "positive_outcome_review",
    reviewId,
  });
  assert.match(focusQuery, /workspace_id =/);
  assert.match(focusQuery, /state = 'PENDING'/);
});

test("policy release focus excludes ungrounded legacy approvals", async () => {
  let callCount = 0;
  let focusQuery = "";
  const sql = async (strings: TemplateStringsArray) => {
    callCount += 1;
    if (callCount === 1) {
      return [{
        ...zeroRow,
        learning_candidates_approved: 1,
        learning_candidates_approved_unapplied: 1,
      }];
    }
    focusQuery = strings.join(" ").replace(/\s+/g, " ").trim();
    return [{ candidate_id: 44 }];
  };
  const { response, state } = responseCapture();
  await captureHandler({ sql })({} as Request, response);

  assert.equal(state.status, 200);
  assert.equal(
    state.body.nextAction.code,
    "APPLY_MESSAGE_POLICY"
  );
  assert.deepEqual(state.body.nextAction.focus, {
    kind: "learning_candidate",
    candidateId: 44,
  });
  assert.match(
    focusQuery,
    /JOIN prospect_message_experiments/
  );
  assert.match(focusQuery, /e\.state = 'CLOSED'/);
  assert.match(
    focusQuery,
    /executedProtocolDeviationCount/
  );
  assert.match(focusQuery, /runtimePolicyChange/);
  assert.match(focusQuery, /sampleSize/);
  assert.match(
    focusQuery,
    /evidence->'current'->>'channel'/
  );
  assert.match(
    focusQuery,
    /FROM prospect_message_policy_releases/
  );
});

test("shared experiment actions focus the email lane before the call lane", async () => {
  let callCount = 0;
  let focusValues: unknown[] = [];
  const experimentId =
    "532f458c-4bb4-4712-8ddb-4b4f1f1bd38a";
  const sql = async (
    _strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    callCount += 1;
    if (callCount === 1) {
      return [{
        ...zeroRow,
        email_experiments_active: 1,
        email_experiment_unenrolled: 1,
        call_experiments_active: 1,
        call_experiment_unenrolled: 1,
      }];
    }
    focusValues = values;
    return [{
      experiment_id: experimentId,
      campaign_id: 12,
    }];
  };
  const { response, state } = responseCapture();
  await captureHandler({ sql })({} as Request, response);

  assert.equal(state.status, 200);
  assert.equal(
    state.body.nextAction.code,
    "PREPARE_EXPERIMENT_DRAFTS"
  );
  assert.deepEqual(state.body.nextAction.focus, {
    kind: "message_experiment",
    experimentId,
    campaignId: 12,
  });
  assert.ok(
    focusValues.includes("email"),
    "the focus query must preserve the controller's email-first lane"
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
