import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticateProspectRevenueLoopObserver,
  readProspectRevenueLoopObserverConfig,
} from "../src/prospect-revenue-loop-observer.ts";

const observerKey = "observer-key-32-characters-minimum-123";
const env = {
  PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY: observerKey,
  PROSPECT_REVENUE_LOOP_OBSERVER_WORKSPACE_ID: "7",
};

test("observer configuration requires a strong key and one workspace", () => {
  assert.deepEqual(readProspectRevenueLoopObserverConfig({}), {
    configured: false,
    available: false,
    workspaceId: null,
    missing: [
      "PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY",
      "PROSPECT_REVENUE_LOOP_OBSERVER_WORKSPACE_ID",
    ],
  });
  assert.equal(
    readProspectRevenueLoopObserverConfig({
      ...env,
      PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY: "too-short",
    }).available,
    false
  );
  assert.equal(
    readProspectRevenueLoopObserverConfig(env).available,
    true
  );
  assert.equal(
    readProspectRevenueLoopObserverConfig({
      ...env,
      DASHBOARD_API_KEY: observerKey,
    }).missing.includes(
      "PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY_SEPARATION"
    ),
    true
  );
});

test("observer key authenticates only the exact GET and locked workspace", () => {
  assert.equal(
    authenticateProspectRevenueLoopObserver({
      method: "GET",
      path: "/api/prospecting/revenue-loop",
      providedApiKey: observerKey,
      env,
    }),
    7
  );
  for (const attempt of [
    {
      method: "POST",
      path: "/api/prospecting/revenue-loop",
      providedApiKey: observerKey,
    },
    {
      method: "GET",
      path: "/api/prospecting/revenue-loop/execute",
      providedApiKey: observerKey,
    },
    {
      method: "GET",
      path: "/api/prospecting/revenue-loop",
      providedApiKey: `${observerKey}-forged`,
    },
  ]) {
    assert.equal(
      authenticateProspectRevenueLoopObserver({
        ...attempt,
        env,
      }),
      null
    );
  }
});
