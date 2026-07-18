#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LAUNCH_ASSET_MANIFEST_SCHEMA_VERSION,
  buildLaunchCaptureProvenance,
  compareLaunchDeployment,
  fetchLaunchDeploymentFingerprint,
  sha256LaunchAssetFile,
} from "./lib/launch-asset-provenance.mjs";

const repoRoot = process.cwd();
const tempRoot = mkdtempSync(path.join(tmpdir(), "smirk-launch-asset-provenance-"));
const manifestPath = path.join(tempRoot, "manifest.json");
const fetchMockPath = path.join(tempRoot, "fetch-mock.mjs");
const version = "a".repeat(40);
const otherVersion = "b".repeat(40);
const branch = "codex/launch-assets";
const deployedAt = "2026-07-18T16:00:00.000Z";
const publicCapturedAt = "2026-07-18T16:10:00.000Z";
const protectedCapturedAt = "2026-07-18T16:15:00.000Z";
const walkthroughCapturedAt = "2026-07-18T16:20:00.000Z";
const now = "2026-07-18T16:30:00.000Z";

const publicAssetSpecs = [
  ["launch-page", "01-launch-page.png"],
  ["pricing-page", "02-pricing-page.png"],
  ["plumbing-industry-page", "03-plumbing-industry-page.png"],
  ["hvac-industry-page", "04-hvac-industry-page.png"],
  ["compare-page", "05-compare-page.png"],
];
const protectedAssetSpecs = [
  ["redacted-proof-dashboard", "06-redacted-proof-dashboard.png"],
  ["redacted-callback-task-queue", "07-redacted-callback-task-queue.png"],
];
const clipFile = "08-smirk-short-proof-walkthrough.mp4";
const posterFile = "08-smirk-short-proof-walkthrough-poster.png";

writeFileSync(fetchMockPath, `
globalThis.fetch = async () => {
  const version = process.env.SMIRK_LAUNCH_ASSET_TEST_LIVE_VERSION || process.env.SMIRK_LAUNCH_ASSET_EXPECT_VERSION;
  const branch = process.env.SMIRK_LAUNCH_ASSET_TEST_LIVE_BRANCH || process.env.SMIRK_LAUNCH_ASSET_EXPECT_BRANCH;
  return new Response(JSON.stringify({ status: "ok", version, branch }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-smirk-readiness": "1",
      "x-smirk-version": version,
      "x-smirk-branch": branch,
    },
  });
};
`);

function captureRecord(capturedAt) {
  return {
    captured_at: capturedAt,
    source_branch: branch,
    source_version: version,
    source_health_url: "https://smirkcalls.example/health",
    source_health_verified_at: capturedAt,
    intended_deployed_at: deployedAt,
  };
}

function asset(id, file, capturedAt) {
  return {
    id,
    ok: true,
    file,
    absolute_path: path.join(tempRoot, file),
    captured_at: capturedAt,
    source_branch: branch,
    source_version: version,
    sha256: sha256LaunchAssetFile(path.join(tempRoot, file)),
    use: "fixture",
  };
}

function buildManifest() {
  const publicAssets = publicAssetSpecs.map(([id, file]) => asset(id, file, publicCapturedAt));
  const protectedAssets = protectedAssetSpecs.map(([id, file]) => asset(id, file, protectedCapturedAt));
  const demo = {
    ...asset("short-proof-walkthrough", clipFile, walkthroughCapturedAt),
    poster_file: posterFile,
    poster_absolute_path: path.join(tempRoot, posterFile),
    poster_sha256: sha256LaunchAssetFile(path.join(tempRoot, posterFile)),
  };
  return {
    ok: true,
    manifest_schema_version: LAUNCH_ASSET_MANIFEST_SCHEMA_VERSION,
    generated_at: publicCapturedAt,
    updated_at: walkthroughCapturedAt,
    captured_at: publicCapturedAt,
    live_branch: branch,
    live_version: version,
    source_deployment: {
      branch,
      version,
      health_url: "https://smirkcalls.example/health",
      verified_at: publicCapturedAt,
      intended_deployed_at: deployedAt,
    },
    capture_provenance: {
      public: captureRecord(publicCapturedAt),
      protected: captureRecord(protectedCapturedAt),
      walkthrough: captureRecord(walkthroughCapturedAt),
    },
    source_base_url: "https://smirkcalls.example",
    output_dir: tempRoot,
    public_screenshots: publicAssets,
    protected_screenshots: protectedAssets,
    demo_assets: [demo],
    protected_required_assets: [
      { id: "redacted-proof-dashboard", status: "ok_redacted_capture" },
      { id: "redacted-callback-task-queue", status: "ok_redacted_capture" },
      {
        id: "short-proof-walkthrough",
        status: "ok_current_redacted_walkthrough",
        file: clipFile,
        absolute_path: path.join(tempRoot, clipFile),
        poster_file: posterFile,
        poster_absolute_path: path.join(tempRoot, posterFile),
      },
    ],
    submission_readiness: {
      product_hunt_submission_ready: false,
      blockers: ["Self-serve paid activation proof must pass before claiming fully automated SaaS."],
    },
  };
}

