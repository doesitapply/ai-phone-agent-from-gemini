# SMIRK Outbound — Daily Run Playbook

Repo: /home/ubuntu/ai-phone-agent-from-gemini (branch codex-launch, tracks origin codex/market-validation-launch). If sandbox is fresh, clone with `gh repo clone doesitapply/ai-phone-agent-from-gemini` and checkout that branch.

Resend API key: `source /home/ubuntu/.smirk_outbound_env` (if missing, create a new sending key via Resend MCP `create-api-key` for domain smirkcalls.com).

Steps, in order:

1. **Check replies.** Use Gmail MCP (`gmail_search_messages`) to search Cam's Gmail (madeinreno775@gmail.com) for messages from any address in `outbound/campaign_ledger.csv` (column `email`), newer than 2 days. Classify each reply as `interested | question | not_now | opt_out | bounce`. Also search for Mailer-Daemon/delivery-failure bounces referencing ledger addresses. Write results to `outbound/replies.json` as `[{"email":..., "classification":..., "note":...}]`, then run `python3 outbound/check_replies.py`.
2. **If any reply is `interested` or `question`:** notify Cam immediately in the task message with the reply content and a suggested response draft. Do NOT auto-reply to prospects.
3. **Draft today's batch:** `python3 outbound/campaign.py draft`. Default cap is 30. Cap ramp for domain warm-up: keep 30/day through 2026-07-22, then raise to 40 (`SMIRK_DAILY_CAP=40`) through 2026-07-25, then 50 thereafter — ONLY if cumulative bounce rate stays under 5% and no spam complaints; otherwise hold or reduce. Prospect pool spans the original West-coast batches plus `prospects_nationwide.csv` (16 metros); the engine merges and dedupes automatically, follow-ups take priority.
4. **Send:** `source /home/ubuntu/.smirk_outbound_env && python3 outbound/campaign.py send`. Cam pre-approved the templates and daily sending on 2026-07-19; no per-batch approval needed unless templates changed.
5. **Log + push:** `python3 outbound/campaign.py status`, then commit `outbound/campaign_ledger.csv` and `outbound/suppression.txt` changes and push: `git add outbound && git commit -m "outbound: daily run $(date +%F)" --no-verify && git push origin HEAD:codex/market-validation-launch`.
6. **Report to Cam:** one short message — sends today, failures, replies found (with classification), cumulative stats (contacted/remaining/replies), any action needed.

Hard rules: email only (never SMS/calls), never email suppressed or replied addresses (engine enforces), stop and ask Cam if Resend returns repeated failures or bounce rate exceeds 10%.
