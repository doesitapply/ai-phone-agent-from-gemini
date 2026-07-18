#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CUSTOMER_POLICY_APPROVAL_MANIFEST,
  evaluateCustomerPolicyApproval,
  verifyPublishedCustomerPolicyDocuments,
  verifyPublishedCustomerPolicyDocumentsForPlan,
} from "../src/customer-policy-approval.js";

const arbitraryEnvOnly = evaluateCustomerPolicyApproval("looks-approved-v1");
assert.equal(arbitraryEnvOnly.ready, false, "an arbitrary regex-shaped env marker must never enable recurring checkout");
assert.equal(arbitraryEnvOnly.coreReady, false);
assert.equal(arbitraryEnvOnly.enterpriseUsageReady, false);
assert.equal(arbitraryEnvOnly.blockers.some((item) => item.code === "customer_policy_owner_approval_missing"), true);
assert.equal(CUSTOMER_POLICY_APPROVAL_MANIFEST.approvalState, "not_approved", "the checked-in production manifest must remain explicitly unapproved");

const version = "fixture-policy-v1";
const names = [
  "terms",
  "privacy",
  "cancellationRefund",
  "billingManagement",
  "support",
  "dataConsent",
];
const policyBody = (name) => Buffer.from(
  `<!doctype html><title>${name}</title><main>SMIRK-POLICY:${name}:${version}\nfixture owner-approved ${name} content</main>`,
  "utf8",
);
const digest = (body) => createHash("sha256").update(body).digest("hex");
const fixtureDocuments = Object.fromEntries(names.map((name) => [name, {
  version,
  url: `https://smirkcalls.com/policy-fixture/${name}`,
  contentSha256: digest(policyBody(name)),
  versionMarker: `SMIRK-POLICY:${name}:${version}`,
}]));
const baseFixtureManifest = {
  manifestSchemaVersion: 1,
  approvalState: "approved",
  policyVersion: version,
  ownerApproval: { approved: true, approvedBy: "fixture-owner", approvedAt: "2030-01-02T03:04:05.000Z" },
  publicDocuments: fixtureDocuments,
  enterpriseUsagePolicy: {
    ownerApproved: false,
    version: null,
    publicUrl: null,
    contentSha256: null,
    versionMarker: null,
    usageRule: { mode: null, monthlyCallHardCap: null, monthlyMinuteHardCap: null },
  },
};

const enterpriseUnresolved = evaluateCustomerPolicyApproval(version, baseFixtureManifest);
assert.equal(enterpriseUnresolved.coreReady, true, "complete core policy fixture should be internally valid");
assert.equal(enterpriseUnresolved.enterpriseUsageReady, false, "unresolved Enterprise usage must remain blocked");
assert.equal(enterpriseUnresolved.ready, false, "overall first-dollar readiness remains closed while Enterprise is publicly offered");
assert.equal(enterpriseUnresolved.enterpriseBlockers.some((item) => item.code === "enterprise_usage_policy_mode_missing"), true);

const coreCalls = [];
const corePublication = await verifyPublishedCustomerPolicyDocumentsForPlan(
  version,
  "starter",
  baseFixtureManifest,
  async (url) => {
    coreCalls.push(url);
    return {
      ok: true,
      status: 200,
      headers: { get: (header) => header.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null },
      arrayBuffer: async () => policyBody(url.split("/").at(-1)),
    };
  },
);
assert.equal(corePublication.ok, true, "Starter/Pro policy publication must not be blocked by unresolved Enterprise caps");
assert.equal(coreCalls.length, 6, "Starter/Pro verify exactly the six core policy documents");
const unresolvedEnterprisePublication = await verifyPublishedCustomerPolicyDocumentsForPlan(
  version,
  "enterprise",
  baseFixtureManifest,
  async () => { throw new Error("must-not-fetch"); },
);
assert.equal(unresolvedEnterprisePublication.ok, false, "Enterprise publication must remain blocked until its usage approval and runtime caps match");

const unsafeUrlManifest = structuredClone(baseFixtureManifest);
unsafeUrlManifest.publicDocuments.privacy.url = "https://attacker.example.net/privacy";
const unsafeUrl = evaluateCustomerPolicyApproval(version, unsafeUrlManifest);
assert.equal(unsafeUrl.coreReady, false, "untrusted policy origins must fail closed");
assert.equal(unsafeUrl.coreBlockers.some((item) => item.code === "customer_policy_privacy_url_missing"), true);

const completeFixtureManifest = structuredClone(baseFixtureManifest);
const enterpriseBody = policyBody("enterpriseUsagePolicy");
completeFixtureManifest.enterpriseUsagePolicy = {
  ownerApproved: true,
  version,
  publicUrl: "https://smirkcalls.com/policy-fixture/enterprise-usage",
  contentSha256: digest(enterpriseBody),
  versionMarker: `SMIRK-POLICY:enterpriseUsagePolicy:${version}`,
  usageRule: {
    mode: "hard_cap",
    monthlyCallHardCap: 10_000,
    monthlyMinuteHardCap: 25_000,
  },
};
const fixtureRuntimeEnterpriseLimits = { enabled: true, calls: 10_000, minutes: 25_000, agents: 25 };
const mismatch = evaluateCustomerPolicyApproval("different-version", completeFixtureManifest, fixtureRuntimeEnterpriseLimits);
assert.equal(mismatch.ready, false, "environment and checked-in manifest versions must match exactly");
assert.equal(mismatch.coreBlockers.some((item) => item.code === "customer_policy_env_version_mismatch"), true);

