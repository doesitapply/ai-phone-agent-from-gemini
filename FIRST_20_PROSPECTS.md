# SMIRK First 20 Prospects

Purpose: start outreach only from the proven missed-call recovery offer.

SMIRK is selling one narrow outcome:

- answer missed calls when the business cannot pick up
- capture caller name, phone, job details, urgency, and next action
- email the owner a callback-ready lead
- create a callback task
- show proof in the dashboard

Do not sell customer texting, full dispatch, a call center, or a generic AI receptionist suite.

---

## Readiness Gate

Before contacting prospects, verify:

- `npm run -s check:no-texting-copy`
- `npm run -s check:live-is-current`
- `npm run -s check:proof-loop-live`
- `npm run -s check:proof-artifacts-live`
- `npm run -s check:operational-auth-live`

Pass means:

- live app matches local HEAD
- public operational routes reject unauthenticated access
- one correlated proof call exists
- proof includes call summary, owner email event, open callback task, and dashboard count
- buyer copy still excludes customer texting claims

If any check fails, fix the product path before outreach.

---

## Target Profile

Start with owner-operated local service businesses where missed calls plausibly cost jobs:

- HVAC
- plumbing
- roofing
- electrical
- landscaping
- auto repair
- pest control
- garage door repair
- handyman and small contractors

Best first targets:

- owner or general manager answers the phone personally
- fewer than 10 trucks or crews
- public website has one main phone number
- reviews mention responsiveness, scheduling, emergencies, or missed follow-up
- service area is local enough for a callback to matter

Avoid for the first 20:

- franchises with corporate call centers
- businesses that only use online booking
- restaurants, medical offices, legal offices, or regulated verticals
- companies that appear to have a dedicated receptionist team

---

## One-Sentence Offer

SMIRK answers missed calls, captures the job details, emails you a callback-ready lead, creates a callback task, and shows proof in the dashboard.

Shorter phone version:

SMIRK keeps missed calls from turning into lost jobs.

---

## Proof Line

Use this only after the proof checks are green:

We have a live proof call showing the whole loop: call captured, summary generated, owner email sent, callback task created, and dashboard proof recorded.

Do not exaggerate this into broad production scale. It is proof of the workflow, not proof of hundreds of customers.

---

## First Call Script

Open:

Hi, this is Cameron with SMIRK. Quick question: when your team misses a call during a job, does it usually become a clean callback, or does it sit in voicemail?

If they engage:

SMIRK is a missed-call recovery assistant for service businesses. It answers when you cannot, captures the caller details, emails you the lead, and creates the callback task so the job does not disappear.

Qualification:

- What kind of calls do you most hate missing?
- Roughly how many calls do you miss in a busy week?
- Who handles callbacks today?
- Would a callback-ready email and task be useful, or do you already have that covered?

Close for demo:

I can show you the exact proof loop on a real call in 15 minutes. If it looks useful, Starter is $197/month.

If not interested:

No problem. If missed calls become painful, the simplest version is at smirkcalls.com.

---

## Cold Email

Subject: missed calls at {{company}}

Hi {{name}},

Quick question: when {{company}} misses a call during a job, does someone reliably turn it into a callback-ready lead?

SMIRK answers missed calls, captures the job details, emails the owner a summary, creates a callback task, and shows proof in the dashboard.

We are starting with a narrow missed-call recovery workflow, not a broad call center. Starter is $197/month.

Worth a 15-minute look?

Cameron

---

## Demo Flow

Keep the demo to 15 minutes:

1. Show the offer in one sentence.
2. Show the proof dashboard counters.
3. Show the correlated proof call.
4. Show the owner email summary.
5. Show the callback task.
6. Show pricing.
7. Ask whether missed-call recovery would save at least one job a month.

Do not spend the demo touring internal operator controls.

---

## Tracking Sheet Columns

- Business
- Industry
- City
- Owner or manager
- Phone
- Email
- Source
- Missed-call pain signal
- Outreach date
- Response
- Demo booked
- Outcome
- Notes

---

## Hard Stop Rules

Stop outreach and fix the product if:

- the checkout path stops returning a Stripe URL
- proof artifacts stop correlating
- owner email alerts fail
- callback tasks are not created
- public operational routes return customer or operator data without auth
- any copy starts implying customer texting

