const PAYMENT_LINK_ID = /^plink_[A-Za-z0-9_]+$/;
const MAX_STARTER_FULFILLMENT_IDS = 20;

export function candidateStarterPaymentLinkFulfillmentIds({ currentId, rawIds }) {
  const current = String(currentId || "").trim();
  const tokens = String(rawIds || "").trim()
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([current, ...tokens].filter((value) => PAYMENT_LINK_ID.test(value)))]
    .slice(0, MAX_STARTER_FULFILLMENT_IDS);
}

export function evaluateStarterPaymentLinkFulfillmentIds({ currentId, rawIds }) {
  const current = String(currentId || "").trim();
  const raw = String(rawIds || "").trim();
  const blockers = [];
  const tokens = raw
    ? raw.split(",").map((value) => value.trim()).filter(Boolean)
    : [];

  if (!PAYMENT_LINK_ID.test(current)) blockers.push("starter-current-payment-link-id-invalid");
  if (!raw) blockers.push("starter-fulfillment-payment-link-ids-missing");
  if (tokens.length > MAX_STARTER_FULFILLMENT_IDS) blockers.push("starter-fulfillment-payment-link-ids-too-many");
  if (tokens.some((value) => !PAYMENT_LINK_ID.test(value))) blockers.push("starter-fulfillment-payment-link-id-invalid");
  if (new Set(tokens).size !== tokens.length) blockers.push("starter-fulfillment-payment-link-id-duplicate");
  if (PAYMENT_LINK_ID.test(current) && !tokens.includes(current)) blockers.push("starter-current-payment-link-id-not-allowlisted");

  return {
    ready: blockers.length === 0,
    ids: blockers.length === 0 ? tokens : [],
    currentId: current,
    blockers,
  };
}
