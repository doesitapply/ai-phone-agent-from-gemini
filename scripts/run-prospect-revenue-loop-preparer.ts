#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  prospectRevenueLoopStatusSchema,
} from "../src/prospect-revenue-loop-runner.js";
import {
  PROSPECT_REVENUE_LOOP_PREPARER_CONFIRMATION,
  PROSPECT_REVENUE_LOOP_PREPARER_PATH,
  prospectRevenueLoopPreparerReceiptSchema,
} from "../src/prospect-revenue-loop-preparer.js";

type Args = {
  prepare: boolean;
  statusFile: string | null;
  receiptFile: string | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    prepare: false,
    statusFile: null,
    receiptFile: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--prepare") {
      args.prepare = true;
      continue;
    }
    if (value === "--status-file" || value === "--receipt-file") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`${value} requires a path.`);
      }
      index += 1;
      if (value === "--status-file") {
        args.statusFile = path.resolve(next);
      } else {
        args.receiptFile = path.resolve(next);
      }
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (args.receiptFile && !args.statusFile) {
    throw new Error("--receipt-file is allowed only with --status-file.");
  }
  return args;
}

function positiveWorkspaceId(raw: string | undefined, name: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function strongKey(raw: string | undefined, name: string): string {
  const value = String(raw || "").trim();
  if (value.length < 32) {
    throw new Error(`${name} must contain at least 32 characters.`);
  }
  return value;
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

async function boundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) {
    throw new Error("The revenue-loop response exceeded the 1 MB limit.");
  }
  return JSON.parse(text);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = safeBaseUrl(
    process.env.PROSPECT_REVENUE_LOOP_BASE_URL
  );
  const observerWorkspaceId = positiveWorkspaceId(
    process.env.PROSPECT_REVENUE_LOOP_OBSERVER_WORKSPACE_ID,
    "PROSPECT_REVENUE_LOOP_OBSERVER_WORKSPACE_ID"
  );
  const preparerWorkspaceId = positiveWorkspaceId(
    process.env.PROSPECT_REVENUE_LOOP_PREPARER_WORKSPACE_ID,
    "PROSPECT_REVENUE_LOOP_PREPARER_WORKSPACE_ID"
  );
  if (observerWorkspaceId !== preparerWorkspaceId) {
    throw new Error(
      "The observer and preparer must be locked to the same workspace."
    );
  }
  const observerKey = strongKey(
    process.env.PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY,
    "PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY"
  );
  const preparerKey = strongKey(
    process.env.PROSPECT_REVENUE_LOOP_PREPARER_API_KEY,
    "PROSPECT_REVENUE_LOOP_PREPARER_API_KEY"
  );
  if (observerKey === preparerKey) {
    throw new Error("The observer and preparer keys must be distinct.");
  }

  let statusBody: unknown;
  if (args.statusFile) {
    statusBody = JSON.parse(await readFile(args.statusFile, "utf8"));
  } else {
    const statusEndpoint = new URL(
      "/api/prospecting/revenue-loop",
      baseUrl
    );
    const statusResponse = await fetch(statusEndpoint, {
      method: "GET",
      headers: {
        "X-Api-Key": observerKey,
        "X-Workspace-Id": String(observerWorkspaceId),
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    statusBody = await boundedJson(statusResponse).catch(() => null);
    if (!statusResponse.ok) {
      throw new Error(
        `Revenue-loop status returned HTTP ${statusResponse.status}.`
      );
    }
  }
  const status = prospectRevenueLoopStatusSchema.parse(statusBody);
  const eligible =
    status.nextAction.code === "PREPARE_VELVET_DISCOVERY" &&
    status.counts.unreviewedPositiveOutcomeJobs === 0;
  if (!eligible || !args.prepare) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: args.prepare ? "no-op" : "read-only-dry-run",
          decision: eligible ? "READY_TO_PREPARE" : "NO_ACTION",
          nextAction: status.nextAction,
          workspaceId: observerWorkspaceId,
          durableWrite: false,
          contactAuthorized: false,
          executionAuthorized: false,
          spendAuthorized: false,
          providerRequestAuthorized: false,
          policyMutationAuthorized: false,
          emailSent: false,
          smsSent: false,
          callPlaced: false,
          externalAction: "none",
        },
        null,
        2
      )
    );
    return;
  }
  if (
    process.env.CONFIRM_SMIRK_PROSPECT_REVENUE_LOOP_PREPARER !==
    PROSPECT_REVENUE_LOOP_PREPARER_CONFIRMATION
  ) {
    throw new Error(
      `Preparation requires CONFIRM_SMIRK_PROSPECT_REVENUE_LOOP_PREPARER=${PROSPECT_REVENUE_LOOP_PREPARER_CONFIRMATION}.`
    );
  }

  let prepareBody: unknown;
  if (args.receiptFile) {
    prepareBody = JSON.parse(await readFile(args.receiptFile, "utf8"));
  } else {
    const prepareEndpoint = new URL(
      PROSPECT_REVENUE_LOOP_PREPARER_PATH,
      baseUrl
    );
    const prepareResponse = await fetch(prepareEndpoint, {
      method: "POST",
      headers: {
        "X-Api-Key": preparerKey,
        "X-Workspace-Id": String(preparerWorkspaceId),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        confirmation: PROSPECT_REVENUE_LOOP_PREPARER_CONFIRMATION,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    prepareBody = await boundedJson(prepareResponse).catch(() => null);
    if (![200, 201].includes(prepareResponse.status)) {
      throw new Error(
        `Revenue-loop preparation returned HTTP ${prepareResponse.status}.`
      );
    }
  }
  const receipt = prospectRevenueLoopPreparerReceiptSchema.parse(
    prepareBody
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "prepare-one-review-item",
        decision: receipt.outcome,
        receipt,
        durableWrite: true,
        contactAuthorized: false,
        executionAuthorized: false,
        spendAuthorized: false,
        providerRequestAuthorized: false,
        policyMutationAuthorized: false,
        emailSent: false,
        smsSent: false,
        callPlaced: false,
        externalAction: "prepared_no_contact_review_item",
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
            : "Revenue-loop preparation failed.",
        durableWrite: false,
        contactAuthorized: false,
        executionAuthorized: false,
        spendAuthorized: false,
        providerRequestAuthorized: false,
        emailSent: false,
        smsSent: false,
        callPlaced: false,
        externalAction: "none",
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
