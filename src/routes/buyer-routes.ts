import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import Stripe from "stripe";
import type { Workspace } from "../saas.js";
import { hasWorkspaceBillingEntitlement } from "../billing-safety.js";
import { hasSmirkNativeCheckoutIdentity, isApprovedSyntheticPaidHandoffSmoke } from "../checkout-safety.js";
import { firstSafePublicHttpsUrl, normalizeTrustedProductionAppUrl, resolveTrustedProductionAppOrigin } from "../public-url-safety.js";
import { normalizeStrictMailbox, parseStrictMailboxList } from "../email-safety.js";
import { evaluateCustomerPolicyApproval, verifyPublishedCustomerPolicyDocumentsForPlan } from "../customer-policy-approval.js";
import { evaluateFirstDollarVoiceReadiness } from "../first-dollar-voice-readiness.js";
import {
  candidateStarterPaymentLinkFulfillmentIds,
  evaluateStarterPaymentLinkFulfillmentIds,
} from "../payment-link-fulfillment-ids.js";
import {
  createWorkspaceBillingPortalSession,
  verifyBillingPortalConfiguration,
} from "../stripe-billing-portal.js";
import {
  buildPlanCheckoutReadiness,
  evaluateCompletedPaymentLinkSession,
  restrictCheckoutReadinessToPlans,
  validPaymentLinkId,
  validPaymentLinkUrl,
  validRevenueReadRestrictedKey,
  verifyCanonicalPaymentLink,
  type PaymentLinkProviderReadiness,
  type StripeCheckoutPlan,
} from "../stripe-payment-link-readiness.js";

type BuyerRouteDeps = {
  publicCheckoutRateLimit: RequestHandler;
  publicInviteRateLimit: RequestHandler;
  workspaceBillingPortalAuth: RequestHandler;
  env: {
    APP_URL?: string;
    LANDING_APP_URL?: string;
    CALENDLY_URL?: string;
  };
  isProd: boolean;
  deployVersion: string;
  deployBranch: string;
  getAppUrl: () => string;
  log: (level: string, message: string, meta?: Record<string, unknown>) => void;
  inspectInvite: (token: string) => Promise<{ workspace_id: number; role?: string; accepted_at?: string | null; invite_expires_at?: string | null } | null>;
  inspectInviteRecovery: (token: string) => Promise<{ checkout_session_id: string } | null>;
  acceptInvite: (token: string) => Promise<{ workspace_id: number; role?: string; accepted_at?: string | null; invite_expires_at?: string | null } | null>;
  getWorkspaceById: (id: number) => Promise<Workspace | null>;
  handleStripeWebhook: (event: unknown) => Promise<void>;
  recordPaidCheckoutException: (
    event: unknown,
    input: { reason?: string | null; plan?: "starter" | "pro" | "enterprise" | null },
  ) => Promise<{ recorded: boolean; checkoutSessionId?: string; alertSent?: boolean }>;
};

const FIRST_DOLLAR_SELF_SERVE_PLAN: StripeCheckoutPlan = "starter";

const getPublicAppUrl = (env: BuyerRouteDeps["env"], getAppUrl: () => string): string => {
  return resolveTrustedProductionAppOrigin(env.LANDING_APP_URL, env.APP_URL, getAppUrl());
};

const getPublicPricingPlans = (env: BuyerRouteDeps["env"]) => {
  const bookingLink = firstSafePublicHttpsUrl(process.env.BOOKING_LINK, process.env.CALENDLY_URL, env.CALENDLY_URL);
  return [
    {
      id: "starter",
      name: "SMIRK AI Starter",
      price: 197,
      interval: "month",
      description: "Smart voicemail and missed-call recovery for small local service businesses.",
      features: ["Smart voicemail", "Dedicated recovery number", "Lead capture", "Owner email alerts", "Callback task queue", "Proof dashboard", "Up to 500 calls and 1,000 minutes each month"],
      usage_summary: "500 calls and 1,000 minutes per month.",
      best_for: "Best for solo operators and small teams.",
      cta: "Start Starter Plan",
      checkout_url: String(process.env.STRIPE_PAYMENT_LINK_STARTER || "").trim() || null,
      fallback_url: bookingLink || null,
    },
    {
      id: "pro",
      name: "SMIRK AI Pro",
      price: 397,
      interval: "month",
      description: "More automation and setup help for businesses ready to recover more missed calls.",
      features: ["Everything in Starter", "Full Answer Mode option", "Requested callback windows", "Custom intake logic", "Call transfer and handoff rules", "Priority setup", "Up to 2,000 calls and 5,000 minutes each month"],
      usage_summary: "2,000 calls and 5,000 minutes per month.",
      best_for: "Built for businesses actively scaling lead flow.",
      cta: "Start Pro Plan",
      checkout_url: String(process.env.STRIPE_PAYMENT_LINK_PRO || "").trim() || null,
      fallback_url: bookingLink || null,
    },
    {
      id: "enterprise",
      name: "SMIRK AI Agency",
      price: 697,
      interval: "month",
      description: "Higher-volume lane for agencies, multi-location operators, and heavier call workflows.",
      features: ["Everything in Pro", "Higher-volume usage", "Multi-agent workflows", "Advanced routing", "CRM and webhook integrations", "Priority deployment support"],
      usage_summary: "Usage limits and any overage terms require an owner-approved Enterprise policy before checkout is available.",
      best_for: "For agency and multi-business operators.",
      cta: "Start Agency Plan",
      checkout_url: String(process.env.STRIPE_PAYMENT_LINK_ENTERPRISE || "").trim() || null,
      fallback_url: bookingLink || null,
    },
  ];
};

const isPlausibleInviteToken = (token: string): boolean => {
  return /^[a-f0-9]{64}$/i.test(token) || /^[A-Za-z0-9]{48}$/.test(token);
};

const cleanStripeMetadataValue = (value: unknown, max = 180): string => {
  return String(value || "")
    .trim()
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, max);
};

const addMetadataValue = (metadata: Record<string, string>, key: string, value: unknown, max?: number) => {
  const clean = cleanStripeMetadataValue(value, max);
  if (clean) metadata[key] = clean;
};

const hasValidOperatorAlertRecipient = (): boolean => {
  return ["NOTIFICATION_EMAIL", "OWNER_ALERT_EMAIL", "OWNER_EMAIL", "OPERATOR_EMAIL"].some((key) => (
    parseStrictMailboxList(process.env[key]).length > 0
  ));
};

const looksLikeNativeStripeKeyPlaceholder = (value: string): boolean => {
  const normalized = String(value || "").trim().toLowerCase();
  return ["...", "replace", "example", "your_", "xxxxx", "changeme"].some((marker) => normalized.includes(marker));
};

