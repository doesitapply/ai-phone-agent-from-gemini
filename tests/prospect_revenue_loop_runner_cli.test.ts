import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  buildProspectRevenueLoopStatus,
  type ProspectRevenueLoopConnections,
  type ProspectRevenueLoopCounts,
} from "../src/prospect-revenue-loop.ts";

function counts(
  update: Partial<ProspectRevenueLoopCounts> = {}
): ProspectRevenueLoopCounts {
  return {
    campaigns: 1,
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
    inboxPlacement: { ...ready },
    velvetOutcome: { ...ready },
  };
}

function run(
  statusFile: string,
  outputDir: string,
  input: {
    noWrite?: boolean;
    confirmation?: string;
  } = {}
) {
  const args = [
    "--import",
    "tsx",
    "scripts/run-prospect-revenue-loop-checkpoint.ts",
    "--status-file",
    statusFile,
    "--output-dir",
    outputDir,
  ];
  if (input.noWrite) args.push("--no-write");
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PROSPECT_REVENUE_LOOP_OBSERVER_WORKSPACE_ID: "7",
      PROSPECT_REVENUE_LOOP_BASE_URL:
        "https://must-not-be-contacted.example.invalid",
      PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY:
        "must-not-be-used-in-status-file-mode",
      ...(input.confirmation
        ? {
            CONFIRM_SMIRK_PROSPECT_REVENUE_LOOP_CHECKPOINT:
              input.confirmation,
          }
        : {}),
    },
  });
}

test("checkpoint CLI is dry-run-first, replay-safe, and stops on interaction", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "smirk-revenue-loop-runner-")
  );
  const outputDir = path.join(root, "ledger");
  const configStatusPath = path.join(root, "config.json");
  const interactionStatusPath = path.join(root, "interaction.json");
  try {
    await writeFile(
      configStatusPath,
      JSON.stringify(
        buildProspectRevenueLoopStatus({
          counts: counts({ sourcePrepared: 1 }),
          connections: connections(),
        })
      )
    );
    await writeFile(
      interactionStatusPath,
      JSON.stringify(
        buildProspectRevenueLoopStatus({
          counts: counts({
            outcomeEvents: 2,
            positiveOutcomeJobs: 1,
            unreviewedPositiveOutcomeJobs: 1,
          }),
          connections: connections(),
        })
      )
    );

    const dryRun = run(configStatusPath, outputDir, {
      noWrite: true,
    });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryBody = JSON.parse(dryRun.stdout);
    assert.equal(dryBody.mode, "read-only-dry-run");
    assert.equal(dryBody.externalAction, "none");
    assert.equal(dryBody.providerRequest, false);

    const unconfirmed = run(configStatusPath, outputDir);
    assert.equal(unconfirmed.status, 1);
    assert.match(
      unconfirmed.stderr,
      /CONFIRM_SMIRK_PROSPECT_REVENUE_LOOP_CHECKPOINT/
    );

    const first = run(configStatusPath, outputDir, {
      confirmation: "write-one-local-checkpoint-v1",
    });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).changed, true);

    const replay = run(configStatusPath, outputDir, {
      confirmation: "write-one-local-checkpoint-v1",
    });
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(JSON.parse(replay.stdout).changed, false);

    const stopped = run(interactionStatusPath, outputDir, {
      confirmation: "write-one-local-checkpoint-v1",
    });
    assert.equal(stopped.status, 0, stopped.stderr);
    const stoppedBody = JSON.parse(stopped.stdout);
    assert.equal(
      stoppedBody.checkpoint.schedulerDecision,
      "STOP_INTERACTION"
    );
    assert.equal(
      stoppedBody.checkpoint.shouldScheduleNextCheck,
      false
    );
    assert.equal(stoppedBody.checkpoint.hardStop, "interaction");
    assert.equal(stoppedBody.emailSent, false);
    assert.equal(stoppedBody.smsSent, false);
    assert.equal(stoppedBody.callPlaced, false);
    assert.equal(stoppedBody.spendCents, 0);

    const history = (
      await readFile(path.join(outputDir, "history.jsonl"), "utf8")
    )
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line));
    assert.equal(history.length, 2);
    assert.equal(history[0].schedulerDecision, "WAIT_HUMAN");
    assert.equal(history[1].schedulerDecision, "STOP_INTERACTION");

    const latest = JSON.parse(
      await readFile(path.join(outputDir, "latest.json"), "utf8")
    );
    assert.equal(latest.schedulerDecision, "STOP_INTERACTION");
    assert.equal(
      (await stat(path.join(outputDir, "latest.json"))).mode & 0o777,
      0o600
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
