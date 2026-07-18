#!/usr/bin/env node
import {
  AUTHORITATIVE_PRODUCTION_APP_URL,
  AUTHORITATIVE_PRODUCTION_ORIGINS,
} from './lib/deploy-change-set.mjs';

const requestedTarget = process.env.SMIRK_DEPLOY_FINGERPRINT_APP_URL || AUTHORITATIVE_PRODUCTION_APP_URL;
let parsedTarget;
try {
  parsedTarget = new URL(requestedTarget);
} catch {
  console.error(JSON.stringify({
    ok: false,
    failure: 'invalid-production-origin',
    message: 'Deploy fingerprints must be read from an allowlisted production HTTPS origin.',
    requestedTarget,
  }, null, 2));
  process.exit(1);
}
if (
  parsedTarget.protocol !== 'https:'
  || parsedTarget.username
  || parsedTarget.password
  || !['', '/'].includes(parsedTarget.pathname)
  || parsedTarget.search
  || parsedTarget.hash
  || !AUTHORITATIVE_PRODUCTION_ORIGINS.includes(parsedTarget.origin)
) {
  console.error(JSON.stringify({
    ok: false,
    failure: 'untrusted-production-origin',
    message: 'Deploy fingerprints must be read from an allowlisted production HTTPS origin.',
    requestedTarget,
    allowedOrigins: AUTHORITATIVE_PRODUCTION_ORIGINS,
  }, null, 2));
  process.exit(1);
}
const target = parsedTarget.origin;
const expectedBranch = process.env.SMIRK_EXPECT_BRANCH || "";
const expectedVersion = process.env.SMIRK_EXPECT_VERSION || "";
const url = `${target.replace(/\/$/, "")}/health`;
const fetchTimeoutMs = Number(process.env.SMIRK_DEPLOY_FINGERPRINT_FETCH_TIMEOUT_MS || 15_000);
const fetchAttempts = Number(process.env.SMIRK_DEPLOY_FINGERPRINT_FETCH_ATTEMPTS || 2);
const fetchRetryDelayMs = Number(process.env.SMIRK_DEPLOY_FINGERPRINT_FETCH_RETRY_DELAY_MS || 750);

const fail = (payload) => {
  console.error(JSON.stringify({ ok: false, url, ...payload }, null, 2));
  process.exit(1);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeFetchError(error) {
  if (error?.name === "AbortError") {
    return `Timed out after ${fetchTimeoutMs}ms`;
  }
  return error?.message || String(error);
}

async function fetchHealth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    return await fetch(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchHealthWithRetry() {
  let lastError = null;
  for (let attempt = 1; attempt <= fetchAttempts; attempt += 1) {
    try {
      return { res: await fetchHealth(), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < fetchAttempts) {
        await sleep(fetchRetryDelayMs);
      }
    }
  }

  return {
    error: lastError,
    attempts: fetchAttempts,
    detail: normalizeFetchError(lastError),
  };
}

const main = async () => {
  const fetched = await fetchHealthWithRetry();
  if (!fetched.res) {
    fail({
      failure: "deploy-fingerprint-fetch-failed",
      message: "Could not verify live deploy fingerprint after bounded retries.",
      attempts: fetched.attempts,
      detail: fetched.detail,
    });
  }

  const { res } = fetched;
  const contentType = res.headers.get("content-type") || "";
  const readinessHeader = res.headers.get("x-smirk-readiness") || "";
  const versionHeader = res.headers.get("x-smirk-version") || "";
  const branchHeader = res.headers.get("x-smirk-branch") || "";
  const body = await res.text();

  if (readinessHeader !== "1") fail({ status: res.status, contentType, readinessHeader, versionHeader, branchHeader, failure: "missing-readiness-header", sample: body.slice(0, 160) });
  if (!contentType.includes("application/json")) fail({ status: res.status, contentType, readinessHeader, versionHeader, branchHeader, failure: "non-json-response", sample: body.slice(0, 160) });

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    fail({ status: res.status, contentType, readinessHeader, versionHeader, branchHeader, failure: "invalid-json", sample: body.slice(0, 160) });
  }

  const parsedVersion = parsed?.version || null;
  const parsedBranch = parsed?.branch || null;
  const version = parsedVersion || versionHeader || null;
  const branch = parsedBranch || branchHeader || null;

  if (!res.ok) fail({
    status: res.status,
    readinessHeader,
    versionHeader,
    branchHeader,
    actualVersion: version,
    actualBranch: branch,
    failure: "non-success-status",
  });
  if (parsedVersion && versionHeader && parsedVersion !== versionHeader) fail({
    status: res.status,
    readinessHeader,
    versionHeader,
    branchHeader,
    actualVersion: parsedVersion,
    failure: "version-header-body-mismatch",
  });
  if (parsedBranch && branchHeader && parsedBranch !== branchHeader) fail({
    status: res.status,
    readinessHeader,
    versionHeader,
    branchHeader,
    actualBranch: parsedBranch,
    failure: "branch-header-body-mismatch",
  });

  if (expectedBranch && branch !== expectedBranch) fail({ status: res.status, readinessHeader, versionHeader, branchHeader, expectedBranch, actualBranch: branch, actualVersion: version, failure: "branch-mismatch" });
  if (expectedVersion && version !== expectedVersion) fail({ status: res.status, readinessHeader, versionHeader, branchHeader, expectedVersion, actualVersion: version, failure: "version-mismatch" });

  console.log(JSON.stringify({ ok: true, url, status: res.status, readinessHeader, versionHeader, branchHeader, version, branch, appStatus: parsed?.status || null }, null, 2));
};

main().catch((error) => fail({ failure: "request-error", message: error instanceof Error ? error.message : String(error) }));
