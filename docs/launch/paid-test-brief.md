# SMIRK Guarded Paid Test Brief

Paid spend is capped at $500 total and does not start until readiness gates are green or the test is explicitly marked as pre-proof research. This brief prepares ad structure only; it does not authorize spend.

## Source Notes

- LinkedIn Lead Gen Forms: `https://business.linkedin.com/advertise/ads/sponsored-content/lead-gen-ads`
- Google Local Services Ads: `https://business.google.com/us/ad-solutions/local-service-ads/`
- Google responsive search ad guidance: `https://support.google.com/google-ads/answer/6167122`
- Meta lead ads reference: `https://www.facebook.com/business/help/761812391313386`

## Spend Gates

Required before spend:

- `npm run check:landing-live`
- `npm run check:live-is-current`
- `npm run check:paid-handoff-safety`
- `/dashboard/launch` can log source, campaign, response, demo, checkout, and activation status.
- Landing page analytics are posting to `/api/launch/events`.
- Checkout starts are trackable.
- Self-serve activation proof has passed, or the test is explicitly labeled pre-proof research.

Human approval required:

> APPROVE_SMIRK_PAID_TEST: $500 cap, no cold SMS, no automated phone spam, no Local Services Ads provider impersonation.

## Budget

- Meta or Instagram lead/demo test: $200.
- Google Search long-tail test: $150.
- Retargeting: $100.
- Creative/tooling reserve: $50.

Hard stop:

- $500 total spend with 0 qualified replies.
- Any channel creates compliance risk.
- Any channel produces checkout starts that fail activation.

## Meta / Instagram Lead Test

Objective:

> Book proof walkthroughs or collect qualified owner/operator interest.

Audience:

- Home-service business owners.
- Field-service managers.
- Local service contractors.
- Agency owners serving trades.

Geography:

- 2-3 selected regions only.

Creative angles:

1. Missed job calls become callback tasks.
2. Proof dashboard after one call.
3. Owner alert while crews are busy.

Primary text A:

> Missing job calls while you are already on a job? SMIRK turns missed or forwarded calls into caller summaries, owner alerts, callback tasks, and dashboard proof.

Primary text B:

> For plumbers, HVAC, roofers, electricians, and repair shops: test one proof call before trusting any AI receptionist promise.

Headline options:

- Missed-call recovery
- See one proof call
- Calls to callback tasks
- Built for service teams

Lead form questions:

- Business name.
- Trade.
- Region.
- What happens when calls are missed today?
- Are you open to a proof walkthrough?

Do not ask for sensitive personal data. Do not ask for consent to SMS marketing.

## Google Search Test

Campaign type:

> Search only. Do not use Google Local Services Ads as SMIRK because SMIRK is not advertising as a plumber, HVAC provider, roofer, electrician, or other local contractor.

Ad groups:

- AI receptionist for plumbers.
- Missed call service for contractors.
- HVAC answering service alternative.
- Contractor call answering software.
- Auto repair missed calls.

Exact/phrase starter keywords:

- "ai receptionist for plumbers"
- "missed call service for contractors"
- "contractor call answering software"
- "hvac answering service"
- "roofing call answering"
- "auto repair answering service"
- "missed call recovery software"

Negative keywords:

- job
- salary
- free
- template
- script
- call center jobs
- receptionist jobs
- answering service employment

Responsive search headlines:

- Missed-Call Recovery
- AI For Missed Calls
- Built For Contractors
- Calls To Callback Tasks
- Owner Alerts Fast
- Proof After Every Call
- Starter At $197/Mo
- For Plumbers And HVAC
- Stop Losing Job Calls
- See One Proof Call

Descriptions:

- SMIRK captures missed job calls, summarizes urgency, alerts the owner, and creates callback work.
- Built for home-service teams that need proof after calls hit voicemail or forwarding.
- Start with one proof call. No cold SMS. No unsupported revenue promises.
- Starter begins at $197/month with clear usage limits.

Landing URLs:

- `https://smirkcalls.com/launch`
- `https://smirkcalls.com/pricing`
- `https://smirkcalls.com/industries/plumbing`
- `https://smirkcalls.com/industries/hvac`

## LinkedIn Lead Gen Test

Use LinkedIn only as a narrow owner/operator or agency test. Do not broaden into generic SMB.

Audience:

- Owners/founders.
- Operations managers.
- Field-service agency owners.
- Local service company operators.

Lead form:

- Name.
- Company.
- Work email.
- Job title.
- Company website.
- Primary trade.
- Missed-call problem severity: none, occasional, weekly, daily.

CTA:

> Book proof walkthrough

## Retargeting

Retarget only visitors to:

- `/launch`
- `/pricing`
- `/industries/plumbing`
- `/industries/hvac`
- `/compare`

Creative:

- Proof loop screenshot.
- Callback task screenshot.
- Pricing clarity screenshot.

Frequency:

- Low frequency cap.
- Stop after 30 days or after a booked demo.

## Tracking

Every paid lead must be logged in `/dashboard/launch` with:

- source
- channel
- campaign
- message_variant
- response
- proof_walkthrough_status
- checkout_status
- activation_status
- spend_cents
- next_state

Use campaign names:

- `meta_proof_walkthrough_v1`
- `google_search_missed_call_v1`
- `linkedin_owner_operator_v1`
- `retargeting_proof_loop_v1`

## Claims Policy

Allowed:

- "Missed-call recovery for home-service businesses."
- "Call summaries, owner alerts, callback tasks, dashboard proof."
- "Starter begins at $197/month."
- "Proof call before broad rollout."

Not allowed:

- Guaranteed recovered revenue.
- Fully automated SaaS until proof passes.
- Replaces your receptionist.
- Unlimited usage.
- SMS-first acquisition.
- Local Services Ads provider claims.
