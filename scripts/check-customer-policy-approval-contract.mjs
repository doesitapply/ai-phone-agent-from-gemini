#!/usr/bin/env node
import fs from "node:fs";

const manifest = fs.readFileSync("src/customer-policy-approval.js", "utf8");
const buyerRoutes = fs.readFileSync("src/routes/buyer-routes.ts", "utf8");
const app = fs.readFileSync("src/App.tsx", "utf8");
const localEnv = fs.readFileSync("scripts/check-first-dollar-env.mjs", "utf8");
const railwayEnv = fs.readFileSync("scripts/check-railway-first-dollar-env.mjs", "utf8");
const docs = fs.readFileSync("docs/launch/customer-policy-approval-manifest.md", "utf8");
const fixtures = fs.readFileSync("scripts/check-customer-policy-approval-fixtures.mjs", "utf8");
const limits = fs.readFileSync("src/plan-limits.js", "utf8");
const saas = fs.readFileSync("src/saas.ts", "utf8");
const failures = [];
const expect = (label, condition) => { if (!condition) failures.push(label); };

expect("production manifest is checked in and explicitly unapproved",
  manifest.includes('approvalState: "not_approved"')
  && manifest.includes("approved: false")
  && manifest.includes("policyVersion: null"));
for (const documentName of ["terms", "privacy", "cancellationRefund", "billingManagement", "support", "dataConsent"]) {
  expect(`manifest requires versioned and digest-bound ${documentName} publication`,
    manifest.includes(`${documentName}: Object.freeze({ version: null, url: null, contentSha256: null, versionMarker: null })`));
}
expect("env-only policy approval cannot open checkout",
  buyerRoutes.includes("evaluateCustomerPolicyApproval(customerPolicyVersion)")
  && buyerRoutes.includes("const customerPolicyReady = customerPolicy.coreReady && publishedPolicyProof?.ok === true")
  && localEnv.includes("evaluateCustomerPolicyApproval(normalized)")
  && railwayEnv.includes("evaluateCustomerPolicyApproval(normalized)"));
expect("readiness surfaces exact policy and Enterprise blockers",
  buyerRoutes.includes("policyBlockers,")
  && buyerRoutes.includes("enterpriseUsagePolicyBlockers,")
  && buyerRoutes.includes('code: !readiness.customerPolicyReady ? "CUSTOMER_POLICY_APPROVAL_REQUIRED"'));
expect("Starter and Pro use core publication while Enterprise additionally requires exact live Enterprise publication",
  buyerRoutes.includes('getPublishedCustomerPolicyProof(customerPolicyVersion, "starter")')
  && buyerRoutes.includes('getPublishedCustomerPolicyProof(customerPolicyVersion, "enterprise")')
  && buyerRoutes.includes("enterpriseUsagePolicyPublicationVerified")
  && fixtures.includes("corePublication")
  && fixtures.includes("unresolvedEnterprisePublication"));
expect("live gate verifies exact policy bodies without redirects",
  railwayEnv.includes("verifyPublishedCustomerPolicyDocumentsForPlan(customerPolicyVersion, 'starter')")
  && buyerRoutes.includes('getPublishedCustomerPolicyProof(customerPolicyVersion, "starter")')
  && buyerRoutes.includes("customerPolicyPublicationVerified: publishedPolicyProof?.ok === true")
  && manifest.includes('redirect: "error"')
  && manifest.includes("AbortSignal.timeout(10_000)")
  && manifest.includes('createHash("sha256")')
  && manifest.includes("actualDigest !== digest")
  && manifest.includes("decoded.includes(marker)")
  && manifest.includes("customer_policy_publication_urls_not_unique")
  && manifest.includes("customer_policy_publication_digests_not_unique"));
expect("Enterprise unlimited claim is removed and exposure is policy-gated",
  !buyerRoutes.includes("No built-in monthly call or minute cap")
  && buyerRoutes.includes("Usage limits and any overage terms require an owner-approved Enterprise policy")
  && manifest.includes("enterprise_usage_policy_owner_approval_missing")
  && manifest.includes('usageRule?.mode !== "hard_cap"')
  && manifest.includes("enterprise_usage_policy_runtime_limits_mismatch")
  && limits.includes("enabled: false")
  && limits.includes("calls: 0")
  && !limits.includes("calls: -1")
  && saas.includes("ws.monthly_call_limit <= 0")
  && saas.includes("customerPolicyReadyForPlan(customerPolicy, plan)")
  && app.includes('plan.checkout_available !== true')
  && app.includes('"Checkout unavailable"'));
expect("fixtures prove fail-closed and future approved paths",
  fixtures.includes("arbitraryEnvOnly")
  && fixtures.includes("enterpriseUnresolved")
  && fixtures.includes("completeFixtureManifest")
  && fixtures.includes("failedLive")
  && fixtures.includes("bodyless")
  && fixtures.includes("genericSpa")
  && fixtures.includes("reused")
  && fixtures.includes("wrongDigest")
  && fixtures.includes("fixtureRuntimeEnterpriseLimits"));
expect("approval documentation refuses to invent or self-approve legal terms",
  docs.includes("Current status: NOT APPROVED")
  && docs.includes("must not draft, infer, or mark these policies approved"));
expect("buyer-facing landing and pricing surfaces expose only manifest-derived policy/support links",
  buyerRoutes.includes("policy_links: readiness.policyLinks")
  && app.includes("function PublicPolicyLinks")
  && app.includes('terms: "Terms"')
  && app.includes('privacy: "Privacy"')
  && app.includes('cancellation_refund: "Cancellation & refunds"')
  && app.includes('billing_management: "Billing management"')
  && app.includes('support: "Support"')
  && app.includes("normalizePublicPolicyLinks(body.policy_links)")
  && app.includes("<PublicPolicyLinks links={policyLinks} />"));

if (failures.length > 0) {
  console.error("FAIL customer policy approval contract drift:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK recurring checkout requires exact approved policy bytes and Enterprise hard caps bound to runtime enforcement");
