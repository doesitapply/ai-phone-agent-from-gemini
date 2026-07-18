const SAFE_PRODUCTION_ORIGINS = new Set([
  "https://ai-phone-agent-production-6811.up.railway.app",
  "https://smirkcalls.com",
  "https://www.smirkcalls.com",
]);

export const CANONICAL_REVENUE_PAYMENT_LINKS = Object.freeze([
  Object.freeze({ plan: "starter", amount: 19700, productName: "SMIRK AI Starter" }),
  Object.freeze({ plan: "pro", amount: 39700, productName: "SMIRK AI Pro" }),
  Object.freeze({ plan: "enterprise", amount: 69700, productName: "SMIRK AI Agency" }),
]);
export const CANONICAL_REVENUE_SUCCESS_URL = "https://smirkcalls.com/success?session_id={CHECKOUT_SESSION_ID}";

function canonicalPlanSpec(plan) {
  return CANONICAL_REVENUE_PAYMENT_LINKS.find((entry) => entry.plan === normalizePaidPlan(plan)) || null;
}

function validCustomerPolicyVersion(raw) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(String(raw || "").trim());
}

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
    [String(values.starter || "").trim(), { plan: "starter" }],
    [String(values.pro || "").trim(), { plan: "pro" }],
    [String(values.enterprise || "").trim(), { plan: "enterprise" }],
  ].filter(([id]) => /^plink_[A-Za-z0-9_]+$/.test(id)));
}

function paymentLinkBinding(raw) {
  if (typeof raw === "string") return canonicalPlanSpec(raw) ? { plan: normalizePaidPlan(raw) } : null;
  if (!raw || typeof raw !== "object") return null;
  const plan = normalizePaidPlan(raw.plan);
  return plan ? { ...raw, plan } : null;
}

