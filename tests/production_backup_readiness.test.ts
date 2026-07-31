import assert from "node:assert/strict";
import test from "node:test";
import {
  databaseEndpointFingerprint,
  evaluateProductionBackupReadiness,
  selectBoundDatabaseVolume,
} from "../scripts/lib/production-backup-readiness.mjs";

const now = new Date("2026-07-30T20:00:00.000Z");

test("database endpoint fingerprints never expose credentials", () => {
  const fingerprint = databaseEndpointFingerprint(
    "postgresql://secret-user:secret-password@db.example.test:5432/smirk"
  );
  assert.equal(fingerprint, "db.example.test:5432/smirk");
  assert.equal(fingerprint?.includes("secret"), false);
});

test("the application database must bind to exactly one production volume", () => {
  const result = selectBoundDatabaseVolume({
    appDatabaseUrl:
      "postgresql://app:password@bound.example.test:5432/smirk",
    volumeCandidates: [
      {
        id: "bound",
        databaseUrl:
          "postgresql://db:other@bound.example.test:5432/smirk",
      },
      {
        id: "other",
        databaseUrl:
          "postgresql://db:other@other.example.test:5432/smirk",
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.match?.id, "bound");

  const ambiguous = selectBoundDatabaseVolume({
    appDatabaseUrl:
      "postgresql://app:password@bound.example.test:5432/smirk",
    volumeCandidates: [
      {
        id: "one",
        databaseUrl:
          "postgresql://db:one@bound.example.test:5432/smirk",
      },
      {
        id: "two",
        databasePublicUrl:
          "postgresql://db:two@bound.example.test:5432/smirk",
      },
    ],
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error, "application-database-volume-ambiguous");
});

test("no, stale, expired, or future backups fail closed", () => {
  assert.equal(
    evaluateProductionBackupReadiness({ backups: [], now }).ok,
    false
  );
  assert.equal(
    evaluateProductionBackupReadiness({
      now,
      backups: [{
        id: "old",
        name: "old",
        createdAt: "2026-07-28T19:00:00.000Z",
        expiresAt: "2026-08-01T20:00:00.000Z",
      }],
    }).ok,
    false
  );
  assert.equal(
    evaluateProductionBackupReadiness({
      now,
      backups: [{
        id: "expiring",
        name: "expiring",
        createdAt: "2026-07-30T19:00:00.000Z",
        expiresAt: "2026-07-30T20:30:00.000Z",
      }],
    }).ok,
    false
  );
  assert.equal(
    evaluateProductionBackupReadiness({
      now,
      backups: [{
        id: "future",
        name: "future",
        createdAt: "2026-07-30T21:00:00.000Z",
        expiresAt: "2026-08-01T20:00:00.000Z",
      }],
    }).ok,
    false
  );
});

test("a fresh provider-listed backup is selected without claiming a restore test", () => {
  const result = evaluateProductionBackupReadiness({
    now,
    backups: [
      {
        id: "older",
        name: "older",
        createdAt: "2026-07-30T18:00:00.000Z",
        expiresAt: "2026-08-01T20:00:00.000Z",
        usedMB: 4,
        referencedMB: 1000,
      },
      {
        id: "newer",
        name: "newer",
        createdAt: "2026-07-30T19:30:00.000Z",
        expiresAt: null,
        usedMB: 1,
        referencedMB: 1000,
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.selectedBackup?.id, "newer");
});
