#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

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
    expectedText: ["30-day market validation", "Missed-call recovery"],
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
  const missingFiles = (manifest.public_screenshots || [])
    .filter((asset) => !asset.ok || !existsSync(path.resolve(asset.absolute_path || path.join(outputDir, asset.file))));
  if (missingFiles.length > 0) {
    fail("launch public screenshot assets are incomplete", { missingFiles });
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
    publicScreenshotCount: manifest.public_screenshots?.length || 0,
    productHuntSubmissionReady: manifest.submission_readiness?.product_hunt_submission_ready === true,
  }, null, 2));
  process.exit(0);
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
      missing_expected_text: missingExpectedText,
      use: asset.use,
      error,
    });
  }
} finally {
  await browser.close();
}

const publicFailures = results.filter((asset) => !asset.ok);
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
  generated_at: new Date().toISOString(),
  source_base_url: baseUrl,
  output_dir: outputDir,
  public_screenshots: results,
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
  productHuntSubmissionReady: false,
  blockers,
}, null, 2));

if (!manifest.ok) process.exit(1);
