#!/usr/bin/env node
import {
  CUSTOMER_POLICY_APPROVAL_MANIFEST,
  evaluateCustomerPolicyApproval,
  verifyPublishedCustomerPolicyDocuments,
  verifyPublishedCustomerPolicyDocumentsForPlan,
} from "../src/customer-policy-approval.js";

const planArg = process.argv.find((arg) => arg.startsWith("--plan="));
const plan = String(planArg?.split("=")[1] || "enterprise").trim().toLowerCase();
if (!["starter", "pro", "enterprise", "agency"].includes(plan)) {
  console.error("FAIL --plan must be starter, pro, enterprise, or agency");
  process.exit(2);
}
const configuredVersion = String(process.env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION || "").trim();
const evaluation = evaluateCustomerPolicyApproval(configuredVersion);
const corePlan = plan === "starter" || plan === "pro";
const planReady = evaluation.coreReady && (corePlan || evaluation.enterpriseUsageReady);
const planBlockers = corePlan ? evaluation.coreBlockers : evaluation.blockers;
console.log(JSON.stringify({
  ok: planReady,
  plan,
  manifestApprovalState: evaluation.manifestApprovalState,
  versionMatches: evaluation.versionMatches,
  corePolicyReady: evaluation.coreReady,
  enterpriseUsagePolicyReady: evaluation.enterpriseUsageReady,
  blockers: planBlockers,
  manifestSchemaVersion: CUSTOMER_POLICY_APPROVAL_MANIFEST.manifestSchemaVersion,
  nextAction: planReady
    ? "Run with --verify-live to confirm every approved public policy document is reachable."
    : "Complete docs/launch/first-dollar-policy-decisions.md, obtain explicit owner and qualified review, publish the policy documents, then update the checked-in manifest and matching environment version. Do not approve it from code alone.",
}, null, 2));

if (!planReady) process.exit(1);

if (process.argv.includes("--verify-live")) {
  const live = corePlan
    ? await verifyPublishedCustomerPolicyDocumentsForPlan(configuredVersion, plan)
    : await verifyPublishedCustomerPolicyDocuments(configuredVersion);
  if (!live.ok) {
    console.error("FAIL approved customer policy URLs are not all verifiably public:");
    for (const failure of live.failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`OK checked-in owner approval and public customer policy documents verified live for ${plan}`);
}
