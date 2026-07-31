# SMIRK Starter — paid-pilot fulfillment proof

**Run:** 2026-07-31 09:44 PDT  
**Offer:** Starter missed-call recovery — **$197/month**  
**Proof mode:** signed synthetic checkout and synthetic call fixtures; **no real charge, call, or external message**.

## What a buyer receives

When a caller reaches the SMIRK backup path, SMIRK captures the caller's issue, urgency, service area, and preferred callback window. It then creates:

1. a durable call/recovery record;
2. a callback-ready owner summary;
3. an owner notification with an idempotency key;
4. a callback/follow-up task in the buyer queue; and
5. dashboard proof that the recovery artifacts completed.

## Executed purchase-to-activation evidence

A locally signed synthetic Stripe `checkout.session.completed` webhook was submitted twice to the production webhook route.

| Assertion | Executed result |
|---|---:|
| Webhook HTTP results | `200`, `200` |
| Workspaces created for exact synthetic customer | **1** |
| Activation/provisioning tasks | **1** |
| Fulfillment receipts | **1** |
| Replay idempotent | **true** |
| Purchased plan | `starter` |
| Purchased mode | `missed_call_recovery` |
| Missing phone-line state | `PENDING_MANUAL_TELEPHONY` |
| False "activation complete" claim | **false** |

The duplicate signed webhook did not create a second workspace, task, or receipt. Because no Twilio number was assigned in this local proof, the workspace remained visibly blocked at `PENDING_MANUAL_TELEPHONY`; the system did not claim the phone agent was live.

## Executed call-result evidence

The same proof command ran the repository's executable post-call durability fixtures and canonical owner-action contract. They passed these contracts:

- mandatory call artifacts are durable, tenant-bound, checkpointed, resumable, and idempotent;
- an injected failure after the summary is retried without duplicating the summary, callback task, lead, appointment, or completion marker;
- completed CRM actions do not rerun;
- failed CRM actions alone retry;
- `callback`, `follow_up`, `handoff`, and `escalate_to_human` are accepted owner actions;
- manual setup fails closed if buyer details cannot be durably captured.

## Reproduce from the repository

```bash
cd /Users/cameronchurch/OpenClaw/workspace/ai-phone-agent-from-gemini-pilot-hardening
scripts/run-paid-pilot-commercial-proof.sh
```

**Verified result:** exit `0` at `2026-07-31T16:44:17Z`.

Raw outputs:

- `artifacts/revenue/2026-07-31/raw/paid-pilot-commercial-proof-run.log`
- `artifacts/revenue/2026-07-31/raw/paid-pilot-local-proof.json`
- `artifacts/revenue/2026-07-31/raw/paid-pilot-component-tests.log`

## Scope boundary

This proves the signed purchase/replay/activation path against a dedicated local PostgreSQL database and proves the call-result contract with executable synthetic fixtures. It does **not** represent a real Stripe charge, a real Twilio call, a delivered external email, or a single live production transaction. A paid workspace without a number remains pending manual telephony rather than being falsely reported as activated.
