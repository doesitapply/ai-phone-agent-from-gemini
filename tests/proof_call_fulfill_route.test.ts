import assert from "node:assert/strict";
import test from "node:test";

import { digestExactProofCallTarget } from "../src/proof-call-binding.js";
import { registerOutboundCallRoutes } from "../src/routes/outbound-call-routes.js";

const PROOF_REQUEST_ID = 501;
const WORKSPACE_ID = 41;
const PROVISIONING_REQUEST_ID = 73;
const TARGET = "+17754204485";
const FROM = "+17755550123";
const CALL_SID = `CA${"a".repeat(32)}`;
const ACCOUNT_SID = `AC${"b".repeat(32)}`;

type ActivationEvent = {
  id: number;
  workspace_id: number;
  provisioning_request_id: number | null;
  event_type: string;
  status: string;
  actor: string;
  detail: Record<string, unknown>;
};

type HarnessOptions = {
  preDialFailures?: number;
  providerError?: Error;
  acceptedPersistenceFailures?: number;
  terminalPersistenceFailures?: number;
  proofTargetDigest?: string;
  providerDateCreated?: string;
};

type CapturedResponse = {
  status: number;
  body: any;
};

function createHarness(options: HarnessOptions = {}) {
  let handler: ((req: any, res: any) => Promise<unknown>) | null = null;
  let reconcileHandler: ((req: any, res: any) => Promise<unknown>) | null = null;
  let nextClaimId = 900;
  let preDialFailuresRemaining = options.preDialFailures || 0;
  let acceptedPersistenceFailuresRemaining = options.acceptedPersistenceFailures || 0;
  let terminalPersistenceFailuresRemaining = options.terminalPersistenceFailures || 0;
  let telephonyLookups = 0;
  let dialCount = 0;
  let providerFetches = 0;
  let activeProofRequestId = PROOF_REQUEST_ID;

  const activationEvents: ActivationEvent[] = [];
  const callRows: Array<{ callSid: string; to: string; from: string; workspaceId: number }> = [];
  const messageRows: Array<{ callSid: string; text: string }> = [];
  const dialPayloads: any[] = [];

  const proofRequest = {
    id: PROOF_REQUEST_ID,
    workspace_id: WORKSPACE_ID,
    provisioning_request_id: PROVISIONING_REQUEST_ID,
    event_type: "proof_call_requested",
    status: "open",
    actor: "customer",
    detail: {
      auth_mode: "workspace",
      auth_provenance: "workspace_bearer_token",
      proof_target_e164_sha256: options.proofTargetDigest || digestExactProofCallTarget(TARGET),
    },
    business_name: "Fixture Plumbing",
    proof_call_target: TARGET,
    proof_target_digest: options.proofTargetDigest || digestExactProofCallTarget(TARGET),
  };

  const sql = async (parts: TemplateStringsArray, ...values: any[]) => {
    const query = parts.join("?").replace(/\s+/g, " ").trim();

    if (query.startsWith("SELECT ae.id") && query.includes("proof_call_requested")) {
      const requestedProofId = Number(values[0]);
      const requestedWorkspaceId = Number(values[1]);
      return requestedProofId === activeProofRequestId && requestedWorkspaceId === WORKSPACE_ID
        ? [{ ...proofRequest, id: activeProofRequestId }]
        : [];
    }

    if (query.startsWith("SELECT claim.id") && query.includes("outcome_unknown")) {
      const requestedProofId = Number(values[0]);
      const requestedWorkspaceId = Number(values[1]);
      const claim = activationEvents.find((event) => (
        event.workspace_id === requestedWorkspaceId
        && ["proof_call_dispatch_claimed", "proof_call_dispatched"].includes(event.event_type)
        && ["open", "outcome_unknown", "in_progress"].includes(event.status)
        && event.detail.proof_request_event_id === String(requestedProofId)
      ));
      return claim ? [{
        id: claim.id,
        provisioning_request_id: claim.provisioning_request_id,
        event_type: claim.event_type,
        status: claim.status,
        created_at: new Date().toISOString(),
        stored_call_sid: claim.detail.call_sid || null,
        proof_target_digest: proofRequest.proof_target_digest,
        business_name: proofRequest.business_name,
      }] : [];
    }

    if (query.startsWith("INSERT INTO activation_events") && query.includes("proof_call_dispatch_claimed")) {
      const detail = JSON.parse(String(values[2] || "{}"));
      const exactRequestAlreadyClaimed = activationEvents.some((event) => (
        ["proof_call_dispatch_claimed", "proof_call_dispatched"].includes(event.event_type)
        && ["open", "outcome_unknown", "in_progress", "complete"].includes(event.status)
        && event.detail.proof_request_event_id === detail.proof_request_event_id
      ));
      const workspaceAlreadyHasActiveClaim = activationEvents.some((event) => (
        event.workspace_id === Number(values[0])
        && ["proof_call_dispatch_claimed", "proof_call_dispatched"].includes(event.event_type)
        && ["open", "outcome_unknown", "in_progress"].includes(event.status)
      ));
      if (exactRequestAlreadyClaimed || workspaceAlreadyHasActiveClaim) return [];
      const event: ActivationEvent = {
        id: nextClaimId++,
        workspace_id: Number(values[0]),
        provisioning_request_id: Number(values[1]) || null,
        event_type: "proof_call_dispatch_claimed",
        status: "open",
        actor: "system",
        detail,
      };
      activationEvents.push(event);
      return [{ id: event.id }];
    }

    if (query.includes("SET status = 'outcome_unknown'") && query.includes("RETURNING id")) {
      if (acceptedPersistenceFailuresRemaining > 0) {
        acceptedPersistenceFailuresRemaining -= 1;
        return [];
      }
      const detail = JSON.parse(String(values[0] || "{}"));
      const claimId = Number(values[1]);
      const workspaceId = Number(values[2]);
      const event = activationEvents.find((candidate) => (
        candidate.id === claimId
        && candidate.workspace_id === workspaceId
        && candidate.event_type === "proof_call_dispatch_claimed"
        && candidate.status === "open"
      ));
      if (!event) return [];
      event.status = "outcome_unknown";
      event.detail = { ...event.detail, ...detail };
      return [{ id: event.id }];
    }

    if (query.startsWith("INSERT INTO calls")) {
      if (!callRows.some((row) => row.callSid === String(values[0]))) {
        callRows.push({
          callSid: String(values[0]),
          to: String(values[1]),
          from: String(values[2]),
          workspaceId: Number(values.at(-1)),
        });
      }
      return [];
    }

    if (query.startsWith("SELECT call_sid") && query.includes("FROM calls")) {
      return callRows.filter((row) => (
        row.callSid === String(values[0])
        && row.workspaceId === Number(values[1])
        && row.to === String(values[2])
        && row.from === String(values[3])
      )).map((row) => ({ call_sid: row.callSid }));
    }

    if (query.startsWith("INSERT INTO messages")) {
      messageRows.push({ callSid: String(values[0]), text: String(values[1]) });
      return [];
    }

    if (query.includes("SET event_type = 'proof_call_dispatched'") && query.includes("RETURNING id")) {
      const dynamicStatus = query.includes("status = ?");
      const nextStatus = dynamicStatus ? String(values[0]) : "in_progress";
      const offset = dynamicStatus ? 1 : 0;
      const detail = JSON.parse(String(values[offset] || "{}"));
      const claimId = Number(values[offset + 1]);
      const workspaceId = Number(values[offset + 2]);
      const event = activationEvents.find((candidate) => (
        candidate.id === claimId
        && candidate.workspace_id === workspaceId
        && ["proof_call_dispatch_claimed", "proof_call_dispatched"].includes(candidate.event_type)
        && ["open", "outcome_unknown", "in_progress"].includes(candidate.status)
      ));
      if (!event) return [];
      event.event_type = "proof_call_dispatched";
      event.status = nextStatus;
      event.detail = detail;
      return [{ id: event.id }];
    }

    if (query.includes("SET status = ?") && query.includes("status IN ('open', 'outcome_unknown')")) {
      if (terminalPersistenceFailuresRemaining > 0) {
        terminalPersistenceFailuresRemaining -= 1;
        throw new Error("terminal claim persistence unavailable");
      }
      const terminalStatus = String(values[0]);
      const detail = JSON.parse(String(values[1] || "{}"));
      const claimId = Number(values[2]);
      const event = activationEvents.find((candidate) => (
        candidate.id === claimId
        && candidate.event_type === "proof_call_dispatch_claimed"
        && ["open", "outcome_unknown"].includes(candidate.status)
      ));
      if (event) {
        event.status = terminalStatus;
        event.detail = { ...event.detail, ...detail };
      }
      return [];
    }

    throw new Error(`Unexpected SQL in proof-call fixture: ${query}`);
  };

  const callsApi: any = (_callSid: string) => ({
    fetch: async () => {
      providerFetches += 1;
      return {
        sid: CALL_SID,
        to: TARGET,
        from: FROM,
        status: "completed",
        direction: "outbound-api",
        accountSid: ACCOUNT_SID,
        dateCreated: options.providerDateCreated || new Date(),
      };
    },
  });
  callsApi.create = async (payload: any) => {
    dialCount += 1;
    dialPayloads.push(payload);
    if (options.providerError) throw options.providerError;
    return { sid: CALL_SID };
  };
  const twilioClient = { calls: callsApi };

  const pass = (_req: any, _res: any, next: () => void) => next();
  const app = {
    post(path: string, ...handlers: any[]) {
      if (path === "/api/workspace/proof-call/fulfill") handler = handlers.at(-1);
      if (path === "/api/workspace/proof-call/reconcile") reconcileHandler = handlers.at(-1);
    },
  };

  registerOutboundCallRoutes(app as any, {
    dashboardAuth: pass,
    callRateLimit: pass,
    requireTestCallSecret: pass,
    requireProofCallSchemaReady: pass,
    outboundCallSchema: { safeParse: () => ({ success: false, error: { issues: [{ message: "unused" }] } }) },
    env: {},
    sql,
    getWorkspaceId: () => WORKSPACE_ID,
    checkOutboundCompliance: async () => ({ allowed: true }),
    getTwilioClient: () => ({ calls: { create: async () => { throw new Error("unused"); } } }),
    getWorkspaceOutboundTelephony: async (workspaceId: number) => {
      telephonyLookups += 1;
      assert.equal(workspaceId, WORKSPACE_ID);
      if (preDialFailuresRemaining > 0) {
        preDialFailuresRemaining -= 1;
        throw new Error("workspace telephony unavailable before dial");
      }
      return { client: twilioClient, from: FROM, accountSid: ACCOUNT_SID };
    },
    getAppUrl: () => "https://smirkcalls.com",
    getActiveAgent: async () => ({ name: "Fixture Agent" }),
    resolveContact: async (_phone: string, workspaceId?: number) => {
      assert.equal(workspaceId, WORKSPACE_ID, "proof contact resolution must stay inside the exact customer workspace");
      return { contact: { id: 808 }, isNew: false };
    },
    sendOutboundCallConfirmationEmail: async () => ({ sent: false, recipientCount: 0 }),
    createActivationEvent: async () => undefined,
    logEvent: () => undefined,
    log: () => undefined,
  });

  assert.ok(handler, "proof-call fulfillment route must register");
  assert.ok(reconcileHandler, "proof-call reconciliation route must register");

  const invoke = async (requestId: string): Promise<CapturedResponse> => {
    const result: CapturedResponse = { status: 200, body: null };
    const response = {
      status(code: number) { result.status = code; return response; },
      json(body: any) { result.body = body; return response; },
    };
    await handler!({
      requestId,
      body: {
        proofRequestId: activeProofRequestId,
        workspaceId: WORKSPACE_ID,
        to: TARGET,
        confirmedTarget: TARGET,
        confirmation: "place-one-smirk-real-proof-call",
      },
    }, response);
    return result;
  };

  const reconcile = async (requestId: string): Promise<CapturedResponse> => {
    const result: CapturedResponse = { status: 200, body: null };
    const response = {
      status(code: number) { result.status = code; return response; },
      json(body: any) { result.body = body; return response; },
    };
    await reconcileHandler!({
      requestId,
      body: {
        proofRequestId: PROOF_REQUEST_ID,
        workspaceId: WORKSPACE_ID,
        callSid: CALL_SID,
        confirmation: "reconcile-one-smirk-proof-call",
      },
    }, response);
    return result;
  };

  return {
    invoke,
    reconcile,
    beginNewProofRequest(proofRequestId: number) { activeProofRequestId = proofRequestId; },
    activationEvents,
    callRows,
    messageRows,
    dialPayloads,
    get dialCount() { return dialCount; },
    get telephonyLookups() { return telephonyLookups; },
    get providerFetches() { return providerFetches; },
  };
}

