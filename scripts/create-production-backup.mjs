#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import {
  railwayDeployments,
  railwayGraphql,
  railwayVariablesGraphql,
} from "./railway-json.mjs";
import {
  SMIRK_RAILWAY_PRODUCTION_TARGET,
  evaluateProviderBackupCapability,
  selectBoundDatabaseVolume,
} from "./lib/production-backup-readiness.mjs";
import {
  bindProductionBackupCreatePlanRuntime,
  buildProductionBackupCreatePlan,
  evaluateProductionBackupCreateApproval,
  productionBackupIds,
  productionBackupTimeoutMs,
  verifyProductionBackupCreate,
} from "./lib/production-backup-create.mjs";
import {
  claimProductionBackupReceipt,
  updateProductionBackupReceipt,
} from "./lib/production-backup-receipt.mjs";

const ACTIVE_DEPLOYMENT_STATUSES = new Set([
  "BUILDING",
  "DEPLOYING",
  "INITIALIZING",
  "QUEUED",
  "WAITING",
]);
const SMIRK_PRODUCTION_ORIGINS = new Set([
  "https://smirkcalls.com",
  "https://www.smirkcalls.com",
  "https://ai-phone-agent-production-6811.up.railway.app",
]);
const WORKFLOW_POLL_MS = 3_000;
const WORKFLOW_TIMEOUT_MS = productionBackupTimeoutMs(
  process.env.SMIRK_PRODUCTION_BACKUP_WORKFLOW_TIMEOUT_SECONDS
);
const RECEIPT_DIRECTORY = path.join(
  homedir(),
  ".openclaw",
  "workspace",
  "state",
  "smirk-production-backups"
);
let providerMutationAttempted = false;
let providerWorkflowId = null;

function parseArguments(argv) {
  const unknown = argv.filter((argument) => argument !== "--apply");
  if (unknown.length > 0) {
    throw new Error(`UNKNOWN_ARGUMENT:${unknown.join(",")}`);
  }
  return { apply: argv.includes("--apply") };
}

