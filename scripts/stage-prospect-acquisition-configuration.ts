#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  buildProspectAcquisitionConfigurationStagePlan,
  evaluateProspectAcquisitionConfigurationStageApproval,
  verifyProspectAcquisitionConfigurationStage,
} from "../src/prospect-acquisition-configuration-stage.js";
import {
  isProspectAcquisitionConfigurationPhase,
} from "../src/prospect-acquisition-configuration-plan.js";
import {
  railwayDeployments,
  railwayProjectContext,
  railwaySetVariable,
  railwayVariables,
} from "./railway-json.mjs";

const SMIRK_PRODUCTION_ORIGINS = new Set([
  "https://smirkcalls.com",
  "https://www.smirkcalls.com",
  "https://ai-phone-agent-production-6811.up.railway.app",
]);
const ACTIVE_DEPLOYMENT_STATUSES = new Set([
  "BUILDING",
  "DEPLOYING",
  "INITIALIZING",
  "QUEUED",
  "WAITING",
]);
const MAX_VALUES_FILE_BYTES = 64 * 1024;
let providerMutationAttempted = false;
const providerAcceptedNames: string[] = [];

function parseArguments(argv: string[]) {
  let phase = "";
  let valuesFile = "";
  let apply = false;
  for (const argument of argv) {
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument.startsWith("--phase=")) {
      phase = argument.slice("--phase=".length).trim();
      continue;
    }
    if (argument.startsWith("--values-file=")) {
      valuesFile = argument.slice("--values-file=".length).trim();
      continue;
    }
    throw new Error(`UNKNOWN_ARGUMENT:${argument}`);
  }
  if (!isProspectAcquisitionConfigurationPhase(phase)) {
    throw new Error("PROSPECT_ACQUISITION_STAGE_PHASE_INVALID");
  }
  if (!valuesFile) {
    throw new Error("PROSPECT_ACQUISITION_STAGE_VALUES_FILE_REQUIRED");
  }
  return {
    phase,
    valuesFile: path.resolve(valuesFile),
    apply,
  };
}

async function readPrivateAssignments(valuesFile: string, repositoryRoot: string) {
  const suppliedMetadata = await lstat(valuesFile);
  if (!suppliedMetadata.isFile() || suppliedMetadata.isSymbolicLink()) {
    throw new Error("PROSPECT_ACQUISITION_STAGE_VALUES_FILE_UNSAFE");
  }
  const [realValuesFile, realRepositoryRoot] = await Promise.all([
    realpath(valuesFile),
    realpath(repositoryRoot),
  ]);
  const relativeToRepository = path.relative(
    realRepositoryRoot,
    realValuesFile
  );
  if (
    relativeToRepository === "" ||
    (!relativeToRepository.startsWith(`..${path.sep}`) &&
      relativeToRepository !== ".." &&
      !path.isAbsolute(relativeToRepository))
  ) {
    throw new Error("PROSPECT_ACQUISITION_STAGE_VALUES_FILE_INSIDE_REPOSITORY");
  }
  const metadata = await lstat(realValuesFile);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("PROSPECT_ACQUISITION_STAGE_VALUES_FILE_UNSAFE");
  }
  if (
    metadata.dev !== suppliedMetadata.dev ||
    metadata.ino !== suppliedMetadata.ino
  ) {
    throw new Error("PROSPECT_ACQUISITION_STAGE_VALUES_FILE_CHANGED");
  }
  if (metadata.nlink !== 1) {
    throw new Error("PROSPECT_ACQUISITION_STAGE_VALUES_FILE_HARDLINK_UNSAFE");
  }
  if (metadata.size <= 0 || metadata.size > MAX_VALUES_FILE_BYTES) {
    throw new Error("PROSPECT_ACQUISITION_STAGE_VALUES_FILE_SIZE_INVALID");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("PROSPECT_ACQUISITION_STAGE_VALUES_FILE_PERMISSIONS_UNSAFE");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("PROSPECT_ACQUISITION_STAGE_VALUES_FILE_OWNER_INVALID");
  }
  const parsed = JSON.parse(await readFile(realValuesFile, "utf8")) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("PROSPECT_ACQUISITION_STAGE_VALUES_FILE_INVALID");
  }
  return parsed as Record<string, unknown>;
}

