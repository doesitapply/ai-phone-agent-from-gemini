# SMIRK Grant Matrix

This file defines which access unlocks which SMIRK operations, where that access should be stored, and which actions still require explicit approval.

## Secret Storage

Use the OpenClaw workspace env files for operator and app secrets:

- Operator/admin auth: `~/.openclaw/workspace/.env.operator`
- SMIRK service env: `~/.openclaw/workspace/.env.smirk`
- Inventory: `~/.openclaw/workspace/state/secret-inventory.json`

Set values without putting secrets in shell history:

```bash
SECRET_VALUE='value' npm run set:operator-secret -- KEY operator
SECRET_VALUE='value' npm run set:operator-secret -- KEY smirk
```

Audit what is present:

```bash
npm run check:secret-inventory
```

## Access Matrix

| Tool or account | Credential or access | Store in | Unlocks |
| --- | --- | --- | --- |
| Railway | `RAILWAY_API_TOKEN` or `RAILWAY_TOKEN` | `.env.operator` | Read/set service variables, deploy, redeploy, compare live env, run Railway checks |
| GitHub | Local git auth, `GITHUB_TOKEN`, or `GITHUB_PAT` | `.env.operator` | Fetch, push branches, inspect PRs, merge PRs when permitted |
| Resend | `RESEND_API_KEY` | `.env.smirk` | Add/check sending domains, export DNS records, verify domain state, test email readiness |
| Namecheap DNS | Logged-in browser session or registrar API credentials | browser or `.env.operator` | Add Resend DKIM/SPF/MX records, manage domain DNS |
| Stripe | Logged-in browser session or live `STRIPE_SECRET_KEY` | browser or `.env.operator` | Create products/prices/payment links, inspect payment configuration |
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | `.env.smirk` | Validate phone setup, configure/test messaging and calling flows that API permits |
| Phone app operator | `DASHBOARD_API_KEY` | `.env.smirk` and Railway | Full SMIRK dashboard operator profile and admin-only API checks |
| Landing to phone provisioning | `PHONE_AGENT_PROVISIONING_SECRET` | `.env.smirk` and both Railway services | Authenticated landing-to-phone workspace provisioning |
| Email sender | Verified `FROM_EMAIL` such as `SMIRK <alerts@smirkcalls.com>` | `.env.smirk` and Railway | Owner alert emails and buyer provisioning emails |
| Booking fallback | `BOOKING_LINK` | `.env.smirk` and Railway | Manual setup fallback from pricing/provisioning flows |
| OpenClaw gateway | Gateway URL/token/model env | `.env.smirk` | Live agent/gateway bridge checks and OpenClaw injection workflows |

## Highest-Value Setup Order

1. `RAILWAY_API_TOKEN` or `RAILWAY_TOKEN`
2. `RESEND_API_KEY`
3. verified `FROM_EMAIL`
4. `PHONE_AGENT_PROVISIONING_SECRET`
5. `DASHBOARD_API_KEY`
6. `TWILIO_ACCOUNT_SID`
7. `TWILIO_AUTH_TOKEN`
8. `TWILIO_PHONE_NUMBER`
9. `GITHUB_TOKEN` or `GITHUB_PAT`
10. Stripe live secret or logged-in Stripe browser session
11. Namecheap logged-in browser session or DNS API access

## Browser Sessions That Help

Keep these logged in when dashboard-only work is needed:

- Railway
- Resend
- Namecheap
- Stripe
- Twilio

## Approval Required

Even with access, do not do these silently:

- buy domains
- buy phone numbers
- change billing or subscription settings
- rotate major production secrets
- delete production data
- force-push or rewrite git history
- remove DNS records that may support live production traffic

## Current SMIRK Sender Domain Flow

Use `smirkcalls.com` for Resend sender verification.

Target sender:

```text
SMIRK <alerts@smirkcalls.com>
```

After DNS is published and Resend verifies the domain:

```bash
FROM_EMAIL='SMIRK <alerts@smirkcalls.com>' npm run set:operator-secret -- FROM_EMAIL smirk
npm run set:live-from-email
```

Then rerun:

```bash
npm run check:railway:resend-domain
npm run check:railway:first-dollar-env
```
