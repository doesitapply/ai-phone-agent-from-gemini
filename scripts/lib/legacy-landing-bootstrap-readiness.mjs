export const AUTHORITATIVE_LANDING_ORIGIN = 'https://smirkcalls.com';
export const AUTHORITATIVE_RAILWAY_SOURCE_REPO = 'doesitapply/ai-phone-agent-from-gemini';
export const LEGACY_LANDING_READINESS_KEYS = Object.freeze([
  'checkoutReady',
  'planCount',
]);
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const DEPLOYMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pushFailure(failures, condition, message) {
  if (!condition) failures.push(message);
}

export function evaluateLegacyLandingBootstrapReadiness({
  origin,
  status,
  contentType,
  payload,
}) {
  const failures = [];
  const normalizedOrigin = String(origin || '').trim().replace(/\/+$/, '');
  const normalizedContentType = String(contentType || '').trim().toLowerCase();
  const payloadIsPlainObject = isPlainObject(payload);
  const payloadKeys = payloadIsPlainObject ? Object.keys(payload).sort() : [];
  const expectedKeys = [...LEGACY_LANDING_READINESS_KEYS].sort();

  pushFailure(
    failures,
    normalizedOrigin === AUTHORITATIVE_LANDING_ORIGIN,
    `origin must equal ${AUTHORITATIVE_LANDING_ORIGIN}`,
  );
  pushFailure(failures, Number(status) === 200, 'readiness response must be HTTP 200');
  pushFailure(failures, normalizedContentType.includes('application/json'), 'readiness response must be JSON');
  pushFailure(failures, payloadIsPlainObject, 'readiness payload must be a plain object');
  pushFailure(
    failures,
    JSON.stringify(payloadKeys) === JSON.stringify(expectedKeys),
    'readiness payload must match the exact legacy checkout-only field set',
  );
  pushFailure(failures, payload?.checkoutReady === true, 'legacy checkoutReady must equal true');
  pushFailure(failures, payload?.planCount === 3, 'legacy planCount must equal 3');

  return {
    ok: failures.length === 0,
    mode: 'exact-legacy-landing-readiness-bootstrap',
    origin: normalizedOrigin || null,
    status: Number.isFinite(Number(status)) ? Number(status) : null,
    payloadKeys,
    failures,
  };
}

export function evaluateExactAutoDeployedBootstrap({
  deployment,
  liveCheck,
  currentCommit,
  targetBranch,
  target,
  targetMatches,
}) {
  const failures = [];
  const normalizedCommit = String(currentCommit || '').trim();
  const normalizedBranch = String(targetBranch || '').trim();
  const deploymentMeta = deployment?.meta && typeof deployment.meta === 'object'
    ? deployment.meta
    : {};
  const liveDetail = liveCheck?.detail;

  pushFailure(failures, targetMatches === true, 'Railway project, service, and environment must match the pinned production target');
  pushFailure(failures, COMMIT_PATTERN.test(normalizedCommit), 'current commit must be an exact 40-character Git SHA');
  pushFailure(failures, normalizedBranch.length > 0, 'target branch must be explicit');
  pushFailure(failures, DEPLOYMENT_ID_PATTERN.test(String(deployment?.id || '')), 'latest Railway deployment ID must be a UUID');
  pushFailure(failures, deployment?.status === 'SUCCESS', 'latest Railway production deployment must be successful');
  pushFailure(failures, deployment?.serviceId === target?.serviceId, 'latest deployment must belong to the pinned production service');
  pushFailure(failures, deployment?.environmentId === target?.environmentId, 'latest deployment must belong to the pinned production environment');
  pushFailure(failures, Number.isFinite(Date.parse(String(deployment?.createdAt || ''))), 'latest deployment must have a valid creation timestamp');
  pushFailure(failures, deploymentMeta.commitHash === normalizedCommit, 'latest deployment source commit must match current HEAD');
  pushFailure(failures, deploymentMeta.branch === 'main', 'latest deployment must come from the configured main source branch');
  pushFailure(failures, deploymentMeta.repo === AUTHORITATIVE_RAILWAY_SOURCE_REPO, 'latest deployment must come from the authoritative repository');
  pushFailure(failures, deploymentMeta.reason === 'deploy', 'latest deployment must be a source deploy');
  pushFailure(failures, deploymentMeta.buildOnly === false, 'latest deployment must not be build-only');

  pushFailure(failures, liveCheck?.ok === false, 'live fingerprint must still be stale');
  pushFailure(failures, liveCheck?.blocker === 'stale-production-deploy', 'live fingerprint sole blocker must be stale production');
  pushFailure(failures, liveCheck?.expectedVersion === normalizedCommit, 'live check expected version must match current HEAD');
  pushFailure(failures, liveCheck?.expectedBranch === normalizedBranch, 'live check expected branch must match the deploy target');
  pushFailure(failures, COMMIT_PATTERN.test(String(liveCheck?.actualVersion || '')), 'live process must expose a valid prior fingerprint');
  pushFailure(failures, liveCheck?.actualVersion !== normalizedCommit, 'live process fingerprint must not already match current HEAD');
  pushFailure(failures, Number(liveCheck?.liveStatus) === 200, 'live process must remain healthy');
  pushFailure(failures, liveCheck?.liveReadinessHeader === '1', 'live process must expose the readiness header');
  pushFailure(failures, liveDetail?.status === 200, 'live fingerprint detail must confirm HTTP 200');
  pushFailure(failures, liveDetail?.readinessHeader === '1', 'live fingerprint detail must confirm readiness');
  pushFailure(failures, liveDetail?.failure === 'version-mismatch', 'live fingerprint mismatch must be version-only');

  return {
    ok: failures.length === 0,
    mode: 'exact-auto-deployed-current-commit-stale-fingerprint',
    deploymentId: deployment?.id || null,
    deploymentCommit: deploymentMeta.commitHash || null,
    liveFingerprint: liveCheck?.actualVersion || null,
    targetCommit: COMMIT_PATTERN.test(normalizedCommit) ? normalizedCommit : null,
    failures,
  };
}
