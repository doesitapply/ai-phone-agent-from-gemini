import assert from "node:assert/strict";
import { registerWorkspaceKnowledgeRoutes } from "../src/routes/workspace-knowledge-routes.ts";

type Handler = (req: any, res: any, next?: () => void) => Promise<void> | void;

const getHandlers = new Map<string, Handler>();
const postHandlers = new Map<string, Handler>();
const app = {
  get: (path: string, ...items: Handler[]) => getHandlers.set(path, items[items.length - 1]),
  post: (path: string, ...items: Handler[]) => postHandlers.set(path, items[items.length - 1]),
  delete: () => undefined,
};

const queries: string[] = [];
const sql = async (strings: TemplateStringsArray) => {
  const query = strings.join("?").replace(/\s+/g, " ").trim();
  queries.push(query);
  if (query.startsWith("UPDATE workspace_knowledge_packs") && query.includes("RETURNING id")) return [{ id: 4 }];
  return [];
};

const pass: Handler = (_req, _res, next) => next?.();

registerWorkspaceKnowledgeRoutes(app as any, {
  dashboardAuth: pass,
  dbEnabled: true,
  sql,
  getWorkspaceId: () => 17,
  createActivationEvent: async () => undefined,
  log: () => undefined,
});

const response = () => {
  const state: { status?: number; body?: any } = {};
  return {
    state,
    status(code: number) { state.status = code; return this; },
    json(body: any) { state.body = body; return this; },
  };
};

const create = postHandlers.get("/api/workspace/knowledge/packs");
assert.ok(create, "knowledge-pack draft handler must be registered");
const noSources = response();
await create!({ body: { title: "Unsafe empty demo" }, authMode: "operator" }, noSources as any);
assert.equal(noSources.state.status, 400, "a draft must not be created without selected workspace sources");
assert.match(noSources.state.body?.error || "", /select at least one/i, "missing source failure should explain the operator action");

const activate = postHandlers.get("/api/workspace/knowledge/packs/:id/activate");
assert.ok(activate, "knowledge-pack activation handler must be registered");
const badPackId = response();
await activate!({ params: { id: "0" }, body: {}, authMode: "operator" }, badPackId as any);
assert.equal(badPackId.state.status, 400, "activation must reject an invalid pack identifier");

const reset = postHandlers.get("/api/workspace/knowledge/packs/reset");
assert.ok(reset, "knowledge-pack reset handler must be registered");

console.log("Business Knowledge Pack route checks passed (6 assertions).");
