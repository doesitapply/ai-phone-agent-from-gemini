# SMIRK AI Phone Agent — Active TODO

- [ ] Reconcile production Stripe readiness with the live Launch Sprint dashboard
- [ ] Configure Stripe Starter, Pro, and Enterprise payment products and checkout paths
- [ ] Set production payment-link and webhook environment variables
- [ ] Validate Stripe test checkout through workspace provisioning

## Verified Progress — 2026-08-15

- [x] Bind the verified active $197/month Starter Stripe link and its allowlisted fulfillment ID in Railway production.
- [ ] Correct the stale production Stripe billing credentials so they belong to the active GlassBox merchant account.
- [ ] Publish and approve versioned customer-policy documents at trusted `smirkcalls.com` URLs before enabling recurring payment capture.
- [ ] Configure and validate the signed Stripe webhook and a completed checkout-session fulfillment proof.
- [ ] Enable at least one premium streaming TTS provider if streaming voice readiness is a launch requirement.

## Owner Decisions Recorded — 2026-08-15-v1

- [x] Prepare the versioned policy contract from Cameron's approved business choices without marking qualified legal review complete.
- [x] Verify Starter hard-stop enforcement blocks usage when either 500 calls or 1,000 minutes is reached.
- [x] Verify recording consent/compliance remains independent of the 90-day data-retention policy.
- [x] Configure and validate Stripe Test-mode checkout; Stripe-side subscription and event emission succeeded, while production provisioning correctly remained blocked by the separate live gate.

## Stripe Test-Mode Evidence

- [x] Created the non-production `SMIRK Starter — Test` recurring product in Stripe Test mode at $197/month.
- [x] Created active Stripe Test-mode SMIRK Starter Payment Link `plink_1U4uDVIoSdlZwew1KQikE4Ec` at $197/month with required full name, business name, and phone collection.
- [ ] Configure the Terms-of-Service agreement URL after the qualified-reviewed public Terms document exists; Stripe correctly reports Terms acknowledgement as unavailable until then.
- [x] Completed sandbox checkout with Visa `4242`; Stripe emitted `checkout.session.completed`, `customer.subscription.created`, `invoice.paid`, and successful $197 test payment events.
- [ ] Keep production fulfillment intentionally blocked until the live-only payment-link, signed webhook, qualified review, and public customer-policy requirements are all satisfied.

## Velvet Inbound Bearer Rotation

- [x] Verify the Velvet → SMIRK inbound handoff contract: unauthenticated input returns 401 and malformed authenticated input returns 400 without creating a handoff.
- [x] Install a distinct inbound bearer as the masked Railway production variable `VELVET_ALCHEMY_HANDOFF_API_KEY`, without source-control persistence.
- [x] Restart and health-check the active Railway service with the rotated bearer. Startup logs show a fresh initialization at 05:34 PDT; `/health` returned `status: ok` with 31-second uptime. The latest GitHub deploy remains skipped after a CI check-suite failure.
- [x] Validate the harmless synthetic inbound outcome proof: authenticated receipt returned 201, identical replay returned 200 DUPLICATE without duplicate queue work, and invalid authorization returned 401. The retired predecessor was not reintroduced merely for testing.

> Restart is owner-confirmed in Railway; the active deployment action menu exposes the service restart control.

> Deployment note: the current synced `main` repository does not yet contain the Velvet handoff source, but the user verified the production receiver contract independently before authorizing the Railway secret rotation.

## GitHub-to-Railway Release Repair

- [x] Identify the failing check: the scheduled `Reset Monthly Usage Counters` GitHub Action sends an empty `PHONE_AGENT_PROVISIONING_SECRET`, receives `401 Unauthorized`, and marks the commit check failed.
- [x] Prepare the minimum workflow correction without changing the healthy active callback deployment; GitHub workflow-file permission is required before it can be pushed.
- [ ] Verify the corrected check passes and a GitHub-sourced Railway deployment is eligible to run.

## Documentation and Release Record

- [x] Update README and operational documentation with verified non-sensitive Stripe, Velvet, Railway, and CI-release status.
- [ ] Review and push the documentation-only commit to GitHub without including credentials or unrelated local artifacts.
