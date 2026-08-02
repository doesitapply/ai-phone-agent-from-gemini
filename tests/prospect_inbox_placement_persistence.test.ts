import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import {
  PROSPECT_INBOX_PLACEMENT_FINALIZE_CONFIRMATION,
  PROSPECT_INBOX_PLACEMENT_INSPECTION_CONFIRMATION,
  PROSPECT_INBOX_PLACEMENT_PREPARE_CONFIRMATION,
} from "../src/prospect-inbox-placement.ts";
import { PROSPECT_EMAIL_EXECUTION_CONFIRMATION } from "../src/prospect-email-provider.ts";
import { PROSPECT_MESSAGE_EXPERIMENT_ACTIVATION_CONFIRMATION } from "../src/prospect-message-experiments.ts";

const databaseUrl =
  process.env.SMIRK_INBOX_PLACEMENT_TEST_DATABASE_URL || "";

function requireDisposableDatabase(raw: string): void {
  const parsed = new URL(raw);
  const databaseName = parsed.pathname.replace(/^\//, "");
  assert.ok(
    ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname),
    "Inbox-placement persistence tests require a loopback Postgres host."
  );
  assert.match(
    databaseName,
    /^smirk_inbox_placement_test_[a-z0-9_]+$/,
    "Inbox-placement persistence tests require a disposable database name."
  );
  assert.equal(parsed.search, "");
  assert.equal(parsed.hash, "");
}

type CapturedHandler = (
  req: Request,
  res: Response,
  next: () => void
) => unknown;