test("pre-dial failure is blocked and explicitly retryable", async () => {
  const harness = createHarness({ preDialFailures: 1 });

  const failed = await harness.invoke("fixture-pre-dial-1");
  assert.equal(failed.status, 500);
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.retryable, true);
  assert.equal(failed.body.reconciliationRequired, false);
  assert.equal(harness.dialCount, 0, "a pre-dial dependency failure must not call Twilio");
  assert.equal(harness.activationEvents[0].status, "blocked");
  assert.equal(harness.activationEvents[0].detail.dial_attempted, false);
  assert.equal(harness.activationEvents[0].detail.retry_requires_operator_reconciliation, false);

  const retried = await harness.invoke("fixture-pre-dial-2");
  assert.equal(retried.status, 202, "a blocked pre-dial claim may be retried");
  assert.equal(harness.dialCount, 1);
  assert.equal(harness.activationEvents[1].event_type, "proof_call_dispatched");
  assert.equal(harness.activationEvents[1].status, "in_progress");
});

test("a target not bound to the exact customer request is rejected before telephony", async () => {
  const harness = createHarness({ proofTargetDigest: digestExactProofCallTarget("+17755559999")! });

  const rejected = await harness.invoke("fixture-target-mismatch");
  assert.equal(rejected.status, 409);
  assert.match(rejected.body.error, /exact customer request/i);
  assert.equal(harness.telephonyLookups, 0);
  assert.equal(harness.dialCount, 0);
  assert.equal(harness.activationEvents.length, 0);
});