function exactProductionOrigin(raw: string): string {
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !["", "/"].includes(parsed.pathname) ||
    parsed.search ||
    parsed.hash ||
    !SMIRK_PRODUCTION_ORIGINS.has(parsed.origin)
  ) {
    throw new Error("SMIRK_ORIGIN_NOT_ALLOWLISTED");
  }
  return parsed.origin;
}

async function readLiveFingerprint(origin: string) {
  const response = await fetch(`${origin}/health`, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`SMIRK_HEALTH_HTTP_${response.status}`);
  if (!String(response.headers.get("content-type") || "").includes("application/json")) {
    throw new Error("SMIRK_HEALTH_CONTENT_TYPE_INVALID");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 64 * 1024) {
    throw new Error("SMIRK_HEALTH_RESPONSE_TOO_LARGE");
  }
  const body = JSON.parse(new TextDecoder().decode(bytes)) as {
    version?: unknown;
  };
  const bodyVersion = typeof body.version === "string" ? body.version : null;
  const headerVersion = response.headers.get("x-smirk-version");
  if (bodyVersion && headerVersion && bodyVersion !== headerVersion) {
    throw new Error("SMIRK_HEALTH_VERSION_MISMATCH");
  }
  return {
    commit: bodyVersion || headerVersion,
    readinessConfirmed: response.headers.get("x-smirk-readiness") === "1",
  };
}

