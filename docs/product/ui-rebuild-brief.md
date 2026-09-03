# SMIRK Product UI Rebuild Brief

## Product Position

SMIRK is **missed-call recovery for service businesses**. It is not a generic AI receptionist, a CRM, a call center, or an analytics dashboard. The interface must make the operational loop obvious: a caller reaches SMIRK when the owner cannot answer, SMIRK collects the essential details, the owner receives an alert, and the owner completes one callback.

## Current Visual Debt

The active frontend has a dark cyber-console aesthetic with neon-green accent saturation, global utility-class remaps, dense navigation, mixed corner radii, and multiple overlapping operational pages. These patterns read as an internal prototype rather than a trusted phone-product system. The public landing page also combines acquisition copy, billing setup, policy acknowledgement, activation lookup, and dashboard preview into one overloaded screen.

The signed-in product currently exposes a large page surface: Dashboard, Review, Calls, Contacts, CRM, Appointments, Handoffs, Recovery, Tasks, Settings, Analytics, Mission Control, Prospecting, Launch, Velvet, Agent, Voice, Lead Hunter, Integrations, Agents, Compliance, Workspaces, System Health, Logs, and Campaigns. Those screens may remain available to authorized operators, but they cannot all be treated as first-class navigation for a Starter owner.

## Direction

The supplied SMIRK UI pack is a directional reference, not an implementation template. Retain its strongest structural insight:

| Surface | Design language | Job |
|---|---|---|
| Public marketing and onboarding | Paper, ink, forest, editorial trade photography, clear one-action hierarchy | Explain the narrow offer and start a verified setup flow. |
| Owner desk | Dark mineral surfaces, restrained lime only for live/urgent state, large decision targets | Return missed calls, complete callbacks, inspect alerts, and control line settings. |
| Internal operator tooling | Quiet operational UI, visually subordinate to owner tasks | Support troubleshooting, configuration, audit, and internal launch work. |

The public system will use an editorial serif display paired with a practical sans-serif UI face. The owner desk will use the same system with a dark operational palette. Bright lime is a status color—not the primary personality of every component. Gradients, hacker grids, generic dashboard KPI cards, visual noise, fake proof, and nonessential panel stacks are prohibited.

## Owner Desk Information Architecture

Starter owner navigation is constrained to four actions:

1. **Calls** — call records, essential facts, transcript/recording when present, and immediate callback action.
2. **Tasks** — callback queue with urgency, owner, next step, and handled outcome.
3. **Alerts** — urgent notifications and unresolved handoffs that require attention.
4. **Settings** — line, hours, alert destination, recording notice, business context, and Starter billing/usage.

Advanced CRM, proof, compliance, prospecting, health, and campaign screens remain hidden behind operator access or a single advanced-tools route. This is navigation suppression, not feature deletion.

## Public Page Hierarchy

The public flow must be split into focused surfaces: Home, recovered-call demonstration, Pricing, Compare, industry fit pages, Setup, and policies. Exact payment, recording, SMS-alert, and proof claims remain conditional on live verification. Until the final operational proof and checkout chain are current, public copy must describe available setup paths rather than imply unverified outcomes.

## Non-Negotiable Build Constraints

The rebuild must preserve active API routes, authentication, policy acknowledgement, purchase gating, call and task controls, explicit handoff outcomes, workspace isolation, and Business Knowledge Pack activation. Visual improvements are not permission to broaden the Starter offer or claim unverified operational results.
