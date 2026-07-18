const COMMIT_RE = /^[a-f0-9]{40}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const NONCE_RE = /^[a-f0-9]{24}$/;

export function pendingActivationUploadMessage({ commit, digest, nonce }) {
  const normalizedCommit = String(commit || "").trim().toLowerCase();
  const normalizedDigest = String(digest || "").trim().toLowerCase();
  const normalizedNonce = String(nonce || "").trim().toLowerCase();
  if (!COMMIT_RE.test(normalizedCommit) || !DIGEST_RE.test(normalizedDigest) || !NONCE_RE.test(normalizedNonce)) {
    throw new Error("pending activation upload binding requires an exact commit, digest, and 96-bit nonce");
  }
  return `smirk-first-dollar-activation:${normalizedCommit}:${normalizedDigest}:${normalizedNonce}`;
}

export function deploymentMatchesPendingActivation({ deployment, baseline, target }) {
  const id = String(deployment?.id || "").trim();
  const baselineIds = new Set(Array.isArray(baseline?.baselineDeploymentIds)
    ? baseline.baselineDeploymentIds.map((value) => String(value || "").trim()).filter(Boolean)
    : []);
  const uploadMessage = String(baseline?.uploadMessage || "").trim();
  const deploymentMessage = String(deployment?.meta?.commitMessage || deployment?.meta?.message || "").trim();
  const capturedAtMs = Date.parse(String(baseline?.capturedAt || ""));
  const createdAtMs = Date.parse(String(deployment?.createdAt || ""));
  return Boolean(
    id
    && !baselineIds.has(id)
    && uploadMessage
    && deploymentMessage === uploadMessage
    && Number.isFinite(capturedAtMs)
    && Number.isFinite(createdAtMs)
    && createdAtMs >= capturedAtMs - 10_000
    && (!deployment?.serviceId || deployment.serviceId === target?.serviceId)
    && (!deployment?.environmentId || deployment.environmentId === target?.environmentId)
  );
}
