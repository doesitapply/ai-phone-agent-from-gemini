# SMIRK Runtime and Zero-Dollar API Plan

Status date: 2026-08-08

This document records the verified production connections, the actual request path, and the operating plan while no new spending is authorized. It contains variable names and public provider links only. It does not contain secret values.

## Admin access

- Direct entry: `https://smirkcalls.com/admin`
- Equivalent entry: `https://smirkcalls.com/dashboard?admin=1`
- Admin Settings after operator sign-in: `https://smirkcalls.com/dashboard/owner-control`
- Sign in with the allowlisted Google admin identity shown by the login screen.
- A customer workspace session and a full-operator session are different modes. The `?admin=1` entry clears the customer session before operator sign-in.
- Full operator access can review all workspaces, calls, contacts, compliance records, provider posture, cost telemetry, and redacted credential inventory.
- Secret values remain write-only. The application must never return an existing token to the browser.

## What the system actually does

```text
Inbound caller
  -> Twilio phone number and voice webhook
  -> SMIRK server and workspace routing
  -> workspace business profile and approved knowledge in Postgres
  -> OpenRouter or Gemini language model
  -> text-to-speech provider for caller audio
  -> persisted call, transcript, summary, lead, and callback task in Postgres
  -> Resend owner alert when configured and eligible
  -> authenticated customer or full-operator dashboard
```

Supporting paths:

- Stripe handles checkout and starts provisioning only after all fulfillment gates pass.
- Google Calendar or Calendly supplies scheduling when a workspace enables it.
- Google Places can support business lookup and prospect research. It does not authorize contact.
- Telegram can carry guarded approval notifications only when its webhook secret and user/chat allowlists are complete.
- DNC removal is an audited correction or documented consent action. It is not permission to ignore federal, state, carrier, or platform restrictions.

## Verified production snapshot

The following was read from the full-operator overview on 2026-08-08. A green provider probe proves the named check only; it does not prove every product path.

| Connection | Observed state | Current resource | Action |
| --- | --- | --- | --- |
| Operator access | Online | Full operator and admin API capabilities | Use the admin entry URL |
| Twilio | Online | Account active, one SMIRK number, $9.89 balance | Keep current account; no new purchase |
| OpenRouter | Online | `google/gemini-2.5-flash`, $7.19 credits | Use existing credits |
| Gemini | Configured | Not independently live-probed in Admin Settings | Keep as fallback; do not prepay |
| ElevenLabs | Online | 10,000 characters remaining | Use existing free allocation |
| Resend | Online | SMIRK sender verified by provider probe | Reserve for transactional owner alerts |
| Postgres | Online | Persistent application database | Keep as source of truth |
| Google Calendar | Online | Admin calendar identity connected | Use only for approved scheduling flows |
| Google Places | Configured | Credential present | Prefer low-cost field masks and ID-only lookup |
| Stripe | Offline | Required exact payment-link configuration missing | Repair configuration before claiming self-serve checkout |
| Cartesia | Not configured | None | Do not add while funds are unavailable |
| OpenAI TTS | Not configured | None | Do not add while existing TTS works |
| OpenClaw bridge | Disabled | None | Keep disabled until a concrete requirement exists |
| Outbound webhook | Not configured | None | Not required for the basic inbound pilot |

Tracked August usage at the snapshot was zero calls, zero voice minutes, zero AI tokens, zero TTS characters, and $0 tracked variable spend. Provider invoices and balances remain authoritative because local cost telemetry can be incomplete.

## Current blockers

1. Production is running commit `2138435151dc09433528c1035eddd9b16331ed1e`, while the hardening branch is at `e4639f194796af12398a2dc3b1bc0c740389681c` before the changes in this document.
2. The live chatbot is Gemini-only and exposes the provider's depleted-credit error. The hardening branch already implements OpenRouter-first chat with Gemini fallback, but that code is not live.
3. Stripe is missing the exact current and historical payment-link identifiers and fulfillment allowlist required by the fail-closed checkout gates.
4. Railway backup creation requires a paid plan. No upgrade is authorized, so production deployment remains paused until there is a no-cost backup or another approved rollback method.
5. Settings entered through the app are durable only when `SETTINGS_PATH` points to mounted persistent storage. Railway environment variables remain authoritative across restart and deploy.

## Zero-dollar operating policy

