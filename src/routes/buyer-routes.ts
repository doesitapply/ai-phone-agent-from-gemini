import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import Stripe from "stripe";
import type { Workspace } from "../saas.js";
import { hasWorkspaceBillingEntitlement } from "../billing-safety.js";
import { firstSafePublicHttpsUrl, normalizeTrustedProductionAppUrl, resolveTrustedProductionAppOrigin } from "../public-url-safety.js";
import { normalizeStrictMailbox, parseStrictMailboxList } from "../email-safety.js";
import { evaluateCustomerPolicyApproval, verifyPublishedCustomerPolicyDocumentsForPlan } from "../customer-policy-approval.js";
import { evaluateFirstDollarVoiceReadiness } from "../first-dollar-voice-readiness.js";
import {
  createWorkspaceBillingPortalSession,
  verifyBillingPortalConfiguration,
} from "../stripe-billing-portal.js";
import {
  buildPlanCheckoutReadiness,
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
};

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
      features: ["Smart voicemail", "Existing-number forwarding", "Lead capture", "Owner email alerts", "Callback task queue", "Proof dashboard", "Up to 500 calls and 1,000 minutes each month"],
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

const isNativeStripeCheckoutKeyReady = (stripeKey: string, isProd: boolean): boolean => {
  const allowTestCheckout = !isProd
    && String(process.env.ALLOW_STRIPE_TEST_CHECKOUT || "").trim().toLowerCase() === "true";
  return /^sk_live_[A-Za-z0-9_]+$/.test(stripeKey)
    || (allowTestCheckout && /^sk_test_[A-Za-z0-9_]+$/.test(stripeKey));
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
  restrictedKey: string;
  configurationId: string;
  expiresAt: number;
  proof: Awaited<ReturnType<typeof verifyBillingPortalConfiguration>>;
} | null = null;

