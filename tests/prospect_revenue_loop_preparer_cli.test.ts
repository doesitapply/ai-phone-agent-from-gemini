import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildProspectRevenueLoopStatus,
  type ProspectRevenueLoopConnections,
  type ProspectRevenueLoopCounts,
} from "../src/prospect-revenue-loop.ts";
import {
  PROSPECT_REVENUE_LOOP_PREPARER_CONFIRMATION,
  PROSPECT_REVENUE_LOOP_PREPARER_CONTRACT_VERSION,
  buildProspectRevenueLoopPreparerControls,
} from "../src/prospect-revenue-loop-preparer.ts";

function counts(
  update: Partial<ProspectRevenueLoopCounts> = {}
): ProspectRevenueLoopCounts {
  return {
    campaigns: 0,
    discoveryPrepared: 0,
    discoveryApproved: 0,
    discoveryInFlight: 0,
    discoveryReadyForImport: 0,
    discoveryFailed: 0,
    sourcePrepared: 0,
    sourceApproved: 0,
    sourceInFlight: 0,
    pendingReviewLeads: 0,
    qualifiedLeads: 0,
    qualifiedEmailLeadsWithoutOutreach: 0,
    qualifiedCallLeadsWithoutOutreach: 0,
    qcRevisionsRequired: 0,
    outreachPrepared: 0,
    outreachApprovedEmail: 0,
    outreachApprovedCall: 0,
    outreachSending: 0,
    outreachSentWithoutOutcome: 0,
    outreachSentEmailWithoutOutcome: 0,
    outreachSentCallWithoutOutcome: 0,
    outcomeEvents: 0,
    positiveOutcomeJobs: 0,
    unreviewedPositiveOutcomeJobs: 0,
    velvetCallbacksPrepared: 0,
    velvetCallbacksSending: 0,
    passingInboxTests: 0,
    inboxPlacementOpenTests: 0,
    inboxSeedPrepared: 0,
    inboxSeedApproved: 0,
    inboxSeedSending: 0,
    inboxSeedSentAwaitingInspection: 0,
    inboxSeedInspected: 0,
    inboxPlacementReadyToFinalize: 0,
    inboxPlacementBlocked: 0,
    emailExperimentsPrepared: 0,
    emailExperimentsPreparedWithMatchingInboxTest: 0,
    emailExperimentsActive: 0,
    emailExperimentsReadyToClose: 0,
    emailExperimentUnenrolled: 0,
    callExperimentsPrepared: 0,
    callExperimentsActive: 0,
    callExperimentsReadyToClose: 0,
    callExperimentUnenrolled: 0,
    closedExperiments: 0,
    learningCandidatesPending: 0,
    learningCandidatesApproved: 0,
    learningCandidatesApprovedUnapplied: 0,
    ...update,
  };
}

function connections(): ProspectRevenueLoopConnections {
  const ready = {
    configured: true,
    enabled: true,
    availableForWorkspace: true,
    missing: [],
  };
  return {
    velvetDiscovery: { ...ready },
    velvetSource: { ...ready },
    advisoryQc: { ...ready },
    emailProvider: { ...ready },
    emailWebhook: { ...ready },
    emailReceiving: { ...ready },
    inboxPlacement: { ...ready },
    velvetOutcome: { ...ready },
  };
}

function run(input: {
  statusFile: string;
  receiptFile?: string;
  prepare?: boolean;
  confirmation?: string;
  preparerWorkspaceId?: string;
}) {
  const args = [
    "--import",
    "tsx",
    "scripts/run-prospect-revenue-loop-preparer.ts",
    "--status-file",
    input.statusFile,
  ];
  if (input.receiptFile) args.push("--receipt-file", input.receiptFile);
  if (input.prepare) args.push("--prepare");
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PROSPECT_REVENUE_LOOP_BASE_URL:
        "https://must-not-be-contacted.example.invalid",
      PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY:
        `observer-${"o".repeat(32)}`,
      PROSPECT_REVENUE_LOOP_OBSERVER_WORKSPACE_ID: "7",
      PROSPECT_REVENUE_LOOP_PREPARER_API_KEY:
        `preparer-${"p".repeat(32)}`,
      PROSPECT_REVENUE_LOOP_PREPARER_WORKSPACE_ID:
        input.preparerWorkspaceId || "7",
      ...(input.confirmation
        ? {
            CONFIRM_SMIRK_PROSPECT_REVENUE_LOOP_PREPARER:
              input.confirmation,
          }
        : {}),
    },
  });
}

