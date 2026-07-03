# SMIRK First-Customer 10/10 Runbook

Last checked: 2026-07-03 UTC

## Current Verdict

SMIRK is deploy-current and close to an operator-assisted first customer.

As of the latest deploy check on 2026-07-03 UTC, local HEAD and live Railway both report `e0ebecb11e2514d38e6fa009828a31b3c39e283f` on `cleanup/stop-tracking-generated-deploy-output`. The guarded deploy succeeded, `npm run -s check:ship-live` passed, live Railway env checks are readable, and `npm run -s check:first-customer-10of10` now fails only on the deliberate production-write proof gate.

It is not a fully proven hands-off SaaS 10/10 until one approved production checkout/provisioning smoke or real paid customer activation is completed end to end and cleaned up or retained as the first customer record.

## Current Evidence

Live parity check:

```bash
npm run -s check:live-is-current
```

Current result: passing at `e0ebecb11e2514d38e6fa009828a31b3c39e283f`.

Expected branch:

```text
cleanup/stop-tracking-generated-deploy-output
```

Passing non-mutating evidence gathered on 2026-07-03 UTC:

- `npm audit --audit-level=moderate`
- `npm run -s check:local-runtime-smoke`
- `npm run -s check:customer-dashboard`
- `npm run -s check:plan-boundaries`
- `npm run -s check:live-workspace-entitlements`
- `npm run -s check:contact-management`
- `npm run -s check:cors-security`
- `npm run -s check:stripe-webhook-signature-live`
- `npm run -s check:stripe-webhook-handoff-live:preflight`
- `npm run -s check:stripe-webhook-smoke-approval-ready`
- `npm run -s check:proof-artifacts-live`
- `npm run -s check:post-call-intelligence-live`
- `npm run -s check:dashboard-proof-live`
- `npm run lint`
- `npm run build`
- `npm run -s check:ship-live`

Remaining incomplete or approval-gated evidence:

- `npm run -s check:first-customer-10of10`: fails by design until an approved production checkout/provisioning write proof exists.
- Starter/Basic live-token blocking is still static-contract-covered because current production has only a Pro workspace. It becomes live-proven when the approved provisioning smoke or a real Starter/Basic customer creates a live Starter/Basic workspace.

The whole non-mutating readiness bundle is wrapped by:

```bash
npm run -s check:first-customer-10of10
```

That command is expected to fail until an approved production checkout/provisioning write proof exists.

Current live evidence:

- Live app is current at `e0ebecb11e2514d38e6fa009828a31b3c39e283f`.
- Railway latest failed deploy check passes.
- Live buyer routes, operational auth, DB health, proof artifacts, post-call intelligence, dashboard proof, and public proof snapshot pass.
- Customer dashboard and plan boundary contracts pass for the deployed branch.
- Starter/Basic live-token blocking remains static-contract-covered until the approved provisioning smoke or a real Starter/Basic customer creates a live Starter/Basic workspace.
- Cleanup dry-run against `https://www.smirkcalls.com` returns 200 and matches 0 smoke workspaces and 0 provisioning requests.

Video artifact:

```text
output/playwright/smirk-e2e-production-2026-07-02-narrated-masked.mp4
```

This video proves the production screen flow: public site, pricing, authenticated customer workspace, and the simplified customer dashboard. It does not prove a new paid Stripe fulfillment or new live phone call.

## What A Real 10/10 Means

SMIRK gets a realistic first-customer 10/10 only when every item below is true with current evidence:

| Gate | Proof Required | Current Status |
| --- | --- | --- |
| Production deploy is current | `check:live-is-current` and `check:latest-failed-deploy` pass | Pass: live `e0ebecb11e2514d38e6fa009828a31b3c39e283f`; no failed deploys |
| Dependency/security floor is clean | `npm audit --audit-level=moderate` passes | Pass |
| Production browser security defaults are sane | `check:cors-security` passes | Pass |
| Public buyer path is live | `check:buyer-routes-live` or `check:ship-live` passes | Pass |
| Customer dashboard is plan-gated | `check:customer-dashboard` and `check:plan-boundaries` pass; Starter/Basic gets Calls, Contacts, Tasks; Pro/Agency gets the full customer suite; operator tools stay operator-only; `check:live-workspace-entitlements` proves the current live workspace-token boundary without mutation | Pass for deployed Pro workspace; Starter/Basic remains static-contract-covered until a live Starter/Basic workspace exists |
| Contact/DNC operator cleanup exists | `check:contact-management` passes | Pass |
| Signed Stripe webhook works | `check:stripe-webhook-signature-live` passes | Pass |
| Checkout/provisioning mutating smoke is proven | Approved `check:stripe-webhook-handoff-live` or real paid buyer activation creates and verifies a workspace/provisioning record | Approval gated |
| Smoke records are handled | Dry-run reviewed, then cleanup applied only after separate approval or retained as real customer evidence | Pass dry-run baseline: 0 matched workspaces, 0 matched provisioning requests |
| Proof call path is fresh | Existing live proof checks pass, or approved real proof call is pinned and verified | Pass: live proof checks and public proof freshness pass on current deploy |
| Runbook exists | This file plus approval artifacts document exact stop/go commands | Pass |

## Approval-Gated Commands

Do not run these from memory. Use the exact phrases.

### Full Stripe Webhook Smoke

