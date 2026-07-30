import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import express, {
  type NextFunction,
  type Request,
  type Response as ExpressResponse,
} from "express";

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
    emailRequests: 0,
    smsRequests: 0,
    callRequests: 0,
  };

  try {
    databasesCreated = true;
    await createDisposableDatabases();
    velvetFixture = await startVelvetFixture();
    const velvetFixtureBaseUrl = `http://127.0.0.1:${velvetFixture.ready.port}`;

    process.env.DATABASE_URL = postgresUrl;
    process.env.VELVET_LEAD_SOURCE_ENABLED = "true";
    process.env.VELVET_LEAD_SOURCE_BASE_URL = `${productionVelvetOrigin}/`;
    process.env.VELVET_LEAD_SOURCE_API_KEY = sourceApiKey;
    process.env.VELVET_LEAD_SOURCE_WORKSPACE_ID = "1";
    process.env.VELVET_OUTCOME_DISPATCH_ENABLED = "true";
    process.env.VELVET_BASE_URL = `${productionVelvetOrigin}/`;
    process.env.VELVET_OUTCOME_API_KEY = outcomeApiKey;
    process.env.VELVET_OUTCOME_SIGNING_SECRET = signingSecret;
    process.env.VELVET_OUTCOME_WORKSPACE_ID = "1";
    process.env.PROSPECT_EMAIL_EXECUTION_ENABLED = "false";

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
    const sourceContract = await import("../src/velvet-lead-source.js");
    const outreachContract = await import("../src/prospect-outreach.js");
    const variants = await import("../src/prospect-message-variants.js");
    const outcomeContract = await import("../src/velvet-outcome.js");
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

    const guardedVelvetFetch: typeof fetch = async (input, init) => {
      const requestedUrl = new URL(
        input instanceof Request ? input.url : String(input)
      );
      if (requestedUrl.origin !== productionVelvetOrigin) {
        network.unexpectedRequests += 1;
        throw new Error(
          `Blocked non-Velvet network request: ${requestedUrl.origin}`
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
    app.use(express.json({ limit: "1mb" }));
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
      fetchImpl: guardedVelvetFetch,
    });
    outreachRoutes.registerProspectOutreachRoutes(app, {
      dashboardAuth: operator,
      requireOperator: operator,
      requireFullOperator: operator,
      sql,
      dbEnabled: true,
      getWorkspaceId,
      env: process.env,
      fetchImpl: guardedVelvetFetch,
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
        guardedVelvetFetch
      );
    invariant(
      remoteSourceReplay.success &&
        remoteSourceReplay.response.state === "DUPLICATE" &&
        remoteSourceReplay.httpStatus === 200,
      "Velvet did not recognize the exact lead-batch replay."
    );

    const importedRows = await sql`
      SELECT l.id, l.campaign_id, l.business_name, l.industry,
             l.external_id, l.research_evidence
      FROM prospect_leads l
      JOIN prospecting_campaigns c ON c.id = l.campaign_id
      WHERE c.workspace_id = 1
        AND l.source = 'velvet_alchemy_research'
      ORDER BY l.id ASC
    `;
    invariant(
      importedRows.length === 1 &&
        importedRows[0].external_id ===
          velvetFixture.ready.externalProspectId,
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
        guardedVelvetFetch,
        new Date()
      );
    invariant(
      remoteOutcomeReplay.success &&
        remoteOutcomeReplay.state === "DUPLICATE",
      "Velvet did not recognize the exact signed outcome replay."
    );

    const velvetState = await httpJson({
      baseUrl: velvetFixtureBaseUrl,
      pathname: "/__fixture/state",
      headers: { "x-fixture-token": fixtureControlToken },
      expectedStatus: 200,
    });
    invariant(
      velvetState.mode === "smirk-cross-db-v1" &&
        velvetState.lead?.id === velvetFixture.ready.leadId &&
        velvetState.lead?.smirkCallOutcome === "no_answer" &&
        velvetState.lead?.smirkWorkspaceId === "1" &&
        velvetState.outcomes?.length === 1 &&
        velvetState.outcomes[0].externalEventId === outcomeEventId &&
        velvetState.batches?.length === 1 &&
        velvetState.batches[0].state === "EXPORTED" &&
        velvetState.discoveries?.length === 1 &&
        velvetState.discoveries[0].state === "COMPLETED",
      "Velvet MySQL state does not match the SMIRK outcome."
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
        pg.outreach_jobs === 1 &&
        pg.outcome_events === 1 &&
        pg.outbox_events === 1 &&
        pg.provider_executions === 0 &&
        pg.email_provider_events === 0,
      "SMIRK Postgres row counts are not exact."
    );
    const finalRows = await sql`
      SELECT j.state AS outreach_state,
             j.execution_proof_reference,
             j.payload->'qcReceipt'->>'verdict' AS qc_verdict,
             j.payload->'qcReceipt'->>'contactAuthorized'
               AS qc_contact_authorized,
             j.payload->'qcReceipt'->>'executionAuthorized'
               AS qc_execution_authorized,
             o.state AS outbox_state,
             o.remote_event_id,
             l.status AS prospect_status,
             l.external_id
      FROM prospect_outreach_jobs j
      JOIN prospect_leads l ON l.id = j.lead_id
      JOIN velvet_outcome_outbox o ON o.lead_id = l.id
      WHERE j.workspace_id = 1
      LIMIT 1
    `;
    const final = finalRows[0];
    invariant(
      final.outreach_state === "SENT" &&
        final.execution_proof_reference === proofReference &&
        final.qc_verdict === "ELIGIBLE_FOR_HUMAN_APPROVAL" &&
        final.qc_contact_authorized === "false" &&
        final.qc_execution_authorized === "false" &&
        final.outbox_state === "DISPATCHED" &&
        Number(final.remote_event_id) ===
          Number(velvetState.outcomes[0].id) &&
        final.prospect_status === "no_answer" &&
        final.external_id === velvetFixture.ready.externalProspectId,
      "The final SMIRK durable state is inconsistent."
    );
    invariant(
      network.leadBatchRequests === 2 &&
        network.outcomeRequests === 2 &&
        network.unexpectedRequests === 0 &&
        network.emailRequests === 0 &&
        network.smsRequests === 0 &&
        network.callRequests === 0,
      "The network trap observed an unexpected request."
    );

    report = {
      ok: true,
      proof: "velvet-smirk-cross-database-http-loop",
      mode: "synthetic-disposable-local-only",
      externalProspectId: velvetFixture.ready.externalProspectId,
      smirkProspectId: leadId,
      outreachApprovalId: outreachPrepared.approvalId,
      outcomeEventId,
      source: {
        velvetDiscoveryProviderAdapterCalls:
          velvetFixture.ready.providerRequests,
        velvetLeadBatchRequests: network.leadBatchRequests,
        importedProspects: sourceDispatched.importedCount,
        exactRemoteReplay: remoteSourceReplay.response.state,
      },
      qc: {
        verdict: qcReceipt.verdict,
        deterministicPassed: qcReceipt.deterministicPassed,
        humanApprovalRequired: true,
        contactAuthorized: qcReceipt.contactAuthorized,
        executionAuthorized: qcReceipt.executionAuthorized,
      },
      execution: {
        mode: "synthetic-manual-record-only",
        initial: executionRecorded.outcome,
        replay: executionReplay.outcome,
        providerExecutionCount: pg.provider_executions,
      },
      outcome: {
        smirkInitial: outcomeRecorded.outcome,
        smirkReplay: outcomeReplay.outcome,
        velvetInitial: callbackDispatched.remoteState,
        velvetReplay: remoteOutcomeReplay.state,
        postgresOutboxState: final.outbox_state,
        mysqlOutcomeCount: velvetState.outcomes.length,
      },
      tenantIsolation: {
        crossWorkspaceReadDenied: true,
      },
      sideEffects: {
        productionNetworkRequests: 0,
        emailRequests: network.emailRequests,
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