test("provider timeout is terminal outcome-unknown and the exact request cannot dial again", async () => {
  const harness = createHarness({ providerError: new Error("Twilio request timed out after dispatch") });

  const timedOut = await harness.invoke("fixture-timeout-1");
  assert.equal(timedOut.status, 500);
  assert.equal(timedOut.body.retryable, false);
  assert.equal(timedOut.body.reconciliationRequired, true);
  assert.match(timedOut.body.error, /outcome is uncertain/i);
  assert.equal(harness.dialCount, 1);
  assert.equal(harness.activationEvents[0].status, "outcome_unknown");
  assert.equal(harness.activationEvents[0].detail.dial_attempted, true);
  assert.equal(harness.activationEvents[0].detail.retry_requires_operator_reconciliation, true);

  const refused = await harness.invoke("fixture-timeout-2");
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /already claimed or dispatched/i);
  assert.equal(harness.dialCount, 1, "retry refusal must happen before any second provider call");
  assert.equal(harness.telephonyLookups, 1, "retry refusal must happen before telephony lookup");
});

test("an uncertain workspace claim fences a newer request before any second dial", async () => {
  const harness = createHarness({ providerError: new Error("Twilio request timed out after dispatch") });
  const first = await harness.invoke("fixture-workspace-fence-1");
  assert.equal(first.status, 500);
  assert.equal(harness.activationEvents[0].status, "outcome_unknown");
  assert.equal(harness.dialCount, 1);

  harness.beginNewProofRequest(PROOF_REQUEST_ID + 1);
  const second = await harness.invoke("fixture-workspace-fence-2");
  assert.equal(second.status, 409);
  assert.match(second.body.error, /workspace already has an active proof attempt/i);
  assert.equal(harness.dialCount, 1, "a new request ID must not bypass the workspace-level uncertain-call fence");
  assert.equal(harness.telephonyLookups, 1);
});

