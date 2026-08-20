import assert from "node:assert/strict";
import test from "node:test";
import {
  WEBHOOK_BUFFER_REPLAY_APPROVAL_PREFIX,
  WEBHOOK_BUFFER_REPLAY_MAX_ROWS,
  buildWebhookBufferReplayPlan,
  evaluateWebhookBufferReplayApproval,
  publicWebhookBufferReplayPlan,
} from "../src/webhook-buffer-replay-contract.mjs";

const runtimeCommit = "a".repeat(40);
const baseRow = {
  id: 19,
  call_sid: "CA436230540466d83c5a4acb59d974dd4c",
  webhook_type: "twilio.incoming",
  workspace_id: 1,
  from_number: "+12025550124",
  to_number: "+17755550100",
  direction: "inbound",
  process_status: "received",
  received_at: "2026-08-07T12:00:00.000Z",
  payload: {
    CallSid: "CA436230540466d83c5a4acb59d974dd4c",
    From: "+12025550124",
    To: "+17755550100",
    Direction: "inbound",
    workspace_id: 1,
  },
};

test("an exact inbound replay snapshot produces one digest-bound approval", () => {
  const plan = buildWebhookBufferReplayPlan({
    requestedIds: [19],
    rows: [baseRow],
    runtimeCommit,
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.blockers, []);
  assert.match(plan.requestDigest, /^[a-f0-9]{64}$/);
  assert.ok(plan.approvalPhrase?.startsWith(
    `${WEBHOOK_BUFFER_REPLAY_APPROVAL_PREFIX}: digest=`
  ));
  assert.match(plan.approvalPhrase || "", /rows=19: workspace=1/);
  assert.match(
    plan.approvalPhrase || "",
    /action=replay-buffered-inbound-calls-only$/
  );

  const approved = evaluateWebhookBufferReplayApproval({
    plan,
    providedApproval: plan.approvalPhrase,
    providedRequestDigest: plan.requestDigest,
  });
  assert.equal(approved.authorized, true);
  assert.equal(approved.replayAuthorized, true);
  assert.equal(approved.outboundContactAuthorized, false);
  assert.equal(approved.smsAuthorized, false);
  assert.equal(approved.deploymentAuthorized, false);
  assert.equal(approved.deletionAuthorized, false);
});

test("payload, status, workspace, and runtime drift change or invalidate approval", () => {
  const baseline = buildWebhookBufferReplayPlan({
    requestedIds: [19],
    rows: [baseRow],
    runtimeCommit,
  });
  const changedPayload = buildWebhookBufferReplayPlan({
    requestedIds: [19],
    rows: [{
      ...baseRow,
      payload: { ...baseRow.payload, CallerName: "Synthetic Caller" },
    }],
    runtimeCommit,
  });
  assert.equal(changedPayload.ok, true);
  assert.notEqual(changedPayload.requestDigest, baseline.requestDigest);
  assert.notEqual(changedPayload.approvalPhrase, baseline.approvalPhrase);

  for (const entry of [
    {
      expected: "WEBHOOK_REPLAY_STATUS_NOT_REPLAYABLE",
      row: { ...baseRow, process_status: "processed" },
      commit: runtimeCommit,
    },
    {
      expected: "WEBHOOK_REPLAY_WORKSPACE_CONFLICT",
      row: { ...baseRow, payload: { ...baseRow.payload, workspace_id: 2 } },
      commit: runtimeCommit,
    },
    {
      expected: "WEBHOOK_REPLAY_TYPE_NOT_INBOUND_CALL",
      row: { ...baseRow, webhook_type: "twilio.status" },
      commit: runtimeCommit,
    },
    {
      expected: "WEBHOOK_REPLAY_DIRECTION_NOT_INBOUND",
      row: {
        ...baseRow,
        direction: "outbound-api",
        payload: { ...baseRow.payload, Direction: "outbound-api" },
      },
      commit: runtimeCommit,
    },
    {
      expected: "WEBHOOK_REPLAY_RUNTIME_COMMIT_UNCONFIRMED",
      row: baseRow,
      commit: "dev",
    },
  ]) {
    const plan = buildWebhookBufferReplayPlan({
      requestedIds: [19],
      rows: [entry.row],
      runtimeCommit: entry.commit,
    });
    assert.equal(plan.ok, false, entry.expected);
    assert.ok(plan.blockers.includes(entry.expected), entry.expected);
    assert.equal(plan.approvalPhrase, null, entry.expected);
  }
});

test("selection cardinality, duplicates, and multi-workspace batches fail closed", () => {
  const missing = buildWebhookBufferReplayPlan({
    requestedIds: [19, 21],
    rows: [baseRow],
    runtimeCommit,
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.blockers.includes("WEBHOOK_REPLAY_SELECTION_DRIFT"));
  assert.deepEqual(missing.missingIds, [21]);

  const duplicate = buildWebhookBufferReplayPlan({
    requestedIds: [19, 19],
    rows: [baseRow],
    runtimeCommit,
  });
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.blockers.includes("WEBHOOK_REPLAY_ROW_ID_DUPLICATE"));

  const tooManyIds = Array.from(
    { length: WEBHOOK_BUFFER_REPLAY_MAX_ROWS + 1 },
    (_, index) => index + 1
  );
  const tooMany = buildWebhookBufferReplayPlan({
    requestedIds: tooManyIds,
    rows: [],
    runtimeCommit,
  });
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.blockers.includes("WEBHOOK_REPLAY_ROW_LIMIT_EXCEEDED"));

  const secondRow = {
    ...baseRow,
    id: 21,
    call_sid: "CA56c12ce651ebfa314ae4bd07901192a2",
    workspace_id: 2,
    payload: {
      ...baseRow.payload,
      CallSid: "CA56c12ce651ebfa314ae4bd07901192a2",
      workspace_id: 2,
    },
  };
  const multipleWorkspaces = buildWebhookBufferReplayPlan({
    requestedIds: [19, 21],
    rows: [baseRow, secondRow],
    runtimeCommit,
  });
  assert.equal(multipleWorkspaces.ok, false);
  assert.ok(multipleWorkspaces.blockers.includes(
    "WEBHOOK_REPLAY_WORKSPACE_SET_INVALID"
  ));
});

