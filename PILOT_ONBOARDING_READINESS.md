# SMIRK Pilot Onboarding Readiness

Last checked: 2026-06-09T14:55:00Z

## Verdict

SMIRK is ready for 3 paying pilot customers with manual operator supervision.

The previous deploy-parity blocker has been closed. Live Railway now matches this branch and the strict proof-artifact checks pass.

It is not yet a fully hands-off self-serve onboarding machine because local first-dollar env is still incomplete and real pilot activations still need operator supervision.

## Definition-of-Done Audit

| Requirement | Current evidence | Status |
| --- | --- | --- |
| Live checkout/provisioning path verified | `npm run -s check:railway:first-dollar-env` passed with all required live Railway values present; `npm run -s check:buyer-routes-live` passed for public buyer routes; `npm run -s check:stripe-webhook-signature-live` verified signed webhook handling without mutation; `CONFIRM_SMIRK_PAID_HANDOFF_LIVE_WRITE=create-live-smirk-paid-handoff-smoke npm run -s check:paid-handoff-live` created provisioning request `111` and verified checkout status found it as `manual_fallback_required`; live smoke cleanup deleted request `111` afterward; a follow-up dry run found `0` smoke workspaces and `0` smoke provisioning requests. | Ready |
| Proof-call loop verified or blocker documented | `npm run -s check:ship-live` passed on live version `0967493d78aa4b2870b2f8935014c31cad90eca9`; `npm run -s check:proof-artifacts-live` passed with `correlatedProofCalls: 1`; `npm run -s check:post-call-intelligence-live` passed for latest call `CAcc67f531a16475ff53ad816bfa13f582`. | Ready |
| Owner email and callback task flow verified | Proof artifacts now correlate summary, owner email event, and callback task on the same call. The latest verified callback task is `id: 152`, `status: open`, `call_sid: CAcc67f531a16475ff53ad816bfa13f582`. | Ready |
| Dashboard proof visible to buyer/operator | `npm run -s check:dashboard-proof-live` passed with `totalCalls: 87`, `summariesGenerated: 80`, `callbackTasksCreated: 13`, `ownerEmailAlertsSent: 13`, and `completeProofCalls: 4`. | Ready |
| Local dev/env gaps documented or fixed | `npm run -s check:first-dollar-env` failed locally because local env lacks `PHONE_AGENT_PROVISIONING_SECRET`, `AUTO_FULFILL_PROVISIONING_REQUESTS`, `RESEND_API_KEY`, `FROM_EMAIL`, and `BOOKING_LINK` or `CALENDLY_URL`. `.env.example` already documents these values. Live Railway has them. | Documented |

## Verified Commands

Passing:

- `npm run -s lint`
- `npm run -s check:launch-blockers`
- `npm run -s check:paid-handoff-safety`
- `npm run -s check:railway:first-dollar-env`
- `npm run -s check:buyer-routes-live`
- `npm run -s check:stripe-webhook-handoff-live:preflight`
- `npm run -s check:stripe-webhook-signature-live`
- `CONFIRM_SMIRK_PAID_HANDOFF_LIVE_WRITE=create-live-smirk-paid-handoff-smoke npm run -s check:paid-handoff-live`
- `APP_URL=https://smirkcalls.com npm run -s cleanup:smoke-workspaces`
- `APP_URL=https://smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run -s cleanup:smoke-workspaces:apply`
- `npm run -s check:proof-loop-live`
- `npm run -s check:real-call-readiness` for live proof state, allowlist, and documented deploy-parity blocker
- `npm run -s check:live-db-health`
- `npm run -s check:pricing`
- `npm run -s check:ship-live`
- `npm run -s check:proof-artifacts-live`
- `npm run -s check:post-call-intelligence-live`
- `npm run -s check:dashboard-proof-live`
- `npm run -s check:live-is-current`

Expected blocked or manual:

- `npm run -s check:first-dollar-env` fails locally, while `npm run -s check:railway:first-dollar-env` passes for production.

## Current Pilot Operating Model

For the next 3 paying pilots, use a supervised activation flow:

1. Take payment through the live Stripe payment link.
2. Confirm provisioning through the live buyer routes and operator dashboard.
3. Configure the customer's business basics, owner alert email, callback rules, and safe test number.
4. Run a guarded proof call only against an allowlisted target.
5. Confirm the public proof snapshot and authenticated dashboard show call, summary, owner alert, callback task, and complete-proof counter movement.
6. Clean up any smoke workspaces created during testing.

## Remaining Blockers Before Fully Hands-Off Onboarding

1. Future live paid handoff smoke checks remain intentionally confirmation-gated:
   - `CONFIRM_SMIRK_PAID_HANDOFF_LIVE_WRITE=create-live-smirk-paid-handoff-smoke npm run check:paid-handoff-live`
2. Clean up smoke workspaces after future live-write testing:
   - `APP_URL=https://smirkcalls.com npm run cleanup:smoke-workspaces`
   - `APP_URL=https://smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply`
3. Fill local development env values if local first-dollar reproduction is required:
   - `PHONE_AGENT_PROVISIONING_SECRET`
   - `AUTO_FULFILL_PROVISIONING_REQUESTS`
   - `RESEND_API_KEY`
   - `FROM_EMAIL`
   - `BOOKING_LINK` or `CALENDLY_URL`
4. Run 3 real paid pilot activations and record whether each buyer saw a callback-ready recovered opportunity.

## Final Readiness Statement

Ready with manual operator steps.

SMIRK has enough live checkout, environment, proof, owner alert, callback task, and dashboard evidence to onboard 3 paying pilot customers under operator supervision. The remaining blockers are not core product failures; they are local env reproducibility and real paid-pilot execution.
