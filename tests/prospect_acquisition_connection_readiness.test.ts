import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import {
  buildProspectAcquisitionConnectionReadiness,
  type ProspectAcquisitionConnectionReadiness,
} from "../src/prospect-acquisition-connection-readiness.ts";

function configuredEnv(): Record<string, string> {
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
    PROSPECT_EMAIL_DAILY_RECIPIENT_CAP: "1",
    PROSPECT_EMAIL_DAILY_SPEND_CAP_CENTS: "2",
    PROSPECT_EMAIL_UNIT_COST_CENTS: "1",
    PROSPECT_EMAIL_WEBHOOK_ENABLED: "true",
    PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET:
      `whsec_${"c".repeat(24)}`,
    PROSPECT_INBOX_SEED_ALLOWLIST: [
      "google-one@example.invalid",
      "google-two@example.invalid",
      "microsoft-one@example.invalid",
      "microsoft-two@example.invalid",
      "yahoo-one@example.invalid",
    ].join(","),
    PROSPECT_QC_MODEL_REVIEW_ENABLED: "true",
    PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL: "true",
    PROSPECT_QC_MODEL_REVIEW_MODE:
      "single-draft-advisory-v1",
    PROSPECT_QC_OPENROUTER_API_KEY:
      `sk-or-${"i".repeat(24)}`,
    PROSPECT_QC_OPENROUTER_MODEL:
      "google/gemini-2.5-flash-lite",
    PROSPECT_QC_MODEL_WORKSPACE_ID: "7",
    PROSPECT_QC_MODEL_DAILY_REVIEW_CAP: "2",
    PROSPECT_QC_MODEL_DAILY_SPEND_CAP_CENTS: "2",
    PROSPECT_QC_MODEL_RESERVED_COST_CENTS: "1",
    PROSPECT_QC_MODEL_TIMEOUT_MS: "5000",
    OPENROUTER_API_KEY: `sk-or-${"j".repeat(24)}`,
    VELVET_BASE_URL: "https://velvetalchemy.manus.space",
    VELVET_OUTCOME_API_KEY: `outcome-${"d".repeat(32)}`,
    VELVET_OUTCOME_SIGNING_SECRET: `signing-${"e".repeat(32)}`,
    VELVET_OUTCOME_WORKSPACE_ID: "7",
    VELVET_OUTCOME_DISPATCH_ENABLED: "true",
    RESEND_API_KEY: `re_${"f".repeat(24)}`,
    DASHBOARD_API_KEY: `admin-${"g".repeat(32)}`,
    PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY:
      `observer-${"h".repeat(32)}`,
    PROSPECT_REVENUE_LOOP_OBSERVER_WORKSPACE_ID: "7",
    PROSPECT_REVENUE_LOOP_PREPARER_ENABLED: "true",
    PROSPECT_REVENUE_LOOP_PREPARER_API_KEY:
      `preparer-${"k".repeat(32)}`,
    PROSPECT_REVENUE_LOOP_PREPARER_WORKSPACE_ID: "7",
    PROSPECT_REVENUE_LOOP_DISCOVERY_LIMIT: "10",
    PROSPECT_REVENUE_LOOP_DISCOVERY_CATEGORY: "plumbing",
    PROSPECT_REVENUE_LOOP_DISCOVERY_CITY: "Reno",
    PROSPECT_REVENUE_LOOP_DISCOVERY_STATE: "NV",
  };
}

function report(
  env: Record<string, string | undefined>
): ProspectAcquisitionConnectionReadiness {
  return buildProspectAcquisitionConnectionReadiness({
    env,
    source: "synthetic-test",
  });
}

function authorityOnlyEnv(): Record<string, string> {
  const complete = configuredEnv();
  return {
    VELVET_LEAD_SOURCE_BASE_URL:
      complete.VELVET_LEAD_SOURCE_BASE_URL,
    VELVET_LEAD_SOURCE_API_KEY:
      complete.VELVET_LEAD_SOURCE_API_KEY,
    VELVET_LEAD_SOURCE_WORKSPACE_ID:
      complete.VELVET_LEAD_SOURCE_WORKSPACE_ID,
    VELVET_BASE_URL: complete.VELVET_BASE_URL,
    VELVET_OUTCOME_API_KEY: complete.VELVET_OUTCOME_API_KEY,
    VELVET_OUTCOME_SIGNING_SECRET:
      complete.VELVET_OUTCOME_SIGNING_SECRET,
    VELVET_OUTCOME_WORKSPACE_ID:
      complete.VELVET_OUTCOME_WORKSPACE_ID,
  };
}

