import { validPaymentLinkId, validPaymentLinkUrl } from "./stripe-payment-link-readiness.js";
import { evaluateStarterPaymentLinkFulfillmentIds } from "./payment-link-fulfillment-ids.js";

export type PaymentLinkPlan = "starter" | "pro" | "enterprise";

export type PaymentLinkConfigurationEnvironment = Partial<Record<
  | "STRIPE_PAYMENT_LINK_STARTER"
  | "STRIPE_PAYMENT_LINK_STARTER_ID"
  | "STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS"
  | "STRIPE_PAYMENT_LINK_PRO"
  | "STRIPE_PAYMENT_LINK_PRO_ID"
  | "STRIPE_PAYMENT_LINK_ENTERPRISE"
  | "STRIPE_PAYMENT_LINK_ENTERPRISE_ID",
  string
>>;

export type PaymentLinkConfigurationReadiness = {
  ready: boolean;
  configuredCorePlans: Array<"starter" | "pro">;
  configuredPlans: PaymentLinkPlan[];
  enterpriseConfigured: boolean;
  starterFulfillmentIds: string[];
  blockers: string[];
  providerVerification: "not_checked";
};

const PLAN_ENV_KEYS: Record<PaymentLinkPlan, { url: keyof PaymentLinkConfigurationEnvironment; id: keyof PaymentLinkConfigurationEnvironment }> = {
  starter: { url: "STRIPE_PAYMENT_LINK_STARTER", id: "STRIPE_PAYMENT_LINK_STARTER_ID" },
  pro: { url: "STRIPE_PAYMENT_LINK_PRO", id: "STRIPE_PAYMENT_LINK_PRO_ID" },
  enterprise: { url: "STRIPE_PAYMENT_LINK_ENTERPRISE", id: "STRIPE_PAYMENT_LINK_ENTERPRISE_ID" },
};

export function evaluatePaymentLinkConfiguration(
  env: PaymentLinkConfigurationEnvironment,
  { enterpriseUsageReady = false }: { enterpriseUsageReady?: boolean } = {},
): PaymentLinkConfigurationReadiness {
  // Broader policy readiness does not expand the active first-dollar launch.
  void enterpriseUsageReady;
  const blockers: string[] = [];
  const configuredPlans: PaymentLinkPlan[] = [];
  const completePlans: Array<{ plan: PaymentLinkPlan; url: string; id: string }> = [];

  for (const plan of Object.keys(PLAN_ENV_KEYS) as PaymentLinkPlan[]) {
    const keys = PLAN_ENV_KEYS[plan];
    const url = String(env[keys.url] || "").trim();
    const id = String(env[keys.id] || "").trim();
    if (!url && !id) continue;

    configuredPlans.push(plan);
    if (!url || !id) {
      blockers.push(`${plan}-payment-link-pair-incomplete`);
      continue;
    }
    if (!validPaymentLinkUrl(url)) blockers.push(`${plan}-payment-link-url-invalid`);
    if (!validPaymentLinkId(id)) blockers.push(`${plan}-payment-link-id-invalid`);
    if (validPaymentLinkUrl(url) && validPaymentLinkId(id)) completePlans.push({ plan, url, id });
  }

  const configuredCorePlans = completePlans
    .filter((offer): offer is typeof offer & { plan: "starter" | "pro" } => offer.plan === "starter" || offer.plan === "pro")
    .map((offer) => offer.plan);
  if (!configuredCorePlans.includes("starter")) blockers.push("starter-payment-link-pair-missing");
  if (configuredPlans.includes("pro")) blockers.push("pro-payment-link-out-of-first-dollar-scope");

  for (const field of ["url", "id"] as const) {
    const seen = new Set<string>();
    for (const offer of completePlans) {
      if (seen.has(offer[field])) blockers.push(`duplicate-payment-link-${field}`);
      seen.add(offer[field]);
    }
  }

  const enterpriseConfigured = configuredPlans.includes("enterprise");
  if (enterpriseConfigured) blockers.push("enterprise-payment-link-out-of-first-dollar-scope");

  const starterFulfillmentIds = evaluateStarterPaymentLinkFulfillmentIds({
    currentId: env.STRIPE_PAYMENT_LINK_STARTER_ID,
    rawIds: env.STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS,
  });
  blockers.push(...starterFulfillmentIds.blockers);

  return {
    ready: blockers.length === 0,
    configuredCorePlans,
    configuredPlans,
    enterpriseConfigured,
    starterFulfillmentIds: starterFulfillmentIds.ids,
    blockers,
    providerVerification: "not_checked",
  };
}
