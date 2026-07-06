# SMIRK 1000/1000 Roadmap

Last updated: July 6, 2026 America/Los_Angeles.

This roadmap turns the current `875 / 1000` state into a practical launch path. It is deliberately split between what is needed to sell the first customer and what belongs later in the enterprise database architecture.

## Current Baseline

Current score: `875 / 1000`.

Verified locally from the current checkout:

| Gate | Current evidence |
| --- | --- |
| TypeScript | `npm run lint` passed. |
| Production build | `npm run build` passed. |
| Customer dashboard contract | `npm run -s check:customer-dashboard` passed. |
| Plan boundary contract | `npm run -s check:plan-boundaries` passed. |
| Contact/DNC contract | `npm run -s check:contact-management` passed. |
| First-dollar scope | `npm run -s check:first-dollar-offer-scope` passed. |
| No-DB demo reads | `npm run -s check:no-db-demo-mode` passed with local demo calls, contacts, tasks, transcripts, and review items. |
| Local Basic chaos | Temporary local Postgres-backed Starter workspace provisioning passed; 36 Basic-allowed requests and 96 Pro-restricted requests returned the expected boundaries, then cleanup succeeded. |

## Phase 1: Finish The 1000/1000 Final Mile

Target score: `1000 / 1000`.

| Milestone | Points | Status | Proof command or artifact |
| --- | ---: | --- | --- |
| High-fidelity No-DB demo mode | +35 | Implemented locally | `npm run build && npm run -s check:no-db-demo-mode` |
| Handyman Shield UI partition | +50 | Implemented and contract-tested | `npm run -s check:customer-dashboard && npm run -s check:plan-boundaries` |
| Basic chaos validation | +40 | Proven locally with approved temp provisioning; live proof still pending | `npm run -s check:basic-chaos` with either a real Basic token or explicit temp provisioning |
| Safe local acquisition audit loop | Supporting | Implemented as manual-review drafts | `python3 scripts/outbound_auditor.py --targets docs/outbound-auditor-targets.example.json --output /tmp/smirk-audit-test` |
| Interactive tracker | Supporting | Built | `docs/SMIRK_1000_TRACKER.html` |

Completion condition for this phase:

```bash
npm run build
npm run -s check:no-db-demo-mode
npm run -s check:customer-dashboard
npm run -s check:plan-boundaries
npm run -s check:contact-management
npm run -s check:first-dollar-offer-scope
SMIRK_BASIC_CHAOS_WORKSPACE_ID=<real-basic-workspace-id> SMIRK_BASIC_CHAOS_TOKEN=<real-basic-token> npm run -s check:basic-chaos
npm run -s check:first-customer-10of10
```

The local DB-backed Basic chaos path is now proven. The remaining proof gap is live Basic chaos validation after production runs the current commit. It requires either a real Starter/Basic workspace token or an approved temporary Starter workspace on the live app. Contract tests and local provisioning are not enough to call the production surface done.

To create a temporary Starter workspace through the real operator API, use:

```bash
ALLOW_SMIRK_BASIC_CHAOS_PROVISION=1 DASHBOARD_API_KEY=<operator-key> npm run -s check:basic-chaos
```

If this provisions a temporary workspace, rerun with `CONFIRM_SMIRK_BASIC_CHAOS_CLEANUP=delete-temp-basic-workspace` to remove it after evidence is captured.

## Phase 2: Buyer-Ready Product Surface

Goal: make SMIRK understandable to a contractor in 30 seconds.

| Workstream | Required outcome |
| --- | --- |
| Basic dashboard | Calls, Contacts, Tasks only. No logs, config, integrations, health, telemetry, or operator tools. |
| Pro dashboard | Full customer suite without operator-only machinery. |
| Operator cockpit | Keep workspaces, logs, compliance, settings, voice config, health, provisioning, and deploy/proof tools behind operator auth. |
| Onboarding | Reduce customer setup to business identity, protected phone number, owner alert email/phone, and proof call. |
| Demo | Local No-DB dashboard should open without Postgres and show believable emergency-service scenarios. |

## Phase 3: First Revenue Loop

Goal: convert the product from a proven repository into a repeatable sales motion.

| Step | Definition of done |
| --- | --- |
| Pick one niche | Start with plumbing, HVAC, electrical, roofing, or handyman. |
| Create one simple pitch | "We catch missed calls and turn them into callback-ready jobs." |
| Use local audit drafts | Generate drafts only from manually curated targets. Review before sending. |
| Demo from No-DB mode | Show calls, contacts, transcripts, DNC review, and tasks without external billing footprints. |
| Close first Basic or Pro buyer | Paid checkout creates workspace, invite works, dashboard opens, callback proof appears. |
| Run post-sale proof | Verify owner alert, callback task, dashboard proof, cleanup safety, and live parity. |

## Phase 4: Production Reliability Spine

Goal: reduce the chance that a database hiccup drops a high-value inbound call.

The objective file proposes a "Sovereign, Multi-Tenant Database Grid with Localized Failover." That is directionally useful, but the safe implementation path is incremental. The current repo already has `workspaces`, workspace-scoped tables, and workspace indexes. Replacing the schema wholesale with `VARCHAR` IDs and new table names would be risky and would break live routes.

Recommended sequence:

1. Add a durable webhook event buffer.
2. Write raw Twilio webhook payloads to the buffer before expensive AI or database work.
3. Add retry workers that replay buffered events into Postgres.
4. Add Redis only for short-lived call-session and TwiML coordination if real latency requires it.
5. Add database latency alarms and failover behavior before changing tenant topology.
6. Add tenant export/restore tooling before schema-per-tenant.
7. Consider schema-per-tenant only after real customers prove that shared-table workspace isolation is the limiting factor.

## Database Architecture Roadmap

| Stage | Architecture | When to use it | Risk |
| --- | --- | --- | --- |
| Stage 0 | Current shared Postgres with `workspace_id` isolation | Now | Lowest; already implemented. |
| Stage 1 | Shared Postgres plus durable webhook buffer and retry worker | Before scaling sales | Low to medium; improves call survival without schema rewrite. |
| Stage 2 | Shared Postgres plus Redis call-session cache | When webhook latency affects calls | Medium; adds operational dependency. |
| Stage 3 | Workspace export, restore, and data-residency boundaries | When agencies or larger customers ask for separation | Medium; builds enterprise credibility. |
| Stage 4 | Schema-per-tenant for high-value enterprise tenants | Only after revenue justifies operational overhead | High; migration and query complexity. |
| Stage 5 | Distributed database cluster | Only after multi-region demand or uptime economics justify it | Highest; do not do this before usage demands it. |

## What Not To Do Yet

- Do not rewrite `src/db.ts` around a new "billion-dollar" schema that does not match the existing routes.
- Do not replace integer workspace IDs with string IDs without a migration plan.
- Do not add Redis, CockroachDB, Vitess, or schema-per-tenant because it sounds valuable.
- Do not build autonomous outbound scraping or email blasting.
- Do not sell SMS/texting as part of the first-dollar product.

## Next Concrete Actions

1. Run `npm run build && npm run -s check:no-db-demo-mode`.
2. Deploy the current commit so live parity is restored.
3. Provision or identify one live Starter/Basic workspace.
4. Run `npm run -s check:basic-chaos` with that live Basic token or approved live temp provisioning.
5. Run `npm run -s check:first-customer-10of10`.
6. Record a Basic demo and a Pro/operator comparison.
7. Use `scripts/outbound_auditor.py` to create manual-review outreach drafts for one niche.