function sleep(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function exactProductionOrigin(raw) {
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

async function readLiveFingerprint(origin) {
  const response = await fetch(`${origin}/health`, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`SMIRK_HEALTH_HTTP_${response.status}`);
  if (!String(response.headers.get("content-type") || "").includes("application/json")) {
    throw new Error("SMIRK_HEALTH_CONTENT_TYPE_INVALID");
  }
  const announcedLength = Number(response.headers.get("content-length") || "0");
  if (announcedLength > 64 * 1024) {
    throw new Error("SMIRK_HEALTH_RESPONSE_TOO_LARGE");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 64 * 1024) {
    throw new Error("SMIRK_HEALTH_RESPONSE_TOO_LARGE");
  }
  const body = JSON.parse(new TextDecoder().decode(bytes));
  const bodyVersion = typeof body?.version === "string" ? body.version : null;
  const headerVersion = response.headers.get("x-smirk-version");
  if (bodyVersion && headerVersion && bodyVersion !== headerVersion) {
    throw new Error("SMIRK_HEALTH_VERSION_MISMATCH");
  }
  return {
    commit: bodyVersion || headerVersion,
    readinessConfirmed: response.headers.get("x-smirk-readiness") === "1",
  };
}

function gitHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function gitWorktreeClean() {
  return execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim().length === 0;
}

function gitHeadPublished(headCommit) {
  try {
    return execFileSync("git", ["rev-parse", "@{upstream}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() === headCommit;
  } catch {
    return false;
  }
}

function activeDeploymentPresent(deployments) {
  return deployments.some((deployment) =>
    ACTIVE_DEPLOYMENT_STATUSES.has(
      String(deployment?.status || "").toUpperCase()
    )
  );
}

function deploymentIds(deployments) {
  return deployments.map((deployment) => String(deployment?.id || ""))
    .filter(Boolean)
    .sort();
}

function listVolumeBackups(volumeInstanceId) {
  const data = railwayGraphql(`
    query SmirkProductionVolumeBackupsForCreate($volumeInstanceId: String!) {
      volumeInstanceBackupList(volumeInstanceId: $volumeInstanceId) {
        id
        name
        createdAt
        expiresAt
        usedMB
        referencedMB
      }
      volumeInstanceBackupScheduleList(volumeInstanceId: $volumeInstanceId) {
        id
        kind
        retentionSeconds
        createdAt
      }
    }
  `, { volumeInstanceId });
  return {
    backups: data?.volumeInstanceBackupList || [],
    schedules: data?.volumeInstanceBackupScheduleList || [],
  };
}

async function readSnapshot() {
  const target = SMIRK_RAILWAY_PRODUCTION_TARGET;
  const environmentData = railwayGraphql(`
    query SmirkProductionVolumeInstancesForBackupCreate(
      $environmentId: String!,
      $projectId: String!
    ) {
      project(id: $projectId) {
        id
        subscriptionType
        subscriptionPlanLimit
      }
      environment(id: $environmentId, projectId: $projectId) {
        id
        name
        volumeInstances(first: 50) {
          edges {
            node {
              id
              volumeId
              serviceId
              mountPath
              currentSizeMB
              sizeMB
              state
              volume { name }
              service { name }
            }
          }
        }
      }
    }
  `, {
    environmentId: target.environmentId,
    projectId: target.projectId,
  });
  const project = environmentData?.project;
  if (project?.id !== target.projectId) {
    throw new Error("RAILWAY_PRODUCTION_PROJECT_MISMATCH");
  }
  const environment = environmentData?.environment;
  if (
    environment?.id !== target.environmentId ||
    environment?.name !== "production"
  ) {
    throw new Error("RAILWAY_PRODUCTION_ENVIRONMENT_MISMATCH");
  }
  const instances = environment?.volumeInstances?.edges
    ?.map((edge) => edge?.node)
    .filter(Boolean) || [];
  const appVariables = railwayVariablesGraphql({
    projectId: target.projectId,
    serviceId: target.appServiceId,
    environmentId: target.environmentId,
    quiet: true,
  });
  const volumeCandidates = instances.map((instance) => {
    const variables = railwayVariablesGraphql({
      projectId: target.projectId,
      serviceId: instance.serviceId,
      environmentId: target.environmentId,
      quiet: true,
    });
    return {
      ...instance,
      databaseUrl: variables.DATABASE_URL,
      databasePublicUrl: variables.DATABASE_PUBLIC_URL,
      postgresUrl: variables.POSTGRES_URL,
    };
  });
  const binding = selectBoundDatabaseVolume({
    appDatabaseUrl: appVariables.DATABASE_URL,
    volumeCandidates,
  });
  if (!binding.ok || !binding.match) {
    throw new Error(
      String(binding.error || "PRODUCTION_DATABASE_BINDING_UNVERIFIED")
    );
  }
  const bound = binding.match;
  const providerBackupState = listVolumeBackups(bound.id);
  const deployments = railwayDeployments({
    projectId: target.projectId,
    serviceId: target.appServiceId,
    environmentId: target.environmentId,
    first: 20,
    quiet: true,
  });
  const origin = exactProductionOrigin(
    String(
      process.env.SMIRK_PRODUCTION_BACKUP_APP_URL ||
        appVariables.APP_URL ||
        "https://smirkcalls.com"
    ).trim()
  );
  const live = await readLiveFingerprint(origin);
  const headCommit = gitHead();
  return {
    projectId: target.projectId,
    appServiceId: target.appServiceId,
    environmentId: target.environmentId,
    environmentName: environment.name,
    databaseBindingVerified: true,
    database: {
      serviceId: bound.serviceId,
      serviceName: bound.service?.name || null,
      volumeId: bound.volumeId,
      volumeName: bound.volume?.name || null,
      volumeInstanceId: bound.id,
      mountPath: bound.mountPath,
      state: bound.state,
      currentSizeMB: Number(bound.currentSizeMB),
      capacityMB: Number(bound.sizeMB),
    },
    headCommit,
    liveCommit: live.commit,
    liveReadinessConfirmed: live.readinessConfirmed,
    worktreeClean: gitWorktreeClean(),
    headPublished: gitHeadPublished(headCommit),
    activeDeploymentPresent: activeDeploymentPresent(deployments),
    deploymentIds: deploymentIds(deployments),
    backups: providerBackupState.backups,
    schedules: providerBackupState.schedules,
    providerBackupCapability: evaluateProviderBackupCapability({
      subscriptionType: project.subscriptionType,
      subscriptionPlanLimit: project.subscriptionPlanLimit,
    }),
    checkedAt: new Date().toISOString(),
  };
}

function createBackup(plan) {
  const data = railwayGraphql(`
    mutation SmirkProductionVolumeBackupCreate(
      $name: String,
      $volumeInstanceId: String!
    ) {
      volumeInstanceBackupCreate(
        name: $name,
        volumeInstanceId: $volumeInstanceId
      ) {
        workflowId
      }
    }
  `, {
    name: plan.backupName,
    volumeInstanceId: plan.exactTarget.volumeInstanceId,
  });
  const workflowId = String(
    data?.volumeInstanceBackupCreate?.workflowId || ""
  ).trim();
  if (!workflowId) throw new Error("RAILWAY_BACKUP_WORKFLOW_ID_MISSING");
  return workflowId;
}

function readWorkflowStatus(workflowId) {
  const data = railwayGraphql(`
    query SmirkProductionBackupWorkflow($workflowId: String!) {
      workflowStatus(workflowId: $workflowId) {
        status
        error
      }
    }
  `, { workflowId });
  return {
    status: String(data?.workflowStatus?.status || "NotFound"),
    error: data?.workflowStatus?.error
      ? String(data.workflowStatus.error)
      : null,
  };
}

function waitForWorkflow(workflowId) {
  const startedAt = Date.now();
  let state = { status: "Running", error: null };
  while (Date.now() - startedAt < WORKFLOW_TIMEOUT_MS) {
    state = readWorkflowStatus(workflowId);
    if (["Complete", "Error", "NotFound"].includes(state.status)) {
      return state;
    }
    sleep(WORKFLOW_POLL_MS);
  }
  return { status: "Running", error: "WORKFLOW_VERIFICATION_TIMEOUT" };
}

function waitForExactBackup(volumeInstanceId, backupName) {
  const startedAt = Date.now();
  let state = listVolumeBackups(volumeInstanceId);
  while (Date.now() - startedAt < WORKFLOW_TIMEOUT_MS) {
    if (state.backups.some((backup) => backup?.name === backupName)) {
      return state;
    }
    sleep(WORKFLOW_POLL_MS);
    state = listVolumeBackups(volumeInstanceId);
  }
  return state;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const snapshot = await readSnapshot();
  const plan = bindProductionBackupCreatePlanRuntime(
    buildProductionBackupCreatePlan({ snapshot }),
    snapshot
  );
  const {
    beforeBackupIds: _beforeBackupIds,
    beforeDeploymentIds: _beforeDeploymentIds,
    ...publicPlan
  } = plan;

  if (!args.apply) {
    process.stdout.write(`${JSON.stringify({
      ...publicPlan,
      mode: "dry-run",
      providerMutationPerformed: false,
      productionWritePerformed: false,
      deploymentPerformed: false,
      applicationDataMutationPerformed: false,
      note:
        "This request can create exactly one backup for the bound production volume after exact approval. It cannot restore, delete, schedule, deploy, or modify application data.",
    }, null, 2)}\n`);
    if (!plan.ok) process.exitCode = 1;
    return;
  }

  if (plan.idempotentReplay) {
    process.stdout.write(`${JSON.stringify({
      ...publicPlan,
      mode: "apply-idempotent-replay",
      providerMutationPerformed: false,
      productionWritePerformed: false,
      deploymentPerformed: false,
      applicationDataMutationPerformed: false,
    }, null, 2)}\n`);
    return;
  }

  const approval = evaluateProductionBackupCreateApproval({
    plan,
    providedApproval:
      process.env.SMIRK_PRODUCTION_BACKUP_CREATE_APPROVAL || null,
  });
  if (!approval.authorized) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      contractVersion: plan.contractVersion,
      mode: "apply-refused",
      blockers: approval.blockers,
      requestDigest: plan.requestDigest,
      backupName: plan.backupName,
      exactTarget: plan.exactTarget,
      providerMutationPerformed: false,
      productionWritePerformed: false,
      deploymentPerformed: false,
      applicationDataMutationPerformed: false,
    }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const preMutationDeployments = railwayDeployments({
    projectId: plan.exactTarget.projectId,
    serviceId: plan.exactTarget.appServiceId,
    environmentId: plan.exactTarget.environmentId,
    first: 20,
    quiet: true,
  });
  if (
    activeDeploymentPresent(preMutationDeployments) ||
    JSON.stringify(deploymentIds(preMutationDeployments)) !==
      JSON.stringify(plan.beforeDeploymentIds)
  ) {
    throw new Error("RAILWAY_DEPLOYMENT_SET_CHANGED_BEFORE_BACKUP");
  }
  const preMutationBackupState = listVolumeBackups(
    plan.exactTarget.volumeInstanceId
  );
  if (
    JSON.stringify(productionBackupIds(preMutationBackupState.backups)) !==
      JSON.stringify(plan.beforeBackupIds)
  ) {
    throw new Error("RAILWAY_BACKUP_SET_CHANGED_BEFORE_BACKUP");
  }

  const claim = claimProductionBackupReceipt({
    plan,
    receiptDirectory: RECEIPT_DIRECTORY,
  });
  if (!claim.created && !claim.receipt?.workflowId) {
    throw new Error("PRODUCTION_BACKUP_REQUEST_CLAIMED_WITHOUT_WORKFLOW");
  }
  const reconciliationOnly = !claim.created;
  if (reconciliationOnly) {
    providerWorkflowId = String(claim.receipt.workflowId);
  } else {
    providerMutationAttempted = true;
    providerWorkflowId = createBackup(plan);
    updateProductionBackupReceipt({
      plan,
      receiptDirectory: RECEIPT_DIRECTORY,
      changes: {
        status: "WORKFLOW_ACCEPTED",
        workflowId: providerWorkflowId,
        workflowAcceptedAt: new Date().toISOString(),
      },
    });
  }
  const workflow = waitForWorkflow(providerWorkflowId);
  const afterProviderState = workflow.status === "Complete"
    ? waitForExactBackup(
        plan.exactTarget.volumeInstanceId,
        plan.backupName
      )
    : listVolumeBackups(plan.exactTarget.volumeInstanceId);
  const afterDeployments = railwayDeployments({
    projectId: plan.exactTarget.projectId,
    serviceId: plan.exactTarget.appServiceId,
    environmentId: plan.exactTarget.environmentId,
    first: 20,
    quiet: true,
  });
  const verification = verifyProductionBackupCreate({
    plan,
    workflowStatus: workflow.status,
    workflowError: workflow.error,
    afterBackups: afterProviderState.backups,
    afterDeploymentIds: deploymentIds(afterDeployments),
    verifiedAt: new Date().toISOString(),
    providerMutationPerformed: providerMutationAttempted,
  });
  updateProductionBackupReceipt({
    plan,
    receiptDirectory: RECEIPT_DIRECTORY,
    changes: verification.ok
      ? {
          status: "VERIFIED",
          workflowId: providerWorkflowId,
          backupId: verification.selectedBackup?.id || null,
          verifiedAt: new Date().toISOString(),
        }
      : {
          status: "FAILED",
          workflowId: providerWorkflowId,
          verificationBlockers: verification.blockers,
        },
  });

  process.stdout.write(`${JSON.stringify({
    ...verification,
    mode: verification.ok
      ? "apply-create-verified"
      : "apply-create-verification-failed",
    workflowId: providerWorkflowId,
    reconciliationOnly,
    exactTarget: plan.exactTarget,
    productionWritePerformed: providerMutationAttempted,
    externalAction: providerMutationAttempted
      ? "railway-production-volume-backup-create"
      : "none-reconciled-existing-workflow",
    scheduleCountAfter: afterProviderState.schedules.length,
  }, null, 2)}\n`);
  if (!verification.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    mode: process.argv.includes("--apply")
      ? "apply-failed"
      : "dry-run-failed",
    error: error instanceof Error ? error.message : "UNKNOWN_FAILURE",
    providerMutationAttempted,
    workflowId: providerWorkflowId,
    providerMutationState: providerWorkflowId
      ? "ACCEPTED_VERIFICATION_INCOMPLETE"
      : providerMutationAttempted
        ? "ATTEMPTED_NO_WORKFLOW_ID"
        : "NOT_ATTEMPTED",
    productionWritePerformed: providerWorkflowId
      ? true
      : providerMutationAttempted
        ? null
        : false,
    deploymentPerformed: false,
    unexpectedDeploymentObserved: null,
    applicationDataMutationPerformed: false,
    backupDeletePerformed: false,
    backupRestorePerformed: false,
    backupScheduleChanged: false,
    contactPerformed: false,
  }, null, 2)}\n`);
  process.exitCode = 1;
});