export async function verifyCanonicalRevenuePaymentLinks({ stripe, configs, policyVersion }) {
  const approvedPolicyVersion = String(policyVersion || "").trim();
  if (!validCustomerPolicyVersion(approvedPolicyVersion)) {
    return { ok: false, reason: "approved-customer-policy-version-invalid" };
  }
  if (!Array.isArray(configs) || configs.length < 1 || configs.length > CANONICAL_REVENUE_PAYMENT_LINKS.length) {
    return { ok: false, reason: "canonical-payment-link-config-incomplete" };
  }

  const normalizedConfigs = configs.map((config) => ({
    plan: normalizePaidPlan(config?.plan),
    id: String(config?.id || "").trim(),
    url: String(config?.url || "").trim(),
  }));
  const ids = normalizedConfigs.map((entry) => entry.id);
  if (normalizedConfigs.some((entry) => !canonicalPlanSpec(entry.plan) || !/^plink_[A-Za-z0-9_]+$/.test(entry.id) || !/^https:\/\/buy\.stripe\.com\//.test(entry.url))) {
    return { ok: false, reason: "canonical-payment-link-config-invalid" };
  }
  if (new Set(ids).size !== ids.length || new Set(normalizedConfigs.map((entry) => entry.plan)).size !== normalizedConfigs.length) {
    return { ok: false, reason: "canonical-payment-link-config-duplicate" };
  }

  const verified = new Map();
  for (const config of normalizedConfigs) {
    const expected = canonicalPlanSpec(config.plan);
    try {
      const [link, lineItems] = await Promise.all([
        stripe.paymentLinks.retrieve(config.id),
        stripe.paymentLinks.listLineItems(config.id, { limit: 100, expand: ["data.price.product"] }),
      ]);
      const line = lineItems?.data?.[0];
      const price = line?.price;
      const product = price && typeof price.product === "object" ? price.product : null;
      const redirectUrl = link?.after_completion?.type === "redirect" ? link.after_completion.redirect?.url : null;
      const failures = [];
      const check = (label, condition) => { if (!condition) failures.push(label); };
      check("link-id", link?.id === config.id);
      check("live-mode", link?.livemode === true);
      check("active", link?.active === true);
      check("public-url", link?.url === config.url);
      check("one-line-item", lineItems?.has_more === false && lineItems?.data?.length === 1);
      check("quantity-one", Number(line?.quantity || 0) === 1 && line?.adjustable_quantity?.enabled !== true);
      check("monthly-recurring-price", price?.type === "recurring" && price?.recurring?.interval === "month" && Number(price?.recurring?.interval_count || 0) === 1);
      check("exact-usd-amount", price?.currency === "usd" && Number(price?.unit_amount || 0) === expected.amount);
      check("exact-product-name", product?.name === expected.productName);
      check("stable-price-and-product-ids", /^price_[A-Za-z0-9_]+$/.test(String(price?.id || "")) && /^prod_[A-Za-z0-9_]+$/.test(String(product?.id || "")));
      check("exact-success-redirect", redirectUrl === CANONICAL_REVENUE_SUCCESS_URL);
      check("promotion-codes-disabled", link?.allow_promotion_codes === false);
      check("link-policy-version", link?.metadata?.smirk_customer_policy_version === approvedPolicyVersion);
      check("subscription-policy-version", link?.subscription_data?.metadata?.smirk_customer_policy_version === approvedPolicyVersion);
      if (failures.length > 0) {
        return { ok: false, reason: "canonical-payment-link-drift", plan: config.plan, failedChecks: failures };
      }
      verified.set(config.id, {
        plan: config.plan,
        paymentLinkId: config.id,
        paymentLinkUrl: config.url,
        priceId: price.id,
        productId: product.id,
        amount: expected.amount,
        productName: expected.productName,
        policyVersion: approvedPolicyVersion,
      });
    } catch (error) {
      return {
        ok: false,
        reason: "canonical-payment-link-provider-read-failed",
        plan: config.plan,
        stripeError: {
          type: error?.type || null,
          code: error?.code || null,
          statusCode: error?.statusCode || null,
        },
      };
    }
  }
  return { ok: true, allowedPaymentLinks: verified };
}

export function identifySmirkCheckout(session, allowedPaymentLinks = new Map(), policyVersion = "") {
  if (session?.livemode !== true) return { ok: false, reason: "checkout-not-live" };
  if (session?.mode !== "subscription") return { ok: false, reason: "checkout-not-subscription-mode" };
  if (session?.status !== "complete" || session?.payment_status !== "paid") return { ok: false, reason: "checkout-not-complete-and-paid" };
  if (session?.currency !== "usd") return { ok: false, reason: "checkout-currency-not-usd" };

  const metadata = session.metadata || {};
  const approvedPolicyVersion = String(policyVersion || "").trim();
  if (!validCustomerPolicyVersion(approvedPolicyVersion) || metadata.smirk_customer_policy_version !== approvedPolicyVersion) {
    return { ok: false, reason: "checkout-policy-version-mismatch" };
  }
  const nativePlan = metadata.smirk_product === "missed_call_recovery" && metadata.smirk_checkout_version === "1"
    ? normalizePaidPlan(metadata.plan)
    : null;
  const paymentLinkId = objectId(session.payment_link);
  const verifiedLink = paymentLinkId ? paymentLinkBinding(allowedPaymentLinks.get(paymentLinkId)) : null;
  const plan = paymentLinkId ? verifiedLink?.plan || null : nativePlan;
  if (!plan) return { ok: false, reason: "checkout-not-bound-to-smirk-product" };
  if (Number(session.amount_total || 0) <= 0) return { ok: false, reason: "checkout-has-no-positive-payment" };
  if (!objectId(session.customer)) return { ok: false, reason: "checkout-customer-missing" };
  if (!objectId(session.subscription)) return { ok: false, reason: "checkout-subscription-missing" };
  return {
    ok: true,
    plan,
    binding: paymentLinkId ? "allowlisted_payment_link" : "native_server_marker",
    paymentLinkId: paymentLinkId || null,
    paymentLink: verifiedLink,
    policyVersion: approvedPolicyVersion,
  };
}

function exactSubscriptionId(invoice) {
  return objectId(invoice?.parent?.subscription_details?.subscription);
}

function linePrice(line) {
  const price = line?.pricing?.price_details?.price;
  return price && typeof price === "object" ? price : null;
}

function productLineMatches(line, identity, subscriptionId) {
  const expected = canonicalPlanSpec(identity.plan);
  const price = linePrice(line);
  const product = price && typeof price.product === "object" ? price.product : null;
  if (!expected || !price || !product) return false;
  const canonicalProduct = product.name === expected.productName
    && price.type === "recurring"
    && price.recurring?.interval === "month"
    && Number(price.recurring?.interval_count || 0) === 1
    && price.currency === "usd"
    && Number(price.unit_amount || 0) === expected.amount;
  const exactVerifiedLinkProduct = identity.binding !== "allowlisted_payment_link" || (
    price.id === identity.paymentLink?.priceId
    && product.id === identity.paymentLink?.productId
  );
  return canonicalProduct
    && exactVerifiedLinkProduct
    && Number(line?.quantity || 0) === 1
    && Number(line?.amount || 0) > 0
    && objectId(line?.subscription) === subscriptionId;
}

function nativeMetadataMatches(sessionMetadata, invoiceMetadata) {
  for (const key of ["smirk_product", "smirk_checkout_version", "smirk_customer_policy_version", "plan", "owner_email"]) {
    if (String(sessionMetadata?.[key] || "") !== String(invoiceMetadata?.[key] || "")) return false;
  }
  return true;
}

export async function resolveExactCheckoutPayment({ stripe, listedSession, allowedPaymentLinks, nowEpoch, policyVersion }) {
  try {
    const session = await stripe.checkout.sessions.retrieve(listedSession.id, {
      expand: ["invoice"],
    });
    if (session.id !== listedSession.id) return { ok: false, reason: "checkout-session-id-mismatch" };
    const identity = identifySmirkCheckout(session, allowedPaymentLinks, policyVersion);
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

    if (invoiceMetadata.smirk_customer_policy_version !== identity.policyVersion) {
      return { ok: false, reason: "immutable-subscription-policy-version-mismatch" };
    }
    if (identity.binding === "native_server_marker" && !nativeMetadataMatches(session.metadata, invoiceMetadata)) {
      return { ok: false, reason: "immutable-subscription-metadata-mismatch" };
    }

    const linePage = await stripe.invoices.listLineItems(invoice.id, {
      limit: 100,
      expand: ["data.pricing.price_details.price.product"],
    });
    if (linePage.has_more) return { ok: false, reason: "invoice-line-items-truncated" };
    if (!linePage.data.some((line) => productLineMatches(line, identity, subscriptionId))) {
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

export async function verifyProviderCheckoutFulfillmentEvent({ stripe, eventId, payment, policyVersion, webhookUrl }) {
  const exactEventId = String(eventId || "").trim();
  if (!/^evt_[A-Za-z0-9_]+$/.test(exactEventId)) return { ok: false, reason: "checkout-fulfillment-event-id-invalid" };
  try {
    const event = await stripe.events.retrieve(exactEventId);
    const checkout = event?.data?.object;
    const session = payment?.session;
    const allowedTypes = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);
    const exactCheckout = event?.id === exactEventId
      && event?.livemode === true
      && allowedTypes.has(event?.type)
      && checkout?.id === session?.id
      && checkout?.livemode === true
      && checkout?.mode === "subscription"
      && checkout?.status === "complete"
      && checkout?.payment_status === "paid"
      && checkout?.currency === session?.currency
      && Number(checkout?.amount_total || 0) === Number(session?.amount_total || 0)
      && objectId(checkout?.customer) === payment?.customerId
      && objectId(checkout?.subscription) === payment?.subscriptionId
      && objectId(checkout?.payment_link) === objectId(session?.payment_link)
      && checkout?.metadata?.smirk_customer_policy_version === String(policyVersion || "").trim();
    if (!exactCheckout) return { ok: false, reason: "checkout-fulfillment-provider-event-mismatch" };

    const eventCreated = Number(event.created || 0);
    const sessionCreated = Number(session?.created || 0);
    if (!eventCreated || !sessionCreated || eventCreated < sessionCreated - 300 || eventCreated > sessionCreated + 86400) {
      return { ok: false, reason: "checkout-fulfillment-provider-event-timeline-mismatch" };
    }

    const expectedWebhookUrl = String(webhookUrl || "").trim();
    if (!/^https:\/\//.test(expectedWebhookUrl)) return { ok: false, reason: "checkout-fulfillment-webhook-url-invalid" };
    const webhookEndpoints = [];
    let webhookStartingAfter;
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await stripe.webhookEndpoints.list({
        limit: 100,
        ...(webhookStartingAfter ? { starting_after: webhookStartingAfter } : {}),
      });
      webhookEndpoints.push(...page.data);
      if (!page.has_more) break;
      webhookStartingAfter = page.data.at(-1)?.id;
      if (!webhookStartingAfter) return { ok: false, reason: "checkout-fulfillment-webhook-endpoint-scan-truncated" };
    }
    const matchingEndpoints = webhookEndpoints.filter((endpoint) => {
      const enabledEvents = new Set(endpoint.enabled_events || []);
      return endpoint.url === expectedWebhookUrl
        && endpoint.status === "enabled"
        && (enabledEvents.has("*") || enabledEvents.has(event.type));
    });
    if (matchingEndpoints.length !== 1) return { ok: false, reason: "checkout-fulfillment-canonical-webhook-endpoint-mismatch" };

    let startingAfter;
    let delivered = false;
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await stripe.events.list({
        types: [event.type],
        delivery_success: true,
        created: { gte: Math.max(0, eventCreated - 1), lte: eventCreated + 1 },
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      if (page.data.some((candidate) => candidate.id === exactEventId && candidate.livemode === true)) {
        delivered = true;
        break;
      }
      if (!page.has_more) break;
      startingAfter = page.data.at(-1)?.id;
      if (!startingAfter) return { ok: false, reason: "checkout-fulfillment-delivery-scan-truncated" };
    }
    if (!delivered) return { ok: false, reason: "checkout-fulfillment-provider-delivery-unproven" };
    return { ok: true, eventId: exactEventId, eventType: event.type, providerDeliverySuccess: true };
  } catch (error) {
    return {
      ok: false,
      reason: "checkout-fulfillment-provider-event-read-failed",
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

export function validateCheckoutActivationEvidence(evidence, payment, workspace) {
  if (evidence?.ok !== true || evidence?.found !== true) return { ok: false, reason: "checkout-activation-evidence-not-found" };
  const checkoutSessionId = objectId(payment?.session);
  if (!checkoutSessionId || evidence.checkout_session_id !== checkoutSessionId) {
    return { ok: false, reason: "checkout-activation-session-mismatch" };
  }
  const exactIdentity = Number(evidence.workspace?.id) === Number(workspace?.id)
    && Number(evidence.provisioning?.workspace_id) === Number(workspace?.id)
    && String(evidence.workspace?.stripe_customer_id || "") === String(payment?.customerId || "")
    && String(evidence.workspace?.stripe_subscription_id || "") === String(payment?.subscriptionId || "")
    && String(evidence.workspace?.owner_email || "").trim().toLowerCase() === String(payment?.buyerEmail || "").trim().toLowerCase()
    && String(evidence.provisioning?.owner_email || "").trim().toLowerCase() === String(payment?.buyerEmail || "").trim().toLowerCase()
    && normalizePaidPlan(evidence.workspace?.plan) === payment?.plan
    && normalizePaidPlan(evidence.provisioning?.requested_plan) === payment?.plan;
  if (!exactIdentity) return { ok: false, reason: "checkout-activation-identity-mismatch" };

  if (evidence.provisioning?.request_id !== checkoutSessionId || evidence.provisioning?.source !== "stripe_checkout_completed") {
    return { ok: false, reason: "checkout-provisioning-provenance-mismatch" };
  }
  if (evidence.fulfillment?.status !== "complete" || !/^evt_[A-Za-z0-9_]+$/.test(String(evidence.fulfillment?.event_id || ""))) {
    return { ok: false, reason: "checkout-fulfillment-not-complete" };
  }
  const automaticChain = evidence.automatic_chain || {};
  const currentState = evidence.current_state || {};
  if (automaticChain.checkout_completed_event !== true
    || automaticChain.workspace_created_by_checkout !== true
    || automaticChain.buyer_activation_email_sent !== true
    || automaticChain.owner_invite_accepted !== true
    || automaticChain.buyer_invite_acceptance_event !== true
    || automaticChain.customer_setup_event !== true
    || automaticChain.customer_proof_event !== true
    || automaticChain.operator_rescue_event !== false
    || automaticChain.operator_authored_activation_event !== false) {
    return { ok: false, reason: "checkout-automatic-activation-chain-incomplete" };
  }
  if (currentState.activation_stage !== "proof_complete"
    || currentState.setup_ready !== true
    || currentState.proof_fresh !== true
    || !Number.isSafeInteger(Number(currentState.complete_proof_calls))
    || Number(currentState.complete_proof_calls) < 1) {
    return { ok: false, reason: "checkout-customer-activation-current-state-incomplete" };
  }

  const checkoutCreated = Number(payment?.session?.created || 0);
  const checkoutCompleted = Date.parse(String(automaticChain.checkout_completed_at || "")) / 1000;
  const workspaceCreated = Date.parse(String(evidence.workspace?.created_at || "")) / 1000;
  const provisioningCreated = Date.parse(String(evidence.provisioning?.created_at || "")) / 1000;
  const emailSent = Date.parse(String(automaticChain.buyer_activation_email_sent_at || "")) / 1000;
  const inviteAccepted = Date.parse(String(automaticChain.owner_invite_accepted_at || "")) / 1000;
  const buyerInviteEvent = Date.parse(String(automaticChain.buyer_invite_acceptance_event_at || "")) / 1000;
  const customerSetupEvent = Date.parse(String(automaticChain.customer_setup_event_at || "")) / 1000;
  const customerProofEvent = Date.parse(String(automaticChain.customer_proof_event_at || "")) / 1000;
  const setupCompleted = Date.parse(String(currentState.setup_completed_at || "")) / 1000;
  const latestCompleteProof = Date.parse(String(currentState.latest_complete_proof_at || "")) / 1000;
  const withinCheckoutActivationWindow = (timestamp) => Number.isFinite(timestamp)
    && timestamp >= checkoutCreated - 300
    && timestamp <= checkoutCreated + 86400;
  if (!checkoutCreated
    || !withinCheckoutActivationWindow(checkoutCompleted)
    || !withinCheckoutActivationWindow(workspaceCreated)
    || !withinCheckoutActivationWindow(provisioningCreated)
    || !withinCheckoutActivationWindow(emailSent)
    || !Number.isFinite(inviteAccepted)
    || !Number.isFinite(buyerInviteEvent)
    || !Number.isFinite(customerSetupEvent)
    || !Number.isFinite(customerProofEvent)
    || !Number.isFinite(setupCompleted)
    || !Number.isFinite(latestCompleteProof)
    || inviteAccepted < Math.max(checkoutCompleted, emailSent)
    || buyerInviteEvent < Math.max(checkoutCompleted, emailSent)
    || Math.abs(buyerInviteEvent - inviteAccepted) > 300
    || customerSetupEvent < buyerInviteEvent
    || customerProofEvent < buyerInviteEvent
    || setupCompleted < buyerInviteEvent
    || latestCompleteProof < customerProofEvent) {
    return { ok: false, reason: "checkout-activation-timeline-mismatch" };
  }
  return {
    ok: true,
    checkoutSessionId,
    fulfillmentEventId: String(evidence.fulfillment.event_id),
    workspaceId: Number(workspace.id),
    automaticCheckoutFulfillment: true,
    checkoutCreatedWorkspace: true,
    buyerActivationEmailSent: true,
    ownerInviteAccepted: true,
    buyerInviteAcceptanceEvent: true,
    customerSetupEvent: true,
    customerProofEvent: true,
    operatorRescueEvent: false,
    activationStage: currentState.activation_stage,
    setupReady: true,
    proofFresh: true,
    completeProofCalls: Number(currentState.complete_proof_calls),
    setupCompletedAt: currentState.setup_completed_at,
    latestCompleteProofAt: currentState.latest_complete_proof_at,
  };
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