test("a complete aligned configuration reports only redacted readiness", () => {
  const env = configuredEnv();
  const result = report(env);
  assert.equal(result.ok, true);
  assert.equal(result.workspaceBoundary.aligned, true);
  assert.equal(result.workspaceBoundary.workspaceId, 7);
  assert.deepEqual(result.emailCaps, {
    dailyRecipientCap: 1,
    dailySpendCapCents: 2,
    unitCostCents: 1,
  });
  assert.deepEqual(result.qcCaps, {
    requiredForApproval: true,
    dailyReviewCap: 2,
    dailySpendCapCents: 2,
    reservedCostCents: 1,
    timeoutMs: 5000,
  });
  assert.equal(
    result.connections.prospectQcModel.available,
    true
  );
  for (const phase of Object.values(result.configurationPhases)) {
    assert.equal(phase.configurationReady, true);
    assert.equal(phase.activationAuthorized, false);
  }
  assert.equal(result.externalAction, "none");
  assert.equal(result.guardrails.coldSmsAllowed, false);
  assert.equal(result.guardrails.qcMayAuthorizeContact, false);
  const serialized = JSON.stringify(result);
  for (const key of [
    "VELVET_LEAD_SOURCE_API_KEY",
    "PROSPECT_EMAIL_RESEND_API_KEY",
    "PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET",
    "PROSPECT_QC_OPENROUTER_API_KEY",
    "OPENROUTER_API_KEY",
    "VELVET_OUTCOME_API_KEY",
    "VELVET_OUTCOME_SIGNING_SECRET",
    "RESEND_API_KEY",
    "DASHBOARD_API_KEY",
    "PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY",
    "PROSPECT_REVENUE_LOOP_PREPARER_API_KEY",
  ]) {
    assert.equal(serialized.includes(env[key]), false, key);
  }
  assert.equal(
    serialized.includes("google-one@example.invalid"),
    false
  );
});

test("the Velvet authority phase is ready before any execution switch is enabled", () => {
  const result = report(authorityOnlyEnv());
  assert.equal(result.ok, false);
  assert.equal(
    result.configurationPhases["velvet-authority"]
      .configurationReady,
    true
  );
  assert.equal(
    result.configurationPhases["velvet-authority"]
      .activationAuthorized,
    false
  );
  assert.equal(
    result.configurationPhases["no-contact-discovery"]
      .configurationReady,
    false
  );
  assert.ok(
    result.configurationPhases["no-contact-discovery"].blockers.includes(
      "VELVET_DISCOVERY_ENABLED"
    )
  );
  assert.equal(
    result.configurationPhases["single-recipient-email"]
      .configurationReady,
    false
  );
});

test("authority rejects API or signing credentials reused across trust boundaries", () => {
  const env = authorityOnlyEnv();
  env.DASHBOARD_API_KEY = env.VELVET_LEAD_SOURCE_API_KEY;
  env.VELVET_OUTCOME_SIGNING_SECRET = env.VELVET_OUTCOME_API_KEY;
  const result = report(env);
  const authority = result.configurationPhases["velvet-authority"];
  assert.equal(authority.configurationReady, false);
  assert.ok(
    authority.blockers.includes("VELVET_OPERATOR_KEY_SEPARATION")
  );
  assert.ok(
    authority.blockers.includes("VELVET_SIGNING_SECRET_SEPARATION")
  );
  assert.equal(
    result.credentialSeparation
      .velvetKeysAndSmirkOperatorKeysDistinct,
    false
  );
  assert.equal(
    result.credentialSeparation.velvetSigningSecretDistinct,
    false
  );
});

