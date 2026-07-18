#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import {
  LAUNCH_ASSET_MANIFEST_SCHEMA_VERSION,
  buildLaunchCaptureProvenance,
  compareLaunchDeployment,
  fetchLaunchDeploymentFingerprint,
  resolveIntendedLaunchDeployment,
  sha256LaunchAssetFile,
  validateLaunchCaptureStage,
  verifyLaunchManifestCurrent,
} from "./lib/launch-asset-provenance.mjs";

const args = new Set(process.argv.slice(2));
const checkExisting = args.has("--check-existing");
const requireSubmissionReady = args.has("--require-submission-ready");
const baseUrl = String(process.env.SMIRK_LAUNCH_ASSET_BASE_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const outputDir = path.resolve(process.env.SMIRK_LAUNCH_ASSET_OUTPUT_DIR || "output/playwright/launch-assets");
const manifestPath = path.join(outputDir, "manifest.json");
const markdownPath = path.join(outputDir, "manifest.md");

const publicScreenshots = [
  {
    id: "launch-page",
    path: "/launch",
    file: "01-launch-page.png",
    expectedText: ["Buyer-facing proof loop", "callback-ready job record"],
    use: "Product Hunt hero/gallery, paid test landing proof, G2/Capterra public surface",
  },
  {
    id: "pricing-page",
    path: "/pricing",
    file: "02-pricing-page.png",
    expectedText: ["Starter", "$197"],
    use: "Pricing proof for Product Hunt, G2, Capterra, and paid ads",
  },
  {
    id: "plumbing-industry-page",
    path: "/industries/plumbing",
    file: "03-plumbing-industry-page.png",
    expectedText: ["plumbing", "missed"],
    use: "Trade-specific gallery asset for the first home-services wedge",
  },
  {
    id: "hvac-industry-page",
    path: "/industries/hvac",
    file: "04-hvac-industry-page.png",
    expectedText: ["HVAC", "missed"],
    use: "Trade-specific gallery asset for urgent phone-demand positioning",
  },
  {
    id: "compare-page",
    path: "/compare",
    file: "05-compare-page.png",
    expectedText: ["missed-call recovery", "receptionist"],
    use: "Competitor-positioning asset showing the narrow wedge",
  },
];

const protectedRequiredAssets = [
  {
    id: "redacted-proof-dashboard",
    status: "missing_requires_authenticated_redacted_capture",
    requiredFor: ["Product Hunt", "G2", "Capterra", "retargeting"],
    nextAction: "Capture the dashboard proof view only after caller details are removed or masked.",
  },
  {
    id: "redacted-callback-task-queue",
    status: "missing_requires_authenticated_redacted_capture",
    requiredFor: ["Product Hunt", "G2", "Capterra", "retargeting"],
    nextAction: "Capture the callback task queue only after caller details are removed or masked.",
  },
  {
    id: "short-proof-walkthrough",
    status: "missing_requires_current_review",
    requiredFor: ["Product Hunt", "paid creative", "sales proof walkthroughs"],
    nextAction: "Record or approve a current short walkthrough showing call record, summary, owner alert, callback task, and dashboard proof.",
  },
];

function fail(message, detail = {}) {
  console.error(JSON.stringify({ ok: false, message, detail }, null, 2));
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail("could not read launch asset manifest", { file, error: error?.message || String(error) });
  }
}

function intendedDeployment() {
  try {
    return resolveIntendedLaunchDeployment();
  } catch (error) {
    fail("could not resolve intended/current launch deployment", {
      error: error?.message || String(error),
    });
  }
}

function findExistingDemoCandidates() {
  const dir = path.resolve("output/playwright");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => /smirk.*(?:masked|narrated|proof).*\.mp4$/i.test(file))
    .sort()
    .map((file) => path.join(dir, file));
}