export const isNativeStripeCheckoutKeyReady = (
  stripeKey: string,
  isProd: boolean,
  nativeCheckoutEnabled: boolean,
): boolean => {
  if (!nativeCheckoutEnabled || looksLikeNativeStripeKeyPlaceholder(stripeKey)) return false;
  const allowTestCheckout = !isProd
    && String(process.env.ALLOW_STRIPE_TEST_CHECKOUT || "").trim().toLowerCase() === "true";
  return /^sk_live_[A-Za-z0-9_]{16,}$/.test(stripeKey)
    || (allowTestCheckout && /^sk_test_[A-Za-z0-9_]{16,}$/.test(stripeKey));
};

const CUSTOMER_POLICY_PROOF_CACHE_MS = 5 * 60 * 1_000;
const customerPolicyProofCache = new Map<string, {
  version: string;
  expiresAt: number;
  proof: Awaited<ReturnType<typeof verifyPublishedCustomerPolicyDocumentsForPlan>>;
}>();

const getPublishedCustomerPolicyProof = async (version: string, plan: "starter" | "enterprise") => {
  const now = Date.now();
  const cacheKey = `${plan}:${version}`;
  const cached = customerPolicyProofCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.proof;

  const proof = await verifyPublishedCustomerPolicyDocumentsForPlan(version, plan);
  customerPolicyProofCache.set(cacheKey, {
    version,
    expiresAt: now + CUSTOMER_POLICY_PROOF_CACHE_MS,
    proof,
  });
  return proof;
};

const BILLING_PORTAL_PROOF_CACHE_MS = 5 * 60 * 1_000;
let billingPortalProofCache: {
  signature: string;
  expiresAt: number;
  proof: Awaited<ReturnType<typeof verifyBillingPortalConfiguration>>;
} | null = null;

const getBillingPortalProof = async (policyBinding: {
  termsUrl: string;
  privacyUrl: string;
  cancellationMode: string;
  cancellationProrationBehavior: string;
}) => {
  const restrictedKey = String(process.env.STRIPE_BILLING_PORTAL_KEY || "").trim();
  const revenueRestrictedKey = String(process.env.STRIPE_REVENUE_READ_KEY || "").trim();
  const configurationId = String(process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID || "").trim();
  const signature = JSON.stringify([restrictedKey, revenueRestrictedKey, configurationId, policyBinding]);
  const now = Date.now();
  if (
    billingPortalProofCache
    && billingPortalProofCache.signature === signature
    && billingPortalProofCache.expiresAt > now
  ) return billingPortalProofCache.proof;

  const proof = await verifyBillingPortalConfiguration({
    restrictedKey,
    revenueRestrictedKey,
    configurationId,
    policyBinding,
    retrieveConfiguration: async (id) => {
      const client = new Stripe(restrictedKey);
      return await client.billingPortal.configurations.retrieve(id) as any;
    },
  });
  billingPortalProofCache = {
    signature,
    expiresAt: now + (proof.ready ? BILLING_PORTAL_PROOF_CACHE_MS : 30_000),
    proof,
  };
  return proof;
};

const PAYMENT_LINK_PROOF_CACHE_MS = 5 * 60 * 1_000;
const paymentLinkProofCache = new Map<StripeCheckoutPlan, {
  signature: string;
  expiresAt: number;
  proof: PaymentLinkProviderReadiness;
}>();
const paymentLinkProofInFlight = new Map<string, Promise<PaymentLinkProviderReadiness>>();

const getPaymentLinkProviderProof = async (input: {
  plan: StripeCheckoutPlan;
  paymentLinkId: string;
  paymentLinkUrl: string;
  policyVersion: string;
  taxMode: string;
}, forceRefresh = false): Promise<PaymentLinkProviderReadiness> => {
  const restrictedKey = String(process.env.STRIPE_REVENUE_READ_KEY || "").trim();
  const signature = JSON.stringify([
    restrictedKey,
    input.plan,
    input.paymentLinkId,
    input.paymentLinkUrl,
    input.policyVersion,
    input.taxMode,
  ]);
  const now = Date.now();
  const cached = paymentLinkProofCache.get(input.plan);
  if (!forceRefresh && cached && cached.signature === signature && cached.expiresAt > now) return cached.proof;
  const existingProof = paymentLinkProofInFlight.get(signature);
  if (existingProof) return await existingProof;

  const proofPromise = (async () => {
    let stripeClient: Stripe | null = null;
    const getStripeClient = () => {
      stripeClient ||= new Stripe(restrictedKey, {
        apiVersion: "2026-04-22.dahlia",
        maxNetworkRetries: 2,
        timeout: 10_000,
      });
      return stripeClient;
    };
    const proof = await verifyCanonicalPaymentLink({
      restrictedKey,
      ...input,
      retrievePaymentLink: async (paymentLinkId) => (
        await getStripeClient().paymentLinks.retrieve(paymentLinkId) as any
      ),
      listPaymentLinkLineItems: async (paymentLinkId) => (
        await getStripeClient().paymentLinks.listLineItems(paymentLinkId, {
          limit: 100,
          expand: ["data.price.product"],
        }) as any
      ),
    });
    paymentLinkProofCache.set(input.plan, {
      signature,
      expiresAt: Date.now() + (proof.ready ? PAYMENT_LINK_PROOF_CACHE_MS : 30_000),
      proof,
    });
    return proof;
  })();
  paymentLinkProofInFlight.set(signature, proofPromise);
  try {
    return await proofPromise;
  } finally {
    if (paymentLinkProofInFlight.get(signature) === proofPromise) paymentLinkProofInFlight.delete(signature);
  }
};

const HISTORICAL_PAYMENT_LINK_PROOF_CACHE_MS = 30_000;
let historicalPaymentLinkProofCache: {
  signature: string;
  expiresAt: number;
  proof: { ready: boolean; blockers: string[] };
} | null = null;

