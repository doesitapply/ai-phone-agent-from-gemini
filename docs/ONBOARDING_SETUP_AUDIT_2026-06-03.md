# Onboarding Setup Audit - 2026-06-03

## Cleanup Result

Production database cleanup was partially completed.

- `npm run cleanup:smoke-workspaces` dry-run matched 0 workspaces and 0 provisioning requests. That built-in cleanup only targets narrow smoke names and does not release Twilio numbers.
- Direct production DB inspection through `railway connect Postgres-sTit` found 1 real workspace and 1 mapped phone number.
- Two orphan test-like provisioning requests were deleted from production:
  - `Test Business`, `test@example.com`, `source=test`, `status=workspace_and_line_created`, created 2026-05-22.
  - `test`, `isthisaracket@gmail.com`, `source=landing:signup`, `status=manual_fallback_required`, created 2026-05-15.
- Post-cleanup recount: 1 workspace, 1 workspace phone number, 2 provisioning requests total, 0 suspicious orphan test provisioning requests.

Twilio external cleanup is blocked.

- `scripts/audit-clean-twilio-test-resources.mjs` was added to list test-like Twilio subaccounts, release their phone numbers, and close the subaccounts with explicit confirmation.
- The available Twilio credentials from Railway/local env fail Twilio API authentication with `Authenticate`.
- This means DB cleanup is done, but orphan Twilio subaccounts or numbers that no longer have DB rows may still exist in Twilio. They need valid master Twilio credentials or Console access to verify and release.

## Hardening Applied

`server.ts` now blocks test-like provisioning inputs before they can create paid resources.

- Public `/api/provisioning/request` now detects test/smoke/example inputs and records `test_rejected_no_paid_resources`.
- Secret `/api/provision/workspace` now records `test_rejected_no_paid_resources` and returns without creating a workspace or provisioning a phone number.
- Operator `/api/workspaces` creation now rejects test-like workspace creation instead of allowing a workspace path that can attach telephony.

The guard covers obvious cost-leak patterns: `test`, `testing`, `smoke`, `buyer-auth-smoke`, `webhook smoke`, `test@example.com`, `@example.com`, `+test`, `+smoke`, and the prior exact smoke names.

## Onboarding Capability Audit

Current system already has the foundation needed for business-specific answering.

- Setup wizard captures business name, industry, timezone, business hours, owner phone/email, agent name, persona, greetings, phone provisioning, notifications, and final health checks.
- Settings includes a DB-backed business profile with name, tagline, phone, website, address/service area, business hours, agent name, escalation phone, notification email, greetings, and persona.
- Settings includes Knowledge / CRM Import for CSV, JSON, text, and manual notes.
- CSV/JSON rows with phone numbers are merged into Contacts.
- Extra columns are stored as verified `contact_custom_fields`.
- Imported knowledge is exposed in an agent grounding preview.
- Live call prompts include uploaded workspace knowledge and explicitly instruct the agent not to invent prices, policies, service details, warranties, or customer facts.
- Dashboard chat also uses the workspace knowledge context.

## Gaps To Reach Production-Ready

1. Require setup completion before go-live phone provisioning.
   - Phone number provisioning should be behind a clear production intent gate: paid/confirmed customer, business profile complete, notification email verified, and knowledge import or explicit "no import yet" acknowledgement.

2. Move Knowledge / CRM Import into first-run setup.
   - It currently exists in Settings, but it is not a required onboarding step before phone activation.
   - Add a dedicated "Business Data" step before "Phone Number".

3. Add a setup completeness score.
   - Required: business name, service area/address, hours, owner escalation phone, notification email, inbound greeting, outbound greeting.
   - Recommended: services offered, pricing rules, service boundaries, FAQs, warranties, cancellation/reschedule policy, urgent/escalation rules.
   - Data: at least one uploaded source or explicit owner acknowledgement that the agent has no CRM/customer history yet.

4. Add no-guess readiness checks.
   - Before activation, show what the agent knows and what it will refuse to answer.
   - Run a synthetic prompt test against missing price/policy/service questions and verify it escalates instead of guessing.

5. Add Twilio lifecycle cleanup.
   - Workspace deletion/cancellation must release workspace phone numbers and close Twilio subaccounts before deleting DB rows.
   - Cleanup reports should include Twilio release status, not just database deletion.

6. Add a paid-resource confirmation step.
   - Any action that buys a number should show the cost/risk and require a production confirmation, even for operator/admin users.
   - Test and smoke paths should use dry-run, a fixed existing test number, or Twilio test credentials only.

7. Improve import scale and safety.
   - Current import route allows 256 KB request bodies and the parser caps content at 200,000 characters.
   - That is enough for small CRM exports but not full databases.
   - Add file upload storage, background import, row-level validation, import preview, and rollback.

8. Add data freshness and ownership controls.
   - Imported sources can be deleted, but contacts/custom fields imported from a source are not rolled back as a set.
   - Add source lineage to imported contact fields and a source-level rollback/delete impact preview.

9. Add CRM connector onboarding.
   - Existing integrations/webhooks can push and sync call data, but first-run onboarding should ask: upload file, paste export, connect CRM, or start empty.
   - The agent should know which path was chosen.

10. Add tests around cost gates.
    - Test-like public provisioning request must never call workspace or Twilio provisioning.
    - Secret provisioning with `source=test` must return `test_rejected_no_paid_resources`.
    - Operator workspace creation with test-like input must be rejected.
    - Phone provisioning endpoints should have a production confirmation or setup-complete gate.

## Immediate Milestones

### Milestone 1 - Stop Cost Leaks

- Ship the test-like provisioning guard.
- Add automated regression tests for all provisioning entry points.
- Get valid Twilio master credentials and run Twilio test-resource dry-run.
- Release/close confirmed test Twilio numbers/subaccounts.

### Milestone 2 - Make Setup Data-First

- Add "Business Data" to SetupWizard before "Phone Number".
- Reuse the existing Knowledge / CRM Import APIs and UI patterns.
- Block activation until either data is imported or the owner confirms the agent should start with only the business profile.

### Milestone 3 - Go-Live Readiness

- Add setup completeness scoring.
- Add no-guess synthetic call checks.
- Add email notification verification as a required check.
- Only enable phone provisioning after readiness passes or an operator explicitly overrides it.

### Milestone 4 - Resource Lifecycle

- Add workspace cancellation/deletion lifecycle that releases Twilio numbers and closes subaccounts.
- Add admin cleanup report with DB rows, Twilio numbers, subaccounts, and action results.
- Add scheduled monitor for orphaned Twilio resources not referenced by DB.

## Verification Performed

- `npm run lint` passed.
- `npx tsx scripts/check-test-provisioning-guard.mjs` passed: 5 blocked cases, 3 allowed cases.
- Production DB recount after cleanup: 1 workspace, 1 workspace phone number, 2 provisioning requests total, 0 suspicious orphan test provisioning requests.
- Twilio external cleanup dry-run failed with `Authenticate`; not applied.
