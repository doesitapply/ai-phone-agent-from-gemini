const SAFE_PRODUCTION_ORIGINS = new Set([
  "https://ai-phone-agent-production-6811.up.railway.app",
  "https://smirkcalls.com",
  "https://www.smirkcalls.com",
]);

export function objectId(raw) {
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  return String(raw.id || "");
}

export function normalizePaidPlan(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (["starter", "basic"].includes(value)) return "starter";
  if (value === "pro") return "pro";
  if (["enterprise", "agency"].includes(value)) return "enterprise";
  return null;
}

export function validateRevenueAppOrigin(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return { ok: false, reason: "production-app-url-invalid" };
  }
  const cleanOrigin = `${url.protocol}//${url.host}`;
  const safe = url.protocol === "https:"
    && !url.username
    && !url.password
    && url.pathname === "/"
    && !url.search
    && !url.hash
    && !url.port
    && SAFE_PRODUCTION_ORIGINS.has(url.origin)
    && cleanOrigin === url.origin;
  return safe
    ? { ok: true, origin: url.origin }
    : { ok: false, reason: "production-app-origin-not-allowlisted" };
}

export function paymentLinkPlanMap(values = {}) {
  return new Map([
    [String(values.starter || "").trim(), "starter"],
    [String(values.pro || "").trim(), "pro"],
    [String(values.enterprise || "").trim(), "enterprise"],
  ].filter(([id]) => /^plink_[A-Za-z0-9_]+$/.test(id)));
}

export function identifySmirkCheckout(session, allowedPaymentLinks = new Map()) {
  if (session?.livemode !== true) return { ok: false, reason: "checkout-not-live" };
  if (session?.mode !== "subscription") return { ok: false, reason: "checkout-not-subscription-mode" };
  if (session?.status !== "complete" || session?.payment_status !== "paid") return { ok: false, reason: "checkout-not-complete-and-paid" };
  if (session?.currency !== "usd") return { ok: false, reason: "checkout-currency-not-usd" };

  const metadata = session.metadata || {};
  const nativePlan = metadata.smirk_product === "missed_call_recovery" && metadata.smirk_checkout_version === "1"
    ? normalizePaidPlan(metadata.plan)
    : null;
  const paymentLinkId = objectId(session.payment_link);
  const paymentLinkPlan = paymentLinkId ? allowedPaymentLinks.get(paymentLinkId) || null : null;
  const plan = nativePlan || paymentLinkPlan;
  if (!plan) return { ok: false, reason: "checkout-not-bound-to-smirk-product" };
  if (Number(session.amount_total || 0) <= 0) return { ok: false, reason: "checkout-has-no-positive-payment" };
  if (!objectId(session.customer)) return { ok: false, reason: "checkout-customer-missing" };
  if (!objectId(session.subscription)) return { ok: false, reason: "checkout-subscription-missing" };
  return {
    ok: true,
    plan,
    binding: nativePlan ? "native_server_marker" : "allowlisted_payment_link",
    paymentLinkId: paymentLinkId || null,
  };
}

function exactSubscriptionId(invoice) {
  return objectId(invoice?.parent?.subscription_details?.subscription);
}

function lineProductName(line) {
  const price = line?.pricing?.price_details?.price;
  const product = price && typeof price === "object" ? price.product : null;
  if (product && typeof product === "object") return String(product.name || "").trim();
  return String(line?.description || "").trim();
}

function productLineMatches(line, plan, subscriptionId) {
  const name = lineProductName(line).toLowerCase();
  const planWord = plan === "enterprise" ? /(agency|enterprise)/ : new RegExp(`\\b${plan}\\b`);
  return /\bsmirk\b/.test(name)
    && planWord.test(name)
    && Number(line?.amount || 0) > 0
    && objectId(line?.subscription) === subscriptionId;
}

function nativeMetadataMatches(sessionMetadata, invoiceMetadata) {
  for (const key of ["smirk_product", "smirk_checkout_version", "plan", "owner_email"]) {
    if (String(sessionMetadata?.[key] || "") !== String(invoiceMetadata?.[key] || "")) return false;
  }
  return true;
}

