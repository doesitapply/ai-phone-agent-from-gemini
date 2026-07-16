# SMIRK Guarded SMS Enablement Runbook

SMS is not part of first-dollar acquisition. Do not use SMS for cold outreach, purchased lists, automated prospecting, or launch-channel follow-up.

This runbook exists only for approved product SMS testing after the operator confirms the recipient, message, and cap.

## Current Safe Default

Expected default behavior:
- `SMS_ENABLED` is unset or false.
- `SMS_SEND_MODE` defaults to `dry_run`.
- `SMS_A2P_CAMPAIGN_APPROVED` is false unless explicitly configured.
- `SMS_ALLOW_NON_ALLOWLISTED` is false.
- `SMS_ALLOWED_NUMBERS` is empty unless test recipients are deliberately added.
- `SMS_MAX_PER_WORKSPACE_PER_DAY` defaults to `20`.
- `SMS_MAX_PER_RECIPIENT_PER_DAY` defaults to `2`.
- `SMS_MIN_SECONDS_BETWEEN_RECIPIENT` defaults to `300`.
- `SMS_DAILY_SPEND_CAP_CENTS` defaults to `200`.
- `SMS_ESTIMATED_CENTS_PER_MESSAGE` defaults to `2`.
- Live sends require the exact confirmation phrase `send guarded sms`.

## Required Checks

Run before any SMS test:

```bash
npm run check:sms-guardrails
npm run check:no-texting-copy
```

For production, also verify the deployed build is current before testing:

```bash
npm run check:live-is-current
npm run check:operator-session-live
```

## Phase 0: Dry-Run Only

Use this state for UI and API testing:

```text
SMS_ENABLED=false
SMS_SEND_MODE=dry_run
SMS_A2P_CAMPAIGN_APPROVED=false
SMS_ALLOW_NON_ALLOWLISTED=false
SMS_ALLOWED_NUMBERS=
SMS_DAILY_SPEND_CAP_CENTS=200
```

Expected result from `/api/sms/test`:
- blocked if the number/body/STOP+HELP/consent checks fail.
- dry_run if guardrails pass but live env gates are not all true.
- sent never happens in Phase 0.

## Phase 1: One Allowlisted Live Test

Only after explicit approval, use one known test recipient:

```text
SMS_ENABLED=true
SMS_SEND_MODE=live
SMS_A2P_CAMPAIGN_APPROVED=true
SMS_ALLOW_NON_ALLOWLISTED=false
SMS_ALLOWED_NUMBERS=<one E.164 test number>
SMS_MAX_PER_WORKSPACE_PER_DAY=3
SMS_MAX_PER_RECIPIENT_PER_DAY=1
SMS_MIN_SECONDS_BETWEEN_RECIPIENT=900
SMS_DAILY_SPEND_CAP_CENTS=50
SMS_ESTIMATED_CENTS_PER_MESSAGE=5
```

The request body must include:

```json
{
  "confirm": "send guarded sms"
}
```

Stop after one message. Inspect `/api/sms/safety`, Twilio delivery status, and `sms_messages` before allowing any second send.

## Phase 2: Limited Product SMS

Only after A2P approval, consent capture, STOP/HELP handling, and delivery monitoring are proven:

```text
SMS_ALLOW_NON_ALLOWLISTED=true
SMS_MAX_PER_WORKSPACE_PER_DAY=<approved low cap>
SMS_MAX_PER_RECIPIENT_PER_DAY=1
SMS_DAILY_SPEND_CAP_CENTS=<approved daily cap>
```

Do not raise caps because a test "looks fine." Raise caps only after reviewing:
- messages sent in the last 24 hours,
- blocked and dry-run counts,
- Twilio status callbacks,
- opt-outs,
- estimated spend,
- consent source.

## Stop Rules

Stop SMS immediately if:
- more than one unexpected live message is sent,
- a recipient did not explicitly consent,
- STOP/HELP handling fails,
- Twilio status callbacks are not being stored,
- spend approaches the configured daily cap,
- any operator proposes SMS as a cold acquisition channel.
