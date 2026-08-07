import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import test from "node:test";
import { registerAdminMaintenanceRoutes } from
  "../src/routes/admin-maintenance-routes.js";

const deployVersion = "c".repeat(40);
const operatorKey = "fixture-full-operator";
const callSid = "CA436230540466d83c5a4acb59d974dd4c";

type FakeState = {
  buffer: Array<Record<string, any>>;
  calls: Array<Record<string, any>>;
  audits: Array<Record<string, any>>;
  forceBufferWriteMiss: boolean;
  failAllQueries: boolean;
};

const baseBufferRow = () => ({
  id: 19,
  call_sid: callSid,
  webhook_type: "twilio.incoming",
  workspace_id: 1,
  from_number: "+12025550124",
  to_number: "+17755550100",
  direction: "inbound",
  process_status: "received",
  error: null,
  received_at: new Date("2026-08-07T12:00:00.000Z"),
  processed_at: null,
  payload: {
    CallSid: callSid,
    From: "+12025550124",
    To: "+17755550100",
    Direction: "inbound",
    workspace_id: 1,
  },
});

function restoreState(target: FakeState, snapshot: FakeState) {
  target.buffer = snapshot.buffer;
  target.calls = snapshot.calls;
  target.audits = snapshot.audits;
  target.forceBufferWriteMiss = snapshot.forceBufferWriteMiss;
  target.failAllQueries = snapshot.failAllQueries;
}

