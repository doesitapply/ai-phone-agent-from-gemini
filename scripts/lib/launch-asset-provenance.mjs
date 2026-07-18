import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const LAUNCH_ASSET_MANIFEST_SCHEMA_VERSION = 3;
export const DEFAULT_LAUNCH_ASSET_MAX_AGE_HOURS = 168;

const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const DEFAULT_FILE_CAPTURE_TOLERANCE_MINUTES = 20;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parseDate(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

function finitePositive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function push(failures, condition, code, message, detail = {}) {
  if (!condition) failures.push({ code, message, ...detail });
}

export function sha256LaunchAssetFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function resolveIntendedLaunchDeployment({
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const version = String(env.SMIRK_LAUNCH_ASSET_EXPECT_VERSION || git(["rev-parse", "HEAD"], cwd)).trim();
  const branch = String(env.SMIRK_LAUNCH_ASSET_EXPECT_BRANCH || git(["branch", "--show-current"], cwd) || "main").trim();
  const deployedAt = String(
    env.SMIRK_LAUNCH_ASSET_INTENDED_DEPLOYED_AT
      || git(["show", "-s", "--format=%cI", version], cwd),
  ).trim();
  const deployedAtMs = parseDate(deployedAt);

  if (!COMMIT_PATTERN.test(version)) {
    throw new Error("intended launch deployment version must be an exact 40-character Git commit");
  }
  if (!branch || branch === "unknown") {
    throw new Error("intended launch deployment branch must be explicit");
  }
  if (deployedAtMs == null) {
    throw new Error("intended launch deployment timestamp must be a valid date");
  }

  return {
    branch,
    version,
    deployed_at: new Date(deployedAtMs).toISOString(),
    deployedAtMs,
  };
}

export async function fetchLaunchDeploymentFingerprint(baseUrl, {
  env = process.env,
  now = () => new Date(),
} = {}) {
  let healthUrl;
  try {
    const parsed = new URL(baseUrl);
    healthUrl = new URL("/health", parsed.origin).toString();
  } catch {
    throw new Error(`launch asset base URL is invalid: ${JSON.stringify(baseUrl)}`);
  }

  const timeoutMs = finitePositive(env.SMIRK_LAUNCH_ASSET_HEALTH_TIMEOUT_MS, 15_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(healthUrl, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const contentType = String(response.headers.get("content-type") || "");
  const readinessHeader = String(response.headers.get("x-smirk-readiness") || "");
  const versionHeader = String(response.headers.get("x-smirk-version") || "").trim();
  const branchHeader = String(response.headers.get("x-smirk-branch") || "").trim();
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error("launch asset source /health response is not valid JSON");
  }

  const version = String(body?.version || versionHeader || "").trim();
  const branch = String(body?.branch || branchHeader || "").trim();
  if (!response.ok) throw new Error(`launch asset source /health returned HTTP ${response.status}`);
  if (readinessHeader !== "1") throw new Error("launch asset source /health is missing x-smirk-readiness=1");
  if (!contentType.includes("application/json")) throw new Error("launch asset source /health is not application/json");
  if (body?.version && versionHeader && body.version !== versionHeader) {
    throw new Error("launch asset source version header/body mismatch");
  }
  if (body?.branch && branchHeader && body.branch !== branchHeader) {
    throw new Error("launch asset source branch header/body mismatch");
  }
  if (!COMMIT_PATTERN.test(version)) {
    throw new Error("launch asset source version is not an exact 40-character Git commit");
  }
  if (!branch || branch === "unknown") {
    throw new Error("launch asset source branch is missing or unknown");
  }

  return {
    branch,
    version,
    health_url: healthUrl,
    verified_at: now().toISOString(),
  };
}

export function compareLaunchDeployment(source, intended) {
  const failures = [];
  push(
    failures,
    source?.version === intended?.version,
    "source-version-mismatch",
    "launch asset source version does not match the intended/current deployment",
    { expected: intended?.version || null, actual: source?.version || null },
  );
  push(
    failures,
    source?.branch === intended?.branch,
    "source-branch-mismatch",
    "launch asset source branch does not match the intended/current deployment",
    { expected: intended?.branch || null, actual: source?.branch || null },
  );
  return { ok: failures.length === 0, failures };
}

export async function verifyLaunchManifestCurrent(manifest, intended, options = {}) {
  const failures = [];
  const baseUrl = String(manifest?.source_base_url || "").trim();
  if (!baseUrl) {
    return {
      ok: false,
      liveDeployment: null,
      failures: [{ code: "manifest-source-url-missing", message: "launch asset manifest source URL is missing" }],
    };
  }

  let liveDeployment;
  try {
    liveDeployment = await fetchLaunchDeploymentFingerprint(baseUrl, options);
  } catch (error) {
    return {
      ok: false,
      liveDeployment: null,
      failures: [{
        code: "current-deployment-unverified",
        message: "could not verify the current launch asset source deployment",
        detail: error?.message || String(error),
      }],
    };
  }

  failures.push(...compareLaunchDeployment(liveDeployment, intended).failures);
  push(failures, liveDeployment.version === manifest?.live_version, "current-version-manifest-mismatch", "current live version no longer matches the launch asset manifest", {
    expected: manifest?.live_version || null,
    actual: liveDeployment.version,
  });
  push(failures, liveDeployment.branch === manifest?.live_branch, "current-branch-manifest-mismatch", "current live branch no longer matches the launch asset manifest", {
    expected: manifest?.live_branch || null,
    actual: liveDeployment.branch,
  });

  return { ok: failures.length === 0, liveDeployment, failures };
}

export function buildLaunchCaptureProvenance(source, intended, capturedAt = new Date().toISOString()) {
  return {
    captured_at: capturedAt,
    source_branch: source.branch,
    source_version: source.version,
    source_health_url: source.health_url,
    source_health_verified_at: source.verified_at,
    intended_deployed_at: intended.deployed_at,
  };
}

export function launchAssetFreshnessOptions(env = process.env) {
  const maxAgeHours = finitePositive(
    env.SMIRK_LAUNCH_ASSET_MAX_AGE_HOURS,
    DEFAULT_LAUNCH_ASSET_MAX_AGE_HOURS,
  );
  const fileCaptureToleranceMinutes = finitePositive(
    env.SMIRK_LAUNCH_ASSET_FILE_CAPTURE_TOLERANCE_MINUTES,
    DEFAULT_FILE_CAPTURE_TOLERANCE_MINUTES,
  );
  const nowText = String(env.SMIRK_LAUNCH_ASSET_NOW || "").trim();
  const nowMs = nowText ? parseDate(nowText) : Date.now();
  if (nowMs == null) throw new Error("SMIRK_LAUNCH_ASSET_NOW must be a valid date when set");
  return { maxAgeHours, fileCaptureToleranceMinutes, nowMs };
}

export function validateLaunchCaptureStage({
  manifest,
  stage,
  intended,
  artifacts = [],
  requiredArtifactIds = [],
  dependencies = [],
  env = process.env,
}) {
  const failures = [];
  const options = launchAssetFreshnessOptions(env);
  const record = manifest?.capture_provenance?.[stage];
  const capturedAtMs = parseDate(record?.captured_at);
  const healthVerifiedAtMs = parseDate(record?.source_health_verified_at);
  const recordedIntendedDeployedAtMs = parseDate(record?.intended_deployed_at);
  const expectedDeployedAtMs = intended?.deployedAtMs ?? parseDate(intended?.deployed_at);
  const maxAgeMs = options.maxAgeHours * 60 * 60 * 1000;
  const fileToleranceMs = options.fileCaptureToleranceMinutes * 60 * 1000;

  push(
    failures,
    manifest?.manifest_schema_version === LAUNCH_ASSET_MANIFEST_SCHEMA_VERSION,
    "manifest-schema-not-version-bound",
    `launch asset manifest must use schema ${LAUNCH_ASSET_MANIFEST_SCHEMA_VERSION}`,
    { actual: manifest?.manifest_schema_version ?? null },
  );
  push(failures, record && typeof record === "object", "capture-provenance-missing", `${stage} capture is not version-bound`);
  push(failures, COMMIT_PATTERN.test(String(record?.source_version || "")), "capture-source-version-invalid", `${stage} capture source version must be an exact Git commit`);
  push(failures, Boolean(record?.source_branch) && record?.source_branch !== "unknown", "capture-source-branch-invalid", `${stage} capture source branch must be explicit`);
  push(failures, capturedAtMs != null, "capture-timestamp-invalid", `${stage} capture timestamp is missing or invalid`);
  push(failures, /^https?:\/\/[^\s]+\/health$/.test(String(record?.source_health_url || "")), "capture-health-source-invalid", `${stage} capture health source is missing or invalid`);
  push(failures, healthVerifiedAtMs != null, "capture-health-verification-time-invalid", `${stage} capture health verification timestamp is missing or invalid`);
  push(failures, recordedIntendedDeployedAtMs != null && recordedIntendedDeployedAtMs === expectedDeployedAtMs, "capture-intended-deployment-time-mismatch", `${stage} capture is not bound to the intended deployment timestamp`);
  push(failures, record?.source_version === intended?.version, "capture-version-mismatch", `${stage} capture does not match the intended/current deployment version`, {
    expected: intended?.version || null,
    actual: record?.source_version || null,
  });
  push(failures, record?.source_branch === intended?.branch, "capture-branch-mismatch", `${stage} capture does not match the intended/current deployment branch`, {
    expected: intended?.branch || null,
    actual: record?.source_branch || null,
  });
  push(failures, manifest?.live_version === intended?.version, "manifest-live-version-mismatch", "manifest live version does not match the intended/current deployment", {
    expected: intended?.version || null,
    actual: manifest?.live_version || null,
  });
  push(failures, manifest?.live_branch === intended?.branch, "manifest-live-branch-mismatch", "manifest live branch does not match the intended/current deployment", {
    expected: intended?.branch || null,
    actual: manifest?.live_branch || null,
  });
  push(failures, manifest?.source_deployment?.version === intended?.version, "manifest-source-version-mismatch", "manifest source deployment version is missing or stale");
  push(failures, manifest?.source_deployment?.branch === intended?.branch, "manifest-source-branch-mismatch", "manifest source deployment branch is missing or stale");

  if (capturedAtMs != null && expectedDeployedAtMs != null) {
    push(failures, capturedAtMs >= expectedDeployedAtMs, "capture-predates-deployment", `${stage} capture predates the intended/current deployment`, {
      capturedAt: record.captured_at,
      intendedDeployedAt: intended.deployed_at,
    });
    push(failures, capturedAtMs <= options.nowMs + FUTURE_TOLERANCE_MS, "capture-timestamp-in-future", `${stage} capture timestamp is implausibly in the future`);
    push(failures, options.nowMs - capturedAtMs <= maxAgeMs, "capture-stale", `${stage} capture is older than the allowed freshness window`, {
      capturedAt: record.captured_at,
      maxAgeHours: options.maxAgeHours,
    });
    if (healthVerifiedAtMs != null) {
      push(failures, healthVerifiedAtMs >= expectedDeployedAtMs, "capture-health-verification-predates-deployment", `${stage} live fingerprint verification predates the intended/current deployment`);
      push(failures, healthVerifiedAtMs <= capturedAtMs + FUTURE_TOLERANCE_MS, "capture-health-verification-after-capture", `${stage} live fingerprint verification is later than its capture timestamp`);
    }
    if (stage === "public") {
      push(failures, parseDate(manifest?.captured_at) === capturedAtMs, "manifest-capture-time-mismatch", "manifest capture timestamp does not match the public capture provenance");
    }
  }

  if (requiredArtifactIds.length > 0) {
    const actualIds = artifacts.map((artifact) => artifact.id);
    for (const requiredId of requiredArtifactIds) {
      push(failures, actualIds.filter((id) => id === requiredId).length === 1, "capture-required-artifact-missing", `${stage} capture must contain exactly one ${requiredId} artifact`, { requiredId });
    }
    push(failures, artifacts.length === requiredArtifactIds.length, "capture-artifact-set-mismatch", `${stage} capture artifact set does not match the required set`, {
      expectedIds: requiredArtifactIds,
      actualIds,
    });
  }

  for (const dependency of dependencies) {
    const dependencyRecord = manifest?.capture_provenance?.[dependency];
    const dependencyCapturedAtMs = parseDate(dependencyRecord?.captured_at);
    push(failures, Boolean(dependencyRecord), "capture-dependency-missing", `${stage} capture is missing ${dependency} provenance`, { dependency });
    push(failures, dependencyRecord?.source_version === record?.source_version, "capture-dependency-version-mismatch", `${stage} and ${dependency} captures are not bound to the same version`, { dependency });
    push(failures, dependencyRecord?.source_branch === record?.source_branch, "capture-dependency-branch-mismatch", `${stage} and ${dependency} captures are not bound to the same branch`, { dependency });
    if (capturedAtMs != null && dependencyCapturedAtMs != null) {
      push(failures, capturedAtMs >= dependencyCapturedAtMs, "capture-predates-dependency", `${stage} capture predates its ${dependency} source assets`, { dependency });
    }
  }

  for (const artifact of artifacts) {
    const file = path.resolve(artifact.file || "");
    const exists = Boolean(artifact.file) && existsSync(file);
    const stat = exists ? statSync(file) : null;
    const minBytes = Number(artifact.minBytes || 1);
    const metadata = artifact.metadata;
    const expectedSha256 = String(artifact.sha256 || metadata?.sha256 || "").trim().toLowerCase();
    push(failures, exists, "capture-artifact-missing", `${stage} artifact is missing`, { id: artifact.id, file });
    push(failures, exists && stat.size >= minBytes, "capture-artifact-too-small", `${stage} artifact is incomplete`, {
      id: artifact.id,
      file,
      expectedMinBytes: minBytes,
      actualBytes: stat?.size ?? 0,
    });
    if (stat && capturedAtMs != null && expectedDeployedAtMs != null) {
      push(failures, stat.mtimeMs >= expectedDeployedAtMs, "capture-artifact-predates-deployment", `${stage} artifact file predates the intended/current deployment`, { id: artifact.id, file });
      push(failures, options.nowMs - stat.mtimeMs <= maxAgeMs, "capture-artifact-stale", `${stage} artifact file is older than the allowed freshness window`, { id: artifact.id, file, maxAgeHours: options.maxAgeHours });
      push(failures, stat.mtimeMs <= options.nowMs + FUTURE_TOLERANCE_MS, "capture-artifact-in-future", `${stage} artifact file timestamp is implausibly in the future`, { id: artifact.id, file });
      push(failures, Math.abs(stat.mtimeMs - capturedAtMs) <= fileToleranceMs, "capture-artifact-timestamp-mismatch", `${stage} artifact file does not match its recorded capture time`, {
        id: artifact.id,
        file,
        capturedAt: record.captured_at,
        fileModifiedAt: stat.mtime.toISOString(),
        toleranceMinutes: options.fileCaptureToleranceMinutes,
      });
    }

    push(
      failures,
      SHA256_PATTERN.test(expectedSha256),
      "capture-artifact-sha256-invalid",
      `${stage} artifact is not bound to a valid SHA-256 digest`,
      { id: artifact.id, file, recordedSha256: expectedSha256 || null },
    );
    if (exists && SHA256_PATTERN.test(expectedSha256)) {
      let actualSha256 = null;
      try {
        actualSha256 = sha256LaunchAssetFile(file);
      } catch (error) {
        failures.push({
          code: "capture-artifact-sha256-read-failed",
          message: `${stage} artifact could not be hashed`,
          id: artifact.id,
          file,
          detail: error?.message || String(error),
        });
      }
      if (actualSha256) {
        push(
          failures,
          actualSha256 === expectedSha256,
          "capture-artifact-sha256-mismatch",
          `${stage} artifact bytes do not match the capture manifest`,
          { id: artifact.id, file, expectedSha256, actualSha256 },
        );
      }
    }

    if (metadata) {
      push(failures, metadata.ok === true, "capture-artifact-not-ok", `${stage} artifact is not marked ok`, { id: artifact.id });
      push(failures, metadata.source_version === record?.source_version, "capture-artifact-version-unbound", `${stage} artifact metadata is not bound to its source version`, { id: artifact.id });
      push(failures, metadata.source_branch === record?.source_branch, "capture-artifact-branch-unbound", `${stage} artifact metadata is not bound to its source branch`, { id: artifact.id });
      push(failures, metadata.captured_at === record?.captured_at, "capture-artifact-time-unbound", `${stage} artifact metadata is not bound to its capture timestamp`, { id: artifact.id });
    }
  }

  return {
    ok: failures.length === 0,
    stage,
    expectedDeployment: {
      branch: intended?.branch || null,
      version: intended?.version || null,
      deployedAt: intended?.deployed_at || null,
    },
    recordedCapture: record || null,
    maxAgeHours: options.maxAgeHours,
    failures,
  };
}
