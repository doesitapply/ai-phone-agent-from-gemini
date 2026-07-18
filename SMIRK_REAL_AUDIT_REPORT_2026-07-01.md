# SMIRK Real Audit Report - Current Through 2026-07-02

## Scope

This audit uses current repo state, current command output, live production checks, and production video artifacts. It does not use older README claims as truth.

No mock product data is used for readiness conclusions. The production video uses a real workspace session, and the share-safe version blurs live customer/caller rows.

## Executive Verdict

SMIRK is a live, working missed-call recovery product that is ready for an operator-assisted first customer.

It is not yet a fully proven hands-off SaaS 10/10 because the final mutating checkout/provisioning proof remains intentionally approval-gated. The safe non-mutating Stripe proof passes, but a real production write has not been run on the current deployed build in this audit pass.

Current rating from verified evidence:

- Production runtime health: 9/10.
- First-dollar proof loop: 8/10.
- Customer-facing dashboard scope: 8/10.
- Dependency/security floor: 9/10.
- Operator-assisted first customer: 8/10.
- Hands-off SaaS readiness: 6/10.

## Source Of Truth

- Repository: `/Users/cameronchurch/OpenClaw/workspace/ai-phone-agent-from-gemini`
- Branch: `cleanup/stop-tracking-generated-deploy-output`
- Live commit: verify with `npm run -s check:live-is-current`
- Live health URL: `https://ai-phone-agent-production-6811.up.railway.app/health`
- Branded domain used for buyer/video checks: `https://smirkcalls.com`

## Verified Green

### Production is current

`npm run -s check:live-is-current` returned `ok: true`.

Evidence:

- Live `/health` returned HTTP 200.
- Live readiness header was `1`.
- Live version matched local HEAD at the time of the check.
- Live branch matched `cleanup/stop-tracking-generated-deploy-output`.

`npm run -s check:latest-failed-deploy` returned:

```text
OK no failed deployments found for ai-phone-agent
```

### Dependency audit is clean

`npm audit --audit-level=moderate` returned:

```text
found 0 vulnerabilities
```

The prior `form-data`, `@babel/core`, and `esbuild` audit blockers are resolved in the current lockfile.

### Customer dashboard cleanup is shipped

`npm run -s check:customer-dashboard` returned:

```text
OK customer dashboard contract hides operator surface and sanitizes owner-visible failures
```

Current behavior:

- Workspace customers see Calls, Contacts, and Tasks.
- Operator surfaces are hidden from workspace sessions.
- Owner-visible API/network failures are sanitized.
- Operator-only destructive controls remain behind operator mode.

Production video artifact:

```text
output/playwright/smirk-e2e-production-2026-07-02-narrated-masked.mp4
```

The video shows public landing, pricing, authenticated customer workspace access, and the simplified owner view on production. The masked version blurs live call-row details.

### Contact status and DNC correction checks pass

`npm run -s check:contact-management` returned:

```text
[contact-management-contract] ok
```

Covered behavior:

- Contact status editing.
- Status/DNC filtering.
- Contact-level mark DNC.
- Contact-level remove DNC.
- Required note/correction flow for DNC removal.
- Contact and DNC list synchronization.

### Live proof loop is fresh

`npm run -s check:dashboard-proof-live` returned `ok: true`.

Current counters:

- Total calls: `104`.
- Summaries generated: `97`.
- Callback tasks created: `109`.
- Owner email alerts sent: `30`.
- Complete proof calls: `27`.
- Public proof leaked fields: `[]`.
- Public proof cache control: `no-store`.
- Latest complete proof: `2026-07-01T23:11:00.974Z`.
- Proof age at audit: `20.8` hours.
- Proof fresh: `true`.

`npm run -s check:proof-artifacts-live` returned `ok: true`.

Notable evidence:

- Fresh calls: `100`.
- Fresh tasks: `187`.
- Correlated proof calls: `5`.
- Latest correlated call SID: `CA9235569c21c4eaf0c4bf83084055423b`.
- Latest owner email event: `OWNER_EMAIL_ALERT_SENT`.
- Latest owner action task: callback task `190`.

`npm run -s check:post-call-intelligence-live` returned `ok: true`.

### Safe Stripe webhook proof passes

`npm run -s check:stripe-webhook-signature-live` returned:

```json
{
  "ok": true,
  "appUrl": "https://smirkcalls.com",
  "signatureOnly": true,
  "webhook": {
    "verified": true
  },
  "mutationRisk": "none: evt_test_* is verified and returned before provisioning logic"
}
```

`npm run -s check:stripe-webhook-handoff-live:preflight` returned:

- Webhook secret configured: `true`.
- Auto-fulfillment enabled: `true`.
- Full signed smoke without approval: `false`.
- Required approval env: `ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1`.

`npm run -s check:stripe-webhook-smoke-approval-ready` returned:

- Approval required: `true`.
- Cleanup baseline matched workspaces: `0`.
- Cleanup baseline matched provisioning requests: `0`.

### Local runtime smoke still passes

`npm run -s check:local-runtime-smoke` passed:

- `GET /health -> 200`.
- `GET /api/version -> 200`.
- `GET /api/tasks -> 200`.

No-DB mode is still only a shell/demo mode. It is not a substitute for a real staging or production workspace.

## Remaining 10/10 Gaps

### 1. Mutating checkout/provisioning proof needs explicit approval

The full Stripe webhook smoke is intentionally blocked until this exact approval phrase is provided:

```bash
APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE: ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live
```

Without that run, this audit can prove signed webhook handling and readiness, but not a new production auto-fulfilled provisioning write on the current deployed build.

### 2. Cleanup apply needs separate explicit approval

Cleanup dry-run is safe:

```bash
APP_URL=https://www.smirkcalls.com npm run cleanup:smoke-workspaces
```

Cleanup apply requires separate approval:

```bash
APPROVE_SMIRK_SMOKE_CLEANUP_APPLY: APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply
```

### 3. A new real proof call is also approval-gated

Existing proof is fresh and passing. A new real proof call requires the guarded allowlist flow:

```bash
npm run check:real-call-readiness
npm run -s print:real-call-setup
npm run check:real-call-readiness -- <safe-number>
# After: APPROVE_SMIRK_REAL_PROOF_CALL: <exact-approved-e164>
CONFIRM_SMIRK_REAL_PROOF_CALL=place-one-smirk-real-proof-call \
CONFIRM_SMIRK_REAL_PROOF_CALL_TARGET='<exact-approved-e164>' \
npm run -s proof:real-call -- '<exact-approved-e164>'
```

## Current Business Readiness

Ready to sell and onboard the first customer with the operator watching activation and proof.

Not ready to call fully hands-off SaaS until either:

1. The approved full Stripe webhook/provisioning smoke passes on the current live build and cleanup is handled; or
2. A real paid customer completes checkout, provisioning evidence is captured, and the first call proof loop is verified.
