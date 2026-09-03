# SMIRK Data Integrity and Endpoint Audit — 2026-09-03

## Scope and Standard

This audit applies a fail-closed rule: if durable workspace storage is unavailable, SMIRK must not return a believable substitute call, contact, task, transcript, workspace, proof state, DNC record, schedule, recovery queue, or usage metric. It must return `503` with `code: DURABLE_STORAGE_UNAVAILABLE`.

The rule intentionally distinguishes an actual empty business queue from an unavailable one. An empty response is a business assertion; it is not an acceptable resilience fallback.

## Remediated Fixture Surface

The following retired fixture path was reachable through client and server no-database demo behavior and was removed from the active application:

| Removed surface | Why it was unsafe | Replacement behavior |
| --- | --- | --- |
| `src/mock-db.ts` and `src/data/mockDbData.json` | Contained fabricated Reno trade calls, contacts, tasks, transcripts, DNC state, and metrics that could be mistaken for a customer workspace. | Files deleted; no customer-facing endpoint may source data from a fixture module. |
| Server no-database mock workspace authentication | Granted a fixture workspace identity when a database was absent. | Removed; a storage-disconnected runtime cannot authenticate into a fictional customer account. |
| Client mock-workspace auto-login | Embedded a retired fixture workspace credential and auto-opened the dashboard. | Removed; the dashboard requires a real authenticated workspace. |
| Empty/zero no-database responses | Could falsely assert “nothing needs attention,” “no DNC entries,” or “no recovery work.” | Returns explicit 503 availability error. |
| Inbound SMS acknowledgement while storage was absent | Accepted an inbound message or delivery callback while silently discarding durable evidence. | Returns 503 so the provider receives a failure rather than a false acknowledgement. |

## Coverage

The no-storage guard starts a production-mode runtime with `DATABASE_URL` deliberately absent and verifies 16 persistence-backed reads/actions return `503` plus `DURABLE_STORAGE_UNAVAILABLE`. It covers workspaces, overview, profile, metrics, intelligence, triage, calls, contacts, tasks, handoffs, recovery, appointments, DNC data, and recovery direct dialing.

Fresh local validation on 2026-09-03:

```text
npm run build                                PASS
npm run -s check:no-db-storage-guard         PASS — 16 routes
npm run -s generate:openapi                  PASS — 228 declarations
npm run -s check:openapi                     PASS
fixture/mock source-reference scan           PASS — no matches
no-database successful-response scan         PASS — no matches
```

## Safe Public Production Probe

The following read-only public endpoints on `https://smirkcalls.com` returned a response during this audit: `/health`, `/livez`, `/api/version`, `/api/pricing`, `/api/first-dollar-readiness`, `/api/public-proof-snapshot`, `/api/system-health/public`, and all six public policy documents. `/api/health` intentionally returned a `307` to `/health`, which completed with `200` when followed.

This is **not** evidence that the current product release is validated. Railway shows the active production deployment as `fix: render live call period metrics`; its subsequent `docs: record Railway deployment incident` release failed at **Deploy → Create container**, while the intervening safety/dashboard releases are marked removed. The Railway source settings explicitly point to GitHub `main` with auto-deploy enabled. The stale branch name exposed in the current `/health` payload is not deployment-source proof.

## Deliberately Unproven Until Deployment Recovers

The following must not be called working until a clean active deployment includes the current source and live verification is repeated with authorized, read-only or pre-approved controlled actions:

1. Current dashboard metrics, refresh loop, and proof wording.
2. Current callback deduplication and failed-transfer fallback on a real call.
3. Stripe checkout → webhook → workspace provisioning → activation invite chain.
4. Current Business Knowledge Pack review/activation behavior in a live workspace.
5. Authenticated customer and operator endpoint behavior against the deployed source.

No production deployment, payment, outbound call, destructive cleanup, or provider setting was changed during this audit.
