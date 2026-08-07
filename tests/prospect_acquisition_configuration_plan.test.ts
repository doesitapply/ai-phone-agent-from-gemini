import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { buildProspectAcquisitionConfigurationPlan } from "../src/prospect-acquisition-configuration-plan.ts";

function authorityEnv(): Record<string, string> {
  return {
    VELVET_LEAD_SOURCE_BASE_URL:
      "https://velvetalchemy.manus.space",
    VELVET_BASE_URL: "https://velvetalchemy.manus.space",
    VELVET_LEAD_SOURCE_API_KEY: `research-${"a".repeat(32)}`,
    VELVET_OUTCOME_API_KEY: `outcome-${"b".repeat(32)}`,
    VELVET_OUTCOME_SIGNING_SECRET: `signing-${"c".repeat(32)}`,
    VELVET_LEAD_SOURCE_WORKSPACE_ID: "7",
    VELVET_OUTCOME_WORKSPACE_ID: "7",
    DASHBOARD_API_KEY: `dashboard-${"d".repeat(32)}`,
  };
}

function qcEnv(): Record<string, string> {
  return {
    ...authorityEnv(),
    PROSPECT_QC_MODEL_REVIEW_ENABLED: "false",
    PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL: "true",
    PROSPECT_QC_MODEL_REVIEW_MODE: "single-draft-advisory-v1",
    PROSPECT_QC_OPENROUTER_API_KEY: `sk-or-${"e".repeat(24)}`,
    PROSPECT_QC_OPENROUTER_MODEL: "google/gemini-2.5-flash",
    PROSPECT_QC_MODEL_WORKSPACE_ID: "7",
    PROSPECT_QC_MODEL_DAILY_REVIEW_CAP: "1",
    PROSPECT_QC_MODEL_DAILY_SPEND_CAP_CENTS: "1",
    PROSPECT_QC_MODEL_RESERVED_COST_CENTS: "1",
    PROSPECT_QC_MODEL_TIMEOUT_MS: "5000",
    OPENROUTER_API_KEY: `sk-or-${"f".repeat(24)}`,
  };
}

function fullyStagedEnv(): Record<string, string> {
  return {
    ...qcEnv(),
    VELVET_DISCOVERY_ENABLED: "false",
    VELVET_LEAD_SOURCE_ENABLED: "false",
    PROSPECT_REVENUE_LOOP_PREPARER_ENABLED: "false",
    PROSPECT_REVENUE_LOOP_PREPARER_API_KEY:
      `preparer-${"g".repeat(32)}`,
    PROSPECT_REVENUE_LOOP_PREPARER_WORKSPACE_ID: "7",
    PROSPECT_REVENUE_LOOP_DISCOVERY_LIMIT: "1",
    PROSPECT_REVENUE_LOOP_DISCOVERY_CATEGORY: "plumbing",
    PROSPECT_REVENUE_LOOP_DISCOVERY_CITY: "Reno",
    PROSPECT_REVENUE_LOOP_DISCOVERY_STATE: "NV",
    PROSPECT_EMAIL_EXECUTION_ENABLED: "false",
    PROSPECT_EMAIL_EXECUTION_MODE:
      "single-recipient-reviewed-v1",
    PROSPECT_EMAIL_RESEND_API_KEY: `re_${"h".repeat(24)}`,
    PROSPECT_EMAIL_FROM: "SMIRK <outreach@smirkcalls.com>",
    PROSPECT_EMAIL_REPLY_TO: "reply@smirkcalls.com",
    PROSPECT_EMAIL_WORKSPACE_ID: "7",
    PROSPECT_EMAIL_DAILY_RECIPIENT_CAP: "1",
    PROSPECT_EMAIL_DAILY_SPEND_CAP_CENTS: "2",
    PROSPECT_EMAIL_UNIT_COST_CENTS: "1",
    PROSPECT_EMAIL_WEBHOOK_ENABLED: "false",
    PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET:
      `whsec_${"i".repeat(24)}`,
    PROSPECT_INBOX_SEED_ALLOWLIST: [
      "google-one@example.invalid",
      "google-two@example.invalid",
      "microsoft-one@example.invalid",
      "microsoft-two@example.invalid",
      "yahoo-one@example.invalid",
    ].join(","),
    PROSPECT_EMAIL_RECEIVING_ENABLED: "false",
    PROSPECT_EMAIL_RECEIVING_MODE:
      "operator-reviewed-content-v1",
    PROSPECT_EMAIL_RESEND_RECEIVING_API_KEY:
      `re_${"j".repeat(24)}`,
    PROSPECT_EMAIL_RECEIVING_WORKSPACE_ID: "7",
    PROSPECT_MANUAL_CALL_ENABLED: "false",
    PROSPECT_MANUAL_CALL_MODE: "operator-tel-link-v1",
    PROSPECT_MANUAL_CALL_WORKSPACE_ID: "7",
    PROSPECT_MANUAL_CALL_DAILY_APPROVAL_CAP: "1",
    PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY:
      `observer-${"k".repeat(32)}`,
    PROSPECT_REVENUE_LOOP_OBSERVER_WORKSPACE_ID: "7",
    VELVET_OUTCOME_DISPATCH_ENABLED: "false",
    RESEND_API_KEY: `re_${"l".repeat(24)}`,
  };
}

test("a fully staged QC phase is reviewable while model spend remains disabled", () => {
  const plan = buildProspectAcquisitionConfigurationPlan({
    phase: "pre-approval-qc",
    env: qcEnv(),
    source: "synthetic-test",
  });
  assert.equal(plan.stagedConfigurationReady, true);
  assert.equal(plan.safeStagingState, true);
  assert.equal(plan.runtimePhaseConfigurationReady, false);
  assert.equal(plan.activation.authorized, false);
  assert.equal(plan.activation.allExecutionSwitchesDisabled, true);
  assert.deepEqual(plan.activation.enabledSwitches, []);
  assert.ok(
    plan.activation.switchNames.includes(
      "PROSPECT_QC_MODEL_REVIEW_ENABLED"
    )
  );
  assert.equal(plan.guardrails.providerMutationPerformed, false);
  assert.equal(plan.guardrails.spendAuthorized, false);
});

