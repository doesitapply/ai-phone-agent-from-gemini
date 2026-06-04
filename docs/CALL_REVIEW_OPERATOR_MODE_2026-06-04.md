# SMIRK Call Review: Operator Mode Hardening

Date: 2026-06-04

## Transcript Failures

The call failed because SMIRK treated Cameron like a prospect instead of the business operator. It repeatedly fell back to missed-call/demo language, asked unnecessary clarifying questions, and did not expose workspace-level operations such as completing all open tasks or listing handoff availability.

Specific gaps:

- Owner intent was not elevated into an internal operator mode.
- Phone-call task tools were scoped to the current contact, while dashboard chat tools already work at workspace scope.
- Calls could use OpenClaw or streaming responses before built-in tool calling, which meant operational commands could become spoken claims instead of database actions.
- Workspace context for call classification and temporary Boss Mode context was hardcoded to workspace `1`.
- Handoff availability was not available as a direct phone-call tool.

## Implemented Hardening

- Added owner/operator detection from `OWNER_PHONE`, `HUMAN_TRANSFER_NUMBER`, `OPERATOR_ALERT_NUMBER`, workspace `owner_phone`, and enabled Boss Mode `boss_phone`.
- Added an Operator / Boss Mode prompt block that tells the agent not to pitch SMIRK/demo flows to the owner.
- Added operator-only workspace tools for listing tasks, creating tasks, updating/transferring tasks, deleting tasks, completing all open tasks, and listing handoff targets.
- Routed operator calls away from OpenClaw/streaming bypass paths so built-in tool execution can actually run.
- Fixed incoming call workspace routing for classification and temporary context snapshots.
- Shared the operator tool registry across phone calls, dashboard chat, and Boss Mode.
- Kept Boss Mode confirmation/audit behavior for operator mutations while allowing read-only status/list actions immediately.
- Added structured before/after or deleted-task payloads to task mutation results so tool execution logs can prove what changed.
- Added `GET /api/workspace/onboarding-audit` to score whether a workspace has enough business profile, knowledge, team routing, and owner access to answer without guessing.

## What Still Takes This From Toy To Business

1. Add live call regression tests using recorded transcript scenarios: owner cleanup, handoff request, normal prospect demo, emergency, and frustrated transfer.
2. Add admin UI for owner phones and Boss Mode authorization so operator access is visible and revocable.
3. Add post-call verification that compares spoken claims against actual tool results, especially for task deletion/completion and transfers.
4. Surface the onboarding audit in the dashboard setup flow so customers know exactly what data the agent is grounded on.
