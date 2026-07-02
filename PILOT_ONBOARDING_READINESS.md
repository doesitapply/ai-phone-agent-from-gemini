# SMIRK Pilot Onboarding Readiness

Last checked: 2026-07-02

## Verdict

SMIRK is ready for an operator-assisted first paying pilot.

The current production build includes the customer dashboard cleanup, contact status/DNC controls, live proof-loop evidence, public proof masking, guarded Stripe/provisioning checks, and a clean dependency audit.

SMIRK is not yet a fully hands-off SaaS 10/10 because the final mutating checkout/provisioning smoke on the current live build still requires explicit approval.

## Definition-Of-Done Audit

| Requirement | Current Evidence | Status |
| --- | --- | --- |
| Live deploy is current | `npm run -s check:live-is-current` passed against local HEAD; `npm run -s check:latest-failed-deploy` found no failed deployments. | Ready |
| Dependency/security floor is clean | `npm audit --audit-level=moderate` returned `found 0 vulnerabilities`. | Ready |
| Customer dashboard is narrowed | `npm run -s check:customer-dashboard` passed; production video shows owner view limited to Calls, Contacts, and Tasks. | Ready |
| Contact status/DNC controls exist | `npm run -s check:contact-management` passed. | Ready |
| Live proof loop is fresh | `npm run -s check:dashboard-proof-live`, `check:proof-artifacts-live`, and `check:post-call-intelligence-live` passed. Public proof is masked, no-store, and fresh. | Ready |
| Signed Stripe webhook works without mutation | `npm run -s check:stripe-webhook-signature-live` returned `verified: true`. | Ready |
| Full checkout/provisioning production write | `npm run -s check:stripe-webhook-handoff-live:preflight` and `check:stripe-webhook-smoke-approval-ready` passed, but the mutating smoke requires `ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1` and explicit approval. | Approval gated |
| Smoke cleanup | Cleanup baseline currently reports `0` matched smoke workspaces and `0` matched smoke provisioning requests. Future apply cleanup requires separate approval. | Ready / approval gated |

## Verified Commands

Passing:

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

Production video:

```text
output/playwright/smirk-e2e-production-2026-07-02-narrated-masked.mp4
```

## Pilot Operating Model

For the first paying pilot:

1. Keep the sale narrow: missed-call recovery.
2. Confirm the buyer has one owner email, one main business number, and one safe proof-call target.
3. Take payment through the live Stripe path or run the approved Stripe webhook smoke first.
4. Confirm workspace/provisioning evidence.
5. Configure business basics, callback rules, owner alert email, and safe call target.
6. Run a guarded proof call or verify the first real missed call.
7. Confirm call record, summary, owner alert, callback task, dashboard proof, and public masked proof.
8. Use contact status and DNC controls to clean the first records.
9. Clean up smoke records only after separate cleanup approval.

## Approval-Gated Actions

Full Stripe webhook smoke:

```bash
APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE: ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live
```

Cleanup apply:

```bash
APPROVE_SMIRK_SMOKE_CLEANUP_APPLY: APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply
```

Paid handoff manual-fallback smoke:

```bash
APPROVE_SMIRK_PAID_HANDOFF_LIVE_WRITE: CONFIRM_SMIRK_PAID_HANDOFF_LIVE_WRITE=create-live-smirk-paid-handoff-smoke npm run check:paid-handoff-live
```

Real proof call:

```bash
npm run check:real-call-readiness
npm run -s print:real-call-setup
npm run check:real-call-readiness -- <safe-number>
npm run proof:real-call -- <safe-number>
```

## Final Readiness Statement

Ready with manual operator steps.

The product is strong enough for the first customer, but the final 10/10 claim should wait until the approved production checkout/provisioning write is completed and its evidence is recorded.
