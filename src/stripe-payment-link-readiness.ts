export type StripeCheckoutPlan = "starter" | "pro" | "enterprise";

export type PaymentLinkProviderReadiness = {
  ready: boolean;
  blockers: string[];
  binding: {
    plan: StripeCheckoutPlan;
    paymentLinkId: string;
    paymentLinkUrl: string;
    verifiedAt: string;
  } | null;
};

export type PlanCheckoutReadiness = {
  paymentLinkCheckoutReady: boolean;
  paymentLinkCheckoutReadyByPlan: Record<StripeCheckoutPlan, boolean>;
  checkoutReady: boolean;
  checkoutReadyByPlan: Record<StripeCheckoutPlan, boolean>;
  firstDollarReady: boolean;
  firstDollarReadyByPlan: Record<StripeCheckoutPlan, boolean>;
  enterprisePaymentLinkCheckoutReady: boolean;
  enterpriseCheckoutReady: boolean;
};

const CANONICAL_PAYMENT_LINK_SPECS: Record<StripeCheckoutPlan, {
  amount: number;
  productName: string;
}> = {
  starter: { amount: 19_700, productName: "SMIRK AI Starter" },
  pro: { amount: 39_700, productName: "SMIRK AI Pro" },
  enterprise: { amount: 69_700, productName: "SMIRK AI Agency" },
};

export const CANONICAL_PAYMENT_LINK_SUCCESS_URL = "https://smirkcalls.com/success?session_id={CHECKOUT_SESSION_ID}";

export const validRevenueReadRestrictedKey = (value: unknown): boolean => (
  /^rk_live_[A-Za-z0-9_]+$/.test(String(value || "").trim())
);

const looksLikePaymentLinkPlaceholder = (value: unknown): boolean => {
  const normalized = String(value || "").trim().toLowerCase();
  return ["...", "replace", "example", "your_", "xxxxx"].some((marker) => normalized.includes(marker));
};

export const validPaymentLinkId = (value: unknown): boolean => {
  const normalized = String(value || "").trim();
  return /^plink_[A-Za-z0-9_]+$/.test(normalized) && !looksLikePaymentLinkPlaceholder(normalized);
};

export const validPaymentLinkUrl = (value: unknown): boolean => {
  const normalized = String(value || "").trim();
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return false;
  }
  return url.protocol === "https:"
    && url.hostname === "buy.stripe.com"
    && !url.username
    && !url.password
    && !url.port
    && !/^https:\/\/buy\.stripe\.com:/i.test(normalized)
    && url.pathname !== "/"
    && !looksLikePaymentLinkPlaceholder(normalized)
    && !url.search
    && !url.hash;
};

const validPolicyVersion = (value: unknown): boolean => (
  /^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(String(value || "").trim())
);

export function evaluateCanonicalPaymentLink(input: {
  plan: StripeCheckoutPlan;
  paymentLinkId: string;
  paymentLinkUrl: string;
  policyVersion: string;
  link: any;
  lineItems: any;
}): PaymentLinkProviderReadiness {
  const expected = CANONICAL_PAYMENT_LINK_SPECS[input.plan];
  const line = input.lineItems?.data?.[0];
  const price = line?.price;
  const product = price && typeof price.product === "object" ? price.product : null;
  const redirectUrl = input.link?.after_completion?.type === "redirect"
    ? input.link.after_completion.redirect?.url
    : null;
  const blockers: string[] = [];
  const check = (label: string, condition: boolean) => { if (!condition) blockers.push(label); };

  check("payment-link-id-mismatch", input.link?.id === input.paymentLinkId);
  check("payment-link-not-live", input.link?.livemode === true);
  check("payment-link-not-active", input.link?.active === true);
  check("payment-link-url-mismatch", input.link?.url === input.paymentLinkUrl);
  check("payment-link-trial-enabled", input.link?.subscription_data?.trial_period_days === null);
  check(
    "payment-link-optional-items-enabled",
    input.link?.optional_items === null
      || (Array.isArray(input.link?.optional_items) && input.link.optional_items.length === 0),
  );
  check("payment-link-shipping-address-collection-enabled", input.link?.shipping_address_collection === null);
  check(
    "payment-link-shipping-options-enabled",
    Array.isArray(input.link?.shipping_options) && input.link.shipping_options.length === 0,
  );
  check("payment-link-line-items-invalid", input.lineItems?.has_more === false && input.lineItems?.data?.length === 1);
  check("payment-link-quantity-invalid", Number(line?.quantity || 0) === 1 && line?.adjustable_quantity?.enabled !== true);
  check(
    "payment-link-recurring-price-invalid",
    price?.type === "recurring"
      && price?.recurring?.interval === "month"
      && Number(price?.recurring?.interval_count || 0) === 1,
  );
  check(
    "payment-link-recurring-billing-model-invalid",
    price?.billing_scheme === "per_unit"
      && price?.custom_unit_amount === null
      && price?.transform_quantity === null
      && price?.recurring?.usage_type === "licensed"
      && price?.recurring?.meter === null
      && price?.recurring?.trial_period_days === null,
  );
  check("payment-link-amount-mismatch", price?.currency === "usd" && Number(price?.unit_amount || 0) === expected.amount);
  check("payment-link-price-not-live", price?.livemode === true);
  check("payment-link-price-not-active", price?.active === true);
  check("payment-link-product-mismatch", product?.name === expected.productName);
  check("payment-link-product-not-live", product?.livemode === true);
  check("payment-link-product-not-active", product?.active === true);
  check(
    "payment-link-provider-ids-invalid",
    /^price_[A-Za-z0-9_]+$/.test(String(price?.id || ""))
      && /^prod_[A-Za-z0-9_]+$/.test(String(product?.id || "")),
  );
  check("payment-link-success-url-mismatch", redirectUrl === CANONICAL_PAYMENT_LINK_SUCCESS_URL);
  check("payment-link-promotion-codes-enabled", input.link?.allow_promotion_codes === false);
  check("payment-link-policy-version-mismatch", input.link?.metadata?.smirk_customer_policy_version === input.policyVersion);
  check(
    "payment-link-subscription-policy-version-mismatch",
    input.link?.subscription_data?.metadata?.smirk_customer_policy_version === input.policyVersion,
  );

  return {
    ready: blockers.length === 0,
    blockers,
    binding: blockers.length === 0
      ? {
          plan: input.plan,
          paymentLinkId: input.paymentLinkId,
          paymentLinkUrl: input.paymentLinkUrl,
          verifiedAt: new Date().toISOString(),
        }
      : null,
  };
}

