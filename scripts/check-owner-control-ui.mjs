#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

const port = Number(process.env.SMIRK_OWNER_UI_PROOF_PORT || 4182);
const externalBaseUrl = String(
  process.env.SMIRK_OWNER_UI_PROOF_BASE_URL || ""
).trim();
const baseUrl = externalBaseUrl || `http://127.0.0.1:${port}`;
const outputDir = path.resolve(
  process.env.SMIRK_OWNER_UI_PROOF_OUTPUT_DIR ||
    "output/ui-proof/owner-control"
);

const prospectConnections = [
  "Velvet lead discovery",
  "Velvet reviewed-lead source",
  "Prospect email sender",
  "Prospect delivery webhook",
  "Prospect reply receiving",
  "Controlled inbox placement",
  "Advisory QC model",
  "Velvet outcome callback",
  "Revenue-loop observer",
  "Revenue-loop preparer",
].map((label, index) => ({
  id: `connection-${index + 1}`,
  label,
  configured: index < 3,
  enabled: false,
  available: false,
  workspaceId: index < 3 ? 1 : null,
  missing: index < 3 ? [`EXECUTION_SWITCH_${index + 1}`] : [`MISSING_CONFIG_${index + 1}`],
}));

const switchDefinitions = [
  ["VELVET_DISCOVERY_ENABLED", "Velvet discovery"],
  ["VELVET_LEAD_SOURCE_ENABLED", "Velvet reviewed-lead import"],
  ["PROSPECT_REVENUE_LOOP_PREPARER_ENABLED", "Review-item preparation"],
  ["PROSPECT_QC_MODEL_REVIEW_ENABLED", "Advisory QC provider"],
  ["PROSPECT_EMAIL_EXECUTION_ENABLED", "Single-recipient email"],
  ["PROSPECT_EMAIL_WEBHOOK_ENABLED", "Signed email events"],
  ["PROSPECT_EMAIL_RECEIVING_ENABLED", "Reply retrieval"],
  ["VELVET_OUTCOME_DISPATCH_ENABLED", "Velvet outcome dispatch"],
];

const phaseLabels = [
  "Velvet authority",
  "No-contact discovery",
  "Pre-approval QC",
  "Controlled inbox placement",
  "Single-recipient email",
  "Closed-loop learning",
];

