# Historical SMIRK Outbound Archive

This directory preserves the pre-ledger prospect files, delivery history,
reply classifications, and suppression evidence. It is not an active sending
system.

`campaign.py draft` and `campaign.py send` fail closed with
`SMIRK_GUARDED_OUTREACH_REQUIRED`, even when a provider key is present. The
script contains no email-provider transport. The historical
`send_callout_united.py`, `send_samples.py`, and `smoke_test.py` entry points
are fail-closed tombstones with the same boundary.

The only supported command is read-only:

```bash
python3 outbound/campaign.py status
```

Do not delete, regenerate, reformat, or overwrite:

- `campaign_ledger.csv`;
- `suppression.txt`;
- historical prospect CSVs;
- historical previews or reply classifications.

They may contain evidence needed to reconcile earlier sends, suppression, and
outcomes. They do not authorize another contact and must not be enrolled in a
controlled experiment as if they were untouched prospects.

All new prospect work must use the workspace-scoped SMIRK flow documented in
`docs/PROSPECT_QC_AND_DELIVERABILITY_RUNBOOK.md`:

```text
reviewed Velvet evidence
  -> recipient-specific SMIRK draft
  -> deterministic QC
  -> optional advisory model receipt
  -> one human approval
  -> one separate email execution confirmation OR one manual call
  -> signed/manual outcome
  -> deduplicated observational or frozen-cohort learning
```

Cold SMS, bulk email, automated prospect dialing, and provider execution from
this archive remain disabled.
