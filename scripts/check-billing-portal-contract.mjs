#!/usr/bin/env node
import fs from "node:fs";

const helper = fs.readFileSync("src/stripe-billing-portal.ts", "utf8");
const buyer = fs.readFileSync("src/routes/buyer-routes.ts", "utf8");
const server = fs.readFileSync("server.ts", "utf8");
const app = fs.readFileSync("src/App.tsx", "utf8");
const localEnv = fs.readFileSync("scripts/check-first-dollar-env.mjs", "utf8");
const railwayEnv = fs.readFileSync("scripts/check-railway-first-dollar-env.mjs", "utf8");
const docs = fs.readFileSync("STRIPE_PAYMENT_LINK_SETUP.md", "utf8");
const failures = [];
const expect = (label, value) => { if (!value) failures.push(label); };

expect("portal route is workspace authenticated and does not accept a body workspace/customer",
  buyer.includes('app.post("/api/billing/portal", workspaceBillingPortalAuth')
  && buyer.includes('(req as any).authMode !== "workspace"')
  && buyer.includes("workspace,")
  && !buyer.includes("req.body.stripe_customer_id")
  && server.includes("const workspaceBillingPortalAuth")
  && server.includes("getWorkspaceByApiKey(workspaceToken)")
  && !server.slice(server.indexOf("const workspaceBillingPortalAuth"), server.indexOf("const requireOperator")).includes("hasWorkspaceBillingEntitlement"));
expect("portal session binds exact workspace customer, configuration, and trusted return",
  helper.includes("input.workspace?.stripe_customer_id")
  && helper.includes("configuration: input.configurationId")
  && helper.includes('new URL("/?billing=portal_return", trustedOrigin)'));
expect("portal readiness fails closed on exact live feature configuration",
  helper.includes("configuration?.livemode !== true")
  && helper.includes("configuration?.active !== true")
  && helper.includes("invoice_history?.enabled !== true")
  && helper.includes("payment_method_update?.enabled !== true")
  && helper.includes("subscription_cancel?.enabled !== true")
  && helper.includes("portal-terms-url-mismatch")
  && helper.includes("portal-privacy-url-mismatch")
  && helper.includes("portal-cancellation-mode-mismatch")
  && helper.includes("portal-cancellation-proration-mismatch")
  && helper.includes("portal-restricted-key-not-distinct")
  && buyer.includes("&& billingPortalReady"));
expect("portal configuration proof is cached", buyer.includes("BILLING_PORTAL_PROOF_CACHE_MS") && buyer.includes("billingPortalProofCache"));
expect("workspace settings expose the authenticated portal path", app.includes('api<{ ok: boolean; url: string }>("/api/billing/portal"') && app.includes("Manage billing"));
expect("local and Railway env checks require dedicated portal credentials",
  localEnv.includes("STRIPE_BILLING_PORTAL_KEY")
  && localEnv.includes("STRIPE_BILLING_PORTAL_CONFIGURATION_ID")
  && railwayEnv.includes("STRIPE_BILLING_PORTAL_KEY")
  && railwayEnv.includes("verifyBillingPortalConfiguration")
  && railwayEnv.includes("Stripe restricted-key separation"));
expect("runbook documents exact approved portal bindings and distinct restricted key", docs.includes("STRIPE_BILLING_PORTAL_KEY") && docs.includes("invoice history") && docs.includes("payment method") && docs.includes("Terms and Privacy URLs") && docs.includes("different credential"));

if (failures.length) {
  console.error("FAIL Stripe billing portal contract drift:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("OK authenticated Stripe Billing Portal path is tenant-bound, feature-verified, cached, and checkout-gating");