test("preparer CLI is dry-run-first, exact-action-only, and interaction-stopping", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "smirk-revenue-loop-preparer-")
  );
  const readyPath = path.join(root, "ready.json");
  const stoppedPath = path.join(root, "stopped.json");
  const receiptPath = path.join(root, "receipt.json");
  try {
    await writeFile(
      readyPath,
      JSON.stringify(
        buildProspectRevenueLoopStatus({
          counts: counts(),
          connections: connections(),
        })
      )
    );
    await writeFile(
      stoppedPath,
      JSON.stringify(
        buildProspectRevenueLoopStatus({
          counts: counts({
            outcomeEvents: 1,
            positiveOutcomeJobs: 1,
            unreviewedPositiveOutcomeJobs: 1,
          }),
          connections: connections(),
        })
      )
    );
    await writeFile(
      receiptPath,
      JSON.stringify({
        ok: true,
        contractVersion:
          PROSPECT_REVENUE_LOOP_PREPARER_CONTRACT_VERSION,
        outcome: "PREPARED",
        id: 51,
        requestId:
          "smirk-auto-discovery-20260802-aaaaaaaaaaaaaaaaaaaaaaaa",
        state: "PREPARED",
        payloadHash: "b".repeat(64),
        criteriaHash: "c".repeat(64),
        expiresAt: "2026-08-03T03:00:00.000Z",
        controls: buildProspectRevenueLoopPreparerControls(),
        externalAction: "none",
      })
    );

    const dryRun = run({ statusFile: readyPath });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryBody = JSON.parse(dryRun.stdout);
    assert.equal(dryBody.mode, "read-only-dry-run");
    assert.equal(dryBody.decision, "READY_TO_PREPARE");
    assert.equal(dryBody.durableWrite, false);
    assert.equal(dryBody.externalAction, "none");

    const unconfirmed = run({
      statusFile: readyPath,
      receiptFile: receiptPath,
      prepare: true,
    });
    assert.equal(unconfirmed.status, 1);
    assert.match(
      unconfirmed.stderr,
      /CONFIRM_SMIRK_PROSPECT_REVENUE_LOOP_PREPARER/
    );

    const prepared = run({
      statusFile: readyPath,
      receiptFile: receiptPath,
      prepare: true,
      confirmation: PROSPECT_REVENUE_LOOP_PREPARER_CONFIRMATION,
    });
    assert.equal(prepared.status, 0, prepared.stderr);
    const preparedBody = JSON.parse(prepared.stdout);
    assert.equal(preparedBody.decision, "PREPARED");
    assert.equal(preparedBody.durableWrite, true);
    assert.equal(preparedBody.contactAuthorized, false);
    assert.equal(preparedBody.spendAuthorized, false);
    assert.equal(preparedBody.providerRequestAuthorized, false);
    assert.equal(preparedBody.emailSent, false);
    assert.equal(preparedBody.smsSent, false);
    assert.equal(preparedBody.callPlaced, false);

    const stopped = run({
      statusFile: stoppedPath,
      prepare: true,
      confirmation: PROSPECT_REVENUE_LOOP_PREPARER_CONFIRMATION,
    });
    assert.equal(stopped.status, 0, stopped.stderr);
    const stoppedBody = JSON.parse(stopped.stdout);
    assert.equal(stoppedBody.decision, "NO_ACTION");
    assert.equal(stoppedBody.durableWrite, false);
    assert.equal(stoppedBody.externalAction, "none");

    const workspaceDrift = run({
      statusFile: readyPath,
      preparerWorkspaceId: "8",
    });
    assert.equal(workspaceDrift.status, 1);
    assert.match(workspaceDrift.stderr, /same workspace/);

    const source = await readFile(
      "scripts/run-prospect-revenue-loop-preparer.ts",
      "utf8"
    );
    assert.match(source, /method: "GET"/);
    assert.match(source, /method: "POST"/);
    assert.match(source, /PREPARE_VELVET_DISCOVERY/);
    assert.doesNotMatch(source, /sendApprovedProspectEmail|calls\.create|sendSms/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
