// This is the single runtime source of truth for advertised and enforced plan
// limits. Enterprise is deliberately disabled: the business owner has not
// approved customer-facing caps or overage terms, so code must not interpret a
// sentinel such as -1 as an unlimited commercial promise.
export const PLAN_LIMITS = Object.freeze({
  free: Object.freeze({ calls: 50, minutes: 100, agents: 1, enabled: true, label: "Free Trial" }),
  starter: Object.freeze({ calls: 500, minutes: 1000, agents: 3, enabled: true, label: "Starter — $197/mo" }),
  pro: Object.freeze({ calls: 2000, minutes: 5000, agents: 9, enabled: true, label: "Pro — $397/mo" }),
  enterprise: Object.freeze({
    calls: 0,
    minutes: 0,
    agents: 0,
    enabled: false,
    label: "Agency — checkout disabled pending owner-approved limits",
  }),
});
