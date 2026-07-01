# SMIRK Missed-Call Recovery — Monetization Readiness

Date: 2026-07-01 (America/Los_Angeles)

## Executive Summary

SMIRK is monetizable for the narrow first-dollar offer: missed-call recovery for owner-operated local service businesses. The validated loop is: payment/provisioning handoff, workspace creation, inbound call capture, post-call summary, owner alert, callback/owner-action task, dashboard proof, and public proof masking.

The newest local work adds contact status management and DNC correction controls. That work is implemented and locally verified, but it is not production-live until the guarded deploy approval is given and the deploy completes.

## Repo State

- Repo: `doesitapply/ai-phone-agent-from-gemini`
- Local path: `/Users/cameronchurch/OpenClaw/workspace/ai-phone-agent-from-gemini`
- Branch: `cleanup/stop-tracking-generated-deploy-output`
- Live production commit before this report update: `b308980d191476866b9be7e3168584f8a687aeda`
- Current local state: deploy-relevant working tree changes pending guarded deploy approval

## Production Snapshot

Endpoint: `https://ai-phone-agent-production-6811.up.railway.app/health`

```json
{
  "status": "ok",
  "readinessHeader": "1",
  "branch": "cleanup/stop-tracking-generated-deploy-output",
  "version": "b308980d191476866b9be7e3168584f8a687aeda"
}
```

## What Is Ready

- Twilio voice webhook flow for inbound calls.
- AI call handling with tool execution.
- Postgres persistence for calls, messages, contacts, summaries, events, tasks, handoffs, and provisioning records.
- Owner email alert and callback/owner-action task flow.
- Authenticated dashboard proof surfaces.
- Public proof snapshot with caller-data masking.
- Stripe webhook signature handling and paid provisioning handoff smoke path.
- Guarded deploy/readiness scripts for proof freshness, route inventory, auth regression, paid handoff safety, and live parity.

## Pending Local Product Polish

The contact-management update adds:

- `contacts.status` schema and API support.
- Status values: `active`, `lead`, `customer`, `inactive`, `bad_number`.
- Contact list status filter.
- Contact list DNC filter.
- Contact detail status editing.
- Contact-level `Mark DNC`.
- Contact-level `Remove from DNC`.
- Required consent/correction note before DNC removal.
- DNC list/contact flag synchronization.
- Compliance audit entry for DNC removal.
- `check:contact-management` regression contract.

## Verification

Local verification for the pending contact/DNC update:

- `npm run -s check:contact-management`
- `npm run lint`
- `npm run build`
- `npm run -s check:auth-regression`
- `npm run -s check:openapi`
- `git diff --check`
- `npm run -s check:deploy-post-call-fix-ready`

The deploy preflight is green except for the expected state: production is stale relative to the pending local work, and production deployment requires explicit approval.

## Current Verdict

Ready to sell the narrow first-dollar product under operator supervision.

Not yet a fully hands-off self-serve SaaS for every edge case. The first customer should still be watched through activation, proof call, owner alert, callback task creation, and workspace cleanup. The contact/DNC update should be deployed before broad customer operations because it gives the operator a safer way to clean incorrect DNC flags without silently opting people back in.

## Next Moves

1. Approve and run the guarded deploy for the pending contact/DNC update.
2. Re-run live parity and post-deploy checks.
3. Use Contacts to classify real contacts and correct any wrong DNC flags with notes.
4. Keep first customer scope narrow: missed-call recovery, callback task, owner email, proof dashboard, workspace provisioning.
5. Add billing/usage self-service after the first customer activation creates real pressure for it.
