import assert from "node:assert/strict";
import { registerOperationsRoutes } from "../src/routes/operations-routes.ts";

type Handler = (req: any, res: any, next?: () => void) => Promise<void> | void;

const handlers = new Map<string, Handler>();
const app = {
  get: () => undefined,
  post: (path: string, ...items: Handler[]) => handlers.set(path, items[items.length - 1]),
};
const queries: string[] = [];
const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const query = strings.join("?").replace(/\s+/g, " ").trim();
  queries.push(query);
  if (query.startsWith("SELECT call_sid, contact_id FROM handoffs")) return [{ call_sid: "CA-proof", contact_id: 7 }];
  if (query.includes("RETURNING id, status, last_action")) return [{ id: 4, status: "completed", last_action: "complete" }];
  if (query.includes("RETURNING id")) return [{ id: 4 }];
  return [];
};
const pass: Handler = (_req, _res, next) => next?.();

registerOperationsRoutes(app as any, {
  dashboardAuth: pass,
  requireOperator: pass,
  sql,
  dbEnabled: true,
  getWorkspaceId: () => 1,
  velvet: { receiverConfigured: false, workspaceId: null, portalUrl: null },
});

const response = () => {
  const state: { status?: number; body?: any } = {};
  return {
    state,
    status(code: number) { state.status = code; return this; },
    json(body: any) { state.body = body; return this; },
  };
};

const acknowledge = handlers.get("/api/handoffs/:id/acknowledge");
assert.ok(acknowledge, "acknowledge handler must be registered");
queries.length = 0;
await acknowledge!({ params: { id: "4" }, body: {} }, response() as any);
assert.ok(queries.some((query) => query.includes("SET status = CASE WHEN status = 'pending' THEN 'acknowledged'")), "acknowledge must record ownership");
assert.ok(!queries.some((query) => query.includes("UPDATE tasks SET status = 'completed'")), "acknowledge must not silently complete handoff tasks");

const action = handlers.get("/api/handoffs/:id/action");
assert.ok(action, "explicit handoff action handler must be registered");
const missingOutcome = response();
await action!({ params: { id: "4" }, body: { action: "complete" } }, missingOutcome as any);
assert.equal(missingOutcome.state.status, 400, "completion must require an outcome note");

queries.length = 0;
const queued = response();
await action!({ params: { id: "4" }, body: { action: "queue_callback", resolution_notes: "Call after lunch" } }, queued as any);
assert.equal(queued.state.body?.success, true, "queue callback should succeed");
assert.ok(queries.some((query) => query.includes("WHERE NOT EXISTS") && query.includes("task_type = 'callback'")), "callback queueing must avoid duplicate open callback tasks");

console.log("Operator handoff action checks passed (6 assertions).");
