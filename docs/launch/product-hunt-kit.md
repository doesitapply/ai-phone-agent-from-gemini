# Product Hunt Kit

Use this only after the readiness gate in `docs/SMIRK_30_DAY_MARKET_VALIDATION_GOAL.md` passes.

## Product

Name: SMIRK

Tagline:

> Missed-call recovery for home-service businesses

Short description:

> SMIRK catches missed job calls, captures the caller's issue and urgency, alerts the owner, creates callback work, and leaves proof in the dashboard.

## Gallery Checklist

- Landing page screenshot.
- Pricing screenshot.
- Dashboard proof screenshot with caller details removed.
- One industry page screenshot.
- One short walkthrough showing call record, summary, owner alert, and callback task.

## Asset Capture

Capture current public screenshots before launch review:

```bash
SMIRK_LAUNCH_ASSET_BASE_URL=https://smirkcalls.com npm run capture:launch-assets
```

The command writes public screenshots and `output/playwright/launch-assets/manifest.json`.
It intentionally marks Product Hunt submission as not ready until the redacted dashboard proof screenshot, redacted callback task screenshot, current walkthrough clip, and self-serve activation proof are reviewed.

## First Comment

Hi Product Hunt,

SMIRK is a missed-call recovery system for home-service businesses.

Most field-service owners do not need a giant front-office project to start. They need the job calls they miss while driving, under a sink, on a roof, or in the bay to stop disappearing into voicemail.

The first proof loop is intentionally narrow:

- a missed or forwarded call comes in
- SMIRK captures the caller's issue and urgency
- the owner gets an alert
- a callback task is created
- the dashboard shows proof of what happened

We are looking for feedback from plumbers, HVAC operators, roofers, electricians, handymen, auto shops, agencies serving local service businesses, and anyone who has tried AI reception tools but wanted a smaller first step.

Best feedback:

- Would this be enough to try one proof call?
- What would you need to see before forwarding a real business line?
- Which trade-specific intake questions matter most?

## Launch-Day Reply Rules

- Answer questions with product behavior, not hype.
- Do not promise recovered revenue.
- Do not claim full hands-off setup until the activation proof is green.
- If asked about texting, say it is guarded and not part of the first-dollar launch motion.
- If asked about competitors, say SMIRK is narrower: missed-call recovery, owner alerts, callback tasks, and dashboard proof.
