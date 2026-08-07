import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import {
  buildOwnerCredentialInventory,
  buildOwnerConnectionManagement,
  buildOwnerProspectAcquisitionOverview,
  loadOwnerProspectAcquisitionUsage,
  registerOwnerControlRoutes,
} from "../src/routes/owner-control-routes.ts";
import { SETTINGS_GROUPS } from "../src/settings.ts";

test("owner connection management exposes only allowlisted repair links and redacted credential state", () => {
  const active = buildOwnerConnectionManagement({
    id: "openrouter",
    status: "online",
    configured: true,
    detail: "Credits endpoint reachable.",
    verification: "provider_probe",
  });
  assert.equal(active.credentialState, "active");
  assert.equal(active.actionRequired, false);
  assert.deepEqual(active.actions.map((action) => action.id), [
    "configure",
    "provider",
    "billing",
  ]);
  assert.match(active.actions[0].href, /^\/dashboard\/settings\?connection=/);
  for (const action of active.actions.filter((item) => item.external)) {
    assert.match(action.href, /^https:\/\//);
    assert.doesNotMatch(action.href, /(?:key|token|secret)=/i);
  }

  const rejected = buildOwnerConnectionManagement({
    id: "resend",
    status: "warn",
    configured: true,
    detail: "Resend returned 401",
    verification: "provider_probe",
  });
  assert.equal(rejected.credentialState, "rejected");
  assert.equal(rejected.actionRequired, true);

  const missing = buildOwnerConnectionManagement({
    id: "twilio",
    status: "offline",
    configured: false,
    detail: "Credentials missing.",
    verification: "provider_probe",
  });
  assert.equal(missing.credentialState, "missing");
  assert.equal(missing.actionRequired, true);

  const configuredOnly = buildOwnerConnectionManagement({
    id: "google_tts",
    status: "unknown",
    configured: true,
    detail: "Configured but not provider-probed.",
    verification: "configuration",
  });
  assert.equal(configuredOnly.credentialState, "unverified");
  assert.equal(configuredOnly.actions[0].href, "/dashboard/settings?connection=google_tts");
});

test("owner credential inventory is comprehensive and never returns credential bytes", () => {
  const secret = `sk-${"x".repeat(40)}`;
  const inventory = buildOwnerCredentialInventory({
    OPENROUTER_API_KEY: secret,
    HUBSPOT_ACCESS_TOKEN: secret,
    APOLLO_API_KEY: secret,
    TELEGRAM_WEBHOOK_SECRET: secret,
    VELVET_OUTCOME_SIGNING_SECRET: secret,
  });

  assert.ok(inventory.length >= 55);
  for (const key of [
    "DATABASE_URL",
    "OPENROUTER_API_KEY",
    "HUBSPOT_ACCESS_TOKEN",
    "APOLLO_API_KEY",
    "TELEGRAM_WEBHOOK_SECRET",
    "VELVET_OUTCOME_SIGNING_SECRET",
  ]) {
    assert.ok(inventory.some((item) => item.key === key), key);
  }
  assert.equal(inventory.find((item) => item.key === "OPENROUTER_API_KEY")?.configured, true);
  assert.equal(JSON.stringify(inventory).includes(secret), false);
});

test("admin settings expose CRM and lead provider setup without an outreach switch", () => {
  const crm = SETTINGS_GROUPS.find((group) => group.id === "crm");
  const leadProviders = SETTINGS_GROUPS.find((group) => group.id === "lead_providers");
  assert.ok(crm);
  assert.ok(leadProviders);
  assert.ok(crm.fields.some((field) => field.key === "HUBSPOT_ACCESS_TOKEN"));
  assert.ok(crm.fields.some((field) => field.key === "SALESFORCE_REFRESH_TOKEN"));
  assert.ok(leadProviders.fields.some((field) => field.key === "APOLLO_API_KEY"));
  assert.ok(leadProviders.fields.some((field) => field.key === "GOOGLE_MAPS_API_KEY"));
  const serialized = JSON.stringify([crm, leadProviders]);
  assert.doesNotMatch(serialized, /SMS.*enabled|auto.?dial|send.*enabled/i);
});

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

  assert.equal(result.connections.length, 11);
  assert.equal(result.executionSwitches.length, 9);
  assert.equal(result.phases.length, 7);
  const authorityPhase = result.phases.find(
    (phase) => phase.id === "velvet-authority"
  );
  assert.ok(authorityPhase);
  assert.ok(
    authorityPhase.requiredVariables.some(
      (variable) =>
        variable.name === "VELVET_LEAD_SOURCE_API_KEY" &&
        variable.sensitive &&
        variable.currentValueDisclosed === false
    )
  );
  assert.ok(
    authorityPhase.setupLinks.some(
      (link) => link.href === "https://velvetalchemy.manus.space/api-keys"
    )
  );
  assert.match(
    authorityPhase.nextCheckCommand,
    /configuration-phase=velvet-authority/
  );
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
  assert.equal(state.body.prospectAcquisition.connections.length, 11);
  assert.equal(state.body.prospectAcquisition.executionSwitches.length, 9);
  assert.equal(state.body.prospectAcquisition.externalAction, "none");
  assert.equal(
    state.body.prospectAcquisition.activation.contactAuthorized,
    false
  );
  assert.equal(state.body.prospectAcquisition.usage.availability, "unavailable");
  assert.equal(state.body.prospectAcquisition.usage.email.recipientsReserved, null);
  assert.equal(state.body.prospectAcquisition.usage.manualCall.approvals, null);
  assert.deepEqual(state.body.prospectAcquisition.usage.issues, ["database-disabled"]);
  assert.equal(state.body.settingsStorage.durableInAppWrites, false);
  assert.equal(state.body.operationalChecklist.length, 8);
  for (const connectionId of [
    "google_tts",
    "hubspot",
    "salesforce",
    "airtable",
    "notion",
    "apollo",
    "brave_search",
    "serper",
    "google_maps",
  ]) {
    assert.ok(state.body.connections.some((item: any) => item.id === connectionId), connectionId);
  }
  assert.ok(state.body.credentials.length >= 55);
  assert.equal(
    state.body.operationalChecklist.find((item: any) => item.id === "production_backup")?.state,
    "unverified"
  );
});

