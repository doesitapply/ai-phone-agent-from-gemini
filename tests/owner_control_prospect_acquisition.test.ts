import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import {
  buildOwnerProspectAcquisitionOverview,
  loadOwnerProspectAcquisitionUsage,
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
  assert.equal(state.body.prospectAcquisition.usage.availability, "unavailable");
  assert.equal(state.body.prospectAcquisition.usage.email.recipientsReserved, null);
  assert.deepEqual(state.body.prospectAcquisition.usage.issues, ["database-disabled"]);
});

test("owner prospect usage reports durable rolling reservations, tokens, and approved exposure", async () => {
  const queries: string[] = [];
  const sql = (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    queries.push(query);
    if (query.includes("FROM prospect_outreach_jobs")) {
      return Promise.resolve([{
        recipients_reserved: 2,
        provider_accepted: 1,
        provider_failed: 1,
        provider_attempts: 3,
        reserved_spend_cents: 2,
      }]);
    }
    if (query.includes("FROM prospect_qc_model_reviews")) {
      return Promise.resolve([{
        reviews_reserved: 3,
        completed: 2,
        failed_or_unknown: 1,
        total_tokens: 287,
        reserved_spend_cents: 3,
      }]);
    }
    if (query.includes("FROM velvet_discovery_requests")) {
      return Promise.resolve([{
        requests: 1,
        approved: 1,
        completed: 0,
        provider_requests: 4,
        approved_max_spend_cents: 25,
      }]);
    }
    return Promise.reject(new Error("unexpected query"));
  };

  const usage = await loadOwnerProspectAcquisitionUsage(
    sql,
    7,
    "2026-08-02T12:00:00.000Z"
  );

  assert.equal(usage.availability, "available");
  assert.deepEqual(usage.period, {
    kind: "rolling-24-hours",
    startsAt: "2026-08-01T12:00:00.000Z",
    endsAt: "2026-08-02T12:00:00.000Z",
  });
  assert.equal(usage.email.recipientsReserved, 2);
  assert.equal(usage.email.providerAttempts, 3);
  assert.equal(usage.qc.totalTokens, 287);
  assert.equal(usage.qc.reservedSpendCents, 3);
  assert.equal(usage.discovery.providerRequests, 4);
  assert.equal(usage.discovery.approvedMaxSpendCents, 25);
  assert.deepEqual(usage.issues, []);
  assert.equal(usage.externalAction, "none");
  assert.equal(queries.length, 3);
  for (const query of queries) {
    assert.match(query, /workspace_id =/);
    assert.match(query, />=/);
  }
});

test("owner prospect usage exposes a partial failure instead of reporting false zeroes", async () => {
  const sql = (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("FROM prospect_outreach_jobs")) {
      return Promise.reject(new Error("email ledger unavailable"));
    }
    return Promise.resolve([{}]);
  };

  const usage = await loadOwnerProspectAcquisitionUsage(
    sql,
    7,
    "2026-08-02T12:00:00.000Z"
  );

  assert.equal(usage.availability, "partial");
  assert.equal(usage.email.available, false);
  assert.equal(usage.email.recipientsReserved, null);
  assert.equal(usage.qc.available, true);
  assert.equal(usage.qc.totalTokens, 0);
  assert.deepEqual(usage.issues, ["email-usage-unavailable"]);
});

test("owner-control UI names the redacted prospect controls and safety boundary", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/App.tsx", import.meta.url), "utf8")
  );

  assert.match(source, /Prospect acquisition control plane/);
  assert.match(source, /Revenue-loop connections/);
  assert.match(source, /Execution switches/);
  assert.match(source, /Credential separation/);
  assert.match(source, /Rolling 24-hour controlled usage/);
  assert.match(source, /Provider acceptance is not delivery proof/);
  assert.match(source, /maximum is not actual spend/);
  assert.match(source, /zero tokens or spend are not assumed/);
  assert.match(source, /External evidence unproven/);
  assert.match(source, /No action authorized/i);
  assert.match(source, /cannot enable a switch, contact a prospect, or authorize spend/);
});