This creates a real production smoke workspace/provisioning path when auto-fulfillment is enabled.

Approval phrase:

```bash
APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE: ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live
```

Command:

```bash
ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live
```

Expected proof:

- Webhook response returns `received=true`.
- Provisioning/workspace evidence is visible to the smoke checker.
- Public checkout status returns safe labels and does not expose raw Stripe session data.
- Cleanup dry-run can see the created smoke records before success is reported.
- The checker writes `output/stripe-webhook-handoff-live.json` with the current live deploy fingerprint.
- `npm run -s check:first-customer-10of10` recognizes the proof artifact.

### Smoke Cleanup

Always run dry-run first:

```bash
APP_URL=https://www.smirkcalls.com npm run cleanup:smoke-workspaces
```

Apply cleanup only after separate explicit approval:

```bash
APPROVE_SMIRK_SMOKE_CLEANUP_APPLY: APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply
```

### Paid Handoff Manual-Fallback Smoke

This creates a live SMIRK Smoke Test provisioning request to prove paid signup reaches a tracked manual fallback.

Approval phrase:

```bash
APPROVE_SMIRK_PAID_HANDOFF_LIVE_WRITE: CONFIRM_SMIRK_PAID_HANDOFF_LIVE_WRITE=create-live-smirk-paid-handoff-smoke npm run check:paid-handoff-live
```

Command:

```bash
CONFIRM_SMIRK_PAID_HANDOFF_LIVE_WRITE=create-live-smirk-paid-handoff-smoke npm run check:paid-handoff-live
```

Run cleanup dry-run afterward and apply cleanup only after separate cleanup approval.

### Real Proof Call

Preflight:

```bash
npm run check:real-call-readiness
npm run -s print:real-call-setup
```

Only dial an allowlisted safe target from the readiness output:

```bash
npm run check:real-call-readiness -- <safe-number>
npm run proof:real-call -- <safe-number>
```

Expected proof:

- A pinned call SID is captured.
- `check:proof-artifacts-live` passes for that call.
- `check:post-call-intelligence-live` passes for that call.
- `check:dashboard-proof-live` counters move.
- Owner alert and callback task are present.

## Executable 10/10 Gate

Run:

```bash
npm run -s check:first-customer-10of10
```

This command is non-mutating. It verifies live parity, failed deploy status, dependency audit, public buyer routes, local runtime smoke, customer dashboard scope, plan boundary mapping, live workspace entitlement proof, server-side plan gating for pro-suite APIs, contact/DNC controls, signed webhook verification, Stripe smoke approval readiness, live proof artifacts, post-call intelligence, dashboard proof, and a freshly executed smoke cleanup dry-run against `https://www.smirkcalls.com`.

The cleanup baseline is refreshed during the gate. Do not treat an old `output/smoke-workspace-cleanup-dry-run.json` file as enough evidence by itself.

It fails until one of these approved production-write artifacts exists:

```text
output/stripe-webhook-handoff-live.json
output/paid-handoff-live.json
```

The artifact must include a `liveDeploy` fingerprint matching the current deployed commit and branch. This prevents stale smoke files from making the gate pass after a later deploy.

That failure is intentional. It prevents calling the product 10/10 while the checkout/provisioning proof is still approval-gated.

## First-Customer Operating Procedure

1. Keep the offer narrow: missed-call recovery only.
2. Confirm live deploy and audit gates:

```bash
npm run -s check:live-is-current
npm run -s check:latest-failed-deploy
npm run -s check:railway
npm audit --audit-level=moderate
npm run -s check:cors-security
npm run -s check:post-deploy-live
```

3. Confirm customer UI and contact safety:

```bash
npm run -s check:customer-dashboard
npm run -s check:contact-management
```

4. Confirm Stripe readiness without mutation:

```bash
npm run -s check:stripe-webhook-signature-live
npm run -s check:stripe-webhook-handoff-live:preflight
npm run -s check:stripe-webhook-smoke-approval-ready
```

5. Run either an approved full Stripe webhook smoke or a real paid buyer activation.
6. Verify workspace/provisioning evidence.
7. Run an approved proof call, or verify the first real missed call creates the required artifacts.
8. Confirm owner email, callback task, dashboard proof, and public masked proof.
9. Clean up smoke records only with separate cleanup approval.
10. Record the final evidence in this file or a dated customer launch note.

## Stop Conditions

Stop and do not call it 10/10 if any of these are true:

- Live commit does not match local HEAD.
- Railway shows a failed deploy.
- `npm audit --audit-level=moderate` fails.
- Customer dashboard exposes operator-only tabs to a workspace session.
- Stripe webhook smoke has not been explicitly approved.
- Cleanup apply has not been separately approved.
- Proof-call target was not selected from the guarded allowlist.
- Public proof leaks caller phone numbers, transcripts, recordings, raw task notes, or Stripe data.

## Plain-English Status

The product is currently deploy-current. The current branch contains the Basic/Pro dashboard split, plan-boundary verifier, Railway GraphQL fallback for rate-limited CLI reads/writes, CORS hardening, and clearer acceptance diagnostics. Production is serving `e0ebecb11e2514d38e6fa009828a31b3c39e283f`.

The product should not be marketed as a fully hands-off SaaS machine until an approved production checkout/provisioning run proves the paid path again on the current deployed build. That is the only failing top-level 10/10 gate after the 2026-07-03 deploy.
