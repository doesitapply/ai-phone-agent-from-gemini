import { createHash } from "node:crypto";
import { PLAN_LIMITS } from "./plan-limits.js";

const TRUSTED_POLICY_ORIGINS = new Set([
  "https://ai-phone-agent-production-6811.up.railway.app",
  "https://smirkcalls.com",
  "https://www.smirkcalls.com",
]);

export const REQUIRED_CUSTOMER_POLICY_DOCUMENTS = Object.freeze([
  "terms",
  "privacy",
  "cancellationRefund",
  "billingManagement",
  "support",
  "dataConsent",
]);

export const CUSTOMER_POLICY_TAX_MODES = Object.freeze([
  "stripe_automatic_tax",
  "stripe_automatic_tax_disabled",
]);
export const CUSTOMER_POLICY_CANCELLATION_MODES = Object.freeze([
  "at_period_end",
  "immediately",
]);
export const CUSTOMER_POLICY_CANCELLATION_PRORATION_BEHAVIORS = Object.freeze([
  "none",
  "create_prorations",
]);

export function customerPolicyAutomaticTaxEnabled(taxMode) {
  if (taxMode === "stripe_automatic_tax") return true;
  if (taxMode === "stripe_automatic_tax_disabled") return false;
  return null;
}

// Deliberately not approved. This file is the checked-in owner-approval record,
// not a substitute for legal review or a place for code to invent policy terms.
// A regex-shaped environment value must never turn recurring charges on by itself.
export const CUSTOMER_POLICY_APPROVAL_MANIFEST = Object.freeze({
  manifestSchemaVersion: 2,
  approvalState: "not_approved",
  policyVersion: null,
  ownerApproval: Object.freeze({
    approved: false,
    approvedBy: null,
    approvedAt: null,
  }),
  billingPolicy: Object.freeze({
    taxMode: null,
    cancellationMode: null,
    cancellationProrationBehavior: null,
  }),
  starterUsagePolicy: Object.freeze({
    ownerApproved: false,
    usageRule: Object.freeze({
      mode: null,
      monthlyCallHardCap: null,
      monthlyMinuteHardCap: null,
    }),
  }),
  publicDocuments: Object.freeze({
    terms: Object.freeze({ version: null, url: null, contentSha256: null, versionMarker: null }),
    privacy: Object.freeze({ version: null, url: null, contentSha256: null, versionMarker: null }),
    cancellationRefund: Object.freeze({ version: null, url: null, contentSha256: null, versionMarker: null }),
    billingManagement: Object.freeze({ version: null, url: null, contentSha256: null, versionMarker: null }),
    support: Object.freeze({ version: null, url: null, contentSha256: null, versionMarker: null }),
    dataConsent: Object.freeze({ version: null, url: null, contentSha256: null, versionMarker: null }),
  }),
  enterpriseUsagePolicy: Object.freeze({
    ownerApproved: false,
    version: null,
    publicUrl: null,
    contentSha256: null,
    versionMarker: null,
    usageRule: Object.freeze({
      mode: null,
      monthlyCallHardCap: null,
      monthlyMinuteHardCap: null,
    }),
  }),
});

const validVersion = (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(String(value || "").trim());
const validSha256 = (value) => /^[a-f0-9]{64}$/.test(String(value || "").trim());
const validVersionMarker = (value, version, documentName) => {
  const marker = String(value || "").trim();
  return marker.length >= 12
    && marker.length <= 240
    && marker.includes(String(version || "").trim())
    && marker.includes(documentName);
};
const validHardCap = (value) => Number.isSafeInteger(value) && value > 0;

const normalizePolicyUrl = (value) => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > 2_048 || /[\u0000-\u0020\u007f]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash
      || url.pathname === "/"
      || !TRUSTED_POLICY_ORIGINS.has(url.origin)
    ) return null;
    return url.href;
  } catch {
    return null;
  }
};

const blocker = (code, message, area = "customer_policy") => ({ code, message, area });

