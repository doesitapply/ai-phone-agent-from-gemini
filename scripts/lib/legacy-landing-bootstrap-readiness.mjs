export const AUTHORITATIVE_LANDING_ORIGIN = 'https://smirkcalls.com';
export const LEGACY_LANDING_READINESS_KEYS = Object.freeze([
  'checkoutReady',
  'planCount',
]);

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