const getHistoricalPaymentLinkInactivityProof = async (input: {
  restrictedKey: string;
  currentId: string;
  fulfillmentIds: string[];
}): Promise<{ ready: boolean; blockers: string[] }> => {
  const historicalIds = input.fulfillmentIds.filter((id) => id !== input.currentId);
  if (historicalIds.length === 0) return { ready: true, blockers: [] };
  if (!validRevenueReadRestrictedKey(input.restrictedKey)) {
    return { ready: false, blockers: ["historical-payment-link-read-key-invalid"] };
  }
  const signature = JSON.stringify([input.restrictedKey, input.currentId, historicalIds]);
  const now = Date.now();
  if (historicalPaymentLinkProofCache?.signature === signature && historicalPaymentLinkProofCache.expiresAt > now) {
    return historicalPaymentLinkProofCache.proof;
  }
  const blockers: string[] = [];
  try {
    const stripeClient = new Stripe(input.restrictedKey, {
      apiVersion: "2026-04-22.dahlia",
      maxNetworkRetries: 2,
      timeout: 10_000,
    });
    for (const historicalId of historicalIds) {
      const link = await stripeClient.paymentLinks.retrieve(historicalId) as any;
      if (String(link?.id || "") !== historicalId || link?.livemode !== true) {
        blockers.push("historical-payment-link-provider-proof-invalid");
      } else if (link?.active !== false) {
        blockers.push("historical-payment-link-reactivated");
      }
    }
  } catch {
    blockers.push("historical-payment-link-provider-read-failed");
  }
  const proof = { ready: blockers.length === 0, blockers };
  historicalPaymentLinkProofCache = {
    signature,
    expiresAt: now + (proof.ready ? HISTORICAL_PAYMENT_LINK_PROOF_CACHE_MS : 10_000),
    proof,
  };
  return proof;
};

export async function verifyCheckoutPaymentLinkBeforeFulfillment(
  event: any,
  options: {
    env?: Record<string, string | undefined>;
    evaluatePolicy?: (policyVersion: string) => {
      coreReady?: boolean;
      billingPolicy?: { taxMode?: unknown };
      coreBlockers?: Array<{ code?: unknown }>;
    };
    retrieveCheckoutSession?: (checkoutSessionId: string) => Promise<any>;
    retrievePaymentLink?: (paymentLinkId: string) => Promise<any>;
  } = {},
): Promise<{ ok: boolean; source: "native" | "payment_link"; ignored?: boolean; reason?: string; plan?: StripeCheckoutPlan; checkoutSession?: any }> {
  const checkout = event?.data?.object || {};
  const paymentLinkId = typeof checkout?.payment_link === "string"
    ? checkout.payment_link.trim()
    : String(checkout?.payment_link?.id || "").trim();
  if (!paymentLinkId) {
    if (isApprovedSyntheticPaidHandoffSmoke(event)) {
      return { ok: true, source: "native" };
    }
    if (!hasSmirkNativeCheckoutIdentity(checkout)) {
      return { ok: true, source: "native", ignored: true };
    }
    return {
      ok: false,
      source: "native",
      reason: "native-checkout-disabled-first-dollar-launch",
    };
  }

  const env = options.env || process.env;
  const configuredPaymentLinkCandidates = new Set([
    ...candidateStarterPaymentLinkFulfillmentIds({
      currentId: env.STRIPE_PAYMENT_LINK_STARTER_ID,
      rawIds: env.STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS,
    }),
    String(env.STRIPE_PAYMENT_LINK_PRO_ID || "").trim(),
    String(env.STRIPE_PAYMENT_LINK_ENTERPRISE_ID || "").trim(),
  ].filter((value) => validPaymentLinkId(value)));
  if (!configuredPaymentLinkCandidates.has(paymentLinkId) && !hasSmirkNativeCheckoutIdentity(checkout)) {
    return { ok: true, source: "payment_link", ignored: true };
  }
  const starterFulfillmentIds = evaluateStarterPaymentLinkFulfillmentIds({
    currentId: env.STRIPE_PAYMENT_LINK_STARTER_ID,
    rawIds: env.STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS,
  });
  if (!starterFulfillmentIds.ready) {
    return {
      ok: false,
      source: "payment_link",
      reason: starterFulfillmentIds.blockers[0] || "starter-fulfillment-payment-link-ids-invalid",
    };
  }
  const planMatches: StripeCheckoutPlan[] = [];
  if (starterFulfillmentIds.ids.includes(paymentLinkId)) planMatches.push("starter");
  for (const plan of ["pro", "enterprise"] as const) {
    if (String(env[`STRIPE_PAYMENT_LINK_${plan.toUpperCase()}_ID`] || "").trim() === paymentLinkId) planMatches.push(plan);
  }
  if (planMatches.length !== 1 || !validPaymentLinkId(paymentLinkId)) {
    return { ok: false, source: "payment_link", reason: "payment-link-fulfillment-id-not-uniquely-configured" };
  }

  const plan = planMatches[0];
  if (plan !== FIRST_DOLLAR_SELF_SERVE_PLAN) {
    return { ok: false, source: "payment_link", plan, reason: "first-dollar-launch-starter-only" };
  }
  const policyVersion = String(env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION || "").trim();
  const policy = (options.evaluatePolicy || evaluateCustomerPolicyApproval)(policyVersion);
  if (policy.coreReady !== true) {
    return {
      ok: false,
      source: "payment_link",
      plan,
      reason: String(policy.coreBlockers?.[0]?.code || "customer-policy-not-approved"),
    };
  }
  const taxMode = String(policy.billingPolicy?.taxMode || "");

  const checkoutSessionId = String(checkout.id || "").trim();
  if (!/^cs_live_[A-Za-z0-9_]+$/.test(checkoutSessionId)) {
    return { ok: false, source: "payment_link", plan, reason: "payment-link-checkout-session-id-invalid" };
  }
  const restrictedKey = String(env.STRIPE_REVENUE_READ_KEY || process.env.STRIPE_REVENUE_READ_KEY || "").trim();
  let fulfillmentStripeClient: Stripe | null = null;
  const getFulfillmentStripeClient = () => {
    if (!validRevenueReadRestrictedKey(restrictedKey)) throw new Error("invalid-revenue-read-key");
    fulfillmentStripeClient ||= new Stripe(restrictedKey, {
      apiVersion: "2026-04-22.dahlia",
      maxNetworkRetries: 2,
      timeout: 10_000,
    });
    return fulfillmentStripeClient;
  };
  if (paymentLinkId !== starterFulfillmentIds.currentId) {
    try {
      const retrievePaymentLink = options.retrievePaymentLink || (async (id: string) => (
        await getFulfillmentStripeClient().paymentLinks.retrieve(id) as any
      ));
      const historicalLink = await retrievePaymentLink(paymentLinkId);
      if (String(historicalLink?.id || "") !== paymentLinkId || historicalLink?.livemode !== true) {
        return { ok: false, source: "payment_link", plan, reason: "historical-payment-link-provider-proof-invalid" };
      }
      if (historicalLink?.active !== false) {
        return { ok: false, source: "payment_link", plan, reason: "historical-payment-link-reactivated" };
      }
    } catch {
      return { ok: false, source: "payment_link", plan, reason: "historical-payment-link-provider-read-failed" };
    }
  }
  try {
    const retrieveCheckoutSession = options.retrieveCheckoutSession || (async (sessionId: string) => {
      return await getFulfillmentStripeClient().checkout.sessions.retrieve(sessionId, {
        expand: ["line_items.data.price.product"],
      }) as any;
    });
    const completedSession = await retrieveCheckoutSession(checkoutSessionId);
    if (String(completedSession?.id || "") !== checkoutSessionId) {
      return { ok: false, source: "payment_link", plan, reason: "payment-link-checkout-session-id-mismatch" };
    }
    const sessionProof = evaluateCompletedPaymentLinkSession({
      plan,
      paymentLinkId,
      policyVersion,
      taxMode,
      session: completedSession,
    });
    return sessionProof.ready
      ? { ok: true, source: "payment_link", plan, checkoutSession: completedSession }
      : { ok: false, source: "payment_link", plan, reason: sessionProof.blockers[0] || "payment-link-checkout-session-proof-failed" };
  } catch {
    return { ok: false, source: "payment_link", plan, reason: "payment-link-checkout-session-read-failed" };
  }
}

