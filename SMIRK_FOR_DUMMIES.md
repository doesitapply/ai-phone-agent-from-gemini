# SMIRK For Dummies

Plain-English status as of 2026-07-01.

## What This Thing Is

SMIRK is supposed to save missed calls for small service businesses.

The simple version:

1. Customer calls the business.
2. Business misses the call.
3. SMIRK answers.
4. SMIRK gets the caller's name, phone, job, urgency, and callback details.
5. SMIRK writes a summary.
6. SMIRK emails or alerts the business owner.
7. SMIRK creates a follow-up task.
8. The owner looks in the dashboard and sees what needs to be done.

That is the business.

Everything else is secondary.

## What You Are Actually Building

You are building a missed-call recovery system, not a giant AI receptionist company yet.

The first thing to sell is:

> "If you miss a call, SMIRK answers it, captures the job, and tells you who to call back."

That is clear. That is sellable. That is what matters.

## Where It Really Is

### The good news

- The core app exists.
- The public landing page loads.
- The dashboard exists.
- The backend exists.
- Twilio webhook routes exist.
- Call records, contacts, tasks, handoffs, summaries, and DNC logic exist.
- Stripe/provisioning code exists.
- The first-dollar proof loop has been validated before.
- The latest contact status and DNC correction work is implemented locally.
- The local app now boots without a database after fixing a startup crash.

### The blunt truth

This is not a tiny MVP anymore.

It has too many features for something that should be sold as one simple missed-call product. It has multiple AI paths, multiple TTS paths, compliance logic, contact management, tasks, handoffs, proof dashboards, billing/provisioning, settings pages, and a lot of operational scripts.

That does not mean it is bad. It means it needs discipline.

## What Is Live

Production is live on Railway.

The current live app was verified on commit:

```text
b308980d191476866b9be7e3168584f8a687aeda
```

That live version already has the earlier review-issues work.

## What Is Local But Not Live Yet

These changes are in the local checkout but are not production-live yet:

- Contact status editing.
- Contact status filters.
- DNC filters.
- Contact-level Mark DNC.
- Contact-level Remove from DNC.
- Required note before removing DNC.
- DNC audit logging.
- Contact/DNC sync fixes.
- New contact-management check script.
- Updated README and paperwork.
- Local no-database startup crash fix.

To put those live, the guarded deploy still needs approval.

## What Is Broken Or Rough

### 1. The product story is still too complicated

The thing should feel like:

> Missed call goes in. Callback-ready lead comes out.

Instead, the repo still feels like:

> AI phone platform, CRM, compliance system, dashboard, provisioning machine, proof lab, integration hub, and ops cockpit.

That is too much for a buyer and too much for a first customer.

### 2. Local setup is fragile

Without `DATABASE_URL`, the app is only partially useful.

I fixed one no-database crash in `src/routes/calendar-routes.ts`, but no-DB mode still means many real dashboard actions cannot work because there is no persistence.

Plain English: you can open the app locally, but you cannot fully demo the product without a database.

### 3. Local OpenClaw is noisy

The local server is trying to connect to OpenClaw Gateway, but the gateway protocol does not match:

```text
PROTOCOL_MISMATCH
```

Plain English: the local AI gateway setup is not clean. It does not block looking at the frontend, but it is not a healthy local AI runtime.

### 4. The landing form is not satisfying in local mode

The public form enables after you type business name, email, and phone. But in the current local environment, the buyer ends up seeing an "online checkout is not available" style fallback.

Plain English: the form exists, but the local experience does not feel like a clean win.

### 5. The dashboard is probably too big

The dashboard has a lot of tabs and tools. That is good for an operator, but bad for a normal small-business owner.

Plain English: the operator dashboard and customer dashboard probably need to become two different experiences.

## What It Needs Next

### Before first real customer

1. Deploy the pending contact/DNC changes.
2. Confirm production is current.
3. Run post-deploy live checks.
4. Create or use a real customer workspace.
5. Run one real proof call for that workspace.
6. Confirm the owner gets the alert.
7. Confirm the dashboard shows the call, summary, and follow-up task.
8. Clean up any test records.

### Before it feels like real SaaS

1. Make onboarding less confusing.
2. Split owner/customer UI from operator/admin UI.
3. Make settings less scary.
4. Hide advanced tools from normal customers.
5. Make the first dashboard screen answer only:
   - Who called?
   - What did they need?
   - How urgent is it?
   - Who needs to call them back?
   - Did we follow up?
6. Make billing and usage understandable.
7. Make local setup less fragile.

## What To Stop Doing

- Stop describing it like a broad AI phone platform.
- Stop adding features before the missed-call loop feels obvious.
- Stop putting internal deploy drama in public-facing docs.
- Stop making the buyer understand tools, workflows, proof loops, and infrastructure.
- Stop treating green scripts as the same thing as a good user experience.

## What To Focus On

For the first customer, only prove this:

```text
Missed call -> SMIRK answer -> clean summary -> owner alert -> callback task -> dashboard proof
```

If that works, the product can make money.

If that feels confusing, none of the extra features matter.

## Current Rating

### Business idea

8/10.

Missed-call recovery is real and easy to explain.

### Current codebase

6/10.

Lots of working pieces, but too much surface area.

### Current UX

5/10.

The visual style is strong, but the user journey is still too complicated.

### Current readiness

7/10 for an operator-assisted first customer.

4/10 for hands-off SaaS.

## The Honest One-Sentence Version

SMIRK is a mostly working missed-call recovery product trapped inside an overgrown AI phone platform, and the next job is to make the simple customer journey obvious.
