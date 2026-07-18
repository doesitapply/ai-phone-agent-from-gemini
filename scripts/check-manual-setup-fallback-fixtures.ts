#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { registerProvisioningRoutes } from "../src/routes/provisioning-routes.js";

const originalFetch = globalThis.fetch;
const trackedEnv = [
  "RESEND_API_KEY", "FROM_EMAIL", "FROM_NAME", "APP_URL",
  "NOTIFICATION_EMAIL", "OWNER_ALERT_EMAIL", "OWNER_EMAIL", "OPERATOR_EMAIL",
] as const;
const originalEnv = Object.fromEntries(trackedEnv.map((key) => [key, process.env[key]]));

const restoreEnv = () => {
  for (const key of trackedEnv) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

type CapturedResponse = { status: number; body: any };
const invoke = async (handler: (req: any, res: any) => Promise<void>, body: Record<string, unknown>): Promise<CapturedResponse> => {
  const result: CapturedResponse = { status: 200, body: null };
  const response = {
    set: () => response,
    status(code: number) { result.status = code; return response; },
    json(payload: any) { result.body = payload; return response; },
  };
  await handler({
    body,
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
    requestId: "manual-setup-fixture-request",
  }, response);
  return result;
};

const registerFixture = (dbEnabled: boolean, sql: any) => {
  let requestHandler: ((req: any, res: any) => Promise<void>) | null = null;
  const app = {
    get: () => undefined,
    post: (route: string, ...handlers: any[]) => {
      if (route === "/api/provisioning/request") requestHandler = handlers.at(-1);
    },
  };
  const pass = (_req: any, _res: any, next: () => void) => next();
  registerProvisioningRoutes(app as any, {
    publicProvisioningRequestRateLimit: pass,
    publicCheckoutStatusRateLimit: pass,
    publicInviteResendRateLimit: pass,
    dashboardAuth: pass,
    requireOperator: pass,
    requireProvisioningSecret: pass,
    sql,
    dbEnabled,
    env: {},
    getAppUrl: () => "http://localhost:3000",
    provisionWorkspaceTelephony: async () => ({ phoneNumber: null }),
    buildProofFreshness: () => ({}),
    buildSetupReadiness: () => ({}),
    buildActivationStatus: () => ({}),
  });
  assert.ok(requestHandler, "manual setup route must register");
  return requestHandler!;
};

const setupBody = {
  business_name: "Fixture Plumbing",
  owner_email: "buyer@fixture.test",
  phone: "+17755550123",
  notes: "Morning callback; protect the main business line.",
  plan: "starter",
  mode: "missed_call_recovery",
  source: "public_book_setup",
};

try {
  process.env.FROM_EMAIL = "SMIRK <hello@smirkcalls.com>";
  process.env.FROM_NAME = "SMIRK";
  process.env.APP_URL = "https://smirkcalls.com";
  process.env.OWNER_ALERT_EMAIL = "operator@smirkcalls.com";
  delete process.env.NOTIFICATION_EMAIL;
  delete process.env.OWNER_EMAIL;
  delete process.env.OPERATOR_EMAIL;

  delete process.env.RESEND_API_KEY;
  const noDbFailure = await invoke(registerFixture(false, null), setupBody);
  assert.equal(noDbFailure.status, 503);
  assert.equal(noDbFailure.body.ok, false);
  assert.equal(noDbFailure.body.captured, false);
  assert.equal(noDbFailure.body.status, "capture_unavailable");
  assert.match(noDbFailure.body.error, /Nothing has been captured/);

  process.env.RESEND_API_KEY = "re_fixture";
  const emailCalls: Array<{ headers: Headers; body: any }> = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    emailCalls.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body || "{}")) });
    return new Response(JSON.stringify({ id: `manual_fixture_${emailCalls.length}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const noDbAccepted = await invoke(registerFixture(false, null), setupBody);
  assert.equal(noDbAccepted.status, 202);
  assert.equal(noDbAccepted.body.captured, true);
  assert.equal(noDbAccepted.body.operator_alert_sent, true);
  assert.equal(noDbAccepted.body.receipt_email_sent, true);
  assert.equal(emailCalls.length, 2);
  assert.deepEqual(emailCalls[0].body.to, ["operator@smirkcalls.com"]);
  assert.equal(emailCalls[0].body.text.includes(setupBody.notes), true, "operator fallback must retain setup notes when DB is unavailable");
  assert.deepEqual(emailCalls[1].body.to, [setupBody.owner_email]);

  const queries: Array<{ text: string; values: unknown[] }> = [];
  const fakeSql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    queries.push({ text, values });
    if (text.includes("INSERT INTO provisioning_requests")) return [{ id: 73 }];
    return [];
  };
  const dbAccepted = await invoke(registerFixture(true, fakeSql), setupBody);
  assert.equal(dbAccepted.status, 202);
  assert.equal(dbAccepted.body.captured, true);
  assert.equal(dbAccepted.body.receipt_email_sent, true);
  const insert = queries.find((query) => query.text.includes("INSERT INTO provisioning_requests"));
  assert.ok(insert, "manual setup must insert a provisioning request");
  assert.match(insert.text, /owner_phone, business_phone, intake_notes/);
  assert.equal(insert.values.includes(setupBody.phone), true, "persisted request must contain the submitted phone");
  assert.equal(insert.values.includes(setupBody.notes), true, "persisted request must contain the submitted notes");
  assert.equal(queries.some((query) => query.text.includes("manual_receipt_sent")), false, "receipt status must be parameterized, not interpolated into SQL text");
  assert.equal(queries.some((query) => query.values.includes("manual_receipt_sent")), true, "receipt delivery result must be persisted");

  console.log("OK manual setup route fails closed without durable capture, retains phone and notes, and reports buyer receipt delivery honestly");
} finally {
  globalThis.fetch = originalFetch;
  restoreEnv();
}