const getPublicBuyerReadiness = async (env: BuyerRouteDeps["env"], isProd: boolean) => {
  const plans = getPublicPricingPlans(env);
  const stripeKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
  // The first-dollar launch is intentionally one reviewed hosted Starter lane.
  // Keep native Checkout code available for a future separately approved launch,
  // but never let an env toggle open a second checkout lane now.
  const nativeCheckoutEnabled = false;
  const nativeCheckoutReady = isNativeStripeCheckoutKeyReady(stripeKey, isProd, nativeCheckoutEnabled);
  const revenueRestrictedKey = String(process.env.STRIPE_REVENUE_READ_KEY || "").trim();
  const portalRestrictedKey = String(process.env.STRIPE_BILLING_PORTAL_KEY || "").trim();
  const revenueReadKeyReady = validRevenueReadRestrictedKey(revenueRestrictedKey);
  const restrictedStripeKeysDistinct = revenueReadKeyReady
    && portalRestrictedKey.length > 0
    && revenueRestrictedKey !== portalRestrictedKey;
  const signedWebhookReady = /^whsec_[A-Za-z0-9_]+$/.test(String(process.env.STRIPE_WEBHOOK_SECRET || "").trim());
  const durablePersistenceReady = String(process.env.DATABASE_URL || "").trim().length > 0;
  const trustedAppOriginReady = Boolean(normalizeTrustedProductionAppUrl(env.APP_URL || process.env.APP_URL));
  const automaticFulfillmentReady = String(process.env.AUTO_FULFILL_PROVISIONING_REQUESTS || "").trim().toLowerCase() === "true";
  const resendReady = /^re_[A-Za-z0-9_]+$/.test(String(process.env.RESEND_API_KEY || "").trim());
  const senderReady = Boolean(normalizeStrictMailbox(process.env.FROM_EMAIL));
  const operatorAlertRecipientReady = hasValidOperatorAlertRecipient();
  const customerPolicyVersion = String(process.env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION || "").trim();
  const starterFulfillmentIds = evaluateStarterPaymentLinkFulfillmentIds({
    currentId: process.env.STRIPE_PAYMENT_LINK_STARTER_ID,
    rawIds: process.env.STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS,
  });
  const customerPolicy = evaluateCustomerPolicyApproval(customerPolicyVersion);
  const publishedPolicyProof = customerPolicy.coreReady
    ? await getPublishedCustomerPolicyProof(customerPolicyVersion, "starter")
    : null;
  const publicationBlockers = customerPolicy.coreReady && publishedPolicyProof?.ok !== true
    ? (publishedPolicyProof?.failures || ["public policy documents could not be verified"]).map((failure) => ({
        code: "customer_policy_publication_unverified",
        area: "customer_policy",
        message: `Recurring checkout is blocked because ${failure}.`,
      }))
    : [];
  const policyBlockers = [...customerPolicy.coreBlockers, ...publicationBlockers];
  const customerPolicyReady = customerPolicy.coreReady && publishedPolicyProof?.ok === true;
  const enterprisePublishedPolicyProof = customerPolicy.enterpriseUsageReady
    ? await getPublishedCustomerPolicyProof(customerPolicyVersion, "enterprise")
    : null;
  const enterprisePublicationBlockers = customerPolicy.enterpriseUsageReady && enterprisePublishedPolicyProof?.ok !== true
    ? (enterprisePublishedPolicyProof?.failures || ["Enterprise usage policy could not be verified"]).map((failure) => ({
        code: "enterprise_usage_policy_publication_unverified",
        area: "enterprise_usage_policy",
        message: `Enterprise checkout is blocked because ${failure}.`,
      }))
    : [];
  const enterpriseUsagePolicyReady = customerPolicy.enterpriseUsageReady && enterprisePublishedPolicyProof?.ok === true;
  const enterpriseUsagePolicyBlockers = [...customerPolicy.enterpriseBlockers, ...enterprisePublicationBlockers];
  const planById = new Map(plans.map((plan) => [plan.id as StripeCheckoutPlan, plan]));
  const unavailablePaymentLinkProof = (blocker: string): PaymentLinkProviderReadiness => ({
    ready: false,
    blockers: [blocker],
    binding: null,
  });
  const starterPaymentLinkProof = customerPolicy.coreReady
    ? await getPaymentLinkProviderProof({
        plan: "starter",
        paymentLinkId: String(process.env.STRIPE_PAYMENT_LINK_STARTER_ID || "").trim(),
        paymentLinkUrl: String(planById.get("starter")?.checkout_url || ""),
        policyVersion: customerPolicyVersion,
        taxMode: String(customerPolicy.billingPolicy?.taxMode || ""),
      })
    : unavailablePaymentLinkProof("customer-policy-core-not-approved");
  const historicalPaymentLinkProof = starterFulfillmentIds.ready
    ? await getHistoricalPaymentLinkInactivityProof({
        restrictedKey: revenueRestrictedKey,
        currentId: starterFulfillmentIds.currentId,
        fulfillmentIds: starterFulfillmentIds.ids,
      })
    : { ready: false, blockers: starterFulfillmentIds.blockers };
  const proPaymentLinkProof = unavailablePaymentLinkProof("first-dollar-launch-starter-only");
  const enterprisePaymentLinkProof = unavailablePaymentLinkProof("first-dollar-launch-starter-only");
  const policyLinks = publishedPolicyProof?.ok === true
    ? [
        ["terms", "Terms", customerPolicy.documentUrls.terms],
        ["privacy", "Privacy", customerPolicy.documentUrls.privacy],
        ["cancellation_refund", "Cancellation & refunds", customerPolicy.documentUrls.cancellationRefund],
        ["billing_management", "Billing management", customerPolicy.documentUrls.billingManagement],
        ["support", "Support", customerPolicy.documentUrls.support],
        ["data_consent", "Data & recording consent", customerPolicy.documentUrls.dataConsent],
        ...(enterprisePublishedPolicyProof?.ok === true
          ? [["enterprise_usage", "Agency usage", customerPolicy.enterprisePolicyUrl]]
          : []),
      ].filter((entry) => Boolean(entry[2])).map(([key, label, url]) => ({ key, label, url }))
    : [];
  const billingPortalProof = customerPolicy.coreReady
    ? await getBillingPortalProof({
        termsUrl: String(customerPolicy.documentUrls?.terms || ""),
        privacyUrl: String(customerPolicy.documentUrls?.privacy || ""),
        cancellationMode: String(customerPolicy.billingPolicy?.cancellationMode || ""),
        cancellationProrationBehavior: String(customerPolicy.billingPolicy?.cancellationProrationBehavior || ""),
      })
    : { ready: false, blockers: ["customer-policy-core-not-approved"] };
  const billingPortalReady = billingPortalProof.ready;
  const voiceReadiness = evaluateFirstDollarVoiceReadiness(process.env);
  const activationPrerequisitesReady = signedWebhookReady
    && durablePersistenceReady
    && trustedAppOriginReady
    && automaticFulfillmentReady
    && resendReady
    && senderReady
    && operatorAlertRecipientReady
    && customerPolicyReady
    && billingPortalReady
    && revenueReadKeyReady
    && restrictedStripeKeysDistinct
    && starterFulfillmentIds.ready
    && historicalPaymentLinkProof.ready
    && voiceReadiness.ready;
  const providerPlanReadiness = buildPlanCheckoutReadiness({
    nativeCheckoutReady,
    activationPrerequisitesReady,
    enterpriseUsagePolicyReady,
    paymentLinkCheckoutReadyByPlan: {
      starter: starterPaymentLinkProof.ready,
      pro: proPaymentLinkProof.ready,
      enterprise: enterprisePaymentLinkProof.ready,
    },
  });
  const planReadiness = restrictCheckoutReadinessToPlans(providerPlanReadiness, [FIRST_DOLLAR_SELF_SERVE_PLAN]);
  const activationReady = planReadiness.checkoutReady && activationPrerequisitesReady;
  const fulfillmentBound = planReadiness.checkoutReady && signedWebhookReady && durablePersistenceReady;

  return {
    ...planReadiness,
    paymentLinkBlockersByPlan: {
      starter: [...starterPaymentLinkProof.blockers, ...historicalPaymentLinkProof.blockers],
      pro: proPaymentLinkProof.blockers,
      enterprise: enterprisePaymentLinkProof.blockers,
    },
    activationReady,
    activationPrerequisitesReady,
    activationMode: activationReady ? "automatic" : "not_ready",
    fulfillmentBound,
    planCount: plans.length,
    customerPolicyReady,
    customerPolicyCoreReady: customerPolicy.coreReady,
    enterpriseUsagePolicyReady,
    enterpriseUsageApprovalReady: customerPolicy.enterpriseUsageReady,
    enterpriseUsagePolicyPublicationVerified: enterprisePublishedPolicyProof?.ok === true,
    customerPolicyApprovalState: customerPolicy.manifestApprovalState,
    customerPolicyVersionMatches: customerPolicy.versionMatches,
    customerPolicyPublicationVerified: publishedPolicyProof?.ok === true,
    customerPolicyPublicationFailures: publishedPolicyProof?.failures || [],
    policyLinks,
    billingPortalReady,
    billingPortalBlockers: billingPortalProof.blockers,
    revenueReadKeyReady,
    restrictedStripeKeysDistinct,
    policyBlockers,
    enterpriseUsagePolicyBlockers,
    twilioProvisioningReady: voiceReadiness.twilioProvisioningReady,
    streamingAiReady: voiceReadiness.streamingAiReady,
    streamingTtsReady: voiceReadiness.streamingTtsReady,
    voiceReadinessBlockers: voiceReadiness.blockers,
    starterFulfillmentIdBlockers: starterFulfillmentIds.blockers,
    historicalPaymentLinkBlockers: historicalPaymentLinkProof.blockers,
  };
};

