import assert from "node:assert/strict";
import test from "node:test";

import { registerWorkspaceActivationRoutes } from "../src/routes/workspace-activation-routes.js";

test("an active or outcome-unknown workspace claim blocks creation of a newer proof request", async () => {
  let handler: ((req: any, res: any) => Promise<unknown>) | null = null;
  let workspaceRead = false;
  let workspaceWrite = false;
  const createdEvents: any[] = [];
  const pass = (_req: any, _res: any, next: () => void) => next();
  const app = {
    post(path: string, ...handlers: any[]) {
      if (path === "/api/workspace/proof-call/request") handler = handlers.at(-1);
    },
    get() {},
  };
  const sql = async (parts: TemplateStringsArray) => {
    const query = parts.join("?").replace(/\s+/g, " ").trim();
    if (query.includes("FROM provisioning_requests")) return [{ id: 73 }];
    if (query.includes("FROM activation_events") && query.includes("proof_call_dispatch_claimed")) {
      return [{ id: 900, status: "outcome_unknown", proof_request_event_id: "501" }];
    }
    throw new Error(`Proof-request fence should short-circuit before SQL: ${query}`);
  };

  registerWorkspaceActivationRoutes(app as any, {
    dashboardAuth: pass,
    sql: sql as any,
    env: {},
    log: () => undefined,
    getWorkspaceId: () => 41,
    getWorkspaceById: async () => { workspaceRead = true; return null; },
    updateWorkspace: async () => { workspaceWrite = true; },
    createActivationEvent: async (event: any) => {
      createdEvents.push(event);
      return { id: 901 };
    },
    listActivationEvents: async () => [],
    recordActivationStageEvent: async () => undefined,
    buildProofFreshness: () => ({}),
    buildSetupReadiness: () => ({ items: [] }),
    buildActivationStatus: () => ({ readyForProofCall: true, stage: "ready", customerNextAction: "none" }),
    maskPhoneForResponse: () => null,
    workspaceProfileCache: { delete: () => undefined },
  });
  assert.ok(handler);

  const captured = { status: 200, body: null as any };
  const response = {
    status(code: number) { captured.status = code; return response; },
    json(body: any) { captured.body = body; return response; },
  };
  await handler!({ body: {}, authMode: "workspace", workspaceAuth: { id: 41 } }, response);

  assert.equal(captured.status, 409);
  assert.equal(captured.body.reconciliation_required, true);
  assert.equal(captured.body.active_claim_event_id, 900);
  assert.equal(captured.body.active_proof_request_id, 501);
  assert.equal(workspaceRead, false);
  assert.equal(workspaceWrite, false);
  assert.equal(createdEvents.length, 1);
  assert.equal(createdEvents[0].event_type, "proof_call_request_blocked");
  assert.equal(createdEvents[0].status, "blocked");
  assert.equal(createdEvents[0].actor, "customer");
  assert.equal(createdEvents[0].detail.reason, "active_or_uncertain_proof_call_claim");
});
