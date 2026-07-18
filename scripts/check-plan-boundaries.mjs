#!/usr/bin/env node
import fs from "node:fs";

const files = {
  buyerRoutes: fs.readFileSync("src/routes/buyer-routes.ts", "utf8"),
  saas: fs.readFileSync("src/saas.ts", "utf8"),
  server: fs.readFileSync("server.ts", "utf8"),
  customerDashboard: fs.readFileSync("scripts/check-customer-dashboard-contract.mjs", "utf8"),
  liveEntitlements: fs.readFileSync("scripts/check-live-workspace-entitlements.mjs", "utf8"),
  stripeSmoke: fs.readFileSync("scripts/check-stripe-webhook-handoff-live.mjs", "utf8"),
};

const failures = [];
const expect = (label, condition) => {
  if (!condition) failures.push(label);
};
const includes = (file, snippet) => files[file].includes(snippet);

expect("public pricing exposes Starter at $197", includes("buyerRoutes", 'id: "starter"') && includes("buyerRoutes", "price: 197"));
expect("public pricing exposes Pro at $397", includes("buyerRoutes", 'id: "pro"') && includes("buyerRoutes", "price: 397"));
expect("public pricing exposes Agency/Enterprise at $697", includes("buyerRoutes", 'id: "enterprise"') && includes("buyerRoutes", "price: 697"));
expect("checkout metadata carries selected plan", includes("buyerRoutes", "const checkoutMetadata: Record<string, string> = {") && includes("buyerRoutes", "plan: plan.id") && includes("buyerRoutes", "metadata: checkoutMetadata"));
expect("subscription metadata carries selected plan", includes("buyerRoutes", "subscription_data:") && includes("buyerRoutes", "metadata: checkoutMetadata"));
expect("checkout completion reads a strictly classified SMIRK plan", includes("saas", "classifySmirkCheckoutForFulfillment(event") && includes("saas", "const { session, plan } = classification;") && includes("saas", "const verifiedPlan = plan!;"));
expect("new paid workspace is created with selected plan", includes("saas", "const workspace = await createWorkspace({") && includes("saas", "plan: verifiedPlan"));
expect("existing paid workspace is updated to selected plan", includes("saas", "await updateWorkspace(existingWorkspace[0].id") && includes("saas", "plan: verifiedPlan"));
expect("subscription updates prefer subscription metadata plan", includes("saas", "const planSource = obj.metadata?.plan ||"));
expect("subscription updates strictly normalize metadata, nickname, lookup key, and product name", includes("saas", "obj.items?.data?.[0]?.price?.lookup_key") && includes("saas", "obj.items?.data?.[0]?.price?.product?.name") && includes("saas", "const plan = strictPaidPlan(planSource);"));
expect("plan normalizer accepts Basic as Starter", includes("saas", '["starter", "basic"].includes(value)') && includes("saas", 'value.includes("basic")'));
expect("plan normalizer accepts Agency as Enterprise", includes("saas", '["enterprise", "agency"].includes(value)') && includes("saas", 'value.includes("agency")'));
expect("plan normalizer preserves Pro", includes("saas", 'if (value === "pro") return "pro";') && includes("saas", 'value.includes("pro")'));
expect("Starter/Basic is not in pro-suite server allowlist", includes("server", 'normalized === "pro" || normalized === "enterprise" || normalized === "agency"') && !includes("server", 'normalized === "starter" || normalized === "basic"'));
expect("pro-suite APIs return PRO_SUITE_REQUIRED for non-Pro workspace tokens", includes("server", 'code: "PRO_SUITE_REQUIRED"') && includes("server", 'required_plan: "pro"'));
expect("pro-suite middleware covers advanced customer APIs", includes("server", '"/api/stats"') && includes("server", '"/api/handoffs"') && includes("server", '"/api/recovery"') && includes("server", '"/api/workspace-overview"'));
expect("dashboard contract locks Starter/Basic visible tabs", includes("customerDashboard", "BASIC_WORKSPACE_TABS") && includes("customerDashboard", '"calls"') && includes("customerDashboard", '"contacts"') && includes("customerDashboard", '"tasks"'));
expect("dashboard contract locks Pro customer suite", includes("customerDashboard", "PRO_WORKSPACE_TABS") && includes("customerDashboard", '"handoffs"') && includes("customerDashboard", '"recovery"') && includes("customerDashboard", '"analytics"'));
expect("live entitlement proof expects Basic pro-suite denial and Pro pro-suite access", includes("liveEntitlements", 'expectedTier === "pro" ? 200 : 403') && includes("liveEntitlements", 'expectedTier,'));
expect("Stripe smoke still exercises Starter paid path", includes("stripeSmoke", 'plan: "starter"') && includes("stripeSmoke", "SMIRK Stripe Webhook Smoke"));

if (failures.length) {
  console.error("FAIL plan boundary contract drift:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK plan boundary contract keeps Basic/Starter and Pro/Agency pricing, provisioning, and entitlement behavior aligned");
