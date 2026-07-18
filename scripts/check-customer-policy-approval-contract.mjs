#!/usr/bin/env node
import fs from "node:fs";
import {
  CUSTOMER_POLICY_VERSION_RAILWAY_SOURCE,
  readCustomerPolicyVersionFromRailway,
  verifiedRailwayCustomerPolicyVersion,
} from "./lib/deploy-customer-policy-version.mjs";

const manifest = fs.readFileSync("src/customer-policy-approval.js", "utf8");
const buyerRoutes = fs.readFileSync("src/routes/buyer-routes.ts", "utf8");
const app = fs.readFileSync("src/App.tsx", "utf8");
const localEnv = fs.readFileSync("scripts/check-first-dollar-env.mjs", "utf8");
const railwayEnv = fs.readFileSync("scripts/check-railway-first-dollar-env.mjs", "utf8");
const docs = fs.readFileSync("docs/launch/customer-policy-approval-manifest.md", "utf8");
const policyDecisions = fs.readFileSync("docs/launch/first-dollar-policy-decisions.md", "utf8");
const packetWriter = fs.readFileSync("scripts/write-first-dollar-approval-packet.mjs", "utf8");
const packetPrinter = fs.readFileSync("scripts/print-first-dollar-approval-packet.mjs", "utf8");
const deployBundleWriter = fs.readFileSync("scripts/write-deploy-approval-bundle.mjs", "utf8");
const deployHandoffCheck = fs.readFileSync("scripts/check-deploy-approval-handoff.mjs", "utf8");
const fixtures = fs.readFileSync("scripts/check-customer-policy-approval-fixtures.mjs", "utf8");
const limits = fs.readFileSync("src/plan-limits.js", "utf8");
const saas = fs.readFileSync("src/saas.ts", "utf8");
const failures = [];
const expect = (label, condition) => { if (!condition) failures.push(label); };

const previousAmbientPolicyVersion = process.env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION;
process.env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION = "process-env-must-never-be-live-proof";
let requestedRailwayTarget = null;
const railwayVersionEvidence = readCustomerPolicyVersionFromRailway((target) => {
  requestedRailwayTarget = target;
  return { SMIRK_CUSTOMER_POLICY_APPROVED_VERSION: "policy-v1" };
});
const emptyRailwayVersionEvidence = readCustomerPolicyVersionFromRailway(() => ({}));
const failedRailwayVersionEvidence = readCustomerPolicyVersionFromRailway(() => {
  throw new Error("fixture Railway read failure");
});
if (previousAmbientPolicyVersion === undefined) {
  delete process.env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION;
} else {
  process.env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION = previousAmbientPolicyVersion;
}
const verifiedRailwayEvidence = verifiedRailwayCustomerPolicyVersion(railwayVersionEvidence);
const spoofedSourceEvidence = verifiedRailwayCustomerPolicyVersion({
  ...railwayVersionEvidence,
  customerPolicyVersionSource: "process-environment",
});
const failedReadSpoofEvidence = verifiedRailwayCustomerPolicyVersion({
  ...railwayVersionEvidence,
  customerPolicyVersionReadSucceeded: false,
});
const wrongTargetEvidence = verifiedRailwayCustomerPolicyVersion({
  ...railwayVersionEvidence,
  customerPolicyVersionTarget: {
    ...railwayVersionEvidence.customerPolicyVersionTarget,
    environmentId: "not-production",
  },
});
const legacyUnprovenEvidence = verifiedRailwayCustomerPolicyVersion({
  customerPolicyVersion: "policy-v1",
  customerPolicyVersionRecorded: true,
});

expect("Railway policy-version fixture ignores ambient process values and pins the exact production target",
  railwayVersionEvidence.customerPolicyVersion === "policy-v1"
  && railwayVersionEvidence.customerPolicyVersionRecorded === true
  && railwayVersionEvidence.customerPolicyVersionReadSucceeded === true
  && railwayVersionEvidence.customerPolicyVersionSource === CUSTOMER_POLICY_VERSION_RAILWAY_SOURCE
  && requestedRailwayTarget?.projectId === "90599f03-6d6f-4044-8933-e0301be67a82"
  && requestedRailwayTarget?.serviceId === "96bcd6e7-9487-4197-bcd1-a6bd0546e6b2"
  && requestedRailwayTarget?.environmentId === "22e0a5a3-43bf-4b6c-8fa6-635e7c94b84a");