test("no-contact discovery can become configuration-ready without email or model execution", () => {
  const complete = configuredEnv();
  const env = authorityOnlyEnv();
  for (const key of [
    "VELVET_DISCOVERY_ENABLED",
    "VELVET_LEAD_SOURCE_ENABLED",
    "PROSPECT_REVENUE_LOOP_PREPARER_ENABLED",
    "PROSPECT_REVENUE_LOOP_PREPARER_API_KEY",
    "PROSPECT_REVENUE_LOOP_PREPARER_WORKSPACE_ID",
    "PROSPECT_REVENUE_LOOP_DISCOVERY_LIMIT",
    "PROSPECT_REVENUE_LOOP_DISCOVERY_CATEGORY",
    "PROSPECT_REVENUE_LOOP_DISCOVERY_CITY",
    "PROSPECT_REVENUE_LOOP_DISCOVERY_STATE",
  ]) {
    env[key] = complete[key];
  }
  const result = report(env);
  assert.equal(result.ok, false);
  assert.equal(
    result.configurationPhases["no-contact-discovery"]
      .configurationReady,
    true
  );
  assert.equal(
    result.configurationPhases["no-contact-discovery"]
      .activationAuthorized,
    false
  );
  assert.equal(
    result.configurationPhases["pre-approval-qc"]
      .configurationReady,
    false
  );
  assert.ok(
    result.configurationPhases["pre-approval-qc"].blockers.includes(
      "PROSPECT_QC_MODEL_REVIEW_ENABLED"
    )
  );
  assert.ok(
    result.configurationPhases["single-recipient-email"].blockers.includes(
      "PROSPECT_EMAIL_EXECUTION_ENABLED"
    )
  );
});

test("a harmless QC lane can be configured while discovery and email remain disabled", () => {
  const complete = configuredEnv();
  const env = authorityOnlyEnv();
  for (const key of [
    "PROSPECT_QC_MODEL_REVIEW_ENABLED",
    "PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL",
    "PROSPECT_QC_MODEL_REVIEW_MODE",
    "PROSPECT_QC_OPENROUTER_API_KEY",
    "PROSPECT_QC_OPENROUTER_MODEL",
    "PROSPECT_QC_MODEL_WORKSPACE_ID",
    "PROSPECT_QC_MODEL_DAILY_REVIEW_CAP",
    "PROSPECT_QC_MODEL_DAILY_SPEND_CAP_CENTS",
    "PROSPECT_QC_MODEL_RESERVED_COST_CENTS",
    "PROSPECT_QC_MODEL_TIMEOUT_MS",
    "OPENROUTER_API_KEY",
  ]) {
    env[key] = complete[key];
  }
  const result = report(env);
  assert.equal(
    result.configurationPhases["pre-approval-qc"]
      .configurationReady,
    true
  );
  assert.equal(
    result.configurationPhases["no-contact-discovery"]
      .configurationReady,
    false
  );
  assert.equal(
    result.configurationPhases["controlled-inbox-placement"]
      .configurationReady,
    false
  );
  assert.equal(
    result.configurationPhases["pre-approval-qc"]
      .activationAuthorized,
    false
  );
});

test("one-recipient email configuration does not require discovery workers to stay enabled", () => {
  const env = configuredEnv();
  env.VELVET_DISCOVERY_ENABLED = "false";
  env.VELVET_LEAD_SOURCE_ENABLED = "false";
  const result = report(env);
  assert.equal(result.ok, false);
  assert.equal(
    result.configurationPhases["no-contact-discovery"]
      .configurationReady,
    false
  );
  assert.equal(
    result.configurationPhases["single-recipient-email"]
      .configurationReady,
    true
  );
  assert.equal(
    result.configurationPhases["single-recipient-email"]
      .activationAuthorized,
    false
  );
  assert.ok(
    result.configurationPhases["single-recipient-email"]
      .proofsStillRequired.some((proof) =>
        proof.includes("Velvet source receipt")
      )
  );
});

test("the phase CLI reports authority readiness without promoting the full stack", () => {
  const cli = new URL(
    "../scripts/check-prospect-acquisition-connections.ts",
    import.meta.url
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      cli.pathname,
      "--process-env",
      "--configuration-phase=velvet-authority",
    ],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        PATH: process.env.PATH || "",
        HOME: process.env.HOME || "",
        ...authorityOnlyEnv(),
      },
      encoding: "utf8",
    }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.requestedConfigurationPhase, "velvet-authority");
  assert.equal(parsed.overallConnectionConfigurationReady, false);
  assert.equal(parsed.phase.activationAuthorized, false);
  assert.equal(parsed.externalAction, "none");
});

