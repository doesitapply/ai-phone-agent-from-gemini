const CANONICAL_STARTER_AMOUNT = 19700;

function linkSummary(link) {
  return {
    id: link.id,
    active: link.active,
    livemode: link.livemode,
    classifiedPlan: link.classifiedPlan,
    lines: link.lines,
  };
}

function isActiveLive(link) {
  return link?.active === true && link?.livemode === true;
}

function isCanonicalStarter197(link) {
  return link?.classifiedPlan === "starter"
    && link?.checks?.canonicalStarterPrice === true;
}

function isLaunchReadyStarter(link) {
  return isActiveLive(link)
    && isCanonicalStarter197(link)
    && link?.checks?.canonicalSuccessRedirect === true
    && link?.checks?.termsAcceptanceRequired === true
    && link?.checks?.phoneCollectionRequired === true
    && link?.checks?.businessNameCollectionRequired === true
    && link?.checks?.policyVersionRecorded === true
    && link?.checks?.productMetadataBound === true
    && link?.checks?.starterMetadataBound === true;
}

export function evaluateFirstDollarPaymentLinkDiscovery({
  described = [],
  configuredUrls = {},
} = {}) {
  const links = Array.isArray(described) ? described : [];
  const normalizedConfiguredUrls = {
    starter: String(configuredUrls?.starter || "").trim() || null,
    pro: String(configuredUrls?.pro || "").trim() || null,
    enterprise: String(configuredUrls?.enterprise || "").trim() || null,
  };
  const configuredBindings = Object.fromEntries(
    Object.entries(normalizedConfiguredUrls).map(([plan, url]) => [
      plan,
      url
        ? links.filter((link) => link.url === url).map(linkSummary)
        : [],
    ]),
  );
  const activeSmirkLinks = links.filter(isActiveLive);
  const activeStarter197Candidates = activeSmirkLinks.filter(isCanonicalStarter197);
  const launchReadyStarterCandidates = activeStarter197Candidates.filter(isLaunchReadyStarter);
  const proposedStarter = launchReadyStarterCandidates.length === 1
    ? launchReadyStarterCandidates[0]
    : null;
  const activeLinksRequiringResolution = activeSmirkLinks.filter(
    (link) => link.id !== proposedStarter?.id,
  );

  const blockers = [];
  if (activeStarter197Candidates.length === 0) {
    blockers.push("no-active-canonical-197-starter-candidate");
  }
  if (activeStarter197Candidates.length > 1) {
    blockers.push("multiple-active-canonical-197-starter-candidates");
  }
  if (launchReadyStarterCandidates.length === 0) {
    blockers.push("no-launch-ready-starter-payment-link");
  }
  if (launchReadyStarterCandidates.length > 1) {
    blockers.push("multiple-launch-ready-starter-payment-links");
  }

  const configuredStarter = configuredBindings.starter;
  if (configuredStarter.length !== 1) {
    blockers.push("configured-starter-url-does-not-map-to-exactly-one-smirk-link");
  } else {
    const configuredLink = links.find((link) => link.id === configuredStarter[0].id);
    if (!isActiveLive(configuredLink) || !isCanonicalStarter197(configuredLink)) {
      blockers.push("configured-starter-url-is-not-active-live-canonical-197-starter");
    }
    if (!isLaunchReadyStarter(configuredLink)) {
      blockers.push("configured-starter-url-is-not-launch-ready");
    }
  }

  if (activeLinksRequiringResolution.length > 0) {
    blockers.push("active-smirk-payment-links-require-resolution");
  }

  return {
    ok: blockers.length === 0,
    configuredUrls: normalizedConfiguredUrls,
    configuredBindings,
    activeSmirkLinks,
    activeStarter197Candidates,
    launchReadyStarterCandidates,
    proposedStarterId: proposedStarter?.id || null,
    activeLinksRequiringResolution,
    blockers: Array.from(new Set(blockers)),
  };
}

export const FIRST_DOLLAR_PAYMENT_LINK_DISCOVERY_CONSTANTS = Object.freeze({
  canonicalStarterAmount: CANONICAL_STARTER_AMOUNT,
});
