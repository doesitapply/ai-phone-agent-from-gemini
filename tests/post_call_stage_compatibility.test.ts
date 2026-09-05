import assert from "node:assert/strict";
import test from "node:test";

import {
  POST_CALL_STAGES,
  claimPostCallJobWithStageRepair,
} from "../src/routes/twilio-status-routes.js";

test("claim repairs a legacy post-call job without repeating completed stages", async () => {
  const legacyStageState = new Map<string, string>([
    ["summary", "completed"],
    ["opt_out", "completed"],
    ["call_webhook", "skipped"],
    ["crm_sync", "completed"],
    ["owner_webhook", "skipped"],
    ["owner_alert", "completed"],
  ]);
  const originalStageState = new Map(legacyStageState);
  const insertedStages: string[] = [];
  let claimSql = "";

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    claimSql = strings.join("?");
    const requiredStages = values.find((value): value is string[] => Array.isArray(value));
    assert.deepEqual(requiredStages, [...POST_CALL_STAGES]);
    for (const stage of requiredStages) {
      if (legacyStageState.has(stage)) continue;
      legacyStageState.set(stage, "pending");
      insertedStages.push(stage);
    }
    return Promise.resolve([{
      call_sid: "CA_legacy_post_call_0001",
      workspace_id: 42,
      attempts: 1,
      lease_token: "lease-legacy-0001",
    }]);
  }) as any;

  const claimed = await claimPostCallJobWithStageRepair(
    sql,
    "CA_legacy_post_call_0001",
    "lease-legacy-0001",
  );

  assert.equal(claimed?.call_sid, "CA_legacy_post_call_0001");
  assert.deepEqual(insertedStages, ["velvet_outcome"]);
  assert.equal(legacyStageState.get("velvet_outcome"), "pending");
  for (const [stage, status] of originalStageState) {
    assert.equal(legacyStageState.get(stage), status, `${stage} must retain ${status}`);
  }
  assert.ok(POST_CALL_STAGES.every((stage) => legacyStageState.has(stage)));
  assert.match(claimSql, /WITH claimed_job AS/);
  assert.match(claimSql, /INSERT INTO post_call_processing_stages/);
  assert.match(claimSql, /ON CONFLICT \(call_sid, stage\) DO NOTHING/);
  assert.doesNotMatch(claimSql, /UPDATE post_call_processing_stages\s+SET status/);

  insertedStages.length = 0;
  await claimPostCallJobWithStageRepair(
    sql,
    "CA_legacy_post_call_0001",
    "lease-legacy-0002",
  );
  assert.deepEqual(insertedStages, [], "a retry must not recreate or reset any stage");
});
