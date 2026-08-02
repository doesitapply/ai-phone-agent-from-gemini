import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import {
  buildOwnerProspectAcquisitionOverview,
  registerOwnerControlRoutes,
} from "../src/routes/owner-control-routes.ts";

test("owner prospect-acquisition telemetry is redacted and cannot authorize execution", () => {
  const secretValues = {
    VELVET_LEAD_SOURCE_API_KEY: `research-${"a".repeat(32)}`,
    VELVET_OUTCOME_API_KEY: `outcome-${"b".repeat(32)}`,
    VELVET_OUTCOME_SIGNING_SECRET: `signing-${"c".repeat(32)}`,
    PROSPECT_EMAIL_RESEND_API_KEY: `re_${"d".repeat(24)}`,
    PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET: `whsec_${"e".repeat(24)}`,
    PROSPECT_EMAIL_RESEND_RECEIVING_API_KEY: `re_${"f".repeat(24)}`,
    PROSPECT_QC_OPENROUTER_API_KEY: `sk-or-${"g".repeat(24)}`,
    PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY: `observer-${"h".repeat(32)}`,
    PROSPECT_REVENUE_LOOP_PREPARER_API_KEY: `preparer-${"i".repeat(32)}`,
    PROSPECT_INBOX_SEED_ALLOWLIST:
      "seed-one@example.invalid,seed-two@example.invalid",
  };
  const result = buildOwnerProspectAcquisitionOverview({
    ...secretValues,
    VELVET_DISCOVERY_ENABLED: "true",
    PROSPECT_EMAIL_EXECUTION_ENABLED: "unexpected",
  });

  assert.equal(result.connections.length, 10);
  assert.equal(result.executionSwitches.length, 8);
  assert.equal(
    result.executionSwitches.find(
      (item) => item.key === "VELVET_DISCOVERY_ENABLED"
    )?.state,
    "enabled-requires-separate-approval"
  );
  assert.equal(
    result.executionSwitches.find(
      (item) => item.key === "PROSPECT_EMAIL_EXECUTION_ENABLED"
    )?.state,
    "invalid-switch-value"
  );
  assert.equal(result.activation.authorized, false);
  assert.equal(result.activation.contactAuthorized, false);
  assert.equal(result.activation.spendAuthorized, false);
  assert.equal(result.activation.providerMutationPerformed, false);
  assert.equal(result.externalAction, "none");
  assert.equal(result.guardrails.coldSmsAllowed, false);
  assert.equal(result.guardrails.bulkEmailAllowed, false);
  assert.equal(result.guardrails.automatedProspectDialingAllowed, false);
  assert.equal(result.guardrails.qcMayAuthorizeContact, false);

  const serialized = JSON.stringify(result);
  for (const value of Object.values(secretValues)) {
    assert.equal(serialized.includes(value), false, value);
  }
  assert.equal(serialized.includes("seed-one@example.invalid"), false);
});

test("owner-control overview exposes redacted prospect plumbing to full operators", async () => {
  let handler:
    | ((req: Request, res: Response) => unknown)
    | undefined;
  const app = {
    get(
      path: string,
      ...handlers: Array<(req: Request, res: Response) => unknown>
    ) {
      if (path === "/api/owner-control/overview") {
        handler = handlers.at(-1);
      }
    },
  };
  registerOwnerControlRoutes(app as any, {
    dashboardAuth: ((_req, _res, next) => next()) as any,
    requireFullOperator: (_req, _res, next) => next(),
    sql: async () => [],
    dbEnabled: false,
    env: {},
    getWorkspaceId: () => 7,
    getAdminAllowlistCount: () => 1,
    buildOpsMonitor: async () => ({
      services: [],
      spend: null,
      config: [],
      generatedAt: "2026-08-02T12:00:00.000Z",
    }),
    log: () => {},
  });
  assert.ok(handler);

  const state = { status: 200, body: undefined as any };
  const response = {
    setHeader() {},
    status(status: number) {
      state.status = status;
      return response;
    },
    json(body: unknown) {
      state.body = body;
      return response;
    },
  };
  await handler({} as Request, response as unknown as Response);

  assert.equal(state.status, 200);
  assert.equal(state.body.access.fullControl, true);
  assert.equal(state.body.access.readOnlyConsole, true);
  assert.equal(state.body.prospectAcquisition.connections.length, 10);
  assert.equal(state.body.prospectAcquisition.executionSwitches.length, 8);
  assert.equal(state.body.prospectAcquisition.externalAction, "none");
  assert.equal(
    state.body.prospectAcquisition.activation.contactAuthorized,
    false
  );
});

test("owner-control UI names the redacted prospect controls and safety boundary", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/App.tsx", import.meta.url), "utf8")
  );

  assert.match(source, /Prospect acquisition control plane/);
  assert.match(source, /Revenue-loop connections/);
  assert.match(source, /Execution switches/);
  assert.match(source, /Credential separation/);
  assert.match(source, /External evidence unproven/);
  assert.match(source, /No action authorized/i);
  assert.match(source, /cannot enable a switch, contact a prospect, or authorize spend/);
});
