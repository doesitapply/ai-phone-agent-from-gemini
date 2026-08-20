import { createHash, timingSafeEqual } from "node:crypto";
import {
  SMIRK_RAILWAY_PRODUCTION_TARGET,
  evaluateProductionBackupReadiness,
} from "./production-backup-readiness.mjs";

export const PRODUCTION_BACKUP_CREATE_CONTRACT =
  "smirk.production-backup-create.v1";
export const PRODUCTION_BACKUP_CREATE_APPROVAL_PREFIX =
  "APPROVE_CREATE_SMIRK_PRODUCTION_BACKUP";
export const SMIRK_PRODUCTION_DATABASE_EXPECTATION = Object.freeze({
  serviceName: "Postgres-sTit",
  volumeName: "postgres-volume-82PP",
  mountPath: "/var/lib/postgresql/data",
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function exactStringEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function validCommit(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
}

function validProviderId(value) {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/.test(value);
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

export function productionBackupIds(backups) {
  return (Array.isArray(backups) ? backups : [])
    .map((backup) => String(backup?.id || "").trim())
    .filter(Boolean)
    .sort();
}

function normalizedDeploymentIds(deployments) {
  return (Array.isArray(deployments) ? deployments : [])
    .map((deployment) => String(deployment || "").trim())
    .filter(Boolean)
    .sort();
}

export function productionBackupTimeoutMs(value, fallbackSeconds = 180) {
  const configuredSeconds = value === undefined || value === null ||
    String(value).trim() === ""
    ? Number.NaN
    : Number(value);
  const safeFallbackSeconds = Number.isFinite(Number(fallbackSeconds))
    ? Number(fallbackSeconds)
    : 180;
  const selectedSeconds = Number.isFinite(configuredSeconds)
    ? configuredSeconds
    : safeFallbackSeconds;
  return Math.min(600_000, Math.max(30_000, selectedSeconds * 1_000));
}

export function buildProductionBackupCreatePlan(input) {
  const snapshot = input?.snapshot || {};
  const database = snapshot.database || {};
  const blockers = [];

  if (snapshot.projectId !== SMIRK_RAILWAY_PRODUCTION_TARGET.projectId) {
    blockers.push("RAILWAY_PROJECT_NOT_SMIRK_PRODUCTION");
  }
  if (snapshot.appServiceId !== SMIRK_RAILWAY_PRODUCTION_TARGET.appServiceId) {
    blockers.push("RAILWAY_APP_SERVICE_NOT_SMIRK_PRODUCTION");
  }
  if (snapshot.environmentId !== SMIRK_RAILWAY_PRODUCTION_TARGET.environmentId) {
    blockers.push("RAILWAY_ENVIRONMENT_NOT_SMIRK_PRODUCTION");
  }
  if (snapshot.environmentName !== "production") {
    blockers.push("RAILWAY_ENVIRONMENT_NAME_NOT_PRODUCTION");
  }
  if (snapshot.databaseBindingVerified !== true) {
    blockers.push("PRODUCTION_DATABASE_BINDING_UNVERIFIED");
  }
  if (!validProviderId(database.serviceId)) {
    blockers.push("PRODUCTION_DATABASE_SERVICE_ID_INVALID");
  }
  if (!validProviderId(database.volumeId)) {
    blockers.push("PRODUCTION_DATABASE_VOLUME_ID_INVALID");
  }
  if (!validProviderId(database.volumeInstanceId)) {
    blockers.push("PRODUCTION_DATABASE_VOLUME_INSTANCE_ID_INVALID");
  }
  if (database.serviceName !== SMIRK_PRODUCTION_DATABASE_EXPECTATION.serviceName) {
    blockers.push("PRODUCTION_DATABASE_SERVICE_NAME_MISMATCH");
  }
  if (database.volumeName !== SMIRK_PRODUCTION_DATABASE_EXPECTATION.volumeName) {
    blockers.push("PRODUCTION_DATABASE_VOLUME_NAME_MISMATCH");
  }
  if (database.mountPath !== SMIRK_PRODUCTION_DATABASE_EXPECTATION.mountPath) {
    blockers.push("PRODUCTION_DATABASE_MOUNT_PATH_MISMATCH");
  }
  if (database.state !== "READY") {
    blockers.push("PRODUCTION_DATABASE_VOLUME_NOT_READY");
  }
  if (
    !Number.isFinite(Number(database.currentSizeMB)) ||
    Number(database.currentSizeMB) <= 0 ||
    !Number.isFinite(Number(database.capacityMB)) ||
    Number(database.capacityMB) < Number(database.currentSizeMB)
  ) {
    blockers.push("PRODUCTION_DATABASE_VOLUME_SIZE_INVALID");
  }
  if (!validCommit(snapshot.headCommit)) {
    blockers.push("LOCAL_HEAD_COMMIT_UNCONFIRMED");
  }
  if (!validCommit(snapshot.liveCommit)) {
    blockers.push("LIVE_SMIRK_COMMIT_UNCONFIRMED");
  }
  if (snapshot.liveReadinessConfirmed !== true) {
    blockers.push("LIVE_SMIRK_READINESS_UNCONFIRMED");
  }
  if (snapshot.worktreeClean !== true) {
    blockers.push("LOCAL_WORKTREE_DIRTY");
  }
  if (snapshot.headPublished !== true) {
    blockers.push("LOCAL_HEAD_NOT_PUBLISHED");
  }
  if (snapshot.activeDeploymentPresent === true) {
    blockers.push("ACTIVE_RAILWAY_DEPLOYMENT_PRESENT");
  }

  const readiness = evaluateProductionBackupReadiness({
    backups: snapshot.backups,
    now: snapshot.checkedAt,
  });
  const backupAlreadyReady = readiness.ok === true;
  if (!backupAlreadyReady && snapshot.providerBackupCapability?.ok !== true) {
    blockers.push(
      snapshot.providerBackupCapability?.error ===
          "railway-backups-unavailable-on-current-plan"
        ? "RAILWAY_BACKUPS_UNAVAILABLE_ON_CURRENT_PLAN"
        : "RAILWAY_BACKUP_PLAN_LIMIT_UNCONFIRMED"
    );
  }
  const backupName = validCommit(snapshot.headCommit) &&
    validCommit(snapshot.liveCommit)
    ? `smirk-predeploy-${snapshot.headCommit.slice(0, 12)}-${snapshot.liveCommit.slice(0, 12)}`
    : "smirk-predeploy-unconfirmed";
  const beforeBackupIds = productionBackupIds(snapshot.backups);
  const beforeDeploymentIds = normalizedDeploymentIds(snapshot.deploymentIds);
  const requestDigest = sha256({
    contractVersion: PRODUCTION_BACKUP_CREATE_CONTRACT,
    target: {
      projectId: snapshot.projectId,
      appServiceId: snapshot.appServiceId,
      environmentId: snapshot.environmentId,
      databaseServiceId: database.serviceId,
      volumeId: database.volumeId,
      volumeInstanceId: database.volumeInstanceId,
    },
    headCommit: snapshot.headCommit,
    liveCommit: snapshot.liveCommit,
    backupName,
    beforeBackupIds,
    beforeDeploymentIds,
  });
  const computedApprovalPhrase = [
    PRODUCTION_BACKUP_CREATE_APPROVAL_PREFIX,
    `digest=${requestDigest}`,
    `volume=${database.volumeInstanceId || "UNCONFIRMED"}`,
    `name=${backupName}`,
    `head=${snapshot.headCommit || "UNCONFIRMED"}`,
    `live=${snapshot.liveCommit || "UNCONFIRMED"}`,
    "action=create-one-backup-only",
  ].join(": ");
  const uniqueBlockers = sortedUnique(blockers);
  const approvalPhrase = uniqueBlockers.length === 0 && !backupAlreadyReady
    ? computedApprovalPhrase
    : null;

  return {
    contractVersion: PRODUCTION_BACKUP_CREATE_CONTRACT,
    ok: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    mutationRequired: uniqueBlockers.length === 0 && !backupAlreadyReady,
    idempotentReplay: uniqueBlockers.length === 0 && backupAlreadyReady,
    backupAlreadyReady,
    selectedExistingBackup: readiness.selectedBackup,
    backupName,
    requestDigest,
    approvalPhrase,
    exactTarget: {
      projectId: snapshot.projectId || null,
      appServiceId: snapshot.appServiceId || null,
      environmentId: snapshot.environmentId || null,
      databaseServiceId: database.serviceId || null,
      volumeId: database.volumeId || null,
      volumeInstanceId: database.volumeInstanceId || null,
      headCommit: snapshot.headCommit || null,
      liveCommit: snapshot.liveCommit || null,
    },
    observed: {
      databaseServiceName: database.serviceName || null,
      volumeName: database.volumeName || null,
      mountPath: database.mountPath || null,
      volumeState: database.state || null,
      currentSizeMB: Number.isFinite(Number(database.currentSizeMB))
        ? Number(database.currentSizeMB)
        : null,
      capacityMB: Number.isFinite(Number(database.capacityMB))
        ? Number(database.capacityMB)
        : null,
      backupCount: Array.isArray(snapshot.backups)
        ? snapshot.backups.length
        : 0,
      scheduleCount: Array.isArray(snapshot.schedules)
        ? snapshot.schedules.length
        : 0,
      deploymentCount: Array.isArray(snapshot.deploymentIds)
        ? snapshot.deploymentIds.length
        : 0,
      liveReadinessConfirmed: snapshot.liveReadinessConfirmed === true,
      worktreeClean: snapshot.worktreeClean === true,
      headPublished: snapshot.headPublished === true,
      activeDeploymentPresent: snapshot.activeDeploymentPresent === true,
      subscriptionType:
        snapshot.providerBackupCapability?.subscriptionType || null,
      maxBackupsCount:
        snapshot.providerBackupCapability?.maxBackupsCount !== null &&
        snapshot.providerBackupCapability?.maxBackupsCount !== undefined &&
        Number.isFinite(Number(
          snapshot.providerBackupCapability.maxBackupsCount
        ))
        ? Number(snapshot.providerBackupCapability.maxBackupsCount)
        : null,
    },
    guardrails: {
      providerMutationAuthorized: false,
      backupCreateAuthorized: false,
      backupDeleteAuthorized: false,
      backupRestoreAuthorized: false,
      backupScheduleChangeAuthorized: false,
      deploymentAuthorized: false,
      applicationDataMutationAuthorized: false,
      contactAuthorized: false,
      spendAuthorizedBeyondProviderBackupStorage: false,
    },
    nextGate:
      uniqueBlockers.length > 0
        ? "Resolve the named blockers and regenerate the exact backup request."
        : backupAlreadyReady
          ? "A fresh provider-listed backup already satisfies the deploy backup gate. Regenerate the deploy approval bundle."
          : "Obtain the exact digest-bound approval to create this one backup. No restore, delete, schedule, deploy, or application-data authority is included.",
  };
}

export function evaluateProductionBackupCreateApproval({
  plan,
  providedApproval,
}) {
  const blockers = [...(plan?.blockers || [])];
  if (plan?.mutationRequired !== true) {
    blockers.push("PRODUCTION_BACKUP_CREATE_NOT_REQUIRED");
  }
  if (!exactStringEqual(providedApproval, plan?.approvalPhrase)) {
    blockers.push("EXACT_PRODUCTION_BACKUP_APPROVAL_MISSING");
  }
  const uniqueBlockers = sortedUnique(blockers);
  return {
    authorized: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    requestDigest: plan?.requestDigest || null,
    backupName: plan?.backupName || null,
    backupCreateAuthorized: uniqueBlockers.length === 0,
    backupDeleteAuthorized: false,
    backupRestoreAuthorized: false,
    backupScheduleChangeAuthorized: false,
    deploymentAuthorized: false,
    applicationDataMutationAuthorized: false,
  };
}

export function verifyProductionBackupCreate({
  plan,
  workflowStatus,
  workflowError = null,
  afterBackups,
  afterDeploymentIds,
  verifiedAt,
  providerMutationPerformed = true,
}) {
  const blockers = [];
  if (plan?.ok !== true || plan?.mutationRequired !== true) {
    blockers.push("PRODUCTION_BACKUP_CREATE_PLAN_NOT_EXECUTABLE");
  }
  if (workflowStatus !== "Complete") {
    blockers.push(
      workflowStatus === "Error"
        ? "PRODUCTION_BACKUP_WORKFLOW_FAILED"
        : "PRODUCTION_BACKUP_WORKFLOW_NOT_COMPLETE"
    );
  }
  if (workflowError) blockers.push("PRODUCTION_BACKUP_WORKFLOW_ERROR_PRESENT");

  const beforeIds = new Set(
    plan?.beforeBackupIds || []
  );
  const exactBackup = (Array.isArray(afterBackups) ? afterBackups : [])
    .filter((backup) => String(backup?.name || "") === plan?.backupName)
    .filter((backup) => !beforeIds.has(String(backup?.id || "")))
    .sort((left, right) =>
      String(right?.createdAt || "").localeCompare(String(left?.createdAt || ""))
    )[0] || null;
  if (!exactBackup) blockers.push("EXACT_CREATED_BACKUP_NOT_LISTED");

  const readiness = evaluateProductionBackupReadiness({
    backups: exactBackup ? [exactBackup] : [],
    now: verifiedAt,
  });
  if (!readiness.ok) blockers.push("CREATED_BACKUP_NOT_FRESH_OR_RETAINED");

  const previousDeployments = new Set(plan?.beforeDeploymentIds || []);
  const newDeploymentIds = (Array.isArray(afterDeploymentIds)
    ? afterDeploymentIds
    : [])
    .map(String)
    .filter((id) => !previousDeployments.has(id));
  if (newDeploymentIds.length > 0) {
    blockers.push("UNEXPECTED_DEPLOYMENT_OBSERVED");
  }
  const uniqueBlockers = sortedUnique(blockers);

  return {
    contractVersion: PRODUCTION_BACKUP_CREATE_CONTRACT,
    ok: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    requestDigest: plan?.requestDigest || null,
    backupName: plan?.backupName || null,
    selectedBackup: readiness.selectedBackup,
    workflowStatus,
    workflowError,
    deploymentObservation: {
      beforeCount: (plan?.beforeDeploymentIds || []).length,
      afterCount: Array.isArray(afterDeploymentIds)
        ? afterDeploymentIds.length
        : 0,
      newDeploymentIds,
    },
    providerMutationPerformed: providerMutationPerformed === true,
    backupCreated: uniqueBlockers.length === 0,
    restoreTested: false,
    deploymentPerformed: false,
    unexpectedDeploymentObserved: newDeploymentIds.length > 0,
    guardrails: {
      backupDeletePerformed: false,
      backupRestorePerformed: false,
      backupScheduleChanged: false,
      applicationDataMutationPerformed: false,
      contactPerformed: false,
    },
    nextGate:
      uniqueBlockers.length === 0
        ? "Rerun the read-only production backup check, then regenerate the exact deploy approval bundle."
        : "Stop. Do not retry creation automatically; inspect the workflow and provider backup list first.",
  };
}

export function bindProductionBackupCreatePlanRuntime(plan, snapshot) {
  return {
    ...plan,
    beforeBackupIds: productionBackupIds(snapshot?.backups),
    beforeDeploymentIds: normalizedDeploymentIds(snapshot?.deploymentIds),
  };
}
