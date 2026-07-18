import { SMIRK_RAILWAY_PRODUCTION_TARGET } from "./first-dollar-pending-env.mjs";

export const CUSTOMER_POLICY_VERSION_RAILWAY_SOURCE = "railway-production-variables";

const CUSTOMER_POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/;

function publicTarget() {
  return {
    projectId: SMIRK_RAILWAY_PRODUCTION_TARGET.projectId,
    serviceId: SMIRK_RAILWAY_PRODUCTION_TARGET.serviceId,
    environmentId: SMIRK_RAILWAY_PRODUCTION_TARGET.environmentId,
  };
}

export function readCustomerPolicyVersionFromRailway(readVariables) {
  if (typeof readVariables !== "function") {
    throw new TypeError("readVariables must be a function");
  }

  const target = publicTarget();
  try {
    const variables = readVariables(target);
    if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
      throw new Error("Railway variables read returned a non-object result");
    }
    const candidate = String(variables.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION || "").trim();
    const recorded = CUSTOMER_POLICY_VERSION_PATTERN.test(candidate);
    return {
      customerPolicyVersion: recorded ? candidate : null,
      customerPolicyVersionRecorded: recorded,
      customerPolicyVersionReadSucceeded: true,
      customerPolicyVersionSource: CUSTOMER_POLICY_VERSION_RAILWAY_SOURCE,
      customerPolicyVersionTarget: target,
      customerPolicyVersionReadFailure: null,
    };
  } catch {
    return {
      customerPolicyVersion: null,
      customerPolicyVersionRecorded: false,
      customerPolicyVersionReadSucceeded: false,
      customerPolicyVersionSource: null,
      customerPolicyVersionTarget: target,
      customerPolicyVersionReadFailure: "railway-production-variables-read-failed",
    };
  }
}

export function verifiedRailwayCustomerPolicyVersion(bundle = {}) {
  const candidate = String(bundle?.customerPolicyVersion || "").trim();
  const readSucceeded = bundle?.customerPolicyVersionReadSucceeded === true;
  const sourceMatches = bundle?.customerPolicyVersionSource === CUSTOMER_POLICY_VERSION_RAILWAY_SOURCE;
  const targetMatches = Object.entries(publicTarget()).every(
    ([key, value]) => bundle?.customerPolicyVersionTarget?.[key] === value,
  );
  const recorded = bundle?.customerPolicyVersionRecorded === true
    && CUSTOMER_POLICY_VERSION_PATTERN.test(candidate);
  const provenanceVerified = readSucceeded && sourceMatches && targetMatches && recorded;
  return {
    version: provenanceVerified ? candidate : "",
    recorded: provenanceVerified,
    provenanceVerified,
    railwayReadSucceeded: readSucceeded && targetMatches,
    source: readSucceeded && sourceMatches && targetMatches ? CUSTOMER_POLICY_VERSION_RAILWAY_SOURCE : null,
    targetVerified: targetMatches,
  };
}
