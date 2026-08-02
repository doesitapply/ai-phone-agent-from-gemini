#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  VELVET_HANDOFF_CONTAINMENT_APPROVAL,
  VELVET_HANDOFF_CREDENTIAL_VARIABLE,
  buildVelvetHandoffContainmentPlan,
  evaluateVelvetHandoffContainmentApproval,
  verifyVelvetHandoffContainmentStage,
} from "../src/velvet-handoff-containment.js";
import { inspectSmirkSyntheticHandoffSource } from "../src/velvet-handoff-live-safety.js";
import {
  railwayDeployments,
  railwayProjectContext,
  railwayStageDeleteVariable,
  railwayVariables,
} from "./railway-json.mjs";

const SMIRK_PRODUCTION_ORIGINS = new Set([
  "https://smirkcalls.com",
  "https://www.smirkcalls.com",
  "https://ai-phone-agent-production-6811.up.railway.app",
]);
const FETCH_TIMEOUT_MS = 15_000;
const MAX_HEALTH_BYTES = 64 * 1024;
let providerMutationAttempted = false;
let providerMutationAccepted = false;

function parseArguments(argv: string[]) {
  const unknown = argv.filter(argument => argument !== "--apply");
  if (unknown.length > 0) {
    throw new Error(`UNKNOWN_ARGUMENT:${unknown.join(",")}`);
  }
  return { apply: argv.includes("--apply") };
}

function trustedSmirkOrigin(raw: string): string {
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
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`SMIRK_HEALTH_HTTP_${response.status}`);
  if (!String(response.headers.get("content-type") || "").includes("application/json")) {
    throw new Error("SMIRK_HEALTH_CONTENT_TYPE_INVALID");
  }
  const announcedLength = Number(response.headers.get("content-length") || "0");
  if (announcedLength > MAX_HEALTH_BYTES) {
    throw new Error("SMIRK_HEALTH_RESPONSE_TOO_LARGE");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_HEALTH_BYTES) {
    throw new Error("SMIRK_HEALTH_RESPONSE_TOO_LARGE");
  }
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
    version?: unknown;
  };
  const bodyVersion =
    typeof parsed.version === "string" ? parsed.version : null;
  const headerVersion = response.headers.get("x-smirk-version");
  if (bodyVersion && headerVersion && bodyVersion !== headerVersion) {
    throw new Error("SMIRK_HEALTH_VERSION_MISMATCH");
  }
  return {
    commit: bodyVersion || headerVersion,
    readinessConfirmed: response.headers.get("x-smirk-readiness") === "1",
  };
}

