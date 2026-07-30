import assert from "node:assert/strict";
import test from "node:test";
import type { Express, Request, Response } from "express";
import { registerLeadRoutes } from "../src/routes/lead-routes.ts";
import { registerProspectingRoutes } from "../src/routes/prospecting-routes.ts";
import {
  executeDueSequenceSteps,
  PROSPECT_SEQUENCE_AUTOMATION_ENABLED,
  scheduleFollowUpSteps,
} from "../src/sequence-engine.ts";

type RouteHandler = (req: Request, res: Response, next?: () => void) => unknown;

function createRouteFixture() {
  const routes = new Map<string, RouteHandler>();
  const app: Record<string, unknown> = {};
  for (const method of ["get", "post", "patch", "delete"]) {
    app[method] = (path: string, ...handlers: RouteHandler[]) => {
      routes.set(`${method.toUpperCase()} ${path}`, handlers.at(-1)!);
    };
  }
  return { app: app as unknown as Express, routes };
}

function makeResponse() {
  const state: { statusCode: number; body: unknown } = { statusCode: 200, body: undefined };
  const response = {
    status(code: number) {
      state.statusCode = code;
      return response;
    },
    json(body: unknown) {
      state.body = body;
      return response;
    },
  };
  return { response: response as unknown as Response, state };
}

async function invoke(
  handler: RouteHandler,
  request: Partial<Request>,
): Promise<{ statusCode: number; body: unknown }> {
  const { response, state } = makeResponse();
  await handler(request as Request, response, () => undefined);
  return state;
}

test("prospecting dial endpoints fail closed without provider dependencies", async () => {
  const { app, routes } = createRouteFixture();
  const emptySql = async <T = any>(): Promise<T> => [] as T;
  registerProspectingRoutes(app, {
    dashboardAuth: ((_req, _res, next) => next()) as any,
    requireOperator: ((_req, _res, next) => next()) as any,
    sql: emptySql,
    dbEnabled: true,
    getWorkspaceId: () => 42,
  });

  for (const route of [
    "POST /api/prospecting/campaigns/:id/dial-next",
    "POST /api/prospecting/campaigns/:id/auto-dial/start",
  ]) {
    const result = await invoke(routes.get(route)!, { params: { id: "7" } as any });
    assert.equal(result.statusCode, 409);
    assert.deepEqual(result.body, {
      error: "Prospect contact is disabled. Prepare a recipient-specific draft for human review.",
      code: "PROSPECTING_CONTACT_APPROVAL_REQUIRED",
      externalAction: "blocked",
    });
  }
});

test("legacy lead research and campaign launch endpoints fail closed", async () => {
  const { app, routes } = createRouteFixture();
  let sqlCalls = 0;
  const sql = async (strings: TemplateStringsArray) => {
    sqlCalls += 1;
    const query = strings.join(" ? ").replace(/\s+/g, " ").trim();
    if (query.startsWith("SELECT id FROM campaigns")) return [{ id: 9 }];
    throw new Error(`Unexpected SQL: ${query}`);
  };
  registerLeadRoutes(app, {
    dashboardAuth: ((_req, _res, next) => next()) as any,
    chatRateLimit: ((_req, _res, next) => next()) as any,
    requireOperator: ((_req, _res, next) => next()) as any,
    sql,
    dbEnabled: true,
    getWorkspaceId: () => 42,
    log: () => {},
  });

  for (const route of [
    "POST /api/leads/search/apollo",
    "POST /api/leads/search/maps",
    "POST /api/leads/personalize",
  ]) {
    const result = await invoke(routes.get(route)!, {});
    assert.equal(result.statusCode, 409);
    assert.equal((result.body as any).code, "LEAD_RESEARCH_SPEND_APPROVAL_REQUIRED");
  }
  assert.equal(sqlCalls, 0);

  const launch = await invoke(
    routes.get("POST /api/campaigns/:id/launch")!,
    { params: { id: "9" } as any },
  );
  assert.equal(launch.statusCode, 409);
  assert.equal((launch.body as any).code, "PROSPECTING_CONTACT_APPROVAL_REQUIRED");
  assert.equal(sqlCalls, 1);
});

test("historical prospect sequences cannot schedule or execute external actions", async () => {
  assert.equal(PROSPECT_SEQUENCE_AUTOMATION_ENABLED, false);
  assert.equal(await scheduleFollowUpSteps(1, 2, "callback"), 0);
  assert.deepEqual(await executeDueSequenceSteps(), { executed: 0, failed: 0 });
});
