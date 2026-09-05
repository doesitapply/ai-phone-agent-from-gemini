# SMIRK Selective Caller Memory and Qualification

## Operating distinction

SMIRK keeps **call evidence** separate from **reusable caller memory**. Every completed call may retain the minimum auditable call, transcript, summary, task, and handoff records required by the product and approved retention policy. A caller does not automatically become a durable contact merely because a phone number reached the line.

Reusable memory is earned only when the call creates a legitimate future business need. The durable contact is then linked back to the call with an explicit promotion reason and timestamp.

| Promote reusable caller memory | Do not promote reusable caller memory |
|---|---|
| Qualified service request or estimate request | Immediate hangup or no conversation |
| Requested callback or owner follow-up | Wrong number or obvious spam |
| Requested appointment window | Administrative or identity-only test |
| Active-customer support, billing, warranty, or complaint issue | General question fully answered with no follow-up value |
| Explicit human handoff | Disqualified inquiry with no legitimate future obligation |
| Buyer onboarding request | Caller details supplied before any business purpose is established |
| Explicit do-not-contact request, for compliance enforcement | Model-only confidence score without supporting business intent |

## Promotion evidence

Each promotion must record a stable reason such as `service_request`, `estimate_request`, `callback_commitment`, `appointment_request`, `active_customer_issue`, `human_handoff`, `buyer_onboarding`, `compliance_request`, or `owner_saved`. Promotion is idempotent per workspace and phone number. Existing verified contacts remain available to returning callers.

## Qualification sequence

SMIRK asks one question at a time and stops when enough context exists for the next human action.

| Stage | Question objective | Required boundary |
|---|---|---|
| Purpose | What is the caller trying to get done? | Do not create memory from contact details alone. |
| Service fit | What system, service, or job is involved? | Do not diagnose the failure. |
| Location | Where would service be needed? | Collect only when relevant. |
| Urgency | Is anything actively unsafe, leaking, without power, or preventing use? | Route immediate danger to emergency services; do not give safety instructions. |
| Timing | When do they need help or a callback? | Treat requested times as preferences until a configured workflow confirms availability. |
| Access/context | What should the owner know before returning the call? | Avoid unnecessary personal or sensitive information. |
| Contact | What name and callback method should the owner use? | Ask after legitimate business purpose is established. |
| Next action | Callback, owner review, human handoff, or resolved inquiry | Never invent price, availability, warranty, diagnosis, or dispatch commitment. |

## Trade modules

Trade modules refine the service-fit questions without changing the commitment boundary.

| Trade | Additional useful questions |
|---|---|
| Plumbing | Fixture/system involved, active leak, water shutoff status if voluntarily known, property location, access constraints. |
| HVAC | Heating or cooling, system type if known, complete outage versus degraded performance, occupied property, requested timing. |
| Electrical | Device/circuit/panel involved, loss of power versus intermittent issue, visible smoke/sparking/burning smell as emergency indicators, property type. |
| Roofing | Leak versus inspection/estimate, active interior water entry, roof area if known, storm context, property location. |
| Auto repair | Vehicle year/make/model if known, drivable status, warning indicator, repair/diagnostic request, preferred timing. |
| Landscaping | Property type, requested service, approximate area if known, one-time versus recurring interest, location and timing. |

The agent must not claim a trade diagnosis, quote an unapproved price, confirm inventory or technician availability, interpret a warranty, or promise dispatch. Missing or uncertain facts become owner-review items.

## Voice authority boundary

Inbound callers may create a new callback, service-intake, support, or handoff obligation. They cannot modify existing dashboard work or instruct SMIRK to place a third-party outbound call. Owner-chat dialing remains separately identity-verified, confirmation-gated, and audited. Screened human transfer remains the only live-call bridge path.