function gitHead(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function gitRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function gitWorktreeClean(): boolean {
  return execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim().length === 0;
}

function gitHeadPublished(headCommit: string): boolean {
  try {
    const upstreamCommit = execFileSync(
      "git",
      ["rev-parse", "@{upstream}"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    ).trim();
    return upstreamCommit === headCommit;
  } catch {
    return false;
  }
}

function hasActiveDeployment(deployments: Array<{ status?: unknown }>) {
  return deployments.some(deployment =>
    ACTIVE_DEPLOYMENT_STATUSES.has(
      String(deployment.status || "").toUpperCase()
    )
  );
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const repositoryRoot = gitRoot();
  const requestedAssignments = await readPrivateAssignments(
    args.valuesFile,
    repositoryRoot
  );
  const context = railwayProjectContext({ quiet: true });
  const variables = railwayVariables({
    projectId: context.projectId,
    serviceId: context.serviceId,
    environmentId: context.environmentId,
    quiet: true,
  }) as Record<string, string | undefined>;
  const deployments = railwayDeployments({
    projectId: context.projectId,
    serviceId: context.serviceId,
    environmentId: context.environmentId,
    first: 20,
    quiet: true,
  });
  const origin = exactProductionOrigin(
    String(
      process.env.SMIRK_PROSPECT_ACQUISITION_STAGE_APP_URL ||
        variables.APP_URL ||
        "https://smirkcalls.com"
    ).trim()
  );
  const live = await readLiveFingerprint(origin);
  const headCommit = gitHead();
  const snapshot = {
    projectId: context.projectId,
    serviceId: context.serviceId,
    environmentId: context.environmentId,
    headCommit,
    liveCommit: live.commit,
    liveReadinessConfirmed: live.readinessConfirmed,
    deploymentIds: deployments.map(deployment => String(deployment.id)),
    activeDeploymentPresent: hasActiveDeployment(deployments),
    worktreeClean: gitWorktreeClean(),
    headPublished: gitHeadPublished(headCommit),
  };
  const plan = buildProspectAcquisitionConfigurationStagePlan({
    phase: args.phase,
    currentVariables: variables,
    requestedAssignments,
    snapshot,
  });

  if (!args.apply) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ...plan,
          mode: "dry-run",
          providerMutationPerformed: false,
          productionWritePerformed: false,
          deploymentPerformed: false,
          valuesFile: "private-file-redacted",
          note:
            "The digest binds the exact private values, target, local HEAD, and live commit. No value is printed. Apply requires the exact approval phrase and still cannot deploy or enable execution.",
        },
        null,
        2
      )}\n`
    );
    if (!plan.ok) process.exitCode = 1;
    return;
  }

  if (plan.idempotentReplay) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ...plan,
          mode: "apply-idempotent-replay",
          providerMutationPerformed: false,
          productionWritePerformed: false,
          deploymentPerformed: false,
          runtimeActivated: false,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const approval = evaluateProspectAcquisitionConfigurationStageApproval({
    plan,
    providedApproval:
      process.env.SMIRK_PROSPECT_ACQUISITION_STAGE_APPROVAL || null,
  });
  if (!approval.authorized) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          contractVersion: plan.contractVersion,
          mode: "apply-refused",
          phase: args.phase,
          blockers: approval.blockers,
          assignmentDigest: plan.assignmentDigest,
          assignmentNames: plan.assignmentNames,
          providerMutationPerformed: false,
          productionWritePerformed: false,
          deploymentPerformed: false,
          valuesDisclosed: false,
        },
        null,
        2
      )}\n`
    );
    process.exitCode = 1;
    return;
  }

  providerMutationAttempted = true;
  for (const name of plan.changedNames) {
    const value = requestedAssignments[name];
    if (typeof value !== "string") {
      throw new Error(`STAGE_VALUE_UNAVAILABLE_AFTER_APPROVAL:${name}`);
    }
    const result = railwaySetVariable(name, value, {
      projectId: context.projectId,
      serviceId: context.serviceId,
      environmentId: context.environmentId,
      quiet: true,
      skipDeploys: true,
      graphqlOnly: true,
    });
    if (!result.ok) {
      throw new Error(`RAILWAY_VARIABLE_SET_REJECTED:${name}`);
    }
    providerAcceptedNames.push(name);
  }

  await new Promise(resolve => setTimeout(resolve, 3_000));

  const afterVariables = railwayVariables({
    projectId: context.projectId,
    serviceId: context.serviceId,
    environmentId: context.environmentId,
    quiet: true,
  }) as Record<string, string | undefined>;
  const afterDeployments = railwayDeployments({
    projectId: context.projectId,
    serviceId: context.serviceId,
    environmentId: context.environmentId,
    first: 20,
    quiet: true,
  });
  const verification = verifyProspectAcquisitionConfigurationStage({
    phase: args.phase,
    beforeVariables: variables,
    afterVariables,
    requestedAssignments,
    snapshot,
    afterDeploymentIds: afterDeployments.map(deployment =>
      String(deployment.id)
    ),
    acceptedAssignmentNames: providerAcceptedNames,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        ...verification,
        mode: "apply-stage-only",
        productionWritePerformed:
          verification.productionConfigurationStaged,
        externalAction: "railway-variables-staged-without-deploy",
      },
      null,
      2
    )}\n`
  );
  if (!verification.ok) process.exitCode = 1;
}

main().catch(error => {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: false,
        mode: process.argv.includes("--apply")
          ? "apply-failed"
          : "dry-run-failed",
        error: error instanceof Error ? error.message : "UNKNOWN_FAILURE",
        providerMutationAttempted,
        providerAcceptedNames,
        providerMutationState:
          providerAcceptedNames.length > 0
            ? "PARTIAL_OR_COMPLETE_REQUIRES_VERIFICATION"
            : providerMutationAttempted
              ? "ATTEMPTED_NO_ACCEPTANCE_RECORDED"
              : "NOT_ATTEMPTED",
        valuesDisclosed: false,
        deploymentPerformed: false,
        runtimeActivated: false,
        contactAuthorized: false,
        spendAuthorized: false,
      },
      null,
      2
    )}\n`
  );
  process.exitCode = 1;
});
