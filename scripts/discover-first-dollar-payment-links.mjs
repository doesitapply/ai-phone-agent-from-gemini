#!/usr/bin/env node
import Stripe from "stripe";
import { classifyActiveSmirkPaymentLink } from "./lib/exclusive-first-dollar-payment-links.mjs";
import { evaluateFirstDollarPaymentLinkDiscovery } from "./lib/first-dollar-payment-link-discovery.mjs";
import { railwayVariables } from "./railway-json.mjs";

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const CANONICAL_STARTER_AMOUNT = 19700;
const CANONICAL_SUCCESS_URL = "https://smirkcalls.com/success?session_id={CHECKOUT_SESSION_ID}";

function objectId(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") return String(value.id || "").trim();
  return "";
}

function safeRailwayVariables() {
  try {
    return railwayVariables({ quiet: true, attempts: 2, delayMs: 1000 });
  } catch {
    return {};
  }
}

async function listAllPaymentLinks(stripe) {
  const links = [];
  let startingAfter;
  let pageCount = 0;
  let hasMore = false;
  do {
    const page = await stripe.paymentLinks.list({
      limit: PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    if (!Array.isArray(page?.data)) throw new Error("payment-link-list-invalid");
    links.push(...page.data);
    pageCount += 1;
    hasMore = page.has_more === true;
    startingAfter = objectId(page.data.at(-1)?.id);
    if (hasMore && !startingAfter) throw new Error("payment-link-pagination-invalid");
  } while (hasMore && pageCount < MAX_PAGES);
  if (hasMore) throw new Error("payment-link-scan-limit-exceeded");
  return links;
}

async function listAllPaymentLinkLineItems(stripe, paymentLinkId) {
  const lineItems = [];
  let startingAfter;
  let pageCount = 0;
  let hasMore = false;
  do {
    const page = await stripe.paymentLinks.listLineItems(paymentLinkId, {
      limit: PAGE_SIZE,
      expand: ["data.price.product"],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    if (!Array.isArray(page?.data)) {
      throw new Error(`payment-link-line-items-invalid:${paymentLinkId}`);
    }
    lineItems.push(...page.data);
    pageCount += 1;
    hasMore = page.has_more === true;
    startingAfter = objectId(page.data.at(-1)?.id);
    if (hasMore && !startingAfter) {
      throw new Error(`payment-link-line-item-pagination-invalid:${paymentLinkId}`);
    }
  } while (hasMore && pageCount < MAX_PAGES);
  if (hasMore) {
    throw new Error(`payment-link-line-item-scan-limit-exceeded:${paymentLinkId}`);
  }
  return { data: lineItems };
}

async function describeSmirkPaymentLink(stripe, link) {
  const lineItems = await listAllPaymentLinkLineItems(stripe, link.id);
  const classification = classifyActiveSmirkPaymentLink(link, lineItems);
  if (!classification.smirk) return null;
  const lines = lineItems.data.map((line) => {
    const product = line?.price?.product;
    return {
      productId: typeof product === "object" ? objectId(product) : objectId(product),
      productName: typeof product === "object" ? String(product?.name || "").trim() : null,
      priceId: objectId(line?.price),
      amount: Number(line?.price?.unit_amount || 0),
      currency: String(line?.price?.currency || "").toLowerCase(),
      interval: String(line?.price?.recurring?.interval || "") || null,
      intervalCount: Number(line?.price?.recurring?.interval_count || 1),
    };
  });
  const metadata = link?.metadata || {};
  const subscriptionMetadata = link?.subscription_data?.metadata || {};
  const redirectUrl = link?.after_completion?.type === "redirect"
    ? String(link?.after_completion?.redirect?.url || "").trim()
    : null;
  const customFields = Array.isArray(link?.custom_fields) ? link.custom_fields : [];
  const requiredBusinessName = customFields.some((field) => (
    String(field?.key || "").trim() === "business_name"
    && field?.optional !== true
  ));
  const canonicalStarterPrice = lines.length === 1
    && lines[0].amount === CANONICAL_STARTER_AMOUNT
    && lines[0].currency === "usd"
    && lines[0].interval === "month"
    && lines[0].intervalCount === 1;
  const policyVersion = String(
    metadata.smirk_customer_policy_version
      || subscriptionMetadata.smirk_customer_policy_version
      || "",
  ).trim();
  const markedProduct = String(
    metadata.smirk_product
      || subscriptionMetadata.smirk_product
      || "",
  ).trim();
  const markedPlan = String(
    metadata.plan
      || subscriptionMetadata.plan
      || "",
  ).trim().toLowerCase();
  return {
    id: objectId(link),
    url: String(link?.url || "").trim(),
    active: link?.active === true,
    livemode: link?.livemode === true,
    createdAt: Number.isFinite(Number(link?.created))
      ? new Date(Number(link.created) * 1000).toISOString()
      : null,
    classifiedPlan: classification.plan,
    classificationReason: classification.reason,
    lines,
    checks: {
      canonicalStarterPrice,
      canonicalSuccessRedirect: redirectUrl === CANONICAL_SUCCESS_URL,
      redirectUrl,
      termsAcceptanceRequired: link?.consent_collection?.terms_of_service === "required",
      phoneCollectionRequired: link?.phone_number_collection?.enabled === true,
      businessNameCollectionRequired: requiredBusinessName,
      policyVersionRecorded: Boolean(policyVersion),
      productMetadataBound: markedProduct === "missed_call_recovery",
      starterMetadataBound: markedPlan === "starter",
      automaticTaxEnabled: link?.automatic_tax?.enabled === true,
      promotionCodesAllowed: link?.allow_promotion_codes === true,
      billingAddressCollection: String(link?.billing_address_collection || "auto"),
      customerCreation: String(link?.customer_creation || "if_required"),
    },
  };
}

const railwayEnv = safeRailwayVariables();
const value = (key) => String(process.env[key] || railwayEnv[key] || "").trim();
const restrictedKey = value("STRIPE_REVENUE_READ_KEY");
if (!/^rk_live_[A-Za-z0-9_]+$/.test(restrictedKey)) {
  console.error(JSON.stringify({
    ok: false,
    error: "stripe-live-restricted-read-key-unavailable",
    message: "A dedicated live restricted read key is required; no provider mutation was attempted.",
  }, null, 2));
  process.exit(1);
}

const stripe = new Stripe(restrictedKey, {
  apiVersion: "2026-04-22.dahlia",
  maxNetworkRetries: 2,
  timeout: 10_000,
});

try {
  const links = await listAllPaymentLinks(stripe);
  const described = [];
  for (const link of links) {
    const item = await describeSmirkPaymentLink(stripe, link);
    if (item) described.push(item);
  }
  const configuredUrls = {
    starter: value("STRIPE_PAYMENT_LINK_STARTER") || null,
    pro: value("STRIPE_PAYMENT_LINK_PRO") || null,
    enterprise: value("STRIPE_PAYMENT_LINK_ENTERPRISE") || null,
  };
  const evaluation = evaluateFirstDollarPaymentLinkDiscovery({
    described,
    configuredUrls,
  });
  console.log(JSON.stringify({
    ok: evaluation.ok,
    checkedAt: new Date().toISOString(),
    readOnly: true,
    mutationAttempted: false,
    configuredUrls: evaluation.configuredUrls,
    configuredBindings: evaluation.configuredBindings,
    activeSmirkLinkCount: evaluation.activeSmirkLinks.length,
    activeStarter197CandidateCount: evaluation.activeStarter197Candidates.length,
    launchReadyStarterCandidateCount: evaluation.launchReadyStarterCandidates.length,
    proposedStarterId: evaluation.proposedStarterId,
    blockers: evaluation.blockers,
    activeStarter197Candidates: evaluation.activeStarter197Candidates,
    activeLinksRequiringResolution: evaluation.activeLinksRequiringResolution,
    nextAction: evaluation.blockers.length
      ? "Choose and fully configure one exact $197 Starter Payment Link after owner-policy review; separately approve exact-ID deactivation for every other active SMIRK link."
      : "Use the one proposed Starter ID in a masked first-dollar environment dry run; no write is authorized by this report.",
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    readOnly: true,
    mutationAttempted: false,
    error: "stripe-payment-link-read-failed",
    stripeError: {
      code: String(error?.code || ""),
      type: String(error?.type || ""),
    },
  }, null, 2));
  process.exit(1);
}