function fakeSql(state: FakeState) {
  const query = async (strings: TemplateStringsArray, ...values: any[]) => {
    if (state.failAllQueries) throw new Error("secret-database-detail");
    const text = strings.join(" ? ").replace(/\s+/g, " ").trim();

    if (text.includes("FROM admin_maintenance_action_audit")) {
      if (text.includes("request_digest =")) {
        const digest = String(values[0]);
        return state.audits
          .filter((row) => row.request_digest === digest)
          .map((row) => ({ ...row }));
      }
      return [...state.audits]
        .sort((left, right) =>
          new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
        )
        .slice(0, Number(values[0]) || 20)
        .map((row) => ({ ...row }));
    }
    if (
      text.includes("COUNT(*)::int AS pending_count") &&
      text.includes("FROM webhook_event_buffer")
    ) {
      return [{
        pending_count: state.buffer.filter((row) =>
          ["received", "retry"].includes(row.process_status)
        ).length,
        stale_count: state.buffer.filter((row) =>
          ["received", "retry"].includes(row.process_status)
        ).length,
        oldest_pending_received_at: state.buffer[0]?.received_at || null,
      }];
    }
    if (
      text.includes("FROM webhook_event_buffer") &&
      text.includes("received_at < NOW()") &&
      !text.includes("id = ANY")
    ) {
      return state.buffer
        .filter((row) => ["received", "retry"].includes(row.process_status))
        .map((row) => ({ ...row }));
    }
    if (text.includes("FROM webhook_event_buffer")) {
      const ids = Array.isArray(values[0]) ? values[0].map(Number) : [];
      return state.buffer
        .filter((row) => ids.includes(Number(row.id)))
        .filter((row) => ["received", "retry"].includes(row.process_status))
        .sort((left, right) => left.id - right.id)
        .map((row) => structuredClone(row));
    }
    if (text.includes("FROM calls")) {
      const callSids = Array.isArray(values[0]) ? values[0].map(String) : [];
      return state.calls
        .filter((row) => callSids.includes(row.call_sid))
        .map((row) => ({
          call_sid: row.call_sid,
          workspace_id: row.workspace_id,
          direction: row.direction ?? null,
          from_number: row.from_number ?? null,
          to_number: row.to_number ?? null,
        }));
    }
    if (text.startsWith("INSERT INTO calls")) {
      const [incomingCallSid, direction, toNumber, fromNumber, workspaceId, startedAt] = values;
      const existing = state.calls.find((row) => row.call_sid === incomingCallSid);
      if (existing && Number(existing.workspace_id) !== Number(workspaceId)) {
        return [];
      }
      if (existing) {
        existing.to_number ||= toNumber;
        existing.from_number ||= fromNumber;
      } else {
        state.calls.push({
          call_sid: incomingCallSid,
          direction,
          to_number: toNumber,
          from_number: fromNumber,
          status: "buffered",
          workspace_id: workspaceId,
          started_at: startedAt,
        });
      }
      return [{ call_sid: incomingCallSid }];
    }
    if (text.startsWith("UPDATE webhook_event_buffer")) {
      if (state.forceBufferWriteMiss) return [];
      const [id, expectedCallSid, webhookType, processStatus] = values;
      const row = state.buffer.find((entry) =>
        Number(entry.id) === Number(id) &&
        entry.call_sid === expectedCallSid &&
        entry.webhook_type === webhookType &&
        entry.process_status === processStatus
      );
      if (!row) return [];
      row.process_status = "processed";
      row.processed_at = new Date();
      row.error = null;
      return [{ id: row.id }];
    }
    if (text.startsWith("INSERT INTO admin_maintenance_action_audit")) {
      const [
        contractVersion,
        requestDigest,
        approvalHash,
        actorAuthMode,
        actorRequestId,
        workspaceIds,
        targetIds,
        result,
      ] = values;
      if (state.audits.some((row) =>
        row.action_type === "webhook_buffer_replay" &&
        row.request_digest === requestDigest)) {
        throw new Error("duplicate-audit");
      }
      const created = {
        id: state.audits.length + 1,
        action_type: "webhook_buffer_replay",
        contract_version: contractVersion,
        request_digest: requestDigest,
        approval_hash: approvalHash,
        actor_auth_mode: actorAuthMode,
        actor_request_id: actorRequestId,
        workspace_ids: [...workspaceIds],
        target_ids: [...targetIds],
        intended_action: "replay-buffered-inbound-calls-only",
        result: structuredClone(result),
        created_at: new Date(),
      };
      state.audits.push(created);
      return [{ id: created.id, created_at: created.created_at }];
    }
    throw new Error(`unhandled-query:${text.slice(0, 120)}`);
  };
  const sql: any = query;
  sql.json = (value: unknown) => value;
  sql.begin = async (callback: (tx: any) => Promise<unknown>) => {
    const snapshot = structuredClone(state);
    try {
      return await callback(sql);
    } catch (error) {
      restoreState(state, snapshot);
      throw error;
    }
  };
  return sql;
}

