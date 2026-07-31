import assert from "node:assert/strict";
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
  assert.equal(result.externalAction, "none");
  assert.equal(result.guardrails.coldSmsAllowed, false);
  const serialized = JSON.stringify(result);
  for (const key of [
    "VELVET_LEAD_SOURCE_API_KEY",
    "PROSPECT_EMAIL_RESEND_API_KEY",
    "PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET",
    "VELVET_OUTCOME_API_KEY",
    "VELVET_OUTCOME_SIGNING_SECRET",
    "RESEND_API_KEY",
    "DASHBOARD_API_KEY",
    "PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY",
  ]) {
    assert.equal(serialized.includes(env[key]), false, key);
  }
  assert.equal(
    serialized.includes("google-one@example.invalid"),
    false
  );
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
    result.blockers.includes("VELVET_OUTCOME_DISPATCH_ENABLED")
  );
  assert.ok(
    result.blockers.includes(
      "PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY"
    )
  );
  assert.ok(
    result.blockers.includes(
      "PROSPECT_ACQUISITION_WORKSPACE_ALIGNMENT"
    )
  );
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
      .revenueLoopObserverAndOperatorKeysDistinct,
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
      "PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY_SEPARATION"
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
});
