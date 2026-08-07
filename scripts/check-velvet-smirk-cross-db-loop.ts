import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import express, {
  type NextFunction,
  type Request,
  type Response as ExpressResponse,
} from "express";
import { Webhook } from "standardwebhooks";
import {
  readVelvetRemoteConnectionProofConfig,
  verifyVelvetConnectionProofResponses,
  type VelvetRemoteConnectionProofReport,
} from "../src/velvet-connection-proof.js";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const smirkRoot = path.resolve(scriptDirectory, "..");
const velvetRoot = path.resolve(
  process.env.VELVET_REPO_PATH ||
    path.join(smirkRoot, "..", "velvet-alchemy-landing")
);
const suffix = `${Date.now()}_${process.pid}_${randomBytes(3).toString("hex")}`;
const runId = `cross-db-${suffix.replace(/_/g, "-")}`;
const postgresDatabase = `smirk_cross_db_test_${suffix}`;
const mysqlDatabase = `velvet_cross_db_test_${suffix}`;
const postgresUser = process.env.USER || "postgres";
const postgresUrl = `postgresql://${encodeURIComponent(
  postgresUser
)}@127.0.0.1:5432/${postgresDatabase}`;
const mysqlUrl = `mysql://root@127.0.0.1:3306/${mysqlDatabase}`;
const sourceApiKey = `velvet-source-${randomBytes(32).toString("hex")}`;
const outcomeApiKey = `velvet-outcome-${randomBytes(32).toString("hex")}`;
const revenueLoopObserverApiKey =
  `revenue-loop-observer-${randomBytes(32).toString("hex")}`;
const revenueLoopPreparerApiKey =
  `revenue-loop-preparer-${randomBytes(32).toString("hex")}`;
const signingSecret = `velvet-signing-${randomBytes(32).toString("hex")}`;
const qcProviderFixtureKey = `sk-or-${randomBytes(24).toString("hex")}`;
const receivingProviderFixtureKey =
  `re_receiving_${randomBytes(24).toString("hex")}`;
const fixtureControlToken = `fixture-control-${randomBytes(32).toString("hex")}`;
const productionVelvetOrigin = "https://velvetalchemy.manus.space";
const resendOrigin = "https://api.resend.com";
const openRouterOrigin = "https://openrouter.ai";
const syntheticProviderMessageId = `email_${runId}`;
const controlledInboxMailboxes = [
  {
    label: "Synthetic Google One",
    provider: "google_workspace",
    email: `seed-google-1-${suffix}@example.invalid`,
  },
  {
    label: "Synthetic Google Two",
    provider: "google_workspace",
    email: `seed-google-2-${suffix}@example.invalid`,
  },
  {
    label: "Synthetic Microsoft One",
    provider: "microsoft_365",
    email: `seed-microsoft-1-${suffix}@example.invalid`,
  },
  {
    label: "Synthetic Microsoft Two",
    provider: "microsoft_365",
    email: `seed-microsoft-2-${suffix}@example.invalid`,
  },
  {
    label: "Synthetic Yahoo One",
    provider: "yahoo_aol",
    email: `seed-yahoo-1-${suffix}@example.invalid`,
  },
] as const;
const syntheticEmailCompliance = {
  senderIdentity: "SMIRK",
  advertisementDisclosure: "This is a commercial message from SMIRK.",
  physicalPostalAddress: "100 Example Avenue, Reno, NV 89501",
  optOutInstructions: "Reply stop to opt out of future emails.",
} as const;
const emailWebhookSecret = `whsec_${Buffer.from(
  `smirk-${runId}-webhook-secret`
).toString("base64")}`;

type JsonRecord = Record<string, any>;

type VelvetReady = {
  mode: "smirk-cross-db-v1";
  port: number;
  userId: number;
  leadId: number;
  externalProspectId: string;
  discoveryRequestId: string;
  providerRequests: number;
  experimentId: string;
  experimentDefinitionHash: string;
};

type FixtureProcess = {
  child: ChildProcessWithoutNullStreams;
  ready: VelvetReady;
  stderr: string[];
};

type VelvetConnectionReadiness = {
  contractVersion: "velvet-smirk.connection-readiness.v1";
  ok: boolean;
  readinessScope: "velvet-runtime-preflight";
  endToEndReady: false;
  connections: {
    smirkWorkspaceBoundary: {
      workspaceId: number | null;
    };
    optionalResearchPush: {
      available: boolean;
      requiredForCanonicalPullLoop: false;
    };
  };
  databaseProof: {
    checked: boolean;
    available: boolean;
    schemaReady: boolean;
    activeDedicatedResearchKeyCount: number;
    activeDedicatedOutcomeKeyCount: number;
    keysDistinct: boolean;
    sameAdminOwner: boolean;
  };
  blockers: string[];
  guardrails: {
    coldSmsAllowed: false;
    velvetOutreachExecutionAllowed: false;
    automatedProspectDialingAllowed: false;
    contactAuthorized: false;
    spendAuthorized: false;
    providerRequestPerformed: false;
    databaseMutationPerformed: false;
  };
  externalAction: "none";
};

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function safeDatabaseName(value: string): string {
  invariant(/^[a-z0-9_]+$/.test(value), "Unsafe disposable database name.");
  return value;
}

async function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<void> {
  try {
    await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 800)
        : "";
    throw new Error(
      `${command} ${args.join(" ")} failed${stderr ? `: ${stderr}` : "."}`
    );
  }
}

