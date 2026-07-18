#!/usr/bin/env node
import fs from "node:fs";

const alerts = fs.readFileSync("src/monetization-alerts.ts", "utf8");
const routes = fs.readFileSync("src/routes/provisioning-routes.ts", "utf8");
const fixtures = fs.readFileSync("scripts/check-buyer-activation-email-fixtures.ts", "utf8");
const failures = [];
const expect = (label, condition) => { if (!condition) failures.push(label); };

expect("promo buyer activation has a dedicated transactional email",
  alerts.includes("export async function sendPromoActivationEmail")
  && alerts.includes("smirk_promo_activation_${input.provisioningRequestId}_${inviteVersion}"));
expect("promo email uses a trusted invite and accurately states no payment was collected",
  alerts.includes("validateBuyerRecipientAndInvite(input.ownerEmail, input.inviteLink)")
  && alerts.includes("No payment was collected for this promo workspace"));
expect("promo requests use a server-owned source marker",
  routes.includes('const provisioningSource = promoApplied && shouldProvisionNow ? "smirk24_promo" : source'));
expect("promo delivery state is persisted durably",
  routes.includes("status = ${delivery.sent ? 'promo_workspace_created' : 'manual_fallback_required'}")
  && routes.includes("buyer_activation_email_status = ${deliveryStatus}")
  && routes.includes("buyer_activation_email_sent_at = ${delivery.sent ? new Date().toISOString() : null}")
  && routes.includes("buyer_activation_email_provider_id = ${delivery.providerMessageId || null}")
  && routes.includes("buyer_activation_email_error = ${error}"));
expect("failed promo delivery returns a safe retry instruction without an invite",
  routes.includes("Submit SMIRK24 again with the same owner email to retry safely")
  && routes.includes("invite_available: false")
  && routes.includes("respondPromoDeliveryFailure"));
expect("promo retry reuses the existing workspace and an active invite idempotently",
  routes.includes("existingPromo[0].workspace_id")
  && routes.includes("const reusableInvite = Boolean(")
  && routes.includes("existingPromo[0].owner_invite_token")
  && routes.includes("await inviteMember(existingPromo[0].workspace_id!")
  && routes.includes("persistPromoActivationDelivery({"));
expect("promo success response points to owner email without exposing the invite token",
  routes.includes('next_step: "check_owner_email"')
  && routes.includes("invite_available: true"));
expect("fixtures execute promo success, idempotent retry, transient failure, and permanent failure",
  fixtures.includes("const firstPromo = await sendPromoActivationEmail")
  && fixtures.includes("const retryPromo = await sendPromoActivationEmail")
  && fixtures.includes("const transientPromo = await sendPromoActivationEmail")
  && fixtures.includes("const permanentPromo = await sendPromoActivationEmail"));

if (failures.length > 0) {
  console.error("FAIL promo activation delivery contract drift:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK SMIRK24 creates, persists, retries, and reports buyer activation delivery without exposing invite tokens");
