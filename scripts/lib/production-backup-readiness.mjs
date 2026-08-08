export const SMIRK_RAILWAY_PRODUCTION_TARGET = Object.freeze({
  projectId: "90599f03-6d6f-4044-8933-e0301be67a82",
  appServiceId: "96bcd6e7-9487-4197-bcd1-a6bd0546e6b2",
  environmentId: "22e0a5a3-43bf-4b6c-8fa6-635e7c94b84a",
});

export const DEFAULT_BACKUP_MAX_AGE_HOURS = 24;
export const DEFAULT_BACKUP_MIN_REMAINING_MINUTES = 60;

export function evaluateProviderBackupCapability({
  subscriptionType,
  subscriptionPlanLimit,
} = {}) {
  const normalizedSubscriptionType = typeof subscriptionType === "string"
    ? subscriptionType.trim().toLowerCase()
    : null;
  const rawMaxBackupsCount = subscriptionPlanLimit?.volumes?.maxBackupsCount;
  const maxBackupsCount = Number(rawMaxBackupsCount);
  if (!normalizedSubscriptionType || !Number.isFinite(maxBackupsCount)) {
    return {
      ok: false,
      error: "railway-backup-plan-limit-unconfirmed",
      subscriptionType: normalizedSubscriptionType,
      maxBackupsCount: null,
    };
  }
  if (maxBackupsCount < 1) {
    return {
      ok: false,
      error: "railway-backups-unavailable-on-current-plan",
      subscriptionType: normalizedSubscriptionType,
      maxBackupsCount,
    };
  }
  return {
    ok: true,
    error: null,
    subscriptionType: normalizedSubscriptionType,
    maxBackupsCount,
  };
}

export function databaseEndpointFingerprint(value) {
  try {
    const url = new URL(String(value || ""));
    if (!url.hostname || !url.pathname) return null;
    return `${url.hostname.toLowerCase()}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return null;
  }
}

export function selectBoundDatabaseVolume({
  appDatabaseUrl,
  volumeCandidates,
}) {
  const appFingerprint = databaseEndpointFingerprint(appDatabaseUrl);
  if (!appFingerprint) {
    return {
      ok: false,
      error: "application-database-url-missing-or-invalid",
      match: null,
      matchCount: 0,
    };
  }

  const matches = (Array.isArray(volumeCandidates) ? volumeCandidates : [])
    .filter((candidate) => {
      const candidateFingerprints = [
        candidate?.databaseUrl,
        candidate?.databasePublicUrl,
        candidate?.postgresUrl,
      ]
        .map(databaseEndpointFingerprint)
        .filter(Boolean);
      return candidateFingerprints.includes(appFingerprint);
    });

  return {
    ok: matches.length === 1,
    error: matches.length === 0
      ? "application-database-volume-not-found"
      : (matches.length > 1 ? "application-database-volume-ambiguous" : null),
    match: matches.length === 1 ? matches[0] : null,
    matchCount: matches.length,
  };
}

export function evaluateProductionBackupReadiness({
  backups,
  now = new Date(),
  maxAgeHours = DEFAULT_BACKUP_MAX_AGE_HOURS,
  minRemainingMinutes = DEFAULT_BACKUP_MIN_REMAINING_MINUTES,
}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const maxAgeMs = Number(maxAgeHours) * 60 * 60 * 1000;
  const minRemainingMs = Number(minRemainingMinutes) * 60 * 1000;

  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0
    || !Number.isFinite(minRemainingMs) || minRemainingMs < 0) {
    return {
      ok: false,
      error: "invalid-backup-readiness-window",
      eligibleBackups: [],
      selectedBackup: null,
    };
  }

  const eligibleBackups = (Array.isArray(backups) ? backups : [])
    .map((backup) => {
      const createdAtMs = new Date(backup?.createdAt).getTime();
      const expiresAtMs = backup?.expiresAt
        ? new Date(backup.expiresAt).getTime()
        : null;
      const ageMs = nowMs - createdAtMs;
      const remainingMs = expiresAtMs === null ? null : expiresAtMs - nowMs;
      const eligible = Boolean(
        String(backup?.id || "").trim()
        && String(backup?.name || "").trim()
        && Number.isFinite(createdAtMs)
        && ageMs >= 0
        && ageMs <= maxAgeMs
        && (
          expiresAtMs === null
          || (Number.isFinite(expiresAtMs) && remainingMs >= minRemainingMs)
        )
      );
      return {
        id: String(backup?.id || "").trim() || null,
        name: String(backup?.name || "").trim() || null,
        createdAt: Number.isFinite(createdAtMs)
          ? new Date(createdAtMs).toISOString()
          : null,
        expiresAt: expiresAtMs === null
          ? null
          : (Number.isFinite(expiresAtMs)
            ? new Date(expiresAtMs).toISOString()
            : null),
        usedMB: Number.isFinite(Number(backup?.usedMB))
          ? Number(backup.usedMB)
          : null,
        referencedMB: Number.isFinite(Number(backup?.referencedMB))
          ? Number(backup.referencedMB)
          : null,
        eligible,
      };
    })
    .filter((backup) => backup.eligible)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return {
    ok: eligibleBackups.length > 0,
    error: eligibleBackups.length > 0
      ? null
      : "fresh-provider-backup-not-found",
    eligibleBackups,
    selectedBackup: eligibleBackups[0] || null,
  };
}