test("disabled or absent connections fail closed with named blockers", () => {
  const result = report({});
  assert.equal(result.ok, false);
  assert.equal(result.externalAction, "none");
  assert.ok(result.blockers.includes("VELVET_DISCOVERY_ENABLED"));
  assert.ok(
    result.blockers.includes("PROSPECT_EMAIL_EXECUTION_ENABLED")
  );
  assert.ok(
    result.blockers.includes("PROSPECT_EMAIL_WEBHOOK_ENABLED")
  );
  assert.ok(
    result.blockers.includes("PROSPECT_QC_MODEL_REVIEW_ENABLED")
  );
  assert.ok(
    result.blockers.includes(
      "PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL"
    )
  );
  assert.ok(
    result.blockers.includes("VELVET_OUTCOME_DISPATCH_ENABLED")
  );
  assert.ok(
    result.blockers.includes(
      "PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY"
    )
  );
  assert.ok(
    result.blockers.includes(
      "PROSPECT_REVENUE_LOOP_PREPARER_ENABLED"
    )
  );
  assert.ok(
    result.blockers.includes(
      "PROSPECT_ACQUISITION_WORKSPACE_ALIGNMENT"
    )
  );
});

test("configured advisory QC is not ready unless it is required before approval", () => {
  const env = configuredEnv();
  env.PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL = "false";
  const result = report(env);
  assert.equal(result.ok, false);
  assert.equal(
    result.connections.prospectQcModel.available,
    true
  );
  assert.equal(result.qcCaps.requiredForApproval, false);
  assert.ok(
    result.blockers.includes(
      "PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL"
    )
  );
  assert.equal(result.guardrails.qcMayAuthorizeContact, false);
});

test("workspace drift and credential reuse remain explicit blockers", () => {
  const env = configuredEnv();
  env.VELVET_OUTCOME_WORKSPACE_ID = "8";
  env.VELVET_OUTCOME_API_KEY =
    env.VELVET_LEAD_SOURCE_API_KEY;
  env.RESEND_API_KEY = env.PROSPECT_EMAIL_RESEND_API_KEY;
  env.PROSPECT_REVENUE_LOOP_OBSERVER_WORKSPACE_ID = "9";
  env.PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY =
    env.DASHBOARD_API_KEY;
  env.PROSPECT_REVENUE_LOOP_PREPARER_WORKSPACE_ID = "11";
  env.PROSPECT_REVENUE_LOOP_PREPARER_API_KEY =
    env.VELVET_LEAD_SOURCE_API_KEY;
  env.PROSPECT_QC_MODEL_WORKSPACE_ID = "10";
  env.PROSPECT_QC_OPENROUTER_API_KEY =
    env.OPENROUTER_API_KEY;
  const result = report(env);
  assert.equal(result.ok, false);
  assert.equal(result.workspaceBoundary.aligned, false);
  assert.equal(
    result.credentialSeparation
      .velvetSourceAndOutcomeKeysDistinct,
    false
  );
  assert.equal(
    result.credentialSeparation
      .prospectAndTransactionalEmailKeysDistinct,
    false
  );
  assert.equal(
    result.credentialSeparation
      .prospectQcAndGeneralOpenRouterKeysDistinct,
    false
  );
  assert.equal(
    result.credentialSeparation
      .revenueLoopObserverAndOperatorKeysDistinct,
    false
  );
  assert.equal(
    result.credentialSeparation
      .revenueLoopPreparerAndPrivilegedKeysDistinct,
    false
  );
  assert.ok(
    result.blockers.includes("VELVET_SOURCE_OUTCOME_KEY_SEPARATION")
  );
  assert.ok(
    result.blockers.includes(
      "PROSPECT_TRANSACTIONAL_EMAIL_KEY_SEPARATION"
    )
  );
  assert.ok(
    result.blockers.includes(
      "PROSPECT_QC_OPENROUTER_API_KEY_SEPARATION"
    )
  );
  assert.ok(
    result.blockers.includes(
      "PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY_SEPARATION"
    )
  );
  assert.ok(
    result.blockers.includes(
      "PROSPECT_REVENUE_LOOP_PREPARER_API_KEY_SEPARATION"
    )
  );
});

test("the production checker is read-only and never prints variables", () => {
  const source = fs.readFileSync(
    new URL(
      "../scripts/check-prospect-acquisition-connections.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(source, /railwayVariables/);
  assert.doesNotMatch(source, /railwaySetVariable|variable\s+set/i);
  assert.doesNotMatch(source, /console\.log\(env|JSON\.stringify\(env/);
  assert.match(source, /providerMutationPerformed:\s*false/);
  assert.match(source, /externalAction:\s*"none"/);
  const packageJson = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  assert.match(
    packageJson.scripts["check:prospect-acquisition-connections:remote"],
    /--configuration-phase=velvet-authority/
  );
});
