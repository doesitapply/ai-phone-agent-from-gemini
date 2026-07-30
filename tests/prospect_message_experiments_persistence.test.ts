import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import {
  buildProspectMessageExperimentAssignment,
  type ProspectMessageExperimentDefinition,
} from "../src/prospect-message-experiments.ts";
import {
  buildProspectMessageContext,
  renderProspectMessageVariant,
} from "../src/prospect-message-variants.ts";

const databaseUrl =
  process.env.SMIRK_EXPERIMENT_TEST_DATABASE_URL || "";

function requireDisposableDatabase(raw: string): void {
  const parsed = new URL(raw);
  const databaseName = parsed.pathname.replace(/^\//, "");
  assert.ok(
    ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname),
    "Experiment persistence tests require a loopback Postgres host."
  );
  assert.match(
    databaseName,
    /^smirk_experiment_test_[a-z0-9_]+$/,
    "Experiment persistence tests require a disposable database name."
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
  "real Postgres persists one closed deterministic message experiment",
  { skip: !databaseUrl },
  async () => {
    requireDisposableDatabase(databaseUrl);
    process.env.DATABASE_URL = databaseUrl;

    const [
      { sql },
      { initProspectorSchema, getCampaigns },
      routeModule,
    ] =
      await Promise.all([
        import("../src/db.ts"),
        import("../src/prospector.ts"),
        import("../src/routes/prospect-outreach-routes.ts"),
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
    routeModule.registerProspectOutreachRoutes(app, {
      dashboardAuth: pass as any,
      requireOperator: pass as any,
      requireFullOperator: pass as any,
      sql,
      dbEnabled: true,
      getWorkspaceId: (req: Request) =>
        Number((req as any).workspaceId || 1),
      now: () => new Date("2026-07-30T16:00:00.000Z"),
    });

    const originalFetch = globalThis.fetch;
    let networkAttempts = 0;
    globalThis.fetch = (async () => {
      networkAttempts += 1;
      throw new Error(
        "Network access is forbidden in experiment persistence proof."
      );
    }) as typeof fetch;

    try {
      await initProspectorSchema();
      const campaignRows = await sql<{ id: number }[]>`
        INSERT INTO prospecting_campaigns (
          workspace_id, name, status, target_industry, target_location
        ) VALUES (
          1, 'Synthetic experiment campaign', 'active',
          'plumbing', 'Reno, NV'
        )
        RETURNING id
      `;
      const campaignId = campaignRows[0].id;

      const prepareHandler = routes.get(
        "POST /api/prospecting/learning/experiments"
      );
      assert.ok(prepareHandler);
      const prepared = makeResponse();
      await prepareHandler(
        {
          body: {
            campaignId,
            channel: "email",
            controlVariantKey: "owner-language-v1",
            challengerVariantKey: "owner-language-v2",
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
      const definition =
        prepared.state.body
          .definition as ProspectMessageExperimentDefinition;
      const definitionHash = String(
        prepared.state.body.definitionHash
      );

      const activateHandler = routes.get(
        "POST /api/prospecting/learning/experiments/:experimentId/activate"
      );
      assert.ok(activateHandler);
      const activated = makeResponse();
      await activateHandler(
        {
          params: { experimentId: definition.experimentId },
          body: {
            definitionHash,
            confirmation:
              "activate-one-reviewed-message-experiment-v1",
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
      assert.equal(activated.state.statusCode, 200);
      assert.equal(activated.state.body.state, "ACTIVE");

      const evidence = [
        {
          url: "https://example.com/synthetic-business",
          observation:
            "The public page offers an emergency service contact.",
          observedAt: "2026-07-30T15:00:00.000Z",
          kind: "contact_path",
          basis: "observed",
          confidence: "high",
        },
      ];
      const selected = {
        control: [] as Array<{
          id: number;
          index: number;
          businessName: string;
        }>,
        challenger: [] as Array<{
          id: number;
          index: number;
          businessName: string;
        }>,
      };
      let insertedLeadCount = 0;
      for (
        let sequence = 1;
        sequence <= 100 &&
        (selected.control.length < 10 ||
          selected.challenger.length < 10);
        sequence += 1
      ) {
        const businessName = `Synthetic Business ${sequence}`;
        const leadRows = await sql<{ id: number }[]>`
          INSERT INTO prospect_leads (
            campaign_id, business_name, email,
            email_verification, industry, source, external_id,
            research_evidence, review_state
          ) VALUES (
            ${campaignId}, ${businessName},
            ${`owner-${sequence}@example.invalid`},
            'verified_owner_email', 'plumbing', 'manual',
            ${`synthetic-experiment-${sequence}`},
            ${sql.json(evidence)}, 'qualified'
          )
          RETURNING id
        `;
        const leadId = leadRows[0].id;
        insertedLeadCount += 1;
        const assignment =
          buildProspectMessageExperimentAssignment({
            definition,
            prospectId: leadId,
            actualVariantKey: definition.controlVariantKey,
          });
        if (selected[assignment.arm].length < 10) {
          selected[assignment.arm].push({
            id: leadId,
            index: selected[assignment.arm].length,
            businessName,
          });
        }
      }
      assert.equal(selected.control.length, 10);
      assert.equal(selected.challenger.length, 10);
      const campaignSummaries = await getCampaigns(1);
      assert.equal(campaignSummaries.length, 1);
      assert.equal(
        campaignSummaries[0].total_leads,
        insertedLeadCount,
        "campaign reads must derive the lead count from persisted rows"
      );
      assert.equal((await getCampaigns(2)).length, 0);

      const outreachHandler = routes.get(
        "POST /api/prospecting/leads/:id/outreach"
      );
      assert.ok(outreachHandler);
      let replayChecked = false;
      for (const arm of ["control", "challenger"] as const) {
        for (const selectedLead of selected[arm]) {
          const assignedVariantKey =
            arm === "control"
              ? definition.controlVariantKey
              : definition.challengerVariantKey;
          const rendered = renderProspectMessageVariant(
            assignedVariantKey,
            buildProspectMessageContext({
              businessName: selectedLead.businessName,
              industry: "plumbing",
              researchEvidence: evidence,
            })
          );
          assert.ok(rendered?.subject);
          const request = {
            params: { id: String(selectedLead.id) },
            body: {
              channel: "email",
              subject: rendered.subject,
              body: rendered.content,
              emailCompliance: {
                senderIdentity: "SMIRK",
                advertisementDisclosure:
                  "This is a commercial message from SMIRK.",
                physicalPostalAddress:
                  "1605 McKinley Drive, Reno, NV 89509",
                optOutInstructions:
                  "If this is not relevant, reply no and I will not follow up.",
              },
              variantKey: assignedVariantKey,
              maxCostCents: 2,
              expiresInHours: 24,
            },
            authMode: "operator",
            workspaceId: 1,
          } as unknown as Request;
          const created = makeResponse();
          await outreachHandler(
            request,
            created.response,
            () => undefined
          );
          assert.equal(
            created.state.statusCode,
            201,
            JSON.stringify(created.state.body)
          );
          assert.equal(
            created.state.body.experimentAssignment.arm,
            arm
          );
          assert.equal(
            created.state.body.experimentAssignment.protocolCompliant,
            true
          );

          if (!replayChecked) {
            const replay = makeResponse();
            await outreachHandler(
              request,
              replay.response,
              () => undefined
            );
            assert.equal(replay.state.statusCode, 200);
            assert.equal(replay.state.body.outcome, "duplicate");
            assert.equal(
              replay.state.body.approvalId,
              created.state.body.approvalId
            );
            replayChecked = true;
          }

          const jobRows = await sql<{ id: number }[]>`
            UPDATE prospect_outreach_jobs
            SET state = 'SENT',
                sent_at = '2026-07-30T17:00:00.000Z'
            WHERE workspace_id = 1
              AND approval_id = ${created.state.body.approvalId}
              AND state = 'PREPARED'
            RETURNING id
          `;
          assert.equal(jobRows.length, 1);
          const isPositive =
            selectedLead.index < (arm === "control" ? 2 : 6);
          await sql`
            INSERT INTO prospect_outcome_events (
              workspace_id, campaign_id, lead_id, outreach_job_id,
              source, external_event_id, outcome, occurred_at,
              notes, recorded_by
            ) VALUES (
              1, ${campaignId}, ${selectedLead.id}, ${jobRows[0].id},
              'synthetic_persistence_test',
              ${`synthetic-outcome-${selectedLead.id}`},
              ${isPositive ? "replied" : "delivered"},
              '2026-07-30T18:00:00.000Z',
              'Synthetic experiment persistence proof.',
              'synthetic_test'
            )
          `;
        }
      }

      const closeHandler = routes.get(
        "POST /api/prospecting/learning/experiments/:experimentId/close"
      );
      assert.ok(closeHandler);
      const closed = makeResponse();
      await closeHandler(
        {
          params: { experimentId: definition.experimentId },
          body: {
            definitionHash,
            confirmation: "close-one-message-experiment-v1",
            attestations: {
              enrollmentStopped: true,
              allJobsTerminal: true,
              outcomeWindowReviewed: true,
            },
          },
          authMode: "operator",
          workspaceId: 1,
        } as unknown as Request,
        closed.response,
        () => undefined
      );
      assert.equal(
        closed.state.statusCode,
        200,
        JSON.stringify(closed.state.body)
      );
      assert.equal(closed.state.body.state, "CLOSED");

      const candidateHandler = routes.get(
        "POST /api/prospecting/learning/candidates"
      );
      assert.ok(candidateHandler);
      const candidate = makeResponse();
      const candidateRequest = {
        body: { experimentId: definition.experimentId },
        authMode: "operator",
        workspaceId: 1,
      } as unknown as Request;
      await candidateHandler(
        candidateRequest,
        candidate.response,
        () => undefined
      );
      assert.equal(
        candidate.state.statusCode,
        201,
        JSON.stringify(candidate.state.body)
      );
      assert.equal(candidate.state.body.sampleSize, 20);
      assert.equal(candidate.state.body.policyChanged, false);
      assert.equal(candidate.state.body.externalAction, "none");

      const candidateReplay = makeResponse();
      await candidateHandler(
        candidateRequest,
        candidateReplay.response,
        () => undefined
      );
      assert.equal(candidateReplay.state.statusCode, 200);
      assert.equal(candidateReplay.state.body.outcome, "duplicate");
      assert.equal(
        candidateReplay.state.body.id,
        candidate.state.body.id
      );

      const experimentListHandler = routes.get(
        "GET /api/prospecting/learning/experiments"
      );
      assert.ok(experimentListHandler);
      const otherWorkspace = makeResponse();
      await experimentListHandler(
        {
          authMode: "operator",
          workspaceId: 2,
        } as unknown as Request,
        otherWorkspace.response,
        () => undefined
      );
      assert.equal(otherWorkspace.state.statusCode, 200);
      assert.deepEqual(otherWorkspace.state.body.experiments, []);
      assert.equal(networkAttempts, 0);

      const persisted = await sql<{
        experiment_count: number;
        enrollment_count: number;
        candidate_count: number;
      }[]>`
        SELECT
          (
            SELECT COUNT(*)::int
            FROM prospect_message_experiments
            WHERE workspace_id = 1 AND state = 'CLOSED'
          ) AS experiment_count,
          (
            SELECT COUNT(*)::int
            FROM prospect_outreach_jobs
            WHERE workspace_id = 1
              AND payload->'experimentAssignment'->>'experimentId'
                = ${definition.experimentId}
          ) AS enrollment_count,
          (
            SELECT COUNT(*)::int
            FROM prospect_learning_candidates
            WHERE workspace_id = 1
              AND candidate_key =
                ${`experiment:${definition.experimentId}`}
          ) AS candidate_count
      `;
      assert.deepEqual(persisted[0], {
        experiment_count: 1,
        enrollment_count: 20,
        candidate_count: 1,
      });
    } finally {
      globalThis.fetch = originalFetch;
      await sql.end({ timeout: 5 });
    }
  }
);