test("all seven phases can be staged while every execution switch remains disabled", () => {
  const env = fullyStagedEnv();
  const phases = [
    "velvet-authority",
    "no-contact-discovery",
    "pre-approval-qc",
    "controlled-inbox-placement",
    "single-recipient-email",
    "single-recipient-manual-call",
    "closed-loop-learning",
  ] as const;
  for (const phase of phases) {
    const plan = buildProspectAcquisitionConfigurationPlan({
      phase,
      env,
      source: "synthetic-test",
    });
    assert.equal(
      plan.stagedConfigurationReady,
      true,
      `${phase}: ${plan.stagedConfigurationBlockers.join(", ")}`
    );
    assert.equal(plan.safeStagingState, true, phase);
    assert.equal(plan.activation.authorized, false, phase);
    assert.equal(
      plan.activation.allExecutionSwitchesDisabled,
      true,
      phase
    );
  }
  const closedLoop = buildProspectAcquisitionConfigurationPlan({
    phase: "closed-loop-learning",
    env,
    source: "synthetic-test",
  });
  assert.equal(closedLoop.activation.switchNames.length, 9);
  const serialized = JSON.stringify(closedLoop);
  for (const secretName of [
    "VELVET_LEAD_SOURCE_API_KEY",
    "VELVET_OUTCOME_API_KEY",
    "VELVET_OUTCOME_SIGNING_SECRET",
    "PROSPECT_QC_OPENROUTER_API_KEY",
    "PROSPECT_EMAIL_RESEND_API_KEY",
    "PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET",
    "PROSPECT_EMAIL_RESEND_RECEIVING_API_KEY",
    "PROSPECT_REVENUE_LOOP_PREPARER_API_KEY",
    "PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY",
  ]) {
    assert.equal(serialized.includes(env[secretName]), false, secretName);
  }
});

test("an enabled execution switch is surfaced and never treated as approval", () => {
  const env = qcEnv();
  env.PROSPECT_QC_MODEL_REVIEW_ENABLED = "true";
  const plan = buildProspectAcquisitionConfigurationPlan({
    phase: "pre-approval-qc",
    env,
    source: "synthetic-test",
  });
  assert.equal(plan.stagedConfigurationReady, true);
  assert.equal(plan.safeStagingState, false);
  assert.equal(plan.runtimePhaseConfigurationReady, true);
  assert.equal(plan.activation.authorized, false);
  assert.deepEqual(plan.activation.enabledSwitches, [
    "PROSPECT_QC_MODEL_REVIEW_ENABLED",
  ]);
});

test("the plan reports missing and drifted fixed values without leaking secrets", () => {
  const env = qcEnv();
  env.PROSPECT_QC_MODEL_TIMEOUT_MS = "9000";
  delete env.PROSPECT_QC_OPENROUTER_API_KEY;
  const plan = buildProspectAcquisitionConfigurationPlan({
    phase: "pre-approval-qc",
    env,
    source: "synthetic-test",
  });
  assert.equal(plan.stagedConfigurationReady, false);
  assert.ok(
    plan.stagedConfigurationBlockers.includes(
      "PROSPECT_QC_OPENROUTER_API_KEY"
    )
  );
  assert.ok(
    plan.stagedConfigurationBlockers.includes(
      "PROSPECT_QC_MODEL_TIMEOUT_MS"
    )
  );
  const serialized = JSON.stringify(plan);
  assert.equal(
    serialized.includes(env.VELVET_OUTCOME_SIGNING_SECRET),
    false
  );
  assert.equal(
    serialized.includes(env.VELVET_LEAD_SOURCE_API_KEY),
    false
  );
  assert.equal(plan.guardrails.currentEnvironmentValuesDisclosed, false);
});

test("the CLI requires an explicit phase and has no mutation path", () => {
  const cliUrl = new URL(
    "../scripts/plan-prospect-acquisition-configuration.ts",
    import.meta.url
  );
  const withoutPhase = spawnSync(
    process.execPath,
    ["--import", "tsx", cliUrl.pathname, "--process-env"],
    {
      cwd: new URL("..", import.meta.url),
      env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "" },
      encoding: "utf8",
    }
  );
  assert.equal(withoutPhase.status, 2);
  assert.equal(JSON.parse(withoutPhase.stdout).code, "PHASE_REQUIRED");

  const source = fs.readFileSync(cliUrl, "utf8");
  assert.match(source, /railwayVariables/);
  assert.doesNotMatch(
    source,
    /railwaySetVariable|railwayStageDeleteVariable|--apply|variable\s+set/i
  );
  assert.match(source, /providerMutationPerformed:\s*false/);
  assert.match(source, /contactAuthorized:\s*false/);
  assert.match(source, /spendAuthorized:\s*false/);
});

test("the process-environment CLI returns a redacted safe staging receipt", () => {
  const cliUrl = new URL(
    "../scripts/plan-prospect-acquisition-configuration.ts",
    import.meta.url
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      cliUrl.pathname,
      "--process-env",
      "--phase=pre-approval-qc",
    ],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        PATH: process.env.PATH || "",
        HOME: process.env.HOME || "",
        ...qcEnv(),
      },
      encoding: "utf8",
    }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.safeStagingState, true);
  assert.equal(parsed.activation.authorized, false);
  assert.equal(parsed.externalAction, "none");
});
