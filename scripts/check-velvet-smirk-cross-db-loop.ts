import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
const signingSecret = `velvet-signing-${randomBytes(32).toString("hex")}`;
const fixtureControlToken = `fixture-control-${randomBytes(32).toString("hex")}`;
const productionVelvetOrigin = "https://velvetalchemy.manus.space";
const resendOrigin = "https://api.resend.com";
const syntheticProviderMessageId = `email_${runId}`;
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
              parsed.providerRequests === 2,
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
    leadBatchRequests: 0,
    outcomeRequests: 0,
    unexpectedRequests: 0,
    emailProviderAdapterRequests: 0,
    smsRequests: 0,
    callRequests: 0,
  };

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
    process.env.PROSPECT_EMAIL_DAILY_RECIPIENT_CAP = "2";
    process.env.PROSPECT_EMAIL_DAILY_SPEND_CAP_CENTS = "2";
    process.env.PROSPECT_EMAIL_UNIT_COST_CENTS = "1";
    process.env.PROSPECT_EMAIL_WEBHOOK_ENABLED = "true";
    process.env.PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET =
      emailWebhookSecret;

    const dbModule = await import("../src/db.js");
    const saasModule = await import("../src/saas.js");
    const prospectorModule = await import("../src/prospector.js");
    const researchRoutes = await import(
      "../src/routes/velvet-research-routes.js"
    );
    const sourceRoutes = await import(
      "../src/routes/velvet-lead-source-routes.js"
    );
    const outreachRoutes = await import(
      "../src/routes/prospect-outreach-routes.js"
    );
    const revenueLoopRoutes = await import(
      "../src/routes/prospect-revenue-loop-routes.js"
    );
    const sourceContract = await import("../src/velvet-lead-source.js");
    const outreachContract = await import("../src/prospect-outreach.js");
    const emailProviderContract = await import(
      "../src/prospect-email-provider.js"
    );
    const variants = await import("../src/prospect-message-variants.js");
    const outcomeContract = await import("../src/velvet-outcome.js");
    const positiveOutcomeReviewContract = await import(
      "../src/prospect-positive-outcome-review.js"
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
        return new Response(
          JSON.stringify({ id: syntheticProviderMessageId }),
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
      if (requestedUrl.pathname === "/api/v1/smirk/lead-batches") {
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
    const getWorkspaceId = (req: Request) => {
      const requested = Number(req.headers["x-smirk-fixture-workspace"] || 1);
      return Number.isSafeInteger(requested) && requested > 0
        ? requested
        : 1;
    };
    const store = researchRoutes.createPostgresVelvetResearchStore(sql);
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
        },
      },
      expectedStatus: 200,
    });
    invariant(
      outreachApproved.state === "APPROVED",
      "The exact human-gated call brief was not approved."
    );

    const approvedRows = await sql`
      SELECT approved_at
      FROM prospect_outreach_jobs
      WHERE approval_id = ${outreachPrepared.approvalId}
      LIMIT 1
    `;
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
        emailCompliance: {
          senderIdentity: "SMIRK",
          advertisementDisclosure:
            "This is a commercial message from SMIRK.",
          physicalPostalAddress:
            "100 Example Avenue, Reno, NV 89501",
          optOutInstructions:
            "Reply stop to opt out of future emails.",
        },
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
      emailApproved.state === "APPROVED",
      "The exact one-recipient email was not human-approved."
    );
    const emailExecutionBody = {
      payloadHash: emailPrepared.payloadHash,
      confirmation:
        emailProviderContract.PROSPECT_EMAIL_EXECUTION_CONFIRMATION,
    };
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
        network.emailProviderAdapterRequests === 1,
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
      replyRecorded.outcome === "recorded" &&
        replyRecorded.status === "PROCESSED",
      "The signed reply event did not create one measured outcome."
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
        "smirk.prospect-revenue-loop.v6" &&
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
    ]);
    invariant(
      velvetState.mode === "smirk-cross-db-v1" &&
        velvetState.lead?.id === velvetFixture.ready.leadId &&
        velvetState.lead?.smirkCallOutcome === "replied" &&
        velvetState.lead?.smirkWorkspaceId === "1" &&
        velvetOutcomes.length === 3 &&
        velvetOutcomes.every((event: JsonRecord) =>
          expectedOutcomeIds.has(event.externalEventId)
        ) &&
        ["no_answer", "delivered", "replied"].every(outcome =>
          velvetOutcomes.some(
            (event: JsonRecord) => event.outcome === outcome
          )
        ) &&
        velvetState.batches?.length === 1 &&
        velvetState.batches[0].state === "EXPORTED" &&
        velvetState.discoveries?.length === 1 &&
        velvetState.discoveries[0].state === "COMPLETED",
      `Velvet MySQL state does not match the SMIRK outcomes: ${JSON.stringify({
        lead: velvetState.lead,
        outcomes: velvetOutcomes,
        expectedOutcomeIds: Array.from(expectedOutcomeIds),
        batches: velvetState.batches,
        discoveries: velvetState.discoveries,
      }).slice(0, 2_000)}`
    );

    const postgresProof = await sql`
      SELECT
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
      pg.source_requests === 1 &&
        pg.source_items === 1 &&
        pg.leads === 1 &&
        pg.outreach_jobs === 2 &&
        pg.outcome_events === 3 &&
        pg.positive_reviews === 1 &&
        pg.pending_positive_reviews === 0 &&
        pg.positive_review_events === 2 &&
        pg.outbox_events === 3 &&
        pg.provider_executions === 1 &&
        pg.email_provider_events === 2,
      "SMIRK Postgres row counts are not exact."
    );
    const finalJobRows = await sql`
      SELECT j.approval_id, j.channel, j.state,
             j.execution_proof_reference, j.provider_name,
             j.provider_message_id,
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
        finalCall?.qc_verdict ===
          "ELIGIBLE_FOR_HUMAN_APPROVAL" &&
        finalCall?.qc_contact_authorized === "false" &&
        finalCall?.qc_execution_authorized === "false" &&
        finalEmail?.state === "SENT" &&
        finalEmail?.provider_name === "resend" &&
        finalEmail?.provider_message_id ===
          syntheticProviderMessageId &&
        finalEmail?.execution_proof_reference ===
          `provider:resend/${syntheticProviderMessageId}` &&
        finalEmail?.qc_verdict ===
          "ELIGIBLE_FOR_HUMAN_APPROVAL" &&
        finalEmail?.qc_contact_authorized === "false" &&
        finalEmail?.qc_execution_authorized === "false" &&
        finalOutboxRows.length === 3 &&
        finalOutboxRows.every(
          (row: JsonRecord) =>
            row.state === "DISPATCHED" &&
            velvetRemoteIds.has(Number(row.remote_event_id))
        ) &&
        finalOutcomeRows.length === 3 &&
        finalPositiveReviewRows.length === 1 &&
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
      network.leadBatchRequests === 2 &&
        network.outcomeRequests === 4 &&
        network.unexpectedRequests === 0 &&
        network.emailProviderAdapterRequests === 1 &&
        network.smsRequests === 0 &&
        network.callRequests === 0,
      "The network trap observed an unexpected request."
    );
    invariant(
      revenueLoop.contractVersion ===
        "smirk.prospect-revenue-loop.v6" &&
        revenueLoop.mode === "guarded-human-approval" &&
        revenueLoop.externalAction === "none" &&
        revenueLoop.counts?.campaigns === 1 &&
        revenueLoop.counts?.qualifiedLeads === 1 &&
        revenueLoop.counts?.outreachPrepared === 0 &&
        revenueLoop.counts?.outreachApprovedEmail === 0 &&
        revenueLoop.counts?.outreachApprovedCall === 0 &&
        revenueLoop.counts?.outreachSending === 0 &&
        revenueLoop.counts?.outreachSentWithoutOutcome === 0 &&
        revenueLoop.counts?.outcomeEvents === 3 &&
        revenueLoop.counts?.positiveOutcomeJobs === 1 &&
        revenueLoop.counts?.unreviewedPositiveOutcomeJobs === 0 &&
        revenueLoop.counts?.velvetCallbacksPrepared === 0 &&
        revenueLoop.counts?.velvetCallbacksSending === 0 &&
        revenueLoop.connections?.velvetDiscovery
          ?.availableForWorkspace === true &&
        revenueLoop.connections?.velvetSource
          ?.availableForWorkspace === true &&
        revenueLoop.connections?.emailProvider
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
      },
      execution: {
        call: {
          mode: "synthetic-manual-record-only",
          initial: executionRecorded.outcome,
          replay: executionReplay.outcome,
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
        counts: {
          campaigns: revenueLoop.counts?.campaigns,
          qualifiedLeads: revenueLoop.counts?.qualifiedLeads,
          outreachJobs: pg.outreach_jobs,
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
      tenantIsolation: {
        crossWorkspaceReadDenied: true,
      },
      sideEffects: {
        productionNetworkRequests: 0,
        externalEmailsSent: 0,
        interceptedEmailProviderAdapterRequests:
          network.emailProviderAdapterRequests,
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
