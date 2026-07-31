# Production Database Backup Gate

SMIRK must not deploy schema-bearing code unless Railway lists a fresh backup
for the exact Postgres volume used by the application.

## Read-only verification

Run:

```bash
npm run -s check:production-backup
```

The checker:

- reads the pinned Railway production project, environment, and app service;
- resolves the app's `DATABASE_URL` without printing it;
- matches that endpoint to exactly one Postgres service and volume;
- lists backups and schedules for that exact volume instance;
- requires a provider-listed backup created within the last 24 hours;
- requires at least 60 minutes before an expiring backup expires;
- exits nonzero on a missing, ambiguous, stale, future, or expiring backup;
- performs no provider mutation.

The current production binding is:

- service: `Postgres-sTit`
- volume: `postgres-volume-82PP`
- mount: `/var/lib/postgresql/data`

Provider IDs are emitted by the checker and are not credentials. Database URLs,
users, and passwords are never emitted.

## Creating a backup

Creating or scheduling a backup changes Railway state and can incur storage
cost. It requires a separate owner action; the checker never creates one.

In Railway, open the `Postgres-sTit` service, open **Backups**, create a manual
backup for `postgres-volume-82PP`, and wait until Railway lists it as complete.
Railway's backup and restore behavior is documented at:

https://docs.railway.com/volumes/backups

Then run:

```bash
npm run -s check:production-backup
npm run write:deploy-approval-bundle
npm run -s check:deploy-post-call-fix-ready
```

The approval card remains tokenless until the fresh backup, exact database
binding, clean commit, live fingerprint, and all other deploy gates pass.
Deploy confirmation re-runs the provider check immediately before upload.

## Evidence boundary

A provider-listed backup proves that Railway exposes a backup for the exact
bound volume. It does not prove that SMIRK performed a restore drill.

Restoring a backup is a separate production mutation and deploy. Never restore,
swap, detach, or delete a production volume as part of the ordinary deploy
path. Obtain explicit approval for the exact restore operation and collect a
new database binding proof before any cutover.

## Schema scope

The pending prospecting changes are additive or constraint-tightening:

- add workspace and research provenance columns;
- add guarded Velvet request, event, outreach, suppression, outcome, experiment,
  learning, and inbox-placement tables;
- add indexes and idempotency constraints;
- make legacy prospect phone optional;
- remove the temporary default from campaign `workspace_id`;
- extend the Velvet outcome state constraint to include `SENDING`.

They do not drop a table, drop a column, truncate data, or delete production
rows. They can still acquire PostgreSQL locks while columns, constraints, and
indexes are created, which is why the fresh backup and exact-commit gate remain
mandatory.
