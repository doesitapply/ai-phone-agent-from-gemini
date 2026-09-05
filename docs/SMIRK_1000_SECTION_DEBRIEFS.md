# SMIRK 1000/1000 Section Debriefs

Last guidance update: September 5, 2026 America/Los_Angeles.

This file tracks each completed implementation section in the final-mile sprint. The implementation history remains useful, but current access guidance is the one sellable Starter offer, billing-entitled tenant-scoped workspace APIs, and operator APIs behind `requireOperator`; the old July plan-denial proof is not the current model.

## Section: Webhook Buffer Lag Monitor

### What Was Added

- Added `npm run check:webhook-buffer-lag` for operator-visible stale buffer detection.
- Added `scripts/check-webhook-buffer-lag.mjs`, which reports `received` and `retry` rows older than `WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES`.
- Added the evidence artifact `output/webhook-buffer-lag.json`.

### What Changed

- The webhook buffer now has capture, replay, and lag visibility.
- Operators can distinguish a healthy empty/young buffer from stale unreplayed call events.
- `npm run -s check:webhook-buffer` now verifies that the lag monitor exists alongside replay.

### What Is Next

- Run the lag check against production after live deploy parity is restored.
- Add scheduling or external alerting only after real traffic shows what threshold is practical.
- Use lag output to decide whether replay should be manual, scheduled, or event-driven.

### What Is Out Of Control

- Production buffer lag cannot be measured from the current local checkout until the current commit is deployed.
- Real alerting depends on the hosting/runtime platform chosen for scheduled checks.

### How To Make It Controllable

- Deploy the current commit, then run `WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag` with production `DATABASE_URL`.
- If stale rows appear, run `npm run replay:webhook-buffer` first, then apply only with `CONFIRM_WEBHOOK_BUFFER_REPLAY=process-buffered-webhooks`.
- Put the lag command under a scheduler after the first real customer proves the buffer threshold.

## Section: Durable Webhook Replay Worker

### What Was Added

- Added a guarded replay worker for rows captured in `webhook_event_buffer`.
- Added dry-run and explicit apply commands:
  - `npm run replay:webhook-buffer`
  - `CONFIRM_WEBHOOK_BUFFER_REPLAY=process-buffered-webhooks npm run replay:webhook-buffer:apply`
- Added replay contract checks to `npm run -s check:webhook-buffer`.

### What Changed

- The durable intake buffer is no longer just raw capture. It now has an operator-controlled path to replay `received` and `retry` rows back into `calls`.
- Replay is tenant-conservative: rows without a workspace ID are deferred unless an operator explicitly sets `WEBHOOK_BUFFER_REPLAY_DEFAULT_WORKSPACE_ID`.
- The roadmap now describes Stage 1B as implemented instead of deferred.

### What Is Next

- Run the replay worker against a real buffered-row sample after live deploy parity is restored.
- Watch whether buffered events are actually needed under real traffic before adding Redis or more database architecture.
- Keep Starter Owner Chaos Testing as the next target-specific access proof after deployment. The compatibility command `npm run check:basic-chaos` must return `STARTER_OWNER_CHAOS_PASSED`; a local result is not production proof.

### What Is Out Of Control

- Live production is still running an older commit until the guarded deploy is approved and completed.
- Real customer call behavior is not fully controllable from local tests.
- Railway availability, deploy rate limits, and production secret access remain external platform constraints.

### How To Make It Controllable

- Restore live parity with the guarded deploy flow.
- Run replay in dry-run first, then apply only with the explicit confirmation token.
- Add alerting on buffered rows older than a small threshold after the first real customer is live.
- Use one approved billing-entitled Starter workspace for the concurrent owner-API and masked-credential check. Verify operator-only routes separately with `requireOperator`; do not infer a sellable Pro entitlement from legacy labels.
