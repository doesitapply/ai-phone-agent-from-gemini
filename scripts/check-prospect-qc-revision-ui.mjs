import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

const baseUrl = process.env.SMIRK_UI_PROOF_BASE_URL || "http://127.0.0.1:4180";
const outputDir = path.resolve(
  process.env.SMIRK_UI_PROOF_OUTPUT_DIR || "output/ui-proof"
);
const revisionId = "11111111-1111-4111-8111-111111111111";

const campaign = {
  id: 1,
  name: "Reno Home Services Validation",
  description: "Synthetic operator-review campaign",
  status: "draft",
  agent_name: "SMIRK",
  target_industry: "plumbing",
  target_location: "Reno, NV",
  max_calls_per_day: 0,
  call_window_start: "09:00",
  call_window_end: "17:00",
  total_leads: 1,
  called: 0,
  interested: 0,
  not_interested: 0,
  voicemails: 0,
  created_at: "2026-08-01T16:00:00.000Z",
};

const lead = {
  id: 3,
  campaign_id: 1,
  business_name: "Silver State Home Services Demo",
  phone: "+12025550124",
  email: "owner@example.test",
  website: "https://example.test",
  industry: "plumbing",
  city: "Reno",
  state: "NV",
  contact_name: "Alex Rivera",
  source: "synthetic_ui_proof",
  status: "pending",
  review_state: "qualified",
  email_verification: "verified_owner_email",
  phone_contact_mode: "operator_review_only",
  research_evidence: [
    {
      url: "https://example.test/services",
      observation:
        "The synthetic service page lists emergency plumbing support in Reno.",
      observedAt: "2026-08-01T16:00:00.000Z",
      kind: "public_web",
      basis: "observed",
      confidence: "high",
    },
  ],
  external_id: "synthetic-ui-proof-3",
  created_at: "2026-08-01T16:00:00.000Z",
};

const revision = {
  revision_id: revisionId,
  state: "REVISION_REQUIRED",
  channel: "email",
  recipient: "owner@example.test",
  subject: "Guaranteed jobs for Silver State",
  content:
    "Hi Alex, SMIRK guarantees you will recover every lost emergency job.",
  variant_key: "operator-custom",
  evidence_hash: "e".repeat(64),
  email_compliance: {
    senderIdentity: "SMIRK",
    advertisementDisclosure: "This is a commercial message from SMIRK.",
    physicalPostalAddress: "1605 McKinley Drive, Reno, NV 89509",
    optOutInstructions: "Reply no and I will not follow up.",
  },
  max_cost_cents: 2,
  expires_in_hours: 24,
  qc_receipt: {
    contractVersion: "smirk.prospect-qc-receipt.v1",
    ruleVersion: "smirk.prospect-qc-rules.v1",
    receiptId: "qcr_synthetic_001",
    deterministicPassed: false,
    verdict: "REVISION_REQUIRED",
    reviewPriority: "elevated",
    failureReasons: ["unsupported_outcome_claim", "spam_phrase"],
    ruleResults: [
      {
        code: "unsupported_outcome_claim",
        passed: false,
        detail: "The guarantee is not supported by the evidence payload.",
      },
      {
        code: "spam_phrase",
        passed: false,
        detail: "Guaranteed outcome language is prohibited.",
      },
      {
        code: "email_compliance",
        passed: true,
        detail: "Required sender, address, and opt-out fields are present.",
      },
    ],
    modelReview: {
      status: "NOT_RUN",
      authority: "advisory-only",
      failureReasons: [],
    },
    humanApprovalRequired: true,
    contactAuthorized: false,
    executionAuthorized: false,
  },
  payload_hash: "a".repeat(64),
  prepared_by: "synthetic-operator",
  prepared_at: "2026-08-01T16:05:00.000Z",
  rejected_by: null,
  rejected_at: null,
  rejection_reason: null,
  superseded_by_approval_id: null,
  superseded_at: null,
  created_at: "2026-08-01T16:05:00.000Z",
  updated_at: "2026-08-01T16:05:00.000Z",
  approvalAuthorized: false,
  contactAuthorized: false,
  executionAuthorized: false,
  providerRequestAuthorized: false,
};

