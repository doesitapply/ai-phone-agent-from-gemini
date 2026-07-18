const CANONICAL_SMIRK_PRODUCT_PLANS = new Map([
  ["SMIRK AI Starter", "starter"],
  ["SMIRK AI Pro", "pro"],
  ["SMIRK AI Agency", "enterprise"],
  ["SMIRK AI Enterprise", "enterprise"],
]);

const FIRST_DOLLAR_PLAN = "starter";
const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 5;

function objectId(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") return String(value.id || "").trim();
  return "";
}

function metadataPlan(link) {
  const metadata = link?.metadata || {};
  const subscriptionMetadata = link?.subscription_data?.metadata || {};
  const hasSmirkMarker = /^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(String(
    metadata.smirk_customer_policy_version
      || subscriptionMetadata.smirk_customer_policy_version
      || "",
  ).trim()) || String(metadata.smirk_product || subscriptionMetadata.smirk_product || "").trim() === "missed_call_recovery";
  if (!hasSmirkMarker) return null;
  const value = String(
    metadata.plan
      || subscriptionMetadata.plan
      || "",
  ).trim().toLowerCase();
  if (value === "starter") return "starter";
  if (value === "pro") return "pro";
  if (value === "enterprise" || value === "agency") return "enterprise";
  return null;
}

export function classifyActiveSmirkPaymentLink(link, lineItems) {
  const lines = Array.isArray(lineItems?.data) ? lineItems.data : [];
  let brandedProduct = false;
  const productPlans = new Set();
  for (const line of lines) {
    const product = line?.price?.product;
    const name = typeof product === "object" ? String(product?.name || "").trim() : "";
    if (/^SMIRK(?:\s+AI)?\b/i.test(name)) brandedProduct = true;
    const namedPlan = CANONICAL_SMIRK_PRODUCT_PLANS.get(name);
    if (namedPlan) productPlans.add(namedPlan);
    const amount = Number(line?.price?.unit_amount || 0);
    const currency = String(line?.price?.currency || "").toLowerCase();
    const recurring = line?.price?.recurring || {};
    const canonicalMonthlyPrice = currency === "usd"
      && recurring.interval === "month"
      && Number(recurring.interval_count || 1) === 1;
    if (canonicalMonthlyPrice && (amount === 19700 || amount === 29900)) productPlans.add("starter");
    if (canonicalMonthlyPrice && (amount === 39700 || amount === 59900)) productPlans.add("pro");
    if (canonicalMonthlyPrice && (amount === 69700 || amount === 149900)) productPlans.add("enterprise");
  }
  const markedPlan = metadataPlan(link);
  if (markedPlan) productPlans.add(markedPlan);
  const hasProductMarker = String(
    link?.metadata?.smirk_product
      || link?.subscription_data?.metadata?.smirk_product
      || "",
  ).trim() === "missed_call_recovery";
  const hasPolicyMarker = /^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(String(
    link?.metadata?.smirk_customer_policy_version
      || link?.subscription_data?.metadata?.smirk_customer_policy_version
      || "",
  ).trim());
  if (hasPolicyMarker && !markedPlan) {
    for (const line of lines) {
      const amount = Number(line?.price?.unit_amount || 0);
      const currency = String(line?.price?.currency || "").toLowerCase();
      if (currency !== "usd") continue;
      if (amount === 19700) productPlans.add("starter");
      if (amount === 39700) productPlans.add("pro");
      if (amount === 69700 || amount === 149900) productPlans.add("enterprise");
    }
  }
  if (productPlans.size === 0 && !brandedProduct && !hasPolicyMarker && !hasProductMarker) {
    return { smirk: false, plan: null, reason: "unrelated-payment-link" };
  }
  if (productPlans.size === 0) return { smirk: true, plan: null, reason: "unclassified-smirk-marker" };
  if (productPlans.size !== 1) return { smirk: true, plan: null, reason: "conflicting-smirk-plan-markers" };
  return { smirk: true, plan: Array.from(productPlans)[0], reason: "canonical-smirk-marker" };
}

