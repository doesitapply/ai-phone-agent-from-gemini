# SMIRK Mobile Revenue Operator Specification

## Objective

SMIRK should not behave like a directory of internal tools on a phone. The phone experience must answer one question quickly: **what is the next action most likely to preserve or create revenue?**

The mobile operating surface is therefore reduced to five decision paths: **Today**, **Calls**, **Recovery**, **Pipeline**, and **Velvet**. Settings, diagnostics, configuration, analytics, workspace administration, and less-frequent specialist surfaces remain available behind **More**, but are not part of the first mobile decision layer.

| Mobile surface | Primary operator question | Existing system of record |
|---|---|---|
| Today | What needs action now? | Dashboard, tasks, active calls, human handoffs |
| Calls | What happened and who needs a response? | Calls and contacts |
| Recovery | Which lost or missed conversations can be saved? | Recovery queue and callback workflow |
| Pipeline | Which leads should move next? | Prospecting, campaigns, lead hunter, CRM, appointments |
| Velvet | What did Velvet send, what did SMIRK do, and what must happen next? | Velvet handoffs, shared handoff queue, future source attribution |

## Navigation Rules

The desktop sidebar may retain the full specialist surface. The mobile drawer must expose only the five core paths plus a single **More tools** control. The expanded control retains every authorized page, preserving existing functionality without making every capability compete for attention.

The current active advanced page remains visible in the mobile drawer while it is open, so deep links and ongoing specialist work do not become unreachable.

## Velvet-Led Outreach Loop

Velvet is not an adjacent dashboard. It is an intake and feedback loop:

```text
Velvet lead / signal
  → SMIRK authenticated intake
  → source attribution + deduplication
  → consent / DNC / quiet-hours gate
  → human review or approved outreach sequence
  → call, recovery, booking, disqualification, or escalation outcome
  → outcome handoff back to Velvet
  → source-to-revenue evidence
```

The existing portal must display only verified receiver and handoff state. Any lead source attribution not currently persisted by the receiver is explicitly marked pending rather than inferred. A later intake contract must require an external lead ID, source, consent basis, contact fields, priority, and idempotency key before auto-outreach is allowed.

## Action Boundaries

SMIRK may prepare outreach candidates and show their compliance status. It must not automatically place calls, send SMS, send email, modify billing, change infrastructure configuration, or alter credentials from the mobile command layer without a separate explicit confirmation path and an audit record.

## Success Criteria

The first mobile screen should let Cameron answer four questions in under ten seconds:

1. Is a live call or urgent human handoff waiting?
2. Which missed lead should be recovered first?
3. Which lead is ready for an approved next outreach action?
4. Did Velvet deliver something that requires a response?

If an operator must scan a flat list of fifteen tabs to answer those questions, the interface has failed.
