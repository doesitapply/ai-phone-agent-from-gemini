import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import Stripe from "stripe";
import type { Workspace } from "../saas.js";

type BuyerRouteDeps = {
  publicDemoRateLimit: RequestHandler;
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
  acceptInvite: (token: string) => Promise<{ workspace_id: number } | null>;
  getWorkspaceById: (id: number) => Promise<Workspace | null>;
  handleStripeWebhook: (event: unknown) => Promise<void>;
};

const getPublicAppUrl = (env: BuyerRouteDeps["env"], getAppUrl: () => string): string => {
  return (env.LANDING_APP_URL || env.APP_URL || getAppUrl()).replace(/\/$/, "");
};

const getPublicPricingPlans = (env: BuyerRouteDeps["env"]) => {
  const bookingLink = String(process.env.BOOKING_LINK || process.env.CALENDLY_URL || env.CALENDLY_URL || "").trim();
  return [
    {
      id: "starter",
      name: "SMIRK AI Starter",
      price: 197,
      interval: "month",
      description: "Smart voicemail and missed-call recovery for small local service businesses.",
      features: ["Smart voicemail", "Existing-number forwarding", "Lead capture", "Owner email alerts", "Callback task queue", "Proof dashboard"],
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
      features: ["Everything in Starter", "Full Answer Mode option", "Requested callback windows", "Custom intake logic", "Call transfer and handoff rules", "Priority setup"],
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

export function registerBuyerRoutes(app: Express, deps: BuyerRouteDeps): void {
  const {
    publicDemoRateLimit,
    env,
    isProd,
    deployVersion,
    deployBranch,
    getAppUrl,
    log,
    acceptInvite,
    getWorkspaceById,
    handleStripeWebhook,
  } = deps;

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

  app.get("/api/first-dollar-readiness", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const planList = getPublicPricingPlans(env);
      const hasCheckoutLinks = planList.length > 0 && planList.every((plan) => plan.checkout_url || plan.fallback_url);
      const stripeKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
      const allowTestCheckout = String(process.env.ALLOW_STRIPE_TEST_CHECKOUT || "").trim().toLowerCase() === "true";
      const nativeCheckoutReady = Boolean(stripeKey) && (!isProd || !stripeKey.startsWith("sk_test") || allowTestCheckout);
      const paymentLinkBindingsReady = planList.every((plan) => (
        Boolean(plan.checkout_url)
        && /^plink_[A-Za-z0-9_]+$/.test(String(process.env[`STRIPE_PAYMENT_LINK_${plan.id.toUpperCase()}_ID`] || "").trim())
      ));
      const checkoutReady = hasCheckoutLinks && (nativeCheckoutReady || paymentLinkBindingsReady);
      res.json({ checkoutReady, planCount: planList.length, fulfillmentBound: nativeCheckoutReady || paymentLinkBindingsReady });
    } catch (e: any) {
      res.status(500).json({ checkoutReady: false, error: "readiness_check_failed" });
    }
  });

  app.get("/api/pricing", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const plans = getPublicPricingPlans(env);
    res.json({ plans });
  });

  app.post("/api/checkout/create", publicDemoRateLimit, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const planId = String((req.body as any)?.plan || "starter").trim().toLowerCase();
    const plan = getPublicPricingPlans(env).find((item) => item.id === planId);
    if (!plan) return res.status(400).json({ ok: false, error: "Unknown plan" });

    const stripeSecretKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
    if (!stripeSecretKey) {
      if (plan.checkout_url) {
        return res.json({ ok: true, checkout_url: plan.checkout_url, source: "payment_link_fallback" });
      }
      return res.status(503).json({
        ok: false,
        error: "Online checkout is not available right now. Request setup and we will send the next step.",
        fallback_url: plan.fallback_url,
      });
    }

    const allowTestCheckout = String(process.env.ALLOW_STRIPE_TEST_CHECKOUT || "").trim().toLowerCase() === "true";
    if (isProd && stripeSecretKey.startsWith("sk_test") && !allowTestCheckout) {
      log("warn", "Stripe test key blocked for public production checkout", { plan: plan.id });
      if (plan.checkout_url) {
        return res.json({ ok: true, checkout_url: plan.checkout_url, source: "payment_link_fallback" });
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
      const checkoutMetadata: Record<string, string> = {
        smirk_product: "missed_call_recovery",
        smirk_checkout_version: "1",
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
      return res.status(500).json({
        ok: false,
        error: "Online checkout is not available right now. Request setup and we will send the next step.",
        fallback_url: plan.fallback_url,
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

  app.get("/api/invite/:token", publicDemoRateLimit, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    const token = String(req.params.token || "").trim();
    if (!isPlausibleInviteToken(token)) return res.status(404).json({ error: "Invalid or expired invite" });
    const member = await acceptInvite(token);
    if (!member) return res.status(404).json({ error: "Invalid or expired invite" });
    const workspace = await getWorkspaceById(member.workspace_id);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { invite_token: _inviteToken, ...publicMember } = member as typeof member & { invite_token?: string | null };
    res.json({
      success: true,
      member: { ...publicMember, invite_token: undefined },
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