function renderMarkdown(manifest) {
  const lines = [
    "# SMIRK Launch Asset Manifest",
    "",
    `Generated: ${manifest.generated_at}`,
    `Captured: ${manifest.captured_at}`,
    `Live branch: ${manifest.live_branch}`,
    `Live version: ${manifest.live_version}`,
    `Base URL: ${manifest.source_base_url}`,
    `Submission ready: ${manifest.submission_readiness.product_hunt_submission_ready ? "yes" : "no"}`,
    "",
    "## Public Screenshots",
    "",
    ...manifest.public_screenshots.map((asset) => `- ${asset.id}: ${asset.ok ? "ok" : "fail"} - ${asset.file} (${asset.use})`),
    "",
    "## Missing Gated Assets",
    "",
    ...manifest.protected_required_assets.map((asset) => `- ${asset.id}: ${asset.status}. ${asset.nextAction}`),
    "",
    "## Submission Blockers",
    "",
    ...manifest.submission_readiness.blockers.map((blocker) => `- ${blocker}`),
    "",
    "## Notes",
    "",
    "- Public screenshots are safe to use as long as they match current production behavior.",
    "- Protected dashboard screenshots must be redacted before submission.",
    "- Do not claim fully automated SaaS until the paid activation proof gate passes.",
  ];
  return `${lines.join("\n")}\n`;
}

if (checkExisting) {
  if (!existsSync(manifestPath)) {
    fail("launch asset manifest is missing", {
      manifestPath,
      nextAction: "Run npm run capture:launch-assets against a local or production base URL.",
    });
  }
  const manifest = readJson(manifestPath);
  const intended = intendedDeployment();
  const currentDeployment = await verifyLaunchManifestCurrent(manifest, intended);
  if (!currentDeployment.ok) {
    fail("launch asset manifest does not match the current deployment", {
      manifestPath,
      ...currentDeployment,
    });
  }
  const existingPublicScreenshots = manifest.public_screenshots || [];
  const missingFiles = existingPublicScreenshots
    .filter((asset) => !asset.ok || !existsSync(path.resolve(asset.absolute_path || path.join(outputDir, asset.file))));
  if (missingFiles.length > 0) {
    fail("launch public screenshot assets are incomplete", { missingFiles });
  }
  const provenance = validateLaunchCaptureStage({
    manifest,
    stage: "public",
    intended,
    requiredArtifactIds: publicScreenshots.map((asset) => asset.id),
    artifacts: existingPublicScreenshots.map((asset) => ({
      id: asset.id,
      file: path.resolve(asset.absolute_path || path.join(outputDir, asset.file || "")),
      minBytes: 20001,
      metadata: asset,
    })),
  });
  if (!provenance.ok) {
    fail("launch public screenshot provenance is stale or invalid", {
      manifestPath,
      ...provenance,
    });
  }
  if (requireSubmissionReady && manifest.submission_readiness?.product_hunt_submission_ready !== true) {
    fail("launch assets are not submission-ready", {
      blockers: manifest.submission_readiness?.blockers || [],
      manifestPath,
    });
  }
  console.log(JSON.stringify({
    ok: true,
    manifestPath,
    publicScreenshotCount: existingPublicScreenshots.length,
    liveBranch: manifest.live_branch,
    liveVersion: manifest.live_version,
    capturedAt: manifest.capture_provenance.public.captured_at,
    productHuntSubmissionReady: manifest.submission_readiness?.product_hunt_submission_ready === true,
  }, null, 2));
  process.exit(0);
}

const intended = intendedDeployment();
let liveDeployment;
try {
  liveDeployment = await fetchLaunchDeploymentFingerprint(baseUrl);
} catch (error) {
  fail("could not verify the launch asset source deployment", {
    baseUrl,
    error: error?.message || String(error),
  });
}
const liveMatch = compareLaunchDeployment(liveDeployment, intended);
if (!liveMatch.ok) {
  fail("launch asset source is not the intended/current deployment", {
    baseUrl,
    intendedDeployment: intended,
    liveDeployment,
    failures: liveMatch.failures,
  });
}

