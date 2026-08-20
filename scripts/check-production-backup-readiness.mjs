#!/usr/bin/env node
import {
  railwayGraphql,
  railwayVariablesGraphql,
} from "./railway-json.mjs";
import {
  DEFAULT_BACKUP_MAX_AGE_HOURS,
  DEFAULT_BACKUP_MIN_REMAINING_MINUTES,
  SMIRK_RAILWAY_PRODUCTION_TARGET,
  evaluateProviderBackupCapability,
  evaluateProductionBackupReadiness,
  selectBoundDatabaseVolume,
} from "./lib/production-backup-readiness.mjs";

const target = SMIRK_RAILWAY_PRODUCTION_TARGET;
const maxAgeHours = Number(
  process.env.SMIRK_PRODUCTION_BACKUP_MAX_AGE_HOURS
    || DEFAULT_BACKUP_MAX_AGE_HOURS
);
const minRemainingMinutes = Number(
  process.env.SMIRK_PRODUCTION_BACKUP_MIN_REMAINING_MINUTES
    || DEFAULT_BACKUP_MIN_REMAINING_MINUTES
);
const checkedAt = new Date();

function fail(error, detail = {}) {
  console.log(JSON.stringify({
    ok: false,
    error,
    checkedAt: checkedAt.toISOString(),
    target,
    providerReadOnly: true,
    externalMutation: false,
    ...detail,
  }, null, 2));
  process.exit(1);
}

try {
  const environmentData = railwayGraphql(`
    query SmirkProductionVolumeInstances(
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
    fail("railway-production-project-mismatch");
  }
  const environment = environmentData?.environment;
  const instances = environment?.volumeInstances?.edges
    ?.map((edge) => edge?.node)
    .filter(Boolean) || [];
  if (environment?.id !== target.environmentId || environment?.name !== "production") {
    fail("railway-production-environment-mismatch", {
      actualEnvironment: environment
        ? { id: environment.id || null, name: environment.name || null }
        : null,
    });
  }

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
    fail(binding.error || "production-database-binding-unverified", {
      databaseBindingVerified: false,
      matchedVolumeCount: binding.matchCount,
      discoveredVolumeCount: instances.length,
    });
  }

  const bound = binding.match;
  const backupData = railwayGraphql(`
    query SmirkProductionVolumeBackups($volumeInstanceId: String!) {
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
  `, {
    volumeInstanceId: bound.id,
  });
  const backups = backupData?.volumeInstanceBackupList || [];
  const schedules = backupData?.volumeInstanceBackupScheduleList || [];
  const readiness = evaluateProductionBackupReadiness({
    backups,
    now: checkedAt,
    maxAgeHours,
    minRemainingMinutes,
  });
  const providerBackupCapability = evaluateProviderBackupCapability({
    subscriptionType: project.subscriptionType,
    subscriptionPlanLimit: project.subscriptionPlanLimit,
  });
  const output = {
    ok: readiness.ok,
    error: readiness.ok ? null : providerBackupCapability.error || readiness.error,
    checkedAt: checkedAt.toISOString(),
    target,
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
    backupPolicy: {
      maxAgeHours,
      minRemainingMinutes,
    },
    backupCount: backups.length,
    providerBackupCapability,
    scheduleCount: schedules.length,
    schedules: schedules.map((schedule) => ({
      id: schedule.id,
      kind: schedule.kind,
      retentionSeconds: schedule.retentionSeconds,
      createdAt: schedule.createdAt,
    })),
    providerListedBackupReady: readiness.ok,
    selectedBackup: readiness.selectedBackup,
    restoreTested: false,
    providerReadOnly: true,
    externalMutation: false,
    nextAction: readiness.ok
      ? "Regenerate the exact deploy approval bundle; deploy confirmation will recheck this same provider backup."
      : providerBackupCapability.ok
        ? "Create and retain a manual backup for the bound Postgres-sTit volume in Railway's Backups tab, wait until it is listed as complete, then rerun npm run -s check:production-backup."
        : "The current Railway plan permits zero volume backups. Do not retry or change billing; wait for explicit owner authorization or a provider capability change.",
  };
  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) process.exit(1);
} catch (error) {
  fail("production-backup-provider-check-failed", {
    detail: error?.detail || String(error?.message || error),
  });
}
