import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverVelvetOutcome,
  mapSmirkOutcomeToVelvet,
  parseVelvetLeadId,
  readVelvetOutcomeConfig,
} from "../src/velvet-outcome.ts";

const env = {
  VELVET_ALCHEMY_OUTCOME_KEY: "outcome-only-7Jq9Vx2Lm4Np6Rs8Tu3Wy5Za",
  VELVET_ALCHEMY_BASE_URL: "https://velvetalchemy.manus.space",
  VELVET_ALCHEMY_WORKSPACE_ID: "1",
};

test("Velvet outcome configuration fails closed when the scoped callback key is absent", () => {
  const config = readVelvetOutcomeConfig({
    VELVET_ALCHEMY_BASE_URL: env.VELVET_ALCHEMY_BASE_URL,
    VELVET_ALCHEMY_WORKSPACE_ID: env.VELVET_ALCHEMY_WORKSPACE_ID,
  });
  assert.equal(config.configured, false);
  assert.deepEqual(config.missing, ["VELVET_ALCHEMY_OUTCOME_KEY"]);
});

test("Velvet outcome configuration rejects insecure URLs and reused provider secrets", () => {
  assert.equal(readVelvetOutcomeConfig({ ...env, VELVET_ALCHEMY_BASE_URL: "http://velvet.example.com" }).configured, false);
  const reused = readVelvetOutcomeConfig({ ...env, STRIPE_SECRET_KEY: env.VELVET_ALCHEMY_OUTCOME_KEY });
  assert.equal(reused.configured, false);
  assert.equal(reused.missing.includes("VELVET_ALCHEMY_OUTCOME_KEY_SEPARATION"), true);
});

test("maps only explicit SMIRK outcomes into Velvet's restricted outcome vocabulary", () => {
  assert.equal(mapSmirkOutcomeToVelvet("appointment_booked"), "booked");
  assert.equal(mapSmirkOutcomeToVelvet("callback_needed"), "callback");
  assert.equal(mapSmirkOutcomeToVelvet("do_not_call"), "not_interested");
  assert.equal(mapSmirkOutcomeToVelvet("unknown"), null);
  assert.equal(parseVelvetLeadId("velvet-42-1700000000000"), 42);
  assert.equal(parseVelvetLeadId("velvet-manus-fake-check"), null);
});

test("posts an outcome only to the lead encoded in a real Velvet handoff external ID", async () => {
  let requestedUrl = "";
  let requestedHeaders: Record<string, string> = {};
  let requestedBody: any = null;
  const result = await deliverVelvetOutcome({
    externalId: "velvet-42-1700000000000",
    callId: "CA1234567890abcdef",
    outcome: "booked",
    summary: "Appointment scheduled.",
    callDuration: 86,
    calledAt: "2026-08-16T12:00:00.000Z",
  }, {
    env,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url);
      requestedHeaders = init?.headers as Record<string, string>;
      requestedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
  });
  assert.deepEqual(result, { delivered: true });
  assert.equal(requestedUrl, "https://velvetalchemy.manus.space/api/v1/leads/42/outcome");
  assert.equal(requestedHeaders.Authorization, `Bearer ${env.VELVET_ALCHEMY_OUTCOME_KEY}`);
  assert.equal(requestedHeaders["X-SMIRK-Idempotency-Key"], "velvet-outcome:velvet-42-1700000000000:CA1234567890abcdef");
  assert.deepEqual(requestedBody, {
    outcome: "booked",
    summary: "Appointment scheduled.",
    workspaceId: 1,
    callDuration: 86,
    calledAt: "2026-08-16T12:00:00.000Z",
  });
});