function makeResponse() {
  const state: { statusCode: number; body: any } = {
    statusCode: 200,
    body: undefined,
  };
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

test(
  "real Postgres proves five controlled seeds, immutable inspection, and activation binding",
  { skip: !databaseUrl },
  async () => {
    requireDisposableDatabase(databaseUrl);
    process.env.DATABASE_URL = databaseUrl;
    const [
      { sql },
      { initProspectorSchema },
      inboxRouteModule,
      outreachRouteModule,
      revenueLoopRouteModule,
    ] = await Promise.all([
      import("../src/db.ts"),
      import("../src/prospector.ts"),
      import("../src/routes/prospect-inbox-placement-routes.ts"),
      import("../src/routes/prospect-outreach-routes.ts"),
      import("../src/routes/prospect-revenue-loop-routes.ts"),
    ]);

    const routes = new Map<string, CapturedHandler>();
    const app: any = {};
    for (const method of ["get", "post", "patch"]) {
      app[method] = (
        path: string,
        ...handlers: CapturedHandler[]
      ) => {
        routes.set(
          `${method.toUpperCase()} ${path}`,
          handlers.at(-1)!
        );
      };
    }
    const pass = (
      _req: Request,
      _res: Response,
      next: () => void
    ) => next();
    const baseNow = new Date();
    const mailboxes = [
      {
        label: "Google seed 1",
        provider: "google_workspace",
        email: "google-one@example.invalid",
      },
      {
        label: "Microsoft seed 1",
        provider: "microsoft_365",
        email: "microsoft-one@example.invalid",
      },
      {
        label: "Google seed 2",
        provider: "google_workspace",
        email: "google-two@example.invalid",
      },
      {
        label: "Microsoft seed 2",
        provider: "microsoft_365",
        email: "microsoft-two@example.invalid",
      },
      {
        label: "Yahoo seed",
        provider: "yahoo_aol",
        email: "yahoo-one@example.invalid",
      },
    ];
    const env = {
      PROSPECT_INBOX_SEED_ALLOWLIST: mailboxes
        .map((mailbox) => mailbox.email)
        .join(","),
      PROSPECT_EMAIL_EXECUTION_ENABLED: "true",
      PROSPECT_EMAIL_EXECUTION_MODE:
        "single-recipient-reviewed-v1",
      PROSPECT_EMAIL_RESEND_API_KEY:
        "re_synthetic_inbox_placement_key",
      PROSPECT_EMAIL_FROM: "SMIRK <hello@smirkcalls.com>",
      PROSPECT_EMAIL_REPLY_TO: "hello@smirkcalls.com",
      PROSPECT_EMAIL_WORKSPACE_ID: "1",
      PROSPECT_EMAIL_DAILY_RECIPIENT_CAP: "10",
      PROSPECT_EMAIL_DAILY_SPEND_CAP_CENTS: "20",
      PROSPECT_EMAIL_UNIT_COST_CENTS: "1",
      PROSPECT_EMAIL_WEBHOOK_ENABLED: "true",
      PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET:
        "whsec_synthetic_inbox_placement",
    };
    let providerRequests = 0;
    const providerBodies: Array<Record<string, unknown>> = [];
    const fakeFetch = (async (
      input: string | URL | globalThis.Request,
      init?: RequestInit
    ) => {
      assert.equal(
        String(input),
        "https://api.resend.com/emails"
      );
      providerRequests += 1;
      providerBodies.push(
        JSON.parse(String(init?.body || "{}"))
      );
      return new Response(
        JSON.stringify({ id: `seed-message-${providerRequests}` }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }) as typeof fetch;
    const getWorkspaceId = (req: Request) =>
      Number((req as any).workspaceId || 1);

    inboxRouteModule.registerProspectInboxPlacementRoutes(app, {
      dashboardAuth: pass as any,
      requireOperator: pass as any,
      requireFullOperator: pass as any,
      sql,
      dbEnabled: true,
      getWorkspaceId,
      env,
      now: () => baseNow,
    });
    outreachRouteModule.registerProspectOutreachRoutes(app, {
      dashboardAuth: pass as any,
      requireOperator: pass as any,
      requireFullOperator: pass as any,
      sql,
      dbEnabled: true,
      getWorkspaceId,
      env,
      fetchImpl: fakeFetch,
      now: () => new Date(baseNow.getTime() + 60_000),
    });
    revenueLoopRouteModule.registerProspectRevenueLoopRoutes(app, {
      dashboardAuth: pass as any,
      requireOperator: pass as any,
      sql,
      dbEnabled: true,
      getWorkspaceId,
      env,
    });

    const readRevenueLoop = async () => {
      const handler = routes.get("GET /api/prospecting/revenue-loop");
      assert.ok(handler);
      const result = makeResponse();
      await handler(
        {
          authMode: "operator",
          workspaceId: 1,
        } as unknown as Request,
        result.response,
        () => undefined
      );
      assert.equal(
        result.state.statusCode,
        200,
        JSON.stringify(result.state.body)
      );
      return result.state.body;
    };

    await initProspectorSchema();
    const campaignRows = await sql<{ id: number }[]>`
      INSERT INTO prospecting_campaigns (
        workspace_id, name, status, target_industry, target_location
      ) VALUES (
        1, 'Synthetic inbox placement target', 'active',
        'plumbing', 'Reno, NV'
      )
      RETURNING id
    `;
    const campaignId = campaignRows[0].id;
    const evidence = [
      {
        url: "https://example.invalid/synthetic-inbox-business",
        observation:
          "The synthetic public page lists emergency service contact details.",
        observedAt: "2026-07-30T15:00:00.000Z",
        kind: "contact_path",
        basis: "observed",
        confidence: "high",
      },
    ];
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      await sql`
        INSERT INTO prospect_leads (
          campaign_id, business_name, email, email_verification,
          industry, source, external_id, research_evidence,
          review_state
        ) VALUES (
          ${campaignId}, ${`Synthetic Inbox Business ${sequence}`},
          ${`inbox-owner-${sequence}@example.invalid`},
          'verified_owner_email', 'plumbing', 'manual',
          ${`synthetic-inbox-prospect-${sequence}`},
          ${sql.json(evidence)}, 'qualified'
        )
      `;
    }

    const prepareHandler = routes.get(
      "POST /api/prospecting/inbox-placement"
    );
    assert.ok(prepareHandler);
    const prepared = makeResponse();
    await prepareHandler(
      {
        body: {
          campaignId,
          controlVariantKey: "micro-after-hours-v1",
          challengerVariantKey: "micro-weekend-work-v1",
          mailboxes,
          emailCompliance: {
            senderIdentity: "SMIRK",
            advertisementDisclosure:
              "This is a commercial message from SMIRK.",
            physicalPostalAddress:
              "1605 McKinley Drive, Reno, NV 89509",
            optOutInstructions:
              "Reply stop if you do not want another commercial email.",
          },
          maxCostCents: 2,
          expiresInHours: 72,
          confirmation:
            PROSPECT_INBOX_PLACEMENT_PREPARE_CONFIRMATION,
          attestations: {
            controlledMailboxesOnly: true,
            mailboxAccessVerified: true,
            noRealProspectsIncluded: true,
            noContactOrSpendAuthorized: true,
          },
        },
        authMode: "operator",
        workspaceId: 1,
      } as unknown as Request,
      prepared.response,
      () => undefined
    );
    assert.equal(
      prepared.state.statusCode,
      201,
      JSON.stringify(prepared.state.body)
    );
    assert.equal(prepared.state.body.items.length, 5);
    assert.equal(prepared.state.body.externalAction, "none");
    assert.equal(providerRequests, 0);
    const preparedLoop = await readRevenueLoop();
    assert.equal(
      preparedLoop.nextAction.code,
      "REVIEW_CONTROLLED_INBOX_SEED"
    );
    assert.equal(preparedLoop.nextAction.executionEffect, "none");
    assert.deepEqual(preparedLoop.nextAction.focus, {
      kind: "inbox_placement",
      testId: prepared.state.body.testId,
      campaignId,
      approvalId: prepared.state.body.items[0].approvalId,
    });

    const approveHandler = routes.get(
      "POST /api/prospecting/outreach/:approvalId/approve"
    );
    const executeHandler = routes.get(
      "POST /api/prospecting/outreach/:approvalId/execute"
    );
    const inspectHandler = routes.get(
      "POST /api/prospecting/inbox-placement/:testId/items/:approvalId/inspect"
    );
    assert.ok(approveHandler);
    assert.ok(executeHandler);
    assert.ok(inspectHandler);

    for (const [index, item] of prepared.state.body.items.entries()) {
      const approved = makeResponse();
      await approveHandler(
        {
          params: { approvalId: item.approvalId },
          body: {
            payloadHash: item.payloadHash,
            attestations: {
              recipientReviewed: true,
              suppressionChecked: true,
              emailComplianceReviewed: true,
            },
          },
          authMode: "operator",
          workspaceId: 1,
        } as unknown as Request,
        approved.response,
        () => undefined
      );
      assert.equal(
        approved.state.statusCode,
        200,
        JSON.stringify(approved.state.body)
      );
      const approvedLoop = await readRevenueLoop();
      assert.equal(
        approvedLoop.nextAction.code,
        "SEND_ONE_CONTROLLED_INBOX_SEED"
      );
      assert.equal(
        approvedLoop.nextAction.executionEffect,
        "one_controlled_seed_email"
      );
      assert.deepEqual(approvedLoop.nextAction.focus, {
        kind: "inbox_placement",
        testId: prepared.state.body.testId,
        campaignId,
        approvalId: item.approvalId,
      });

      const executed = makeResponse();
      await executeHandler(
        {
          params: { approvalId: item.approvalId },
          body: {
            payloadHash: item.payloadHash,
            confirmation: PROSPECT_EMAIL_EXECUTION_CONFIRMATION,
          },
          authMode: "operator",
          workspaceId: 1,
        } as unknown as Request,
        executed.response,
        () => undefined
      );
      assert.equal(
        executed.state.statusCode,
        200,
        JSON.stringify(executed.state.body)
      );
      assert.equal(executed.state.body.state, "SENT");
      const providerMessageId =
        executed.state.body.providerMessageId;
      const sentLoop = await readRevenueLoop();
      assert.equal(
        sentLoop.nextAction.code,
        "INSPECT_CONTROLLED_INBOX_SEED"
      );
      assert.equal(sentLoop.nextAction.executionEffect, "none");
      assert.deepEqual(sentLoop.nextAction.focus, {
        kind: "inbox_placement",
        testId: prepared.state.body.testId,
        campaignId,
        approvalId: item.approvalId,
      });

      if (index === 0) {
        const forged = makeResponse();
        await inspectHandler(
          {
            params: {
              testId: prepared.state.body.testId,
              approvalId: item.approvalId,
            },
            body: {
              definitionHash: prepared.state.body.definitionHash,
              payloadHash: item.payloadHash,
              providerMessageId: "forged-message",
              inspectedAt: new Date(
                baseNow.getTime() + 2 * 60_000
              ).toISOString(),
              folder: "primary",
              smtpAccepted: true,
              spf: "PASS",
              dkim: "PASS",
              dmarc: "PASS",
              fromAligned: true,
              plainTextOnly: true,
              trackingPixelAbsent: true,
              unexpectedLinksAbsent: true,
              complianceFooterRendered: true,
              confirmation:
                PROSPECT_INBOX_PLACEMENT_INSPECTION_CONFIRMATION,
              attestations: {
                mailboxOpenedByOperator: true,
                folderLocationObserved: true,
                rawHeadersReviewed: true,
              },
            },
            authMode: "operator",
            workspaceId: 1,
          } as unknown as Request,
          forged.response,
          () => undefined
        );
        assert.equal(forged.state.statusCode, 409);
        assert.equal(
          forged.state.body.code,
          "PROSPECT_INBOX_PLACEMENT_SENT_PROOF_REQUIRED"
        );
      }

      const inspectionBody = {
        definitionHash: prepared.state.body.definitionHash,
        payloadHash: item.payloadHash,
        providerMessageId,
        inspectedAt: new Date(
          baseNow.getTime() + 2 * 60_000
        ).toISOString(),
        folder: "primary",
        smtpAccepted: true,
        spf: "PASS",
        dkim: "PASS",
        dmarc: "PASS",
        fromAligned: true,
        plainTextOnly: true,
        trackingPixelAbsent: true,
        unexpectedLinksAbsent: true,
        complianceFooterRendered: true,
        confirmation:
          PROSPECT_INBOX_PLACEMENT_INSPECTION_CONFIRMATION,
        attestations: {
          mailboxOpenedByOperator: true,
          folderLocationObserved: true,
          rawHeadersReviewed: true,
        },
      };
      const inspected = makeResponse();
      await inspectHandler(
        {
          params: {
            testId: prepared.state.body.testId,
            approvalId: item.approvalId,
          },
          body: inspectionBody,
          authMode: "operator",
          workspaceId: 1,
        } as unknown as Request,
        inspected.response,
        () => undefined
      );
      assert.equal(
        inspected.state.statusCode,
        200,
        JSON.stringify(inspected.state.body)
      );
      const replay = makeResponse();
      await inspectHandler(
        {
          params: {
            testId: prepared.state.body.testId,
            approvalId: item.approvalId,
          },
          body: inspectionBody,
          authMode: "operator",
          workspaceId: 1,
        } as unknown as Request,
        replay.response,
        () => undefined
      );
      assert.equal(replay.state.body.outcome, "duplicate");
      const inspectedLoop = await readRevenueLoop();
      assert.equal(
        inspectedLoop.nextAction.code,
        index === prepared.state.body.items.length - 1
          ? "FINALIZE_INBOX_PLACEMENT"
          : "REVIEW_CONTROLLED_INBOX_SEED"
      );
    }

    assert.equal(providerRequests, 5);
    assert.equal(
      providerBodies.every(
        (body) =>
          Array.isArray(body.to) &&
          body.to.length === 1 &&
          typeof body.text === "string" &&
          !("html" in body)
      ),
      true
    );
    const finalizableLoop = await readRevenueLoop();
    assert.equal(
      finalizableLoop.nextAction.code,
      "FINALIZE_INBOX_PLACEMENT"
    );
    assert.equal(
      finalizableLoop.counts.inboxPlacementReadyToFinalize,
      1
    );
    assert.equal(finalizableLoop.counts.inboxSeedInspected, 5);

    const finalizeHandler = routes.get(
      "POST /api/prospecting/inbox-placement/:testId/finalize"
    );
    assert.ok(finalizeHandler);
    const finalized = makeResponse();
    await finalizeHandler(
      {
        params: { testId: prepared.state.body.testId },
        body: {
          definitionHash: prepared.state.body.definitionHash,
          confirmation:
            PROSPECT_INBOX_PLACEMENT_FINALIZE_CONFIRMATION,
          attestations: {
            allFiveMailboxesReviewed: true,
            rawHeadersReviewed: true,
            noRealProspectOutreach: true,
          },
        },
        authMode: "operator",
        workspaceId: 1,
      } as unknown as Request,
      finalized.response,
      () => undefined
    );
    assert.equal(
      finalized.state.statusCode,
      200,
      JSON.stringify(finalized.state.body)
    );
    assert.equal(finalized.state.body.state, "PASSED");
    assert.equal(
      finalized.state.body.receipt.authorizesExperimentActivation,
      true
    );
    assert.equal(
      finalized.state.body.receipt.authorizesContact,
      false
    );
    const passedLoop = await readRevenueLoop();
    assert.equal(
      passedLoop.nextAction.code,
      "PREPARE_EMAIL_EXPERIMENT"
    );

    const experimentPrepareHandler = routes.get(
      "POST /api/prospecting/learning/experiments"
    );
    assert.ok(experimentPrepareHandler);
    const experimentPrepared = makeResponse();
    await experimentPrepareHandler(
      {
        body: {
          campaignId,
          channel: "email",
          controlVariantKey: "micro-after-hours-v1",
          challengerVariantKey: "micro-weekend-work-v1",
        },
        authMode: "operator",
        workspaceId: 1,
      } as unknown as Request,
      experimentPrepared.response,
      () => undefined
    );
    assert.equal(
      experimentPrepared.state.statusCode,
      201,
      JSON.stringify(experimentPrepared.state.body)
    );

    const activateHandler = routes.get(
      "POST /api/prospecting/learning/experiments/:experimentId/activate"
    );
    assert.ok(activateHandler);
    const activated = makeResponse();
    await activateHandler(
      {
        params: {
          experimentId: experimentPrepared.state.body.experimentId,
        },
        body: {
          definitionHash:
            experimentPrepared.state.body.definitionHash,
          confirmation:
            PROSPECT_MESSAGE_EXPERIMENT_ACTIVATION_CONFIRMATION,
          attestations: {
            registeredContentReviewed: true,
            deterministicAssignmentReviewed: true,
            noContactOrSpendAuthorized: true,
          },
        },
        authMode: "operator",
        workspaceId: 1,
      } as unknown as Request,
      activated.response,
      () => undefined
    );
    assert.equal(
      activated.state.statusCode,
      200,
      JSON.stringify(activated.state.body)
    );
    assert.equal(
      activated.state.body.inboxPlacementTestId,
      prepared.state.body.testId
    );

    const seedJobRows = await sql<{
      id: number;
      campaign_id: number;
      lead_id: number;
      approval_id: string;
    }[]>`
      SELECT id, campaign_id, lead_id, approval_id
      FROM prospect_outreach_jobs
      WHERE workspace_id = 1 AND is_seed = TRUE
      ORDER BY id ASC
      LIMIT 1
    `;
    const outcomeHandler = routes.get(
      "POST /api/prospecting/leads/:id/outcomes"
    );
    assert.ok(outcomeHandler);
    const forbiddenSeedOutcome = makeResponse();
    await outcomeHandler(
      {
        params: { id: String(seedJobRows[0].lead_id) },
        body: {
          externalEventId: "synthetic-seed-event-1",
          outcome: "delivered",
          occurredAt: new Date(
            baseNow.getTime() + 3 * 60_000
          ).toISOString(),
          outreachApprovalId: seedJobRows[0].approval_id,
          notes: "Controlled seed must remain placement evidence.",
        },
        authMode: "operator",
        workspaceId: 1,
      } as unknown as Request,
      forbiddenSeedOutcome.response,
      () => undefined
    );
    assert.equal(forbiddenSeedOutcome.state.statusCode, 409);
    assert.equal(
      forbiddenSeedOutcome.state.body.code,
      "PROSPECT_SEED_OUTCOME_FORBIDDEN"
    );
    const scorecardHandler = routes.get(
      "GET /api/prospecting/learning/scorecard"
    );
    assert.ok(scorecardHandler);
    const scorecard = makeResponse();
    await scorecardHandler(
      {
        authMode: "operator",
        workspaceId: 1,
      } as unknown as Request,
      scorecard.response,
      () => undefined
    );
    assert.equal(scorecard.state.statusCode, 200);
    assert.equal(scorecard.state.body.sampleSize, 0);
    assert.equal(scorecard.state.body.eventCount, 0);

    const listHandler = routes.get(
      "GET /api/prospecting/inbox-placement"
    );
    assert.ok(listHandler);
    const otherWorkspace = makeResponse();
    await listHandler(
      {
        query: {},
        authMode: "operator",
        workspaceId: 2,
      } as unknown as Request,
      otherWorkspace.response,
      () => undefined
    );
    assert.equal(otherWorkspace.state.statusCode, 200);
    assert.deepEqual(otherWorkspace.state.body.tests, []);

    const proofRows = await sql<{
      test_count: number;
      seed_job_count: number;
      inspection_count: number;
      active_experiment_count: number;
      market_outcome_count: number;
      velvet_outbox_count: number;
    }[]>`
      SELECT
        (SELECT COUNT(*)::int
         FROM prospect_inbox_placement_tests
         WHERE workspace_id = 1 AND state = 'PASSED') AS test_count,
        (SELECT COUNT(*)::int
         FROM prospect_outreach_jobs
         WHERE workspace_id = 1 AND is_seed = TRUE
           AND state = 'SENT') AS seed_job_count,
        (SELECT COUNT(*)::int
         FROM prospect_inbox_placement_items
         WHERE workspace_id = 1
           AND inspection_hash IS NOT NULL) AS inspection_count,
        (SELECT COUNT(*)::int
         FROM prospect_message_experiments
         WHERE workspace_id = 1 AND state = 'ACTIVE'
           AND inbox_placement_test_id =
             ${prepared.state.body.testId}) AS active_experiment_count,
        (SELECT COUNT(*)::int
         FROM prospect_outcome_events
         WHERE workspace_id = 1) AS market_outcome_count,
        (SELECT COUNT(*)::int
         FROM velvet_outcome_outbox
         WHERE workspace_id = 1) AS velvet_outbox_count
    `;
    assert.deepEqual(proofRows[0], {
      test_count: 1,
      seed_job_count: 5,
      inspection_count: 5,
      active_experiment_count: 1,
      market_outcome_count: 0,
      velvet_outbox_count: 0,
    });
  }
);