function writeSizedFile(file, bytes, modifiedAt, fillByte = 7) {
  writeFileSync(path.join(tempRoot, file), Buffer.alloc(bytes, fillByte));
  const date = new Date(modifiedAt);
  utimesSync(path.join(tempRoot, file), date, date);
}

function resetFiles() {
  for (const [, file] of publicAssetSpecs) writeSizedFile(file, 25_000, publicCapturedAt);
  for (const [, file] of protectedAssetSpecs) writeSizedFile(file, 25_000, protectedCapturedAt);
  writeSizedFile(clipFile, 60_000, walkthroughCapturedAt);
  writeSizedFile(posterFile, 25_000, walkthroughCapturedAt);
}

function writeManifest(manifest) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function runCheck(script, extraEnv = {}) {
  return spawnSync(process.execPath, ["--import", fetchMockPath, script, "--check-existing"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      SMIRK_LAUNCH_ASSET_OUTPUT_DIR: tempRoot,
      SMIRK_LAUNCH_ASSET_EXPECT_BRANCH: branch,
      SMIRK_LAUNCH_ASSET_EXPECT_VERSION: version,
      SMIRK_LAUNCH_ASSET_INTENDED_DEPLOYED_AT: deployedAt,
      SMIRK_LAUNCH_ASSET_NOW: now,
      SMIRK_LAUNCH_ASSET_MAX_AGE_HOURS: "2",
      ...extraEnv,
    },
  });
}