const getBillingPortalProof = async () => {
  const restrictedKey = String(process.env.STRIPE_BILLING_PORTAL_KEY || "").trim();
  const configurationId = String(process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID || "").trim();
  const now = Date.now();
  if (
    billingPortalProofCache
    && billingPortalProofCache.restrictedKey === restrictedKey
    && billingPortalProofCache.configurationId === configurationId
    && billingPortalProofCache.expiresAt > now
  ) return billingPortalProofCache.proof;

  const proof = await verifyBillingPortalConfiguration({
    restrictedKey,
    configurationId,
    retrieveConfiguration: async (id) => {
      const client = new Stripe(restrictedKey);
      return await client.billingPortal.configurations.retrieve(id) as any;
    },
  });
  billingPortalProofCache = {
    restrictedKey,
    configurationId,
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
}, forceRefresh = false): Promise<PaymentLinkProviderReadiness> => {
  const restrictedKey = String(process.env.STRIPE_REVENUE_READ_KEY || "").trim();
  const signature = JSON.stringify([
    restrictedKey,
    input.plan,
    input.paymentLinkId,
    input.paymentLinkUrl,
    input.policyVersion,
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

const getPublicBuyerReadiness = async (env: BuyerRouteDeps["env"], isProd: boolean) => {
  const plans = getPublicPricingPlans(env);
  const stripeKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
  const nativeCheckoutReady = isNativeStripeCheckoutKeyReady(stripeKey, isProd);
  const signedWebhookReady = /^whsec_[A-Za-z0-9_]+$/.test(String(process.env.STRIPE_WEBHOOK_SECRET || "").trim());
  const durablePersistenceReady = String(process.env.DATABASE_URL || "").trim().length > 0;
  const trustedAppOriginReady = Boolean(normalizeTrustedProductionAppUrl(env.APP_URL || process.env.APP_URL));
  const automaticFulfillmentReady = String(process.env.AUTO_FULFILL_PROVISIONING_REQUESTS || "").trim().toLowerCase() === "true";
  const resendReady = /^re_[A-Za-z0-9_]+$/.test(String(process.env.RESEND_API_KEY || "").trim());
  const senderReady = Boolean(normalizeStrictMailbox(process.env.FROM_EMAIL));
  const operatorAlertRecipientReady = hasValidOperatorAlertRecipient();
  const customerPolicyVersion = String(process.env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION || "").trim();
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
  const [starterPaymentLinkProof, proPaymentLinkProof, enterprisePaymentLinkProof] = await Promise.all([
    customerPolicy.coreReady
      ? getPaymentLinkProviderProof({
          plan: "starter",
          paymentLinkId: String(process.env.STRIPE_PAYMENT_LINK_STARTER_ID || "").trim(),
          paymentLinkUrl: String(planById.get("starter")?.checkout_url || ""),
          policyVersion: customerPolicyVersion,
        })
      : unavailablePaymentLinkProof("customer-policy-core-not-approved"),
    customerPolicy.coreReady
      ? getPaymentLinkProviderProof({
          plan: "pro",
          paymentLinkId: String(process.env.STRIPE_PAYMENT_LINK_PRO_ID || "").trim(),
          paymentLinkUrl: String(planById.get("pro")?.checkout_url || ""),
          policyVersion: customerPolicyVersion,
        })
      : unavailablePaymentLinkProof("customer-policy-core-not-approved"),
    customerPolicy.enterpriseUsageReady
      ? getPaymentLinkProviderProof({
          plan: "enterprise",
          paymentLinkId: String(process.env.STRIPE_PAYMENT_LINK_ENTERPRISE_ID || "").trim(),
          paymentLinkUrl: String(planById.get("enterprise")?.checkout_url || ""),
          policyVersion: customerPolicyVersion,
        })
      : unavailablePaymentLinkProof("enterprise-usage-policy-not-approved"),
  ]);
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
  const billingPortalProof = await getBillingPortalProof();
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
    && voiceReadiness.ready;
  const planReadiness = buildPlanCheckoutReadiness({
    nativeCheckoutReady,
    activationPrerequisitesReady,
    enterpriseUsagePolicyReady,
    paymentLinkCheckoutReadyByPlan: {
      starter: starterPaymentLinkProof.ready,
      pro: proPaymentLinkProof.ready,
      enterprise: enterprisePaymentLinkProof.ready,
    },
  });
  const activationReady = planReadiness.checkoutReady && activationPrerequisitesReady;
  const fulfillmentBound = planReadiness.checkoutReady && signedWebhookReady && durablePersistenceReady;

  return {
    ...planReadiness,
    paymentLinkBlockersByPlan: {
      starter: starterPaymentLinkProof.blockers,
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
    policyBlockers,
    enterpriseUsagePolicyBlockers,
    twilioProvisioningReady: voiceReadiness.twilioProvisioningReady,
    streamingAiReady: voiceReadiness.streamingAiReady,
    streamingTtsReady: voiceReadiness.streamingTtsReady,
    voiceReadinessBlockers: voiceReadiness.blockers,
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
      const checkoutAvailable = readiness.firstDollarReadyByPlan[plan.id as StripeCheckoutPlan] === true;
      return {
        ...plan,
        checkout_available: checkoutAvailable,
        checkout_blocker: checkoutAvailable
          ? null
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
    const refreshSelectedPaymentLinkProof = async () => await getPaymentLinkProviderProof({
      plan: selectedPlanId,
      paymentLinkId: String(process.env[`STRIPE_PAYMENT_LINK_${selectedPlanId.toUpperCase()}_ID`] || "").trim(),
      paymentLinkUrl: String(plan.checkout_url || ""),
      policyVersion: String(process.env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION || "").trim(),
    }, true);
    // Use exactly the same key predicate as readiness. If readiness was earned
    // through a provider-verified Payment Link, a malformed or test key must
    // not divert the buyer into native Checkout Session creation. Refresh the
    // exact selected binding before returning its provider-confirmed URL.
    if (!isNativeStripeCheckoutKeyReady(stripeSecretKey, isProd)) {
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
      const ownerEmail = String((req.body as any)?.owner_email || (req.body as any)?.email || "").trim().toLowerCase();
      const businessName = String((req.body as any)?.business_name || (req.body as any)?.name || "").trim();
      const ownerPhone = String((req.body as any)?.phone || (req.body as any)?.owner_phone || "").trim();
      const customerPolicyVersion = String(process.env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION || "").trim();
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
    const portalProof = await getBillingPortalProof();
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
      await handleStripeWebhook(event);
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