function readLiveSource(commit: string | null): string | null {
  if (!commit || !/^[a-f0-9]{40}$/i.test(commit)) return null;
  try {
    const domain = execFileSync(
      "git",
      ["show", `${commit}:src/velvet-handoff.ts`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const route = execFileSync(
      "git",
      ["show", `${commit}:src/routes/velvet-handoff-routes.ts`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return `${domain}\n${route}`;
  } catch {
    return null;
  }
}

function activeDeploymentPresent(deployments: Array<{ status?: unknown }>) {
  const activeStatuses = new Set([
    "BUILDING",
    "DEPLOYING",
    "INITIALIZING",
    "QUEUED",
    "WAITING",
  ]);
  return deployments.some(deployment =>
    activeStatuses.has(String(deployment.status || "").toUpperCase())
  );
}

function approvalCommand(snapshot: {
  projectId: string;
  serviceId: string;
  environmentId: string;
  liveCommit: string | null;
}) {
  return [
    `SMIRK_PROVIDER_MUTATION_APPROVAL=${VELVET_HANDOFF_CONTAINMENT_APPROVAL}`,
    `SMIRK_EXPECTED_RAILWAY_PROJECT_ID=${snapshot.projectId}`,
    `SMIRK_EXPECTED_RAILWAY_SERVICE_ID=${snapshot.serviceId}`,
    `SMIRK_EXPECTED_RAILWAY_ENVIRONMENT_ID=${snapshot.environmentId}`,
    `SMIRK_EXPECTED_LIVE_COMMIT=${snapshot.liveCommit || "UNCONFIRMED"}`,
    "npm run -s stage:disable-legacy-velvet-handoff -- --apply",
  ].join(" ");
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
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
  const smirkOrigin = trustedSmirkOrigin(
    String(
      process.env.SMIRK_HANDOFF_SAFETY_APP_URL ||
        variables.APP_URL ||
        "https://smirkcalls.com"
    ).trim()
  );
  const live = await readLiveFingerprint(smirkOrigin);
  const liveSource = readLiveSource(live.commit);
  const sourceInspection = inspectSmirkSyntheticHandoffSource(liveSource);
  const snapshot = {
    projectId: context.projectId,
    serviceId: context.serviceId,
    environmentId: context.environmentId,
    liveCommit: live.commit,
    liveReadinessConfirmed: live.readinessConfirmed,
    liveSourceAvailable: sourceInspection.available,
    liveSyntheticBoundaryPresent:
      sourceInspection.syntheticBoundaryPresent,
    targetVariablePresent: Boolean(
      String(variables[VELVET_HANDOFF_CREDENTIAL_VARIABLE] || "").trim()
    ),
    variableCount: Object.keys(variables).length,
    deploymentIds: deployments.map(deployment => String(deployment.id)),
  };
  const plan = buildVelvetHandoffContainmentPlan(snapshot);

  if (!args.apply) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ...plan,
          mode: "dry-run",
          providerMutationPerformed: false,
          productionWritePerformed: false,
          approvalCommand: plan.ok && plan.mutationRequired
            ? approvalCommand(snapshot)
            : null,
          note:
            "This command stages one Railway variable deletion only after exact approval. It does not deploy or prove the running receiver is contained.",
        },
        null,
        2
      )}\n`
    );
    if (!plan.ok) process.exitCode = 1;
    return;
  }

  if (!snapshot.targetVariablePresent) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ...plan,
          ok: plan.ok,
          mode: "apply-idempotent-replay",
          providerMutationPerformed: false,
          productionWritePerformed: false,
          runtimeContained: false,
          nextGate:
            "The variable is already absent from Railway configuration. Separately verify which variables the running revision actually has before claiming containment.",
        },
        null,
        2
      )}\n`
    );
    if (!plan.ok) process.exitCode = 1;
    return;
  }

  const approval = evaluateVelvetHandoffContainmentApproval(snapshot, {
    approvalPhrase:
      process.env.SMIRK_PROVIDER_MUTATION_APPROVAL || null,
    expectedProjectId:
      process.env.SMIRK_EXPECTED_RAILWAY_PROJECT_ID || null,
    expectedServiceId:
      process.env.SMIRK_EXPECTED_RAILWAY_SERVICE_ID || null,
    expectedEnvironmentId:
      process.env.SMIRK_EXPECTED_RAILWAY_ENVIRONMENT_ID || null,
    expectedLiveCommit:
      process.env.SMIRK_EXPECTED_LIVE_COMMIT || null,
  });
  if (!approval.authorized) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          mode: "apply-refused",
          blockers: approval.blockers,
          targetVariable: approval.targetVariable,
          providerMutationPerformed: false,
          productionWritePerformed: false,
          deploymentPerformed: false,
        },
        null,
        2
      )}\n`
    );
    process.exitCode = 1;
    return;
  }
  if (activeDeploymentPresent(deployments)) {
    throw new Error("ACTIVE_RAILWAY_DEPLOYMENT_BLOCKS_STAGED_CONTAINMENT");
  }

  providerMutationAttempted = true;
  const mutation = railwayStageDeleteVariable(
    VELVET_HANDOFF_CREDENTIAL_VARIABLE,
    {
      projectId: context.projectId,
      serviceId: context.serviceId,
      environmentId: context.environmentId,
      quiet: true,
    }
  );
  providerMutationAccepted = mutation.ok === true;

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
  const verification = verifyVelvetHandoffContainmentStage({
    mutationAccepted: mutation.ok === true,
    beforeVariables: variables,
    afterVariables,
    beforeDeploymentIds: snapshot.deploymentIds,
    afterDeploymentIds: afterDeployments.map(deployment =>
      String(deployment.id)
    ),
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        ...verification,
        mode: "apply-stage-only",
        exactTarget: plan.exactTarget,
        productionWritePerformed: true,
        externalAction: "railway-variable-deletion-staged",
        note:
          "No deployment was authorized. Runtime containment remains unproven until a separately approved deploy and live fail-closed verification.",
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
        error:
          error instanceof Error ? error.message : "UNKNOWN_FAILURE",
        providerMutationAttempted,
        providerMutationAccepted,
        providerMutationState: providerMutationAccepted
          ? "ACCEPTED_VERIFICATION_INCOMPLETE"
          : providerMutationAttempted
            ? "UNKNOWN_AFTER_ATTEMPT"
            : "NOT_ATTEMPTED",
        deploymentPerformed: false,
        runtimeContained: false,
      },
      null,
      2
    )}\n`
  );
  process.exitCode = 1;
});