expect("Railway policy-version fixtures distinguish successful empty reads from failed reads",
  emptyRailwayVersionEvidence.customerPolicyVersion === null
  && emptyRailwayVersionEvidence.customerPolicyVersionRecorded === false
  && emptyRailwayVersionEvidence.customerPolicyVersionReadSucceeded === true
  && emptyRailwayVersionEvidence.customerPolicyVersionSource === CUSTOMER_POLICY_VERSION_RAILWAY_SOURCE
  && emptyRailwayVersionEvidence.customerPolicyVersionReadFailure === null
  && failedRailwayVersionEvidence.customerPolicyVersion === null
  && failedRailwayVersionEvidence.customerPolicyVersionRecorded === false
  && failedRailwayVersionEvidence.customerPolicyVersionReadSucceeded === false
  && failedRailwayVersionEvidence.customerPolicyVersionSource === null
  && failedRailwayVersionEvidence.customerPolicyVersionReadFailure === "railway-production-variables-read-failed");
expect("packet policy-version fixture rejects unproven, process-sourced, and failed-read bundle claims",
  verifiedRailwayEvidence.provenanceVerified === true
  && verifiedRailwayEvidence.version === "policy-v1"
  && spoofedSourceEvidence.provenanceVerified === false
  && spoofedSourceEvidence.version === ""
  && failedReadSpoofEvidence.provenanceVerified === false
  && failedReadSpoofEvidence.version === ""
  && wrongTargetEvidence.provenanceVerified === false
  && wrongTargetEvidence.version === ""
  && wrongTargetEvidence.railwayReadSucceeded === false
  && wrongTargetEvidence.source === null
  && legacyUnprovenEvidence.provenanceVerified === false
  && legacyUnprovenEvidence.version === "");

expect("production manifest is checked in and explicitly unapproved",
  manifest.includes('approvalState: "not_approved"')
  && manifest.includes("approved: false")
  && manifest.includes("policyVersion: null"));
expect("core approval requires explicit tax cancellation and proration choices",
  manifest.includes("taxMode: null")
  && manifest.includes("cancellationMode: null")
  && manifest.includes("cancellationProrationBehavior: null")
  && manifest.includes("customer_policy_tax_mode_missing")
  && manifest.includes("customer_policy_cancellation_mode_missing")
  && manifest.includes("customer_policy_cancellation_proration_missing")
  && fixtures.includes('["taxMode"')
  && fixtures.includes('["cancellationMode"')
  && fixtures.includes('["cancellationProrationBehavior"'));
expect("Starter approval binds the owner-approved hard stop to runtime limits",
  manifest.includes("starterUsagePolicy: Object.freeze")
  && manifest.includes("starter_usage_policy_owner_approval_missing")
  && manifest.includes('starterUsageRule?.mode !== "hard_cap"')
  && manifest.includes("starter_usage_policy_runtime_limits_mismatch")
  && manifest.includes("PLAN_LIMITS.starter?.calls !== starterUsageRule?.monthlyCallHardCap")
  && fixtures.includes("invalidStarterPolicy")
  && limits.includes('starter: Object.freeze({ calls: 500, minutes: 1000'));
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
  && docs.includes("must not draft, infer, or mark these policies approved")
  && docs.includes("six unique stable public HTTPS URLs")
  && docs.includes("before Enterprise is enabled"));
