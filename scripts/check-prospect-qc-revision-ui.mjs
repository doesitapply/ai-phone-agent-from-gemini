import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

const baseUrl = process.env.SMIRK_UI_PROOF_BASE_URL || "http://127.0.0.1:4180";
const outputDir = path.resolve(
  process.env.SMIRK_UI_PROOF_OUTPUT_DIR || "output/ui-proof"
);
const revisionId = "11111111-1111-4111-8111-111111111111";
const callApprovalId = "22222222-2222-4222-8222-222222222222";
const inboundReplyReviewId =
  "33333333-3333-4333-8333-333333333333";
const inboundReplyApprovalId =
  "44444444-4444-4444-8444-444444444444";
const fixedBrowserTime = "2026-08-01T18:15:00.000Z";

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

const callJob = {
  approval_id: callApprovalId,
  channel: "call",
  state: "APPROVED",
  recipient: "+12025550124",
  content:
    "Manual call brief: ask how after-hours calls are handled. Do not claim consent, urgency, loss, or prior contact.",
  variant_key: "transparent-overflow-call-v1",
  qc_receipt: {
    contractVersion: "smirk.prospect-qc-receipt.v1",
    ruleVersion: "smirk.prospect-qc-rules.v1",
    receiptId: "qcr_synthetic_call_001",
    deterministicPassed: true,
    verdict: "ELIGIBLE_FOR_HUMAN_APPROVAL",
    reviewPriority: "standard",
    failureReasons: [],
    ruleResults: [
      {
        code: "grounded_copy",
        passed: true,
        detail: "The synthetic brief is supported by the displayed evidence.",
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
  payload_hash: "b".repeat(64),
  evidence_hash: "c".repeat(64),
  max_cost_cents: 50,
  expires_at: "2026-08-02T16:00:00.000Z",
  approved_at: "2026-08-01T16:05:00.000Z",
  approval_attestations: {
    callComplianceReceiptHash: "d".repeat(64),
    callComplianceReceipt: {
      recipient: "+12025550124",
      recipientTimezone: "America/Los_Angeles",
      checkedAt: "2026-08-01T16:00:00.000Z",
      validUntil: "2026-08-02T16:00:00.000Z",
      dncChecks: [
        {
          scope: "federal",
          status: "clear",
          source: "Synthetic federal fixture",
          reference: "federal-fixture-001",
        },
        {
          scope: "state",
          status: "clear",
          source: "Synthetic state fixture",
          reference: "state-fixture-001",
        },
        {
          scope: "internal",
          status: "clear",
          source: "Synthetic internal fixture",
          reference: "internal-fixture-001",
        },
      ],
      callingWindow: { start: "09:00", end: "17:00" },
      manualDialOnly: true,
      contactAuthorizedByReceipt: false,
      automatedDialingAuthorized: false,
    },
  },
  created_at: "2026-08-01T16:05:00.000Z",
};

const inboundReplyReview = {
  reviewId: inboundReplyReviewId,
  state: "PENDING",
  businessName: "Silver State Home Services Demo",
  payloadHash: "f".repeat(64),
  payload: {
    sender: "owner@example.test",
    occurredAt: "2026-08-01T18:10:00.000Z",
    inboundMessageId: "email_synthetic_ui_reply_001",
    matchState: "unique",
    candidates: [
      {
        outreachJobId: 18,
        outreachApprovalId: inboundReplyApprovalId,
        prospectId: 3,
        businessName: "Silver State Home Services Demo",
        sentAt: "2026-08-01T17:45:00.000Z",
      },
    ],
  },
  contentReceipt: null,
  contentReceiptHash: null,
  resolutionReceipt: null,
  receivedAt: "2026-08-01T18:10:01.000Z",
};

const inboundReplyContentReceipt = {
  subject: "Re: after-hours call coverage",
  plainText:
    "Yes, I handle the evening calls myself.\nWhat does the backup workflow look like?",
  contentHash: "9".repeat(64),
  contentBytes: 80,
  retrievedBy: "dashboard_operator:synthetic",
  retrievedAt: "2026-08-01T18:15:00.000Z",
  providerReadPerformed: true,
  contactAuthorized: false,
  sendAuthorized: false,
  htmlStored: false,
  attachmentsFetched: false,
};

const revenueLoop = {
  contractVersion: "smirk.prospect-revenue-loop.v11",
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
    const RealDate = Date;
    const fixedTime = RealDate.parse("2026-08-01T18:15:00.000Z");
    class FixedDate extends RealDate {
      constructor(...args) {
        super(...(args.length === 0 ? [fixedTime] : args));
      }

      static now() {
        return fixedTime;
      }
    }
    globalThis.Date = FixedDate;
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
    const requestMethod = route.request().method();
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
        jobs: [callJob],
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
        manualCall: {
          enabled: true,
          configured: true,
          availableForWorkspace: true,
          missing: [],
          mode: "operator-tel-link-v1",
          workspaceId: 1,
          dailyApprovalCap: 1,
          manualDialOnly: true,
          providerExecutionAllowed: false,
          automatedDialingAllowed: false,
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
    if (
      requestPath === "/api/prospecting/email-replies" &&
      requestMethod === "GET"
    ) {
      return respond(route, {
        reviews: [inboundReplyReview],
        filter: "pending",
        controls: {
          humanClassificationRequired: true,
          exactProviderContentRequiredBeforeClassification: true,
          contentRetrievalRequiresFullOperator: true,
          contactAuthorized: false,
          executionAuthorized: false,
          spendAuthorized: false,
          providerRequestAuthorized: false,
        },
        externalAction: "none",
      });
    }
    if (
      requestPath ===
        `/api/prospecting/email-replies/${inboundReplyReviewId}/content` &&
      requestMethod === "POST"
    ) {
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          outcome: "retrieved",
          receipt: inboundReplyContentReceipt,
          receiptHash: "8".repeat(64),
          reviewState: "PENDING",
          controls: {
            providerReadPerformed: true,
            contactAuthorized: false,
            executionAuthorized: false,
            spendAuthorized: false,
            sendAuthorized: false,
          },
          externalAction: "resend_received_email_read",
        }),
      });
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

async function captureManualDial(browser, name, viewport) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
  });
  await installSyntheticApi(context);
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const mutationRequests = [];
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", error =>
    pageErrors.push(error.stack || error.message)
  );
  page.on("requestfailed", request =>
    requestFailures.push({
      url: request.url(),
      error: request.failure()?.errorText || "unknown",
    })
  );
  page.on("request", request => {
    if (
      request.url().includes("/api/") &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method())
    ) {
      mutationRequests.push({ method: request.method(), url: request.url() });
    }
  });

  await page.goto(`${baseUrl}/dashboard/prospecting`, {
    waitUntil: "networkidle",
  });
  await page
    .getByRole("heading", { name: "Prospect Research Queue" })
    .waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Open prospect" }).click();

  const callCard = page.locator(`#prospect-outreach-${callApprovalId}`);
  await callCard.waitFor();
  await callCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);

  const lockedBeforeCheck = await callCard
    .getByRole("button", { name: "Dialer locked" })
    .isDisabled();
  const linkBeforeCheck = await callCard.locator('a[href^="tel:"]').count();
  const windowOpen = await callCard
    .getByText("Manual dial window open", { exact: true })
    .isVisible();
  const proofFieldVisible = await callCard
    .getByText("External completion proof", { exact: true })
    .isVisible();

  await callCard
    .getByLabel(
      "Rechecked the approved recipient and current local calling window"
    )
    .check();
  const dialLink = callCard.getByRole("link", {
    name: "Open phone dialer for +12025550124",
  });
  await dialLink.waitFor();
  const href = await dialLink.getAttribute("href");
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );

  if (
    !lockedBeforeCheck ||
    linkBeforeCheck !== 0 ||
    !windowOpen ||
    !proofFieldVisible ||
    href !== "tel:+12025550124" ||
    mutationRequests.length !== 0 ||
    pageErrors.length !== 0 ||
    requestFailures.length !== 0 ||
    pageOverflow
  ) {
    throw new Error(
      JSON.stringify(
        {
          lockedBeforeCheck,
          linkBeforeCheck,
          windowOpen,
          proofFieldVisible,
          href,
          mutationRequests,
          consoleErrors,
          pageErrors,
          requestFailures,
          pageOverflow,
          fixedBrowserTime,
        },
        null,
        2
      )
    );
  }

  const screenshot = path.join(outputDir, name);
  await page.screenshot({ path: screenshot, fullPage: false });
  await context.close();
  return {
    screenshot,
    viewport,
    fixedBrowserTime,
    lockedBeforeCheck,
    linkBeforeCheck,
    windowOpen,
    proofFieldVisible,
    href,
    mutationRequests,
    consoleErrors,
    pageErrors,
    requestFailures,
    pageOverflow,
  };
}