export function registerBuyerRoutes(app: Express, deps: BuyerRouteDeps): void {
  const {
    publicCheckoutRateLimit,
    publicInviteRateLimit,
    workspaceBillingPortalAuth,
    env,
    isProd,
    deployVersion,
    deployBranch,
    getAppUrl,
    log,
    inspectInvite,
    inspectInviteRecovery,
    acceptInvite,
    getWorkspaceById,
    handleStripeWebhook,
    recordPaidCheckoutException,
  } = deps;

  const respondWithInviteRecovery = async (token: string, res: Response): Promise<boolean> => {
    const recovery = await inspectInviteRecovery(token);
    if (!recovery) return false;
    const publicAppUrl = getPublicAppUrl(env, getAppUrl);
    res.status(410).json({
      error: "This secure invite expired. Continue from the original Checkout activation page to request a fresh owner email.",
      code: "INVITE_EXPIRED",
      recovery_url: `${publicAppUrl}/success?session_id=${encodeURIComponent(recovery.checkout_session_id)}`,
    });
    return true;
  };

  app.get("/api/version", (_req: Request, res: Response) => {
    res.setHeader("x-smirk-readiness", "1");
    res.setHeader("x-smirk-version", deployVersion);
    res.setHeader("x-smirk-branch", deployBranch);
    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
      version: deployVersion,
      branch: deployBranch,
    });
  });

  app.get("/api/health", (_req: Request, res: Response) => {
    res.redirect(307, "/health");
  });

  app.get("/api/first-dollar-readiness", async (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(await getPublicBuyerReadiness(env, isProd));
    } catch (e: any) {
      res.status(500).json({
        checkoutReady: false,
        checkoutReadyByPlan: { starter: false, pro: false, enterprise: false },
        paymentLinkCheckoutReady: false,
        paymentLinkCheckoutReadyByPlan: { starter: false, pro: false, enterprise: false },
        paymentLinkBlockersByPlan: {
          starter: ["readiness_check_failed"],
          pro: ["readiness_check_failed"],
          enterprise: ["readiness_check_failed"],
        },
        activationReady: false,
        activationPrerequisitesReady: false,
        firstDollarReady: false,
        firstDollarReadyByPlan: { starter: false, pro: false, enterprise: false },
        activationMode: "not_ready",
        fulfillmentBound: false,
        enterprisePaymentLinkCheckoutReady: false,
        enterpriseCheckoutReady: false,
        planCount: 0,
        customerPolicyReady: false,
        customerPolicyCoreReady: false,
        enterpriseUsagePolicyReady: false,
        enterpriseUsageApprovalReady: false,
        enterpriseUsagePolicyPublicationVerified: false,
        customerPolicyApprovalState: "not_approved",
        customerPolicyVersionMatches: false,
        customerPolicyPublicationVerified: false,
        customerPolicyPublicationFailures: ["readiness_check_failed"],
        policyLinks: [],
        billingPortalReady: false,
        billingPortalBlockers: ["readiness_check_failed"],
        revenueReadKeyReady: false,
        restrictedStripeKeysDistinct: false,
        policyBlockers: [{
          code: "customer_policy_readiness_failed",
          area: "customer_policy",
          message: "Customer policy approval readiness could not be evaluated.",
        }],
        enterpriseUsagePolicyBlockers: [],
        twilioProvisioningReady: false,
        streamingAiReady: false,
        streamingTtsReady: false,
        voiceReadinessBlockers: ["readiness_check_failed"],
        error: "readiness_check_failed",
      });
    }
  });

  app.get("/api/pricing", async (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const readiness = await getPublicBuyerReadiness(env, isProd);
    const plans = getPublicPricingPlans(env).map(({ checkout_url: _checkoutUrl, ...plan }) => {
      const checkoutAvailable = plan.id === FIRST_DOLLAR_SELF_SERVE_PLAN
        && readiness.firstDollarReadyByPlan[plan.id as StripeCheckoutPlan] === true;
      return {
        ...plan,
        checkout_available: checkoutAvailable,
        checkout_blocker: checkoutAvailable
          ? null
          : plan.id !== FIRST_DOLLAR_SELF_SERVE_PLAN
            ? "The first-dollar launch is Starter-only. Pro and Agency checkout remain disabled pending owner review after the first qualifying payment."
          : plan.id === "enterprise" && !readiness.enterpriseUsagePolicyReady
            ? readiness.enterpriseUsagePolicyBlockers[0]?.message || "Enterprise usage policy approval is required before checkout."
            : readiness.policyBlockers[0]?.message || "This plan's recurring checkout is not ready.",
      };
    });
    res.json({
      plans,
      policy_links: readiness.policyLinks,
      policy_version: readiness.customerPolicyVersionMatches
        ? String(process.env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION || "").trim()
        : null,
    });
  });

  app.post("/api/checkout/create", publicCheckoutRateLimit, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const planId = String((req.body as any)?.plan || "starter").trim().toLowerCase();
    const plan = getPublicPricingPlans(env).find((item) => item.id === planId);
    if (!plan) return res.status(400).json({ ok: false, error: "Unknown plan" });
    const selectedPlanId = plan.id as StripeCheckoutPlan;
    if (selectedPlanId !== FIRST_DOLLAR_SELF_SERVE_PLAN) {
      return res.status(409).json({
        ok: false,
        code: "FIRST_DOLLAR_STARTER_ONLY",
        error: "The current first-dollar launch accepts Starter checkout only. Pro and Agency require owner review after the first qualifying payment.",
        fallback_url: plan.fallback_url,
      });
    }
    const ownerEmail = String((req.body as any)?.owner_email || (req.body as any)?.email || "").trim().toLowerCase();
    const businessName = String((req.body as any)?.business_name || (req.body as any)?.name || "").trim();
    const ownerPhone = String((req.body as any)?.phone || (req.body as any)?.owner_phone || "").trim();
    const buyerDetailsReady = businessName.length >= 2
      && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)
      && ownerPhone.replace(/\D/g, "").length >= 7;
    if (!buyerDetailsReady) {
      return res.status(400).json({
        ok: false,
        code: "BUYER_DETAILS_REQUIRED",
        error: "Business name, a valid owner email, and owner phone are required before secure checkout.",
      });
    }

    const readiness = await getPublicBuyerReadiness(env, isProd);
    if (plan.id === "enterprise" && !readiness.enterpriseUsagePolicyReady) {
      return res.status(503).json({
        ok: false,
        code: "ENTERPRISE_USAGE_POLICY_REQUIRED",
        error: "Agency checkout is unavailable until owner-approved hard caps are published and exactly bound to runtime enforcement.",
        fallback_url: plan.fallback_url,
        policy_blockers: readiness.enterpriseUsagePolicyBlockers,
      });
    }
    if (plan.id === "enterprise" && !readiness.enterpriseCheckoutReady) {
      return res.status(503).json({
        ok: false,
        code: "ENTERPRISE_CHECKOUT_NOT_READY",
        error: "Agency checkout is unavailable until its exact live checkout route is verified.",
        fallback_url: plan.fallback_url,
      });
    }
    const selectedPlanReady = readiness.firstDollarReadyByPlan[selectedPlanId] === true;
    if (!selectedPlanReady) {
      const policyBlockers = plan.id === "enterprise" && !readiness.enterpriseUsagePolicyReady
        ? readiness.enterpriseUsagePolicyBlockers
        : readiness.policyBlockers;
      return res.status(503).json({
        ok: false,
        code: !readiness.customerPolicyReady ? "CUSTOMER_POLICY_APPROVAL_REQUIRED" : "CHECKOUT_NOT_READY",
        error: "Online checkout is temporarily paused while secure activation is being verified. Use setup help and we will follow up without charging you.",
        fallback_url: plan.fallback_url,
        policy_blockers: policyBlockers,
      });
    }

    const stripeSecretKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
    const nativeCheckoutEnabled = false;
    const checkoutCustomerPolicy = evaluateCustomerPolicyApproval(
      String(process.env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION || "").trim(),
    );
    const refreshSelectedPaymentLinkProof = async () => await getPaymentLinkProviderProof({
      plan: selectedPlanId,
      paymentLinkId: String(process.env[`STRIPE_PAYMENT_LINK_${selectedPlanId.toUpperCase()}_ID`] || "").trim(),
      paymentLinkUrl: String(plan.checkout_url || ""),
      policyVersion: String(process.env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION || "").trim(),
      taxMode: String(checkoutCustomerPolicy.billingPolicy?.taxMode || ""),
    }, true);
    // Use exactly the same key predicate as readiness. If readiness was earned
    // through a provider-verified Payment Link, a malformed or test key must
    // not divert the buyer into native Checkout Session creation. Refresh the
    // exact selected binding before returning its provider-confirmed URL.
    if (!isNativeStripeCheckoutKeyReady(stripeSecretKey, isProd, nativeCheckoutEnabled)) {
      if (stripeSecretKey) log("warn", "Non-live Stripe key bypassed in favor of verified Payment Link", { plan: plan.id });
      const paymentLinkProof = await refreshSelectedPaymentLinkProof();
      if (paymentLinkProof.ready && paymentLinkProof.binding?.plan === selectedPlanId) {
        return res.json({ ok: true, checkout_url: paymentLinkProof.binding.paymentLinkUrl, source: "payment_link_fallback" });
      }
      return res.status(503).json({
        ok: false,
        error: "Online checkout is not available right now. Request setup and we will send the next step.",
        fallback_url: plan.fallback_url,
      });
    }

    try {
      const stripeClient = new Stripe(stripeSecretKey);
      const publicAppUrl = getPublicAppUrl(env, getAppUrl);
      const customerPolicyVersion = String(process.env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION || "").trim();
      const automaticTaxEnabled = checkoutCustomerPolicy.billingPolicy?.automaticTaxEnabled;
      if (typeof automaticTaxEnabled !== "boolean") {
        return res.status(503).json({
          ok: false,
          code: "CUSTOMER_TAX_POLICY_REQUIRED",
          error: "Online checkout is unavailable until the approved tax handling choice is bound to checkout.",
          fallback_url: plan.fallback_url,
        });
      }
      const checkoutMetadata: Record<string, string> = {
        smirk_product: "missed_call_recovery",
        smirk_checkout_version: "1",
        smirk_customer_policy_version: customerPolicyVersion,
        plan: plan.id,
        business_name: businessName,
        owner_email: ownerEmail,
        owner_phone: ownerPhone,
        source: cleanStripeMetadataValue((req.body as any)?.source || "public_landing", 120) || "public_landing",
      };
      addMetadataValue(checkoutMetadata, "medium", (req.body as any)?.medium, 120);
      addMetadataValue(checkoutMetadata, "campaign", (req.body as any)?.campaign, 180);
      addMetadataValue(checkoutMetadata, "content", (req.body as any)?.content, 180);
      addMetadataValue(checkoutMetadata, "term", (req.body as any)?.term, 180);
      addMetadataValue(checkoutMetadata, "page_path", (req.body as any)?.page_path, 180);

      const session = await stripeClient.checkout.sessions.create({
        mode: "subscription",
        adaptive_pricing: { enabled: false },
        consent_collection: { terms_of_service: "required" },
        automatic_tax: { enabled: automaticTaxEnabled },
        customer_email: ownerEmail || undefined,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: Number(plan.price) * 100,
              recurring: { interval: "month" },
              product_data: {
                name: plan.name,
                description: plan.description,
              },
            },
          },
        ],
        success_url: `${publicAppUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${publicAppUrl}/pricing`,
        client_reference_id: businessName || ownerEmail || undefined,
        custom_text: {
          submit: {
            message: "SMIRK setup starts after checkout. Watch your owner email for workspace access and test-call instructions.",
          },
        },
        name_collection: { business: { enabled: true, optional: false } },
        phone_number_collection: { enabled: true },
        metadata: checkoutMetadata,
        subscription_data: {
          metadata: checkoutMetadata,
        },
      });

      return res.json({ ok: true, checkout_url: session.url, id: session.id, source: "checkout_session" });
    } catch (err: any) {
      log("error", "Stripe checkout session creation failed", { error: err?.message, plan: plan.id });
      const paymentLinkProof = await refreshSelectedPaymentLinkProof();
      if (paymentLinkProof.ready && paymentLinkProof.binding?.plan === selectedPlanId) {
        return res.json({ ok: true, checkout_url: paymentLinkProof.binding.paymentLinkUrl, source: "payment_link_fallback_after_native_error" });
      }
      return res.status(500).json({
        ok: false,
        error: "Online checkout is not available right now. Request setup and we will send the next step.",
        fallback_url: plan.fallback_url,
      });
    }
  });

  app.post("/api/billing/portal", workspaceBillingPortalAuth, publicCheckoutRateLimit, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    if ((req as any).authMode !== "workspace" || !(req as any).workspaceAuth?.id) {
      return res.status(403).json({
        ok: false,
        code: "WORKSPACE_AUTH_REQUIRED",
        error: "Sign in to the exact customer workspace to manage its billing.",
      });
    }
    const workspace = await getWorkspaceById(Number((req as any).workspaceAuth.id));
    if (!workspace || Number(workspace.id) !== Number((req as any).workspaceAuth.id)) {
      return res.status(404).json({ ok: false, code: "WORKSPACE_NOT_FOUND", error: "Workspace not found." });
    }
    const customerPolicy = evaluateCustomerPolicyApproval(
      String(process.env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION || "").trim(),
    );
    const portalProof = customerPolicy.coreReady
      ? await getBillingPortalProof({
          termsUrl: String(customerPolicy.documentUrls?.terms || ""),
          privacyUrl: String(customerPolicy.documentUrls?.privacy || ""),
          cancellationMode: String(customerPolicy.billingPolicy?.cancellationMode || ""),
          cancellationProrationBehavior: String(customerPolicy.billingPolicy?.cancellationProrationBehavior || ""),
        })
      : { ready: false, blockers: ["customer-policy-core-not-approved"] };
    if (!portalProof.ready) {
      return res.status(503).json({
        ok: false,
        code: "BILLING_PORTAL_NOT_READY",
        error: "Billing management is temporarily unavailable.",
      });
    }
    const restrictedKey = String(process.env.STRIPE_BILLING_PORTAL_KEY || "").trim();
    const configurationId = String(process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID || "").trim();
    try {
      const client = new Stripe(restrictedKey);
      const session = await createWorkspaceBillingPortalSession({
        workspace,
        trustedAppOrigin: getPublicAppUrl(env, getAppUrl),
        restrictedKey,
        configurationId,
        createSession: async (params) => await client.billingPortal.sessions.create(params) as any,
      });
      return res.status(201).json({ ok: true, url: session.url });
    } catch (error: any) {
      log("error", "Stripe billing portal session creation failed", {
        workspaceId: workspace.id,
        error: error?.message || String(error),
      });
      return res.status(503).json({
        ok: false,
        code: "BILLING_PORTAL_SESSION_FAILED",
        error: "Billing management is temporarily unavailable.",
      });
    }
  });

  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req: Request, res: Response) => {
    const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
    const allowUnsignedDevWebhook = !isProd && String(process.env.ALLOW_UNSIGNED_STRIPE_WEBHOOK_DEV || "").trim().toLowerCase() === "true";
    const sig = req.headers["stripe-signature"];
    let event: unknown;
    try {
      if (webhookSecret && sig) {
        const stripeSecretKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
        // Signature verification is local cryptography and does not require an API
        // credential. Keep Payment Link webhooks working even when no secret API key
        // is configured, without ever skipping verification in production.
        const stripeClient = new Stripe(stripeSecretKey || "sk_test_webhook_signature_only");
        event = stripeClient.webhooks.constructEvent(req.body, sig, webhookSecret);
      } else if (allowUnsignedDevWebhook) {
        log("warn", "Stripe webhook: explicit unsigned local-development override enabled", {});
        event = JSON.parse(req.body.toString());
      } else {
        log("error", "Stripe webhook rejected: verified signature required", { path: req.path, isProd });
        return res.status(400).json({ error: "Webhook signature verification failed" });
      }
      if (typeof (event as { id?: unknown }).id === "string" && String((event as { id: string }).id).startsWith("evt_test_")) {
        return res.json({ verified: true });
      }
      let checkoutSessionForFulfillment: any = null;
      if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(String((event as any)?.type || ""))) {
        const paymentLinkProof = await verifyCheckoutPaymentLinkBeforeFulfillment(event);
        if (paymentLinkProof.ignored) {
          log("info", "Stripe Checkout event acknowledged outside the configured SMIRK fulfillment boundary", {
            eventId: String((event as any)?.id || ""),
            source: paymentLinkProof.source,
          });
          return res.json({ received: true });
        }
        if (!paymentLinkProof.ok) {
          try {
            const paidException = await recordPaidCheckoutException(event, {
              reason: paymentLinkProof.reason || "provider-proof-failed",
              plan: paymentLinkProof.plan || null,
            });
            if (paidException.recorded) {
              log("error", "Paid Stripe Checkout exception durably recorded for immediate operator review", {
                eventId: String((event as any)?.id || ""),
                checkoutSessionId: paidException.checkoutSessionId || null,
                plan: paymentLinkProof.plan || null,
                reason: paymentLinkProof.reason || "provider-proof-failed",
                operatorAlertSent: paidException.alertSent === true,
              });
            }
          } catch (exceptionError: any) {
            log("error", "Stripe paid-checkout exception recording or operator alert failed", {
              eventId: String((event as any)?.id || ""),
              plan: paymentLinkProof.plan || null,
              reason: paymentLinkProof.reason || "provider-proof-failed",
              exceptionError: exceptionError?.message || String(exceptionError),
            });
            return res.status(503).json({
              error: "Paid checkout rescue recording is temporarily unavailable.",
              code: "PAID_CHECKOUT_EXCEPTION_RECORDING_REQUIRED",
            });
          }
          log("error", "Stripe Payment Link fulfillment deferred until exact provider verification passes", {
            eventId: String((event as any)?.id || ""),
            plan: paymentLinkProof.plan || null,
            reason: paymentLinkProof.reason || "provider-proof-failed",
          });
          return res.status(503).json({
            error: "Checkout fulfillment is awaiting exact Payment Link verification.",
            code: "PAYMENT_LINK_FULFILLMENT_VERIFICATION_REQUIRED",
          });
        }
        checkoutSessionForFulfillment = paymentLinkProof.checkoutSession || null;
      }
      const fulfillmentEvent = checkoutSessionForFulfillment
        ? {
            ...(event as any),
            data: {
              ...((event as any)?.data || {}),
              object: checkoutSessionForFulfillment,
            },
          }
        : event;
      await handleStripeWebhook(fulfillmentEvent);
      res.json({ received: true });
    } catch (err: any) {
      log("error", "Stripe webhook error", { error: err.message });
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/invite/:token", publicInviteRateLimit, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    const token = String(req.params.token || "").trim();
    if (!isPlausibleInviteToken(token)) return res.status(404).json({ error: "Invalid or expired invite" });
    const member = await inspectInvite(token);
    if (!member) {
      if (await respondWithInviteRecovery(token, res)) return;
      return res.status(404).json({ error: "Invalid or expired invite" });
    }
    const workspace = await getWorkspaceById(member.workspace_id);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    if (!hasWorkspaceBillingEntitlement(workspace.plan, workspace.subscription_status)) {
      return res.status(402).json({ error: "Workspace access is paused. Contact setup help to restore access.", code: "WORKSPACE_BILLING_INACTIVE" });
    }
    res.json({
      success: true,
      accepted: Boolean(member.accepted_at),
      role: member.role || "owner",
      expires_at: member.invite_expires_at || null,
      workspace: {
        name: workspace.name,
        plan: workspace.plan,
        mode: workspace.mode,
      },
    });
  });

  app.post("/api/invite/:token/accept", publicInviteRateLimit, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    const token = String(req.params.token || "").trim();
    if (!isPlausibleInviteToken(token)) return res.status(404).json({ error: "Invalid or expired invite" });
    const preview = await inspectInvite(token);
    if (!preview) {
      if (await respondWithInviteRecovery(token, res)) return;
      return res.status(404).json({ error: "Invalid or expired invite" });
    }
    const workspaceBeforeAcceptance = await getWorkspaceById(preview.workspace_id);
    if (!workspaceBeforeAcceptance) return res.status(404).json({ error: "Workspace not found" });
    if (!hasWorkspaceBillingEntitlement(workspaceBeforeAcceptance.plan, workspaceBeforeAcceptance.subscription_status)) {
      return res.status(402).json({ error: "Workspace access is paused. Contact setup help to restore access.", code: "WORKSPACE_BILLING_INACTIVE" });
    }
    const member = await acceptInvite(token);
    if (!member) {
      if (await respondWithInviteRecovery(token, res)) return;
      return res.status(404).json({ error: "Invalid or expired invite" });
    }
    const workspace = await getWorkspaceById(member.workspace_id);
    if (!workspace || !hasWorkspaceBillingEntitlement(workspace.plan, workspace.subscription_status)) {
      return res.status(402).json({ error: "Workspace access is paused. Contact setup help to restore access.", code: "WORKSPACE_BILLING_INACTIVE" });
    }
    res.json({
      success: true,
      member: { role: member.role || "owner", accepted_at: member.accepted_at || null },
      workspace: {
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        plan: workspace.plan,
        mode: workspace.mode,
        api_key: workspace.api_key,
      },
    });
  });
}