const revenueLoop = {
  contractVersion: "smirk.prospect-revenue-loop.v9",
  mode: "guarded-human-approval",
  counts: { positiveOutcomeJobs: 0, unreviewedPositiveOutcomeJobs: 0 },
  stages: [
    { id: "source", label: "Source", state: "READY", count: 1 },
    { id: "review", label: "Review", state: "READY", count: 1 },
    { id: "experiment", label: "Experiment", state: "WAITING", count: 0 },
    {
      id: "outreach",
      label: "Outreach",
      state: "ACTION_REQUIRED",
      count: 1,
    },
    { id: "feedback", label: "Feedback", state: "WAITING", count: 0 },
    { id: "learning", label: "Learning", state: "WAITING", count: 0 },
  ],
  nextAction: {
    code: "REVISE_RECIPIENT_OUTREACH",
    stage: "outreach",
    title: "Revise one failed-QC draft",
    detail:
      "A deterministic QC receipt blocked this draft before approval or provider contact.",
    target: "prospect-qc-revision-queue",
    requiresHumanApproval: true,
    requiresSeparateExecutionConfirmation: true,
    executionEffect: "none",
    focus: {
      kind: "prospect",
      campaignId: 1,
      leadId: 3,
      revisionId,
    },
  },
  guardrails: {
    smsAllowed: false,
    bulkExecutionAllowed: false,
    automatedProspectDialingAllowed: false,
    qcMayAuthorizeContact: false,
    learningMayMutateRuntimePolicy: false,
  },
  externalAction: "none",
};

const respond = (route, body) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

async function installSyntheticApi(context) {
  await context.addInitScript(() => {
    localStorage.setItem(
      "smirk_operator_session",
      JSON.stringify({
        apiKey: "synthetic-operator-key",
        label: "SMIRK Operator Admin",
        role: "operator",
        capabilities: ["workspace:read", "prospecting:review"],
        pages: [],
        spendRestricted: false,
        createdAt: "2026-08-01T16:00:00.000Z",
        lastUsedAt: "2026-08-01T16:00:00.000Z",
      })
    );
    localStorage.setItem("smirk_active_workspace_id", "1");
  });

  await context.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const requestPath = url.pathname;
    if (requestPath === "/api/workspaces") {
      return respond(route, {
        workspaces: [
          { id: 1, name: "SMIRK Demo Workspace", plan: "enterprise" },
        ],
      });
    }
    if (requestPath === "/api/calls/active") return respond(route, []);
    if (requestPath === "/api/stats") {
      return respond(route, {
        totalCalls: 0,
        todayCalls: 0,
        avgDuration: 0,
        conversionRate: 0,
      });
    }
    if (requestPath === "/api/config-status") {
      return respond(route, {
        missingRequired: [],
        warnings: [],
        configured: true,
      });
    }
    if (requestPath === "/api/calls") return respond(route, { calls: [] });
    if (requestPath === "/api/tasks") return respond(route, { tasks: [] });
    if (requestPath === "/api/prospecting/revenue-loop") {
      return respond(route, revenueLoop);
    }
    if (requestPath === "/api/prospecting/campaigns") {
      return respond(route, { campaigns: [campaign] });
    }
    if (requestPath === "/api/prospecting/campaigns/1") {
      return respond(route, {
        leads: [lead],
        funnel: {
          total: 1,
          pending: 1,
          dialed: 0,
          answered: 0,
          interested: 0,
          voicemail: 0,
          not_interested: 0,
          callback: 0,
          converted: 0,
        },
      });
    }
    if (requestPath === "/api/prospecting/sequences/stats") {
      return respond(route, { total: 1, pending: 1, sent: 0, failed: 0 });
    }
    if (requestPath === "/api/prospecting/leads/3/outreach") {
      return respond(route, {
        jobs: [],
        qcRevisions: [revision],
        outcomes: [],
        qcModelReviews: [],
        qcModelProvider: {
          enabled: false,
          configured: false,
          requiredForApproval: false,
          availableForWorkspace: false,
        },
        experimentAssignments: [],
        emailProvider: {
          enabled: false,
          configured: false,
          availableForWorkspace: false,
        },
      });
    }
    if (requestPath === "/api/prospecting/learning/scorecard") {
      return respond(route, {
        variants: [],
        sampleSize: 0,
        eventCount: 0,
        studyDesign: "observational",
      });
    }
    if (requestPath === "/api/prospecting/learning/experiments") {
      return respond(route, { experiments: [] });
    }
    if (requestPath === "/api/prospecting/learning/candidates") {
      return respond(route, { candidates: [] });
    }
    if (requestPath === "/api/prospecting/learning/policies") {
      return respond(route, { policies: [], releases: [] });
    }
    if (requestPath === "/api/prospecting/inbox-placement") {
      return respond(route, {
        tests: [],
        configuration: { configured: false, missing: [] },
        emailProvider: null,
      });
    }
    if (requestPath === "/api/prospecting/velvet-outcomes/outbox") {
      return respond(route, { events: [], dispatch: null });
    }
    if (requestPath === "/api/prospecting/positive-outcomes") {
      return respond(route, { reviews: [] });
    }
    if (requestPath === "/api/prospecting/velvet-source/status") {
      return respond(route, {
        enabled: false,
        configured: false,
        availableForWorkspace: false,
      });
    }
    if (requestPath === "/api/prospecting/velvet-source/requests") {
      return respond(route, { requests: [] });
    }
    if (requestPath === "/api/prospecting/velvet-discovery/status") {
      return respond(route, {
        enabled: false,
        configured: false,
        availableForWorkspace: false,
      });
    }
    if (
      requestPath === "/api/prospecting/velvet-discovery/active-experiment"
    ) {
      return respond(route, { state: "NONE", experiment: null });
    }
    if (requestPath === "/api/prospecting/velvet-discovery/requests") {
      return respond(route, { requests: [] });
    }
    return respond(route, {});
  });
}