export async function verifyExclusiveActiveFirstDollarPaymentLink({
  stripe,
  expectedStarterId,
  approvedFulfillmentIds = [],
  maxPages = DEFAULT_MAX_PAGES,
}) {
  const starterId = String(expectedStarterId || "").trim();
  if (!/^plink_[A-Za-z0-9_]+$/.test(starterId)) {
    return { ok: false, reason: "expected-starter-payment-link-id-invalid", blockers: ["expected-starter-payment-link-id-invalid"] };
  }
  if (!stripe?.paymentLinks?.list || !stripe?.paymentLinks?.listLineItems) {
    return { ok: false, reason: "stripe-payment-link-reader-unavailable", blockers: ["stripe-payment-link-reader-unavailable"] };
  }
  const fulfillmentIds = Array.isArray(approvedFulfillmentIds)
    ? approvedFulfillmentIds.map((value) => String(value || "").trim())
    : [];
  if (
    fulfillmentIds.length < 1
    || fulfillmentIds.length > 20
    || fulfillmentIds.some((id) => !/^plink_[A-Za-z0-9_]+$/.test(id))
    || new Set(fulfillmentIds).size !== fulfillmentIds.length
    || !fulfillmentIds.includes(starterId)
  ) {
    return {
      ok: false,
      reason: "starter-fulfillment-payment-link-ids-invalid",
      blockers: ["starter-fulfillment-payment-link-ids-invalid"],
    };
  }

  const activeSmirkLinks = [];
  const blockers = [];
  let startingAfter;
  let pageCount = 0;
  let scannedActiveLinks = 0;
  let hasMore = false;
  const historicalPaymentLinks = [];

  try {
    const readAllLineItems = async (paymentLinkId) => {
      const data = [];
      let lineStartingAfter;
      let linePageCount = 0;
      let lineHasMore = false;
      while (linePageCount < maxPages) {
        const page = await stripe.paymentLinks.listLineItems(paymentLinkId, {
          limit: PAGE_SIZE,
          expand: ["data.price.product"],
          ...(lineStartingAfter ? { starting_after: lineStartingAfter } : {}),
        });
        if (!Array.isArray(page?.data)) throw new Error("payment-link-line-items-invalid");
        data.push(...page.data);
        linePageCount += 1;
        lineHasMore = page?.has_more === true;
        if (!lineHasMore) break;
        lineStartingAfter = objectId(page.data.at(-1)?.id);
        if (!lineStartingAfter) throw new Error("payment-link-line-items-pagination-invalid");
      }
      if (linePageCount >= maxPages && lineHasMore) {
        blockers.push(`payment-link-line-items-scan-limit-exceeded:${paymentLinkId}`);
      }
      return { data };
    };
    while (pageCount < maxPages) {
      const page = await stripe.paymentLinks.list({
        active: true,
        limit: PAGE_SIZE,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      if (!Array.isArray(page?.data)) {
        return { ok: false, reason: "active-payment-link-list-invalid", blockers: ["active-payment-link-list-invalid"] };
      }
      pageCount += 1;
      for (const link of page.data) {
        const id = objectId(link?.id);
        if (!/^plink_[A-Za-z0-9_]+$/.test(id)) {
          blockers.push("active-payment-link-id-invalid");
          continue;
        }
        if (link?.active !== true || link?.livemode !== true) {
          blockers.push(`active-payment-link-state-invalid:${id}`);
          continue;
        }
        scannedActiveLinks += 1;
        const lineItems = await readAllLineItems(id);
        const classification = classifyActiveSmirkPaymentLink(link, lineItems);
        if (!classification.smirk) continue;
        activeSmirkLinks.push({ id, plan: classification.plan, reason: classification.reason });
        if (id !== starterId) {
          blockers.push(`unapproved-active-smirk-payment-link:${classification.plan || "conflicting"}:${id}`);
          continue;
        }
        if (classification.plan !== FIRST_DOLLAR_PLAN) {
          blockers.push(`configured-first-dollar-link-is-not-starter:${classification.plan || "conflicting"}:${id}`);
        }
      }

      hasMore = page?.has_more === true;
      if (!hasMore) break;
      startingAfter = objectId(page.data.at(-1)?.id);
      if (!startingAfter) {
        blockers.push("active-payment-link-pagination-invalid");
        break;
      }
    }
    if (pageCount >= maxPages && hasMore) blockers.push("active-payment-link-scan-limit-exceeded");
    for (const historicalId of fulfillmentIds.filter((id) => id !== starterId)) {
      if (!stripe.paymentLinks.retrieve) {
        blockers.push(`historical-payment-link-read-unavailable:${historicalId}`);
        continue;
      }
      const historical = await stripe.paymentLinks.retrieve(historicalId);
      historicalPaymentLinks.push({
        id: historicalId,
        active: historical?.active === true,
        livemode: historical?.livemode === true,
      });
      if (historical?.id !== historicalId || historical?.livemode !== true) {
        blockers.push(`historical-payment-link-invalid:${historicalId}`);
      } else if (historical?.active !== false) {
        blockers.push(`historical-payment-link-still-active:${historicalId}`);
      }
    }
  } catch (error) {
    return {
      ok: false,
      reason: "active-payment-link-provider-read-failed",
      blockers: ["active-payment-link-provider-read-failed"],
      stripeError: {
        code: String(error?.code || ""),
        type: String(error?.type || ""),
      },
    };
  }

  const expectedMatches = activeSmirkLinks.filter((link) => link.id === starterId && link.plan === FIRST_DOLLAR_PLAN);
  if (expectedMatches.length !== 1) blockers.push("configured-starter-not-found-in-exclusive-active-scan");
  return {
    ok: blockers.length === 0,
    reason: blockers.length === 0 ? "exclusive-active-starter-payment-link-verified" : "active-smirk-payment-link-exclusivity-failed",
    blockers: Array.from(new Set(blockers)),
    activeSmirkLinks,
    scannedActiveLinks,
    pageCount,
    historicalPaymentLinks,
  };
}
