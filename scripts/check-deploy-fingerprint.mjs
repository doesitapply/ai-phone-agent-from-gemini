#!/usr/bin/env node
const target = process.env.APP_URL || "https://ai-phone-agent-production-6811.up.railway.app";
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

  const version = parsed?.version || versionHeader || null;
  const branch = parsed?.branch || branchHeader || null;

  if (expectedBranch && branch !== expectedBranch) fail({ status: res.status, readinessHeader, versionHeader, branchHeader, expectedBranch, actualBranch: branch, failure: "branch-mismatch" });
  if (expectedVersion && version !== expectedVersion) fail({ status: res.status, readinessHeader, versionHeader, branchHeader, expectedVersion, actualVersion: version, failure: "version-mismatch" });

  console.log(JSON.stringify({ ok: true, url, status: res.status, readinessHeader, versionHeader, branchHeader, version, branch, appStatus: parsed?.status || null }, null, 2));
  if (!res.ok) process.exit(1);
};

main().catch((error) => fail({ failure: "request-error", message: error instanceof Error ? error.message : String(error) }));