export function evaluateCustomerPolicyApproval(
  configuredVersion,
  manifest = CUSTOMER_POLICY_APPROVAL_MANIFEST,
  runtimeEnterpriseLimits = PLAN_LIMITS.enterprise,
) {
  const coreBlockers = [];
  const enterpriseBlockers = [];
  const envVersion = String(configuredVersion || "").trim();
  const manifestVersion = String(manifest?.policyVersion || "").trim();
  const taxMode = String(manifest?.billingPolicy?.taxMode || "").trim();
  const cancellationMode = String(manifest?.billingPolicy?.cancellationMode || "").trim();
  const cancellationProrationBehavior = String(manifest?.billingPolicy?.cancellationProrationBehavior || "").trim();
  const starterUsageRule = manifest?.starterUsagePolicy?.usageRule;

  if (manifest?.approvalState !== "approved" || manifest?.ownerApproval?.approved !== true) {
    coreBlockers.push(blocker(
      "customer_policy_owner_approval_missing",
      "Recurring checkout is blocked until the business owner approves the customer policy manifest.",
    ));
  }
  if (!validVersion(manifestVersion)) {
    coreBlockers.push(blocker(
      "customer_policy_manifest_version_missing",
      "The checked-in customer policy manifest does not contain an approved version.",
    ));
  }
  if (!validVersion(envVersion) || envVersion !== manifestVersion) {
    coreBlockers.push(blocker(
      "customer_policy_env_version_mismatch",
      "SMIRK_CUSTOMER_POLICY_APPROVED_VERSION must exactly match the checked-in owner-approved manifest version.",
    ));
  }
  if (!String(manifest?.ownerApproval?.approvedBy || "").trim()) {
    coreBlockers.push(blocker(
      "customer_policy_approver_missing",
      "The checked-in policy manifest does not identify the approving business owner.",
    ));
  }
  const approvedAt = Date.parse(String(manifest?.ownerApproval?.approvedAt || ""));
  if (!Number.isFinite(approvedAt)) {
    coreBlockers.push(blocker(
      "customer_policy_approval_time_missing",
      "The checked-in policy manifest does not record a valid owner-approval timestamp.",
    ));
  }
  if (!CUSTOMER_POLICY_TAX_MODES.includes(taxMode)) {
    coreBlockers.push(blocker(
      "customer_policy_tax_mode_missing",
      "The checked-in owner approval must explicitly choose whether Stripe Automatic Tax is enabled for recurring checkout.",
    ));
  }
  if (!CUSTOMER_POLICY_CANCELLATION_MODES.includes(cancellationMode)) {
    coreBlockers.push(blocker(
      "customer_policy_cancellation_mode_missing",
      "The checked-in owner approval must explicitly choose immediate or end-of-period subscription cancellation.",
    ));
  }
  if (!CUSTOMER_POLICY_CANCELLATION_PRORATION_BEHAVIORS.includes(cancellationProrationBehavior)) {
    coreBlockers.push(blocker(
      "customer_policy_cancellation_proration_missing",
      "The checked-in owner approval must explicitly choose the Stripe cancellation proration behavior.",
    ));
  }
  if (manifest?.starterUsagePolicy?.ownerApproved !== true) {
    coreBlockers.push(blocker(
      "starter_usage_policy_owner_approval_missing",
      "Starter checkout is blocked until the owner explicitly approves the disclosed hard-stop usage policy.",
      "starter_usage_policy",
    ));
  }
  if (starterUsageRule?.mode !== "hard_cap") {
    coreBlockers.push(blocker(
      "starter_usage_policy_mode_missing",
      "The first-dollar Starter usage rule must be the machine-readable hard_cap mode; code must not infer an overage price or different public promise.",
      "starter_usage_policy",
    ));
  }
  if (
    !validHardCap(starterUsageRule?.monthlyCallHardCap)
    || !validHardCap(starterUsageRule?.monthlyMinuteHardCap)
  ) {
    coreBlockers.push(blocker(
      "starter_usage_policy_hard_caps_invalid",
      "Starter hard caps must be explicit positive integers for monthly calls and monthly minutes.",
      "starter_usage_policy",
    ));
  }
  if (
    PLAN_LIMITS.starter?.enabled !== true
    || starterUsageRule?.mode !== "hard_cap"
    || PLAN_LIMITS.starter?.calls !== starterUsageRule?.monthlyCallHardCap
    || PLAN_LIMITS.starter?.minutes !== starterUsageRule?.monthlyMinuteHardCap
  ) {
    coreBlockers.push(blocker(
      "starter_usage_policy_runtime_limits_mismatch",
      "Starter checkout stays blocked until the owner-approved hard caps exactly match the enabled runtime PLAN_LIMITS enforcement values.",
      "starter_usage_policy",
    ));
  }

  const documentUrls = {};
  const documentDigests = {};
  const documentMarkers = {};
  for (const documentName of REQUIRED_CUSTOMER_POLICY_DOCUMENTS) {
    const document = manifest?.publicDocuments?.[documentName];
    const safeUrl = normalizePolicyUrl(document?.url);
    documentUrls[documentName] = safeUrl;
    documentDigests[documentName] = String(document?.contentSha256 || "").trim();
    documentMarkers[documentName] = String(document?.versionMarker || "").trim();
    if (!safeUrl) {
      coreBlockers.push(blocker(
        `customer_policy_${documentName}_url_missing`,
        `The owner-approved ${documentName} policy needs a stable public HTTPS URL on a trusted SMIRK origin.`,
      ));
    }
    if (!manifestVersion || String(document?.version || "").trim() !== manifestVersion) {
      coreBlockers.push(blocker(
        `customer_policy_${documentName}_version_mismatch`,
        `The ${documentName} policy version must exactly match the approved manifest version.`,
      ));
    }
    if (!validSha256(document?.contentSha256)) {
      coreBlockers.push(blocker(
        `customer_policy_${documentName}_digest_missing`,
        `The ${documentName} policy needs the checked-in SHA-256 digest of the exact owner-approved bytes.`,
      ));
    }
    if (!validVersionMarker(document?.versionMarker, manifestVersion, documentName)) {
      coreBlockers.push(blocker(
        `customer_policy_${documentName}_marker_missing`,
        `The ${documentName} policy needs a unique embedded marker containing its document name and approved version.`,
      ));
    }
  }

  const enterprisePolicyUrl = normalizePolicyUrl(manifest?.enterpriseUsagePolicy?.publicUrl);
  const enterprisePolicyDigest = String(manifest?.enterpriseUsagePolicy?.contentSha256 || "").trim();
  const enterprisePolicyMarker = String(manifest?.enterpriseUsagePolicy?.versionMarker || "").trim();
  if (manifest?.enterpriseUsagePolicy?.ownerApproved !== true) {
    enterpriseBlockers.push(blocker(
      "enterprise_usage_policy_owner_approval_missing",
      "Enterprise checkout is blocked until the owner approves a disclosed usage cap, overage rule, or other explicit usage policy.",
      "enterprise_usage_policy",
    ));
  }
  const usageRule = manifest?.enterpriseUsagePolicy?.usageRule;
  if (usageRule?.mode !== "hard_cap") {
    enterpriseBlockers.push(blocker(
      "enterprise_usage_policy_mode_missing",
      "The Enterprise usage mode is unresolved. It must be the machine-readable hard_cap mode; code must not infer unlimited usage or an overage price.",
      "enterprise_usage_policy",
    ));
  }
  if (
    !validHardCap(usageRule?.monthlyCallHardCap)
    || !validHardCap(usageRule?.monthlyMinuteHardCap)
  ) {
    enterpriseBlockers.push(blocker(
      "enterprise_usage_policy_hard_caps_invalid",
      "Enterprise hard caps must be explicit positive integers for monthly calls and monthly minutes.",
      "enterprise_usage_policy",
    ));
  }
  if (!manifestVersion || String(manifest?.enterpriseUsagePolicy?.version || "").trim() !== manifestVersion) {
    enterpriseBlockers.push(blocker(
      "enterprise_usage_policy_version_mismatch",
      "The Enterprise usage policy version must exactly match the owner-approved customer policy version.",
      "enterprise_usage_policy",
    ));
  }
  if (!enterprisePolicyUrl) {
    enterpriseBlockers.push(blocker(
      "enterprise_usage_policy_url_missing",
      "The approved Enterprise usage policy needs a stable public HTTPS URL on a trusted SMIRK origin.",
      "enterprise_usage_policy",
    ));
  }
  if (!validSha256(enterprisePolicyDigest)) {
    enterpriseBlockers.push(blocker(
      "enterprise_usage_policy_digest_missing",
      "The Enterprise usage policy needs the checked-in SHA-256 digest of the exact owner-approved bytes.",
      "enterprise_usage_policy",
    ));
  }
  if (!validVersionMarker(enterprisePolicyMarker, manifestVersion, "enterpriseUsagePolicy")) {
    enterpriseBlockers.push(blocker(
      "enterprise_usage_policy_marker_missing",
      "The Enterprise usage policy needs a unique embedded marker containing its document name and approved version.",
      "enterprise_usage_policy",
    ));
  }

  const coreUrls = Object.values(documentUrls).filter(Boolean);
  if (new Set(coreUrls).size !== coreUrls.length) {
    coreBlockers.push(blocker(
      "customer_policy_publication_urls_not_unique",
      "Each core approved policy document must have its own unique trusted public URL.",
    ));
  }
  const coreDigests = Object.values(documentDigests).filter(validSha256);
  if (new Set(coreDigests).size !== coreDigests.length) {
    coreBlockers.push(blocker(
      "customer_policy_publication_digests_not_unique",
      "Each approved policy document must bind distinct owner-approved content; a reused generic page is not acceptable.",
    ));
  }
  const coreMarkers = Object.values(documentMarkers).filter(Boolean);
  if (new Set(coreMarkers).size !== coreMarkers.length) {
    coreBlockers.push(blocker(
      "customer_policy_publication_markers_not_unique",
      "Each approved policy document must contain its own unique document/version marker.",
    ));
  }
  if (enterprisePolicyUrl && coreUrls.includes(enterprisePolicyUrl)) {
    enterpriseBlockers.push(blocker(
      "enterprise_usage_policy_url_not_unique",
      "The Enterprise usage policy needs its own unique trusted public URL.",
      "enterprise_usage_policy",
    ));
  }
  if (validSha256(enterprisePolicyDigest) && coreDigests.includes(enterprisePolicyDigest)) {
    enterpriseBlockers.push(blocker(
      "enterprise_usage_policy_digest_not_unique",
      "The Enterprise usage policy must bind distinct owner-approved content, not reuse a core policy page.",
      "enterprise_usage_policy",
    ));
  }
  if (enterprisePolicyMarker && coreMarkers.includes(enterprisePolicyMarker)) {
    enterpriseBlockers.push(blocker(
      "enterprise_usage_policy_marker_not_unique",
      "The Enterprise usage policy needs its own unique document/version marker.",
      "enterprise_usage_policy",
    ));
  }

  if (
    runtimeEnterpriseLimits?.enabled !== true
    || usageRule?.mode !== "hard_cap"
    || runtimeEnterpriseLimits?.calls !== usageRule?.monthlyCallHardCap
    || runtimeEnterpriseLimits?.minutes !== usageRule?.monthlyMinuteHardCap
  ) {
    enterpriseBlockers.push(blocker(
      "enterprise_usage_policy_runtime_limits_mismatch",
      "Enterprise checkout stays disabled until the owner-approved hard caps exactly match the enabled runtime PLAN_LIMITS enforcement values.",
      "enterprise_usage_policy",
    ));
  }

  const coreReady = coreBlockers.length === 0;
  const enterpriseUsageReady = enterpriseBlockers.length === 0;
  return {
    ready: coreReady && enterpriseUsageReady,
    coreReady,
    enterpriseUsageReady,
    manifestApprovalState: String(manifest?.approvalState || "not_approved"),
    versionMatches: Boolean(validVersion(envVersion) && envVersion === manifestVersion),
    billingPolicy: {
      taxMode: CUSTOMER_POLICY_TAX_MODES.includes(taxMode) ? taxMode : null,
      automaticTaxEnabled: customerPolicyAutomaticTaxEnabled(taxMode),
      cancellationMode: CUSTOMER_POLICY_CANCELLATION_MODES.includes(cancellationMode) ? cancellationMode : null,
      cancellationProrationBehavior: CUSTOMER_POLICY_CANCELLATION_PRORATION_BEHAVIORS.includes(cancellationProrationBehavior)
        ? cancellationProrationBehavior
        : null,
    },
    starterUsagePolicy: {
      ownerApproved: manifest?.starterUsagePolicy?.ownerApproved === true,
      mode: starterUsageRule?.mode === "hard_cap" ? "hard_cap" : null,
      monthlyCallHardCap: validHardCap(starterUsageRule?.monthlyCallHardCap)
        ? starterUsageRule.monthlyCallHardCap
        : null,
      monthlyMinuteHardCap: validHardCap(starterUsageRule?.monthlyMinuteHardCap)
        ? starterUsageRule.monthlyMinuteHardCap
        : null,
    },
    documentUrls,
    documentDigests,
    documentMarkers,
    enterprisePolicyUrl,
    enterprisePolicyDigest,
    enterprisePolicyMarker,
    coreBlockers,
    enterpriseBlockers,
    blockers: [...coreBlockers, ...enterpriseBlockers],
  };
}