test("forged and stale approvals are rejected with no broadened authority", () => {
  const plan = buildWebhookBufferReplayPlan({
    requestedIds: [19],
    rows: [baseRow],
    runtimeCommit,
  });
  const forged = evaluateWebhookBufferReplayApproval({
    plan,
    providedApproval: `${plan.approvalPhrase} `,
    providedRequestDigest: plan.requestDigest,
  });
  assert.equal(forged.authorized, false);
  assert.ok(forged.blockers.includes("WEBHOOK_REPLAY_EXACT_APPROVAL_MISSING"));

  const stale = evaluateWebhookBufferReplayApproval({
    plan,
    providedApproval: plan.approvalPhrase,
    providedRequestDigest: "b".repeat(64),
  });
  assert.equal(stale.authorized, false);
  assert.ok(stale.blockers.includes("WEBHOOK_REPLAY_REQUEST_DIGEST_MISMATCH"));
  assert.equal(stale.outboundContactAuthorized, false);
  assert.equal(stale.smsAuthorized, false);
});

test("the public plan omits call and phone values while retaining proof hashes", () => {
  const plan = buildWebhookBufferReplayPlan({
    requestedIds: [19],
    rows: [baseRow],
    runtimeCommit,
  });
  const publicPlan = publicWebhookBufferReplayPlan(plan);
  const serialized = JSON.stringify(publicPlan);
  assert.doesNotMatch(serialized, /CA436230540466d83c5a4acb59d974dd4c/);
  assert.doesNotMatch(serialized, /\+12025550124|\+17755550100/);
  assert.equal(publicPlan.replayRows[0]?.callSidSuffix, "74dd4c");
  assert.match(publicPlan.replayRows[0]?.payloadHash || "", /^[a-f0-9]{64}$/);
  assert.match(publicPlan.replayRows[0]?.rowDigest || "", /^[a-f0-9]{64}$/);
});
