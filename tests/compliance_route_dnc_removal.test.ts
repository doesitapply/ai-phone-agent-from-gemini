import assert from "node:assert/strict";
import test from "node:test";
import type { Request, RequestHandler, Response } from "express";
import { registerComplianceRoutes } from "../src/routes/compliance-routes.ts";

type RouteHandler = (req: Request, res: Response) => Promise<unknown> | unknown;

const captureDeleteHandler = () => {
  let deleteHandler: RouteHandler | null = null;
  const app = {
    get: () => undefined,
    post: () => undefined,
    delete: (path: string, ...handlers: RequestHandler[]) => {
      if (path === "/api/compliance/dnc/:phone") {
        deleteHandler = handlers.at(-1) as RouteHandler;
      }
    },
  };
  const passThrough: RequestHandler = (_req, _res, next) => next();
  registerComplianceRoutes(app as any, {
    dashboardAuth: passThrough,
    requireOperator: passThrough,
    sql: () => {
      throw new Error("SQL must not run for an invalid DNC removal note.");
    },
    dbEnabled: true,
  });
  assert.ok(deleteHandler, "DNC delete route must be registered");
  return deleteHandler;
};

const invoke = async (reason: unknown) => {
  const handler = captureDeleteHandler();
  let statusCode = 200;
  let payload: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      payload = body;
      return this;
    },
  };
  await handler(
    {
      body: reason === undefined ? {} : { reason },
      params: { phone: "+12025550124" },
    } as unknown as Request,
    response as unknown as Response
  );
  return { statusCode, payload };
};

test("global DNC removal rejects missing, malformed, and short audit notes", async () => {
  for (const reason of [undefined, null, 42, "", "short", "       "]) {
    const result = await invoke(reason);
    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.payload, {
      error: "A consent or correction note is required to remove DNC.",
    });
  }
});