mkdirSync(outputDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
const results = [];

try {
  for (const asset of publicScreenshots) {
    const url = `${baseUrl}${asset.path}`;
    const absolutePath = path.join(outputDir, asset.file);
    let responseStatus = null;
    let title = "";
    let bodyText = "";
    let error = null;

    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      responseStatus = response?.status() || null;
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      title = await page.title().catch(() => "");
      bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      await page.screenshot({ path: absolutePath, fullPage: true });
    } catch (captureError) {
      error = captureError?.message || String(captureError);
    }

    const sizeBytes = existsSync(absolutePath) ? statSync(absolutePath).size : 0;
    const normalizedText = bodyText.toLowerCase();
    const missingExpectedText = asset.expectedText.filter((needle) => !normalizedText.includes(String(needle).toLowerCase()));
    const ok = !error && responseStatus != null && responseStatus >= 200 && responseStatus < 400 && sizeBytes > 20000 && bodyText.trim().length > 200 && missingExpectedText.length === 0;

    results.push({
      id: asset.id,
      ok,
      url,
      path: asset.path,
      file: asset.file,
      absolute_path: absolutePath,
      response_status: responseStatus,
      title,
      body_text_length: bodyText.trim().length,
      size_bytes: sizeBytes,
      sha256: existsSync(absolutePath) ? sha256LaunchAssetFile(absolutePath) : null,
      missing_expected_text: missingExpectedText,
      use: asset.use,
      error,
    });
  }
} finally {
  await browser.close();
}

const capturedAt = new Date().toISOString();
const publicCaptureProvenance = buildLaunchCaptureProvenance(liveDeployment, intended, capturedAt);
const boundResults = results.map((asset) => ({
  ...asset,
  captured_at: capturedAt,
  source_branch: liveDeployment.branch,
  source_version: liveDeployment.version,
}));
const publicFailures = boundResults.filter((asset) => !asset.ok);
const demoCandidates = findExistingDemoCandidates();
const blockers = [
  ...publicFailures.map((asset) => `Public screenshot failed: ${asset.id}`),
  "Redacted dashboard proof screenshot is not captured in this public workflow.",
  "Redacted callback task queue screenshot is not captured in this public workflow.",
  "Current short proof walkthrough/demo clip still needs review before launch.",
  "Self-serve paid activation proof must pass before claiming fully automated SaaS.",
];

const manifest = {
  ok: publicFailures.length === 0,
  manifest_schema_version: LAUNCH_ASSET_MANIFEST_SCHEMA_VERSION,
  generated_at: capturedAt,
  updated_at: capturedAt,
  captured_at: capturedAt,
  live_branch: liveDeployment.branch,
  live_version: liveDeployment.version,
  source_deployment: {
    branch: liveDeployment.branch,
    version: liveDeployment.version,
    health_url: liveDeployment.health_url,
    verified_at: liveDeployment.verified_at,
    intended_deployed_at: intended.deployed_at,
  },
  capture_provenance: {
    public: publicCaptureProvenance,
  },
  source_base_url: baseUrl,
  output_dir: outputDir,
  public_screenshots: boundResults,
  protected_required_assets: protectedRequiredAssets,
  demo_candidates: demoCandidates.map((file) => ({
    file,
    status: "candidate_existing_needs_current_review",
  })),
  submission_readiness: {
    product_hunt_submission_ready: false,
    g2_capterra_submission_ready: false,
    paid_creative_ready: false,
    blockers,
  },
};

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(markdownPath, renderMarkdown(manifest));

console.log(JSON.stringify({
  ok: manifest.ok,
  manifestPath,
  markdownPath,
  publicScreenshotCount: results.length,
  failedPublicScreenshots: publicFailures.map((asset) => asset.id),
  liveBranch: manifest.live_branch,
  liveVersion: manifest.live_version,
  capturedAt,
  productHuntSubmissionReady: false,
  blockers,
}, null, 2));

if (!manifest.ok) process.exit(1);