test("accepted SID plus persistence failure remains terminal and retains the exact SID", async () => {
  const harness = createHarness({ acceptedPersistenceFailures: 1 });

  const failed = await harness.invoke("fixture-accepted-persistence-1");
  assert.equal(failed.status, 500);
  assert.equal(failed.body.retryable, false);
  assert.equal(failed.body.reconciliationRequired, true);
  assert.equal(harness.dialCount, 1);
  assert.equal(harness.activationEvents[0].status, "outcome_unknown");
  assert.equal(harness.activationEvents[0].detail.call_sid, CALL_SID);
  assert.equal(harness.activationEvents[0].detail.dial_outcome_unknown, true);
  assert.equal(harness.callRows.length, 0, "failure occurred before the local call row was accepted");

  const refused = await harness.invoke("fixture-accepted-persistence-2");
  assert.equal(refused.status, 409);
  assert.equal(harness.dialCount, 1);
});

test("an accepted SID can be provider-verified and reconciled without a second dial", async () => {
  const harness = createHarness({ acceptedPersistenceFailures: 1 });

  const failed = await harness.invoke("fixture-reconcile-1");
  assert.equal(failed.status, 500);
  assert.equal(harness.dialCount, 1);
  assert.equal(harness.activationEvents[0].status, "outcome_unknown");
  assert.equal(harness.activationEvents[0].detail.call_sid, CALL_SID);

  const reconciled = await harness.reconcile("fixture-reconcile-2");
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.body.callSid, CALL_SID);
  assert.equal(reconciled.body.providerStatus, "completed");
  assert.equal(harness.dialCount, 1, "reconciliation must never place another call");
  assert.equal(harness.providerFetches, 1);
  assert.equal(harness.activationEvents[0].event_type, "proof_call_dispatched");
  assert.equal(harness.activationEvents[0].status, "complete");
  assert.equal(harness.activationEvents[0].detail.reconciled_from_outcome_unknown, true);

  const refused = await harness.reconcile("fixture-reconcile-3");
  assert.equal(refused.status, 409);
  assert.equal(harness.dialCount, 1);
  assert.equal(harness.providerFetches, 1, "a completed claim must be rejected before provider lookup");
});

