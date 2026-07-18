# SMIRK Demo Operator Access

Demo operator access is for an employee or helper who needs to show SMIRK without being able to create spend or mutate production.

## Environment

Set these in Railway or the target runtime:

```bash
DEMO_OPERATOR_API_KEY=<strong separate random secret>
DEMO_OPERATOR_EMAILS=jesse@example.com
```

Keep `DASHBOARD_API_KEY` and `GOOGLE_ADMIN_EMAILS` for full admins only. Do not reuse the full admin key as the demo key.

## What Demo Operators Can Do

- Open the dashboard through `/dashboard?admin=1`.
- Use the separate demo operator API key, or Google sign-in if their email is listed in `DEMO_OPERATOR_EMAILS`.
- Switch between masked workspaces.
- View dashboard, review, calls, contacts, CRM, calendar, handoffs, recovery, tasks, analytics, and launch pages.
- Use the SMIRK chat bubble in read-only demo mode.

## What Demo Operators Cannot Do

- Start outbound calls.
- Send or test SMS.
- Launch prospecting, lead search, or auto-dialing.
- Request proof calls.
- Create, invite, patch, or delete workspaces.
- Change settings, agent identity, prompts, integrations, tools, or compliance records.
- Inject live call briefings.
- Write launch ledger entries.
- Fetch workspace API keys.

The server enforces these restrictions in `dashboardAuth`, so direct API calls with the demo key are denied even if a hidden UI button or stale browser state tries to call a blocked endpoint.

## Verification

Run:

```bash
npm run check:demo-operator-access
```

Before granting access, run the normal live-current and deploy checks for the launch branch. Do not use the demo key for real outreach, proof calls, paid spend, SMS, or Stripe smoke tests.