export async function verifyPublishedCustomerPolicyDocuments(
  configuredVersion,
  manifest = CUSTOMER_POLICY_APPROVAL_MANIFEST,
  fetchImpl = globalThis.fetch,
  runtimeEnterpriseLimits = PLAN_LIMITS.enterprise,
  options = {},
) {
  const evaluation = evaluateCustomerPolicyApproval(configuredVersion, manifest, runtimeEnterpriseLimits);
  const requestedPlan = String(options?.plan || "").trim().toLowerCase();
  const includeEnterprise = requestedPlan === "enterprise"
    || requestedPlan === "agency"
    || (!requestedPlan && options?.scope !== "core");
  const approvalReady = includeEnterprise ? evaluation.ready : evaluation.coreReady;
  if (!approvalReady) return { ok: false, evaluation, failures: ["owner-approval-manifest-not-ready"] };
  const entries = Object.entries(evaluation.documentUrls).map(([name, url]) => ({
      name,
      url,
      digest: evaluation.documentDigests[name],
      marker: evaluation.documentMarkers[name],
    }));
  if (includeEnterprise) entries.push({
      name: "enterpriseUsagePolicy",
      url: evaluation.enterprisePolicyUrl,
      digest: evaluation.enterprisePolicyDigest,
      marker: evaluation.enterprisePolicyMarker,
    });
  const verifiedDigests = new Set();
  const results = await Promise.all(entries.map(async ({ name, url, digest, marker }) => {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { Accept: "text/html,application/pdf,text/plain" },
      });
      const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
      if (!response.ok || !/(?:text\/html|text\/plain|application\/pdf)/.test(contentType)) {
        return `${name}: public policy returned ${response.status || "unknown"} or a non-document content type`;
      }
      const declaredLength = Number(response.headers?.get?.("content-length") || 0);
      if (Number.isFinite(declaredLength) && declaredLength > 2_000_000) {
        return `${name}: public policy document exceeds the 2 MB verification limit`;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) return `${name}: public policy returned an empty document`;
      if (bytes.byteLength > 2_000_000) return `${name}: public policy document exceeds the 2 MB verification limit`;
      const actualDigest = createHash("sha256").update(bytes).digest("hex");
      if (actualDigest !== digest) return `${name}: public policy bytes do not match the checked-in owner-approved SHA-256 digest`;
      const decoded = new TextDecoder().decode(bytes);
      if (!decoded.includes(marker)) return `${name}: public policy is missing its exact embedded document/version marker`;
      if (verifiedDigests.has(actualDigest)) return `${name}: public policy reuses another approved document body`;
      verifiedDigests.add(actualDigest);
      return null;
    } catch {
      return `${name}: public policy URL could not be verified without redirects`;
    }
  }));
  const failures = results.filter(Boolean);
  return { ok: failures.length === 0, evaluation, failures, scope: includeEnterprise ? "enterprise" : "core" };
}

export function customerPolicyReadyForPlan(evaluation, plan) {
  const normalizedPlan = String(plan || "").trim().toLowerCase();
  return evaluation?.coreReady === true
    && ((normalizedPlan !== "enterprise" && normalizedPlan !== "agency") || evaluation?.enterpriseUsageReady === true);
}

export function verifyPublishedCustomerPolicyDocumentsForPlan(
  configuredVersion,
  plan,
  manifest = CUSTOMER_POLICY_APPROVAL_MANIFEST,
  fetchImpl = globalThis.fetch,
  runtimeEnterpriseLimits = PLAN_LIMITS.enterprise,
) {
  return verifyPublishedCustomerPolicyDocuments(
    configuredVersion,
    manifest,
    fetchImpl,
    runtimeEnterpriseLimits,
    { plan, scope: String(plan || "").toLowerCase() === "enterprise" ? "enterprise" : "core" },
  );
}
