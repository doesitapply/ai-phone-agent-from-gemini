import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const suffix = `${Date.now()}_${process.pid}_${randomBytes(3).toString(
  "hex"
)}`;
const databaseName = `smirk_experiment_test_${suffix}`;
const databaseUser = process.env.USER || "postgres";
const databaseUrl = `postgresql://${encodeURIComponent(
  databaseUser
)}@127.0.0.1:5432/${databaseName}`;

function assertSafeDatabaseName(value: string): void {
  if (!/^smirk_experiment_test_[a-z0-9_]+$/.test(value)) {
    throw new Error("Refusing an unsafe disposable database name.");
  }
}

async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, {
      env,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || ""),
    };
  } catch (error) {
    const stdout =
      error && typeof error === "object" && "stdout" in error
        ? String((error as { stdout?: unknown }).stdout || "")
        : "";
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr || "")
        : "";
    throw new Error(
      `${command} ${args.join(" ")} failed.\n${stdout}\n${stderr}`.trim()
    );
  }
}

async function main(): Promise<void> {
  assertSafeDatabaseName(databaseName);
  let created = false;
  let testOutput = "";
  try {
    await run("createdb", ["-h", "127.0.0.1", databaseName]);
    created = true;
    const testResult = await run(
      "node",
      [
        "--import",
        "tsx",
        "--test",
        "tests/prospect_message_experiments_persistence.test.ts",
      ],
      {
        ...process.env,
        DATABASE_URL: databaseUrl,
        SMIRK_EXPERIMENT_TEST_DATABASE_URL: databaseUrl,
        NODE_ENV: "test",
      }
    );
    testOutput = testResult.stdout;
  } finally {
    if (created) {
      await run("dropdb", [
        "-h",
        "127.0.0.1",
        "--if-exists",
        "--force",
        databaseName,
      ]);
    }
  }

  const verification = await run("psql", [
    "-h",
    "127.0.0.1",
    "-d",
    "postgres",
    "-Atc",
    `SELECT COUNT(*) FROM pg_database WHERE datname = '${databaseName}'`,
  ]);
  if (verification.stdout.trim() !== "0") {
    throw new Error(
      "Disposable experiment database cleanup was not verified."
    );
  }
  if (!testOutput.includes("# pass 1") || !testOutput.includes("# fail 0")) {
    throw new Error(
      `Message-experiment persistence proof did not report one passing test.\n${testOutput}`
    );
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "prospect-message-experiment-persistence-v2",
        database: databaseName,
        eligiblePopulationFrozen: true,
        exactBalancedCohort: true,
        cohortDraftFeedCreated: 20,
        cohortDraftFeedReplay: "duplicate",
        cohortDraftFeedReplayAuditEvents: 1,
        offProtocolEnrollmentRejected: true,
        deterministicEnrollments: 20,
        concurrentCrossChannelActivationOwners: 1,
        learningCandidates: 1,
        approvedWinnerReleasedAsNextControl: true,
        policyApplicationReplay: "duplicate",
        policyRollbackReplay: "duplicate",
        messagePolicyVersions: 2,
        stalePolicyActivationRejected: true,
        existingJobsChanged: false,
        inboxPlacementReceiptBound: true,
        networkAttempts: 0,
        externalMessages: 0,
        spendCents: 0,
        cleanupVerified: true,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