function combinedOutput(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function expectPass(script) {
  const result = runCheck(script);
  assert.equal(result.status, 0, `${script} should pass:\n${combinedOutput(result)}`);
  assert.match(result.stdout, /"ok": true/);
}

function expectFailure(script, pattern, extraEnv = {}) {
  const result = runCheck(script, extraEnv);
  assert.notEqual(result.status, 0, `${script} should fail closed`);
  assert.match(combinedOutput(result), pattern);
}

async function verifyHealthFingerprintBinding() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://smirkcalls.example/health");
    return new Response(JSON.stringify({ status: "ok", version, branch }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-smirk-readiness": "1",
        "x-smirk-version": version,
        "x-smirk-branch": branch,
      },
    });
  };
  try {
    const source = await fetchLaunchDeploymentFingerprint("https://smirkcalls.example", {
      now: () => new Date(publicCapturedAt),
    });
    const intended = {
      branch,
      version,
      deployed_at: deployedAt,
      deployedAtMs: Date.parse(deployedAt),
    };
    assert.deepEqual(compareLaunchDeployment(source, intended), { ok: true, failures: [] });
    const provenance = buildLaunchCaptureProvenance(source, intended, publicCapturedAt);
    assert.equal(provenance.source_branch, branch);
    assert.equal(provenance.source_version, version);
    assert.equal(provenance.captured_at, publicCapturedAt);
    assert.equal(provenance.intended_deployed_at, deployedAt);
    assert.match(provenance.source_health_url, /\/health$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

try {
  const captureSource = readFileSync(path.join(repoRoot, "scripts/capture-launch-assets.mjs"), "utf8");
  const protectedCaptureSource = readFileSync(path.join(repoRoot, "scripts/capture-launch-protected-assets.mjs"), "utf8");
  const walkthroughSource = readFileSync(path.join(repoRoot, "scripts/capture-launch-walkthrough.mjs"), "utf8");
  assert.match(captureSource, /expectedText: \["Buyer-facing proof loop", "callback-ready job record"\]/);
  assert.doesNotMatch(captureSource, /expectedText: \[[^\n]*30-day market validation/i);
  assert.match(captureSource, /sha256: existsSync\(absolutePath\) \? sha256LaunchAssetFile\(absolutePath\)/);
  assert.match(protectedCaptureSource, /sha256: existsSync\(proofPath\) \? sha256LaunchAssetFile\(proofPath\)/);
  assert.match(protectedCaptureSource, /sha256: existsSync\(taskPath\) \? sha256LaunchAssetFile\(taskPath\)/);
  assert.match(walkthroughSource, /sha256: sha256LaunchAssetFile\(clipPath\)/);
  assert.match(walkthroughSource, /poster_sha256: sha256LaunchAssetFile\(posterPath\)/);
  assert.match(walkthroughSource, /Dedicated recovery number/);
  assert.doesNotMatch(walkthroughSource, /Existing-number forwarding|missed or forwarded/i);
  assert.doesNotMatch(protectedCaptureSource, /missed or forwarded/i);
  assert.doesNotMatch(protectedCaptureSource, /<span class="status">Present<\/span>/);
  assert.doesNotMatch(protectedCaptureSource, /while \(safeTasks\.length/);
  assert.match(protectedCaptureSource, /No callback or owner-action tasks returned/);
  assert.match(protectedCaptureSource, /No evidence in snapshot/);
  assert.match(protectedCaptureSource, /Only live matching tasks are shown/);
  await verifyHealthFingerprintBinding();

  resetFiles();
  const valid = buildManifest();
  writeManifest(valid);
  expectPass("scripts/capture-launch-assets.mjs");
  expectPass("scripts/capture-launch-protected-assets.mjs");
  expectPass("scripts/capture-launch-walkthrough.mjs");

  const digestless = structuredClone(valid);
  delete digestless.public_screenshots[0].sha256;
  writeManifest(digestless);
  expectFailure("scripts/capture-launch-assets.mjs", /capture-artifact-sha256-invalid/);

  writeSizedFile(publicAssetSpecs[0][1], 25_000, publicCapturedAt, 8);
  writeManifest(valid);
  expectFailure("scripts/capture-launch-assets.mjs", /capture-artifact-sha256-mismatch/);
  resetFiles();

  writeSizedFile(protectedAssetSpecs[0][1], 25_000, protectedCapturedAt, 8);
  writeManifest(valid);
  expectFailure("scripts/capture-launch-protected-assets.mjs", /capture-artifact-sha256-mismatch/);
  resetFiles();

  writeSizedFile(clipFile, 60_000, walkthroughCapturedAt, 8);
  writeManifest(valid);
  expectFailure("scripts/capture-launch-walkthrough.mjs", /capture-artifact-sha256-mismatch/);
  resetFiles();

  writeSizedFile(posterFile, 25_000, walkthroughCapturedAt, 8);
  writeManifest(valid);
  expectFailure("scripts/capture-launch-walkthrough.mjs", /capture-artifact-sha256-mismatch/);
  resetFiles();

  const legacy = structuredClone(valid);
  delete legacy.manifest_schema_version;
  delete legacy.capture_provenance;
  writeManifest(legacy);
  expectFailure("scripts/capture-launch-assets.mjs", /manifest-schema-not-version-bound|capture-provenance-missing/);

  writeManifest(valid);
  expectFailure("scripts/capture-launch-assets.mjs", /capture-stale|capture-artifact-stale/, {
    SMIRK_LAUNCH_ASSET_NOW: "2026-07-18T20:30:00.000Z",
  });

  expectFailure("scripts/capture-launch-assets.mjs", /capture-predates-deployment|capture-artifact-predates-deployment/, {
    SMIRK_LAUNCH_ASSET_INTENDED_DEPLOYED_AT: "2026-07-18T16:12:00.000Z",
  });

  expectFailure("scripts/capture-launch-assets.mjs", /current-version-manifest-mismatch|capture-version-mismatch|manifest-live-version-mismatch/, {
    SMIRK_LAUNCH_ASSET_EXPECT_VERSION: otherVersion,
  });

  writeSizedFile(publicAssetSpecs[0][1], 25_000, "2026-07-18T15:00:00.000Z");
  expectFailure("scripts/capture-launch-assets.mjs", /capture-artifact-predates-deployment|capture-artifact-timestamp-mismatch/);
  resetFiles();

  const protectedPredatesPublic = structuredClone(valid);
  protectedPredatesPublic.capture_provenance.protected.captured_at = "2026-07-18T16:05:00.000Z";
  for (const assetItem of protectedPredatesPublic.protected_screenshots) {
    assetItem.captured_at = "2026-07-18T16:05:00.000Z";
    const date = new Date(assetItem.captured_at);
    utimesSync(assetItem.absolute_path, date, date);
  }
  writeManifest(protectedPredatesPublic);
  expectFailure("scripts/capture-launch-protected-assets.mjs", /capture-predates-dependency/);
  resetFiles();

  const unboundWalkthrough = structuredClone(valid);
  delete unboundWalkthrough.demo_assets[0].source_version;
  writeManifest(unboundWalkthrough);
  expectFailure("scripts/capture-launch-walkthrough.mjs", /capture-artifact-version-unbound/);

  console.log("OK launch asset provenance fixtures require current buyer copy, exact live branch/version binding, per-file SHA-256 integrity, fresh post-deploy files, and dependency-ordered protected/walkthrough captures");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
