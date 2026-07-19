# Handoff Brief: Manus → Codex

**Date:** 2026-07-19 (PDT)
**Author:** Manus (Cam's agent). I have been the one working on this repo and the live launch for the past two days. This document brings you fully up to speed so we do not step on each other.

## Who did what

Everything from commit `d3ed9b7` through `2c5af21` on `codex/market-validation-launch` is my work, done in a Manus sandbox with Cam directing. That includes the entire `outbound/` directory, live Stripe changes, a production webhook registration, and a recurring scheduled automation that runs daily in Manus (outside this repo — see "Live moving parts" below, because it will keep committing to this branch every day).

## Current state of the business (the part that matters)

SMIRK had **zero outbound touches and zero revenue** as of July 18. Since then:

| Metric | State |
| :--- | :--- |
| Outbound emails sent | 31 (30 touch-1 + 1 verified missed-call callout) |
| Delivery | 30/31 delivered, 0 bounces, 1 Resend-suppressed |
| Prospect pool | 257 sendable (85 original West-coast + nationwide expansion) |
| Nationwide expansion | 348 new prospects across 16 metros, 179 with verified emails |
| Replies so far | 0 (sends are <48h old) |
| Revenue | Still $0 — see "Critical blocker" |

## What I built (`outbound/`)

The outbound system is plain-Python, stdlib-only, deliberately decoupled from the app runtime so it cannot break production. Read `outbound/README.md` and `outbound/DAILY_RUN.md` for operational detail. Summary:

- **`enrich.py` / `enrich_nationwide.py`** — crawl prospect websites, extract contact emails, score confidence, filter junk inboxes.
- **`campaign.py`** — the engine. Loads `prospects_enriched.csv` + `prospects_nationwide.csv`, dedupes, prioritizes (plumbing/HVAC first, Reno/West-coast first, metros interleaved), drafts a 3-touch sequence (day 0 / 3 / 7), sends via Resend from `cam@smirkcalls.com`, appends to `campaign_ledger.csv` (append-only, the source of truth), enforces a daily cap and `suppression.txt`.
- **`check_replies.py`** — consumes reply classifications (`interested | question | not_now | opt_out | bounce`), halts sequences on any reply, auto-suppresses opt-outs/bounces.
- **Copy is at v3** — blunt trades voice per Cam's direct edits: dollar hooks ("that's a $500 job handed straight to your competition"), demo-line-first CTA `(775) 420-3005`, `(Reply "stop" to opt out)`, region-aware local line ("right here in Reno" only for NV prospects). Do not revert to softer copy; Cam explicitly rejected the corporate voice.
- **Verified missed-call callout** — a one-off variant (`send_callout_united.py` is the template) that only fires when a human actually called a shop and hit voicemail. Never send it unverified; the claim must be factual.

## Live moving parts you must not collide with

1. **A Manus scheduled task runs daily at 9:00 AM PDT.** It checks Cam's Gmail for replies, classifies them, sends the day's batch (cap 30 → 40 on Jul 23 → 50 on Jul 26, gated on <5% bounce), updates the ledger, and **pushes to this branch**. If you rebase or force-push `codex/market-validation-launch`, you will break its push. Coordinate through Cam before any history rewrite.
2. **`campaign_ledger.csv` and `suppression.txt` are append-only state files.** Do not regenerate, reformat, or "clean up" these files. The engine's dedupe/sequencing logic depends on them.
3. **Resend sends from `cam@smirkcalls.com`; replies go to Cam's Gmail** (`reply_to` in `campaign.py` CONFIG). Important: `cam@smirkcalls.com` **cannot receive mail** — the root domain CNAMEs to Railway with no MX. Do not point any reply-to or customer-facing contact at that address until inbound routing (Resend receiving or Cloudflare Email Routing) exists.

## Stripe changes I made (live mode)

- **Founders $99/mo deal:** product + recurring price + payment link `https://buy.stripe.com/cNi5kD7rJ9Ic2LB0Cu6Zy0i`, metadata `deal=founders_99`. This honors the $99 promised in outreach; public pricing stays $197/397/697. The day-7 email closes on this link.
- **Webhook endpoint registered:** `checkout.session.completed` + subscription/invoice events → `https://www.smirkcalls.com/api/stripe/webhook`. Before this, **the Stripe account had no SMIRK webhook at all** — any paid checkout would have charged the customer and provisioned nothing.
- **One-use 100%-off promo `SMIRKDRYRUN100`** exists on the founders link for a zero-cost end-to-end dry run.

## Critical blocker (highest priority item in the repo right now)

`STRIPE_WEBHOOK_SECRET` is **not set on Railway**, so `handleStripeWebhook` rejects the events the new endpoint sends. Until Cam (or someone with a Railway token) sets that variable, **a paying customer ends in silence**: charged, no provisioning, no alert. The signing secret is captured and stored on Cam's side (sandbox file `~/.smirk_webhook_secret`; ask Cam). After it is set, run the `SMIRKDRYRUN100` checkout to prove checkout → webhook → provisioning → operator alert end-to-end. Nothing else in this repo matters more than closing that loop before the first interested reply converts.

## Sensible next work for Codex (in priority order)

1. Nothing that touches `outbound/` state files without coordination.
2. After `STRIPE_WEBHOOK_SECRET` is live: verify `handleCheckoutCompleted` handles the founders link/price cleanly (it was written against the $197+ plans; confirm plan-mapping for the $99 price ID doesn't fall through to a default that misprovisions).
3. Inbound email routing for `smirkcalls.com` so replies/contact addresses on the domain actually work.
4. Merge PR #5 (main is ~110 commits behind this branch) and close stale PRs #1/#3 and issue #4.

Cam's operating rules, unchanged: email-only outbound (zero automated calls/SMS — TCPA line), 3 touches max, hard stop on any reply, never email suppressed addresses.