async function captureInboundReply(browser, name, viewport) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
  });
  await installSyntheticApi(context);
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const mutationRequests = [];
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", error =>
    pageErrors.push(error.stack || error.message)
  );
  page.on("requestfailed", request =>
    requestFailures.push({
      url: request.url(),
      error: request.failure()?.errorText || "unknown",
    })
  );
  page.on("request", request => {
    if (
      request.url().includes("/api/") &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method())
    ) {
      mutationRequests.push({ method: request.method(), url: request.url() });
    }
  });

  await page.goto(`${baseUrl}/dashboard/prospecting`, {
    waitUntil: "networkidle",
  });
  await page
    .getByRole("heading", { name: "Prospect Research Queue" })
    .waitFor({ timeout: 10_000 });

  const reviewCard = page.locator(
    `#revenue-loop-inbound-reply-${inboundReplyReviewId}`
  );
  await reviewCard.waitFor();
  await reviewCard.scrollIntoViewIfNeeded();
  const classificationLocked = await reviewCard
    .getByRole("button", { name: "Record classification" })
    .isDisabled();
  const retrieveButton = reviewCard.getByRole("button", {
    name: "Retrieve exact message",
  });
  await retrieveButton.click();
  await reviewCard
    .getByText("Provider-backed plain text", { exact: true })
    .waitFor();
  const providerTextVisible = await reviewCard
    .getByText(/What does the backup workflow look like\?/)
    .isVisible();
  const retrievalActionGone =
    (await reviewCard
      .getByRole("button", { name: "Retrieve exact message" })
      .count()) === 0;
  const pageOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth
  );

  if (
    !classificationLocked ||
    !providerTextVisible ||
    !retrievalActionGone ||
    mutationRequests.length !== 1 ||
    !mutationRequests[0].url.endsWith(
      `/api/prospecting/email-replies/${inboundReplyReviewId}/content`
    ) ||
    consoleErrors.length !== 0 ||
    pageErrors.length !== 0 ||
    requestFailures.length !== 0 ||
    pageOverflow
  ) {
    throw new Error(
      JSON.stringify(
        {
          classificationLocked,
          providerTextVisible,
          retrievalActionGone,
          mutationRequests,
          consoleErrors,
          pageErrors,
          requestFailures,
          pageOverflow,
        },
        null,
        2
      )
    );
  }

  const screenshot = path.join(outputDir, name);
  await page.screenshot({ path: screenshot, fullPage: false });
  await context.close();
  return {
    screenshot,
    viewport,
    classificationLocked,
    providerTextVisible,
    retrievalActionGone,
    mutationRequests,
    consoleErrors,
    pageErrors,
    requestFailures,
    pageOverflow,
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
  results.push(
    await captureManualDial(browser, "prospect-manual-dial-desktop.png", {
      width: 1440,
      height: 1050,
    })
  );
  results.push(
    await captureManualDial(browser, "prospect-manual-dial-mobile.png", {
      width: 390,
      height: 844,
    })
  );
  results.push(
    await captureInboundReply(browser, "prospect-inbound-reply-desktop.png", {
      width: 1440,
      height: 1050,
    })
  );
  results.push(
    await captureInboundReply(browser, "prospect-inbound-reply-mobile.png", {
      width: 390,
      height: 844,
    })
  );
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} finally {
  await browser.close();
}