export async function resolveExactCheckoutPayment({ stripe, listedSession, allowedPaymentLinks, nowEpoch }) {
  try {
    const session = await stripe.checkout.sessions.retrieve(listedSession.id, {
      expand: ["invoice"],
    });
    if (session.id !== listedSession.id) return { ok: false, reason: "checkout-session-id-mismatch" };
    const identity = identifySmirkCheckout(session, allowedPaymentLinks);
    if (!identity.ok) return identity;

    const customerId = objectId(session.customer);
    const subscriptionId = objectId(session.subscription);
    const sessionCreated = Number(session.created || 0);
    let invoice = session.invoice && typeof session.invoice === "object" ? session.invoice : null;
    if (!invoice) {
      const invoiceId = objectId(session.invoice);
      if (invoiceId) {
        invoice = await stripe.invoices.retrieve(invoiceId);
      } else {
        const page = await stripe.invoices.list({
          subscription: subscriptionId,
          status: "paid",
          created: { gte: Math.max(0, sessionCreated - 900), lte: sessionCreated + 86400 },
          limit: 100,
        });
        if (page.has_more) return { ok: false, reason: "initial-invoice-scan-truncated" };
        const matches = page.data.filter((entry) => (
          entry.billing_reason === "subscription_create"
          && exactSubscriptionId(entry) === subscriptionId
          && objectId(entry.customer) === customerId
        ));
        if (matches.length !== 1) return { ok: false, reason: "exact-initial-invoice-not-unique" };
        invoice = matches[0];
      }
    }

    const invoiceCreated = Number(invoice?.created || 0);
    const invoiceMetadata = invoice?.parent?.subscription_details?.metadata || {};
    if (invoice?.livemode !== true
      || invoice?.status !== "paid"
      || invoice?.billing_reason !== "subscription_create"
      || exactSubscriptionId(invoice) !== subscriptionId
      || objectId(invoice?.customer) !== customerId
      || invoice?.currency !== session.currency
      || Number(invoice?.amount_paid || 0) !== Number(session.amount_total || 0)
      || !invoiceCreated
      || Math.abs(invoiceCreated - sessionCreated) > 86400) {
      return { ok: false, reason: "initial-invoice-does-not-match-checkout" };
    }

    if (identity.binding === "native_server_marker" && !nativeMetadataMatches(session.metadata, invoiceMetadata)) {
      return { ok: false, reason: "immutable-subscription-metadata-mismatch" };
    }

    const linePage = await stripe.invoices.listLineItems(invoice.id, {
      limit: 100,
    });
    if (linePage.has_more) return { ok: false, reason: "invoice-line-items-truncated" };
    if (!linePage.data.some((line) => productLineMatches(line, identity.plan, subscriptionId))) {
      return { ok: false, reason: "smirk-plan-line-item-missing" };
    }

    const invoicePaymentPage = await stripe.invoicePayments.list({
      invoice: invoice.id,
      status: "paid",
      payment: { type: "payment_intent" },
      limit: 100,
    });
    if (invoicePaymentPage.has_more) return { ok: false, reason: "invoice-payments-truncated" };
    const payments = invoicePaymentPage.data.filter((payment) => (
      objectId(payment.invoice) === invoice.id
      && payment.livemode === true
      && payment.status === "paid"
      && payment.currency === invoice.currency
      && Number(payment.amount_paid || 0) > 0
      && payment.payment?.type === "payment_intent"
      && objectId(payment.payment?.payment_intent)
    ));
    if (payments.length !== 1) return { ok: false, reason: "exact-invoice-payment-not-unique" };
    const invoicePayment = payments[0];
    if (Number(invoicePayment.amount_paid || 0) !== Number(invoice.amount_paid || 0)) {
      return { ok: false, reason: "invoice-payment-allocation-unsupported" };
    }

    const paymentIntentId = objectId(invoicePayment.payment.payment_intent);
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["latest_charge.balance_transaction"],
    });
    const latestChargeId = objectId(paymentIntent.latest_charge);
    let charge = paymentIntent.latest_charge && typeof paymentIntent.latest_charge === "object"
      ? paymentIntent.latest_charge
      : null;
    if (!charge && latestChargeId) {
      charge = await stripe.charges.retrieve(latestChargeId, {
        expand: ["balance_transaction"],
      });
    }
    if (charge && latestChargeId && objectId(charge) !== latestChargeId) {
      throw Object.assign(new Error("Stripe returned a different Charge than PaymentIntent.latest_charge"), {
        code: "stripe-charge-id-mismatch",
      });
    }

    const balanceTransactionId = objectId(charge?.balance_transaction);
    let balanceTransaction = charge?.balance_transaction && typeof charge.balance_transaction === "object"
      ? charge.balance_transaction
      : null;
    if (!balanceTransaction && balanceTransactionId) {
      balanceTransaction = await stripe.balanceTransactions.retrieve(balanceTransactionId);
    }
    if (balanceTransaction && balanceTransactionId && objectId(balanceTransaction) !== balanceTransactionId) {
      throw Object.assign(new Error("Stripe returned a different BalanceTransaction than Charge.balance_transaction"), {
        code: "stripe-balance-transaction-id-mismatch",
      });
    }
    if (paymentIntent.id !== paymentIntentId
      || paymentIntent.livemode !== true
      || paymentIntent.status !== "succeeded"
      || objectId(paymentIntent.customer) !== customerId
      || paymentIntent.currency !== invoice.currency
      || Number(paymentIntent.amount_received || 0) < Number(invoicePayment.amount_paid || 0)) {
      return { ok: false, reason: "exact-payment-intent-not-succeeded" };
    }
    if (!charge
      || charge.livemode !== true
      || charge.status !== "succeeded"
      || charge.paid !== true
      || charge.captured !== true
      || charge.refunded === true
      || Number(charge.amount_refunded || 0) !== 0
      || charge.disputed === true) {
      return { ok: false, reason: "charge-refunded-disputed-or-uncaptured" };
    }
    if (!balanceTransaction
      || balanceTransaction.status !== "available"
      || Number(balanceTransaction.available_on || 0) > nowEpoch) {
      return { ok: false, reason: "balance-transaction-not-settled" };
    }

    const buyerEmail = String(session.customer_details?.email || session.customer_email || invoice.customer_email || "").trim().toLowerCase();
    const invoiceEmail = String(invoice.customer_email || buyerEmail).trim().toLowerCase();
    if (!buyerEmail || invoiceEmail !== buyerEmail) return { ok: false, reason: "provider-buyer-email-mismatch" };
    return {
      ok: true,
      session,
      invoice,
      invoicePayment,
      paymentIntent,
      charge,
      balanceTransaction,
      customerId,
      subscriptionId,
      buyerEmail,
      plan: identity.plan,
      productBinding: identity.binding,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "stripe-exact-payment-evidence-read-failed",
      stripeError: {
        type: error?.type || null,
        code: error?.code || null,
        statusCode: error?.statusCode || null,
      },
    };
  }
}

export function selectExactWorkspace(workspaces, { customerId, subscriptionId }) {
  const subscriptionMatches = workspaces.filter((entry) => entry.stripe_subscription_id === subscriptionId);
  if (subscriptionMatches.length !== 1) return { ok: false, reason: "exact-subscription-workspace-not-unique" };
  const workspace = subscriptionMatches[0];
  if (workspace.stripe_customer_id !== customerId) return { ok: false, reason: "workspace-stripe-customer-mismatch" };
  return { ok: true, workspace };
}

export function isClearlyNonCustomer(email, excludedEmails) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || excludedEmails.has(normalized)) return true;
  const [localPart = "", domain = ""] = normalized.split("@");
  return domain === "example.com"
    || domain === "example.org"
    || domain === "example.net"
    || domain === "smirkcalls.com"
    || domain.endsWith(".test")
    || /(^|[+._-])(smoke|test|demo)([+._-]|$)/i.test(localPart);
}
