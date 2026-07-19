# SMIRK Outbound Email Automation

Email-only outbound to the researched launch prospects. No SMS, no automated calls — those stay prohibited per `docs/launch/manual-outbound-playbook.md` and TCPA.

## Files

| File | Purpose |
|---|---|
| `enrich.py` | Crawls prospect `contact_url` sites, extracts public business emails, writes `prospects_enriched.csv` |
| `prospects_enriched.csv` | 200 prospects + discovered emails, confidence, crawl status |
| `campaign.py` | Campaign engine: `draft` / `send` / `status` |
| `pending_batch.json` / `pending_batch_preview.md` | Today's drafted batch (review before send) |
| `campaign_ledger.csv` | Append-only send log: every send, timestamp, Resend ID, response state |
| `check_replies.py` | Applies `replies.json` classifications to the ledger, maintains `suppression.txt` |
| `suppression.txt` | Opt-outs and bounces — never emailed again |

## Sequence Logic

Touch 1 (intro) → Touch 2 at day 3 → Touch 3 at day 7 (final). A reply of any kind stops the sequence for that address. `opt_out`/`bounce` also suppresses permanently. Daily cap: 20 sends total (follow-ups take priority over new sends).

## Compliance (CAN-SPAM)

Every email has: truthful subject, real sender (`cam@smirkcalls.com`), physical mailing address in footer, and a plain-language opt-out honored via suppression. Recipients are public business contact emails found on the business's own official website — no purchased lists, no guessed addresses.

## Daily Run (automated)

1. Check inbox for replies from ledger addresses → write `replies.json` → `python3 outbound/check_replies.py`
2. `python3 outbound/campaign.py draft` — selects due follow-ups + next new prospects (cap 20)
3. Review preview, then `RESEND_API_KEY=... python3 outbound/campaign.py send`
4. Commit `outbound/` ledger changes and push to GitHub

## Manual Commands

```bash
python3 outbound/campaign.py status         # campaign stats
python3 outbound/campaign.py draft          # draft today's batch
RESEND_API_KEY=re_... python3 outbound/campaign.py send
python3 outbound/enrich.py                  # re-run enrichment (refresh emails)
```

Config via env: `SMIRK_DAILY_CAP` (default 20), `SMIRK_REPLY_TO`, `SMIRK_MAILING_ADDRESS`.
