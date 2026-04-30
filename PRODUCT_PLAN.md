# AI Phone Agent — First-Dollar Productization Plan

## Offer: What We Sell First

**“Stop losing missed calls. We answer, capture the job, and send you a callback-ready lead.”**

The first-dollar product is a **missed-call recovery and callback assistant** for owner-operated local service businesses. The system answers inbound calls, captures the customer’s job details, creates a callback task, emails the business owner a clean lead summary, and escalates urgent calls to a human when needed.

This MVP intentionally **does not include SMS**. Texting is removed from the first-dollar scope because it adds cost, compliance burden, delivery-status complexity, and support risk before the core buying promise has been proven.

## Pricing: Simple Enough to Sell Now

| Package | Price | Purpose |
|---|---:|---|
| Setup Deposit | $99 one-time | Low-friction first-dollar payment to configure the assistant. |
| Starter | $149–$299/mo | Single-location missed-call recovery and callback queue. |
| Pro | $499–$599/mo | Higher call volume, multiple workflows, advanced reporting, and white-glove setup. |

Usage should be explained simply. The MVP has Twilio voice-minute costs and AI usage costs, but the buyer should not need to understand infrastructure details during checkout.

## MVP Scope to Sell

### 1. Buyer-Friendly Onboarding Wizard

The onboarding wizard should collect business basics, callback preferences, notification email, operating hours, service area, greeting, qualification questions, human escalation rules, and a test-call flow. The wizard must avoid developer language and should not ask the user to configure SMS.

### 2. Email + Callback v1

Email and callback replace SMS as the near-term recovery workflow. After a call is captured, the app should create a callback task and email the owner or dispatcher with the caller’s name, phone number, issue, urgency, location if provided, preferred callback time, call summary, and recommended next action.

### 3. Deterministic Call Flow

The call flow should be predictable: answer, identify service need, collect caller details, determine urgency, capture callback information, escalate if required, and create a task. Booking can be added later, but first-dollar value comes from making missed calls actionable.

### 4. Dashboard Proof of Value

The dashboard should show calls captured, open callback tasks, urgent leads, completed callbacks, and estimated recovered revenue. Demo/test data should be separated from real production data.

### 5. Payment and Provisioning

A paid setup or first-month checkout should provision a workspace, create an owner invite, and route the buyer into onboarding. Failed provisioning should alert the operator immediately.

## Removed From MVP

| Removed Item | Reason |
|---|---|
| SMS confirmations | Too expensive and compliance-heavy for first-dollar MVP. |
| Inbound SMS webhook | Not needed to prove missed-call recovery. |
| SMS threading | Adds complexity before paid demand is proven. |
| STOP/HELP/START handling | Required for serious SMS usage, but irrelevant after SMS removal. |
| SMS delivery callbacks | Unnecessary for email/callback MVP. |
| Review-request SMS | Deferred indefinitely. |

## Build Order: Next Four Ticks

| Tick | Build Item | Done When |
|---:|---|---|
| 1 | Remove SMS claims from UI/docs and deploy self-serve workspace provisioning. | Public product no longer promises texting, and live signup can create a workspace. |
| 2 | Add payment capture with setup deposit or first-month checkout. | A buyer can pay online before or during onboarding. |
| 3 | Add email lead alerts and callback task creation after captured calls. | A captured call creates an owner email and callback task. |
| 4 | Revamp onboarding and dashboard around callback recovery proof. | New customer can test a call, receive an email, and see the callback task in the dashboard. |

## Demo: What We Show on Sales Calls

A sales demo should show a local business owner the simplest possible proof: call the AI number, describe a service issue, hang up, then show that the dashboard contains a callback task and the owner received a clean lead email. The demo should emphasize speed-to-callback and recovered revenue, not technical automation breadth.

## Success Metric

The core success metric is **recovered callback opportunities**. A customer should believe that one saved job can cover the monthly fee. The first product dashboard should therefore show calls captured, callbacks completed, urgent leads, and estimated recovered revenue.