export async function verifyCanonicalPaymentLink(input: {
  restrictedKey: string;
  plan: StripeCheckoutPlan;
  paymentLinkId: string;
  paymentLinkUrl: string;
  policyVersion: string;
  retrievePaymentLink: (paymentLinkId: string) => Promise<any>;
  listPaymentLinkLineItems: (paymentLinkId: string) => Promise<any>;
}): Promise<PaymentLinkProviderReadiness> {
  if (!validRevenueReadRestrictedKey(input.restrictedKey)) {
    return { ready: false, blockers: ["payment-link-dedicated-live-read-key-invalid"], binding: null };
  }
  if (!validPaymentLinkId(input.paymentLinkId) || !validPaymentLinkUrl(input.paymentLinkUrl)) {
    return { ready: false, blockers: ["payment-link-config-invalid"], binding: null };
  }
  if (!validPolicyVersion(input.policyVersion)) {
    return { ready: false, blockers: ["payment-link-policy-version-invalid"], binding: null };
  }

  try {
    const [link, lineItems] = await Promise.all([
      input.retrievePaymentLink(input.paymentLinkId),
      input.listPaymentLinkLineItems(input.paymentLinkId),
    ]);
    return evaluateCanonicalPaymentLink({
      plan: input.plan,
      paymentLinkId: input.paymentLinkId,
      paymentLinkUrl: input.paymentLinkUrl,
      policyVersion: input.policyVersion,
      link,
      lineItems,
    });
  } catch {
    return { ready: false, blockers: ["payment-link-provider-read-failed"], binding: null };
  }
}

export function buildPlanCheckoutReadiness(input: {
  nativeCheckoutReady: boolean;
  activationPrerequisitesReady: boolean;
  enterpriseUsagePolicyReady: boolean;
  paymentLinkCheckoutReadyByPlan: Partial<Record<StripeCheckoutPlan, boolean>>;
}): PlanCheckoutReadiness {
  const paymentLinkCheckoutReadyByPlan: Record<StripeCheckoutPlan, boolean> = {
    starter: input.paymentLinkCheckoutReadyByPlan.starter === true,
    pro: input.paymentLinkCheckoutReadyByPlan.pro === true,
    enterprise: input.paymentLinkCheckoutReadyByPlan.enterprise === true,
  };
  const checkoutReadyByPlan: Record<StripeCheckoutPlan, boolean> = {
    starter: input.nativeCheckoutReady || paymentLinkCheckoutReadyByPlan.starter,
    pro: input.nativeCheckoutReady || paymentLinkCheckoutReadyByPlan.pro,
    enterprise: input.nativeCheckoutReady || paymentLinkCheckoutReadyByPlan.enterprise,
  };
  const firstDollarReadyByPlan: Record<StripeCheckoutPlan, boolean> = {
    starter: input.activationPrerequisitesReady && checkoutReadyByPlan.starter,
    pro: input.activationPrerequisitesReady && checkoutReadyByPlan.pro,
    enterprise: input.activationPrerequisitesReady
      && input.enterpriseUsagePolicyReady
      && checkoutReadyByPlan.enterprise,
  };

  return {
    paymentLinkCheckoutReady: paymentLinkCheckoutReadyByPlan.starter || paymentLinkCheckoutReadyByPlan.pro,
    paymentLinkCheckoutReadyByPlan,
    checkoutReady: checkoutReadyByPlan.starter || checkoutReadyByPlan.pro,
    checkoutReadyByPlan,
    firstDollarReady: firstDollarReadyByPlan.starter || firstDollarReadyByPlan.pro,
    firstDollarReadyByPlan,
    enterprisePaymentLinkCheckoutReady: paymentLinkCheckoutReadyByPlan.enterprise,
    enterpriseCheckoutReady: checkoutReadyByPlan.enterprise,
  };
}