test("a timeout claim only accepts a provider SID created in the exact claim window", async () => {
  const oldCall = createHarness({
    providerError: new Error("Twilio request timed out after dispatch"),
    providerDateCreated: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });
  const oldTimeout = await oldCall.invoke("fixture-old-provider-1");
  assert.equal(oldTimeout.status, 500);
  assert.equal(oldCall.activationEvents[0].detail.call_sid, null);
  const oldRejected = await oldCall.reconcile("fixture-old-provider-2");
  assert.equal(oldRejected.status, 409);
  assert.match(oldRejected.body.error, /exact provider call/i);
  assert.equal(oldCall.activationEvents[0].status, "outcome_unknown");

  const currentCall = createHarness({ providerError: new Error("Twilio request timed out after dispatch") });
  const currentTimeout = await currentCall.invoke("fixture-current-provider-1");
  assert.equal(currentTimeout.status, 500);
  const reconciled = await currentCall.reconcile("fixture-current-provider-2");
  assert.equal(reconciled.status, 200);
  assert.equal(currentCall.activationEvents[0].event_type, "proof_call_dispatched");
  assert.equal(currentCall.dialCount, 1, "reconciliation must not place a second call");
});

test("provider verification recovers an open claim when both post-dial state writes failed", async () => {
  const harness = createHarness({
    acceptedPersistenceFailures: 1,
    terminalPersistenceFailures: 1,
  });
  const failed = await harness.invoke("fixture-open-claim-1");
  assert.equal(failed.status, 500);
  assert.equal(harness.activationEvents[0].status, "open");
  assert.equal(harness.activationEvents[0].detail.call_sid, undefined);

  const reconciled = await harness.reconcile("fixture-open-claim-2");
  assert.equal(reconciled.status, 200);
  assert.equal(harness.activationEvents[0].event_type, "proof_call_dispatched");
  assert.equal(harness.activationEvents[0].status, "complete");
  assert.equal(harness.dialCount, 1);
  assert.equal(harness.providerFetches, 1);
});

