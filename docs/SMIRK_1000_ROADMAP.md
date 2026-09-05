# SMIRK 1000/1000 Roadmap

Last updated: September 5, 2026 America/Los_Angeles.

This roadmap turns the current `875 / 1000` state into a practical launch path. It is deliberately split between what is needed to sell the first customer and what belongs later in the enterprise database architecture.

## Current Baseline

Current score: `875 / 1000`.

Verified locally from the current checkout:

| Gate | Current evidence |
| --- | --- |
| TypeScript | `npm run lint` passed. |
| Production build | `npm run build` passed. |
| Customer dashboard contract | `npm run -s check:customer-dashboard` passed. |
| Offer and access contracts | `npm run -s check:plan-boundaries`, `npm run -s check:customer-dashboard`, and `npm run -s check:auth-regression` cover the one sellable Starter offer, tenant-scoped workspace access, and operator-only APIs. |
| Contact/DNC contract | `npm run -s check:contact-management` passed. |
| First-dollar scope | `npm run -s check:first-dollar-offer-scope` passed. |
| No-DB storage guard | `npm run -s check:no-db-storage-guard` verifies that customer-facing data routes fail closed without durable storage. |
| Historical July access proof | The old July plan-denial result belongs to the July report and is not the current access model. It must not be counted as proof of today's billing-entitled Starter owner contract. |
| Durable Twilio intake buffer | `npm run -s check:webhook-buffer` verifies raw inbound Twilio payload buffering, guarded replay, and stale-buffer lag monitoring without blocking call handling. |
| Final-mile audit | `npm run -s check:smirk-1000-final-mile` reports local final-mile completion separately from production readiness. |

## Phase 1: Finish The 1000/1000 Final Mile

Target score: `1000 / 1000`.

| Milestone | Points | Status | Proof command or artifact |
| --- | ---: | --- | --- |
| Fail-closed no-database storage guard | +35 | Implemented locally | `npm run build && npm run -s check:no-db-storage-guard` |
| Focused Starter owner UI | +50 | Implemented and contract-tested | `npm run -s check:customer-dashboard && npm run -s check:plan-boundaries` |
| Starter Owner Chaos Testing | +40 | Compatibility harness updated; must pass on each target claimed | `npm run check:basic-chaos` must return `STARTER_OWNER_CHAOS_PASSED` for concurrent billing-entitled Starter owner API access with masked credentials |
| Safe local acquisition audit loop | Supporting | Implemented as manual-review drafts | `python3 scripts/outbound_auditor.py --targets docs/outbound-auditor-targets.example.json --output /tmp/smirk-audit-test` |
| Interactive tracker | Supporting | Built | `docs/SMIRK_1000_TRACKER.html` |
| Final-mile audit | Supporting | Built | `npm run -s check:smirk-1000-final-mile` |

Completion condition for this phase:

```bash
npm run build
npm run -s check:no-db-storage-guard
npm run -s check:customer-dashboard
npm run -s check:plan-boundaries
npm run -s check:contact-management
npm run -s check:first-dollar-offer-scope
npm run check:basic-chaos
npm run -s check:smirk-1000-final-mile
npm run -s check:first-customer-10of10
```

The compatibility command name remains `check:basic-chaos`, but the old July plan-denial model is retired. The current Starter Owner Chaos Testing contract exercises owner APIs concurrently through a billing-entitled Starter identity and verifies that credentials remain masked. Only the explicit `STARTER_OWNER_CHAOS_PASSED` result counts for the target under test.

That result is still narrower than launch proof. A local pass does not establish current production parity, real payment, activation, tenant-isolation behavior on the deployed artifact, or a completed controlled call-to-callback loop. Any temporary live workspace, Stripe smoke, cleanup, or proof call remains behind its own approval gate.

## Phase 2: Buyer-Ready Product Surface

Goal: make SMIRK understandable to a contractor in 30 seconds.

| Workstream | Required outcome |
| --- | --- |
| Starter owner desk | Keep the one sellable offer focused on Calls, Tasks, Alerts, and tenant-scoped CRM/business context; keep provider and system settings operator-only. |
| Workspace APIs | Require billing entitlement for normal product access and pin every customer read/write to the authenticated tenant; do not add a hidden Pro server gate. |
| Legacy/future presentation | Treat `pro`, `enterprise`, and Pro/Agency UI concepts as compatibility or future planning only, not sellable backend entitlements. |
| Operator cockpit | Keep workspaces, logs, compliance, settings, voice config, health, provisioning, and deploy/proof tools behind `requireOperator`. |
| Onboarding | Reduce customer setup to business identity, protected phone number, owner alert email/phone, and proof call. |
| Demo | A real, isolated demo workspace should use approved business data and a controlled proof call; disconnected storage must never substitute fixture records. |

## Phase 3: First Revenue Loop

Goal: convert the product from a proven repository into a repeatable sales motion.

| Step | Definition of done |
| --- | --- |
| Pick one niche | Start with plumbing, HVAC, electrical, roofing, or handyman. |
| Create one simple pitch | "We catch missed calls and turn them into callback-ready jobs." |
| Use local audit drafts | Generate drafts only from manually curated targets. Review before sending. |
| Demo from a controlled workspace | Show only real or explicitly operator-entered demo data, then verify the isolated call, callback, alert, and dashboard evidence. |
| Close first Starter buyer | The $197/month paid checkout creates a workspace, invite works, dashboard opens, and callback proof appears. |
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
| Stage 1 | Shared Postgres plus durable webhook buffer | Implemented for raw Twilio intake | Low; improves call observability without schema rewrite. |
| Stage 1B | Guarded replay worker and lag monitor for buffered events | Implemented as dry-run/apply operator script plus stale-row check | Low to medium; adds recovery automation after the buffer proves useful. |
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

1. Run `npm run build && npm run -s check:no-db-storage-guard`.
2. Deploy the current commit so live parity is restored.
3. Run `WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag` against production after deploy.
4. Identify one approved billing-entitled Starter workspace on the current deployed commit.
5. Run `npm run check:basic-chaos` against that target and require `STARTER_OWNER_CHAOS_PASSED`; treat any needed provisioning or paid smoke as a separate approval-gated action.
6. Run `npm run -s check:smirk-1000-final-mile` and confirm `productionReady: true`.
7. Run `npm run -s check:first-customer-10of10`.
8. Record a Starter owner demo and a separate operator-only comparison without implying a sellable Pro entitlement.
9. Use `scripts/outbound_auditor.py` to create manual-review outreach drafts for one niche.
