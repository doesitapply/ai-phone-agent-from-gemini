import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import {
  PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION,
  type ProspectMessageExperimentDefinition,
} from "../src/prospect-message-experiments.ts";
import {
  buildProspectMessageContext,
  renderProspectMessageVariant,
} from "../src/prospect-message-variants.ts";
import {
  PROSPECT_INBOX_PLACEMENT_PREPARE_CONFIRMATION,
  buildProspectInboxPlacementDefinition,
  buildProspectInboxPlacementReceipt,
  hashProspectInboxPlacementValue,
  prepareProspectInboxPlacementSchema,
  type ProspectInboxPlacementEvaluationItem,
} from "../src/prospect-inbox-placement.ts";

function passingInboxPlacementFixture(input: {
  workspaceId: number;
  campaignId: number;
  controlVariantKey: string;
  challengerVariantKey: string;
  testId?: string;
}) {
  const testId =
    input.testId ||
    "44444444-4444-4444-8444-444444444444";
  const data = prepareProspectInboxPlacementSchema.parse({
    campaignId: input.campaignId,
    controlVariantKey: input.controlVariantKey,
    challengerVariantKey: input.challengerVariantKey,
    mailboxes: [
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
    ],
    emailCompliance: {
      senderIdentity: "SMIRK",
      advertisementDisclosure:
        "This is a commercial message from SMIRK.",
      physicalPostalAddress: "1605 McKinley Drive, Reno, NV 89509",
      optOutInstructions:
        "If this is not relevant, reply no and I will not follow up.",
    },
    maxCostCents: 2,
    expiresInHours: 72,
    confirmation: PROSPECT_INBOX_PLACEMENT_PREPARE_CONFIRMATION,
    attestations: {
      controlledMailboxesOnly: true,
      mailboxAccessVerified: true,
      noRealProspectsIncluded: true,
      noContactOrSpendAuthorized: true,
    },
  });
  const definition = buildProspectInboxPlacementDefinition({
    testId,
    workspaceId: input.workspaceId,
    preparedAt: "2026-07-30T14:00:00.000Z",
    data,
  });
  const definitionHash =
    hashProspectInboxPlacementValue(definition);
  const items: ProspectInboxPlacementEvaluationItem[] =
    definition.mailboxes.map((mailbox) => {
      const payloadHash = String(mailbox.slot).repeat(64);
      const providerMessageId = `experiment-seed-${mailbox.slot}`;
      const inspection = {
        definitionHash,
        payloadHash,
        providerMessageId,
        inspectedAt: "2026-07-30T14:45:00.000Z",
        folder: "primary" as const,
        smtpAccepted: true,
        spf: "PASS" as const,
        dkim: "PASS" as const,
        dmarc: "PASS" as const,
        fromAligned: true,
        plainTextOnly: true,
        trackingPixelAbsent: true,
        unexpectedLinksAbsent: true,
        complianceFooterRendered: true,
        confirmation:
          "record-one-controlled-inbox-inspection-v1" as const,
        attestations: {
          mailboxOpenedByOperator: true as const,
          folderLocationObserved: true as const,
          rawHeadersReviewed: true as const,
        },
      };
      return {
        slot: mailbox.slot,
        label: mailbox.label,
        provider: mailbox.provider,
        approvalId: `00000000-0000-4000-8000-${String(
          mailbox.slot
        ).padStart(12, "0")}`,
        payloadHash,
        jobState: "SENT",
        storedProviderMessageId: providerMessageId,
        inspection,
        inspectionHash:
          hashProspectInboxPlacementValue(inspection),
      };
    });
  const receipt = buildProspectInboxPlacementReceipt({
    definition,
    definitionHash,
    finalizedAt: "2026-07-30T15:00:00.000Z",
    items,
  });
  return {
    testId,
    definition,
    definitionHash,
    receipt,
    receiptHash: hashProspectInboxPlacementValue(receipt),
  };
}

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
      revenueLoopRouteModule,
    ] =
      await Promise.all([
        import("../src/db.ts"),
        import("../src/prospector.ts"),
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
    revenueLoopRouteModule.registerProspectRevenueLoopRoutes(app, {
      dashboardAuth: pass as any,
      requireOperator: pass as any,
      sql,
      dbEnabled: true,
      getWorkspaceId: (req: Request) =>
        Number((req as any).workspaceId || 1),
      env: {},
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
      const insertedLeads = new Map<
        number,
        { businessName: string }
      >();
      for (let sequence = 1; sequence <= 30; sequence += 1) {
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
        insertedLeads.set(leadRows[0].id, { businessName });
      }

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
            cohortSize: 20,
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
      assert.equal(
        definition.contractVersion,
        PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION
      );
      const definitionHash = String(
        prepared.state.body.definitionHash
      );
      const inboxPlacement = passingInboxPlacementFixture({
        workspaceId: 1,
        campaignId,
        controlVariantKey: definition.controlVariantKey,
        challengerVariantKey:
          definition.challengerVariantKey,
      });
      await sql`
        INSERT INTO prospect_inbox_placement_tests (
          test_id, workspace_id, target_campaign_id, state,
          control_variant_key, challenger_variant_key,
          definition, definition_hash, receipt, receipt_hash,
          prepared_by, finalized_by, finalized_at, valid_until,
          expires_at
        ) VALUES (
          ${inboxPlacement.testId}, 1, ${campaignId}, 'PASSED',
          ${definition.controlVariantKey},
          ${definition.challengerVariantKey},
          ${sql.json(inboxPlacement.definition)},
          ${inboxPlacement.definitionHash},
          ${sql.json(inboxPlacement.receipt)},
          ${inboxPlacement.receiptHash},
          'synthetic_test', 'synthetic_test',
          ${inboxPlacement.receipt.finalizedAt},
          ${inboxPlacement.receipt.validUntil},
          ${inboxPlacement.definition.expiresAt}
        )
      `;

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
      const revenueLoopHandler = routes.get(
        "GET /api/prospecting/revenue-loop"
      );
      assert.ok(revenueLoopHandler);
      const beforeDraftFeed = makeResponse();
      await revenueLoopHandler(
        {
          authMode: "operator",
          workspaceId: 1,
        } as unknown as Request,
        beforeDraftFeed.response,
        () => undefined
      );
      assert.equal(
        beforeDraftFeed.state.statusCode,
        200,
        JSON.stringify(beforeDraftFeed.state.body)
      );
      assert.equal(
        beforeDraftFeed.state.body.counts
          .emailExperimentUnenrolled,
        20
      );
      assert.equal(
        beforeDraftFeed.state.body.nextAction.code,
        "PREPARE_EXPERIMENT_DRAFTS"
      );

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
      if (
        definition.contractVersion !==
        PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION
      ) {
        assert.fail("Expected a frozen-cohort experiment definition.");
      }
      for (const entry of definition.cohort) {
        const inserted = insertedLeads.get(entry.prospectId);
        assert.ok(inserted);
        selected[entry.arm].push({
          id: entry.prospectId,
          index: selected[entry.arm].length,
          businessName: inserted.businessName,
        });
      }
      assert.equal(selected.control.length, 10);
      assert.equal(selected.challenger.length, 10);
      const campaignSummaries = await getCampaigns(1);
      assert.equal(campaignSummaries.length, 1);
      assert.equal(
        campaignSummaries[0].total_leads,
        insertedLeads.size,
        "campaign reads must derive the lead count from persisted rows"
      );
      assert.equal((await getCampaigns(2)).length, 0);

      const prepareDraftsHandler = routes.get(
        "POST /api/prospecting/learning/experiments/:experimentId/prepare-drafts"
      );
      assert.ok(prepareDraftsHandler);
      const prepareOneDraftHandler = routes.get(
        "POST /api/prospecting/leads/:id/outreach"
      );
      assert.ok(prepareOneDraftHandler);
      const prepareDraftsRequest = {
        params: { experimentId: definition.experimentId },
        body: {
          channel: "email",
          definitionHash,
          confirmation: "prepare-frozen-cohort-drafts-v1",
          emailCompliance: {
            senderIdentity: "SMIRK",
            advertisementDisclosure:
              "This is a commercial message from SMIRK.",
            physicalPostalAddress:
              "1605 McKinley Drive, Reno, NV 89509",
            optOutInstructions:
              "If this is not relevant, reply no and I will not follow up.",
          },
          maxCostCents: 2,
          expiresInHours: 24,
          attestations: {
            frozenCohortReviewed: true,
            recipientApprovalStillRequired: true,
            noContactOrSpendAuthorized: true,
          },
        },
        authMode: "operator",
        workspaceId: 1,
      } as unknown as Request;

      const offProtocolEntry = definition.cohort[0];
      const offProtocolLead = insertedLeads.get(
        offProtocolEntry.prospectId
      );
      assert.ok(offProtocolLead);
      const assignedCopy = renderProspectMessageVariant(
        offProtocolEntry.assignedVariantKey,
        buildProspectMessageContext({
          businessName: offProtocolLead.businessName,
          industry: "plumbing",
          researchEvidence: evidence,
        })
      );
      assert.ok(assignedCopy?.subject);
      const offProtocolDraft = makeResponse();
      await prepareOneDraftHandler(
        {
          params: { id: String(offProtocolEntry.prospectId) },
          body: {
            channel: "email",
            subject: assignedCopy.subject,
            body: `${assignedCopy.content}\n\nWould that be relevant?`,
            emailCompliance:
              prepareDraftsRequest.body.emailCompliance,
            variantKey: offProtocolEntry.assignedVariantKey,
            maxCostCents: 2,
            expiresInHours: 24,
          },
          authMode: "operator",
          workspaceId: 1,
        } as unknown as Request,
        offProtocolDraft.response,
        () => undefined
      );
      assert.equal(
        offProtocolDraft.state.statusCode,
        201,
        JSON.stringify(offProtocolDraft.state.body)
      );
      assert.equal(
        offProtocolDraft.state.body.experimentAssignment
          .protocolCompliant,
        false
      );
      const blockedByOffProtocolDraft = makeResponse();
      await prepareDraftsHandler(
        prepareDraftsRequest,
        blockedByOffProtocolDraft.response,
        () => undefined
      );
      assert.equal(blockedByOffProtocolDraft.state.statusCode, 409);
      assert.equal(
        blockedByOffProtocolDraft.state.body.code,
        "PROSPECT_MESSAGE_EXPERIMENT_DRAFT_CONFLICT"
      );
      const jobsAfterBlockedFeed = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM prospect_outreach_jobs
        WHERE workspace_id = 1
          AND payload->'experimentAssignment'->>'experimentId'
            = ${definition.experimentId}
      `;
      assert.equal(jobsAfterBlockedFeed[0].count, 1);
      await sql`
        DELETE FROM prospect_outreach_jobs
        WHERE workspace_id = 1
          AND approval_id =
            ${offProtocolDraft.state.body.approvalId}
      `;

      const preparedDrafts = makeResponse();
      await prepareDraftsHandler(
        prepareDraftsRequest,
        preparedDrafts.response,
        () => undefined
      );
      assert.equal(
        preparedDrafts.state.statusCode,
        201,
        JSON.stringify(preparedDrafts.state.body)
      );
      assert.equal(preparedDrafts.state.body.selectedCount, 20);
      assert.equal(preparedDrafts.state.body.createdCount, 20);
      assert.equal(preparedDrafts.state.body.duplicateCount, 0);
      assert.equal(preparedDrafts.state.body.pendingHumanReview, 20);
      assert.equal(preparedDrafts.state.body.externalAction, "none");
      assert.equal(preparedDrafts.state.body.contactAuthorized, false);
      assert.equal(preparedDrafts.state.body.executionAuthorized, false);
      assert.equal(preparedDrafts.state.body.spendAuthorized, false);

      const replayedDrafts = makeResponse();
      await prepareDraftsHandler(
        prepareDraftsRequest,
        replayedDrafts.response,
        () => undefined
      );
      assert.equal(
        replayedDrafts.state.statusCode,
        200,
        JSON.stringify(replayedDrafts.state.body)
      );
      assert.equal(replayedDrafts.state.body.outcome, "duplicate");
      assert.equal(replayedDrafts.state.body.createdCount, 0);
      assert.equal(replayedDrafts.state.body.duplicateCount, 20);
      assert.deepEqual(
        replayedDrafts.state.body.approvalIds,
        preparedDrafts.state.body.approvalIds
      );
      const draftFeedEvents = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM prospect_message_experiment_events event
        JOIN prospect_message_experiments experiment
          ON experiment.id = event.experiment_row_id
        WHERE event.workspace_id = 1
          AND experiment.experiment_id = ${definition.experimentId}
          AND event.details->>'action'
            = 'frozen_cohort_drafts_prepared'
      `;
      assert.equal(
        draftFeedEvents[0].count,
        1,
        "an exact feeder replay must not append another audit event"
      );

      const enrollmentRows = await sql<{
        lead_id: number;
        approval_id: string;
        payload: any;
      }[]>`
        SELECT lead_id, approval_id, payload
        FROM prospect_outreach_jobs
        WHERE workspace_id = 1
          AND payload->'experimentAssignment'->>'experimentId'
            = ${definition.experimentId}
        ORDER BY lead_id ASC
      `;
      assert.equal(enrollmentRows.length, 20);
      const afterDraftFeed = makeResponse();
      await revenueLoopHandler(
        {
          authMode: "operator",
          workspaceId: 1,
        } as unknown as Request,
        afterDraftFeed.response,
        () => undefined
      );
      assert.equal(
        afterDraftFeed.state.statusCode,
        200,
        JSON.stringify(afterDraftFeed.state.body)
      );
      assert.equal(
        afterDraftFeed.state.body.counts
          .emailExperimentUnenrolled,
        0
      );
      assert.equal(
        afterDraftFeed.state.body.counts.outreachPrepared,
        20
      );
      assert.equal(
        afterDraftFeed.state.body.nextAction.code,
        "REVIEW_RECIPIENT_OUTREACH"
      );
      const enrollmentByLead = new Map<
        number,
        { approvalId: string; payload: any }
      >(
        enrollmentRows.map(row => [
          Number(row.lead_id),
          {
            approvalId: row.approval_id,
            payload:
              typeof row.payload === "string"
                ? JSON.parse(row.payload)
                : row.payload,
          },
        ])
      );

      for (const arm of ["control", "challenger"] as const) {
        for (const selectedLead of selected[arm]) {
          const enrollment = enrollmentByLead.get(selectedLead.id);
          assert.ok(enrollment);
          assert.equal(
            enrollment.payload.experimentAssignment.arm,
            arm
          );
          assert.equal(
            enrollment.payload.experimentAssignment.protocolCompliant,
            true
          );

          const jobRows = await sql<{ id: number }[]>`
            UPDATE prospect_outreach_jobs
            SET state = 'SENT',
                sent_at = '2026-07-30T17:00:00.000Z'
            WHERE workspace_id = 1
              AND approval_id = ${enrollment.approvalId}
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
      const readyToClose = makeResponse();
      await revenueLoopHandler(
        {
          authMode: "operator",
          workspaceId: 1,
        } as unknown as Request,
        readyToClose.response,
        () => undefined
      );
      assert.equal(
        readyToClose.state.statusCode,
        200,
        JSON.stringify(readyToClose.state.body)
      );
      assert.equal(
        readyToClose.state.body.nextAction.code,
        "CLOSE_ACTIVE_EXPERIMENT"
      );

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

      const decisionHandler = routes.get(
        "POST /api/prospecting/learning/candidates/:id/decision"
      );
      assert.ok(decisionHandler);
      const decision = makeResponse();
      await decisionHandler(
        {
          params: { id: String(candidate.state.body.id) },
          body: { decision: "APPROVED" },
          authMode: "operator",
          workspaceId: 1,
        } as unknown as Request,
        decision.response,
        () => undefined
      );
      assert.equal(
        decision.state.statusCode,
        200,
        JSON.stringify(decision.state.body)
      );
      assert.equal(decision.state.body.state, "APPROVED");
      assert.equal(decision.state.body.policyChanged, false);
      assert.equal(decision.state.body.externalAction, "none");

      const candidateListHandler = routes.get(
        "GET /api/prospecting/learning/candidates"
      );
      assert.ok(candidateListHandler);
      const candidateList = makeResponse();
      await candidateListHandler(
        {
          authMode: "operator",
          workspaceId: 1,
        } as unknown as Request,
        candidateList.response,
        () => undefined
      );
      assert.equal(
        candidateList.state.statusCode,
        200,
        JSON.stringify(candidateList.state.body)
      );
      const approvedCandidate =
        candidateList.state.body.candidates.find(
          (row: { id: number }) =>
            row.id === candidate.state.body.id
        );
      assert.ok(approvedCandidate);
      assert.equal(approvedCandidate.state, "APPROVED");
      assert.equal(
        approvedCandidate.recommendation_eligible,
        true
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
        approved_candidate_count: number;
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
          ) AS candidate_count,
          (
            SELECT COUNT(*)::int
            FROM prospect_learning_candidates
            WHERE workspace_id = 1
              AND candidate_key =
                ${`experiment:${definition.experimentId}`}
              AND state = 'APPROVED'
          ) AS approved_candidate_count
      `;
      assert.deepEqual(persisted[0], {
        experiment_count: 1,
        enrollment_count: 20,
        candidate_count: 1,
        approved_candidate_count: 1,
      });

      const raceCampaignRows = await sql<{ id: number }[]>`
        INSERT INTO prospecting_campaigns (
          workspace_id, name, status, target_industry, target_location
        ) VALUES (
          2, 'Synthetic activation race', 'active',
          'plumbing', 'Reno, NV'
        )
        RETURNING id
      `;
      const raceCampaignId = raceCampaignRows[0].id;
      for (let sequence = 1; sequence <= 20; sequence += 1) {
        await sql`
          INSERT INTO prospect_leads (
            campaign_id, business_name, email, email_verification,
            phone, phone_contact_mode, industry, source, external_id,
            research_evidence, review_state
          ) VALUES (
            ${raceCampaignId},
            ${`Synthetic Race Business ${sequence}`},
            ${`race-owner-${sequence}@example.invalid`},
            'verified_owner_email',
            ${`+1202555${String(2000 + sequence).slice(-4)}`},
            'operator_review_only', 'plumbing', 'manual',
            ${`synthetic-race-${sequence}`},
            ${sql.json(evidence)}, 'qualified'
          )
        `;
      }

      async function prepareRaceExperiment(
        channel: "email" | "call"
      ) {
        const response = makeResponse();
        await prepareHandler(
          {
            body: {
              campaignId: raceCampaignId,
              channel,
              controlVariantKey:
                channel === "email"
                  ? "owner-language-v1"
                  : "manual-owner-call-v1",
              challengerVariantKey:
                channel === "email"
                  ? "owner-language-v2"
                  : "manual-owner-call-v2",
              cohortSize: 20,
            },
            authMode: "operator",
            workspaceId: 2,
          } as unknown as Request,
          response.response,
          () => undefined
        );
        assert.equal(
          response.state.statusCode,
          201,
          JSON.stringify(response.state.body)
        );
        return {
          definition:
            response.state.body
              .definition as ProspectMessageExperimentDefinition,
          definitionHash: String(
            response.state.body.definitionHash
          ),
        };
      }

      const raceEmail = await prepareRaceExperiment("email");
      const raceCall = await prepareRaceExperiment("call");
      const raceInboxPlacement = passingInboxPlacementFixture({
        workspaceId: 2,
        campaignId: raceCampaignId,
        controlVariantKey:
          raceEmail.definition.controlVariantKey,
        challengerVariantKey:
          raceEmail.definition.challengerVariantKey,
        testId: "55555555-5555-4555-8555-555555555555",
      });
      await sql`
        INSERT INTO prospect_inbox_placement_tests (
          test_id, workspace_id, target_campaign_id, state,
          control_variant_key, challenger_variant_key,
          definition, definition_hash, receipt, receipt_hash,
          prepared_by, finalized_by, finalized_at, valid_until,
          expires_at
        ) VALUES (
          ${raceInboxPlacement.testId}, 2, ${raceCampaignId},
          'PASSED', ${raceEmail.definition.controlVariantKey},
          ${raceEmail.definition.challengerVariantKey},
          ${sql.json(raceInboxPlacement.definition)},
          ${raceInboxPlacement.definitionHash},
          ${sql.json(raceInboxPlacement.receipt)},
          ${raceInboxPlacement.receiptHash},
          'synthetic_test', 'synthetic_test',
          ${raceInboxPlacement.receipt.finalizedAt},
          ${raceInboxPlacement.receipt.validUntil},
          ${raceInboxPlacement.definition.expiresAt}
        )
      `;

      const raceResponses = [makeResponse(), makeResponse()];
      await Promise.all([
        activateHandler(
          {
            params: {
              experimentId:
                raceEmail.definition.experimentId,
            },
            body: {
              definitionHash: raceEmail.definitionHash,
              confirmation:
                "activate-one-reviewed-message-experiment-v1",
              attestations: {
                registeredContentReviewed: true,
                deterministicAssignmentReviewed: true,
                noContactOrSpendAuthorized: true,
              },
            },
            authMode: "operator",
            workspaceId: 2,
          } as unknown as Request,
          raceResponses[0].response,
          () => undefined
        ),
        activateHandler(
          {
            params: {
              experimentId:
                raceCall.definition.experimentId,
            },
            body: {
              definitionHash: raceCall.definitionHash,
              confirmation:
                "activate-one-reviewed-message-experiment-v1",
              attestations: {
                registeredContentReviewed: true,
                deterministicAssignmentReviewed: true,
                noContactOrSpendAuthorized: true,
              },
            },
            authMode: "operator",
            workspaceId: 2,
          } as unknown as Request,
          raceResponses[1].response,
          () => undefined
        ),
      ]);
      assert.deepEqual(
        raceResponses
          .map(response => response.state.statusCode)
          .sort((left, right) => left - right),
        [200, 409]
      );
      assert.ok(
        raceResponses.some(
          response =>
            response.state.body.code ===
            "PROSPECT_MESSAGE_EXPERIMENT_COHORT_RESERVATION_CONFLICT"
        )
      );
      const raceActiveRows = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM prospect_message_experiments
        WHERE workspace_id = 2
          AND campaign_id = ${raceCampaignId}
          AND state = 'ACTIVE'
      `;
      assert.equal(raceActiveRows[0].count, 1);
      assert.equal(networkAttempts, 0);
    } finally {
      globalThis.fetch = originalFetch;
      await sql.end({ timeout: 5 });
    }
  }
);
