import assert from "node:assert/strict";
import test from "node:test";
import {
  PROSPECT_REVENUE_LOOP_PREPARER_PATH,
  authenticateProspectRevenueLoopPreparer,
  buildProspectRevenueLoopPreparerControls,
  buildProspectRevenueLoopPreparerRequestId,
  readProspectRevenueLoopPreparerConfig,
} from "../src/prospect-revenue-loop-preparer.ts";

const preparerKey = `preparer-${"p".repeat(32)}`;
const env = {
  PROSPECT_REVENUE_LOOP_PREPARER_ENABLED: "true",
  PROSPECT_REVENUE_LOOP_PREPARER_API_KEY: preparerKey,
  PROSPECT_REVENUE_LOOP_PREPARER_WORKSPACE_ID: "7",
  PROSPECT_REVENUE_LOOP_DISCOVERY_LIMIT: "10",
  PROSPECT_REVENUE_LOOP_DISCOVERY_CATEGORY: "plumbing",
  PROSPECT_REVENUE_LOOP_DISCOVERY_CITY: "Reno",
  PROSPECT_REVENUE_LOOP_DISCOVERY_STATE: "NV",
  PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY: `observer-${"o".repeat(32)}`,
  DASHBOARD_API_KEY: `operator-${"a".repeat(32)}`,
};

test("preparer configuration requires an enabled dedicated key, one workspace, and bounded criteria", () => {
  const missing = readProspectRevenueLoopPreparerConfig({});
  assert.equal(missing.configured, false);
  for (const expected of [
    "PROSPECT_REVENUE_LOOP_PREPARER_ENABLED",
    "PROSPECT_REVENUE_LOOP_PREPARER_API_KEY",
    "PROSPECT_REVENUE_LOOP_PREPARER_WORKSPACE_ID",
    "PROSPECT_REVENUE_LOOP_DISCOVERY_LIMIT",
    "PROSPECT_REVENUE_LOOP_DISCOVERY_CATEGORY",
    "PROSPECT_REVENUE_LOOP_DISCOVERY_CITY",
    "PROSPECT_REVENUE_LOOP_DISCOVERY_STATE",
  ]) {
    assert.ok(missing.missing.includes(expected), expected);
  }

  const configured = readProspectRevenueLoopPreparerConfig(env);
  assert.equal(configured.configured, true);
  assert.equal(configured.workspaceId, 7);
  assert.deepEqual(configured.criteria, {
    limit: 10,
    category: "plumbing",
    city: "Reno",
    state: "NV",
    learningMode: "none",
  });

  const reused = readProspectRevenueLoopPreparerConfig({
    ...env,
    PROSPECT_REVENUE_LOOP_PREPARER_API_KEY:
      env.PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY,
  });
  assert.equal(reused.configured, false);
  assert.ok(
    reused.missing.includes(
      "PROSPECT_REVENUE_LOOP_PREPARER_API_KEY_SEPARATION"
    )
  );
  const reusedProviderKey = readProspectRevenueLoopPreparerConfig({
    ...env,
    PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET:
      env.PROSPECT_REVENUE_LOOP_PREPARER_API_KEY,
  });
  assert.ok(
    reusedProviderKey.missing.includes(
      "PROSPECT_REVENUE_LOOP_PREPARER_API_KEY_SEPARATION"
    )
  );
});

test("preparer key authenticates only the exact POST route", () => {
  assert.equal(
    authenticateProspectRevenueLoopPreparer({
      method: "POST",
      path: PROSPECT_REVENUE_LOOP_PREPARER_PATH,
      providedApiKey: preparerKey,
      env,
    }),
    7
  );
  for (const attempt of [
    { method: "GET", path: PROSPECT_REVENUE_LOOP_PREPARER_PATH },
    {
      method: "POST",
      path: "/api/prospecting/velvet-discovery/requests",
    },
    {
      method: "POST",
      path: `${PROSPECT_REVENUE_LOOP_PREPARER_PATH}/approve`,
    },
  ]) {
    assert.equal(
      authenticateProspectRevenueLoopPreparer({
        ...attempt,
        providedApiKey: preparerKey,
        env,
      }),
      null
    );
  }
  assert.equal(
    authenticateProspectRevenueLoopPreparer({
      method: "POST",
      path: PROSPECT_REVENUE_LOOP_PREPARER_PATH,
      providedApiKey: `${preparerKey}-forged`,
      env,
    }),
    null
  );
});

test("one workspace and UTC day produce one deterministic review slot", () => {
  const input = {
    workspaceId: 7,
    criteria: readProspectRevenueLoopPreparerConfig(env).criteria!,
    requestedAt: new Date("2026-08-01T23:59:59.000Z"),
  };
  const first = buildProspectRevenueLoopPreparerRequestId(input);
  assert.equal(first, buildProspectRevenueLoopPreparerRequestId(input));
  assert.match(first, /^smirk-auto-discovery-20260801-[a-f0-9]{24}$/);
  assert.notEqual(
    first,
    buildProspectRevenueLoopPreparerRequestId({
      ...input,
      requestedAt: new Date("2026-08-02T00:00:00.000Z"),
    })
  );
  assert.deepEqual(buildProspectRevenueLoopPreparerControls(), {
    reviewOnly: true,
    humanApprovalRequired: true,
    contactAuthorized: false,
    executionAuthorized: false,
    spendAuthorized: false,
    providerRequestAuthorized: false,
    policyMutationAuthorized: false,
    automatedSendingAuthorized: false,
    automatedDialingAuthorized: false,
  });
});