const ownerOverview = {
  generatedAt: "2026-08-02T16:00:00.000Z",
  access: {
    role: "operator",
    access: "full_operator",
    fullControl: true,
    readOnlyConsole: true,
    adminAllowlistCount: 1,
    scopes: [
      "workspace administration",
      "call and recovery operations",
      "billing and launch visibility",
      "compliance and audit controls",
    ],
  },
  business: {
    month: "2026-08",
    workspaces: { total: 1, active: 1, entitled: 1, setupComplete: 1 },
    usage: { calls: 12, minutes: 38, aiTokens: 16420, ttsChars: 9400 },
    operations: { openPostCallJobs: 0, failedPostCallJobs: 0 },
    launch: {
      touches: 0,
      spendCents: 0,
      qualifiedConversations: 0,
      bookedDemos: 0,
      paidActivations: 0,
    },
  },
  cost: {
    month: "2026-08",
    currency: "USD",
    estimated: { twilioVoice: 0.57, ai: 0.0049, total: 0.5749 },
    note: "Synthetic tracked estimate. Provider invoices remain authoritative.",
  },
  connections: [],
  credentials: [],
  guardrails: [
    {
      label: "SMS and outbound delivery",
      state: "separate approval gate",
      detail: "No send control is available from this console.",
    },
  ],
  dataSources: ["Synthetic browser fixture; no provider or production request."],
  prospectAcquisition: {
    contractVersion: "smirk.prospect-acquisition-connections.v5",
    source: "process-environment",
    stagedConfigurationReady: false,
    safeStagingState: false,
    redactedPlanDigest: "a".repeat(64),
    connections: prospectConnections,
    executionSwitches: switchDefinitions.map(([key, label]) => ({
      key,
      label,
      state: "safely-disabled",
      enabled: false,
    })),
    workspaceBoundary: { aligned: false, workspaceId: null },
    credentialSeparation: [
      "Velvet source and outcome keys",
      "Velvet and operator keys",
      "Velvet signing secret",
      "Prospect and transactional email keys",
      "Prospect receiving key",
      "QC and general model keys",
      "Observer and operator keys",
      "Preparer and privileged keys",
    ].map((label, index) => ({ id: `separation-${index}`, label, passed: index < 2 })),
    emailCaps: { dailyRecipientCap: 1, dailySpendCapCents: 2, unitCostCents: 1 },
    qcCaps: {
      requiredForApproval: true,
      dailyReviewCap: 1,
      dailySpendCapCents: 1,
      reservedCostCents: 1,
      timeoutMs: 5000,
    },
    usage: {
      availability: "available",
      source: "durable-database",
      period: {
        kind: "rolling-24-hours",
        startsAt: "2026-08-01T16:00:00.000Z",
        endsAt: "2026-08-02T16:00:00.000Z",
      },
      email: {
        available: true,
        recipientsReserved: 0,
        providerAccepted: 0,
        providerFailed: 0,
        providerAttempts: 0,
        reservedSpendCents: 0,
      },
      qc: {
        available: true,
        reviewsReserved: 0,
        completed: 0,
        failedOrUnknown: 0,
        totalTokens: 0,
        reservedSpendCents: 0,
      },
      discovery: {
        available: true,
        requests: 2,
        approved: 1,
        completed: 1,
        providerRequests: 3,
        approvedMaxSpendCents: 25,
      },
      issues: [],
      externalAction: "none",
    },
    phases: phaseLabels.map((label, index) => ({
      id: `phase-${index + 1}`,
      label,
      configurationReady: index === 0,
      safeStagingState: index === 0,
      blockers: index === 0 ? [] : [`PHASE_${index + 1}_CONFIGURATION`],
      explicitApprovalRequired: index > 0,
      externalActionScope: index === 0 ? "read-only-authority-proof" : "bounded-no-contact-research",
      proofsStillRequired: ["One exact harmless proof remains."],
    })),
    blockers: [
      "PROSPECT_ACQUISITION_WORKSPACE_ALIGNMENT",
      "PROSPECT_EMAIL_RESEND_API_KEY",
      "PROSPECT_QC_OPENROUTER_API_KEY_SEPARATION",
    ],
    unproven: [
      "Velvet API-key scopes and owner binding",
      "Resend domain verification and SPF/DKIM/DMARC alignment",
      "deployed commit parity and database migration state",
      "provider delivery, customer response, conversion, or revenue",
    ],
    nextAction: {
      code: "COMPLETE_CONFIGURATION",
      title: "Complete no-contact discovery configuration",
      detail: "PROSPECT_REVENUE_LOOP_PREPARER_API_KEY",
    },
    activation: {
      authorized: false,
      contactAuthorized: false,
      spendAuthorized: false,
      providerMutationPerformed: false,
      allExecutionSwitchesDisabled: true,
    },
    guardrails: {
      coldSmsAllowed: false,
      bulkEmailAllowed: false,
      automatedProspectDialingAllowed: false,
      qcMayAuthorizeContact: false,
      inboundContentMayAuthorizeContact: false,
      providerMutationPerformed: false,
    },
    externalAction: "none",
  },
};