async function capture(command: string, args: string[]): Promise<string> {
  const result = await execFileAsync(command, args, {
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  return String(result.stdout || "").trim();
}

async function createDisposableDatabases(): Promise<void> {
  safeDatabaseName(postgresDatabase);
  safeDatabaseName(mysqlDatabase);
  await run("createdb", ["-h", "127.0.0.1", postgresDatabase]);
  await run("mysql", [
    "--protocol=tcp",
    "-h",
    "127.0.0.1",
    "-e",
    `CREATE DATABASE \`${mysqlDatabase}\``,
  ]);
  await run(
    "pnpm",
    ["exec", "drizzle-kit", "migrate"],
    {
      cwd: velvetRoot,
      env: {
        ...process.env,
        DATABASE_URL: mysqlUrl,
      },
    }
  );
}

async function dropDisposableDatabases(): Promise<void> {
  let firstError: unknown = null;
  try {
    await run("dropdb", [
      "-h",
      "127.0.0.1",
      "--if-exists",
      "--force",
      safeDatabaseName(postgresDatabase),
    ]);
  } catch (error) {
    firstError = error;
  }
  try {
    await run("mysql", [
      "--protocol=tcp",
      "-h",
      "127.0.0.1",
      "-e",
      `DROP DATABASE IF EXISTS \`${safeDatabaseName(mysqlDatabase)}\``,
    ]);
  } catch (error) {
    firstError ||= error;
  }
  if (firstError) throw firstError;
}

async function verifyDisposableDatabasesDropped(): Promise<void> {
  const postgresCount = await capture("psql", [
    "-h",
    "127.0.0.1",
    "-d",
    "postgres",
    "-Atc",
    `SELECT COUNT(*) FROM pg_database WHERE datname = '${safeDatabaseName(
      postgresDatabase
    )}'`,
  ]);
  const mysqlCount = await capture("mysql", [
    "--protocol=tcp",
    "-h",
    "127.0.0.1",
    "-N",
    "-e",
    `SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = '${safeDatabaseName(
      mysqlDatabase
    )}'`,
  ]);
  invariant(
    postgresCount === "0" && mysqlCount === "0",
    "Disposable database cleanup could not be verified."
  );
}

async function startVelvetFixture(): Promise<FixtureProcess> {
  const child = spawn(
    "pnpm",
    [
      "exec",
      "tsx",
      "server/testSupport/smirkCrossSystemFixtureServer.ts",
    ],
    {
      cwd: velvetRoot,
      env: {
        ...process.env,
        DATABASE_URL: mysqlUrl,
        NODE_ENV: "test",
        VELVET_CROSS_DB_FIXTURE: "1",
        VELVET_CROSS_DB_RUN_ID: runId,
        VELVET_CROSS_DB_SOURCE_API_KEY: sourceApiKey,
        VELVET_CROSS_DB_OUTCOME_API_KEY: outcomeApiKey,
        VELVET_CROSS_DB_CONTROL_TOKEN: fixtureControlToken,
        SMIRK_RESEARCH_WORKSPACE_ID: "1",
        SMIRK_OUTCOME_SIGNING_SECRET: signingSecret,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => {
    stderr.push(String(chunk).slice(0, 2_000));
    if (stderr.length > 20) stderr.shift();
  });

  const ready = await new Promise<VelvetReady>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Velvet fixture startup timed out. ${stderr.join(" ").slice(0, 1_000)}`
        )
      );
    }, 30_000);
    const settle = (callback: () => void) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      callback();
    };
    const onExit = (code: number | null) => {
      settle(() =>
        reject(
          new Error(
            `Velvet fixture exited before readiness (${code}). ${stderr
              .join(" ")
              .slice(0, 1_000)}`
          )
        )
      );
    };
    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("VELVET_CROSS_DB_READY ")) continue;
        try {
          const parsed = JSON.parse(
            line.slice("VELVET_CROSS_DB_READY ".length)
          ) as VelvetReady;
          invariant(
            parsed.mode === "smirk-cross-db-v1" &&
              Number.isSafeInteger(parsed.port) &&
              parsed.port > 0 &&
              Number.isSafeInteger(parsed.userId) &&
              parsed.userId > 0 &&
              Number.isSafeInteger(parsed.leadId) &&
              parsed.leadId > 0 &&
              parsed.providerRequests === 3 &&
              /^[0-9a-f-]{36}$/.test(parsed.experimentId) &&
              /^[a-f0-9]{64}$/.test(parsed.experimentDefinitionHash),
            "Velvet fixture readiness payload is invalid."
          );
          settle(() => resolve(parsed));
        } catch (error) {
          settle(() =>
            reject(
              error instanceof Error
                ? error
                : new Error("Velvet fixture readiness parsing failed.")
            )
          );
        }
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
  return { child, ready, stderr };
}

async function stopVelvetFixture(
  fixture: FixtureProcess | null
): Promise<void> {
  if (!fixture || fixture.child.exitCode !== null) return;
  fixture.child.kill("SIGTERM");
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      fixture.child.kill("SIGKILL");
      resolve();
    }, 5_000);
    fixture.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

async function listen(app: express.Express): Promise<{
  server: Server;
  baseUrl: string;
}> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  invariant(
    address && typeof address !== "string",
    "SMIRK fixture server did not bind."
  );
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function readJsonResponse(
  response: globalThis.Response
): Promise<JsonRecord> {
  const raw = await response.text();
  try {
    return raw ? (JSON.parse(raw) as JsonRecord) : {};
  } catch {
    throw new Error(
      `Expected JSON from ${response.url}; received ${raw.slice(0, 200)}`
    );
  }
}

async function httpJson(input: {
  baseUrl: string;
  pathname: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  expectedStatus: number | number[];
}): Promise<JsonRecord> {
  const url = new URL(input.pathname, input.baseUrl);
  invariant(
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname),
    "The proof harness may only call loopback HTTP."
  );
  const response = await fetch(url, {
    method: input.method || "GET",
    headers: {
      accept: "application/json",
      ...(input.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(input.headers || {}),
    },
    body:
      input.body === undefined ? undefined : JSON.stringify(input.body),
    redirect: "error",
    cache: "no-store",
  });
  const body = await readJsonResponse(response);
  const expected = Array.isArray(input.expectedStatus)
    ? input.expectedStatus
    : [input.expectedStatus];
  invariant(
    expected.includes(response.status),
    `${input.method || "GET"} ${input.pathname} returned ${
      response.status
    }: ${JSON.stringify(body).slice(0, 500)}`
  );
  return body;
}

function signWebhookEvent(
  eventId: string,
  event: Record<string, unknown>
): {
  rawBody: Buffer;
  headers: Record<string, string>;
} {
  const rawBody = Buffer.from(JSON.stringify(event));
  const timestamp = new Date();
  return {
    rawBody,
    headers: {
      "content-type": "application/json",
      "svix-id": eventId,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1_000)),
      "svix-signature": new Webhook(emailWebhookSecret).sign(
        eventId,
        timestamp,
        rawBody
      ),
    },
  };
}

async function httpRaw(input: {
  baseUrl: string;
  pathname: string;
  body: Buffer;
  headers: Record<string, string>;
  expectedStatus: number | number[];
}): Promise<JsonRecord> {
  const url = new URL(input.pathname, input.baseUrl);
  invariant(
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname),
    "The proof harness may only submit raw webhooks to loopback HTTP."
  );
  const response = await fetch(url, {
    method: "POST",
    headers: input.headers,
    body: input.body,
    redirect: "error",
    cache: "no-store",
  });
  const body = await readJsonResponse(response);
  const expected = Array.isArray(input.expectedStatus)
    ? input.expectedStatus
    : [input.expectedStatus];
  invariant(
    expected.includes(response.status),
    `POST ${input.pathname} returned ${response.status}: ${JSON.stringify(
      body
    ).slice(0, 500)}`
  );
  return body;
}

function providerOutcomeEventId(eventId: string): string {
  return `resend:${createHash("sha256")
    .update(eventId)
    .digest("hex")
    .slice(0, 32)}`;
}

function recipientTimezoneFor(date: Date): string {
  const offsetHours = 12 - date.getUTCHours();
  if (offsetHours === 0) return "Etc/UTC";
  return offsetHours > 0
    ? `Etc/GMT-${offsetHours}`
    : `Etc/GMT+${Math.abs(offsetHours)}`;
}

async function main(): Promise<void> {
  invariant(
    path.basename(velvetRoot) === "velvet-alchemy-landing",
    "VELVET_REPO_PATH must identify the Velvet repository."
  );
  let velvetFixture: FixtureProcess | null = null;
  let smirkServer: Server | null = null;
  let sql: any = null;
  let databasesCreated = false;
  let report: JsonRecord | null = null;
  const network = {
    activeExperimentRequests: 0,
    discoveryPrepareRequests: 0,
    discoveryStatusRequests: 0,
    leadBatchRequests: 0,
    outcomeRequests: 0,
    connectionProofRequests: 0,
    unexpectedRequests: 0,
    emailProviderAdapterRequests: 0,
    emailReceivingAdapterRequests: 0,
    qcProviderAdapterRequests: 0,
    smsRequests: 0,
    callRequests: 0,
  };
  let velvetRemoteConnectionProof:
    | VelvetRemoteConnectionProofReport
    | null = null;

  try {
    databasesCreated = true;
    await createDisposableDatabases();
    velvetFixture = await startVelvetFixture();
    const velvetFixtureBaseUrl = `http://127.0.0.1:${velvetFixture.ready.port}`;
    const forgeFixtureKey = `forge-${randomBytes(32).toString("hex")}`;
    const hunterFixtureKey = `hunter-${randomBytes(32).toString("hex")}`;
    const velvetPreflightResult = await execFileAsync(
      "pnpm",
      [
        "exec",
        "tsx",
        "server/smirkConnectionReadinessCheck.ts",
      ],
      {
        cwd: velvetRoot,
        env: {
          ...process.env,
          DATABASE_URL: mysqlUrl,
          BUILT_IN_FORGE_API_URL: "https://forge.example.invalid",
          BUILT_IN_FORGE_API_KEY: forgeFixtureKey,
          ENABLE_MAPS_RESEARCH: "true",
          MAPS_COST_CENTS_PER_REQUEST: "1",
          ENABLE_SMIRK_DISCOVERY_WORKER: "true",
          ENABLE_HUNTER_OWNER_ENRICHMENT: "true",
          HUNTER_API_KEY: hunterFixtureKey,
          HUNTER_COST_CENTS_PER_CREDIT: "1",
          SMIRK_RESEARCH_WORKSPACE_ID: "1",
          SMIRK_OUTCOME_SIGNING_SECRET: signingSecret,
        },
        maxBuffer: 1024 * 1024,
      }
    );
    const velvetConnectionReadiness = JSON.parse(
      String(velvetPreflightResult.stdout || "").trim()
    ) as VelvetConnectionReadiness;
    invariant(
      velvetConnectionReadiness.contractVersion ===
        "velvet-smirk.connection-readiness.v1" &&
        velvetConnectionReadiness.ok === true &&
        velvetConnectionReadiness.readinessScope ===
          "velvet-runtime-preflight" &&
        velvetConnectionReadiness.endToEndReady === false &&
        velvetConnectionReadiness.connections
          .smirkWorkspaceBoundary.workspaceId === 1 &&
        velvetConnectionReadiness.connections.optionalResearchPush
          .available === false &&
        velvetConnectionReadiness.connections.optionalResearchPush
          .requiredForCanonicalPullLoop === false &&
        velvetConnectionReadiness.databaseProof.checked === true &&
        velvetConnectionReadiness.databaseProof.available === true &&
        velvetConnectionReadiness.databaseProof.schemaReady === true &&
        velvetConnectionReadiness.databaseProof
          .activeDedicatedResearchKeyCount === 1 &&
        velvetConnectionReadiness.databaseProof
          .activeDedicatedOutcomeKeyCount === 1 &&
        velvetConnectionReadiness.databaseProof.keysDistinct === true &&
        velvetConnectionReadiness.databaseProof.sameAdminOwner === true &&
        velvetConnectionReadiness.blockers.length === 0 &&
        velvetConnectionReadiness.guardrails.coldSmsAllowed === false &&
        velvetConnectionReadiness.guardrails
          .velvetOutreachExecutionAllowed === false &&
        velvetConnectionReadiness.guardrails
          .automatedProspectDialingAllowed === false &&
        velvetConnectionReadiness.guardrails.contactAuthorized === false &&
        velvetConnectionReadiness.guardrails.spendAuthorized === false &&
        velvetConnectionReadiness.guardrails.providerRequestPerformed ===
          false &&
        velvetConnectionReadiness.guardrails.databaseMutationPerformed ===
          false &&
        velvetConnectionReadiness.externalAction === "none",
      `Velvet connection readiness did not prove the expected redacted runtime prerequisites: ${JSON.stringify(
        velvetConnectionReadiness
      ).slice(0, 2_000)}`
    );
    const serializedVelvetReadiness = JSON.stringify(
      velvetConnectionReadiness
    );
    invariant(
      !serializedVelvetReadiness.includes(mysqlUrl) &&
        !serializedVelvetReadiness.includes(forgeFixtureKey) &&
        !serializedVelvetReadiness.includes(hunterFixtureKey) &&
        !serializedVelvetReadiness.includes(signingSecret) &&
        !serializedVelvetReadiness.includes(sourceApiKey) &&
        !serializedVelvetReadiness.includes(outcomeApiKey),
      "The Velvet connection readiness report exposed a credential."
    );

    const connectionProofConfig =
      readVelvetRemoteConnectionProofConfig({
        VELVET_LEAD_SOURCE_BASE_URL: productionVelvetOrigin,
        VELVET_LEAD_SOURCE_API_KEY: sourceApiKey,
        VELVET_LEAD_SOURCE_WORKSPACE_ID: "1",
        VELVET_BASE_URL: productionVelvetOrigin,
        VELVET_OUTCOME_API_KEY: outcomeApiKey,
        VELVET_OUTCOME_SIGNING_SECRET: signingSecret,
        VELVET_OUTCOME_WORKSPACE_ID: "1",
      });
    invariant(
      connectionProofConfig.configured,
      "The synthetic remote connection proof config is invalid."
    );
    const connectionProofChallenge = randomBytes(32).toString("hex");
    const usageBeforeProof = await httpJson({
      baseUrl: velvetFixtureBaseUrl,
      pathname: "/__fixture/state",
      headers: { "x-fixture-token": fixtureControlToken },
      expectedStatus: 200,
    });
    const proofPath = `/api/v1/smirk/connection-proof?${new URLSearchParams(
      {
        workspaceId: "1",
        challenge: connectionProofChallenge,
      }
    ).toString()}`;
    const [sourceConnectionProof, outcomeConnectionProof] =
      await Promise.all([
        httpJson({
          baseUrl: velvetFixtureBaseUrl,
          pathname: proofPath,
          headers: {
            authorization: `Bearer ${sourceApiKey}`,
          },
          expectedStatus: 200,
        }),
        httpJson({
          baseUrl: velvetFixtureBaseUrl,
          pathname: proofPath,
          headers: {
            authorization: `Bearer ${outcomeApiKey}`,
          },
          expectedStatus: 200,
        }),
      ]);
    network.connectionProofRequests = 2;
    velvetRemoteConnectionProof =
      verifyVelvetConnectionProofResponses({
        sourceBody: sourceConnectionProof,
        outcomeBody: outcomeConnectionProof,
        config: connectionProofConfig,
        challenge: connectionProofChallenge,
      });
    invariant(
      velvetRemoteConnectionProof.ok &&
        velvetRemoteConnectionProof.requestsPerformed === 2 &&
        velvetRemoteConnectionProof.checks
          .sourceKeyAuthenticated &&
        velvetRemoteConnectionProof.checks
          .outcomeKeyAuthenticated &&
        velvetRemoteConnectionProof.checks
          .exactDedicatedScopes &&
        velvetRemoteConnectionProof.checks.sameAdminOwner &&
        velvetRemoteConnectionProof.checks
          .credentialsDistinct &&
        velvetRemoteConnectionProof.checks
          .signingSecretMatched &&
        velvetRemoteConnectionProof.checks.workspaceAligned &&
        velvetRemoteConnectionProof.checks
          .remoteNoMutationClaimed,
      `The remote Velvet connection proof failed: ${JSON.stringify(
        velvetRemoteConnectionProof
      )}`
    );
    const usageAfterProof = await httpJson({
      baseUrl: velvetFixtureBaseUrl,
      pathname: "/__fixture/state",
      headers: { "x-fixture-token": fixtureControlToken },
      expectedStatus: 200,
    });
    const usageFacts = (value: JsonRecord) =>
      (Array.isArray(value.apiKeys) ? value.apiKeys : [])
        .map((item: JsonRecord) => ({
          id: Number(item.id),
          lastUsedAt: item.lastUsedAt || null,
        }))
        .sort(
          (
            left: { id: number },
            right: { id: number }
          ) => left.id - right.id
        );
    invariant(
      JSON.stringify(usageFacts(usageBeforeProof)) ===
        JSON.stringify(usageFacts(usageAfterProof)),
      "The read-only connection proof changed API-key usage state."
    );

    process.env.DATABASE_URL = postgresUrl;
    process.env.VELVET_DISCOVERY_ENABLED = "true";
    process.env.VELVET_LEAD_SOURCE_ENABLED = "true";
    process.env.VELVET_LEAD_SOURCE_BASE_URL = `${productionVelvetOrigin}/`;
    process.env.VELVET_LEAD_SOURCE_API_KEY = sourceApiKey;
    process.env.VELVET_LEAD_SOURCE_WORKSPACE_ID = "1";
    process.env.VELVET_OUTCOME_DISPATCH_ENABLED = "true";
    process.env.VELVET_BASE_URL = `${productionVelvetOrigin}/`;
    process.env.VELVET_OUTCOME_API_KEY = outcomeApiKey;
    process.env.VELVET_OUTCOME_SIGNING_SECRET = signingSecret;
    process.env.VELVET_OUTCOME_WORKSPACE_ID = "1";
    process.env.PROSPECT_EMAIL_EXECUTION_ENABLED = "true";
    process.env.PROSPECT_EMAIL_EXECUTION_MODE =
      "single-recipient-reviewed-v1";
    process.env.PROSPECT_EMAIL_RESEND_API_KEY =
      "re_synthetic_cross_db_only";
    process.env.PROSPECT_EMAIL_FROM =
      "SMIRK <outreach@smirkcalls.com>";
    process.env.PROSPECT_EMAIL_REPLY_TO = "reply@smirkcalls.com";
    process.env.PROSPECT_EMAIL_WORKSPACE_ID = "1";
    process.env.PROSPECT_EMAIL_DAILY_RECIPIENT_CAP = "6";
    process.env.PROSPECT_EMAIL_DAILY_SPEND_CAP_CENTS = "6";
    process.env.PROSPECT_EMAIL_UNIT_COST_CENTS = "1";
    process.env.PROSPECT_INBOX_SEED_ALLOWLIST =
      controlledInboxMailboxes.map(mailbox => mailbox.email).join(",");
    process.env.PROSPECT_EMAIL_WEBHOOK_ENABLED = "true";
    process.env.PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET =
      emailWebhookSecret;
    process.env.PROSPECT_EMAIL_RECEIVING_ENABLED = "true";
    process.env.PROSPECT_EMAIL_RECEIVING_MODE =
      "operator-reviewed-content-v1";
    process.env.PROSPECT_EMAIL_RESEND_RECEIVING_API_KEY =
      receivingProviderFixtureKey;
    process.env.PROSPECT_EMAIL_RECEIVING_WORKSPACE_ID = "1";
    process.env.PROSPECT_MANUAL_CALL_ENABLED = "true";
    process.env.PROSPECT_MANUAL_CALL_MODE =
      "operator-tel-link-v1";
    process.env.PROSPECT_MANUAL_CALL_WORKSPACE_ID = "1";
    process.env.PROSPECT_MANUAL_CALL_DAILY_APPROVAL_CAP = "1";
    process.env.PROSPECT_QC_MODEL_REVIEW_ENABLED = "true";
    process.env.PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL =
      "true";
    process.env.PROSPECT_QC_MODEL_REVIEW_MODE =
      "single-draft-advisory-v1";
    process.env.PROSPECT_QC_OPENROUTER_API_KEY =
      qcProviderFixtureKey;
    process.env.PROSPECT_QC_OPENROUTER_MODEL =
      "google/gemini-2.5-flash-lite";
    process.env.PROSPECT_QC_MODEL_WORKSPACE_ID = "1";
    process.env.PROSPECT_QC_MODEL_DAILY_REVIEW_CAP = "7";
    process.env.PROSPECT_QC_MODEL_DAILY_SPEND_CAP_CENTS = "7";
    process.env.PROSPECT_QC_MODEL_RESERVED_COST_CENTS = "1";
    process.env.PROSPECT_QC_MODEL_TIMEOUT_MS = "5000";
    process.env.PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY =
      revenueLoopObserverApiKey;
    process.env.PROSPECT_REVENUE_LOOP_OBSERVER_WORKSPACE_ID = "1";
    process.env.PROSPECT_REVENUE_LOOP_PREPARER_ENABLED = "true";
    process.env.PROSPECT_REVENUE_LOOP_PREPARER_API_KEY =
      revenueLoopPreparerApiKey;
    process.env.PROSPECT_REVENUE_LOOP_PREPARER_WORKSPACE_ID = "1";
    process.env.PROSPECT_REVENUE_LOOP_DISCOVERY_LIMIT = "10";
    process.env.PROSPECT_REVENUE_LOOP_DISCOVERY_CATEGORY = "plumbing";
    process.env.PROSPECT_REVENUE_LOOP_DISCOVERY_CITY = "Reno";
    process.env.PROSPECT_REVENUE_LOOP_DISCOVERY_STATE = "NV";

    const dbModule = await import("../src/db.js");
    const saasModule = await import("../src/saas.js");
    const prospectorModule = await import("../src/prospector.js");
    const researchRoutes = await import(
      "../src/routes/velvet-research-routes.js"
    );
    const sourceRoutes = await import(
      "../src/routes/velvet-lead-source-routes.js"
    );
    const discoveryRoutes = await import(
      "../src/routes/velvet-discovery-routes.js"
    );
    const outreachRoutes = await import(
      "../src/routes/prospect-outreach-routes.js"
    );
    const inboxPlacementRoutes = await import(
      "../src/routes/prospect-inbox-placement-routes.js"
    );
    const revenueLoopRoutes = await import(
      "../src/routes/prospect-revenue-loop-routes.js"
    );
    const revenueLoopPreparerContract = await import(
      "../src/prospect-revenue-loop-preparer.js"
    );
    const sourceContract = await import("../src/velvet-lead-source.js");
    const discoveryContract = await import("../src/velvet-discovery.js");
    const acquisitionExperimentContract = await import(
      "../src/velvet-acquisition-experiment.js"
    );
    const outreachContract = await import("../src/prospect-outreach.js");
    const callComplianceContract = await import(
      "../src/prospect-call-compliance.js"
    );
    const qcModelProviderContract = await import(
      "../src/prospect-qc-model-provider.js"
    );
    const emailProviderContract = await import(
      "../src/prospect-email-provider.js"
    );
    const inboxPlacementContract = await import(
      "../src/prospect-inbox-placement.js"
    );
    const variants = await import("../src/prospect-message-variants.js");
    const messageExperimentContract = await import(
      "../src/prospect-message-experiments.js"
    );
    const messagePolicyContract = await import(
      "../src/prospect-message-policy.js"
    );
    const outcomeContract = await import("../src/velvet-outcome.js");
    const positiveOutcomeReviewContract = await import(
      "../src/prospect-positive-outcome-review.js"
    );
    const inboundReplyReviewContract = await import(
      "../src/prospect-inbound-reply-review.js"
    );
    const inboundReplyContentContract = await import(
      "../src/prospect-email-receiving.js"
    );
    const positiveOutcomePauseContract = await import(
      "../src/prospect-positive-outcome-pause.js"
    );
    const researchContract = await import(
      "../src/velvet-research.js"
    );
    sql = dbModule.sql;

    const originalConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      const notice = args.length === 1 ? args[0] : null;
      if (
        notice &&
        typeof notice === "object" &&
        "severity" in notice &&
        (notice as { severity?: unknown }).severity === "NOTICE"
      ) {
        return;
      }
      originalConsoleLog(...args);
    };
    try {
      await saasModule.initSaasSchema();
      await dbModule.initSchema();
      await prospectorModule.initProspectorSchema();
    } finally {
      console.log = originalConsoleLog;
    }
    await sql`
      INSERT INTO workspaces (
        id, slug, name, owner_email, plan, api_key, timezone, mode
      ) VALUES (
        1, 'cross-db-test', 'Synthetic Cross-DB Workspace',
        'owner@example.invalid', 'basic', 'cross-db-workspace-key',
        'America/Los_Angeles', 'missed-call-recovery'
      )
      ON CONFLICT (id) DO UPDATE SET
        slug = EXCLUDED.slug,
        name = EXCLUDED.name,
        owner_email = EXCLUDED.owner_email
    `;
    const migrationBackfillProof = await (async () => {
      const campaignRows = await sql<{ id: number }[]>`
        INSERT INTO prospecting_campaigns (
          name, status, workspace_id
        ) VALUES (
          'Synthetic Positive Review Backfill', 'completed', 999
        )
        RETURNING id
      `;
      const campaignId = campaignRows[0].id;
      const leadRows = await sql<{ id: number }[]>`
        INSERT INTO prospect_leads (
          campaign_id, business_name, email, email_verification,
          source, status, review_state
        ) VALUES (
          ${campaignId}, 'Synthetic Backfill Plumbing',
          'backfill@example.invalid', 'verified_owner_email',
          'manual', 'contacted', 'qualified'
        )
        RETURNING id
      `;
      const leadId = leadRows[0].id;
      const approvalId = "99999999-9999-4999-8999-999999999999";
      const jobRows = await sql<{ id: number }[]>`
        INSERT INTO prospect_outreach_jobs (
          approval_id, workspace_id, campaign_id, lead_id, channel,
          state, recipient, subject, content, variant_key,
          contract_version, evidence_hash, draft_fingerprint,
          payload, payload_hash, max_cost_cents, prepared_by,
          expires_at, sent_at, is_seed
        ) VALUES (
          ${approvalId}, 999, ${campaignId}, ${leadId}, 'email',
          'SENT', 'backfill@example.invalid', 'Synthetic backfill',
          'Synthetic migration proof only.', 'operator-v1',
          'synthetic-backfill-v1', ${"a".repeat(64)},
          ${"b".repeat(64)}, ${sql.json({ synthetic: true })},
          ${"c".repeat(64)}, 0, 'synthetic_migration_fixture',
          NOW() + INTERVAL '1 hour', NOW(), FALSE
        )
        RETURNING id
      `;
      const outcomeRows = await sql<{ id: number }[]>`
        INSERT INTO prospect_outcome_events (
          workspace_id, campaign_id, lead_id, outreach_job_id,
          source, external_event_id, outcome, occurred_at,
          notes, recorded_by
        ) VALUES (
          999, ${campaignId}, ${leadId}, ${jobRows[0].id},
          'operator', 'synthetic-backfill-positive-event',
          'replied', NOW(), 'Synthetic historical reply.',
          'synthetic_migration_fixture'
        )
        RETURNING id
      `;
      await prospectorModule.initProspectorSchema();
      const proofRows = await sql`
        SELECT r.state, r.payload->>'outcome' AS outcome,
               COUNT(e.id)::int AS audit_events
        FROM prospect_positive_outcome_reviews r
        LEFT JOIN prospect_positive_outcome_review_events e
          ON e.review_row_id = r.id
         AND e.workspace_id = r.workspace_id
        WHERE r.workspace_id = 999
          AND r.outcome_event_id = ${outcomeRows[0].id}
        GROUP BY r.id
      `;
      invariant(
        proofRows.length === 1 &&
          proofRows[0].state === "PENDING" &&
          proofRows[0].outcome === "replied" &&
          proofRows[0].audit_events === 1,
        "Historical positive outcome was not backfilled into the review queue."
      );
      await sql`
        DELETE FROM prospect_positive_outcome_reviews
        WHERE workspace_id = 999
      `;
      await sql`
        DELETE FROM prospect_outcome_events
        WHERE workspace_id = 999
      `;
      await sql`
        DELETE FROM prospect_outreach_jobs
        WHERE workspace_id = 999
      `;
      await sql`
        DELETE FROM prospect_leads
        WHERE campaign_id = ${campaignId}
      `;
      await sql`
        DELETE FROM prospecting_campaigns
        WHERE id = ${campaignId} AND workspace_id = 999
      `;
      return {
        historicalOutcomeRows: 1,
        backfilledReviewRows: 1,
        initialAuditEvents: 1,
        fixtureCleanup: "verified",
      };
    })();

    const guardedIntegrationFetch: typeof fetch = async (input, init) => {
      const requestedUrl = new URL(
        input instanceof Request ? input.url : String(input)
      );
      if (
        requestedUrl.origin === resendOrigin &&
        requestedUrl.pathname === "/emails"
      ) {
        network.emailProviderAdapterRequests += 1;
        const providerMessageId =
          network.emailProviderAdapterRequests === 1
            ? syntheticProviderMessageId
            : `email_seed_${network.emailProviderAdapterRequests}_${runId}`;
        return new Response(
          JSON.stringify({ id: providerMessageId }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }
      if (
        requestedUrl.origin === resendOrigin &&
        requestedUrl.pathname ===
          `/emails/receiving/email_reply_${runId}`
      ) {
        invariant(
          init?.method === "GET" &&
            requestedUrl.searchParams.get("html_format") === "cid" &&
            new Headers(init.headers).get("authorization") ===
              `Bearer ${receivingProviderFixtureKey}`,
          "The inbound email content request widened its read-only provider contract."
        );
        network.emailReceivingAdapterRequests += 1;
        return new Response(
          JSON.stringify({
            object: "email",
            id: `email_reply_${runId}`,
            to: ["reply@smirkcalls.com"],
            from: `Synthetic Owner <${importedRows[0].email}>`,
            created_at: new Date().toISOString(),
            subject: `Re: ${emailVariant.subject}`,
            bcc: null,
            cc: null,
            reply_to: null,
            received_for: ["reply@smirkcalls.com"],
            html: "<p>This HTML must not be retained.</p>",
            text:
              "Yes, this is the exact synthetic inbound reply for review.",
            headers: { "x-test-secret": "must-not-be-retained" },
            message_id: `message_${runId}`,
            raw: { download_url: "https://example.invalid/raw" },
            attachments: [
              {
                id: "synthetic-attachment-not-fetched",
                filename: "ignored.txt",
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }
      if (
        requestedUrl.origin === openRouterOrigin &&
        requestedUrl.pathname === "/api/v1/chat/completions"
      ) {
        const requestBody = JSON.parse(String(init?.body || "{}"));
        invariant(
          init?.method === "POST" &&
            requestBody.model ===
              "google/gemini-2.5-flash-lite" &&
            requestBody.provider?.require_parameters === true &&
            requestBody.response_format?.type === "json_schema" &&
            requestBody.response_format?.json_schema?.strict === true &&
            !("tools" in requestBody),
          "The advisory QC provider request widened its bounded contract."
        );
        network.qcProviderAdapterRequests += 1;
        return new Response(
          JSON.stringify({
            id: `gen_${runId}_${network.qcProviderAdapterRequests}`,
            model: "google/gemini-2.5-flash-lite",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    pass: true,
                    confidence_score: 0.99,
                    failure_reasons: [],
                  }),
                },
              },
            ],
            usage: {
              cost: 0.0001,
              total_tokens: 42,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }
      if (requestedUrl.origin !== productionVelvetOrigin) {
        network.unexpectedRequests += 1;
        throw new Error(
          `Blocked unexpected integration request: ${requestedUrl.origin}`
        );
      }
      if (
        requestedUrl.pathname ===
        "/api/v1/smirk/acquisition-sourcing-experiments/active"
      ) {
        network.activeExperimentRequests += 1;
      } else if (
        requestedUrl.pathname === "/api/v1/smirk/discovery-requests"
      ) {
        network.discoveryPrepareRequests += 1;
      } else if (
        /^\/api\/v1\/smirk\/discovery-requests\/[A-Za-z0-9:_-]+$/.test(
          requestedUrl.pathname
        )
      ) {
        network.discoveryStatusRequests += 1;
      } else if (requestedUrl.pathname === "/api/v1/smirk/lead-batches") {
        network.leadBatchRequests += 1;
      } else if (
        /^\/api\/v1\/leads\/\d+\/outcome$/.test(requestedUrl.pathname)
      ) {
        network.outcomeRequests += 1;
      } else {
        network.unexpectedRequests += 1;
        throw new Error(
          `Blocked unexpected Velvet path: ${requestedUrl.pathname}`
        );
      }
      const localUrl = new URL(
        `${requestedUrl.pathname}${requestedUrl.search}`,
        velvetFixtureBaseUrl
      );
      return fetch(localUrl, {
        ...init,
        redirect: "error",
        cache: "no-store",
      });
    };

    const app = express();
    const jsonParser = express.json({ limit: "1mb" });
    app.use((req, res, next) =>
      req.path === "/api/prospecting/resend/webhook"
        ? next()
        : jsonParser(req, res, next)
    );
    const operator = (
      req: Request,
      _res: ExpressResponse,
      next: NextFunction
    ) => {
      (req as any).authMode = "operator";
      next();
    };
    const discoveryDashboardAuth = (
      req: Request,
      res: ExpressResponse,
      next: NextFunction
    ) => {
      if (
        req.path !==
        revenueLoopPreparerContract.PROSPECT_REVENUE_LOOP_PREPARER_PATH
      ) {
        return operator(req, res, next);
      }
      const workspaceId =
        revenueLoopPreparerContract.authenticateProspectRevenueLoopPreparer({
          method: req.method,
          path: req.path,
          providedApiKey: String(req.headers["x-api-key"] || ""),
          env: process.env,
        });
      if (workspaceId === null) {
        return res.status(401).json({
          error: "Invalid preparer credential.",
          externalAction: "none",
        });
      }
      (req as any).authMode = "prospect_revenue_loop_preparer";
      (req.headers as any)["x-workspace-id"] = String(workspaceId);
      return next();
    };
    const discoveryOperator = (
      req: Request,
      res: ExpressResponse,
      next: NextFunction
    ) =>
      (req as any).authMode === "prospect_revenue_loop_preparer"
        ? next()
        : operator(req, res, next);
    const getWorkspaceId = (req: Request) => {
      const requested = Number(
        req.headers["x-workspace-id"] ||
          req.headers["x-smirk-fixture-workspace"] ||
          1
      );
      return Number.isSafeInteger(requested) && requested > 0
        ? requested
        : 1;
    };
    const store = researchRoutes.createPostgresVelvetResearchStore(sql);
    discoveryRoutes.registerVelvetDiscoveryRoutes(app, {
      dashboardAuth: discoveryDashboardAuth,
      requireOperator: discoveryOperator,
      requireFullOperator: discoveryOperator,
      sql,
      dbEnabled: true,
      getWorkspaceId,
      env: process.env,
      fetchImpl: guardedIntegrationFetch,
    });
    sourceRoutes.registerVelvetLeadSourceRoutes(app, {
      dashboardAuth: operator,
      requireOperator: operator,
      requireFullOperator: operator,
      sql,
      dbEnabled: true,
      getWorkspaceId,
      store,
      env: process.env,
      fetchImpl: guardedIntegrationFetch,
    });
    outreachRoutes.registerProspectOutreachRoutes(app, {
      dashboardAuth: operator,
      requireOperator: operator,
      requireFullOperator: operator,
      sql,
      dbEnabled: true,
      getWorkspaceId,
      env: process.env,
      fetchImpl: guardedIntegrationFetch,
    });
    inboxPlacementRoutes.registerProspectInboxPlacementRoutes(app, {
      dashboardAuth: operator,
      requireOperator: operator,
      requireFullOperator: operator,
      sql,
      dbEnabled: true,
      getWorkspaceId,
      env: process.env,
    });
    revenueLoopRoutes.registerProspectRevenueLoopRoutes(app, {
      dashboardAuth: operator,
      requireOperator: operator,
      sql,
      dbEnabled: true,
      getWorkspaceId,
      env: process.env,
    });
    const listening = await listen(app);
    smirkServer = listening.server;

    const sourcePrepared = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/velvet-source/requests",
      method: "POST",
      body: {
        criteria: {
          limit: 1,
          category: "Plumbing",
          city: "Reno",
          state: "NV",
          learningMode: "none",
        },
      },
      expectedStatus: 201,
    });
    invariant(
      sourcePrepared.state === "PREPARED" &&
        Number.isSafeInteger(sourcePrepared.id) &&
        /^[a-f0-9]{64}$/.test(sourcePrepared.payloadHash),
      "SMIRK did not durably prepare the source request."
    );
    const sourceApproved = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/velvet-source/requests/${sourcePrepared.id}/approve`,
      method: "POST",
      body: {
        payloadHash: sourcePrepared.payloadHash,
        confirmation:
          sourceContract.VELVET_LEAD_SOURCE_APPROVAL_CONFIRMATION,
        attestations: {
          noContactAuthorized: true,
          zeroSpendAuthorized: true,
        },
      },
      expectedStatus: 200,
    });
    invariant(
      sourceApproved.state === "APPROVED",
      "SMIRK did not approve the exact source request."
    );
    const sourceDispatched = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/velvet-source/requests/${sourcePrepared.id}/dispatch`,
      method: "POST",
      body: {
        payloadHash: sourcePrepared.payloadHash,
        confirmation:
          sourceContract.VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION,
      },
      expectedStatus: 200,
    });
    invariant(
      sourceDispatched.state === "COMPLETED" &&
        sourceDispatched.importedCount === 1 &&
        sourceDispatched.failedCount === 0,
      "SMIRK did not import exactly one reviewed Velvet lead."
    );
    const sourceDispatchReplay = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/velvet-source/requests/${sourcePrepared.id}/dispatch`,
      method: "POST",
      body: {
        payloadHash: sourcePrepared.payloadHash,
        confirmation:
          sourceContract.VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION,
      },
      expectedStatus: 200,
    });
    invariant(
      sourceDispatchReplay.replay === true &&
        sourceDispatchReplay.importedCount === 1,
      "SMIRK source dispatch replay was not idempotent."
    );

    const sourceRows = await sql`
      SELECT request_payload
      FROM velvet_lead_source_requests
      WHERE id = ${sourcePrepared.id} AND workspace_id = 1
      LIMIT 1
    `;
    const sourceRequest = sourceContract.velvetLeadSourceRequestSchema.parse(
      sourceRows[0]?.request_payload
    );
    const sourceConfig = sourceContract.readVelvetLeadSourceConfig(
      process.env
    );
    const remoteSourceReplay =
      await sourceContract.requestVelvetLeadBatch(
        sourceRequest,
        sourceConfig,
        guardedIntegrationFetch
      );
    invariant(
      remoteSourceReplay.success &&
        remoteSourceReplay.response.state === "DUPLICATE" &&
        remoteSourceReplay.httpStatus === 200,
      "Velvet did not recognize the exact lead-batch replay."
    );

    const importedRows = await sql`
      SELECT l.id, l.campaign_id, l.business_name, l.industry,
             l.external_id, l.research_evidence, l.email,
             l.email_verification
      FROM prospect_leads l
      JOIN prospecting_campaigns c ON c.id = l.campaign_id
      WHERE c.workspace_id = 1
        AND l.source = 'velvet_alchemy_research'
      ORDER BY l.id ASC
    `;
    invariant(
      importedRows.length === 1 &&
        importedRows[0].external_id ===
          velvetFixture.ready.externalProspectId &&
        typeof importedRows[0].email === "string" &&
        importedRows[0].email.endsWith("@example.invalid") &&
        importedRows[0].email_verification ===
          "verified_owner_email",
      "The imported SMIRK prospect identity does not match Velvet."
    );
    const leadId = Number(importedRows[0].id);
    const crossTenant = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/leads/${leadId}/outreach`,
      headers: { "x-smirk-fixture-workspace": "2" },
      expectedStatus: 404,
    });
    invariant(
      crossTenant.code === "PROSPECT_NOT_FOUND",
      "Cross-workspace access was not denied."
    );
    await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/leads/${leadId}/review`,
      method: "PATCH",
      body: {
        decision: "qualified",
        notes: "Synthetic persistence proof only.",
      },
      expectedStatus: 200,
    });

    const messageContext = variants.buildProspectMessageContext({
      businessName: importedRows[0].business_name,
      industry: importedRows[0].industry,
      researchEvidence: importedRows[0].research_evidence,
    });
    const callVariant = variants.renderProspectMessageVariant(
      "manual-owner-call-v1",
      messageContext
    );
    invariant(
      callVariant?.channel === "call",
      "The registered manual-call variant is unavailable."
    );
    const outreachPrepared = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/leads/${leadId}/outreach`,
      method: "POST",
      body: {
        channel: "call",
        callBrief: callVariant.content,
        variantKey: callVariant.key,
        maxCostCents: 1,
        expiresInHours: 8,
      },
      expectedStatus: 201,
    });
    invariant(
      outreachPrepared.state === "PREPARED" &&
        /^[0-9a-f-]{36}$/.test(outreachPrepared.approvalId) &&
        /^[a-f0-9]{64}$/.test(outreachPrepared.payloadHash),
      "The exact manual-call brief was not prepared."
    );
    const outreachView = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/leads/${leadId}/outreach`,
      expectedStatus: 200,
    });
    const qcReceipt = outreachView.jobs?.[0]?.qc_receipt;
    invariant(
      qcReceipt?.verdict === "ELIGIBLE_FOR_HUMAN_APPROVAL" &&
        qcReceipt?.deterministicPassed === true &&
        qcReceipt?.contactAuthorized === false &&
        qcReceipt?.executionAuthorized === false,
      "The persisted outreach job is missing its fail-closed QC receipt."
    );
    const callQcReviewed = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/outreach/${outreachPrepared.approvalId}/qc-model-review`,
      method: "POST",
      body: {
        payloadHash: outreachPrepared.payloadHash,
        confirmation:
          qcModelProviderContract.PROSPECT_QC_MODEL_REVIEW_CONFIRMATION,
      },
      expectedStatus: 201,
    });
    invariant(
      callQcReviewed.outcome === "reviewed" &&
        callQcReviewed.receipt?.review?.status === "PASSED" &&
        callQcReviewed.receipt?.humanApprovalRequired === true &&
        callQcReviewed.receipt?.contactAuthorized === false &&
        callQcReviewed.receipt?.executionAuthorized === false &&
        /^[0-9a-f-]{36}$/.test(callQcReviewed.reviewId) &&
        /^[a-f0-9]{64}$/.test(callQcReviewed.receiptHash),
      "The synthetic call brief did not receive a durable advisory QC receipt."
    );
    const callQcReplay = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/outreach/${outreachPrepared.approvalId}/qc-model-review`,
      method: "POST",
      body: {
        payloadHash: outreachPrepared.payloadHash,
        confirmation:
          qcModelProviderContract.PROSPECT_QC_MODEL_REVIEW_CONFIRMATION,
      },
      expectedStatus: 200,
    });
    invariant(
      callQcReplay.outcome === "duplicate" &&
        callQcReplay.reviewId === callQcReviewed.reviewId &&
        callQcReplay.providerRequestPerformed === false &&
        network.qcProviderAdapterRequests === 1,
      "The exact advisory QC replay reached the provider twice."
    );
    const callComplianceCheckedAt = new Date(
      Date.now() - 60_000
    );
    const callComplianceEvidence = {
      checkedAt: callComplianceCheckedAt.toISOString(),
      recipientTimezone: recipientTimezoneFor(
        callComplianceCheckedAt
      ),
      dncChecks: [
        {
          scope: "federal",
          status: "clear",
          source: "Synthetic federal registry fixture",
          reference: `federal-${runId}`,
        },
        {
          scope: "state",
          status: "clear",
          source: "Synthetic state registry fixture",
          reference: `state-${runId}`,
        },
        {
          scope: "internal",
          status: "clear",
          source: "Synthetic SMIRK suppression fixture",
          reference: `internal-${runId}`,
        },
      ],
    };
    const outreachApproved = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/outreach/${outreachPrepared.approvalId}/approve`,
      method: "POST",
      body: {
        payloadHash: outreachPrepared.payloadHash,
        attestations: {
          recipientReviewed: true,
          suppressionChecked: true,
          doNotCallChecked: true,
          callingWindowChecked: true,
          manualDialOnly: true,
          callCompliance: callComplianceEvidence,
        },
      },
      expectedStatus: 200,
    });
    invariant(
      outreachApproved.state === "APPROVED" &&
        outreachApproved.qcModelReviewId === callQcReviewed.reviewId &&
        /^[a-f0-9]{64}$/.test(
          outreachApproved.callComplianceReceiptHash
        ),
      "The exact human-gated call brief was not approved."
    );

    const approvedRows = await sql`
      SELECT approved_at, qc_model_review_id,
             qc_model_review_receipt_hash, approval_attestations
      FROM prospect_outreach_jobs
      WHERE approval_id = ${outreachPrepared.approvalId}
      LIMIT 1
    `;
    const storedCallApproval =
      outreachContract.prospectOutreachStoredApprovalSchema.parse({
        payloadHash: outreachPrepared.payloadHash,
        attestations: approvedRows[0]?.approval_attestations,
      });
    invariant(
      approvedRows[0]?.qc_model_review_id ===
        callQcReviewed.reviewId &&
        approvedRows[0]?.qc_model_review_receipt_hash ===
          callQcReviewed.receiptHash &&
        storedCallApproval.attestations
          .callComplianceReceiptHash ===
          outreachApproved.callComplianceReceiptHash &&
        callComplianceContract.hashProspectCallComplianceReceipt(
          storedCallApproval.attestations.callComplianceReceipt!
        ) ===
          storedCallApproval.attestations
            .callComplianceReceiptHash &&
        storedCallApproval.attestations.callComplianceReceipt
          ?.contactAuthorizedByReceipt === false &&
        storedCallApproval.attestations.callComplianceReceipt
          ?.automatedDialingAuthorized === false,
      "The call approval did not bind its advisory QC and call-compliance receipts."
    );
    const occurredAt = new Date(
      new Date(approvedRows[0].approved_at).getTime() + 1
    ).toISOString();
    const proofReference = `manual:synthetic-cross-db/${runId}`;
    const executionBody = {
      payloadHash: outreachPrepared.payloadHash,
      occurredAt,
      confirmation:
        outreachContract.PROSPECT_MANUAL_CALL_RECORD_CONFIRMATION,
      proofReference,
    };
    await sql`
      UPDATE prospect_outreach_jobs
      SET qc_model_review_receipt_hash = ${"0".repeat(64)}
      WHERE approval_id = ${outreachPrepared.approvalId}
    `;
    const changedCallReceiptBlocked = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/outreach/${outreachPrepared.approvalId}/record-execution`,
      method: "POST",
      body: executionBody,
      expectedStatus: 409,
    });
    invariant(
      changedCallReceiptBlocked.code ===
        "PROSPECT_QC_MODEL_APPROVAL_BINDING_INVALID",
      "A changed advisory QC receipt did not block the manual-call record."
    );
    await sql`
      UPDATE prospect_outreach_jobs
      SET qc_model_review_receipt_hash =
        ${callQcReviewed.receiptHash}
      WHERE approval_id = ${outreachPrepared.approvalId}
    `;
    await sql`
      UPDATE prospect_outreach_jobs
      SET approval_attestations = ${sql.json({
        ...storedCallApproval.attestations,
        callComplianceReceiptHash: "0".repeat(64),
      })}
      WHERE approval_id = ${outreachPrepared.approvalId}
    `;
    const changedComplianceReceiptBlocked = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/outreach/${outreachPrepared.approvalId}/record-execution`,
      method: "POST",
      body: executionBody,
      expectedStatus: 409,
    });
    invariant(
      changedComplianceReceiptBlocked.code ===
        "PROSPECT_MANUAL_CALL_CONTROLS_INVALID",
      "A changed call-compliance receipt did not block the manual-call record."
    );
    await sql`
      UPDATE prospect_outreach_jobs
      SET approval_attestations =
        ${sql.json(storedCallApproval.attestations)}
      WHERE approval_id = ${outreachPrepared.approvalId}
    `;
    const executionRecorded = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/outreach/${outreachPrepared.approvalId}/record-execution`,
      method: "POST",
      body: executionBody,
      expectedStatus: 200,
    });
    invariant(
      executionRecorded.outcome === "recorded" &&
        executionRecorded.externalAction === "recorded_only",
      "The synthetic manual execution receipt was not recorded."
    );
    const executionReplay = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/outreach/${outreachPrepared.approvalId}/record-execution`,
      method: "POST",
      body: executionBody,
      expectedStatus: 200,
    });
    invariant(
      executionReplay.outcome === "duplicate",
      "The manual execution replay created a duplicate."
    );

    const outcomeEventId = `synthetic-outcome-${runId}`;
    const outcomeBody = {
      externalEventId: outcomeEventId,
      outcome: "no_answer",
      occurredAt,
      outreachApprovalId: outreachPrepared.approvalId,
      notes:
        "Synthetic persistence proof only. No external call occurred.",
    };
    const outcomeRecorded = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/leads/${leadId}/outcomes`,
      method: "POST",
      body: outcomeBody,
      expectedStatus: 201,
    });
    invariant(
      outcomeRecorded.outcome === "recorded" &&
        outcomeRecorded.velvetCallbackState === "PREPARED",
      "The outcome did not create exactly one Velvet callback."
    );
    const outcomeReplay = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/leads/${leadId}/outcomes`,
      method: "POST",
      body: outcomeBody,
      expectedStatus: 200,
    });
    invariant(
      outcomeReplay.outcome === "duplicate",
      "The SMIRK outcome replay created a duplicate."
    );

    const outbox = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/velvet-outcomes/outbox",
      expectedStatus: 200,
    });
    invariant(
      outbox.events?.length === 1 &&
        outbox.events[0].state === "PREPARED",
      "The Velvet outcome outbox is not exact."
    );
    const outboxEvent = outbox.events[0];
    const callbackDispatched = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/velvet-outcomes/${outboxEvent.id}/dispatch`,
      method: "POST",
      body: {
        payloadHash: outboxEvent.payload_hash,
        confirmation:
          outcomeContract.VELVET_OUTCOME_DISPATCH_CONFIRMATION,
      },
      expectedStatus: 200,
    });
    invariant(
      callbackDispatched.outcome === "dispatched" &&
        callbackDispatched.remoteState === "RECORDED",
      "Velvet did not durably record the signed outcome."
    );
    const callbackDispatchReplay = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/velvet-outcomes/${outboxEvent.id}/dispatch`,
      method: "POST",
      body: {
        payloadHash: outboxEvent.payload_hash,
        confirmation:
          outcomeContract.VELVET_OUTCOME_DISPATCH_CONFIRMATION,
      },
      expectedStatus: 200,
    });
    invariant(
      callbackDispatchReplay.outcome === "duplicate",
      "The SMIRK callback dispatch replay was not idempotent."
    );

    const storedOutboxRows = await sql`
      SELECT payload
      FROM velvet_outcome_outbox
      WHERE id = ${outboxEvent.id}
      LIMIT 1
    `;
    const storedOutcomePayload =
      outcomeContract.velvetOutcomePayloadSchema.parse(
        storedOutboxRows[0]?.payload
      );
    const outcomeConfig =
      outcomeContract.readVelvetOutcomeDispatchConfig(process.env);
    const remoteOutcomeReplay =
      await outcomeContract.dispatchVelvetOutcome(
        storedOutcomePayload,
        outcomeConfig,
        guardedIntegrationFetch,
        new Date()
      );
    invariant(
      remoteOutcomeReplay.success &&
        remoteOutcomeReplay.state === "DUPLICATE",
      "Velvet did not recognize the exact signed outcome replay."
    );

    const emailVariant = variants.renderProspectMessageVariant(
      "micro-after-hours-v1",
      messageContext
    );
    invariant(
      emailVariant?.channel === "email" && emailVariant.subject,
      "The registered email variant is unavailable."
    );
    const emailPrepared = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/leads/${leadId}/outreach`,
      method: "POST",
      body: {
        channel: "email",
        subject: emailVariant.subject,
        body: emailVariant.content,
        emailCompliance: syntheticEmailCompliance,
        variantKey: emailVariant.key,
        maxCostCents: 1,
        expiresInHours: 24,
      },
      expectedStatus: 201,
    });
    invariant(
      emailPrepared.state === "PREPARED" &&
        /^[0-9a-f-]{36}$/.test(emailPrepared.approvalId) &&
        /^[a-f0-9]{64}$/.test(emailPrepared.payloadHash),
      "The exact one-recipient email was not prepared."
    );
    const emailOutreachView = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/leads/${leadId}/outreach`,
      expectedStatus: 200,
    });
    const emailJobView = emailOutreachView.jobs?.find(
      (job: JsonRecord) =>
        job.approval_id === emailPrepared.approvalId
    );
    const emailQcReceipt = emailJobView?.qc_receipt;
    invariant(
      emailQcReceipt?.verdict ===
        "ELIGIBLE_FOR_HUMAN_APPROVAL" &&
        emailQcReceipt?.deterministicPassed === true &&
        emailQcReceipt?.contactAuthorized === false &&
        emailQcReceipt?.executionAuthorized === false,
      "The persisted email is missing its fail-closed QC receipt."
    );
    const emailQcReviewed = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/outreach/${emailPrepared.approvalId}/qc-model-review`,
      method: "POST",
      body: {
        payloadHash: emailPrepared.payloadHash,
        confirmation:
          qcModelProviderContract.PROSPECT_QC_MODEL_REVIEW_CONFIRMATION,
      },
      expectedStatus: 201,
    });
    invariant(
      emailQcReviewed.outcome === "reviewed" &&
        emailQcReviewed.receipt?.review?.status === "PASSED" &&
        emailQcReviewed.receipt?.humanApprovalRequired === true &&
        emailQcReviewed.receipt?.contactAuthorized === false &&
        emailQcReviewed.receipt?.executionAuthorized === false &&
        /^[0-9a-f-]{36}$/.test(emailQcReviewed.reviewId) &&
        /^[a-f0-9]{64}$/.test(emailQcReviewed.receiptHash),
      "The synthetic email did not receive a durable advisory QC receipt."
    );
    const emailApproved = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/outreach/${emailPrepared.approvalId}/approve`,
      method: "POST",
      body: {
        payloadHash: emailPrepared.payloadHash,
        attestations: {
          recipientReviewed: true,
          suppressionChecked: true,
          emailComplianceReviewed: true,
        },
      },
      expectedStatus: 200,
    });
    invariant(
      emailApproved.state === "APPROVED" &&
        emailApproved.qcModelReviewId ===
          emailQcReviewed.reviewId,
      "The exact one-recipient email was not human-approved."
    );
    const emailApprovalRows = await sql`
      SELECT qc_model_review_id, qc_model_review_receipt_hash
      FROM prospect_outreach_jobs
      WHERE approval_id = ${emailPrepared.approvalId}
      LIMIT 1
    `;
    invariant(
      emailApprovalRows[0]?.qc_model_review_id ===
        emailQcReviewed.reviewId &&
        emailApprovalRows[0]?.qc_model_review_receipt_hash ===
          emailQcReviewed.receiptHash,
      "The email approval did not bind the exact advisory QC receipt."
    );
    const emailExecutionBody = {
      payloadHash: emailPrepared.payloadHash,
      confirmation:
        emailProviderContract.PROSPECT_EMAIL_EXECUTION_CONFIRMATION,
    };
    await sql`
      UPDATE prospect_outreach_jobs
      SET qc_model_review_receipt_hash = ${"0".repeat(64)}
      WHERE approval_id = ${emailPrepared.approvalId}
    `;
    const changedEmailReceiptBlocked = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/outreach/${emailPrepared.approvalId}/execute`,
      method: "POST",
      body: emailExecutionBody,
      expectedStatus: 409,
    });
    invariant(
      changedEmailReceiptBlocked.code ===
        "PROSPECT_QC_MODEL_APPROVAL_BINDING_INVALID" &&
        network.emailProviderAdapterRequests === 0,
      "A changed advisory QC receipt reached the email provider adapter."
    );
    await sql`
      UPDATE prospect_outreach_jobs
      SET qc_model_review_receipt_hash =
        ${emailQcReviewed.receiptHash}
      WHERE approval_id = ${emailPrepared.approvalId}
    `;
    const emailExecuted = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/outreach/${emailPrepared.approvalId}/execute`,
      method: "POST",
      body: emailExecutionBody,
      expectedStatus: 200,
    });
    invariant(
      emailExecuted.outcome === "accepted" &&
        emailExecuted.state === "SENT" &&
        emailExecuted.providerAccepted === true &&
        emailExecuted.delivered === false &&
        emailExecuted.providerMessageId ===
          syntheticProviderMessageId,
      "The intercepted one-recipient email was not durably accepted."
    );
    const emailExecutionReplay = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: `/api/prospecting/outreach/${emailPrepared.approvalId}/execute`,
      method: "POST",
      body: emailExecutionBody,
      expectedStatus: 200,
    });
    invariant(
      emailExecutionReplay.outcome === "duplicate" &&
        Number(network.emailProviderAdapterRequests) === 1,
      "The accepted email replay reached the provider adapter twice."
    );

    const deliveredEventId = `evt-delivered-${runId}`;
    const deliveredAt = new Date().toISOString();
    const deliveredWebhook = signWebhookEvent(deliveredEventId, {
      type: "email.delivered",
      created_at: deliveredAt,
      data: {
        created_at: deliveredAt,
        email_id: syntheticProviderMessageId,
        from: "SMIRK <outreach@smirkcalls.com>",
        to: [importedRows[0].email],
        subject: emailVariant.subject,
      },
    });
    const deliveredRecorded = await httpRaw({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/resend/webhook",
      body: deliveredWebhook.rawBody,
      headers: deliveredWebhook.headers,
      expectedStatus: 200,
    });
    invariant(
      deliveredRecorded.outcome === "recorded" &&
        deliveredRecorded.status === "PROCESSED",
      "The signed delivery event did not create one measured outcome."
    );
    const deliveredReplay = await httpRaw({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/resend/webhook",
      body: deliveredWebhook.rawBody,
      headers: deliveredWebhook.headers,
      expectedStatus: 200,
    });
    invariant(
      deliveredReplay.outcome === "duplicate",
      "The signed delivery event replay was not idempotent."
    );

    const replyEventId = `evt-reply-${runId}`;
    const replyAt = new Date(
      new Date(deliveredAt).getTime() + 1_000
    ).toISOString();
    const replyWebhook = signWebhookEvent(replyEventId, {
      type: "email.received",
      created_at: replyAt,
      data: {
        email_id: `email_reply_${runId}`,
        created_at: replyAt,
        from: `Synthetic Owner <${importedRows[0].email}>`,
        to: ["reply@smirkcalls.com"],
        bcc: [],
        cc: [],
        received_for: ["reply@smirkcalls.com"],
        message_id: `message_${runId}`,
        subject: `Re: ${emailVariant.subject}`,
        attachments: [],
      },
    });
    const replyRecorded = await httpRaw({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/resend/webhook",
      body: replyWebhook.rawBody,
      headers: replyWebhook.headers,
      expectedStatus: 200,
    });
    invariant(
      replyRecorded.outcome === "review_required" &&
        replyRecorded.status === "REVIEW_REQUIRED" &&
        replyRecorded.positiveOutcomeRecorded === false &&
        replyRecorded.suppressionRecorded === false &&
        replyRecorded.externalAction === "none",
      "The signed inbound email bypassed human classification."
    );
    const replyWebhookReplay = await httpRaw({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/resend/webhook",
      body: replyWebhook.rawBody,
      headers: replyWebhook.headers,
      expectedStatus: 200,
    });
    invariant(
      replyWebhookReplay.outcome === "duplicate",
      "The signed inbound-email replay created another review."
    );
    const pendingInboundReplies = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/email-replies?state=pending",
      expectedStatus: 200,
    });
    const inboundReplyReview = pendingInboundReplies.reviews?.[0];
    invariant(
      pendingInboundReplies.reviews?.length === 1 &&
        inboundReplyReview?.reviewId === replyRecorded.reviewId &&
        inboundReplyReview?.payload?.matchState === "unique" &&
        inboundReplyReview?.payload?.candidates?.length === 1 &&
        inboundReplyReview.payload.candidates[0]
          .outreachApprovalId === emailPrepared.approvalId &&
        inboundReplyReview.contentReceipt === null &&
        pendingInboundReplies.controls
          ?.exactProviderContentRequiredBeforeClassification === true &&
        pendingInboundReplies.controls?.humanClassificationRequired ===
          true &&
        pendingInboundReplies.controls?.contactAuthorized === false &&
        pendingInboundReplies.controls?.executionAuthorized === false &&
        pendingInboundReplies.externalAction === "none",
      "The inbound email did not create one immutable operator review."
    );
    const replyReviewPausedRevenueLoop = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/revenue-loop",
      expectedStatus: 200,
    });
    invariant(
      replyReviewPausedRevenueLoop.counts
        ?.unreviewedPositiveOutcomeJobs === 1 &&
        replyReviewPausedRevenueLoop.nextAction?.code ===
          "REVIEW_POSITIVE_OUTCOME",
      "The unclassified inbound email did not pause acquisition."
    );
    const inboundReplyContentRequest = {
      payloadHash: inboundReplyReview.payloadHash,
      confirmation:
        inboundReplyContentContract
          .PROSPECT_EMAIL_RECEIVING_CONFIRMATION,
      attestations: {
        noContactAuthorized: true,
        noSendAuthorized: true,
        attachmentsNotRequested: true,
        htmlWillNotBeStored: true,
      },
    };
    const inboundReplyContent = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/email-replies/` +
        `${inboundReplyReview.reviewId}/content`,
      method: "POST",
      headers: {
        "x-api-key": "synthetic-cross-db-full-operator",
      },
      body: inboundReplyContentRequest,
      expectedStatus: 201,
    });
    invariant(
      inboundReplyContent.outcome === "retrieved" &&
        inboundReplyContent.receipt?.plainText ===
          "Yes, this is the exact synthetic inbound reply for review." &&
        inboundReplyContent.receipt?.contactAuthorized === false &&
        inboundReplyContent.receipt?.sendAuthorized === false &&
        inboundReplyContent.receipt?.htmlStored === false &&
        inboundReplyContent.receipt?.attachmentsFetched === false &&
        /^[a-f0-9]{64}$/.test(inboundReplyContent.receiptHash) &&
        inboundReplyContent.externalAction ===
          "resend_received_email_read" &&
        network.emailReceivingAdapterRequests === 1,
      "The intercepted inbound email did not create one exact plain-text receipt."
    );
    const inboundReplyContentReplay = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/email-replies/` +
        `${inboundReplyReview.reviewId}/content`,
      method: "POST",
      headers: {
        "x-api-key": "synthetic-cross-db-full-operator",
      },
      body: inboundReplyContentRequest,
      expectedStatus: 200,
    });
    invariant(
      inboundReplyContentReplay.outcome === "duplicate" &&
        inboundReplyContentReplay.receiptHash ===
          inboundReplyContent.receiptHash &&
        network.emailReceivingAdapterRequests === 1,
      "The exact inbound-email content replay reached the provider twice."
    );
    const storedInboundContentRows = await sql`
      SELECT details
      FROM prospect_email_provider_events
      WHERE workspace_id = 1
        AND provider_event_id = ${replyEventId}
      LIMIT 1
    `;
    const serializedInboundContent = JSON.stringify(
      storedInboundContentRows[0]?.details || {}
    );
    invariant(
      serializedInboundContent.includes(
        "exact synthetic inbound reply"
      ) &&
        !serializedInboundContent.includes(
          "This HTML must not be retained"
        ) &&
        !serializedInboundContent.includes("must-not-be-retained") &&
        !serializedInboundContent.includes(
          "synthetic-attachment-not-fetched"
        ),
      "The inbound-email receipt retained rich provider content or lost its plain text."
    );
    const inboundReplyResolution = {
      payloadHash: inboundReplyReview.payloadHash,
      contentReceiptHash: inboundReplyContent.receiptHash,
      confirmation:
        inboundReplyReviewContract
          .PROSPECT_INBOUND_REPLY_RESOLUTION_CONFIRMATION,
      resolution: "reply",
      selectedOutreachApprovalId: emailPrepared.approvalId,
      notes: "Synthetic cross-database inbound message reviewed.",
      attestations: {
        messageContentReviewed: true,
        senderIdentityMatched: true,
        noContactExecutedByResolution: true,
        followUpRemainsSeparate: true,
      },
    };
    const inboundReplyResolved = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/email-replies/` +
        `${inboundReplyReview.reviewId}/resolve`,
      method: "POST",
      headers: {
        "x-api-key": "synthetic-cross-db-full-operator",
      },
      body: inboundReplyResolution,
      expectedStatus: 201,
    });
    invariant(
      inboundReplyResolved.outcome === "resolved" &&
        inboundReplyResolved.receipt?.resolution === "reply" &&
        inboundReplyResolved.receipt?.resultingOutcome === "replied" &&
        inboundReplyResolved.receipt?.suppressionRecorded === false &&
        inboundReplyResolved.controls?.contactAuthorized === false &&
        inboundReplyResolved.controls?.executionAuthorized === false &&
        inboundReplyResolved.externalAction === "none",
      "The exact human reply classification was not durably recorded."
    );
    const inboundReplyResolutionReplay = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/email-replies/` +
        `${inboundReplyReview.reviewId}/resolve`,
      method: "POST",
      headers: {
        "x-api-key": "synthetic-cross-db-full-operator",
      },
      body: inboundReplyResolution,
      expectedStatus: 200,
    });
    invariant(
      inboundReplyResolutionReplay.outcome === "duplicate" &&
        inboundReplyResolutionReplay.receiptHash ===
          inboundReplyResolved.receiptHash,
      "The exact inbound-reply resolution replay was not idempotent."
    );
    const clearedInboundReplies = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/email-replies?state=pending",
      expectedStatus: 200,
    });
    invariant(
      clearedInboundReplies.reviews?.length === 0,
      "The resolved inbound email remained in the pending queue."
    );

    const pendingEmailCallbacks = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/velvet-outcomes/outbox",
      expectedStatus: 200,
    });
    const emailOutboxEvents = pendingEmailCallbacks.events?.filter(
      (event: JsonRecord) => event.state === "PREPARED"
    );
    invariant(
      emailOutboxEvents?.length === 2,
      "The delivery and reply did not prepare exactly two Velvet callbacks."
    );

    const pendingPositiveReviews = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/positive-outcomes?state=pending",
      expectedStatus: 200,
    });
    invariant(
      pendingPositiveReviews.reviews?.length === 1 &&
        pendingPositiveReviews.reviews[0].state === "PENDING" &&
        pendingPositiveReviews.reviews[0].payload?.outcome ===
          "replied" &&
        pendingPositiveReviews.controls?.contactAuthorized === false &&
        pendingPositiveReviews.controls?.executionAuthorized === false &&
        pendingPositiveReviews.externalAction === "none",
      "The signed reply did not create one inert human-review item."
    );
    const positiveReview = pendingPositiveReviews.reviews[0];
    const storedSourceResponseRows = await sql`
      SELECT remote_response
      FROM velvet_lead_source_requests
      WHERE id = ${sourcePrepared.id}
        AND workspace_id = 1
      LIMIT 1
    `;
    const storedSourceResponse =
      sourceContract.velvetLeadSourceResponseSchema.parse(
        storedSourceResponseRows[0]?.remote_response
      );
    const importedResearchPayload =
      storedSourceResponse.prospects[0];
    invariant(
      importedResearchPayload,
      "The stored Velvet source response has no research payload."
    );
    const researchReplayDuringPause = await store.receive({
      ...importedResearchPayload,
      payloadHash:
        researchContract.buildVelvetResearchPayloadHash(
          importedResearchPayload
        ),
    });
    invariant(
      researchReplayDuringPause.outcome === "duplicate" &&
        researchReplayDuringPause.prospectId === leadId,
      "An exact direct-research replay was blocked or duplicated during review."
    );
    const newResearchPayload =
      researchContract.velvetResearchPayloadSchema.parse({
        ...importedResearchPayload,
        externalId: `velvet-paused-${runId}`,
      });
    let newResearchBlockedUntilAcknowledged = "";
    try {
      await store.receive({
        ...newResearchPayload,
        payloadHash:
          researchContract.buildVelvetResearchPayloadHash(
            newResearchPayload
          ),
      });
    } catch (error) {
      if (
        error instanceof
          positiveOutcomePauseContract
            .ProspectAcquisitionPausedError &&
        error.pendingCount === 1
      ) {
        newResearchBlockedUntilAcknowledged = error.code;
      } else {
        throw error;
      }
    }
    invariant(
      newResearchBlockedUntilAcknowledged ===
        "PROSPECT_ACQUISITION_PAUSED_FOR_INTERACTION_REVIEW",
      "A new direct Velvet research import bypassed the positive-outcome pause."
    );
    const callbackBlockedByPositiveReview = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/velvet-outcomes/` +
        `${emailOutboxEvents[0].id}/dispatch`,
      method: "POST",
      body: {
        payloadHash: emailOutboxEvents[0].payload_hash,
        confirmation:
          outcomeContract.VELVET_OUTCOME_DISPATCH_CONFIRMATION,
      },
      expectedStatus: 409,
    });
    invariant(
      callbackBlockedByPositiveReview.code ===
        "PROSPECT_ACQUISITION_PAUSED_FOR_INTERACTION_REVIEW" &&
        callbackBlockedByPositiveReview
          .pendingPositiveOutcomeReviews === 1 &&
        callbackBlockedByPositiveReview.externalAction === "none",
      "A pending positive review did not block new callback dispatch."
    );
    const pausedRevenueLoop = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/revenue-loop",
      expectedStatus: 200,
    });
    invariant(
      pausedRevenueLoop.contractVersion ===
        "smirk.prospect-revenue-loop.v11" &&
        pausedRevenueLoop.counts?.positiveOutcomeJobs === 1 &&
        pausedRevenueLoop.counts?.unreviewedPositiveOutcomeJobs === 1 &&
        pausedRevenueLoop.nextAction?.code ===
          "REVIEW_POSITIVE_OUTCOME" &&
        pausedRevenueLoop.nextAction?.focus?.kind ===
          "positive_outcome_review" &&
        pausedRevenueLoop.nextAction.focus.reviewId ===
          positiveReview.reviewId,
      "The revenue loop did not pause on the unreviewed interaction."
    );
    const forgedPreparerBlocked = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        revenueLoopPreparerContract.PROSPECT_REVENUE_LOOP_PREPARER_PATH,
      method: "POST",
      headers: { "x-api-key": `${revenueLoopPreparerApiKey}-forged` },
      body: {
        confirmation:
          revenueLoopPreparerContract
            .PROSPECT_REVENUE_LOOP_PREPARER_CONFIRMATION,
      },
      expectedStatus: 401,
    });
    invariant(
      forgedPreparerBlocked.externalAction === "none",
      "A forged preparer credential was not rejected before storage."
    );
    const pausedPreparerBlocked = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        revenueLoopPreparerContract.PROSPECT_REVENUE_LOOP_PREPARER_PATH,
      method: "POST",
      headers: { "x-api-key": revenueLoopPreparerApiKey },
      body: {
        confirmation:
          revenueLoopPreparerContract
            .PROSPECT_REVENUE_LOOP_PREPARER_CONFIRMATION,
      },
      expectedStatus: 409,
    });
    invariant(
      pausedPreparerBlocked.code ===
        "PROSPECT_ACQUISITION_PAUSED_FOR_INTERACTION_REVIEW" &&
        pausedPreparerBlocked.externalAction === "none",
      "The preparer bypassed the pending positive-interaction pause."
    );
    const positiveReviewAcknowledgment = {
      payloadHash: positiveReview.payloadHash,
      confirmation:
        positiveOutcomeReviewContract
          .PROSPECT_POSITIVE_OUTCOME_ACKNOWLEDGMENT_CONFIRMATION,
      resolution: "continue_guarded_loop",
      notes: "Synthetic cross-database review only.",
      attestations: {
        interactionReviewed: true,
        noContactExecutedByAcknowledgment: true,
        followUpRemainsSeparate: true,
      },
    };
    const reviewAcknowledged = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/positive-outcomes/` +
        `${positiveReview.reviewId}/acknowledge`,
      method: "POST",
      headers: {
        "x-api-key": "synthetic-cross-db-full-operator",
      },
      body: positiveReviewAcknowledgment,
      expectedStatus: 201,
    });
    invariant(
      reviewAcknowledged.outcome === "acknowledged" &&
        reviewAcknowledged.reviewState === "ACKNOWLEDGED" &&
        reviewAcknowledged.controls?.contactAuthorized === false &&
        reviewAcknowledged.controls?.executionAuthorized === false &&
        reviewAcknowledged.controls?.spendAuthorized === false &&
        reviewAcknowledged.controls?.policyMutationAuthorized === false &&
        reviewAcknowledged.controls?.providerRequestAuthorized === false &&
        reviewAcknowledged.externalAction === "none",
      "The positive-outcome acknowledgment widened execution authority."
    );
    const reviewAcknowledgmentReplay = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/positive-outcomes/` +
        `${positiveReview.reviewId}/acknowledge`,
      method: "POST",
      headers: {
        "x-api-key": "synthetic-cross-db-full-operator",
      },
      body: positiveReviewAcknowledgment,
      expectedStatus: 200,
    });
    invariant(
      reviewAcknowledgmentReplay.outcome === "duplicate" &&
        reviewAcknowledgmentReplay.receiptHash ===
          reviewAcknowledged.receiptHash,
      "The exact positive-outcome acknowledgment replay was not idempotent."
    );
    const clearedPositiveReviews = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/positive-outcomes?state=pending",
      expectedStatus: 200,
    });
    invariant(
      clearedPositiveReviews.reviews?.length === 0,
      "The acknowledged positive outcome remained in the pending queue."
    );
    for (const event of emailOutboxEvents) {
      const dispatched = await httpJson({
        baseUrl: listening.baseUrl,
        pathname: `/api/prospecting/velvet-outcomes/${event.id}/dispatch`,
        method: "POST",
        body: {
          payloadHash: event.payload_hash,
          confirmation:
            outcomeContract.VELVET_OUTCOME_DISPATCH_CONFIRMATION,
        },
        expectedStatus: 200,
      });
      invariant(
        dispatched.outcome === "dispatched" &&
          dispatched.remoteState === "RECORDED",
        "Velvet did not durably record an email outcome after review."
      );
    }
    const revenueLoop = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/revenue-loop",
      expectedStatus: 200,
    });
    invariant(
      revenueLoop.counts?.positiveOutcomeJobs === 1 &&
        revenueLoop.counts?.unreviewedPositiveOutcomeJobs === 0 &&
        revenueLoop.nextAction?.code === "PREPARE_VELVET_DISCOVERY",
      "The guarded loop did not resume after exact human acknowledgment."
    );
    const preparerNetworkBefore = JSON.stringify(network);
    const revenueLoopPrepared = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        revenueLoopPreparerContract.PROSPECT_REVENUE_LOOP_PREPARER_PATH,
      method: "POST",
      headers: { "x-api-key": revenueLoopPreparerApiKey },
      body: {
        confirmation:
          revenueLoopPreparerContract
            .PROSPECT_REVENUE_LOOP_PREPARER_CONFIRMATION,
      },
      expectedStatus: 201,
    });
    const revenueLoopPreparedReplay = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        revenueLoopPreparerContract.PROSPECT_REVENUE_LOOP_PREPARER_PATH,
      method: "POST",
      headers: { "x-api-key": revenueLoopPreparerApiKey },
      body: {
        confirmation:
          revenueLoopPreparerContract
            .PROSPECT_REVENUE_LOOP_PREPARER_CONFIRMATION,
      },
      expectedStatus: 200,
    });
    invariant(
      revenueLoopPrepared.outcome === "PREPARED" &&
        revenueLoopPreparedReplay.outcome === "DUPLICATE" &&
        revenueLoopPreparedReplay.id === revenueLoopPrepared.id &&
        revenueLoopPreparedReplay.payloadHash ===
          revenueLoopPrepared.payloadHash &&
        revenueLoopPrepared.controls?.humanApprovalRequired === true &&
        revenueLoopPrepared.controls?.contactAuthorized === false &&
        revenueLoopPrepared.controls?.executionAuthorized === false &&
        revenueLoopPrepared.controls?.spendAuthorized === false &&
        revenueLoopPrepared.controls?.providerRequestAuthorized === false &&
        revenueLoopPrepared.controls?.policyMutationAuthorized === false &&
        revenueLoopPrepared.externalAction === "none" &&
        JSON.stringify(network) === preparerNetworkBefore,
      "The preparer did not persist and replay one inert review item."
    );
    const revenueLoopPreparedRows = await sql`
      SELECT id, state, prepared_by, request_payload_hash
      FROM velvet_discovery_requests
      WHERE id = ${revenueLoopPrepared.id}
        AND workspace_id = 1
      LIMIT 1
    `;
    const revenueLoopPreparedEvents = await sql`
      SELECT from_state, to_state, actor, payload_hash
      FROM velvet_discovery_request_events
      WHERE request_row_id = ${revenueLoopPrepared.id}
        AND workspace_id = 1
      ORDER BY id ASC
    `;
    invariant(
      revenueLoopPreparedRows.length === 1 &&
        revenueLoopPreparedRows[0].state === "PREPARED" &&
        revenueLoopPreparedRows[0].prepared_by ===
          "revenue_loop_preparer" &&
        revenueLoopPreparedRows[0].request_payload_hash ===
          revenueLoopPrepared.payloadHash &&
        revenueLoopPreparedEvents.length === 1 &&
        revenueLoopPreparedEvents[0].from_state === null &&
        revenueLoopPreparedEvents[0].to_state === "PREPARED" &&
        revenueLoopPreparedEvents[0].actor ===
          "revenue_loop_preparer" &&
        revenueLoopPreparedEvents[0].payload_hash ===
          revenueLoopPrepared.payloadHash,
      "The preparer row and immutable event did not match the receipt."
    );
    const revenueLoopPreparedCancelled = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/velvet-discovery/requests/` +
        `${revenueLoopPrepared.id}/cancel`,
      method: "POST",
      body: {
        payloadHash: revenueLoopPrepared.payloadHash,
        confirmation:
          discoveryContract.VELVET_DISCOVERY_CANCEL_CONFIRMATION,
        reason: "Synthetic preparer persistence proof complete.",
      },
      expectedStatus: 200,
    });
    invariant(
      revenueLoopPreparedCancelled.state === "CANCELLED" &&
        revenueLoopPreparedCancelled.externalAction === "none" &&
        JSON.stringify(network) === preparerNetworkBefore,
      "The synthetic preparer item was not cancelled without external action."
    );

    const activeExperiment =
      acquisitionExperimentContract.velvetAcquisitionSourcingActiveResponseSchema.parse(
        await httpJson({
          baseUrl: listening.baseUrl,
          pathname: "/api/prospecting/velvet-discovery/active-experiment",
          expectedStatus: 200,
        })
      );
    invariant(
      activeExperiment.state === "ACTIVE" &&
        activeExperiment.experiment !== null &&
        activeExperiment.experiment.binding.experimentId ===
          velvetFixture.ready.experimentId &&
        activeExperiment.experiment.binding.definitionHash ===
          velvetFixture.ready.experimentDefinitionHash &&
        activeExperiment.experiment.requestsPerArm === 2 &&
        activeExperiment.experiment.leadsPerRequest === 10 &&
        activeExperiment.experiment.totalRequestSlots === 4 &&
        activeExperiment.experiment.assignedRequests === 0 &&
        activeExperiment.contactActionAllowed === false &&
        activeExperiment.spendAuthorized === false &&
        activeExperiment.policyChanged === false,
      "SMIRK did not read the exact frozen Velvet experiment."
    );

    const tamperedExperimentPrepared = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/velvet-discovery/requests",
      method: "POST",
      body: {
        criteria: { limit: 10, learningMode: "experiment" },
        acquisitionExperiment: {
          ...activeExperiment.experiment.binding,
          definitionHash: "0".repeat(64),
        },
      },
      expectedStatus: 201,
    });
    await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/velvet-discovery/requests/` +
        `${tamperedExperimentPrepared.id}/approve`,
      method: "POST",
      body: {
        payloadHash: tamperedExperimentPrepared.payloadHash,
        confirmation:
          discoveryContract.VELVET_DISCOVERY_APPROVAL_CONFIRMATION,
        attestations: {
          noContactAuthorized: true,
          requestOnlyNoProviderSpend: true,
        },
      },
      expectedStatus: 200,
    });
    const tamperedExperimentBlocked = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/velvet-discovery/requests/` +
        `${tamperedExperimentPrepared.id}/dispatch`,
      method: "POST",
      body: {
        payloadHash: tamperedExperimentPrepared.payloadHash,
        confirmation:
          discoveryContract.VELVET_DISCOVERY_DISPATCH_CONFIRMATION,
      },
      expectedStatus: 502,
    });
    invariant(
      tamperedExperimentBlocked.state === "FAILED" &&
        tamperedExperimentBlocked.code ===
          "ACQUISITION_EXPERIMENT_ACTIVE_BINDING_REQUIRED",
      "A changed frozen experiment binding reached discovery assignment."
    );

    type ExperimentLead = {
      arm: "control" | "challenger";
      smirkLeadId: number;
      externalProspectId: string;
    };
    const experimentLeads: ExperimentLead[] = [];
    const experimentRuns: Array<{
      localDiscoveryId: number;
      remoteDiscoveryId: number;
      requestId: string;
      sourceRequestId: number;
      arm: "control" | "challenger";
      slotOrdinal: number;
      assignmentHash: string;
      importedCount: number;
      providerRequests: number;
    }> = [];

    for (
      let slotIndex = 0;
      slotIndex < activeExperiment.experiment.totalRequestSlots;
      slotIndex += 1
    ) {
      const discoveryPrepared = await httpJson({
        baseUrl: listening.baseUrl,
        pathname: "/api/prospecting/velvet-discovery/requests",
        method: "POST",
        body: {
          criteria: { limit: 10, learningMode: "experiment" },
          acquisitionExperiment: activeExperiment.experiment.binding,
        },
        expectedStatus: 201,
      });
      invariant(
        discoveryPrepared.state === "PREPARED" &&
          /^[a-f0-9]{64}$/.test(discoveryPrepared.payloadHash),
        "SMIRK did not prepare one frozen experiment slot."
      );
      const discoveryApproved = await httpJson({
        baseUrl: listening.baseUrl,
        pathname:
          `/api/prospecting/velvet-discovery/requests/` +
          `${discoveryPrepared.id}/approve`,
        method: "POST",
        body: {
          payloadHash: discoveryPrepared.payloadHash,
          confirmation:
            discoveryContract.VELVET_DISCOVERY_APPROVAL_CONFIRMATION,
          attestations: {
            noContactAuthorized: true,
            requestOnlyNoProviderSpend: true,
          },
        },
        expectedStatus: 200,
      });
      invariant(
        discoveryApproved.state === "APPROVED",
        "SMIRK did not approve the exact frozen experiment slot."
      );
      const discoveryDispatched = await httpJson({
        baseUrl: listening.baseUrl,
        pathname:
          `/api/prospecting/velvet-discovery/requests/` +
          `${discoveryPrepared.id}/dispatch`,
        method: "POST",
        body: {
          payloadHash: discoveryPrepared.payloadHash,
          confirmation:
            discoveryContract.VELVET_DISCOVERY_DISPATCH_CONFIRMATION,
        },
        expectedStatus: 200,
      });
      invariant(
        discoveryDispatched.state === "SUBMITTED" &&
          discoveryDispatched.remoteState === "PREPARED" &&
          Number.isSafeInteger(discoveryDispatched.remoteDiscoveryId),
        "Velvet did not assign and prepare the exact experiment slot."
      );
      const localDiscoveryRows = await sql`
        SELECT request_id, request_payload, remote_prepared_response
        FROM velvet_discovery_requests
        WHERE id = ${discoveryPrepared.id}
          AND workspace_id = 1
        LIMIT 1
      `;
      const localDiscoveryRequest =
        discoveryContract.velvetDiscoveryRequestSchema.parse(
          localDiscoveryRows[0]?.request_payload
        );
      const remotePrepared =
        discoveryContract.velvetDiscoveryPreparedResponseSchema.parse(
          localDiscoveryRows[0]?.remote_prepared_response
        );
      const assignment = remotePrepared.acquisitionExperimentAssignment;
      invariant(
        assignment !== null &&
          localDiscoveryRequest.requestId === assignment.requestId &&
          assignment.experimentId === velvetFixture.ready.experimentId &&
          assignment.definitionHash ===
            velvetFixture.ready.experimentDefinitionHash &&
          assignment.effectiveCriteria.limit === 10 &&
          remotePrepared.contactActionAllowed === false &&
          remotePrepared.spendAuthorized === false,
        "The remote experiment assignment did not remain bound to the SMIRK request."
      );
      const fixtureExecution = await httpJson({
        baseUrl: velvetFixtureBaseUrl,
        pathname:
          `/__fixture/discoveries/` +
          `${encodeURIComponent(localDiscoveryRequest.requestId)}/execute`,
        method: "POST",
        headers: { "x-fixture-token": fixtureControlToken },
        body: { assignmentHash: assignment.assignmentHash },
        expectedStatus: 200,
      });
      invariant(
        fixtureExecution.state === "COMPLETED" &&
          fixtureExecution.arm === assignment.arm &&
          fixtureExecution.readyLeadCount === 10 &&
          fixtureExecution.providerRequests === 21 &&
          fixtureExecution.contactActionAllowed === false &&
          fixtureExecution.spendAuthorized === false,
        "The disposable provider adapter did not create one exact experiment cohort."
      );
      const discoveryRefreshed = await httpJson({
        baseUrl: listening.baseUrl,
        pathname:
          `/api/prospecting/velvet-discovery/requests/` +
          `${discoveryPrepared.id}/refresh`,
        method: "POST",
        body: {
          payloadHash: discoveryPrepared.payloadHash,
          confirmation:
            discoveryContract.VELVET_DISCOVERY_REFRESH_CONFIRMATION,
        },
        expectedStatus: 200,
      });
      invariant(
        discoveryRefreshed.remoteState === "COMPLETED" &&
          discoveryRefreshed.readyLeadCount === 10 &&
          discoveryRefreshed.providerRequests === 21 &&
          discoveryRefreshed.canPrepareImport === true,
        "SMIRK did not persist the completed remote experiment status."
      );
      const importPrepared = await httpJson({
        baseUrl: listening.baseUrl,
        pathname:
          `/api/prospecting/velvet-discovery/requests/` +
          `${discoveryPrepared.id}/prepare-import`,
        method: "POST",
        body: {
          payloadHash: discoveryPrepared.payloadHash,
          confirmation:
            discoveryContract.VELVET_DISCOVERY_IMPORT_CONFIRMATION,
        },
        expectedStatus: 201,
      });
      invariant(
        importPrepared.sourceState === "PREPARED" &&
          Number.isSafeInteger(importPrepared.sourceRequestId) &&
          /^[a-f0-9]{64}$/.test(importPrepared.sourcePayloadHash),
        "SMIRK did not prepare the assignment-bound reviewed import."
      );
      await httpJson({
        baseUrl: listening.baseUrl,
        pathname:
          `/api/prospecting/velvet-source/requests/` +
          `${importPrepared.sourceRequestId}/approve`,
        method: "POST",
        body: {
          payloadHash: importPrepared.sourcePayloadHash,
          confirmation:
            sourceContract.VELVET_LEAD_SOURCE_APPROVAL_CONFIRMATION,
          attestations: {
            noContactAuthorized: true,
            zeroSpendAuthorized: true,
          },
        },
        expectedStatus: 200,
      });
      const imported = await httpJson({
        baseUrl: listening.baseUrl,
        pathname:
          `/api/prospecting/velvet-source/requests/` +
          `${importPrepared.sourceRequestId}/dispatch`,
        method: "POST",
        body: {
          payloadHash: importPrepared.sourcePayloadHash,
          confirmation:
            sourceContract.VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION,
        },
        expectedStatus: 200,
      });
      invariant(
        imported.state === "COMPLETED" &&
          imported.importedCount === 10 &&
          imported.failedCount === 0,
        "SMIRK did not import all ten assignment-bound reviewed leads."
      );
      const sourceReceiptRows = await sql`
        SELECT remote_response
        FROM velvet_lead_source_requests
        WHERE id = ${importPrepared.sourceRequestId}
          AND workspace_id = 1
        LIMIT 1
      `;
      const sourceReceipt =
        sourceContract.velvetLeadSourceResponseSchema.parse(
          sourceReceiptRows[0]?.remote_response
        );
      invariant(
        sourceReceipt.acquisitionExperimentAssignment?.assignmentHash ===
          assignment.assignmentHash &&
          sourceReceipt.acquisitionExperimentAssignment.arm ===
            assignment.arm &&
          sourceReceipt.prospects.length === 10,
        "The Velvet batch response changed its frozen experiment attribution."
      );
      const importedExperimentRows = await sql`
        SELECT i.prospect_id, i.external_id
        FROM velvet_lead_source_request_items i
        JOIN prospect_leads l ON l.id = i.prospect_id
        JOIN prospecting_campaigns c ON c.id = l.campaign_id
        WHERE i.request_row_id = ${importPrepared.sourceRequestId}
          AND i.workspace_id = 1
          AND i.import_state IN ('IMPORTED', 'DUPLICATE')
          AND c.workspace_id = 1
        ORDER BY i.id ASC
      `;
      invariant(
        importedExperimentRows.length === 10 &&
          importedExperimentRows.every(
            (row: JsonRecord) =>
              Number(row.prospect_id) > 0 &&
              sourceReceipt.prospects.some(
                prospect => prospect.externalId === row.external_id
              )
          ),
        "The persisted SMIRK experiment cohort does not match the Velvet export."
      );
      for (const row of importedExperimentRows) {
        experimentLeads.push({
          arm: assignment.arm,
          smirkLeadId: Number(row.prospect_id),
          externalProspectId: String(row.external_id),
        });
      }
      experimentRuns.push({
        localDiscoveryId: Number(discoveryPrepared.id),
        remoteDiscoveryId: Number(discoveryDispatched.remoteDiscoveryId),
        requestId: localDiscoveryRequest.requestId,
        sourceRequestId: Number(importPrepared.sourceRequestId),
        arm: assignment.arm,
        slotOrdinal: assignment.slotOrdinal,
        assignmentHash: assignment.assignmentHash,
        importedCount: Number(imported.importedCount),
        providerRequests: Number(discoveryRefreshed.providerRequests),
      });
    }
    invariant(
      experimentRuns.length === 4 &&
        experimentLeads.length === 40 &&
        new Set(experimentRuns.map(run => run.slotOrdinal)).size === 4 &&
        experimentRuns.filter(run => run.arm === "control").length === 2 &&
        experimentRuns.filter(run => run.arm === "challenger").length === 2 &&
        experimentLeads.filter(lead => lead.arm === "control").length === 20 &&
        experimentLeads.filter(lead => lead.arm === "challenger").length === 20,
      "The persisted experiment cohort is not exactly balanced."
    );

    const assignedExperiment =
      acquisitionExperimentContract.velvetAcquisitionSourcingActiveResponseSchema.parse(
        await httpJson({
          baseUrl: listening.baseUrl,
          pathname: "/api/prospecting/velvet-discovery/active-experiment",
          expectedStatus: 200,
        })
      );
    invariant(
      assignedExperiment.state === "ACTIVE" &&
        assignedExperiment.experiment?.assignedRequests === 4,
      "Velvet did not report all four frozen slots as assigned."
    );
    const closeRequest = {
      definitionHash: velvetFixture.ready.experimentDefinitionHash,
      confirmation: "close-synthetic-experiment-v1",
    };
    const incompleteExperiment = await httpJson({
      baseUrl: velvetFixtureBaseUrl,
      pathname:
        `/__fixture/experiments/${velvetFixture.ready.experimentId}/close`,
      method: "POST",
      headers: { "x-fixture-token": fixtureControlToken },
      body: closeRequest,
      expectedStatus: 412,
    });
    invariant(
      incompleteExperiment.code === "OUTCOME_COVERAGE_INCOMPLETE",
      "The experiment evaluator accepted attrited outcome coverage."
    );

    const syntheticExperimentOutcomePayloads: JsonRecord[] = [];
    for (let index = 0; index < experimentLeads.length; index += 1) {
      const lead = experimentLeads[index];
      const outcome = lead.arm === "challenger" ? "replied" : "delivered";
      const payload = outcomeContract.buildVelvetOutcomePayload({
        workspaceId: 1,
        externalProspectId: lead.externalProspectId,
        externalEventId: `synthetic-experiment-${index + 1}-${runId}`,
        outreachApprovalId: randomUUID(),
        channel: "email",
        outcome,
        occurredAt: new Date(Date.now() + index).toISOString(),
        evidenceHash: createHash("sha256")
          .update(`synthetic-evidence-${index}-${runId}`)
          .digest("hex"),
        outreachPayloadHash: createHash("sha256")
          .update(`synthetic-outreach-${index}-${runId}`)
          .digest("hex"),
        notes: "Synthetic frozen-cohort outcome; no external contact occurred.",
      });
      const result = await outcomeContract.dispatchVelvetOutcome(
        payload,
        outcomeConfig,
        guardedIntegrationFetch,
        new Date()
      );
      invariant(
        result.success && result.state === "RECORDED",
        `Velvet did not record synthetic experiment outcome ${index + 1}.`
      );
      syntheticExperimentOutcomePayloads.push(payload);
    }
    const syntheticExperimentOutcomeReplay =
      await outcomeContract.dispatchVelvetOutcome(
        outcomeContract.velvetOutcomePayloadSchema.parse(
          syntheticExperimentOutcomePayloads[0]
        ),
        outcomeConfig,
        guardedIntegrationFetch,
        new Date()
      );
    invariant(
      syntheticExperimentOutcomeReplay.success &&
        syntheticExperimentOutcomeReplay.state === "DUPLICATE",
      "The signed synthetic experiment outcome replay was not idempotent."
    );

    const closedExperiment = await httpJson({
      baseUrl: velvetFixtureBaseUrl,
      pathname:
        `/__fixture/experiments/${velvetFixture.ready.experimentId}/close`,
      method: "POST",
      headers: { "x-fixture-token": fixtureControlToken },
      body: closeRequest,
      expectedStatus: 200,
    });
    invariant(
      closedExperiment.experiment?.state === "CLOSED" &&
        closedExperiment.experiment?.result?.status ===
          "RECOMMENDATION_READY" &&
        closedExperiment.experiment?.result?.code === "READY" &&
        closedExperiment.experiment?.result?.winner === "challenger" &&
        closedExperiment.experiment?.result?.coverage?.measuredLeads === 40 &&
        closedExperiment.experiment?.result?.coverage?.control?.positive === 0 &&
        closedExperiment.experiment?.result?.coverage?.challenger?.positive === 20 &&
        closedExperiment.experiment?.result?.proposal?.value === "hvac" &&
        closedExperiment.candidateCreated === false &&
        closedExperiment.policyChanged === false &&
        closedExperiment.contactActionAllowed === false &&
        closedExperiment.spendAuthorized === false &&
        closedExperiment.externalAction === "evaluation_recorded_only",
      "The persisted experiment did not close as a recommendation-only result."
    );

    const candidateProposalRequest = {
      definitionHash: velvetFixture.ready.experimentDefinitionHash,
      resultHash: closedExperiment.experiment.result.resultHash,
      confirmation: "propose-one-closed-acquisition-sourcing-candidate-v1",
      attestRecommendationReviewed: true,
      attestNoAutomaticPolicyChange: true,
    };
    const proposedCandidate = await httpJson({
      baseUrl: velvetFixtureBaseUrl,
      pathname:
        `/__fixture/experiments/${velvetFixture.ready.experimentId}` +
        "/propose-candidate",
      method: "POST",
      headers: { "x-fixture-token": fixtureControlToken },
      body: candidateProposalRequest,
      expectedStatus: 200,
    });
    invariant(
      proposedCandidate.outcome === "created" &&
        Number.isSafeInteger(proposedCandidate.candidate?.id) &&
        proposedCandidate.candidate.id > 0 &&
        proposedCandidate.candidate.state === "CANDIDATE" &&
        proposedCandidate.candidate.proposal?.value === "hvac" &&
        proposedCandidate.candidate.evidence?.studyDesign ===
          "deterministic-balanced-source-allocation-v1" &&
        /^[a-f0-9]{64}$/.test(proposedCandidate.candidate.proposalHash) &&
        /^[a-f0-9]{64}$/.test(proposedCandidate.candidate.evidenceHash) &&
        proposedCandidate.policyChanged === false &&
        proposedCandidate.contactActionAllowed === false &&
        proposedCandidate.spendAuthorized === false,
      "The exact reviewed recommendation was not proposed as a guarded candidate."
    );
    const proposedCandidateReplay = await httpJson({
      baseUrl: velvetFixtureBaseUrl,
      pathname:
        `/__fixture/experiments/${velvetFixture.ready.experimentId}` +
        "/propose-candidate",
      method: "POST",
      headers: { "x-fixture-token": fixtureControlToken },
      body: candidateProposalRequest,
      expectedStatus: 200,
    });
    invariant(
      proposedCandidateReplay.outcome === "duplicate" &&
        proposedCandidateReplay.candidate?.id ===
          proposedCandidate.candidate.id,
      "The exact candidate proposal replay was not idempotent."
    );

    const learningReleaseId = randomUUID();
    const candidateReleaseRequest = {
      releaseId: learningReleaseId,
      proposalHash: proposedCandidate.candidate.proposalHash,
      evidenceHash: proposedCandidate.candidate.evidenceHash,
      confirmation: "release-one-approved-acquisition-candidate-v1",
      attestations: {
        evidenceReviewed: true,
        observationalNotCausal: true,
        noContactOrSpendApproved: true,
      },
      reason:
        "Synthetic cross-system proof of a future research-only policy release.",
    };
    const releaseBeforeApproval = await httpJson({
      baseUrl: velvetFixtureBaseUrl,
      pathname:
        `/__fixture/learning-candidates/${proposedCandidate.candidate.id}` +
        "/release",
      method: "POST",
      headers: { "x-fixture-token": fixtureControlToken },
      body: candidateReleaseRequest,
      expectedStatus: 412,
    });
    invariant(
      releaseBeforeApproval.code === "PRECONDITION_FAILED",
      "Velvet released a sourcing candidate before the separate human decision."
    );
    const candidateDecision = await httpJson({
      baseUrl: velvetFixtureBaseUrl,
      pathname:
        `/__fixture/learning-candidates/${proposedCandidate.candidate.id}` +
        "/decide",
      method: "POST",
      headers: { "x-fixture-token": fixtureControlToken },
      body: { decision: "APPROVED" },
      expectedStatus: 200,
    });
    invariant(
      candidateDecision.id === proposedCandidate.candidate.id &&
        candidateDecision.state === "APPROVED" &&
        candidateDecision.policyChanged === false &&
        candidateDecision.externalAction === "none",
      "The separate candidate approval did not remain evidence-only."
    );
    const releasedCandidate = await httpJson({
      baseUrl: velvetFixtureBaseUrl,
      pathname:
        `/__fixture/learning-candidates/${proposedCandidate.candidate.id}` +
        "/release",
      method: "POST",
      headers: { "x-fixture-token": fixtureControlToken },
      body: candidateReleaseRequest,
      expectedStatus: 200,
    });
    invariant(
      releasedCandidate.outcome === "released" &&
        releasedCandidate.receipt?.releaseId === learningReleaseId &&
        releasedCandidate.receipt?.activeCandidate?.id ===
          proposedCandidate.candidate.id &&
        releasedCandidate.receipt?.activeCandidate?.proposalHash ===
          proposedCandidate.candidate.proposalHash &&
        releasedCandidate.receipt?.activeCandidate?.evidenceHash ===
          proposedCandidate.candidate.evidenceHash &&
        releasedCandidate.receipt?.controls
          ?.affectsFutureResearchCriteriaOnly === true &&
        releasedCandidate.receipt?.controls?.existingBatchesChanged === false &&
        releasedCandidate.policyChanged === true &&
        releasedCandidate.contactAuthorized === false &&
        releasedCandidate.providerExecutionAuthorized === false &&
        releasedCandidate.spendAuthorized === false &&
        releasedCandidate.externalAction === "none",
      "The approved candidate was not released as an exact research-only policy receipt."
    );
    const releasedCandidateReplay = await httpJson({
      baseUrl: velvetFixtureBaseUrl,
      pathname:
        `/__fixture/learning-candidates/${proposedCandidate.candidate.id}` +
        "/release",
      method: "POST",
      headers: { "x-fixture-token": fixtureControlToken },
      body: candidateReleaseRequest,
      expectedStatus: 200,
    });
    invariant(
      releasedCandidateReplay.outcome === "duplicate" &&
        releasedCandidateReplay.receipt?.receiptHash ===
          releasedCandidate.receipt.receiptHash &&
        releasedCandidateReplay.policyChanged === false,
      "The exact acquisition policy release replay was not idempotent."
    );

    const learnedDiscoveryRequestId = `smirk-learned-${runId}`;
    const learnedDiscoveryRequest = {
      contractVersion: "smirk-velvet.discovery-request.v2",
      requestId: learnedDiscoveryRequestId,
      workspaceId: 1,
      criteria: {
        limit: 10,
        city: "Reno",
        state: "NV",
        learningMode: "latest_released",
      },
      contactActionAllowed: false,
      spendAuthorized: false,
    };
    const prepareLearnedDiscovery = () =>
      guardedIntegrationFetch(
        `${productionVelvetOrigin}/api/v1/smirk/discovery-requests`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${sourceApiKey}`,
            "idempotency-key": learnedDiscoveryRequestId,
          },
          body: JSON.stringify(learnedDiscoveryRequest),
        }
      );
    const learnedDiscoveryResponse = await prepareLearnedDiscovery();
    const learnedDiscovery = await readJsonResponse(learnedDiscoveryResponse);
    invariant(
      learnedDiscoveryResponse.status === 201 &&
        learnedDiscovery.state === "PREPARED" &&
        learnedDiscovery.currentState === "PREPARED" &&
        learnedDiscovery.requestId === learnedDiscoveryRequestId &&
        learnedDiscovery.effectiveCriteria?.category === "hvac" &&
        learnedDiscovery.effectiveCriteria?.city === "Reno" &&
        learnedDiscovery.effectiveCriteria?.state === "NV" &&
        learnedDiscovery.appliedLearningCandidate?.id ===
          proposedCandidate.candidate.id &&
        learnedDiscovery.approvalRequired === true &&
        learnedDiscovery.executionStarted === false &&
        learnedDiscovery.contactActionAllowed === false &&
        learnedDiscovery.spendAuthorized === false &&
        learnedDiscovery.externalAction === "discovery_approval_required",
      `The released sourcing policy did not constrain a future prepared request: ${JSON.stringify(
        learnedDiscovery
      ).slice(0, 1_500)}`
    );
    const learnedDiscoveryReplayResponse = await prepareLearnedDiscovery();
    const learnedDiscoveryReplay = await readJsonResponse(
      learnedDiscoveryReplayResponse
    );
    invariant(
      learnedDiscoveryReplayResponse.status === 200 &&
        learnedDiscoveryReplay.state === "DUPLICATE" &&
        learnedDiscoveryReplay.discoveryId === learnedDiscovery.discoveryId &&
        learnedDiscoveryReplay.requestPayloadHash ===
          learnedDiscovery.requestPayloadHash &&
        learnedDiscoveryReplay.executionStarted === false,
      "The future learned discovery request replay was not idempotent."
    );

    const experimentCampaignRows = await sql<{
      campaign_id: number;
      lead_count: number;
      campaign_external_id: string | null;
    }[]>`
      SELECT l.campaign_id,
             COUNT(*)::int AS lead_count,
             c.external_id AS campaign_external_id
      FROM prospect_leads l
      JOIN prospecting_campaigns c
        ON c.id = l.campaign_id
       AND c.workspace_id = 1
      WHERE l.id IN ${sql(experimentLeads.map(lead => lead.smirkLeadId))}
      GROUP BY l.campaign_id, c.external_id
      ORDER BY l.campaign_id ASC
    `;
    const experimentCampaign = experimentCampaignRows[0];
    invariant(
      experimentCampaignRows.length === 1 &&
        experimentCampaign.lead_count === 40 &&
        experimentCampaign.campaign_external_id ===
          `velvet-acquisition-experiment-${velvetFixture.ready.experimentId}`,
      `Velvet sourcing arms did not converge on one durable SMIRK campaign: ${JSON.stringify(
        experimentCampaignRows
      )}`
    );

    for (const lead of experimentLeads) {
      const reviewed = await httpJson({
        baseUrl: listening.baseUrl,
        pathname: `/api/prospecting/leads/${lead.smirkLeadId}/review`,
        method: "PATCH",
        body: {
          decision: "qualified",
          notes:
            "Synthetic operator qualification for the disposable linked-loop proof.",
        },
        expectedStatus: 200,
      });
      invariant(
        reviewed.reviewState === "qualified" &&
          reviewed.externalAction === "none",
        "A Velvet-sourced lead was not operator-qualified without external action."
      );
    }

    const messageExperimentPrepared = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/learning/experiments",
      method: "POST",
      body: {
        campaignId: experimentCampaign.campaign_id,
        channel: "call",
        controlVariantKey: "manual-owner-call-v1",
        challengerVariantKey: "manual-owner-call-v2",
        cohortSize: 20,
      },
      expectedStatus: 201,
    });
    const messageExperimentDefinition =
      messageExperimentContract.prospectMessageExperimentDefinitionSchema.parse(
        messageExperimentPrepared.definition
      );
    invariant(
      messageExperimentDefinition.contractVersion ===
        messageExperimentContract
          .PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION,
      "The Velvet-fed message experiment did not freeze its eligible cohort."
    );
    invariant(
      messageExperimentPrepared.state === "PREPARED" &&
        messageExperimentDefinition.campaignId ===
          experimentCampaign.campaign_id &&
        messageExperimentDefinition.channel === "call" &&
        messageExperimentDefinition.cohort.length === 20 &&
        messageExperimentDefinition.cohort.filter(
          entry => entry.arm === "control"
        ).length === 10 &&
        messageExperimentDefinition.cohort.filter(
          entry => entry.arm === "challenger"
        ).length === 10 &&
        /^[a-f0-9]{64}$/.test(
          messageExperimentPrepared.definitionHash
        ),
      "The Velvet-fed message experiment was not a frozen balanced cohort."
    );
    const messageExperimentActivated = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/learning/experiments/` +
        `${messageExperimentDefinition.experimentId}/activate`,
      method: "POST",
      body: {
        definitionHash: messageExperimentPrepared.definitionHash,
        confirmation:
          messageExperimentContract
            .PROSPECT_MESSAGE_EXPERIMENT_ACTIVATION_CONFIRMATION,
        attestations: {
          registeredContentReviewed: true,
          deterministicAssignmentReviewed: true,
          noContactOrSpendAuthorized: true,
        },
      },
      expectedStatus: 200,
    });
    invariant(
      messageExperimentActivated.state === "ACTIVE" &&
        messageExperimentActivated.externalAction === "none",
      "The reviewed message experiment was not activated safely."
    );
    const messageDraftRequest = {
      channel: "call",
      definitionHash: messageExperimentPrepared.definitionHash,
      confirmation:
        messageExperimentContract
          .PROSPECT_MESSAGE_EXPERIMENT_PREPARE_DRAFTS_CONFIRMATION,
      maxCostCents: 1,
      expiresInHours: 8,
      attestations: {
        frozenCohortReviewed: true,
        recipientApprovalStillRequired: true,
        noContactOrSpendAuthorized: true,
      },
    };
    const messageDraftsPrepared = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/learning/experiments/` +
        `${messageExperimentDefinition.experimentId}/prepare-drafts`,
      method: "POST",
      body: messageDraftRequest,
      expectedStatus: 201,
    });
    const messageDraftsReplay = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/learning/experiments/` +
        `${messageExperimentDefinition.experimentId}/prepare-drafts`,
      method: "POST",
      body: messageDraftRequest,
      expectedStatus: 200,
    });
    invariant(
      messageDraftsPrepared.selectedCount === 20 &&
        messageDraftsPrepared.createdCount === 20 &&
        messageDraftsPrepared.pendingHumanReview === 20 &&
        messageDraftsPrepared.contactAuthorized === false &&
        messageDraftsPrepared.executionAuthorized === false &&
        messageDraftsPrepared.spendAuthorized === false &&
        messageDraftsReplay.outcome === "duplicate" &&
        messageDraftsReplay.createdCount === 0 &&
        messageDraftsReplay.duplicateCount === 20,
      "The frozen message cohort did not feed an idempotent review-only draft queue."
    );

    const messageJobRows = await sql<{
      id: number;
      approval_id: string;
      lead_id: number;
      state: string;
      variant_key: string;
      payload: unknown;
      payload_hash: string;
    }[]>`
      SELECT id, approval_id, lead_id, state, variant_key,
             payload, payload_hash
      FROM prospect_outreach_jobs
      WHERE workspace_id = 1
        AND payload->'experimentAssignment'->>'experimentId'
          = ${messageExperimentDefinition.experimentId}
      ORDER BY lead_id ASC
    `;
    const messageJobs = messageJobRows.map(row => ({
      ...row,
      payload: outreachContract.prospectOutreachPayloadSchema.parse(
        typeof row.payload === "string"
          ? JSON.parse(row.payload)
          : row.payload
      ),
    }));
    invariant(
      messageJobs.length === 20 &&
        messageJobs.every(
          job =>
            job.state === "PREPARED" &&
            job.payload.channel === "call" &&
            job.payload.experimentAssignment?.protocolCompliant === true &&
            job.payload.controls.providerExecution === "disabled" &&
            job.payload.controls.smsAllowed === false
        ),
      "The message experiment enrolled a changed or executable call payload."
    );
    const messageJobFingerprints = new Map(
      messageJobs.map(job => [
        job.id,
        `${job.payload_hash}:${job.variant_key}`,
      ])
    );
    const syntheticMessageSentAt = new Date(
      Date.now() - 4 * 24 * 60 * 60_000
    ).toISOString();
    const syntheticMessageOutcomeAt = new Date(
      new Date(syntheticMessageSentAt).getTime() + 60_000
    ).toISOString();
    const terminalizedMessageRows = await sql<{ id: number }[]>`
      UPDATE prospect_outreach_jobs
      SET state = 'SENT', sent_at = ${syntheticMessageSentAt},
          updated_at = NOW()
      WHERE workspace_id = 1
        AND payload->'experimentAssignment'->>'experimentId'
          = ${messageExperimentDefinition.experimentId}
        AND state = 'PREPARED'
      RETURNING id
    `;
    invariant(
      terminalizedMessageRows.length === 20,
      "The disposable message cohort did not become a complete synthetic historical sample."
    );

    const messageOutcomeExternalIds: string[] = [];
    for (const job of messageJobs) {
      const assignment = job.payload.experimentAssignment;
      invariant(
        assignment && assignment.protocolCompliant,
        "A synthetic message outcome lost its immutable assignment."
      );
      const outcome =
        assignment.arm === "challenger" ? "qualified" : "no_answer";
      const externalEventId = `synthetic-message-${job.id}-${runId}`;
      const recorded = await httpJson({
        baseUrl: listening.baseUrl,
        pathname: `/api/prospecting/leads/${job.lead_id}/outcomes`,
        method: "POST",
        body: {
          externalEventId,
          outreachApprovalId: job.approval_id,
          outcome,
          occurredAt: syntheticMessageOutcomeAt,
          notes:
            "Synthetic deterministic message-cohort outcome; no external call occurred.",
        },
        expectedStatus: 201,
      });
      invariant(
        recorded.outcome === "recorded" &&
          recorded.externalAction === "none",
        "A synthetic message outcome was not durably recorded."
      );
      messageOutcomeExternalIds.push(externalEventId);
    }

    const pendingMessageReviews = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/positive-outcomes?state=pending",
      expectedStatus: 200,
    });
    invariant(
      pendingMessageReviews.reviews?.length === 10 &&
        pendingMessageReviews.reviews.every(
          (review: JsonRecord) =>
            review.payload?.outcome === "qualified" &&
            review.payload?.channel === "call"
        ),
      "The challenger outcomes did not pause as ten exact human-review items."
    );
    for (const review of pendingMessageReviews.reviews) {
      const acknowledged = await httpJson({
        baseUrl: listening.baseUrl,
        pathname:
          `/api/prospecting/positive-outcomes/` +
          `${review.reviewId}/acknowledge`,
        method: "POST",
        body: {
          payloadHash: review.payloadHash,
          confirmation:
            positiveOutcomeReviewContract
              .PROSPECT_POSITIVE_OUTCOME_ACKNOWLEDGMENT_CONFIRMATION,
          resolution: "continue_guarded_loop",
          notes:
            "Synthetic message experiment evidence reviewed; no follow-up authorized.",
          attestations: {
            interactionReviewed: true,
            noContactExecutedByAcknowledgment: true,
            followUpRemainsSeparate: true,
          },
        },
        expectedStatus: 201,
      });
      invariant(
        acknowledged.reviewState === "ACKNOWLEDGED" &&
          acknowledged.externalAction === "none",
        "A synthetic positive message outcome was not safely acknowledged."
      );
    }

    const messageOutboxRows = await sql<{
      id: number;
      payload_hash: string;
    }[]>`
      SELECT o.id, o.payload_hash
      FROM velvet_outcome_outbox o
      JOIN prospect_outcome_events e
        ON e.id = o.outcome_event_id
       AND e.workspace_id = o.workspace_id
      JOIN prospect_outreach_jobs j
        ON j.id = e.outreach_job_id
       AND j.workspace_id = e.workspace_id
      WHERE o.workspace_id = 1
        AND o.state = 'PREPARED'
        AND j.payload->'experimentAssignment'->>'experimentId'
          = ${messageExperimentDefinition.experimentId}
      ORDER BY o.id ASC
    `;
    invariant(
      messageOutboxRows.length === 20,
      "The message cohort did not prepare twenty exact Velvet feedback receipts."
    );
    for (const event of messageOutboxRows) {
      const dispatched = await httpJson({
        baseUrl: listening.baseUrl,
        pathname: `/api/prospecting/velvet-outcomes/${event.id}/dispatch`,
        method: "POST",
        body: {
          payloadHash: event.payload_hash,
          confirmation:
            outcomeContract.VELVET_OUTCOME_DISPATCH_CONFIRMATION,
        },
        expectedStatus: 200,
      });
      invariant(
        dispatched.outcome === "dispatched" &&
          dispatched.remoteState === "RECORDED",
        "A synthetic message outcome did not complete the Velvet feedback loop."
      );
    }

    const messageExperimentClosed = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/learning/experiments/` +
        `${messageExperimentDefinition.experimentId}/close`,
      method: "POST",
      body: {
        definitionHash: messageExperimentPrepared.definitionHash,
        confirmation:
          messageExperimentContract
            .PROSPECT_MESSAGE_EXPERIMENT_CLOSE_CONFIRMATION,
        attestations: {
          enrollmentStopped: true,
          allJobsTerminal: true,
          outcomeWindowReviewed: true,
        },
      },
      expectedStatus: 200,
    });
    invariant(
      messageExperimentClosed.state === "CLOSED" &&
        messageExperimentClosed.observationWindow?.channel === "call" &&
        messageExperimentClosed.observationWindow?.sentJobCount === 20 &&
        messageExperimentClosed.observationWindow?.measuredSentJobCount ===
          20 &&
        messageExperimentClosed.policyChanged === false &&
        messageExperimentClosed.externalAction === "none",
      "The linked message experiment did not close on complete measured evidence."
    );

    const messageCandidate = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/learning/candidates",
      method: "POST",
      body: {
        experimentId: messageExperimentDefinition.experimentId,
      },
      expectedStatus: 201,
    });
    const messageCandidateReplay = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/learning/candidates",
      method: "POST",
      body: {
        experimentId: messageExperimentDefinition.experimentId,
      },
      expectedStatus: 200,
    });
    invariant(
      messageCandidate.outcome === "created" &&
        messageCandidate.state === "CANDIDATE" &&
        messageCandidate.sampleSize === 20 &&
        messageCandidate.armStats?.control?.measured === 10 &&
        messageCandidate.armStats?.challenger?.measured === 10 &&
        messageCandidate.policyChanged === false &&
        messageCandidate.externalAction === "none" &&
        messageCandidateReplay.outcome === "duplicate" &&
        messageCandidateReplay.id === messageCandidate.id,
      "Complete assigned-cohort evidence did not produce one inert message candidate."
    );
    const messageReleaseBeforeApproval = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/learning/candidates/` +
        `${messageCandidate.id}/apply-policy`,
      method: "POST",
      body: {
        proposalHash: "0".repeat(64),
        confirmation:
          messagePolicyContract
            .PROSPECT_MESSAGE_POLICY_APPLY_CONFIRMATION,
        attestations: {
          approvedCandidateReviewed: true,
          measuredEvidenceReviewed: true,
          futureExperimentsOnly: true,
          noContactOrSpendAuthorized: true,
        },
      },
      expectedStatus: 409,
    });
    invariant(
      messageReleaseBeforeApproval.code ===
        "PROSPECT_MESSAGE_POLICY_CANDIDATE_NOT_APPROVED",
      "A message candidate changed policy before the separate operator decision."
    );
    const messageCandidateDecision = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/learning/candidates/` +
        `${messageCandidate.id}/decision`,
      method: "POST",
      body: { decision: "APPROVED" },
      expectedStatus: 200,
    });
    invariant(
      messageCandidateDecision.state === "APPROVED" &&
        messageCandidateDecision.policyChanged === false &&
        messageCandidateDecision.externalAction === "none",
      "The message candidate decision changed runtime policy by itself."
    );
    const messageCandidateList = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/learning/candidates",
      expectedStatus: 200,
    });
    const approvedMessageCandidate = messageCandidateList.candidates?.find(
      (candidate: JsonRecord) => candidate.id === messageCandidate.id
    );
    invariant(
      approvedMessageCandidate?.state === "APPROVED" &&
        approvedMessageCandidate?.recommendation_eligible === true &&
        /^[a-f0-9]{64}$/.test(
          String(approvedMessageCandidate?.proposal_hash || "")
        ),
      "The approved message candidate did not expose its exact reviewed proposal hash."
    );
    const messagePolicyRequest = {
      proposalHash: approvedMessageCandidate.proposal_hash,
      confirmation:
        messagePolicyContract
          .PROSPECT_MESSAGE_POLICY_APPLY_CONFIRMATION,
      attestations: {
        approvedCandidateReviewed: true,
        measuredEvidenceReviewed: true,
        futureExperimentsOnly: true,
        noContactOrSpendAuthorized: true,
      },
    };
    const messagePolicyReleased = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/learning/candidates/` +
        `${messageCandidate.id}/apply-policy`,
      method: "POST",
      body: messagePolicyRequest,
      expectedStatus: 201,
    });
    const messagePolicyReplay = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/learning/candidates/` +
        `${messageCandidate.id}/apply-policy`,
      method: "POST",
      body: messagePolicyRequest,
      expectedStatus: 200,
    });
    invariant(
      messagePolicyReleased.outcome === "applied" &&
        messagePolicyReleased.release?.action === "PROMOTE" &&
        messagePolicyReleased.release?.championVariantKey ===
          "manual-owner-call-v2" &&
        messagePolicyReleased.release?.controls
          ?.nextExperimentControlOnly === true &&
        messagePolicyReleased.existingJobsChanged === false &&
        messagePolicyReleased.contactAuthorized === false &&
        messagePolicyReleased.executionAuthorized === false &&
        messagePolicyReleased.spendAuthorized === false &&
        messagePolicyReplay.outcome === "duplicate" &&
        messagePolicyReplay.release?.releaseId ===
          messagePolicyReleased.release.releaseId,
      "The approved message winner was not released as one future-experiment-only policy."
    );
    const postReleaseMessageJobs = await sql<{
      id: number;
      payload_hash: string;
      variant_key: string;
    }[]>`
      SELECT id, payload_hash, variant_key
      FROM prospect_outreach_jobs
      WHERE workspace_id = 1
        AND payload->'experimentAssignment'->>'experimentId'
          = ${messageExperimentDefinition.experimentId}
      ORDER BY id ASC
    `;
    invariant(
      postReleaseMessageJobs.length === 20 &&
        postReleaseMessageJobs.every(
          job =>
            messageJobFingerprints.get(job.id) ===
            `${job.payload_hash}:${job.variant_key}`
        ),
      "A message-policy release changed an existing outreach job."
    );

    const wrongMessageControl = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/learning/experiments",
      method: "POST",
      body: {
        campaignId: experimentCampaign.campaign_id,
        channel: "call",
        controlVariantKey: "manual-owner-call-v1",
        challengerVariantKey: "manual-owner-call-v2",
        cohortSize: 20,
      },
      expectedStatus: 409,
    });
    invariant(
      wrongMessageControl.code ===
        "PROSPECT_MESSAGE_POLICY_CONTROL_REQUIRED",
      "A future experiment ignored the exact released message champion."
    );
    const nextMessageExperimentPrepared = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/learning/experiments",
      method: "POST",
      body: {
        campaignId: experimentCampaign.campaign_id,
        channel: "call",
        controlVariantKey: "manual-owner-call-v2",
        challengerVariantKey: "manual-owner-call-v1",
        cohortSize: 20,
      },
      expectedStatus: 201,
    });
    const nextMessageDefinition =
      messageExperimentContract.prospectMessageExperimentDefinitionSchema.parse(
        nextMessageExperimentPrepared.definition
      );
    invariant(
      nextMessageDefinition.contractVersion ===
        messageExperimentContract
          .PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION,
      "The next message experiment did not freeze a policy-bound cohort."
    );
    invariant(
      nextMessageDefinition.controlVariantKey ===
        "manual-owner-call-v2" &&
        nextMessageDefinition.cohort.length === 20 &&
        nextMessageDefinition.appliedPolicy?.releaseId ===
          messagePolicyReleased.release.releaseId &&
        nextMessageDefinition.appliedPolicy?.releaseHash ===
          messagePolicyReleased.releaseHash &&
        nextMessageDefinition.appliedPolicy?.championVariantKey ===
          "manual-owner-call-v2" &&
        nextMessageExperimentPrepared.state === "PREPARED" &&
        nextMessageExperimentPrepared.policyChanged === false &&
        nextMessageExperimentPrepared.externalAction === "none",
      "The released message winner did not bind only the next untouched cohort."
    );

    const inboxPlacementPrepared = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/inbox-placement",
      method: "POST",
      body: {
        campaignId: experimentCampaign.campaign_id,
        controlVariantKey: "micro-after-hours-v1",
        challengerVariantKey: "micro-urgent-workflow-v1",
        mailboxes: controlledInboxMailboxes.map(mailbox => ({
          ...mailbox,
        })),
        emailCompliance: syntheticEmailCompliance,
        maxCostCents: 1,
        expiresInHours: 72,
        confirmation:
          inboxPlacementContract
            .PROSPECT_INBOX_PLACEMENT_PREPARE_CONFIRMATION,
        attestations: {
          controlledMailboxesOnly: true,
          mailboxAccessVerified: true,
          noRealProspectsIncluded: true,
          noContactOrSpendAuthorized: true,
        },
      },
      expectedStatus: 201,
    });
    invariant(
      inboxPlacementPrepared.state === "PREPARED" &&
        inboxPlacementPrepared.items?.length === 5 &&
        inboxPlacementPrepared.externalAction === "none" &&
        inboxPlacementPrepared.spendAuthorized === false &&
        Number(network.emailProviderAdapterRequests) === 1,
      "The Velvet-bound campaign did not prepare five inert controlled inbox seeds."
    );

    const controlledSeedReceipts: Array<{
      approvalId: string;
      providerMessageId: string;
      inspectionOutcome: string;
    }> = [];
    for (const [index, item] of inboxPlacementPrepared.items.entries()) {
      const qcReviewed = await httpJson({
        baseUrl: listening.baseUrl,
        pathname:
          `/api/prospecting/outreach/${item.approvalId}` +
          "/qc-model-review",
        method: "POST",
        body: {
          payloadHash: item.payloadHash,
          confirmation:
            qcModelProviderContract
              .PROSPECT_QC_MODEL_REVIEW_CONFIRMATION,
        },
        expectedStatus: 201,
      });
      invariant(
        qcReviewed.outcome === "reviewed" &&
          qcReviewed.receipt?.review?.status === "PASSED" &&
          qcReviewed.receipt?.humanApprovalRequired === true &&
          qcReviewed.receipt?.contactAuthorized === false &&
          qcReviewed.receipt?.executionAuthorized === false,
        "A controlled inbox seed did not receive one bounded advisory QC receipt."
      );
      const approved = await httpJson({
        baseUrl: listening.baseUrl,
        pathname:
          `/api/prospecting/outreach/${item.approvalId}/approve`,
        method: "POST",
        body: {
          payloadHash: item.payloadHash,
          attestations: {
            recipientReviewed: true,
            suppressionChecked: true,
            emailComplianceReviewed: true,
          },
        },
        expectedStatus: 200,
      });
      invariant(
        approved.state === "APPROVED" &&
          approved.qcModelReviewId === qcReviewed.reviewId,
        "A controlled inbox seed was not individually approved against its exact QC receipt."
      );
      const executed = await httpJson({
        baseUrl: listening.baseUrl,
        pathname:
          `/api/prospecting/outreach/${item.approvalId}/execute`,
        method: "POST",
        body: {
          payloadHash: item.payloadHash,
          confirmation:
            emailProviderContract
              .PROSPECT_EMAIL_EXECUTION_CONFIRMATION,
        },
        expectedStatus: 200,
      });
      invariant(
        executed.outcome === "accepted" &&
          executed.state === "SENT" &&
          executed.providerAccepted === true &&
          executed.delivered === false &&
          /^email_seed_\d+_cross-db-/.test(
            String(executed.providerMessageId || "")
          ),
        "An intercepted controlled inbox seed was not durably accepted one recipient at a time."
      );
      const inspectionRequest = {
        definitionHash: inboxPlacementPrepared.definitionHash,
        payloadHash: item.payloadHash,
        providerMessageId: executed.providerMessageId,
        inspectedAt: new Date().toISOString(),
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
        notes:
          "Synthetic disposable inspection against an intercepted provider response.",
        confirmation:
          inboxPlacementContract
            .PROSPECT_INBOX_PLACEMENT_INSPECTION_CONFIRMATION,
        attestations: {
          mailboxOpenedByOperator: true,
          folderLocationObserved: true,
          rawHeadersReviewed: true,
        },
      };
      const inspected = await httpJson({
        baseUrl: listening.baseUrl,
        pathname:
          `/api/prospecting/inbox-placement/` +
          `${inboxPlacementPrepared.testId}/items/` +
          `${item.approvalId}/inspect`,
        method: "POST",
        body: inspectionRequest,
        expectedStatus: 200,
      });
      invariant(
        inspected.outcome === "recorded" &&
          inspected.externalAction === "none",
        "A controlled inbox inspection was not durably recorded."
      );
      if (index === 0) {
        const inspectionReplay = await httpJson({
          baseUrl: listening.baseUrl,
          pathname:
            `/api/prospecting/inbox-placement/` +
            `${inboxPlacementPrepared.testId}/items/` +
            `${item.approvalId}/inspect`,
          method: "POST",
          body: inspectionRequest,
          expectedStatus: 200,
        });
        invariant(
          inspectionReplay.outcome === "duplicate",
          "An exact controlled inbox inspection replay was not idempotent."
        );
      }
      controlledSeedReceipts.push({
        approvalId: item.approvalId,
        providerMessageId: executed.providerMessageId,
        inspectionOutcome: inspected.outcome,
      });
    }
    invariant(
      controlledSeedReceipts.length === 5 &&
        new Set(
          controlledSeedReceipts.map(
            receipt => receipt.providerMessageId
          )
        ).size === 5 &&
        Number(network.emailProviderAdapterRequests) === 6 &&
        Number(network.qcProviderAdapterRequests) === 7,
      "The controlled five-inbox path was not exactly one recipient and one advisory receipt per seed."
    );

    const inboxPlacementFinalized = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/inbox-placement/` +
        `${inboxPlacementPrepared.testId}/finalize`,
      method: "POST",
      body: {
        definitionHash: inboxPlacementPrepared.definitionHash,
        confirmation:
          inboxPlacementContract
            .PROSPECT_INBOX_PLACEMENT_FINALIZE_CONFIRMATION,
        attestations: {
          allFiveMailboxesReviewed: true,
          rawHeadersReviewed: true,
          noRealProspectOutreach: true,
        },
      },
      expectedStatus: 200,
    });
    invariant(
      inboxPlacementFinalized.state === "PASSED" &&
        inboxPlacementFinalized.receipt
          ?.authorizesExperimentActivation === true &&
        inboxPlacementFinalized.receipt?.authorizesContact === false &&
        inboxPlacementFinalized.receipt?.authorizesSpend === false &&
        inboxPlacementFinalized.externalAction === "none",
      "Five exact synthetic inspections did not produce one inert inbox-placement PASS receipt."
    );

    const emailExperimentPrepared = await httpJson({
      baseUrl: listening.baseUrl,
      pathname: "/api/prospecting/learning/experiments",
      method: "POST",
      body: {
        campaignId: experimentCampaign.campaign_id,
        channel: "email",
        controlVariantKey: "micro-after-hours-v1",
        challengerVariantKey: "micro-urgent-workflow-v1",
        cohortSize: 20,
      },
      expectedStatus: 201,
    });
    const emailExperimentDefinition =
      messageExperimentContract.prospectMessageExperimentDefinitionSchema.parse(
        emailExperimentPrepared.definition
      );
    invariant(
      emailExperimentDefinition.contractVersion ===
        messageExperimentContract
          .PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION &&
        emailExperimentPrepared.state === "PREPARED" &&
        emailExperimentDefinition.campaignId ===
          experimentCampaign.campaign_id &&
        emailExperimentDefinition.channel === "email" &&
        emailExperimentDefinition.cohort.length === 20 &&
        emailExperimentDefinition.cohort.filter(
          entry => entry.arm === "control"
        ).length === 10 &&
        emailExperimentDefinition.cohort.filter(
          entry => entry.arm === "challenger"
        ).length === 10 &&
        emailExperimentPrepared.externalAction === "none" &&
        emailExperimentPrepared.policyChanged === false,
      "The Velvet-fed email experiment was not a frozen 10/10 cohort."
    );
    const emailExperimentActivated = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/learning/experiments/` +
        `${emailExperimentDefinition.experimentId}/activate`,
      method: "POST",
      body: {
        definitionHash: emailExperimentPrepared.definitionHash,
        confirmation:
          messageExperimentContract
            .PROSPECT_MESSAGE_EXPERIMENT_ACTIVATION_CONFIRMATION,
        attestations: {
          registeredContentReviewed: true,
          deterministicAssignmentReviewed: true,
          noContactOrSpendAuthorized: true,
        },
      },
      expectedStatus: 200,
    });
    invariant(
      emailExperimentActivated.state === "ACTIVE" &&
        emailExperimentActivated.inboxPlacementTestId ===
          inboxPlacementPrepared.testId &&
        emailExperimentActivated.externalAction === "none",
      "The email cohort activated without the exact campaign-and-variant inbox receipt."
    );
    const emailExperimentDraftRequest = {
      channel: "email",
      definitionHash: emailExperimentPrepared.definitionHash,
      confirmation:
        messageExperimentContract
          .PROSPECT_MESSAGE_EXPERIMENT_PREPARE_DRAFTS_CONFIRMATION,
      emailCompliance: syntheticEmailCompliance,
      maxCostCents: 1,
      expiresInHours: 24,
      attestations: {
        frozenCohortReviewed: true,
        recipientApprovalStillRequired: true,
        noContactOrSpendAuthorized: true,
      },
    };
    const emailExperimentDraftsPrepared = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/learning/experiments/` +
        `${emailExperimentDefinition.experimentId}/prepare-drafts`,
      method: "POST",
      body: emailExperimentDraftRequest,
      expectedStatus: 201,
    });
    const emailExperimentDraftsReplay = await httpJson({
      baseUrl: listening.baseUrl,
      pathname:
        `/api/prospecting/learning/experiments/` +
        `${emailExperimentDefinition.experimentId}/prepare-drafts`,
      method: "POST",
      body: emailExperimentDraftRequest,
      expectedStatus: 200,
    });
    invariant(
      emailExperimentDraftsPrepared.selectedCount === 20 &&
        emailExperimentDraftsPrepared.createdCount === 20 &&
        emailExperimentDraftsPrepared.pendingHumanReview === 20 &&
        emailExperimentDraftsPrepared.contactAuthorized === false &&
        emailExperimentDraftsPrepared.executionAuthorized === false &&
        emailExperimentDraftsPrepared.spendAuthorized === false &&
        emailExperimentDraftsReplay.outcome === "duplicate" &&
        emailExperimentDraftsReplay.createdCount === 0 &&
        emailExperimentDraftsReplay.duplicateCount === 20,
      "The inbox-gated email cohort did not feed one idempotent review-only queue."
    );
    const linkedEmailJobRows = await sql<{
      state: string;
      variant_key: string;
      payload: unknown;
      is_seed: boolean;
    }[]>`
      SELECT state, variant_key, payload, is_seed
      FROM prospect_outreach_jobs
      WHERE workspace_id = 1
        AND payload->'experimentAssignment'->>'experimentId'
          = ${emailExperimentDefinition.experimentId}
      ORDER BY lead_id ASC
    `;
    const linkedEmailJobs = linkedEmailJobRows.map(row => ({
      ...row,
      payload: outreachContract.prospectOutreachPayloadSchema.parse(
        typeof row.payload === "string"
          ? JSON.parse(row.payload)
          : row.payload
      ),
    }));
    invariant(
      linkedEmailJobs.length === 20 &&
        linkedEmailJobs.every(
          job =>
            job.state === "PREPARED" &&
            job.is_seed === false &&
            job.payload.channel === "email" &&
            job.payload.experimentAssignment?.protocolCompliant === true &&
            job.payload.controls.providerExecution ===
              "operator-triggered-single-recipient" &&
            job.payload.controls.humanApprovalRequired === true &&
            job.payload.controls.smsAllowed === false &&
            job.payload.qcReceipt?.deterministicPassed === true &&
            job.payload.qcReceipt?.contactAuthorized === false &&
            job.payload.qcReceipt?.executionAuthorized === false
        ) &&
        new Set(linkedEmailJobs.map(job => job.variant_key)).size === 2,
      "The linked email cohort widened execution authority or lost exact attribution."
    );

    const velvetState = await httpJson({
      baseUrl: velvetFixtureBaseUrl,
      pathname: "/__fixture/state",
      headers: { "x-fixture-token": fixtureControlToken },
      expectedStatus: 200,
    });
    const velvetOutcomes = Array.isArray(velvetState.outcomes)
      ? velvetState.outcomes
      : [];
    const expectedOutcomeIds = new Set([
      outcomeEventId,
      providerOutcomeEventId(deliveredEventId),
      providerOutcomeEventId(replyEventId),
      ...syntheticExperimentOutcomePayloads.map(
        payload => payload.externalEventId
      ),
      ...messageOutcomeExternalIds,
    ]);
    const velvetExperimentDiscoveries = velvetState.discoveries?.filter(
      (discovery: JsonRecord) => discovery.experimentId !== null
    );
    const velvetLearnedDiscovery = velvetState.discoveries?.find(
      (discovery: JsonRecord) =>
        discovery.requestId === learnedDiscoveryRequestId
    );
    const persistedCandidate = velvetState.learningCandidates?.find(
      (candidate: JsonRecord) =>
        candidate.id === proposedCandidate.candidate.id
    );
    const persistedPolicyRelease = velvetState.policyReleases?.find(
      (release: JsonRecord) => release.releaseId === learningReleaseId
    );
    invariant(
      velvetState.mode === "smirk-cross-db-v1" &&
        velvetState.lead?.id === velvetFixture.ready.leadId &&
        velvetState.lead?.smirkCallOutcome === "replied" &&
        velvetState.lead?.smirkWorkspaceId === "1" &&
        velvetOutcomes.length === 63 &&
        velvetOutcomes.every((event: JsonRecord) =>
          expectedOutcomeIds.has(event.externalEventId)
        ) &&
        ["no_answer", "delivered", "replied"].every(outcome =>
          velvetOutcomes.some(
            (event: JsonRecord) => event.outcome === outcome
          )
        ) &&
        velvetState.batches?.length === 5 &&
        velvetState.batches.every(
          (batch: JsonRecord) => batch.state === "EXPORTED"
        ) &&
        velvetState.discoveries?.length === 6 &&
        velvetState.discoveries.filter(
          (discovery: JsonRecord) => discovery.state === "COMPLETED"
        ).length === 5 &&
        velvetLearnedDiscovery?.state === "PREPARED" &&
        velvetLearnedDiscovery?.providerRequests === 0 &&
        velvetLearnedDiscovery?.readyLeadCount === 0 &&
        velvetLearnedDiscovery?.learningCandidateId ===
          proposedCandidate.candidate.id &&
        velvetLearnedDiscovery?.experimentId === null &&
        velvetExperimentDiscoveries?.length === 4 &&
        new Set(
          velvetExperimentDiscoveries.map(
            (discovery: JsonRecord) => discovery.slotOrdinal
          )
        ).size === 4 &&
        velvetState.experiments?.length === 1 &&
        velvetState.experiments[0].experimentId ===
          velvetFixture.ready.experimentId &&
        velvetState.experiments[0].state === "CLOSED" &&
        velvetState.experiments[0].learningCandidateId ===
          proposedCandidate.candidate.id &&
        velvetState.experimentEvents?.length === 8 &&
        velvetState.experimentEvents.some(
          (event: JsonRecord) => event.action === "candidate_proposed"
        ) &&
        velvetState.learningCandidateCount === 1 &&
        persistedCandidate?.state === "APPROVED" &&
        persistedCandidate?.sampleSize === 40 &&
        velvetState.policyReleases?.length === 1 &&
        persistedPolicyRelease?.action === "APPLY" &&
        persistedPolicyRelease?.activeCandidateId ===
          proposedCandidate.candidate.id &&
        persistedPolicyRelease?.proposalHash ===
          proposedCandidate.candidate.proposalHash &&
        persistedPolicyRelease?.evidenceHash ===
          proposedCandidate.candidate.evidenceHash &&
        persistedPolicyRelease?.receiptHash ===
          releasedCandidate.receipt.receiptHash,
      `Velvet MySQL state does not match the SMIRK outcomes: ${JSON.stringify({
        lead: velvetState.lead,
        outcomes: velvetOutcomes,
        expectedOutcomeIds: Array.from(expectedOutcomeIds),
        batches: velvetState.batches,
        discoveries: velvetState.discoveries,
        experiments: velvetState.experiments,
        experimentEvents: velvetState.experimentEvents,
        learningCandidates: velvetState.learningCandidates,
        learningCandidateCount: velvetState.learningCandidateCount,
        policyReleases: velvetState.policyReleases,
      }).slice(0, 2_000)}`
    );

    const postgresProof = await sql`
      SELECT
        (SELECT COUNT(*)::int
           FROM velvet_discovery_requests
          WHERE workspace_id = 1) AS discovery_requests,
        (SELECT COUNT(*)::int
           FROM velvet_discovery_requests
          WHERE workspace_id = 1
            AND state = 'FAILED') AS failed_discovery_requests,
        (SELECT COUNT(*)::int
           FROM velvet_lead_source_requests
          WHERE workspace_id = 1) AS source_requests,
        (SELECT COUNT(*)::int
           FROM velvet_lead_source_request_items
          WHERE workspace_id = 1) AS source_items,
        (SELECT COUNT(*)::int
           FROM prospect_leads l
           JOIN prospecting_campaigns c ON c.id = l.campaign_id
          WHERE c.workspace_id = 1) AS leads,
        (SELECT COUNT(*)::int
           FROM prospect_outreach_jobs
          WHERE workspace_id = 1) AS outreach_jobs,
        (SELECT COUNT(*)::int
           FROM prospect_qc_model_reviews
          WHERE workspace_id = 1) AS qc_model_reviews,
        (SELECT COUNT(*)::int
           FROM prospect_qc_model_reviews
          WHERE workspace_id = 1
            AND state = 'COMPLETED') AS completed_qc_model_reviews,
        (SELECT COUNT(*)::int
           FROM prospect_outcome_events
          WHERE workspace_id = 1) AS outcome_events,
        (SELECT COUNT(*)::int
           FROM prospect_positive_outcome_reviews
          WHERE workspace_id = 1) AS positive_reviews,
        (SELECT COUNT(*)::int
           FROM prospect_positive_outcome_reviews
          WHERE workspace_id = 1
            AND state = 'PENDING') AS pending_positive_reviews,
        (SELECT COUNT(*)::int
           FROM prospect_positive_outcome_review_events
          WHERE workspace_id = 1) AS positive_review_events,
        (SELECT COUNT(*)::int
           FROM velvet_outcome_outbox
          WHERE workspace_id = 1) AS outbox_events,
        (SELECT COUNT(*)::int
           FROM prospect_outreach_jobs
          WHERE workspace_id = 1
            AND (
              provider_name IS NOT NULL OR
              provider_message_id IS NOT NULL
            )) AS provider_executions,
        (SELECT COUNT(*)::int
           FROM prospect_email_provider_events
          WHERE workspace_id = 1) AS email_provider_events
    `;
    const pg = postgresProof[0];
    invariant(
      pg.discovery_requests === 6 &&
        pg.failed_discovery_requests === 1 &&
        pg.source_requests === 5 &&
        pg.source_items === 41 &&
        pg.leads === 46 &&
        pg.outreach_jobs === 47 &&
        pg.qc_model_reviews === 7 &&
        pg.completed_qc_model_reviews === 7 &&
        pg.outcome_events === 23 &&
        pg.positive_reviews === 11 &&
        pg.pending_positive_reviews === 0 &&
        pg.positive_review_events === 22 &&
        pg.outbox_events === 23 &&
        pg.provider_executions === 6 &&
        pg.email_provider_events === 2,
      "SMIRK Postgres row counts are not exact."
    );
    const finalJobRows = await sql`
      SELECT j.approval_id, j.channel, j.state,
             j.execution_proof_reference, j.provider_name,
             j.provider_message_id,
             j.qc_model_review_id,
             j.qc_model_review_receipt_hash,
             j.payload->'qcReceipt'->>'verdict' AS qc_verdict,
             j.payload->'qcReceipt'->>'contactAuthorized'
               AS qc_contact_authorized,
             j.payload->'qcReceipt'->>'executionAuthorized'
               AS qc_execution_authorized
      FROM prospect_outreach_jobs j
      WHERE j.workspace_id = 1
        AND j.approval_id IN (
          ${outreachPrepared.approvalId},
          ${emailPrepared.approvalId}
        )
      ORDER BY j.channel ASC
    `;
    const finalCall = finalJobRows.find(
      (row: JsonRecord) =>
        row.approval_id === outreachPrepared.approvalId
    );
    const finalEmail = finalJobRows.find(
      (row: JsonRecord) =>
        row.approval_id === emailPrepared.approvalId
    );
    const finalQcModelReviewRows = await sql`
      SELECT review_id, outreach_job_id, state, provider, model,
             reserved_cost_cents, provider_reported_cost_usd,
             total_tokens, receipt, receipt_hash
      FROM prospect_qc_model_reviews
      WHERE workspace_id = 1
      ORDER BY requested_at ASC
    `;
    const finalQcReceipts = finalQcModelReviewRows.map(
      (row: JsonRecord) => {
        const receipt =
          qcModelProviderContract.prospectQcModelReviewReceiptSchema.parse(
            row.receipt
          );
        invariant(
          row.state === "COMPLETED" &&
            row.provider === "openrouter" &&
            row.model === "google/gemini-2.5-flash-lite" &&
            row.reserved_cost_cents === 1 &&
            Number(row.provider_reported_cost_usd) === 0.0001 &&
            row.total_tokens === 42 &&
            receipt.reviewId === row.review_id &&
            receipt.review.status === "PASSED" &&
            receipt.contactAuthorized === false &&
            receipt.executionAuthorized === false &&
            qcModelProviderContract.hashProspectQcModelReviewReceipt(
              receipt
            ) === row.receipt_hash,
          "A persisted advisory QC receipt failed immutable verification."
        );
        return receipt;
      }
    );
    const finalOutboxRows = await sql`
      SELECT state, remote_event_id
      FROM velvet_outcome_outbox
      WHERE workspace_id = 1
      ORDER BY id ASC
    `;
    const finalLeadRows = await sql`
      SELECT status, external_id
      FROM prospect_leads
      WHERE id = ${leadId}
      LIMIT 1
    `;
    const finalOutcomeRows = await sql`
      SELECT external_event_id, outcome, occurred_at
      FROM prospect_outcome_events
      WHERE workspace_id = 1
        AND lead_id = ${leadId}
      ORDER BY id ASC
    `;
    const finalPositiveReviewRows = await sql`
      SELECT state, payload_hash, acknowledgment_request_hash,
             acknowledgment_receipt_hash, acknowledged_by,
             payload->>'outcome' AS outcome
      FROM prospect_positive_outcome_reviews
      WHERE workspace_id = 1
      ORDER BY id ASC
    `;
    const finalSmirkCanonical =
      outreachContract.selectCanonicalProspectOutcomeEvent(
        finalOutcomeRows.map((row: JsonRecord) => ({
          externalEventId: row.external_event_id,
          outcome: row.outcome,
          occurredAt: row.occurred_at,
        }))
      );
    const finalLead = finalLeadRows[0];
    const velvetRemoteIds = new Set(
      velvetOutcomes.map((event: JsonRecord) => Number(event.id))
    );
    invariant(
      finalJobRows.length === 2 &&
        finalCall?.state === "SENT" &&
        finalCall?.execution_proof_reference === proofReference &&
        finalCall?.provider_name === null &&
        finalCall?.provider_message_id === null &&
        finalCall?.qc_model_review_id ===
          callQcReviewed.reviewId &&
        finalCall?.qc_model_review_receipt_hash ===
          callQcReviewed.receiptHash &&
        finalCall?.qc_verdict ===
          "ELIGIBLE_FOR_HUMAN_APPROVAL" &&
        finalCall?.qc_contact_authorized === "false" &&
        finalCall?.qc_execution_authorized === "false" &&
        finalEmail?.state === "SENT" &&
        finalEmail?.provider_name === "resend" &&
        finalEmail?.provider_message_id ===
          syntheticProviderMessageId &&
        finalEmail?.qc_model_review_id ===
          emailQcReviewed.reviewId &&
        finalEmail?.qc_model_review_receipt_hash ===
          emailQcReviewed.receiptHash &&
        finalEmail?.execution_proof_reference ===
          `provider:resend/${syntheticProviderMessageId}` &&
        finalEmail?.qc_verdict ===
          "ELIGIBLE_FOR_HUMAN_APPROVAL" &&
        finalEmail?.qc_contact_authorized === "false" &&
        finalEmail?.qc_execution_authorized === "false" &&
        finalQcReceipts.length === 7 &&
        finalQcReceipts.some(
          receipt =>
            receipt.reviewId === callQcReviewed.reviewId
        ) &&
        finalQcReceipts.some(
          receipt =>
            receipt.reviewId === emailQcReviewed.reviewId
        ) &&
        finalOutboxRows.length === 23 &&
        finalOutboxRows.every(
          (row: JsonRecord) =>
            row.state === "DISPATCHED" &&
            velvetRemoteIds.has(Number(row.remote_event_id))
        ) &&
        finalOutcomeRows.length === 3 &&
        finalPositiveReviewRows.length === 11 &&
        finalPositiveReviewRows.every(
          (row: JsonRecord) => row.state === "ACKNOWLEDGED"
        ) &&
        finalPositiveReviewRows[0].state === "ACKNOWLEDGED" &&
        finalPositiveReviewRows[0].outcome === "replied" &&
        finalPositiveReviewRows[0].payload_hash ===
          positiveReview.payloadHash &&
        finalPositiveReviewRows[0].acknowledgment_receipt_hash ===
          reviewAcknowledged.receiptHash &&
        /^[a-f0-9]{64}$/.test(
          String(
            finalPositiveReviewRows[0]
              .acknowledgment_request_hash || ""
          )
        ) &&
        /^dashboard_operator:[a-f0-9]{16}$/.test(
          String(finalPositiveReviewRows[0].acknowledged_by || "")
        ) &&
        finalSmirkCanonical.outcome === "replied" &&
        finalLead?.status === "contacted" &&
        finalLead?.external_id ===
          velvetFixture.ready.externalProspectId,
      `The final SMIRK durable state is inconsistent: ${JSON.stringify({
        jobs: finalJobRows,
        outbox: finalOutboxRows,
        outcomes: finalOutcomeRows,
        positiveReviews: finalPositiveReviewRows,
        canonicalOutcome: finalSmirkCanonical,
        lead: finalLead,
        velvetRemoteIds: Array.from(velvetRemoteIds),
      }).slice(0, 3_000)}`
    );
    invariant(
      network.activeExperimentRequests === 2 &&
        network.discoveryPrepareRequests === 7 &&
        network.discoveryStatusRequests === 4 &&
        network.leadBatchRequests === 6 &&
        network.outcomeRequests === 65 &&
        network.connectionProofRequests === 2 &&
        network.unexpectedRequests === 0 &&
        Number(network.emailProviderAdapterRequests) === 6 &&
        Number(network.emailReceivingAdapterRequests) === 1 &&
        Number(network.qcProviderAdapterRequests) === 7 &&
        network.smsRequests === 0 &&
        network.callRequests === 0,
      "The network trap observed an unexpected request."
    );
    invariant(
      revenueLoop.contractVersion ===
        "smirk.prospect-revenue-loop.v11" &&
        revenueLoop.mode === "guarded-human-approval" &&
        revenueLoop.externalAction === "none" &&
        revenueLoop.counts?.campaigns === 1 &&
        revenueLoop.counts?.qualifiedLeads === 1 &&
        revenueLoop.counts?.qcRevisionsRequired === 0 &&
        revenueLoop.counts?.outreachPrepared === 0 &&
        revenueLoop.counts?.outreachApprovedEmail === 0 &&
        revenueLoop.counts?.outreachApprovedCall === 0 &&
        revenueLoop.counts?.outreachSending === 0 &&
        revenueLoop.counts?.outreachSentWithoutOutcome === 0 &&
        revenueLoop.counts?.outreachSentEmailWithoutOutcome === 0 &&
        revenueLoop.counts?.outreachSentCallWithoutOutcome === 0 &&
        revenueLoop.counts?.outcomeEvents === 3 &&
        revenueLoop.counts?.positiveOutcomeJobs === 1 &&
        revenueLoop.counts?.unreviewedPositiveOutcomeJobs === 0 &&
        revenueLoop.counts?.velvetCallbacksPrepared === 0 &&
        revenueLoop.counts?.velvetCallbacksSending === 0 &&
        revenueLoop.connections?.velvetDiscovery
          ?.availableForWorkspace === true &&
        revenueLoop.connections?.velvetSource
          ?.availableForWorkspace === true &&
        revenueLoop.connections?.advisoryQc
          ?.availableForWorkspace === true &&
        revenueLoop.connections?.emailProvider
          ?.availableForWorkspace === true &&
        revenueLoop.connections?.emailWebhook
          ?.availableForWorkspace === true &&
        revenueLoop.connections?.emailReceiving
          ?.availableForWorkspace === true &&
        revenueLoop.connections?.velvetOutcome
          ?.availableForWorkspace === true &&
        revenueLoop.nextAction?.code ===
          "PREPARE_VELVET_DISCOVERY" &&
        revenueLoop.nextAction?.executionEffect === "none" &&
        revenueLoop.guardrails?.smsAllowed === false &&
        revenueLoop.guardrails?.bulkExecutionAllowed === false &&
        revenueLoop.guardrails
          ?.automatedProspectDialingAllowed === false &&
        revenueLoop.guardrails?.qcMayAuthorizeContact === false &&
        revenueLoop.guardrails
          ?.learningMayMutateRuntimePolicy === false,
      `The revenue-loop controller does not match durable state: ${JSON.stringify(
        revenueLoop
      ).slice(0, 3_000)}`
    );
    const serializedRevenueLoop = JSON.stringify(revenueLoop);
    invariant(
      !serializedRevenueLoop.includes(sourceApiKey) &&
        !serializedRevenueLoop.includes(outcomeApiKey) &&
        !serializedRevenueLoop.includes(qcProviderFixtureKey) &&
        !serializedRevenueLoop.includes(receivingProviderFixtureKey) &&
        !serializedRevenueLoop.includes(emailWebhookSecret) &&
        !serializedRevenueLoop.includes(
          process.env.PROSPECT_EMAIL_RESEND_API_KEY || ""
        ),
      "The revenue-loop controller exposed a credential."
    );

    report = {
      ok: true,
      proof: "velvet-smirk-cross-database-http-loop",
      mode: "synthetic-disposable-local-only",
      externalProspectId: velvetFixture.ready.externalProspectId,
      smirkProspectId: leadId,
      outreachApprovalIds: {
        call: outreachPrepared.approvalId,
        email: emailPrepared.approvalId,
      },
      outcomeEventIds: Array.from(expectedOutcomeIds),
      source: {
        velvetDiscoveryProviderAdapterCalls:
          velvetFixture.ready.providerRequests,
        velvetLeadBatchRequests: network.leadBatchRequests,
        importedProspects: sourceDispatched.importedCount,
        exactRemoteReplay: remoteSourceReplay.response.state,
      },
      frozenSourcingExperiment: {
        experimentId: velvetFixture.ready.experimentId,
        definitionHash:
          velvetFixture.ready.experimentDefinitionHash,
        studyDesign: "deterministic-balanced-source-allocation-v1",
        totalAssignments: experimentRuns.length,
        controlAssignments: experimentRuns.filter(
          run => run.arm === "control"
        ).length,
        challengerAssignments: experimentRuns.filter(
          run => run.arm === "challenger"
        ).length,
        importedProspects: experimentLeads.length,
        providerAdapterRequests: experimentRuns.reduce(
          (total, run) => total + run.providerRequests,
          0
        ),
        exactAssignmentHashes: experimentRuns.map(
          run => run.assignmentHash
        ),
        tamperedBindingBlocked: tamperedExperimentBlocked.code,
        incompleteOutcomeCoverageBlocked:
          incompleteExperiment.code,
        signedOutcomeReceipts:
          syntheticExperimentOutcomePayloads.length,
        signedOutcomeReplay:
          syntheticExperimentOutcomeReplay.state,
        resultStatus:
          closedExperiment.experiment.result.status,
        resultCode: closedExperiment.experiment.result.code,
        winner: closedExperiment.experiment.result.winner,
        recommendation:
          closedExperiment.experiment.result.proposal,
        candidateCreated: closedExperiment.candidateCreated,
        policyChanged: closedExperiment.policyChanged,
        contactActionAllowed:
          closedExperiment.contactActionAllowed,
        spendAuthorized: closedExperiment.spendAuthorized,
        externalAction: closedExperiment.externalAction,
        guardedLearningRelease: {
          candidateId: proposedCandidate.candidate.id,
          proposalOutcome: proposedCandidate.outcome,
          proposalReplayOutcome: proposedCandidateReplay.outcome,
          releaseBeforeApprovalBlocked:
            releaseBeforeApproval.code,
          decisionState: candidateDecision.state,
          decisionChangedPolicy: candidateDecision.policyChanged,
          releaseId: learningReleaseId,
          releaseOutcome: releasedCandidate.outcome,
          releaseReplayOutcome: releasedCandidateReplay.outcome,
          releaseReceiptHash:
            releasedCandidate.receipt.receiptHash,
          futureResearchOnly:
            releasedCandidate.receipt.controls
              .affectsFutureResearchCriteriaOnly,
          existingBatchesChanged:
            releasedCandidate.receipt.controls
              .existingBatchesChanged,
          learnedDiscoveryRequestId,
          learnedDiscoveryState: learnedDiscovery.state,
          learnedDiscoveryReplayState:
            learnedDiscoveryReplay.state,
          learnedCategory:
            learnedDiscovery.effectiveCriteria.category,
          appliedLearningCandidateId:
            learnedDiscovery.appliedLearningCandidate.id,
          executionStarted: learnedDiscovery.executionStarted,
          contactAuthorized:
            releasedCandidate.contactAuthorized,
          providerExecutionAuthorized:
            releasedCandidate.providerExecutionAuthorized,
          spendAuthorized: releasedCandidate.spendAuthorized,
        },
      },
      linkedMessageExperiment: {
        sourceCampaignId: experimentCampaign.campaign_id,
        sourceCampaignExternalId:
          experimentCampaign.campaign_external_id,
        velvetSourcedEligiblePopulation: 40,
        experimentId: messageExperimentDefinition.experimentId,
        definitionHash:
          messageExperimentPrepared.definitionHash,
        channel: messageExperimentDefinition.channel,
        frozenCohortSize: messageExperimentDefinition.cohort.length,
        controlAssignments: messageExperimentDefinition.cohort.filter(
          entry => entry.arm === "control"
        ).length,
        challengerAssignments:
          messageExperimentDefinition.cohort.filter(
            entry => entry.arm === "challenger"
          ).length,
        draftFeedCreated: messageDraftsPrepared.createdCount,
        draftFeedReplay: messageDraftsReplay.outcome,
        syntheticHistoricalOutcomes:
          messageOutcomeExternalIds.length,
        externalCallsPlaced: 0,
        positiveReviewsAcknowledged:
          pendingMessageReviews.reviews.length,
        feedbackReceiptsDispatchedToVelvet:
          messageOutboxRows.length,
        closureState: messageExperimentClosed.state,
        measuredSentJobs:
          messageExperimentClosed.observationWindow
            .measuredSentJobCount,
        candidateId: messageCandidate.id,
        candidateOutcome: messageCandidate.outcome,
        candidateReplay: messageCandidateReplay.outcome,
        releaseBeforeApprovalBlocked:
          messageReleaseBeforeApproval.code,
        decisionState: messageCandidateDecision.state,
        decisionChangedPolicy:
          messageCandidateDecision.policyChanged,
        releaseOutcome: messagePolicyReleased.outcome,
        releaseReplay: messagePolicyReplay.outcome,
        championVariant:
          messagePolicyReleased.release.championVariantKey,
        nextExperimentControlOnly:
          messagePolicyReleased.release.controls
            .nextExperimentControlOnly,
        existingJobsChanged:
          messagePolicyReleased.existingJobsChanged,
        wrongFutureControlBlocked: wrongMessageControl.code,
        nextExperimentId: nextMessageDefinition.experimentId,
        nextExperimentState:
          nextMessageExperimentPrepared.state,
        nextExperimentControl:
          nextMessageDefinition.controlVariantKey,
        nextExperimentCohortSize:
          nextMessageDefinition.cohort.length,
        appliedPolicyReleaseId:
          nextMessageDefinition.appliedPolicy.releaseId,
        contactAuthorized: false,
        executionAuthorized: false,
        spendAuthorized: false,
        externalAction: "none",
      },
      linkedEmailExperiment: {
        sourceCampaignId: experimentCampaign.campaign_id,
        sourceCampaignExternalId:
          experimentCampaign.campaign_external_id,
        velvetSourcedEligiblePopulation: 40,
        inboxPlacement: {
          testId: inboxPlacementPrepared.testId,
          state: inboxPlacementFinalized.state,
          receiptHash: inboxPlacementFinalized.receiptHash,
          validUntil: inboxPlacementFinalized.receipt.validUntil,
          controlledRecipients: controlledSeedReceipts.length,
          providerMix: {
            googleWorkspace: 2,
            microsoft365: 2,
            yahooAol: 1,
          },
          uniqueProviderMessageIds: new Set(
            controlledSeedReceipts.map(
              receipt => receipt.providerMessageId
            )
          ).size,
          advisoryQcReceipts: 5,
          allPrimary: true,
          spfDkimDmarcPass: true,
          plainTextOnly: true,
          trackingPixels: 0,
          unexpectedLinks: 0,
          realRecipients: 0,
          externalMessages: 0,
        },
        experimentId: emailExperimentDefinition.experimentId,
        definitionHash: emailExperimentPrepared.definitionHash,
        channel: emailExperimentDefinition.channel,
        inboxPlacementTestId:
          emailExperimentActivated.inboxPlacementTestId,
        frozenCohortSize: emailExperimentDefinition.cohort.length,
        controlVariant: emailExperimentDefinition.controlVariantKey,
        challengerVariant:
          emailExperimentDefinition.challengerVariantKey,
        controlAssignments: emailExperimentDefinition.cohort.filter(
          entry => entry.arm === "control"
        ).length,
        challengerAssignments:
          emailExperimentDefinition.cohort.filter(
            entry => entry.arm === "challenger"
          ).length,
        state: emailExperimentActivated.state,
        draftFeedCreated:
          emailExperimentDraftsPrepared.createdCount,
        draftFeedReplay: emailExperimentDraftsReplay.outcome,
        pendingHumanReview:
          emailExperimentDraftsPrepared.pendingHumanReview,
        cohortProviderExecutions: 0,
        contactAuthorized: false,
        executionAuthorized: false,
        spendAuthorized: false,
        externalAction: "none",
      },
      velvetConnectionPreflight: {
        contractVersion:
          velvetConnectionReadiness.contractVersion,
        readinessScope: velvetConnectionReadiness.readinessScope,
        runtimePrerequisitesReady: velvetConnectionReadiness.ok,
        endToEndReady: velvetConnectionReadiness.endToEndReady,
        workspaceId:
          velvetConnectionReadiness.connections
            .smirkWorkspaceBoundary.workspaceId,
        schemaReady:
          velvetConnectionReadiness.databaseProof.schemaReady,
        dedicatedResearchKeyCount:
          velvetConnectionReadiness.databaseProof
            .activeDedicatedResearchKeyCount,
        dedicatedOutcomeKeyCount:
          velvetConnectionReadiness.databaseProof
            .activeDedicatedOutcomeKeyCount,
        dedicatedKeysDistinct:
          velvetConnectionReadiness.databaseProof.keysDistinct,
        sameAdminOwner:
          velvetConnectionReadiness.databaseProof.sameAdminOwner,
        optionalPushRequired: false,
        credentialsExposed: false,
        externalAction: velvetConnectionReadiness.externalAction,
      },
      velvetRemoteConnectionProof: {
        contractVersion:
          velvetRemoteConnectionProof?.contractVersion,
        ok: velvetRemoteConnectionProof?.ok,
        requestsPerformed:
          velvetRemoteConnectionProof?.requestsPerformed,
        checks: velvetRemoteConnectionProof?.checks,
        apiKeyUsageStateChanged: false,
        credentialsExposed: false,
        externalAction:
          velvetRemoteConnectionProof?.externalAction,
      },
      qc: {
        callVerdict: qcReceipt.verdict,
        emailVerdict: emailQcReceipt.verdict,
        deterministicPassed:
          qcReceipt.deterministicPassed &&
          emailQcReceipt.deterministicPassed,
        humanApprovalRequired: true,
        contactAuthorized:
          qcReceipt.contactAuthorized ||
          emailQcReceipt.contactAuthorized,
        executionAuthorized:
          qcReceipt.executionAuthorized ||
          emailQcReceipt.executionAuthorized,
        advisoryModel: {
          requiredForApproval: true,
          provider: "intercepted-openrouter-adapter",
          model: "google/gemini-2.5-flash-lite",
          callReviewId: callQcReviewed.reviewId,
          emailReviewId: emailQcReviewed.reviewId,
          callStatus: callQcReviewed.receipt.review.status,
          emailStatus: emailQcReviewed.receipt.review.status,
          exactReplay: callQcReplay.outcome,
          persistedReceiptCount: finalQcReceipts.length,
          changedCallReceiptBlocked:
            changedCallReceiptBlocked.code,
          changedEmailReceiptBlocked:
            changedEmailReceiptBlocked.code,
          providerRequests:
            network.qcProviderAdapterRequests,
          humanApprovalRequired: true,
          contactAuthorized: false,
          executionAuthorized: false,
        },
      },
      execution: {
        call: {
          mode: "synthetic-manual-record-only",
          initial: executionRecorded.outcome,
          replay: executionReplay.outcome,
          complianceReceiptHash:
            storedCallApproval.attestations
              .callComplianceReceiptHash,
          recipientTimezone:
            storedCallApproval.attestations
              .callComplianceReceipt?.recipientTimezone,
          permittedWindow:
            "09:00-17:00 recipient local time",
          changedComplianceReceiptBlocked:
            changedComplianceReceiptBlocked.code,
        },
        email: {
          mode: "intercepted-resend-adapter",
          initial: emailExecuted.outcome,
          replay: emailExecutionReplay.outcome,
          providerAccepted: emailExecuted.providerAccepted,
          deliveryConfirmedBySendResponse:
            emailExecuted.delivered,
          signedDeliveryOutcome:
            deliveredRecorded.outcome,
          signedReplyOutcome: replyRecorded.outcome,
          signedReplyReplay: replyWebhookReplay.outcome,
          inboundContentRetrieval:
            inboundReplyContent.outcome,
          inboundContentRetrievalReplay:
            inboundReplyContentReplay.outcome,
          inboundContentReceiptHash:
            inboundReplyContent.receiptHash,
          humanReplyClassification:
            inboundReplyResolved.outcome,
          humanReplyClassificationReplay:
            inboundReplyResolutionReplay.outcome,
        },
        providerExecutionCount: pg.provider_executions,
      },
      outcome: {
        smirkInitial: outcomeRecorded.outcome,
        smirkReplay: outcomeReplay.outcome,
        velvetInitial: callbackDispatched.remoteState,
        velvetReplay: remoteOutcomeReplay.state,
        postgresOutboxStates: finalOutboxRows.map(
          (row: JsonRecord) => row.state
        ),
        mysqlOutcomeCount: velvetOutcomes.length,
        smirkCanonical: finalSmirkCanonical.outcome,
        velvetCanonical: velvetState.lead?.smirkCallOutcome,
      },
      positiveOutcomeReview: {
        migrationBackfill: migrationBackfillProof,
        initialState: positiveReview.state,
        exactResearchReplayDuringPause:
          researchReplayDuringPause.outcome,
        newResearchBlockedUntilAcknowledged,
        callbackBlockedUntilAcknowledged:
          callbackBlockedByPositiveReview.code,
        acknowledgment: reviewAcknowledged.outcome,
        replay: reviewAcknowledgmentReplay.outcome,
        finalState: finalPositiveReviewRows[0].state,
        pendingAfterAcknowledgment:
          revenueLoop.counts?.unreviewedPositiveOutcomeJobs,
        auditEventCount: pg.positive_review_events,
        externalAction: reviewAcknowledged.externalAction,
      },
      controller: {
        contractVersion: revenueLoop.contractVersion,
        pausedNextAction: pausedRevenueLoop.nextAction?.code,
        pausedFocusVerified:
          pausedRevenueLoop.nextAction?.focus?.reviewId ===
          positiveReview.reviewId,
        resumedNextAction: revenueLoop.nextAction?.code,
        externalAction: revenueLoop.externalAction,
        countsAtResume: {
          campaigns: revenueLoop.counts?.campaigns,
          qualifiedLeads: revenueLoop.counts?.qualifiedLeads,
          outreachPrepared: revenueLoop.counts?.outreachPrepared,
          outreachApprovedEmail:
            revenueLoop.counts?.outreachApprovedEmail,
          outreachApprovedCall:
            revenueLoop.counts?.outreachApprovedCall,
          outreachSending: revenueLoop.counts?.outreachSending,
          outreachSentWithoutOutcome:
            revenueLoop.counts?.outreachSentWithoutOutcome,
          outcomeEvents: revenueLoop.counts?.outcomeEvents,
          positiveOutcomeJobs:
            revenueLoop.counts?.positiveOutcomeJobs,
          unreviewedPositiveOutcomeJobs:
            revenueLoop.counts?.unreviewedPositiveOutcomeJobs,
          pendingVelvetCallbacks:
            revenueLoop.counts?.velvetCallbacksPrepared +
            revenueLoop.counts?.velvetCallbacksSending,
        },
        guardrails: revenueLoop.guardrails,
        credentialsExposed: false,
      },
      finalPersistence: {
        discoveryRequests: pg.discovery_requests,
        sourceRequests: pg.source_requests,
        sourceItems: pg.source_items,
        leads: pg.leads,
        outreachJobs: pg.outreach_jobs,
        outcomeEvents: pg.outcome_events,
        positiveReviews: pg.positive_reviews,
        pendingPositiveReviews: pg.pending_positive_reviews,
        outboxEvents: pg.outbox_events,
        providerExecutions: pg.provider_executions,
      },
      revenueLoopPreparer: {
        forgedCredentialBlocked: true,
        positiveInteractionPause:
          pausedPreparerBlocked.code,
        initial: revenueLoopPrepared.outcome,
        replay: revenueLoopPreparedReplay.outcome,
        durableRowCount: revenueLoopPreparedRows.length,
        immutablePreparedEventCount:
          revenueLoopPreparedEvents.length,
        finalState: revenueLoopPreparedCancelled.state,
        providerRequests: 0,
        contactAuthorized: false,
        executionAuthorized: false,
        spendAuthorized: false,
        policyMutationAuthorized: false,
        externalAction: revenueLoopPrepared.externalAction,
      },
      tenantIsolation: {
        crossWorkspaceReadDenied: true,
      },
      sideEffects: {
        productionNetworkRequests: 0,
        externalEmailsSent: 0,
        interceptedEmailProviderAdapterRequests:
          network.emailProviderAdapterRequests,
        interceptedEmailReceivingAdapterRequests:
          network.emailReceivingAdapterRequests,
        interceptedQcProviderAdapterRequests:
          network.qcProviderAdapterRequests,
        smsRequests: network.smsRequests,
        phoneCalls: network.callRequests,
        paidProviderRequests: 0,
        productionWrites: 0,
      },
      cleanup: {
        disposablePostgres: postgresDatabase,
        disposableMySql: mysqlDatabase,
        verifiedDropped: false,
      },
    };
  } finally {
    await closeServer(smirkServer).catch(() => undefined);
    if (sql) {
      await sql.end({ timeout: 5 }).catch(() => undefined);
    }
    await stopVelvetFixture(velvetFixture);
    if (databasesCreated) {
      await dropDisposableDatabases();
      await verifyDisposableDatabasesDropped();
    }
  }
  invariant(report, "The cross-database proof produced no report.");
  report.cleanup.verifiedDropped = true;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Cross-database proof failed: ${message}\n`);
  process.exitCode = 1;
});
