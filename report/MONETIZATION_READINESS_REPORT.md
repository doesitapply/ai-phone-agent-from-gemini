# SMIRK Missed-Call Recovery - Monetization Readiness

Date: 2026-07-02

## Executive Summary

SMIRK is monetizable for the narrow first-dollar offer: missed-call recovery for owner-operated local service businesses.

The live system can show the public offer, pricing, protected customer workspace, fresh proof counters, call summaries, owner alerts, callback tasks, and public proof masking. The current build also hides the operator cockpit from customer sessions and has a clean dependency audit.

The remaining monetization gap is not basic code readiness. It is the approval-gated production write that proves checkout/provisioning end to end on the current deployed build.

## Repo And Runtime State

- Repo: `doesitapply/ai-phone-agent-from-gemini`
- Local path: `/Users/cameronchurch/OpenClaw/workspace/ai-phone-agent-from-gemini`
- Branch: `cleanup/stop-tracking-generated-deploy-output`
- Live production commit: verify with `npm run -s check:live-is-current`
- Branded domain: `https://smirkcalls.com`
- Railway health URL: `https://ai-phone-agent-production-6811.up.railway.app/health`

## What Is Ready

- Twilio voice webhook flow for inbound calls.
- AI call handling and post-call intelligence.
- Postgres persistence for calls, messages, contacts, summaries, events, tasks, handoffs, and provisioning records.
- Owner email alert and callback task flow.
- Authenticated customer dashboard narrowed to Calls, Contacts, and Tasks.
- Operator/admin surfaces protected from public and customer sessions.
- Contact status and DNC correction controls.
- Public proof snapshot with private data masking and `no-store` cache behavior.
- Stripe webhook signature verification.
- Stripe/provisioning smoke approval artifacts.
- Guarded deploy/readiness scripts.

## Current Verification

Passing checks from 2026-07-02:

```bash
npm run -s check:live-is-current
npm run -s check:latest-failed-deploy
npm audit --audit-level=moderate
npm run -s check:stripe-webhook-signature-live
npm run -s check:stripe-webhook-handoff-live:preflight
npm run -s check:stripe-webhook-smoke-approval-ready
npm run -s check:dashboard-proof-live
npm run -s check:proof-artifacts-live
npm run -s check:post-call-intelligence-live
npm run -s check:local-runtime-smoke
npm run -s check:customer-dashboard
npm run -s check:contact-management
```

Public proof counters:

- Total calls: `104`.
- Calls this month: `37`.
- Summaries generated: `97`.
- Callback tasks created: `109`.
- Owner email alerts sent: `30`.
- Complete proof calls: `27`.
- Summary coverage: `93`.
- Leaked public fields: `[]`.
- Proof freshness: `fresh: true`.

Safe Stripe proof:

- Signature-only webhook returned `verified: true`.
- Preflight shows webhook secret configured and auto-fulfillment enabled.
- Full smoke cannot run without `ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1`.
- Cleanup baseline currently has `0` smoke workspaces and `0` smoke provisioning requests.

Production video:

```text
output/playwright/smirk-e2e-production-2026-07-02-narrated-masked.mp4
```

## Current Verdict

Ready to sell the narrow first-dollar product under operator supervision.

Not yet fully hands-off SaaS. The first customer should still be watched through payment, provisioning, proof call or first missed call, owner alert, callback task creation, dashboard proof, and any cleanup.

## Required Before Claiming 10/10

Run one of these with explicit approval:

1. Full Stripe webhook/provisioning smoke:

```bash
APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE: ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live
```

2. Real paid customer activation, then record the same evidence:

- Checkout completed.
- Workspace/provisioning record exists.
- Owner setup path is clear.
- Proof call or first real missed call creates call record, summary, owner alert, callback task, and dashboard proof.

Cleanup apply remains separately approval-gated:

```bash
APPROVE_SMIRK_SMOKE_CLEANUP_APPLY: APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply
```

## Next Moves

1. Get explicit approval for the full Stripe webhook smoke or run the first real paid customer activation.
2. Verify provisioning/workspace evidence.
3. Run or observe a proof call.
4. Confirm owner alert, callback task, and dashboard/public proof.
5. Apply smoke cleanup only after separate approval.
6. Record the final evidence in `SMIRK_FIRST_CUSTOMER_10_OF_10_RUNBOOK.md`.
