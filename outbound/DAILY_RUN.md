# Historical Outbound Review Procedure

The former batch-send procedure is retired. No scheduled task, agent, or human
should run a draft or send command from `outbound/`.

## Safe Daily Check

```bash
python3 outbound/campaign.py status
```

This reads historical CSV state and prints aggregate counts. It does not load a
provider key, create drafts, contact prospects, or modify the ledger.

## Reply And Suppression Evidence

If a reply, bounce, or opt-out from a historical message is discovered:

1. Preserve the original provider or mailbox evidence.
2. Update the historical classification only through a separately reviewed
   reconciliation procedure.
3. Ensure the address remains suppressed before any future SMIRK review.
4. Record the outcome as observational history, never as a frozen-experiment
   sample.

Do not auto-reply or infer interest from an open, delivery event, or provider
acceptance.

## Current Workflow

Use the guarded operator page at `/dashboard/prospecting` and follow
`docs/PROSPECT_QC_AND_DELIVERABILITY_RUNBOOK.md`. Every new email requires one
recipient-specific approval and a separate one-message execution confirmation.
Every prospect phone call is manual-dial-only and requires fresh DNC and local
calling-window evidence.

No cold SMS, bulk send, auto-dial, purchased-list contact, or unapproved
provider spend is permitted.