test("success durably links exact proof request, workspace, and SID; a second claim cannot dial", async () => {
  const harness = createHarness();

  const completed = await harness.invoke("fixture-success-1");
  assert.equal(completed.status, 202);
  assert.deepEqual(completed.body, {
    ok: true,
    callSid: CALL_SID,
    workspaceId: WORKSPACE_ID,
    proofRequestId: PROOF_REQUEST_ID,
  });
  assert.equal(harness.dialCount, 1);
  assert.equal(harness.dialPayloads[0].to, TARGET);
  assert.equal(harness.dialPayloads[0].from, FROM);

  const dispatch = harness.activationEvents[0];
  assert.equal(dispatch.event_type, "proof_call_dispatched");
  assert.equal(dispatch.status, "in_progress");
  assert.equal(dispatch.workspace_id, WORKSPACE_ID);
  assert.equal(dispatch.provisioning_request_id, PROVISIONING_REQUEST_ID);
  assert.equal(dispatch.detail.proof_request_event_id, String(PROOF_REQUEST_ID));
  assert.equal(dispatch.detail.call_sid, CALL_SID);
  assert.equal(dispatch.detail.twilio_account_sid, ACCOUNT_SID);
  assert.equal(dispatch.detail.request_id, "fixture-success-1");
  assert.deepEqual(harness.callRows, [{ callSid: CALL_SID, to: TARGET, from: FROM, workspaceId: WORKSPACE_ID }]);
  assert.equal(harness.messageRows.length, 1);
  assert.equal(harness.messageRows[0].callSid, CALL_SID);
  assert.match(harness.messageRows[0].text, new RegExp(`\\[PROOF REQUEST EVENT\\] ${PROOF_REQUEST_ID}`));

  harness.beginNewProofRequest(PROOF_REQUEST_ID + 1);
  const refused = await harness.invoke("fixture-success-2");
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /workspace already has an active proof attempt/i);
  assert.equal(harness.dialCount, 1, "the unique claim must suppress a second Twilio dial");
  assert.equal(harness.callRows.length, 1);
});

test("provider reconciliation releases an in-progress dispatch when the terminal callback was lost", async () => {
  const harness = createHarness();

  const dispatched = await harness.invoke("fixture-lost-terminal-callback-1");
  assert.equal(dispatched.status, 202);
  assert.equal(harness.activationEvents[0].event_type, "proof_call_dispatched");
  assert.equal(harness.activationEvents[0].status, "in_progress");

  const reconciled = await harness.reconcile("fixture-lost-terminal-callback-2");
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.body.providerStatus, "completed");
  assert.equal(harness.activationEvents[0].event_type, "proof_call_dispatched");
  assert.equal(harness.activationEvents[0].status, "complete");
  assert.equal(harness.activationEvents[0].detail.reconciled_from_outcome_unknown, false);
  assert.equal(harness.activationEvents[0].detail.reconciled_from_state, "proof_call_dispatched:in_progress");
  assert.equal(harness.dialCount, 1, "reconciliation must recover provider state without redialing");
  assert.equal(harness.providerFetches, 1);
});