expect("owner policy decision card is canonical, explicit, and has no selected defaults",
  policyDecisions.includes("<!-- SMIRK_OWNER_POLICY_DECISION_CARD_START -->")
  && policyDecisions.includes("<!-- SMIRK_OWNER_POLICY_DECISION_CARD_END -->")
  && policyDecisions.includes("Every blank means NOT APPROVED")
  && policyDecisions.includes("tax_mode=<choose exactly stripe_automatic_tax OR stripe_automatic_tax_disabled>")
  && policyDecisions.includes("cancellation_mode=<choose exactly at_period_end OR immediately>")
  && policyDecisions.includes("cancellation_proration_behavior=<choose exactly none OR create_prorations>")
  && policyDecisions.includes("starter_usage_decision=<choose exactly approve_existing_hard_cap_500_calls_1000_minutes OR request_separately_reviewed_change>")
  && policyDecisions.includes("final_owner_confirmation=<required explicit confirmation binding the exact version and six listed documents; no default>")
  && !policyDecisions.includes("tax_mode=stripe_automatic_tax\n")
  && !policyDecisions.includes("cancellation_mode=at_period_end\n")
  && !policyDecisions.includes("cancellation_proration_behavior=none\n"));
expect("owner decision card cannot itself approve policy or authorize production actions",
  policyDecisions.includes("does not draft or publish legal terms")
  && policyDecisions.includes("update the checked-in manifest or live environment")
  && policyDecisions.includes("enable checkout")
  && policyDecisions.includes("authorize a deploy")
  && policyDecisions.includes("send outreach")
  && policyDecisions.includes("initiate a charge")
  && policyDecisions.includes("must not fill this card, select a choice, change `approvalState`, or treat a partial response as approval"));
expect("deploy approval bundle records only exact Railway production policy-version provenance",
  deployBundleWriter.includes("readCustomerPolicyVersionFromRailway")
  && deployBundleWriter.includes("projectId: target.projectId")
  && deployBundleWriter.includes("serviceId: target.serviceId")
  && deployBundleWriter.includes("environmentId: target.environmentId")
  && deployBundleWriter.includes("...customerPolicyVersionEvidence")
  && deployBundleWriter.includes("delete approvalEnv.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION")
  && !deployBundleWriter.includes("process.env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION")
  && deployHandoffCheck.includes("customerPolicyVersionReadSucceeded")
  && deployHandoffCheck.includes("customerPolicyVersionSource")
  && deployHandoffCheck.includes("customerPolicyVersionTarget")
  && deployHandoffCheck.includes("railway-production-variables-read-failed"));
expect("approval packet uses the canonical card, manifest evaluator, and verified Railway provenance",
  packetWriter.includes('import { evaluateCustomerPolicyApproval } from "../src/customer-policy-approval.js"')
  && packetWriter.includes('import { verifiedRailwayCustomerPolicyVersion } from "./lib/deploy-customer-policy-version.mjs"')
  && packetWriter.includes("const ownerPolicyDecisionCard = policyDecisionSheet")
  && packetWriter.includes("const customerPolicyVersionEvidence = verifiedRailwayCustomerPolicyVersion(deployBundle)")
  && packetWriter.includes("const customerPolicyEvaluation = evaluateCustomerPolicyApproval(")
  && packetWriter.includes("Customer policy core readiness (manifest plus matching live-config version)")
  && packetWriter.includes("Railway production variables read succeeded:")
  && packetWriter.includes("Customer policy version source:")
  && packetWriter.includes("ownerPolicyDecisionCard,")
  && !packetWriter.includes("Customer policy approval marker ready:")
  && packetPrinter.includes('import { evaluateCustomerPolicyApproval } from "../src/customer-policy-approval.js"')
  && packetPrinter.includes('import { verifiedRailwayCustomerPolicyVersion } from "./lib/deploy-customer-policy-version.mjs"')
  && packetPrinter.includes("const ownerPolicyDecisionCard = policyDecisionSheet")
  && packetPrinter.includes("const customerPolicyVersionEvidence = verifiedRailwayCustomerPolicyVersion(deployBundle)")
  && packetPrinter.includes("Customer policy core readiness (manifest plus matching live-config version)")
  && packetPrinter.includes("const customerPolicyVersionMatches = customerPolicyVersionEvidence.provenanceVerified")
  && packetPrinter.includes("customerPolicyEvaluation.versionMatches === true")
  && !packetPrinter.includes("Customer policy approval marker ready:"));
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

console.log("OK recurring checkout and approval packets require exact approved policy bytes plus verified Railway production policy-version provenance");
