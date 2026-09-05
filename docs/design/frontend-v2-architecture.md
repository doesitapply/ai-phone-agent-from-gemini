# SMIRK Frontend V2 Architecture

## Decision

The existing `src/App.tsx` is a 14,000-line legacy frontend containing public acquisition pages, authentication, customer screens, operator tooling, and internal administration. Frontend V2 will not add another skin to that tree. It will introduce a new component root with explicit public, authentication, owner, and admin boundaries while retaining the existing backend routes and safety contracts.

## Route Boundary

| Route family | V2 responsibility |
|---|---|
| `/` | Reference-led public home with the warm industrial workfloor composition and no fabricated operational data. |
| `/launch` and `/pricing` | Single approved Starter offer, policy acknowledgement, and existing checkout issuance contract. |
| `/dashboard` | Today intelligence brief based on real workspace state. |
| `/dashboard/calls` | Call ledger and evidence inspector. |
| `/dashboard/tasks` | Recovery and callback obligations. |
| `/dashboard/alerts` | Human handoffs and owner decisions. |
| `/dashboard/settings` | Business identity, call behavior, knowledge, integrations, and account access. |
| `/dashboard/admin/*` | Verified full-operator capabilities, separated from customer navigation. |

## Navigation Contract

The customer owner sees four primary destinations: **Today, Calls, Tasks, Settings**. Alerts are surfaced contextually in Today and Tasks instead of competing as an abstract destination. The verified administrator receives a separate **Admin tools** entry with explicit system, workspace, integration, compliance, agent, and launch controls.

## Interaction Contract

Each primary screen answers one question and exposes one dominant action. Operational state uses the evidence grammar **signal received → context resolved → owner action**. Empty, unavailable, loading, denied, and degraded states remain distinct. No zero may be shown when the source is unavailable, and no illustrative data may be styled as live evidence.

## Visual Contract

Public light mode uses warm concrete, paper, brushed metal, graphite, and restrained signal green. Owner dark mode uses obsidian and gunmetal with the same physical geometry. Both modes use the same typography, spacing, state semantics, and mechanical receipt motif. Texture supports hierarchy; it does not reduce contrast or turn controls into decoration.

## Migration Rule

V2 may reuse backend API contracts and deterministic business logic. It must not reuse legacy page wrappers, navigation shells, dashboard grids, decorative telemetry, or duplicated customer/operator tab lists. Legacy code remains available only until V2 reaches route, authentication, and regression parity, then the entry point switches atomically.
