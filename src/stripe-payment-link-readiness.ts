import { customerPolicyAutomaticTaxEnabled } from "./customer-policy-approval.js";

export type StripeCheckoutPlan = "starter" | "pro" | "enterprise";

export type PaymentLinkProviderReadiness = {
  ready: boolean;
  blockers: string[];
  binding: {
    plan: StripeCheckoutPlan;
    paymentLinkId: string;
    paymentLinkUrl: string;
    priceId: string;
    productId: string;
    amount: number;
    automaticTaxEnabled: boolean;
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
  taxMode: string;
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
  const approvedAutomaticTaxEnabled = customerPolicyAutomaticTaxEnabled(input.taxMode);
  const check = (label: string, condition: boolean) => { if (!condition) blockers.push(label); };

  check("payment-link-id-mismatch", input.link?.id === input.paymentLinkId);
  check("payment-link-not-live", input.link?.livemode === true);
  check("payment-link-not-active", input.link?.active === true);
  check("payment-link-url-mismatch", input.link?.url === input.paymentLinkUrl);
  check("payment-link-currency-mismatch", input.link?.currency === "usd");
  check("payment-link-terms-consent-not-required", input.link?.consent_collection?.terms_of_service === "required");
  check("payment-link-phone-collection-not-required", input.link?.phone_number_collection?.enabled === true);
  check(
    "payment-link-business-name-collection-not-required",
    input.link?.name_collection?.business?.enabled === true
      && input.link?.name_collection?.business?.optional === false,
  );
  check(
    "payment-link-tax-mode-mismatch",
    approvedAutomaticTaxEnabled !== null
      && input.link?.automatic_tax?.enabled === approvedAutomaticTaxEnabled,
  );
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
          priceId: String(price.id),
          productId: String(product.id),
          amount: expected.amount,
          automaticTaxEnabled: input.link.automatic_tax.enabled === true,
          verifiedAt: new Date().toISOString(),
        }
      : null,
  };
}

function objectId(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && "id" in value) {
    return String((value as { id?: unknown }).id || "").trim();
  }
  return "";
}

function validCheckoutEmail(value: unknown): boolean {
  const normalized = String(value || "").trim();
  return normalized.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    && !/[\r\n]/.test(normalized);
}

function validCheckoutPhone(value: unknown): boolean {
  const normalized = String(value || "").trim();
  const digits = normalized.replace(/\D/g, "");
  return normalized.length <= 40
    && digits.length >= 7
    && digits.length <= 15
    && !/[\r\n]/.test(normalized);
}