test("owner prospect usage reports durable rolling reservations, tokens, and approved exposure", async () => {
  const queries: string[] = [];
  const sql = (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    queries.push(query);
    if (
      query.includes("FROM prospect_outreach_jobs") &&
      query.includes("channel = 'call'")
    ) {
      return Promise.resolve([{
        approvals: 1,
        open_approved: 0,
        recorded_completed: 1,
        closed_without_execution: 0,
      }]);
    }
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
  assert.equal(usage.manualCall.approvals, 1);
  assert.equal(usage.manualCall.recordedCompleted, 1);
  assert.equal(usage.manualCall.providerRequests, 0);
  assert.equal(usage.manualCall.automatedDials, 0);
  assert.deepEqual(usage.issues, []);
  assert.equal(usage.externalAction, "none");
  assert.equal(queries.length, 4);
  for (const query of queries) {
    assert.match(query, /workspace_id =/);
    assert.match(query, />=/);
  }
});

test("owner prospect usage exposes a partial failure instead of reporting false zeroes", async () => {
  const sql = (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (
      query.includes("FROM prospect_outreach_jobs") &&
      query.includes("channel = 'email'")
    ) {
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
  assert.equal(usage.manualCall.available, true);
  assert.equal(usage.manualCall.approvals, 0);
  assert.deepEqual(usage.issues, ["email-usage-unavailable"]);
});

test("owner-control UI names the redacted prospect controls and safety boundary", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/App.tsx", import.meta.url), "utf8")
  );

  assert.match(source, /Prospect acquisition control plane/);
  assert.match(source, /Revenue-loop connections/);
  assert.match(source, /Execution switches/);
  assert.match(source, /Seven-phase release sequence/);
  assert.match(source, /Copy redacted template/);
  assert.match(source, /External prerequisites/);
  assert.match(source, /Manual prospect calls/);
  assert.match(source, /provider requests.*automated dials/i);
  assert.match(source, /Credential separation/);
  assert.match(source, /Rolling 24-hour controlled usage/);
  assert.match(source, /Provider acceptance is not delivery proof/);
  assert.match(source, /maximum is not actual spend/);
  assert.match(source, /zero tokens or spend are not assumed/);
  assert.match(source, /External evidence unproven/);
  assert.match(source, /No action authorized/i);
  assert.match(source, /cannot enable a switch, contact a prospect, or authorize spend/);
  assert.match(source, /Operational requirements/);
  assert.match(source, /action\.id === "billing"/);
  assert.match(source, /Rejected \/ expired/);
  assert.match(source, /Production secret rule/);
});
