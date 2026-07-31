import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildProspectRevenueLoopCheckpoint,
  PROSPECT_REVENUE_LOOP_CHECKPOINT_CONFIRMATION,
  prospectRevenueLoopCheckpointSchema,
  prospectRevenueLoopStatusSchema,
} from "../src/prospect-revenue-loop-runner.js";

type Args = {
  noWrite: boolean;
  outputDir: string;
  statusFile: string | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    noWrite: false,
    outputDir: path.resolve("output/prospect-revenue-loop"),
    statusFile: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--no-write") {
      args.noWrite = true;
      continue;
    }
    if (value === "--output-dir" || value === "--status-file") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`${value} requires a path.`);
      }
      index += 1;
      if (value === "--output-dir") {
        args.outputDir = path.resolve(next);
      } else {
        args.statusFile = path.resolve(next);
      }
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function positiveWorkspaceId(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      "PROSPECT_REVENUE_LOOP_OBSERVER_WORKSPACE_ID must be a positive integer."
    );
  }
  return parsed;
}

function safeBaseUrl(raw: string | undefined): URL {
  const parsed = new URL(String(raw || ""));
  const local =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error(
      "PROSPECT_REVENUE_LOOP_BASE_URL must use HTTPS, except for localhost fixtures."
    );
  }
  return parsed;
}

async function loadStatus(input: {
  statusFile: string | null;
  workspaceId: number;
}): Promise<{
  sourceOrigin: string;
  status: ReturnType<typeof prospectRevenueLoopStatusSchema.parse>;
}> {
  if (input.statusFile) {
    const raw = JSON.parse(await readFile(input.statusFile, "utf8"));
    return {
      sourceOrigin: "http://127.0.0.1",
      status: prospectRevenueLoopStatusSchema.parse(raw),
    };
  }

  const baseUrl = safeBaseUrl(
    process.env.PROSPECT_REVENUE_LOOP_BASE_URL
  );
  const apiKey = String(
    process.env.PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY || ""
  ).trim();
  if (apiKey.length < 32) {
    throw new Error(
      "PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY must contain the dedicated 32-character observer credential."
    );
  }
  const endpoint = new URL(
    "/api/prospecting/revenue-loop",
    baseUrl
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        "X-Api-Key": apiKey,
        "X-Workspace-Id": String(input.workspaceId),
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        `Revenue-loop status returned HTTP ${response.status}.`
      );
    }
    return {
      sourceOrigin: baseUrl.origin,
      status: prospectRevenueLoopStatusSchema.parse(body),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readHistory(
  historyPath: string
): Promise<
  Array<ReturnType<typeof prospectRevenueLoopCheckpointSchema.parse>>
> {
  let raw = "";
  try {
    raw = await readFile(historyPath, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length > 10_000) {
    throw new Error(
      "The revenue-loop checkpoint ledger exceeds the 10,000-row review limit."
    );
  }
  return lines.map((line, index) => {
    try {
      return prospectRevenueLoopCheckpointSchema.parse(
        JSON.parse(line)
      );
    } catch {
      throw new Error(
        `The revenue-loop checkpoint ledger is invalid at line ${index + 1}.`
      );
    }
  });
}

async function atomicWrite(
  targetPath: string,
  content: string
): Promise<void> {
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, content, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, targetPath);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workspaceId = positiveWorkspaceId(
    process.env.PROSPECT_REVENUE_LOOP_OBSERVER_WORKSPACE_ID
  );
  const loaded = await loadStatus({
    statusFile: args.statusFile,
    workspaceId,
  });
  const checkpoint = buildProspectRevenueLoopCheckpoint({
    workspaceId,
    observedAt: new Date().toISOString(),
    sourceOrigin: loaded.sourceOrigin,
    status: loaded.status,
  });

  const latestPath = path.join(args.outputDir, "latest.json");
  const historyPath = path.join(args.outputDir, "history.jsonl");
  const history = await readHistory(historyPath);
  const previous = history.at(-1);
  const changed =
    !previous ||
    previous.statusHash !== checkpoint.statusHash ||
    previous.schedulerDecision !== checkpoint.schedulerDecision ||
    previous.nextAction.code !== checkpoint.nextAction.code;

  if (!args.noWrite) {
    if (
      process.env.CONFIRM_SMIRK_PROSPECT_REVENUE_LOOP_CHECKPOINT !==
      PROSPECT_REVENUE_LOOP_CHECKPOINT_CONFIRMATION
    ) {
      throw new Error(
        `Writing requires CONFIRM_SMIRK_PROSPECT_REVENUE_LOOP_CHECKPOINT=${PROSPECT_REVENUE_LOOP_CHECKPOINT_CONFIRMATION}.`
      );
    }
    await mkdir(args.outputDir, { recursive: true, mode: 0o700 });
    if (changed) {
      const nextHistory = [...history, checkpoint]
        .map(item => JSON.stringify(item))
        .join("\n");
      await atomicWrite(historyPath, `${nextHistory}\n`);
    }
    await atomicWrite(
      latestPath,
      `${JSON.stringify(checkpoint, null, 2)}\n`
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: args.noWrite
          ? "read-only-dry-run"
          : "local-checkpoint-write",
        changed,
        historyCount: history.length + (changed ? 1 : 0),
        checkpoint,
        artifacts: args.noWrite
          ? null
          : {
              latestPath,
              historyPath,
            },
        externalAction: "none",
        productionWrite: false,
        providerRequest: false,
        emailSent: false,
        smsSent: false,
        callPlaced: false,
        spendCents: 0,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Revenue-loop checkpoint failed.",
        externalAction: "none",
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
