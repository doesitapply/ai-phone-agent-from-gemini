# Velvet Control Chat

## Purpose

SMIRK already contains an authenticated chat bubble with function calling for its own calls, tasks, contacts, settings, agent prompts, and live-call briefings. The Velvet Control Chat extends that existing bubble so a **verified owner operator** can ask about the combined operating system without opening two dashboards.

This is not a general remote-code executor and does not dynamically load arbitrary Manus skills. The production surface is an explicit server-side registry of named, tested tools. That keeps authority inspectable, workspace-scoped, and auditable.

## Initial Operating Model

| Tool class | Example capability | Authority | Confirmation requirement |
|---|---|---|---|
| System read | Receiver health, active workspace, queued task counts | Read-only operator or workspace context as applicable | None |
| Velvet read | Qualification state, qualified-lead list, lead evidence, handoff/outcome status | Read-only through a narrow Velvet API key | None |
| SMIRK record action | Create, update, complete, or cancel a task; create or update a contact; save a briefing; schedule a follow-up; update an approved operator setting or agent prompt | Verified owner mode only | Latest operator message must exactly match `CONFIRM ACTION <tool_name>` |
| Contact action | Dial an exact phone target | Verified owner mode only | Latest operator message must exactly match `CONFIRM CALL <E.164 phone>` |
| Secret or infrastructure action | Change credentials, deploy, alter Railway variables, edit provider settings | Never delegated to chat | Outside this tool surface |

## Cross-System Boundary

SMIRK will call Velvet only through these configured values:

| Variable | Direction | Purpose |
|---|---|---|
| `VELVET_ALCHEMY_BASE_URL` | SMIRK → Velvet | Private Velvet API base URL |
| `VELVET_ALCHEMY_READ_KEY` | SMIRK → Velvet | New least-privilege read-only key for control-chat evidence retrieval |
| `VELVET_ALCHEMY_OUTCOME_KEY` | SMIRK → Velvet | Existing `outcome:write` key for post-call outcome delivery only |

The read key must not carry `handoff:write`, `outcome:write`, admin, key-management, payment, or deployment authority. The outcome key must never be used to retrieve leads. The inbound Velvet-to-SMIRK bearer remains separate and is not exposed to chat.

The outcome key is a defined capability boundary, not proof that automatic Velvet outcome delivery is live. As of this checkout, the source does not implement durable automatic outbound outcome posting. The operational loop and its current gaps are documented in [`VELVET_SMIRK_CLOSED_LOOP.md`](VELVET_SMIRK_CLOSED_LOOP.md).

## Initial Tools

The first release is intentionally narrow:

1. `get_velvet_system_state` reports Velvet reachability, qualification counts, and the latest handoff/outcome metadata available to the configured workspace.
2. `list_velvet_qualified_leads` lists only Velvet leads that already passed the hard qualification gate.
3. `get_velvet_lead_evidence` retrieves one specified lead’s audit evidence, qualification checks, handoff state, and returned outcome.

No cross-system tool will create a Velvet lead, override qualification, queue a new handoff, send outreach, or trigger a call in the first release. Those are potential future tools only after explicit confirmation UX and audit records are implemented.

## Chat UX

The existing SMIRK chat bubble gains a **System** mode next to Chat and Whisper. System mode exposes read-only prompts for Velvet state, qualified leads, and specific lead evidence, plus visible launch controls for task, contact, follow-up, and call workflows. A launch control only opens the guided chat workflow; it does not execute a write.

For a SMIRK record write, the agent must first gather the exact fields, recap the intended mutation, and ask for the tool-specific latest confirmation. For example, a task creation becomes eligible only after `CONFIRM ACTION create_task`. A new user message invalidates a prior confirmation. Outbound dialing remains stricter: it requires `CONFIRM CALL <E.164 phone>` for the exact target.

## Security Invariants

1. Every Velvet call includes the narrow read bearer server-side; it is never sent to the browser or model context.
2. Shared dashboard-key chat is read-only. Tool-capable mode requires a current verified Google identity matching the configured owner allowlist; it is rate-limited by the existing SMIRK chat route.
3. Tool output is bounded, redacted, and returned only to the authorized SMIRK operator session.
4. A remote failure returns an explicit degraded state. It never falls back to invented lead, call, outcome, or configuration data.
5. A chat request cannot become a mutation merely because the model inferred an intent. CRUD, briefing, agent, setting, and calendar tools are not available until the latest operator message exactly confirms the named tool.
6. A chat request cannot become a contact action merely because the model inferred an intent. `make_call` is not available until the latest operator message exactly confirms the same phone target.

## Deployment Gate

The code may ship with the tool registry disabled until `VELVET_ALCHEMY_BASE_URL` and an operator-created `VELVET_ALCHEMY_READ_KEY` are present in SMIRK. Until then, System mode must say **Velvet read access not configured** and make no network request.