const runtimeUnbound = evaluateCustomerPolicyApproval(version, completeFixtureManifest);
assert.equal(runtimeUnbound.enterpriseUsageReady, false, "synthetic Enterprise approval cannot override disabled production PLAN_LIMITS");
assert.equal(runtimeUnbound.enterpriseBlockers.some((item) => item.code === "enterprise_usage_policy_runtime_limits_mismatch"), true);

const complete = evaluateCustomerPolicyApproval(version, completeFixtureManifest, fixtureRuntimeEnterpriseLimits);
assert.equal(complete.ready, true, "a fully populated synthetic fixture proves the guard can open after real approval work");
assert.equal(complete.enterpriseUsageReady, true);

const liveCalls = [];
const live = await verifyPublishedCustomerPolicyDocuments(version, completeFixtureManifest, async (url, init) => {
  liveCalls.push({ url, init });
  const name = url.endsWith("/enterprise-usage") ? "enterpriseUsagePolicy" : url.split("/").at(-1);
  const body = policyBody(name);
  return {
    ok: true,
    status: 200,
    headers: { get: (header) => header.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null },
    arrayBuffer: async () => body,
  };
}, fixtureRuntimeEnterpriseLimits);
assert.equal(live.ok, true);
assert.equal(liveCalls.length, 7, "all six core documents and Enterprise usage policy must be verified");
assert.equal(liveCalls.every((call) => call.init.redirect === "error" && call.init.signal instanceof AbortSignal), true);

const failedLive = await verifyPublishedCustomerPolicyDocuments(version, completeFixtureManifest, async () => ({
  ok: false,
  status: 404,
  headers: { get: () => "text/html" },
  arrayBuffer: async () => Buffer.alloc(0),
}), fixtureRuntimeEnterpriseLimits);
assert.equal(failedLive.ok, false, "missing published policy documents must fail live verification");

const responseFor = (body) => ({
  ok: true,
  status: 200,
  headers: { get: (header) => header.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null },
  arrayBuffer: async () => body,
});
const bodyless = await verifyPublishedCustomerPolicyDocuments(
  version,
  completeFixtureManifest,
  async () => responseFor(Buffer.alloc(0)),
  fixtureRuntimeEnterpriseLimits,
);
assert.equal(bodyless.ok, false, "a bodyless 2xx response must not count as policy publication");
assert.equal(bodyless.failures.some((failure) => failure.includes("empty document")), true);

const genericSpaBody = Buffer.from("<!doctype html><div id=app>SMIRK dashboard</div>", "utf8");
const genericSpa = await verifyPublishedCustomerPolicyDocuments(
  version,
  completeFixtureManifest,
  async () => responseFor(genericSpaBody),
  fixtureRuntimeEnterpriseLimits,
);
assert.equal(genericSpa.ok, false, "a generic 2xx SPA index must not count as an approved policy document");
assert.equal(genericSpa.failures.every((failure) => failure.includes("SHA-256")), true);

const reusedBody = policyBody("terms");
const reused = await verifyPublishedCustomerPolicyDocuments(
  version,
  completeFixtureManifest,
  async () => responseFor(reusedBody),
  fixtureRuntimeEnterpriseLimits,
);
assert.equal(reused.ok, false, "one valid policy body reused at seven URLs must fail exact document binding");

const wrongDigestManifest = structuredClone(completeFixtureManifest);
wrongDigestManifest.publicDocuments.privacy.contentSha256 = "0".repeat(64);
const wrongDigest = await verifyPublishedCustomerPolicyDocuments(
  version,
  wrongDigestManifest,
  async (url) => responseFor(policyBody(url.split("/").at(-1))),
  fixtureRuntimeEnterpriseLimits,
);
assert.equal(wrongDigest.ok, false, "a checked-in digest that does not match the published bytes must fail");

const duplicateUrlManifest = structuredClone(completeFixtureManifest);
duplicateUrlManifest.publicDocuments.privacy.url = duplicateUrlManifest.publicDocuments.terms.url;
const duplicateUrls = evaluateCustomerPolicyApproval(version, duplicateUrlManifest, fixtureRuntimeEnterpriseLimits);
assert.equal(duplicateUrls.ready, false, "the seven policy publications must use seven unique trusted URLs");
assert.equal(duplicateUrls.coreBlockers.some((item) => item.code === "customer_policy_publication_urls_not_unique"), true);

console.log("OK policy publication binds seven unique URLs to exact bytes/markers and Enterprise hard caps to runtime enforcement");
