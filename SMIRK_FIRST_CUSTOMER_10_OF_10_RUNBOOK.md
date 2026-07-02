# SMIRK First-Customer 10/10 Runbook

Last checked: 2026-07-02

## Current Verdict

SMIRK is live and ready for an operator-assisted first customer.

It is not yet a fully proven hands-off SaaS 10/10 until one approved production checkout/provisioning smoke or real paid customer activation is completed end to end and cleaned up or retained as the first customer record.

## Current Evidence

Verified live commit:

```bash
npm run -s check:live-is-current
```

Expected branch:

```text
cleanup/stop-tracking-generated-deploy-output
```

Passing evidence gathered on 2026-07-02:

- `npm run -s check:live-is-current`
- `npm run -s check:latest-failed-deploy`
- `npm audit --audit-level=moderate`
- `npm run -s check:stripe-webhook-signature-live`
- `npm run -s check:stripe-webhook-handoff-live:preflight`
- `npm run -s check:stripe-webhook-smoke-approval-ready`
- `npm run -s check:dashboard-proof-live`
- `npm run -s check:proof-artifacts-live`
- `npm run -s check:post-call-intelligence-live`
- `npm run -s check:local-runtime-smoke`
- `npm run -s check:customer-dashboard`
- `npm run -s check:contact-management`

The whole non-mutating readiness bundle is wrapped by:

```bash
npm run -s check:first-customer-10of10
```

That command is expected to fail until an approved production checkout/provisioning write proof exists.

Production evidence:

- Live app reports the deployed commit above.
- Railway reports no failed deployments.
- `npm audit --audit-level=moderate` reports `found 0 vulnerabilities`.
- Live Stripe signature-only webhook verification returns `verified: true` without mutation.
- Live Stripe preflight confirms auto-fulfillment is enabled and full smoke is approval-gated.
- Stripe smoke cleanup baseline reports `0` smoke workspaces and `0` smoke provisioning requests.
- Live public proof is fresh, cache-protected, and has no leaked private fields.
- Live proof counters include `104` total calls, `97` summaries, `109` callback tasks, `30` owner email alerts, and `27` complete proof calls.
- Customer dashboard contract confirms normal workspace users see only Calls, Contacts, and Tasks, with owner-safe error copy.

Video artifact:

```text
output/playwright/smirk-e2e-production-2026-07-02-narrated-masked.mp4
```

This video proves the production screen flow: public site, pricing, authenticated customer workspace, and the simplified customer dashboard. It does not prove a new paid Stripe fulfillment or new live phone call.

## What A Real 10/10 Means

SMIRK gets a realistic first-customer 10/10 only when every item below is true with current evidence:

| Gate | Proof Required | Current Status |
| --- | --- | --- |
| Production deploy is current | `check:live-is-current` and `check:latest-failed-deploy` pass | Pass |
| Dependency/security floor is clean | `npm audit --audit-level=moderate` passes | Pass |
| Public buyer path is live | `check:buyer-routes-live` or `check:ship-live` passes | Pass in latest deploy run |
| Customer UI is simplified | `check:customer-dashboard` passes and production video shows owner view | Pass |
| Contact/DNC operator cleanup exists | `check:contact-management` passes | Pass |
| Signed Stripe webhook works | `check:stripe-webhook-signature-live` passes | Pass, non-mutating |
| Checkout/provisioning mutating smoke is proven | Approved `check:stripe-webhook-handoff-live` or real paid buyer activation creates and verifies a workspace/provisioning record | Approval gated |
| Smoke records are handled | Dry-run reviewed, then cleanup applied only after separate approval or retained as real customer evidence | Approval gated |
| Proof call path is fresh | Existing live proof checks pass, or approved real proof call is pinned and verified | Existing proof pass; new call approval gated |
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
- The checker writes `output/stripe-webhook-handoff-live.json`.
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

This command is non-mutating. It verifies live parity, failed deploy status, dependency audit, public buyer routes, local runtime smoke, customer dashboard scope, contact/DNC controls, signed webhook verification, Stripe smoke approval readiness, live proof artifacts, post-call intelligence, dashboard proof, and smoke cleanup baseline.

It fails until one of these approved production-write artifacts exists:

```text
output/stripe-webhook-handoff-live.json
output/paid-handoff-live.json
```

That failure is intentional. It prevents calling the product 10/10 while the checkout/provisioning proof is still approval-gated.

## First-Customer Operating Procedure

1. Keep the offer narrow: missed-call recovery only.
2. Confirm live deploy and audit gates:

```bash
npm run -s check:live-is-current
npm run -s check:latest-failed-deploy
npm audit --audit-level=moderate
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

The product can take a first customer with you watching it.

The product should not be marketed as a fully hands-off SaaS machine until an approved production checkout/provisioning run proves the paid path again on the current deployed build.
