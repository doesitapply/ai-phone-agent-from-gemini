# SMIRK Outbound — Daily Run Playbook

**Repo:** doesitapply/ai-phone-agent-from-gemini
**Branch:** codex/market-validation-launch
**Fresh sandbox:** `gh repo clone doesitapply/ai-phone-agent-from-gemini && cd ai-phone-agent-from-gemini && git checkout codex/market-validation-launch`
**Credentials:** `source /home/ubuntu/.smirk_outbound_env` (if missing, create a new Sending-only API key in Resend for domain smirkcalls.com and write `RESEND_API_KEY=re_...` to that file)

---

## Daily cap — ramp schedule

The engine (`campaign.py`) derives the daily cap automatically from cumulative sends. The engine is the authority; do not override unless Cam explicitly requests it.

| Cumulative sends | Daily cap |
|---|---|
| 0 – 119 | 30 |
| 120 – 199 | 40 |
| 200+ | 50 (hard ceiling) |

To override for a single run: `SMIRK_DAILY_CAP=N python3 outbound/campaign.py draft`

Hold or reduce cap if cumulative bounce rate exceeds **5%** or any spam complaint is received.
Hard stop if bounce rate exceeds **10%**.

---

## Steps (in order)

### 1. Verify state

```bash
git branch --show-current          # must be codex/market-validation-launch
git status --short                 # no unexpected dirty files
python3 outbound/campaign.py status
```

### 2. Check Gmail replies

Search madeinreno775@gmail.com for replies from any address in `outbound/campaign_ledger.csv` (column `email`), newer than 2 days. Also search for Mailer-Daemon / delivery-failure messages referencing ledger addresses.

Classify each reply using one of:

- `interested` — pricing, demo, meeting, info, or next-step request
- `positive_followup` — warm but no explicit ask yet
- `question_or_objection` — asks something or pushes back
- `not_interested` — explicit decline
- `unsubscribe` — any opt-out language ("stop", "remove me", "unsubscribe")
- `wrong_person` — misdirected
- `out_of_office` — auto-reply OOO
- `delivery_failure` — bounce / Mailer-Daemon
- `ambiguous` — unclear intent
- `unrelated` — not about SMIRK

Write results to `outbound/replies.json`:
```json
[{"email": "...", "classification": "...", "note": "..."}]
```
Then run `python3 outbound/check_replies.py`.

**If any reply is `interested` or `question_or_objection`:** notify Cam immediately — include prospect name, company, email, exact reply or faithful summary, and recommended next action. Do NOT auto-reply.

**If any reply is `unsubscribe` or `delivery_failure`:** add the address to `outbound/suppression.txt` (one address per line, lowercase) before drafting.

### 3. Draft today's batch

```bash
python3 outbound/campaign.py draft
```

Review `outbound/pending_batch_preview.md`. Confirm:
- All recipients are eligible (not suppressed, not already contacted today)
- Bounce rate is under 5%
- Batch size does not exceed the active ramp cap

### 4. Send

```bash
source /home/ubuntu/.smirk_outbound_env && nohup python3 -u outbound/campaign.py send > /tmp/campaign_send_$(date +%F).log 2>&1 &
```

Cam pre-approved all current templates and daily sending on 2026-07-19. No per-batch approval needed unless templates changed. Monitor the log until complete before committing.

### 5. Commit and push

```bash
python3 outbound/campaign.py status
git add outbound/campaign_ledger.csv outbound/suppression.txt
git commit -m "outbound: record daily campaign run $(date +%F)" --no-verify
git push origin HEAD:codex/market-validation-launch
```

Commit only `campaign_ledger.csv` and `suppression.txt` unless other outbound files changed legitimately. Never force-push. If push is rejected, `git pull --rebase origin codex/market-validation-launch` then push again.

### 6. Report to Cam

One message covering:
- Run date
- Replies reviewed and classifications
- Interested replies (if any — include full detail)
- New suppressions
- Follow-ups sent / new prospects sent / total sends today
- Failures and reasons
- Cumulative stats: total sends, bounce rate, remaining eligible prospects
- Files updated, commit hash, push status
- Any blocker or decision Cam must handle

---

## Hard rules

- Email only. Never SMS, calls, voicemail, social outreach, or auto-replies.
- Never contact a suppressed address. The engine enforces this; verify manually before sending.
- Never mark a send without Resend confirmation (resend_id present in ledger).
- Never classify interest without supporting reply evidence.
- Stop and ask Cam if Resend returns repeated failures or bounce rate exceeds 10%.
- No secrets in committed files.