1. Do not buy credits, activate auto-recharge, upgrade Railway, add a paid data source, or move providers.
2. Use the existing OpenRouter balance for dashboard chat after the hardening branch is safely deployed.
3. Keep Twilio because it already has a balance and is integrated. Provider migration can wait until real call volume makes the savings larger than the implementation and porting cost.
4. Use ElevenLabs only within the remaining allocation. A Google Cloud TTS fallback is reasonable only after hard quotas and billing alerts are in place.
5. Keep Resend for transactional alerts. Do not restart cold outreach merely because the provider is online.
6. Use Google Places field masks and ID-only requests where possible. Avoid paid enrichment APIs.
7. Keep SMS off for cold outreach. Any future SMS test needs documented opt-in, an allowlist, per-message approval, duplicate prevention, a daily count cap, and a dollar cap.
8. Keep outbound dialing off unless the contact has an approved legal basis and an operator authorizes that exact test.

## Cost comparison for later

These are public list prices, not negotiated invoices. Recheck them before changing a provider.

| Need | Current or candidate | Public price signal | Decision now |
| --- | --- | --- | --- |
| US voice | [Twilio Voice](https://www.twilio.com/en-us/voice/pricing/us) | Local inbound $0.0085/min, outbound $0.014/min, local number $1.15/month | Keep; existing balance and integration matter more at zero volume |
| Lower-cost US voice | [Telnyx Voice API](https://telnyx.com/pricing/voice-api) | Platform fee and SIP charges can be lower, depending on number and route | Evaluate only after measured volume; migration and porting are not free |
| Dashboard and workflow AI | [OpenRouter Gemini 2.5 Flash](https://openrouter.ai/google/gemini-2.5-flash) | $0.30/M input tokens and $2.50/M output tokens | Use existing credits |
| Cheaper compatible AI candidate | [OpenRouter Gemini 3.1 Flash Lite](https://openrouter.ai/google/gemini-3.1-flash-lite) | $0.25/M input tokens and $1.50/M output tokens | Test locally later; do not mutate production blindly |
| Direct Gemini | [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) | Free tier exists with model-specific limits | Keep fallback; depleted prepayment must render as a controlled provider error |
| Text to speech | [Google Cloud TTS](https://cloud.google.com/text-to-speech/pricing/) | Standard voices include 4M free characters/month, then $4/M; billing setup is still required | Potential fallback only with hard quota and alerting |
| Current text to speech | [ElevenLabs API](https://elevenlabs.io/pricing/api?price.platform=api) | Free allocation and pay-as-you-go rates vary by model | Consume existing allocation only |
| Transactional email | [Resend](https://resend.com/pricing) | Free plan: 3,000 emails/month and 100/day | Keep for owner alerts |
| Search data | [Brave Search API](https://brave.com/search/api/) | $5 free monthly credits, then $5/1,000 requests; free use still requires a card | Do not activate while no payment method is available |
| Business lookup | [Google Maps Platform pricing](https://developers.google.com/maps/billing-and-pricing/pricing) | Free usage caps vary by SKU; Place IDs-only operations are the lowest-cost path | Use strict field masks and monitor SKU counts |

## Key management rules

- Admin Settings reports whether a credential is configured, which provider probe passed, current usage when the provider exposes it, and the correct provider console or billing link.
- Existing secret values are never displayed or copied back to the browser.
- In-app configuration writes must be labeled runtime-only unless mounted persistence is proven.
- Production secrets should be changed in Railway, followed by a provider probe and a harmless test.
- Credential rotation, provider purchases, billing changes, and production deploys remain separate approval gates.
- A provider button may open an official console. It must not silently purchase credits, enable auto-recharge, or rotate a credential.

## Small deliverables

1. Ship the direct admin entry and auditable DNC-removal repair to GitHub, with no production deploy.
2. Obtain a no-cost production backup or an explicitly approved rollback substitute.
3. Deploy the already-tested hardening branch and verify the live commit fingerprint.
4. Verify Admin Settings on desktop and mobile, including OpenRouter chat fallback and deliberate provider error states.
5. Repair Stripe configuration without creating or charging a checkout, then run read-only readiness checks.
6. Run one synthetic inbound pilot through call, transcript, summary, lead, and callback task.
7. Only after the inbound pilot is proven, approve one exact real-world transaction at a time.

## Prohibited shortcuts

- No cold SMS.
- No auto-dialing.
- No purchased-list blasting.
- No automatic DNC override.
- No secret-value display.
- No LLM-authorized sending or spending.
- No unsupported revenue or lost-job claims.
- No production deploy while rollback evidence is unavailable.