async function createHarness(initial: Partial<FakeState> = {}) {
  const state: FakeState = {
    buffer: [baseBufferRow()],
    calls: [],
    audits: [],
    forceBufferWriteMiss: false,
    failAllQueries: false,
    ...initial,
  };
  const app = express();
  app.use(express.json());
  const dashboardAuth = (req: any, res: any, next: any) => {
    const provided = String(req.headers["x-api-key"] || "");
    if (provided === operatorKey) {
      req.authMode = "operator";
      req.requestId = "fixture-request";
      return next();
    }
    if (provided === "fixture-demo-operator") {
      req.authMode = "demo_operator";
      return next();
    }
    return res.status(401).json({ error: "unauthorized" });
  };
  const requireOperator = (req: any, res: any, next: any) =>
    ["operator", "demo_operator"].includes(req.authMode)
      ? next()
      : res.status(403).json({ error: "operator-required" });
  const requireFullOperator = (req: any, res: any, next: any) =>
    req.authMode === "operator"
      ? next()
      : res.status(403).json({ error: "full-operator-required" });
  registerAdminMaintenanceRoutes(app, {
    dashboardAuth,
    requireOperator,
    requireFullOperator,
    requireProvisioningSecret: requireFullOperator,
    sql: fakeSql(state),
    dbEnabled: true,
    deployVersion,
    resetMonthlyUsage: async () => {},
    log: () => {},
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    state,
    server,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

async function postReplay(
  origin: string,
  body: Record<string, unknown>,
  apiKey = operatorKey
) {
  const response = await fetch(`${origin}/api/admin/webhook-buffer-replay`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, any>,
  };
}

async function getJson(origin: string, path: string, apiKey = operatorKey) {
  const response = await fetch(`${origin}${path}`, {
    headers: { "x-api-key": apiKey },
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, any>,
  };
}

test("the v2 route previews, applies once, audits, and replays idempotently", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.server.close());

  const preview = await postReplay(harness.origin, {
    apply: false,
    selectedIds: [19],
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.ok, true);
  assert.equal(preview.body.mode, "dry-run");
  assert.match(preview.body.requestDigest, /^[a-f0-9]{64}$/);
  assert.match(preview.body.approvalPhrase, /^APPROVE_REPLAY_SMIRK_WEBHOOK_BUFFER:/);
  assert.equal(preview.body.productionWritePerformed, false);
  assert.equal(harness.state.calls.length, 0);
  assert.equal(harness.state.audits.length, 0);

  const forged = await postReplay(harness.origin, {
    apply: true,
    selectedIds: [19],
    requestDigest: preview.body.requestDigest,
    approval: `${preview.body.approvalPhrase} `,
  });
  assert.equal(forged.status, 409);
  assert.equal(forged.body.productionWritePerformed, false);
  assert.equal(harness.state.buffer[0].process_status, "received");
  assert.equal(harness.state.calls.length, 0);

  const applied = await postReplay(harness.origin, {
    apply: true,
    selectedIds: [19],
    requestDigest: preview.body.requestDigest,
    approval: preview.body.approvalPhrase,
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.ok, true);
  assert.equal(applied.body.mode, "apply-verified");
  assert.equal(applied.body.productionWritePerformed, true);
  assert.equal(applied.body.outboundContactPerformed, false);
  assert.equal(applied.body.smsSent, false);
  assert.deepEqual(applied.body.processedIds, [19]);
  assert.equal(harness.state.buffer[0].process_status, "processed");
  assert.equal(harness.state.calls.length, 1);
  assert.equal(harness.state.calls[0].workspace_id, 1);
  assert.equal(harness.state.audits.length, 1);
  assert.equal(harness.state.audits[0].actor_auth_mode, "dashboard_full_operator");
  harness.state.audits[0].result.unexpectedPrivateDetail = "secret-audit-detail";

  const audit = await getJson(
    harness.origin,
    "/api/admin/webhook-buffer-replay/audit?limit=10"
  );
  assert.equal(audit.status, 200);
  assert.equal(audit.body.receipts.length, 1);
  assert.equal(audit.body.receipts[0].requestDigest, preview.body.requestDigest);
  assert.equal(audit.body.receipts[0].actorAuthMode, "dashboard_full_operator");
  assert.equal(audit.body.payloadsExposed, false);
  assert.equal(audit.body.phoneNumbersExposed, false);
  assert.doesNotMatch(JSON.stringify(audit.body), /secret-audit-detail/);

  const replay = await postReplay(harness.origin, {
    apply: true,
    selectedIds: [19],
    requestDigest: preview.body.requestDigest,
    approval: preview.body.approvalPhrase,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.mode, "apply-idempotent-replay");
  assert.equal(replay.body.productionWritePerformed, false);
  assert.equal(harness.state.calls.length, 1);
  assert.equal(harness.state.audits.length, 1);

  harness.state.audits[0].result.processedCount = 0;
  const corruptReceipt = await postReplay(harness.origin, {
    apply: true,
    selectedIds: [19],
    requestDigest: preview.body.requestDigest,
    approval: preview.body.approvalPhrase,
  });
  assert.equal(corruptReceipt.status, 409);
  assert.equal(
    corruptReceipt.body.error,
    "WEBHOOK_REPLAY_PRIOR_RECEIPT_RESULT_MISMATCH"
  );
  assert.equal(harness.state.calls.length, 1);
  assert.equal(harness.state.audits.length, 1);

  harness.state.audits[0].result.processedCount = 1;
  harness.state.audits[0].result.outboundContactPerformed = true;
  const corruptScopeReceipt = await postReplay(harness.origin, {
    apply: true,
    selectedIds: [19],
    requestDigest: preview.body.requestDigest,
    approval: preview.body.approvalPhrase,
  });
  assert.equal(corruptScopeReceipt.status, 409);
  assert.equal(
    corruptScopeReceipt.body.error,
    "WEBHOOK_REPLAY_PRIOR_RECEIPT_RESULT_MISMATCH"
  );

  harness.state.audits[0].result.outboundContactPerformed = false;

  harness.state.audits[0].contract_version = "smirk.webhook-buffer-replay.v1";
  const staleReceipt = await postReplay(harness.origin, {
    apply: true,
    selectedIds: [19],
    requestDigest: preview.body.requestDigest,
    approval: preview.body.approvalPhrase,
  });
  assert.equal(staleReceipt.status, 409);
  assert.equal(
    staleReceipt.body.error,
    "WEBHOOK_REPLAY_PRIOR_RECEIPT_CONTRACT_MISMATCH"
  );
  assert.equal(harness.state.calls.length, 1);
  assert.equal(harness.state.audits.length, 1);
});

test("lag telemetry is bounded, redacted, and full-operator-only", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.server.close());
  harness.state.buffer[0].error = "secret-provider-detail";

  const lag = await getJson(
    harness.origin,
    "/api/admin/webhook-buffer-lag?thresholdMinutes=not-a-number&limit=bad"
  );
  assert.equal(lag.status, 200);
  assert.equal(lag.body.thresholdMinutes, 5);
  assert.equal(lag.body.staleRows.length, 1);
  assert.equal(lag.body.staleRows[0].callSidSuffix, callSid.slice(-6));
  assert.equal(lag.body.staleRows[0].hasError, true);
  assert.equal("callSid" in lag.body.staleRows[0], false);
  assert.equal("error" in lag.body.staleRows[0], false);
  assert.doesNotMatch(JSON.stringify(lag.body), /secret-provider-detail/);

  const demo = await getJson(
    harness.origin,
    "/api/admin/webhook-buffer-lag",
    "fixture-demo-operator"
  );
  assert.equal(demo.status, 403);
});

test("full-operator authorization, workspace isolation, and rollback fail closed", async (t) => {
  await t.test("apply mode and default workspace require exact types", async (subtest) => {
    const harness = await createHarness();
    subtest.after(() => harness.server.close());
    const stringApply = await postReplay(harness.origin, {
      apply: "false",
      selectedIds: [19],
    });
    assert.equal(stringApply.status, 400);
    assert.equal(stringApply.body.error, "explicit-boolean-apply-required");

    const invalidWorkspace = await postReplay(harness.origin, {
      apply: false,
      selectedIds: [19],
      defaultWorkspaceId: "workspace-one",
    });
    assert.equal(invalidWorkspace.status, 400);
    assert.equal(invalidWorkspace.body.error, "invalid-default-workspace-id");
    assert.equal(harness.state.buffer[0].process_status, "received");
    assert.equal(harness.state.calls.length, 0);
    assert.equal(harness.state.audits.length, 0);
  });

  await t.test("demo operator cannot preview or apply", async (subtest) => {
    const harness = await createHarness();
    subtest.after(() => harness.server.close());
    const result = await postReplay(
      harness.origin,
      { apply: false, selectedIds: [19] },
      "fixture-demo-operator"
    );
    assert.equal(result.status, 403);
    assert.equal(harness.state.calls.length, 0);
    const lag = await getJson(
      harness.origin,
      "/api/admin/webhook-buffer-lag",
      "fixture-demo-operator"
    );
    const audit = await getJson(
      harness.origin,
      "/api/admin/webhook-buffer-replay/audit",
      "fixture-demo-operator"
    );
    assert.equal(lag.status, 403);
    assert.equal(audit.status, 403);
  });

  await t.test("existing cross-workspace call blocks every write", async (subtest) => {
    const harness = await createHarness({
      calls: [{ call_sid: callSid, workspace_id: 2 }],
    });
    subtest.after(() => harness.server.close());
    const preview = await postReplay(harness.origin, {
      apply: false,
      selectedIds: [19],
    });
    const applied = await postReplay(harness.origin, {
      apply: true,
      selectedIds: [19],
      requestDigest: preview.body.requestDigest,
      approval: preview.body.approvalPhrase,
    });
    assert.equal(applied.status, 409);
    assert.equal(applied.body.error, "WEBHOOK_REPLAY_EXISTING_CALL_WORKSPACE_MISMATCH");
    assert.equal(harness.state.buffer[0].process_status, "received");
    assert.equal(harness.state.calls.length, 1);
    assert.equal(harness.state.audits.length, 0);
  });

  await t.test("existing same-workspace call with conflicting identity blocks every write", async (subtest) => {
    const harness = await createHarness({
      calls: [{
        call_sid: callSid,
        workspace_id: 1,
        direction: "inbound",
        from_number: "+12025550999",
        to_number: "+17755550100",
      }],
    });
    subtest.after(() => harness.server.close());
    const preview = await postReplay(harness.origin, {
      apply: false,
      selectedIds: [19],
    });
    const applied = await postReplay(harness.origin, {
      apply: true,
      selectedIds: [19],
      requestDigest: preview.body.requestDigest,
      approval: preview.body.approvalPhrase,
    });
    assert.equal(applied.status, 409);
    assert.equal(applied.body.error, "WEBHOOK_REPLAY_EXISTING_CALL_IDENTITY_MISMATCH");
    assert.equal(harness.state.buffer[0].process_status, "received");
    assert.equal(harness.state.calls.length, 1);
    assert.equal(harness.state.audits.length, 0);
  });

  await t.test("zero-row buffer update rolls back the call write", async (subtest) => {
    const harness = await createHarness({ forceBufferWriteMiss: true });
    subtest.after(() => harness.server.close());
    const preview = await postReplay(harness.origin, {
      apply: false,
      selectedIds: [19],
    });
    const applied = await postReplay(harness.origin, {
      apply: true,
      selectedIds: [19],
      requestDigest: preview.body.requestDigest,
      approval: preview.body.approvalPhrase,
    });
    assert.equal(applied.status, 409);
    assert.equal(applied.body.error, "WEBHOOK_REPLAY_BUFFER_WRITE_COUNT_MISMATCH");
    assert.equal(harness.state.buffer[0].process_status, "received");
    assert.equal(harness.state.calls.length, 0);
    assert.equal(harness.state.audits.length, 0);
  });
});

test("payload drift and database failure do not expose details or write", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.server.close());
  const preview = await postReplay(harness.origin, {
    apply: false,
    selectedIds: [19],
  });
  harness.state.buffer[0].payload.CallerName = "Changed after approval";
  const drift = await postReplay(harness.origin, {
    apply: true,
    selectedIds: [19],
    requestDigest: preview.body.requestDigest,
    approval: preview.body.approvalPhrase,
  });
  assert.equal(drift.status, 409);
  assert.ok(drift.body.blockers.includes("WEBHOOK_REPLAY_REQUEST_DIGEST_MISMATCH"));
  assert.equal(harness.state.buffer[0].process_status, "received");
  assert.equal(harness.state.calls.length, 0);

  harness.state.failAllQueries = true;
  const failed = await postReplay(harness.origin, {
    apply: false,
    selectedIds: [19],
  });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error, "webhook-buffer-replay-failed");
  assert.doesNotMatch(JSON.stringify(failed.body), /secret-database-detail/);
});