async function capture(browser, name, viewport) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
  });
  await installSyntheticApi(context);
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) =>
    pageErrors.push(error.stack || error.message)
  );
  page.on("requestfailed", (request) =>
    requestFailures.push({
      url: request.url(),
      error: request.failure()?.errorText || "unknown",
    })
  );

  await page.goto(`${baseUrl}/dashboard/prospecting`, {
    waitUntil: "networkidle",
  });
  try {
    await page
      .getByRole("heading", { name: "Prospect Research Queue" })
      .waitFor({ timeout: 10_000 });
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          url: page.url(),
          title: await page.title(),
          body: (await page.locator("body").innerText()).slice(0, 2_000),
          consoleErrors,
          pageErrors,
          requestFailures,
        },
        null,
        2
      )
    );
    throw error;
  }
  await page.getByRole("button", { name: "Open prospect" }).click();
  await page.getByText("QC revision queue", { exact: true }).waitFor();

  const revisionCard = page.locator(`#prospect-qc-revision-${revisionId}`);
  await revisionCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);

  const queueVisible = await page
    .getByText(
      "Failed deterministic checks have no approval or execution authority.",
      { exact: true }
    )
    .isVisible();
  const failureVisible = await page
    .getByText(/The guarantee is not supported by the evidence payload\./)
    .isVisible();
  const forbiddenActionCount = await revisionCard
    .getByRole("button", { name: /approve|send/i })
    .count();

  if (!queueVisible || !failureVisible || forbiddenActionCount !== 0) {
    throw new Error(
      JSON.stringify({ queueVisible, failureVisible, forbiddenActionCount })
    );
  }

  const screenshot = path.join(outputDir, name);
  await page.screenshot({ path: screenshot, fullPage: false });
  await context.close();
  return {
    screenshot,
    viewport,
    queueVisible,
    failureVisible,
    forbiddenActionCount,
    consoleErrors,
  };
}

await fs.mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const results = [];
  results.push(
    await capture(browser, "prospect-qc-revision-desktop.png", {
      width: 1440,
      height: 1050,
    })
  );
  results.push(
    await capture(browser, "prospect-qc-revision-mobile.png", {
      width: 390,
      height: 844,
    })
  );
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} finally {
  await browser.close();
}
