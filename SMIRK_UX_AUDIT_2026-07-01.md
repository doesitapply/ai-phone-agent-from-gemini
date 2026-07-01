# SMIRK UX Audit - 2026-07-01

This is a human-user pass through the local app at `http://localhost:3000`.

## Verdict

SMIRK is closer to an operator-assisted first customer than a clean self-serve SaaS product.

The core product idea is strong. The visible app looks real. The dashboard has the right raw materials. But the experience still feels like an internal operations cockpit with a public front door attached.

## What Was Verified

### Public Landing Page

- Loads locally.
- Has a clear first impression: missed calls cost money, SMIRK recovers them.
- Activation form enables after business name, email, and phone are entered.
- In local mode, activation falls back to an "online checkout is not available" style message.

Finding: visually strong, but the local buyer path does not end in a clean success state.

### Dashboard Sign-In

- `/dashboard` opens a private workspace access screen.
- Bad workspace credentials fail cleanly with an unauthorized message.
- Operator login works through `/dashboard?admin=1` with the configured local dashboard key.

Finding: auth behavior is sane, but normal users see a lot of concepts: invite link, activation request, status check, pricing, workspace ID, access token, saved profiles.

### Dashboard Shell

- Operator dashboard renders after sign-in.
- Dashboard cards and proof sections are visible.
- Review badge opens the Review Issues page.
- Review Issues page exists and explains what to fix.

Finding: the low-confidence/review path is now real, but the no-DB error state still shows generic `Failed to fetch` toasts.

### Contacts

- Contacts page loads.
- Search field exists.
- Status filter exists: `All statuses`, `Active`, `Lead`, `Customer`, `Inactive`, `Bad number`.
- DNC filter exists: `All DNC`, `Callable`, `DNC only`.
- Add Contact form includes status selection.
- Creating a contact without a database fails safely, but only says `Failed to fetch`.

Finding: contact status and DNC controls are present locally. The no-DB failure message is not customer-grade.

### Settings

- Settings page loads.
- CRM/business-data now points users to the CRM page.
- Setup wizard entry exists.
- Workspace mode is visible.
- Some backend-backed status areas fail or sit at `Loading...` without enough explanation in no-DB mode.

Finding: settings are usable for an operator, but still intimidating for a customer.

### Navigation

- On a narrow viewport, the dashboard collapses navigation behind a top-left icon.
- Opening the icon exposes primary and advanced navigation.
- The top-left icon appears as an unlabeled button in the accessibility snapshot.
- Some deep overflow items are awkward to reach on the narrow viewport.

Finding: usable, but not polished. The dashboard needs better accessible labels and a simpler customer nav.

## Bugs Fixed During This Pass

### No-DB Startup Crash

The app crashed during local startup without `DATABASE_URL` because `src/routes/calendar-routes.ts` built a SQL fragment during route registration.

Fixed by changing `appointmentSelect` from an immediately evaluated SQL template to a function that builds the fragment only when a calendar route is called.

Result: the app now boots locally without a database. Persistence routes still fail, as expected.

## Main Product Problems

### 1. Too Much Product Surface

The first buyer needs:

```text
Who called?
What did they need?
How urgent is it?
Who needs to call them back?
Was the callback handled?
```

The current dashboard also exposes CRM, appointments, handoffs, recovery, tasks, settings, admin, analytics, mission control, prospecting, agent config, voice config, lead hunter, integrations, agents, compliance, system health, and logs.

That is too much for a first customer.

### 2. Operator UI And Customer UI Are Still Blended

The operator needs the whole cockpit.

The customer needs a simpler owner view:

- Missed calls
- Summaries
- Callback tasks
- Contact details
- DNC/contact correction controls
- Billing/status

The current product makes a small-business owner look at too much internal machinery.

### 3. Error Messages Are Not SaaS-Grade

`Failed to fetch` is acceptable for a developer console, not for a customer-facing product.

Local/no-DB/customer-facing failures should say what happened and what to do next:

- "Database is not connected in this local environment."
- "This workspace could not be loaded."
- "Try again, or contact support if this keeps happening."

### 4. Local Demo Mode Is Not Real Demo Mode

No-DB mode is good for booting the shell. It is not good enough for selling or onboarding.

For a real demo, the product needs either:

- a real local Postgres setup, or
- a seeded demo workspace, or
- a deliberately mocked demo mode.

### 5. Mobile/Narrow Dashboard Needs Cleanup

The collapsed navigation works, but the unlabeled icon and long advanced menu make it feel internal.

## Ratings

- Business idea: 8/10
- Public landing page: 7/10
- Operator dashboard: 6/10
- Customer dashboard: 4/10
- Local developer setup: 6/10 after the no-DB crash fix
- Hands-off SaaS readiness: 4/10
- Operator-assisted first customer readiness: 7/10

## What Needs To Happen Next

1. Deploy the pending local contact/DNC/status changes after guarded approval.
2. Run live post-deploy proof checks.
3. Create or use one real customer workspace.
4. Run a real proof call for that workspace.
5. Confirm call record, summary, owner alert, callback task, and dashboard proof.
6. Replace generic `Failed to fetch` UI messages with actionable error states.
7. Split customer view from operator view.
8. Hide advanced/internal tools from normal customer sessions.
9. Add accessible labels to icon-only dashboard buttons.
10. Build a seeded demo workspace or require Postgres for demos.

## Plain-English Bottom Line

This can make money with operator help.

It is not ready to hand to random customers and expect them to self-serve without confusion.

