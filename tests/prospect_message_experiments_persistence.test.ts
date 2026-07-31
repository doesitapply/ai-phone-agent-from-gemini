import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Request, Response } from "express";
import postgres from "postgres";
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
import {
  buildProspectPositiveOutcomeReviewPayload,
  hashProspectPositiveOutcomeReviewPayload,
} from "../src/prospect-positive-outcome-review.ts";
import { acquireProspectAcquisitionWorkspaceLock } from "../src/prospect-positive-outcome-pause.ts";

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

async function invokeRoute(
  handlers: CapturedHandler[],
  req: Request,
  res: Response
): Promise<void> {
  let index = 0;
  const next = (): unknown => {
    const handler = handlers[index];
    index += 1;
    return handler
      ? handler(req, res, next as () => void)
      : undefined;
  };
  await next();
}

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
    const routeChains = new Map<string, CapturedHandler[]>();
    const app: any = {};
    for (const method of ["get", "post", "patch"]) {
      app[method] = (
        path: string,
        ...handlers: CapturedHandler[]
      ) => {
        const key = `${method.toUpperCase()} ${path}`;
        routeChains.set(key, handlers);
        routes.set(key, handlers.at(-1)!);
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

      const revenueLoopHandler = routes.get(
        "GET /api/prospecting/revenue-loop"
      );
      assert.ok(revenueLoopHandler);
      const activationReady = makeResponse();
      await revenueLoopHandler(
        {
          authMode: "operator",
          workspaceId: 1,
        } as unknown as Request,
        activationReady.response,
        () => undefined
      );
      assert.equal(
        activationReady.state.statusCode,
        200,
        JSON.stringify(activationReady.state.body)
      );
      assert.equal(
        activationReady.state.body.counts
          .emailExperimentsPreparedWithMatchingInboxTest,
        1
      );
      assert.equal(
        activationReady.state.body.nextAction.code,
        "ACTIVATE_EMAIL_EXPERIMENT"
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
        afterDraftFeed.state.body.counts
          .emailExperimentsReadyToClose,
        0
      );
      assert.equal(
        afterDraftFeed.state.body.nextAction.code,
        "REVIEW_RECIPIENT_OUTREACH"
      );
      assert.equal(
        afterDraftFeed.state.body.nextAction.focus.campaignId,
        campaignId
      );
      const focusedEnrollment = enrollmentRows.find(
        row =>
          Number(row.lead_id) ===
          afterDraftFeed.state.body.nextAction.focus.leadId
      );
      assert.equal(
        afterDraftFeed.state.body.nextAction.focus.approvalId,
        focusedEnrollment?.approval_id
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
      const outcomeRoute = routeChains.get(
        "POST /api/prospecting/leads/:id/outcomes"
      );
      assert.ok(outcomeRoute);
      let positiveOutcomeCount = 0;

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
          const recordedOutcome = makeResponse();
          await invokeRoute(
            outcomeRoute,
            {
              params: { id: String(selectedLead.id) },
              body: {
                externalEventId:
                  `synthetic-outcome-${selectedLead.id}`,
                outcome: isPositive ? "replied" : "delivered",
                occurredAt: "2026-07-30T18:00:00.000Z",
                outreachApprovalId: enrollment.approvalId,
                notes: "Synthetic experiment persistence proof.",
              },
              authMode: "operator",
              workspaceId: 1,
              headers: {},
            } as unknown as Request,
            recordedOutcome.response
          );
          assert.equal(
            recordedOutcome.state.statusCode,
            201,
            JSON.stringify(recordedOutcome.state.body)
          );
          assert.equal(recordedOutcome.state.body.outcome, "recorded");
          assert.equal(
            recordedOutcome.state.body.positiveReviewState,
            isPositive ? "PENDING" : "not_applicable"
          );
          if (isPositive) positiveOutcomeCount += 1;
        }
      }
      assert.equal(positiveOutcomeCount, 8);
      const pausedRevenueLoop = makeResponse();
      await revenueLoopHandler(
        {
          authMode: "operator",
          workspaceId: 1,
        } as unknown as Request,
        pausedRevenueLoop.response,
        () => undefined
      );
      assert.equal(
        pausedRevenueLoop.state.statusCode,
        200,
        JSON.stringify(pausedRevenueLoop.state.body)
      );
      assert.equal(
        pausedRevenueLoop.state.body.counts
          .unreviewedPositiveOutcomeJobs,
        8
      );
      assert.equal(
        pausedRevenueLoop.state.body.nextAction.code,
        "REVIEW_POSITIVE_OUTCOME"
      );

      const closeRoute = routeChains.get(
        "POST /api/prospecting/learning/experiments/:experimentId/close"
      );
      assert.ok(closeRoute);
      const closeRequest = {
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
        headers: {},
      } as unknown as Request;
      const blockedClose = makeResponse();
      await invokeRoute(
        closeRoute,
        closeRequest,
        blockedClose.response
      );
      assert.equal(blockedClose.state.statusCode, 409);
      assert.equal(
        blockedClose.state.body.code,
        "PROSPECT_ACQUISITION_PAUSED_FOR_INTERACTION_REVIEW"
      );
      assert.equal(
        blockedClose.state.body.pendingPositiveOutcomeReviews,
        8
      );
      assert.equal(blockedClose.state.body.externalAction, "none");
      assert.equal(
        blockedClose.state.body.controls.contactAuthorized,
        false
      );
      assert.equal(
        blockedClose.state.body.controls.spendAuthorized,
        false
      );

      const workspaceTwoCandidateRoute = routeChains.get(
        "POST /api/prospecting/learning/candidates"
      );
      assert.ok(workspaceTwoCandidateRoute);
      const workspaceTwoProbe = makeResponse();
      await invokeRoute(
        workspaceTwoCandidateRoute,
        {
          body: {},
          authMode: "operator",
          workspaceId: 2,
          headers: {},
        } as unknown as Request,
        workspaceTwoProbe.response
      );
      assert.equal(
        workspaceTwoProbe.state.statusCode,
        400,
        "workspace 1 reviews must not pause workspace 2"
      );

      const positiveOutcomeListRoute = routeChains.get(
        "GET /api/prospecting/positive-outcomes"
      );
      const acknowledgeRoute = routeChains.get(
        "POST /api/prospecting/positive-outcomes/:reviewId/acknowledge"
      );
      assert.ok(positiveOutcomeListRoute);
      assert.ok(acknowledgeRoute);
      const positiveOutcomeList = makeResponse();
      await invokeRoute(
        positiveOutcomeListRoute,
        {
          query: { state: "pending" },
          authMode: "operator",
          workspaceId: 1,
          headers: {},
        } as unknown as Request,
        positiveOutcomeList.response
      );
      assert.equal(
        positiveOutcomeList.state.statusCode,
        200,
        JSON.stringify(positiveOutcomeList.state.body)
      );
      assert.equal(positiveOutcomeList.state.body.reviews.length, 8);
      for (const review of positiveOutcomeList.state.body.reviews) {
        const acknowledged = makeResponse();
        await invokeRoute(
          acknowledgeRoute,
          {
            params: { reviewId: review.reviewId },
            body: {
              payloadHash: review.payloadHash,
              confirmation:
                "acknowledge-one-positive-outcome-v1",
              resolution: "continue_guarded_loop",
              notes:
                "Synthetic interaction reviewed for persistence proof.",
              attestations: {
                interactionReviewed: true,
                noContactExecutedByAcknowledgment: true,
                followUpRemainsSeparate: true,
              },
            },
            authMode: "operator",
            workspaceId: 1,
            headers: {},
          } as unknown as Request,
          acknowledged.response
        );
        assert.equal(
          acknowledged.state.statusCode,
          201,
          JSON.stringify(acknowledged.state.body)
        );
        assert.equal(
          acknowledged.state.body.reviewState,
          "ACKNOWLEDGED"
        );
        assert.equal(acknowledged.state.body.externalAction, "none");
      }

      const [lockRaceJob] = await sql<
        Array<{
          id: number;
          approval_id: string;
          channel: "email";
          lead_id: number;
          campaign_id: number;
          business_name: string;
        }>
      >`
        SELECT job.id, job.approval_id, job.channel, job.lead_id,
               job.campaign_id, lead.business_name
        FROM prospect_outreach_jobs job
        JOIN prospect_leads lead ON lead.id = job.lead_id
        WHERE job.workspace_id = 1
          AND job.campaign_id = ${campaignId}
          AND job.channel = 'email'
          AND job.state = 'SENT'
        ORDER BY job.id
        LIMIT 1
      `;
      assert.ok(lockRaceJob);
      const lockRaceReviewId = randomUUID();
      const lockRaceExternalEventId =
        `synthetic-lock-race-${lockRaceReviewId}`;
      const lockRaceOccurredAt = "2026-07-30T18:30:00.000Z";
      let releasePositiveTransaction = () => undefined;
      let positiveReviewInserted = () => undefined;
      const releasePositive = new Promise<void>((resolve) => {
        releasePositiveTransaction = resolve;
      });
      const positiveInserted = new Promise<void>((resolve) => {
        positiveReviewInserted = resolve;
      });
      const lockHolderSql = postgres(databaseUrl, {
        ssl: false,
        max: 1,
        idle_timeout: 5,
        connect_timeout: 5,
      });
      let lockRaceOutcomeEventId = 0;
      let holder: Promise<unknown> | undefined;
      try {
        holder = lockHolderSql.begin(async (tx: any) => {
          await acquireProspectAcquisitionWorkspaceLock(tx, 1);
          const outcomeRows = await tx<{ id: number }[]>`
            INSERT INTO prospect_outcome_events (
              workspace_id, campaign_id, lead_id, outreach_job_id,
              source, external_event_id, outcome, occurred_at, notes,
              recorded_by
            ) VALUES (
              1, ${lockRaceJob.campaign_id}, ${lockRaceJob.lead_id},
              ${lockRaceJob.id}, 'operator',
              ${lockRaceExternalEventId}, 'qualified',
              ${lockRaceOccurredAt},
              'Synthetic transaction-order proof.',
              'synthetic_lock_race'
            )
            RETURNING id
          `;
          lockRaceOutcomeEventId = outcomeRows[0].id;
          const payload =
            buildProspectPositiveOutcomeReviewPayload({
              reviewId: lockRaceReviewId,
              workspaceId: 1,
              campaignId: lockRaceJob.campaign_id,
              prospectId: lockRaceJob.lead_id,
              businessName: lockRaceJob.business_name,
              outreachJobId: lockRaceJob.id,
              outreachApprovalId: lockRaceJob.approval_id,
              channel: lockRaceJob.channel,
              outcomeEventId: lockRaceOutcomeEventId,
              outcome: "qualified",
              eventSource: "operator",
              externalEventId: lockRaceExternalEventId,
              occurredAt: lockRaceOccurredAt,
              recordedBy: "synthetic_lock_race",
              notes: "Synthetic transaction-order proof.",
            });
          await tx`
            INSERT INTO prospect_positive_outcome_reviews (
              review_id, workspace_id, campaign_id, lead_id,
              outreach_job_id, outcome_event_id, payload, payload_hash,
              state
            ) VALUES (
              ${lockRaceReviewId}, 1, ${lockRaceJob.campaign_id},
              ${lockRaceJob.lead_id}, ${lockRaceJob.id},
              ${lockRaceOutcomeEventId}, ${tx.json(payload)},
              ${hashProspectPositiveOutcomeReviewPayload(payload)},
              'PENDING'
            )
          `;
          positiveReviewInserted();
          await releasePositive;
        });
        await positiveInserted;

        const raceBlockedClose = makeResponse();
        const raceClosePromise = invokeRoute(
          closeRoute,
          closeRequest,
          raceBlockedClose.response
        );
        let waitingLockCount = 0;
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const [lockState] = await sql<
            Array<{ waiting_count: number }>
          >`
            SELECT COUNT(*)::int AS waiting_count
            FROM pg_locks
            WHERE locktype = 'advisory'
              AND granted = FALSE
          `;
          waitingLockCount = Number(lockState.waiting_count);
          if (waitingLockCount > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.ok(
          waitingLockCount > 0,
          "the guarded mutation must wait on the positive-outcome workspace lock"
        );
        releasePositiveTransaction();
        await holder;
        await raceClosePromise;
        assert.equal(raceBlockedClose.state.statusCode, 409);
        assert.equal(
          raceBlockedClose.state.body.code,
          "PROSPECT_ACQUISITION_PAUSED_FOR_INTERACTION_REVIEW"
        );
        assert.equal(
          raceBlockedClose.state.body.pendingPositiveOutcomeReviews,
          1
        );
      } finally {
        releasePositiveTransaction();
        await holder?.catch(() => undefined);
        await lockHolderSql.end({ timeout: 1 });
      }
      await sql`
        DELETE FROM prospect_positive_outcome_reviews
        WHERE review_id = ${lockRaceReviewId}
      `;
      await sql`
        DELETE FROM prospect_outcome_events
        WHERE id = ${lockRaceOutcomeEventId}
          AND external_event_id = ${lockRaceExternalEventId}
      `;

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
        readyToClose.state.body.counts
          .unreviewedPositiveOutcomeJobs,
        0
      );
      assert.equal(
        readyToClose.state.body.counts
          .emailExperimentsReadyToClose,
        1
      );
      assert.equal(
        readyToClose.state.body.nextAction.code,
        "CLOSE_ACTIVE_EXPERIMENT"
      );

      const closed = makeResponse();
      await invokeRoute(closeRoute, closeRequest, closed.response);
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
      assert.match(
        String(approvedCandidate.proposal_hash),
        /^[a-f0-9]{64}$/
      );

      const policyListHandler = routes.get(
        "GET /api/prospecting/learning/policies"
      );
      const applyPolicyHandler = routes.get(
        "POST /api/prospecting/learning/candidates/:id/apply-policy"
      );
      const rollbackPolicyHandler = routes.get(
        "POST /api/prospecting/learning/policies/:releaseId/rollback"
      );
      assert.ok(policyListHandler);
      assert.ok(applyPolicyHandler);
      assert.ok(rollbackPolicyHandler);

      const applyPolicyRequest = {
        params: { id: String(candidate.state.body.id) },
        body: {
          proposalHash: approvedCandidate.proposal_hash,
          confirmation:
            "apply-one-approved-message-policy-v1",
          attestations: {
            approvedCandidateReviewed: true,
            measuredEvidenceReviewed: true,
            futureExperimentsOnly: true,
            noContactOrSpendAuthorized: true,
          },
        },
        authMode: "operator",
        workspaceId: 1,
      } as unknown as Request;
      const appliedPolicy = makeResponse();
      await applyPolicyHandler(
        applyPolicyRequest,
        appliedPolicy.response,
        () => undefined
      );
      assert.equal(
        appliedPolicy.state.statusCode,
        201,
        JSON.stringify(appliedPolicy.state.body)
      );
      assert.equal(appliedPolicy.state.body.outcome, "applied");
      assert.equal(
        appliedPolicy.state.body.release.action,
        "PROMOTE"
      );
      assert.equal(
        appliedPolicy.state.body.release.championVariantKey,
        "owner-language-v2"
      );
      assert.equal(
        appliedPolicy.state.body.release.controls
          .nextExperimentControlOnly,
        true
      );
      assert.equal(
        appliedPolicy.state.body.existingJobsChanged,
        false
      );
      assert.equal(appliedPolicy.state.body.contactAuthorized, false);
      assert.equal(
        appliedPolicy.state.body.executionAuthorized,
        false
      );
      assert.equal(appliedPolicy.state.body.spendAuthorized, false);
      const promotionReleaseId = String(
        appliedPolicy.state.body.release.releaseId
      );
      const promotionReleaseHash = String(
        appliedPolicy.state.body.releaseHash
      );

      const appliedPolicyReplay = makeResponse();
      await applyPolicyHandler(
        applyPolicyRequest,
        appliedPolicyReplay.response,
        () => undefined
      );
      assert.equal(
        appliedPolicyReplay.state.statusCode,
        200,
        JSON.stringify(appliedPolicyReplay.state.body)
      );
      assert.equal(
        appliedPolicyReplay.state.body.outcome,
        "duplicate"
      );
      assert.equal(
        appliedPolicyReplay.state.body.release.releaseId,
        promotionReleaseId
      );

      const otherWorkspacePoliciesBefore = makeResponse();
      await policyListHandler(
        {
          authMode: "operator",
          workspaceId: 2,
        } as unknown as Request,
        otherWorkspacePoliciesBefore.response,
        () => undefined
      );
      assert.equal(
        otherWorkspacePoliciesBefore.state.statusCode,
        200
      );
      assert.deepEqual(
        otherWorkspacePoliciesBefore.state.body.policies,
        []
      );

      for (let sequence = 31; sequence <= 40; sequence += 1) {
        await sql`
          INSERT INTO prospect_leads (
            campaign_id, business_name, email,
            email_verification, industry, source, external_id,
            research_evidence, review_state
          ) VALUES (
            ${campaignId}, ${`Synthetic Business ${sequence}`},
            ${`owner-${sequence}@example.invalid`},
            'verified_owner_email', 'plumbing', 'manual',
            ${`synthetic-experiment-${sequence}`},
            ${sql.json(evidence)}, 'qualified'
          )
        `;
      }

      const wrongPolicyControl = makeResponse();
      await prepareHandler(
        {
          body: {
            campaignId,
            channel: "email",
            controlVariantKey: "owner-language-v1",
            challengerVariantKey: "micro-after-hours-v1",
            cohortSize: 20,
          },
          authMode: "operator",
          workspaceId: 1,
        } as unknown as Request,
        wrongPolicyControl.response,
        () => undefined
      );
      assert.equal(
        wrongPolicyControl.state.statusCode,
        409,
        JSON.stringify(wrongPolicyControl.state.body)
      );
      assert.equal(
        wrongPolicyControl.state.body.code,
        "PROSPECT_MESSAGE_POLICY_CONTROL_REQUIRED"
      );

      const nextExperiment = makeResponse();
      await prepareHandler(
        {
          body: {
            campaignId,
            channel: "email",
            controlVariantKey: "owner-language-v2",
            challengerVariantKey: "micro-after-hours-v1",
            cohortSize: 20,
          },
          authMode: "operator",
          workspaceId: 1,
        } as unknown as Request,
        nextExperiment.response,
        () => undefined
      );
      assert.equal(
        nextExperiment.state.statusCode,
        201,
        JSON.stringify(nextExperiment.state.body)
      );
      const nextDefinition =
        nextExperiment.state.body
          .definition as ProspectMessageExperimentDefinition & {
          appliedPolicy?: {
            releaseId: string;
            releaseHash: string;
            version: number;
            championVariantKey: string;
          };
        };
      const nextDefinitionHash = String(
        nextExperiment.state.body.definitionHash
      );
      assert.equal(
        nextDefinition.controlVariantKey,
        "owner-language-v2"
      );
      assert.equal(
        nextDefinition.appliedPolicy?.releaseId,
        promotionReleaseId
      );
      assert.equal(
        nextDefinition.appliedPolicy?.releaseHash,
        promotionReleaseHash
      );
      assert.equal(
        nextDefinition.appliedPolicy?.championVariantKey,
        "owner-language-v2"
      );

      const rollbackPolicyRequest = {
        params: { releaseId: promotionReleaseId },
        body: {
          releaseHash: promotionReleaseHash,
          reason: "Restore the prior reviewed control.",
          confirmation:
            "rollback-one-message-policy-v1",
          attestations: {
            currentPolicyReviewed: true,
            rollbackTargetReviewed: true,
            futureExperimentsOnly: true,
            noContactOrSpendAuthorized: true,
          },
        },
        authMode: "operator",
        workspaceId: 1,
      } as unknown as Request;
      const rolledBackPolicy = makeResponse();
      await rollbackPolicyHandler(
        rollbackPolicyRequest,
        rolledBackPolicy.response,
        () => undefined
      );
      assert.equal(
        rolledBackPolicy.state.statusCode,
        201,
        JSON.stringify(rolledBackPolicy.state.body)
      );
      assert.equal(
        rolledBackPolicy.state.body.outcome,
        "rolled_back"
      );
      assert.equal(
        rolledBackPolicy.state.body.release.version,
        2
      );
      assert.equal(
        rolledBackPolicy.state.body.release.championVariantKey,
        "owner-language-v1"
      );
      assert.equal(
        rolledBackPolicy.state.body.existingJobsChanged,
        false
      );
      assert.equal(
        rolledBackPolicy.state.body.contactAuthorized,
        false
      );
      assert.equal(
        rolledBackPolicy.state.body.executionAuthorized,
        false
      );
      assert.equal(
        rolledBackPolicy.state.body.spendAuthorized,
        false
      );
      const rollbackReleaseId = String(
        rolledBackPolicy.state.body.release.releaseId
      );

      const rolledBackPolicyReplay = makeResponse();
      await rollbackPolicyHandler(
        rollbackPolicyRequest,
        rolledBackPolicyReplay.response,
        () => undefined
      );
      assert.equal(
        rolledBackPolicyReplay.state.statusCode,
        200,
        JSON.stringify(rolledBackPolicyReplay.state.body)
      );
      assert.equal(
        rolledBackPolicyReplay.state.body.outcome,
        "duplicate"
      );
      assert.equal(
        rolledBackPolicyReplay.state.body.release.releaseId,
        rollbackReleaseId
      );

      const rollbackDrift = makeResponse();
      await rollbackPolicyHandler(
        {
          ...rollbackPolicyRequest,
          body: {
            ...rollbackPolicyRequest.body,
            reason: "A different rollback reason.",
          },
        } as unknown as Request,
        rollbackDrift.response,
        () => undefined
      );
      assert.equal(
        rollbackDrift.state.statusCode,
        409,
        JSON.stringify(rollbackDrift.state.body)
      );
      assert.equal(
        rollbackDrift.state.body.code,
        "PROSPECT_MESSAGE_POLICY_REPLAY_MISMATCH"
      );

      const currentPolicies = makeResponse();
      await policyListHandler(
        {
          authMode: "operator",
          workspaceId: 1,
        } as unknown as Request,
        currentPolicies.response,
        () => undefined
      );
      assert.equal(
        currentPolicies.state.statusCode,
        200,
        JSON.stringify(currentPolicies.state.body)
      );
      assert.equal(currentPolicies.state.body.policies.length, 1);
      assert.equal(currentPolicies.state.body.releases.length, 2);
      assert.equal(
        currentPolicies.state.body.policies[0].release
          .championVariantKey,
        "owner-language-v1"
      );

      const stalePolicyActivation = makeResponse();
      await activateHandler(
        {
          params: {
            experimentId: nextDefinition.experimentId,
          },
          body: {
            definitionHash: nextDefinitionHash,
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
        stalePolicyActivation.response,
        () => undefined
      );
      assert.equal(
        stalePolicyActivation.state.statusCode,
        409,
        JSON.stringify(stalePolicyActivation.state.body)
      );
      assert.equal(
        stalePolicyActivation.state.body.code,
        "PROSPECT_MESSAGE_EXPERIMENT_POLICY_STALE"
      );

      const cancelHandler = routes.get(
        "POST /api/prospecting/learning/experiments/:experimentId/cancel"
      );
      assert.ok(cancelHandler);
      const cancelledNextExperiment = makeResponse();
      await cancelHandler(
        {
          params: {
            experimentId: nextDefinition.experimentId,
          },
          body: {
            definitionHash: nextDefinitionHash,
            confirmation:
              "cancel-one-prepared-message-experiment-v1",
          },
          authMode: "operator",
          workspaceId: 1,
        } as unknown as Request,
        cancelledNextExperiment.response,
        () => undefined
      );
      assert.equal(
        cancelledNextExperiment.state.statusCode,
        200,
        JSON.stringify(cancelledNextExperiment.state.body)
      );
      assert.equal(
        cancelledNextExperiment.state.body.state,
        "CANCELLED"
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
        policy_release_count: number;
        outreach_job_count: number;
        positive_review_count: number;
        acknowledged_review_count: number;
        positive_review_event_count: number;
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
          ) AS approved_candidate_count,
          (
            SELECT COUNT(*)::int
            FROM prospect_message_policy_releases
            WHERE workspace_id = 1
              AND campaign_id = ${campaignId}
              AND channel = 'email'
          ) AS policy_release_count,
          (
            SELECT COUNT(*)::int
            FROM prospect_outreach_jobs
            WHERE workspace_id = 1
              AND campaign_id = ${campaignId}
          ) AS outreach_job_count,
          (
            SELECT COUNT(*)::int
            FROM prospect_positive_outcome_reviews
            WHERE workspace_id = 1
              AND campaign_id = ${campaignId}
          ) AS positive_review_count,
          (
            SELECT COUNT(*)::int
            FROM prospect_positive_outcome_reviews
            WHERE workspace_id = 1
              AND campaign_id = ${campaignId}
              AND state = 'ACKNOWLEDGED'
          ) AS acknowledged_review_count,
          (
            SELECT COUNT(*)::int
            FROM prospect_positive_outcome_review_events event
            JOIN prospect_positive_outcome_reviews review
              ON review.id = event.review_row_id
            WHERE event.workspace_id = 1
              AND review.campaign_id = ${campaignId}
          ) AS positive_review_event_count
      `;
      assert.deepEqual(persisted[0], {
        experiment_count: 1,
        enrollment_count: 20,
        candidate_count: 1,
        approved_candidate_count: 1,
        policy_release_count: 2,
        outreach_job_count: 20,
        positive_review_count: 8,
        acknowledged_review_count: 8,
        positive_review_event_count: 16,
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