export function evaluateCompletedPaymentLinkSession(input: {
  plan: StripeCheckoutPlan;
  paymentLinkId: string;
  policyVersion: string;
  taxMode: string;
  session: any;
}): { ready: boolean; blockers: string[] } {
  const expected = CANONICAL_PAYMENT_LINK_SPECS[input.plan];
  const approvedAutomaticTaxEnabled = customerPolicyAutomaticTaxEnabled(input.taxMode);
  const session = input.session || {};
  const lineItems = session.line_items;
  const line = lineItems?.data?.[0];
  const price = line?.price;
  const product = price && typeof price.product === "object" ? price.product : null;
  const customerDetails = session.customer_details || {};
  const blockers: string[] = [];
  const check = (label: string, condition: boolean) => { if (!condition) blockers.push(label); };

  check("checkout-session-id-invalid", /^cs_live_[A-Za-z0-9_]+$/.test(String(session.id || "")));
  check("checkout-session-not-live", session.livemode === true);
  check("checkout-session-payment-link-mismatch", objectId(session.payment_link) === input.paymentLinkId);
  check("checkout-session-mode-mismatch", session.mode === "subscription");
  check("checkout-session-not-complete", session.status === "complete" && session.payment_status === "paid");
  check("checkout-session-customer-missing", /^cus_[A-Za-z0-9_]+$/.test(objectId(session.customer)));
  check("checkout-session-subscription-missing", /^sub_[A-Za-z0-9_]+$/.test(objectId(session.subscription)));
  check("checkout-session-subtotal-mismatch", session.currency === "usd" && Number(session.amount_subtotal || 0) === expected.amount);
  check(
    "checkout-session-total-invalid",
    Number(session.amount_total || 0) >= Number(session.amount_subtotal || 0)
      && Number(session.total_details?.amount_discount || 0) === 0
      && Number(session.total_details?.amount_shipping || 0) === 0,
  );
  check("checkout-session-terms-not-accepted", session.consent?.terms_of_service === "accepted");
  check("checkout-session-business-name-missing", String(customerDetails.business_name || "").trim().length >= 2);
  check("checkout-session-email-invalid", validCheckoutEmail(customerDetails.email));
  check("checkout-session-phone-invalid", validCheckoutPhone(customerDetails.phone));
  check(
    "checkout-session-tax-mode-mismatch",
    approvedAutomaticTaxEnabled !== null
      && session.automatic_tax?.enabled === approvedAutomaticTaxEnabled,
  );
  check("checkout-session-policy-version-invalid", validPolicyVersion(input.policyVersion));
  check(
    "checkout-session-policy-version-mismatch",
    session.metadata?.smirk_customer_policy_version === input.policyVersion,
  );
  check("checkout-session-line-items-invalid", lineItems?.has_more === false && lineItems?.data?.length === 1);
  check("checkout-session-line-item-quantity-invalid", Number(line?.quantity || 0) === 1);
  check(
    "checkout-session-recurring-price-invalid",
    /^price_[A-Za-z0-9_]+$/.test(objectId(price))
      && price?.livemode === true
      && price?.type === "recurring"
      && price?.currency === "usd"
      && Number(price?.unit_amount || 0) === expected.amount
      && price?.recurring?.interval === "month"
      && Number(price?.recurring?.interval_count || 0) === 1
      && price?.billing_scheme === "per_unit"
      && price?.custom_unit_amount === null
      && price?.transform_quantity === null
      && price?.recurring?.usage_type === "licensed"
      && price?.recurring?.meter === null
      && price?.recurring?.trial_period_days === null,
  );
  check(
    "checkout-session-product-invalid",
    /^prod_[A-Za-z0-9_]+$/.test(objectId(product))
      && product?.livemode === true,
  );
  check("checkout-session-description-mismatch", line?.description === expected.productName);
  check(
    "checkout-session-line-amount-mismatch",
    Number(line?.amount_subtotal || 0) === expected.amount
      && Number(line?.amount_total || 0) >= Number(line?.amount_subtotal || 0)
      && Number(line?.amount_discount || 0) === 0,
  );

  return { ready: blockers.length === 0, blockers };
}

export async function verifyCanonicalPaymentLink(input: {
  restrictedKey: string;
  plan: StripeCheckoutPlan;
  paymentLinkId: string;
  paymentLinkUrl: string;
  policyVersion: string;
  taxMode: string;
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
  if (customerPolicyAutomaticTaxEnabled(input.taxMode) === null) {
    return { ready: false, blockers: ["payment-link-tax-mode-invalid"], binding: null };
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
      taxMode: input.taxMode,
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

export function restrictCheckoutReadinessToPlans(
  input: PlanCheckoutReadiness,
  enabledPlans: readonly StripeCheckoutPlan[],
): PlanCheckoutReadiness {
  const enabled = new Set(enabledPlans);
  const paymentLinkCheckoutReadyByPlan = {
    starter: enabled.has("starter") && input.paymentLinkCheckoutReadyByPlan.starter,
    pro: enabled.has("pro") && input.paymentLinkCheckoutReadyByPlan.pro,
    enterprise: enabled.has("enterprise") && input.paymentLinkCheckoutReadyByPlan.enterprise,
  };
  const checkoutReadyByPlan = {
    starter: enabled.has("starter") && input.checkoutReadyByPlan.starter,
    pro: enabled.has("pro") && input.checkoutReadyByPlan.pro,
    enterprise: enabled.has("enterprise") && input.checkoutReadyByPlan.enterprise,
  };
  const firstDollarReadyByPlan = {
    starter: enabled.has("starter") && input.firstDollarReadyByPlan.starter,
    pro: enabled.has("pro") && input.firstDollarReadyByPlan.pro,
    enterprise: enabled.has("enterprise") && input.firstDollarReadyByPlan.enterprise,
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