function respond(route, body) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function waitForServer(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function installSyntheticApi(context) {
  await context.addInitScript(() => {
    localStorage.setItem(
      "smirk_operator_session",
      JSON.stringify({
        apiKey: "synthetic-full-operator-key",
        label: "SMIRK Owner",
        role: "operator",
        capabilities: ["owner_control", "admin_api"],
        pages: [],
        spendRestricted: false,
        createdAt: "2026-08-02T16:00:00.000Z",
        lastUsedAt: "2026-08-02T16:00:00.000Z",
      })
    );
    localStorage.setItem("smirk_active_workspace_id", "1");
  });
  await context.route("**/api/**", async (route) => {
    const requestPath = new URL(route.request().url()).pathname;
    if (requestPath === "/api/owner-control/overview") {
      return respond(route, ownerOverview);
    }
    if (requestPath === "/api/workspaces") {
      return respond(route, {
        workspaces: [{ id: 1, name: "SMIRK Synthetic Workspace", plan: "starter" }],
      });
    }
    if (requestPath === "/api/calls/active") return respond(route, []);
    if (requestPath === "/api/calls") return respond(route, { calls: [] });
    if (requestPath === "/api/tasks") return respond(route, { tasks: [] });
    if (requestPath === "/api/stats") {
      return respond(route, {
        totalCalls: 0,
        todayCalls: 0,
        avgDuration: 0,
        conversionRate: 0,
      });
    }
    if (requestPath === "/api/config-status") {
      return respond(route, { missingRequired: [], warnings: [], configured: true });
    }
    return respond(route, {});
  });
}

async function pageProof(browser, viewport, name) {
  const context = await browser.newContext({ viewport });
  await installSyntheticApi(context);
  const page = await context.newPage();
  const runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  await page.goto(`${baseUrl}/dashboard/owner-control`, {
    waitUntil: "networkidle",
  });
  const controlPlane = page.getByRole("region", {
    name: "Prospect acquisition control plane",
  });
  await controlPlane.waitFor({ state: "visible" });
  await page.getByText("Revenue-loop connections", { exact: true }).waitFor();
  await page.getByText("Execution switches", { exact: true }).waitFor();
  await page.getByText("Credential separation", { exact: true }).waitFor();
  await page.getByText("Rolling 24-hour controlled usage", { exact: true }).waitFor();
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    document:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  }));
  if (overflow.body > 1 || overflow.document > 1) {
    throw new Error(`Horizontal overflow at ${viewport.width}px: ${JSON.stringify(overflow)}`);
  }
  if (runtimeErrors.length > 0) {
    throw new Error(`Browser runtime errors: ${runtimeErrors.join(" | ")}`);
  }
  const screenshot = path.join(outputDir, name);
  await page.screenshot({ path: screenshot });
  const controlPlaneDimensions = await controlPlane.evaluate((element) => ({
    width: Math.round(element.getBoundingClientRect().width),
    height: Math.round(element.getBoundingClientRect().height),
  }));
  const usageBand = page
    .getByText("Rolling 24-hour controlled usage", { exact: true })
    .locator("xpath=../../..");
  await usageBand.scrollIntoViewIfNeeded();
  const usageScreenshot = path.join(
    outputDir,
    name.replace(/\.png$/, "-usage.png")
  );
  await usageBand.screenshot({ path: usageScreenshot });
  const usageDimensions = await usageBand.evaluate((element) => ({
    width: Math.round(element.getBoundingClientRect().width),
    height: Math.round(element.getBoundingClientRect().height),
  }));
  await context.close();
  return {
    screenshot: path.relative(process.cwd(), screenshot),
    usageScreenshot: path.relative(process.cwd(), usageScreenshot),
    viewport,
    controlPlaneDimensions,
    usageDimensions,
    overflow,
  };
}

await fs.mkdir(outputDir, { recursive: true });
let preview;
let browser;
try {
  if (!externalBaseUrl) {
    preview = spawn(
      "npm",
      ["run", "-s", "preview", "--", "--host", "127.0.0.1", "--port", String(port)],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
  }
  await waitForServer(baseUrl);
  browser = await chromium.launch({ headless: true });
  const proofs = [
    await pageProof(browser, { width: 1440, height: 1000 }, "owner-control-prospect-desktop.png"),
    await pageProof(browser, { width: 390, height: 844 }, "owner-control-prospect-mobile.png"),
  ];
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    syntheticApiOnly: true,
    productionRequests: 0,
    externalActions: 0,
    proofs,
  };
  await fs.writeFile(
    path.join(outputDir, "owner-control-prospect-ui-proof.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  if (preview && !preview.killed) preview.kill("SIGTERM");
}
