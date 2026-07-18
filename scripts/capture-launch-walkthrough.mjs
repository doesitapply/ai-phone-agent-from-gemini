#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import {
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
const outputDir = path.resolve(process.env.SMIRK_LAUNCH_ASSET_OUTPUT_DIR || "output/playwright/launch-assets");
const manifestPath = path.join(outputDir, "manifest.json");
const markdownPath = path.join(outputDir, "manifest.md");
const framesDir = path.join(outputDir, "walkthrough-frames");
const clipFile = "08-smirk-short-proof-walkthrough.mp4";
const posterFile = "08-smirk-short-proof-walkthrough-poster.png";
const clipPath = path.join(outputDir, clipFile);
const posterPath = path.join(outputDir, posterFile);
const requiredArtifactIdsByStage = {
  public: ["launch-page", "pricing-page", "plumbing-industry-page", "hvac-industry-page", "compare-page"],
  protected: ["redacted-proof-dashboard", "redacted-callback-task-queue"],
  walkthrough: ["short-proof-walkthrough", "short-proof-walkthrough-poster"],
};

function fail(message, detail = {}) {
  console.error(JSON.stringify({ ok: false, message, detail }, null, 2));
  process.exit(1);
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

function runQuiet(command, commandArgs, failureMessage) {
  try {
    return execFileSync(command, commandArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    fail(failureMessage, {
      command: [command, ...commandArgs].join(" "),
      output: String(error?.stdout || error?.stderr || error?.message || "").slice(0, 4000),
    });
  }
}

function assertLiveCurrent() {
  runQuiet("npm", ["run", "-s", "check:live-is-current"], "production is not current; walkthrough must match live HEAD");
}

function assertFfmpegAvailable() {
  runQuiet("ffmpeg", ["-version"], "ffmpeg is required to render the launch walkthrough MP4");
}

function readManifest() {
  if (!existsSync(manifestPath)) {
    fail("launch asset manifest is missing", {
      manifestPath,
      nextAction: "Run public and protected launch asset capture before recording the walkthrough.",
    });
  }
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail("could not parse launch asset manifest", { manifestPath, error: String(error?.message || error) });
  }
}

function fileSize(file) {
  return existsSync(file) ? statSync(file).size : 0;
}

function fileOk(file, minBytes = 20000) {
  return fileSize(file) > minBytes;
}

function publicArtifacts(manifest) {
  return (manifest.public_screenshots || []).map((asset) => ({
    id: asset.id,
    file: resolveAssetPath(asset),
    minBytes: 20001,
    metadata: asset,
  }));
}

function protectedArtifacts(manifest) {
  return (manifest.protected_screenshots || []).map((asset) => ({
    id: asset.id,
    file: resolveAssetPath(asset),
    minBytes: 20001,
    metadata: asset,
  }));
}

function walkthroughArtifacts(manifest) {
  const demo = (manifest.demo_assets || []).find((asset) => asset.id === "short-proof-walkthrough");
  return demo ? [
    {
      id: demo.id,
      file: path.resolve(demo.absolute_path || clipPath),
      minBytes: 50001,
      metadata: demo,
      sha256: demo.sha256,
    },
    {
      id: `${demo.id}-poster`,
      file: path.resolve(demo.poster_absolute_path || posterPath),
      minBytes: 20001,
      metadata: demo,
      sha256: demo.poster_sha256,
    },
  ] : [];
}

function validateStage(manifest, stage, intended, artifacts, dependencies = []) {
  const result = validateLaunchCaptureStage({
    manifest,
    stage,
    intended,
    artifacts,
    dependencies,
    requiredArtifactIds: requiredArtifactIdsByStage[stage] || [],
  });
  if (!result.ok) {
    fail(`${stage} launch asset provenance is stale or invalid`, {
      manifestPath,
      ...result,
    });
  }
  return result;
}

function manifestAsset(manifest, id) {
  const assets = [
    ...(manifest.public_screenshots || []),
    ...(manifest.protected_screenshots || []),
  ];
  return assets.find((asset) => asset.id === id);
}

function resolveAssetPath(asset) {
  return path.resolve(asset?.absolute_path || path.join(outputDir, asset?.file || ""));
}

function assertRequiredImage(manifest, id) {
  const asset = manifestAsset(manifest, id);
  const file = resolveAssetPath(asset);
  if (!asset || !fileOk(file)) {
    fail("required launch screenshot is missing or too small", { id, file });
  }
  return file;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function dataUri(file) {
  const encoded = readFileSync(file).toString("base64");
  return `data:image/png;base64,${encoded}`;
}

function slideHtml(slide) {
  const steps = slide.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; }
    body {
      background: #f5f7fb;
      color: #132436;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .frame {
      width: 1280px;
      height: 720px;
      display: grid;
      grid-template-columns: 435px 1fr;
      gap: 28px;
      padding: 38px;
      background: linear-gradient(135deg, #f7fafc 0%, #eaf2f8 55%, #fff8ea 100%);
    }
    .copy {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      border: 1px solid #dce6ee;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.96);
      padding: 28px;
      min-width: 0;
    }
    .brand {
      font-weight: 850;
      color: #172536;
      font-size: 15px;
      letter-spacing: 0.08em;
    }
    .eyebrow {
      margin-top: 40px;
      font-size: 13px;
      font-weight: 800;
      color: #627386;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    h1 {
      margin: 10px 0 0;
      color: #132436;
      font-size: 42px;
      line-height: 1.04;
      letter-spacing: 0;
    }
    .body {
      margin-top: 16px;
      color: #526273;
      font-size: 18px;
      line-height: 1.48;
    }
    ul {
      margin: 24px 0 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 10px;
    }
    li {
      display: flex;
      align-items: center;
      min-height: 34px;
      border: 1px solid #dce6ee;
      border-radius: 8px;
      background: #f8fbfd;
      padding: 8px 10px;
      color: #27394b;
      font-size: 14px;
      line-height: 1.3;
    }
    li::before {
      content: "";
      width: 8px;
      height: 8px;
      margin-right: 9px;
      border-radius: 999px;
      background: #1f8a5b;
      flex: 0 0 auto;
    }
    .guardrail {
      margin-top: 22px;
      color: #657687;
      font-size: 12px;
      line-height: 1.45;
    }
    .visual {
      border: 1px solid #d5e0ea;
      border-radius: 8px;
      background: #ffffff;
      box-shadow: 0 24px 60px rgba(32, 48, 64, 0.14);
      overflow: hidden;
      display: grid;
      align-content: center;
      min-width: 0;
    }
    .visual img {
      width: 100%;
      height: 100%;
      max-height: 644px;
      object-fit: cover;
      object-position: top center;
      display: block;
    }
    .caption {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      color: #627386;
      font-size: 12px;
      line-height: 1.35;
    }
  </style>
</head>
<body>
  <div class="frame">
    <section class="copy">
      <div>
        <div class="brand">SMIRK</div>
        <div class="eyebrow">${escapeHtml(slide.eyebrow)}</div>
        <h1>${escapeHtml(slide.title)}</h1>
        <div class="body">${escapeHtml(slide.body)}</div>
        <ul>${steps}</ul>
        <div class="guardrail">${escapeHtml(slide.guardrail)}</div>
      </div>
      <div class="caption">
        <span>${escapeHtml(slide.footerLeft)}</span>
        <span>${escapeHtml(slide.footerRight)}</span>
      </div>
    </section>
    <section class="visual">
      <img alt="" src="${dataUri(slide.image)}">
    </section>
  </div>
</body>
</html>`;
}

async function renderSlides(slides) {
  mkdirSync(framesDir, { recursive: true });
  const browser = await chromium.launch();
  const frames = [];
  try {
    for (const [index, slide] of slides.entries()) {
      const framePath = path.join(framesDir, `${String(index + 1).padStart(2, "0")}-${slide.slug}.png`);
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
      await page.setContent(slideHtml(slide), { waitUntil: "domcontentloaded" });
      await page.screenshot({ path: framePath, fullPage: false });
      await page.close();
      if (!fileOk(framePath)) fail("walkthrough frame render failed", { framePath });
      frames.push(framePath);
    }
  } finally {
    await browser.close();
  }
  return frames;
}

function concatLine(file) {
  return `file '${file.replaceAll("'", "'\\''")}'`;
}

function renderMp4(frames, durations) {
  const concatPath = path.join(framesDir, "concat.txt");
  const lines = [];
  for (const [index, frame] of frames.entries()) {
    lines.push(concatLine(frame));
    lines.push(`duration ${durations[index] || 3}`);
  }
  lines.push(concatLine(frames[frames.length - 1]));
  writeFileSync(concatPath, `${lines.join("\n")}\n`);
  runQuiet("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatPath,
    "-vf",
    "fps=30,format=yuv420p",
    "-movflags",
    "+faststart",
    clipPath,
  ], "could not render launch walkthrough MP4");
}

function probeVideoDurationSeconds(file) {
  try {
    const output = execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const duration = Number(output);
    return Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null;
  } catch {
    return null;
  }
}

function renderMarkdown(manifest) {
  const publicScreenshots = manifest.public_screenshots || [];
  const protectedScreenshots = manifest.protected_screenshots || [];
  const protectedRequired = manifest.protected_required_assets || [];
  const blockers = manifest.submission_readiness?.blockers || [];
  const demoAssets = manifest.demo_assets || [];
  const lines = [
    "# SMIRK Launch Asset Manifest",
    "",
    `Generated: ${manifest.generated_at}`,
    `Captured: ${manifest.captured_at}`,
    `Live branch: ${manifest.live_branch}`,
    `Live version: ${manifest.live_version}`,
    `Base URL: ${manifest.source_base_url}`,
    `Submission ready: ${manifest.submission_readiness?.product_hunt_submission_ready ? "yes" : "no"}`,
    "",
    "## Public Screenshots",
    "",
    ...publicScreenshots.map((asset) => `- ${asset.id}: ${asset.ok ? "ok" : "fail"} - ${asset.file} (${asset.use})`),
    "",
    "## Protected Redacted Screenshots",
    "",
    ...protectedScreenshots.map((asset) => `- ${asset.id}: ${asset.ok ? "ok" : "fail"} - ${asset.file} (${asset.use})`),
    "",
    "## Demo Walkthrough",
    "",
    ...demoAssets.map((asset) => `- ${asset.id}: ${asset.ok ? "ok" : "fail"} - ${asset.file} (${asset.use})`),
    "",
    "## Missing Gated Assets",
    "",
    ...protectedRequired
      .filter((asset) => !String(asset.status || "").startsWith("ok_"))
      .map((asset) => `- ${asset.id}: ${asset.status}. ${asset.nextAction}`),
    "",
    "## Submission Blockers",
    "",
    ...blockers.map((blocker) => `- ${blocker}`),
    "",
    "## Notes",
    "",
    "- Public screenshots are safe to use as long as they match current production behavior.",
    "- Protected screenshots and walkthrough assets are rendered from redacted launch assets.",
    "- Do not claim fully automated SaaS until the paid activation proof gate passes.",
  ];
  return `${lines.join("\n")}\n`;
}

function updateManifest(manifest, demoAsset, walkthroughProvenance) {
  const requiredById = new Map((manifest.protected_required_assets || []).map((asset) => [asset.id, asset]));
  requiredById.set("short-proof-walkthrough", {
    ...(requiredById.get("short-proof-walkthrough") || {}),
    id: "short-proof-walkthrough",
    status: "ok_current_redacted_walkthrough",
    file: clipFile,
    absolute_path: clipPath,
    poster_file: posterFile,
    poster_absolute_path: posterPath,
    requiredFor: ["Product Hunt", "paid creative", "sales proof walkthroughs"],
    nextAction: "Use this redacted walkthrough clip only while it matches the current launch manifest and proof assets.",
  });

  const blockers = (manifest.submission_readiness?.blockers || [])
    .filter((blocker) => !/Current short proof walkthrough\/demo clip/i.test(String(blocker)));
  const selfServeBlocker = "Self-serve paid activation proof must pass before claiming fully automated SaaS.";
  if (!blockers.includes(selfServeBlocker)) blockers.push(selfServeBlocker);

  return {
    ...manifest,
    updated_at: new Date().toISOString(),
    capture_provenance: {
      ...(manifest.capture_provenance || {}),
      walkthrough: walkthroughProvenance,
    },
    demo_assets: [demoAsset],
    protected_required_assets: [...requiredById.values()],
    submission_readiness: {
      ...(manifest.submission_readiness || {}),
      product_hunt_submission_ready: false,
      g2_capterra_submission_ready: false,
      paid_creative_ready: false,
      blockers,
    },
  };
}

async function checkExistingAsset() {
  const manifest = readManifest();
  const intended = intendedDeployment();
  const currentDeployment = await verifyLaunchManifestCurrent(manifest, intended);
  if (!currentDeployment.ok) {
    fail("launch asset manifest does not match the current deployment", {
      manifestPath,
      ...currentDeployment,
    });
  }
  const demo = (manifest.demo_assets || []).find((asset) => asset.id === "short-proof-walkthrough");
  const requirement = (manifest.protected_required_assets || []).find((asset) => asset.id === "short-proof-walkthrough");
  const missing = [];
  if (!demo || demo.ok !== true) missing.push("manifest demo_assets short-proof-walkthrough");
  if (!requirement || !String(requirement.status || "").startsWith("ok_current_redacted_walkthrough")) {
    missing.push("protected_required_assets short-proof-walkthrough ok status");
  }
  if (!fileOk(path.resolve(demo?.absolute_path || clipPath), 50000)) missing.push(clipFile);
  if (!fileOk(path.resolve(demo?.poster_absolute_path || posterPath), 20000)) missing.push(posterFile);
  const blockers = manifest.submission_readiness?.blockers || [];
  if (blockers.some((blocker) => /Current short proof walkthrough\/demo clip/i.test(String(blocker)))) {
    missing.push("walkthrough blocker must be cleared");
  }
  if (missing.length > 0) {
    fail("launch walkthrough asset is incomplete", { missing, manifestPath });
  }
  validateStage(manifest, "public", intended, publicArtifacts(manifest));
  validateStage(manifest, "protected", intended, protectedArtifacts(manifest), ["public"]);
  validateStage(manifest, "walkthrough", intended, walkthroughArtifacts(manifest), ["public", "protected"]);
  console.log(JSON.stringify({
    ok: true,
    manifestPath,
    file: demo.file,
    absolutePath: demo.absolute_path,
    posterFile: demo.poster_file,
    sizeBytes: fileSize(path.resolve(demo.absolute_path)),
    liveBranch: manifest.live_branch,
    liveVersion: manifest.live_version,
    capturedAt: manifest.capture_provenance.walkthrough.captured_at,
    productHuntSubmissionReady: manifest.submission_readiness?.product_hunt_submission_ready === true,
    blockers,
  }, null, 2));
}

if (checkExisting) {
  await checkExistingAsset();
  process.exit(0);
}

assertLiveCurrent();
assertFfmpegAvailable();
runQuiet("npm", ["run", "-s", "check:launch-protected-assets"], "protected launch assets must pass before recording walkthrough");
mkdirSync(outputDir, { recursive: true });

const manifest = readManifest();
const intended = intendedDeployment();
validateStage(manifest, "public", intended, publicArtifacts(manifest));
validateStage(manifest, "protected", intended, protectedArtifacts(manifest), ["public"]);
let liveDeployment;
try {
  liveDeployment = await fetchLaunchDeploymentFingerprint(process.env.APP_URL || manifest.source_base_url);
} catch (error) {
  fail("could not verify the walkthrough launch asset source deployment", {
    baseUrl: process.env.APP_URL || manifest.source_base_url,
    error: error?.message || String(error),
  });
}
const liveMatch = compareLaunchDeployment(liveDeployment, intended);
if (!liveMatch.ok) {
  fail("walkthrough launch asset source is not the intended/current deployment", {
    intendedDeployment: intended,
    liveDeployment,
    failures: liveMatch.failures,
  });
}
const launchPage = assertRequiredImage(manifest, "launch-page");
const pricingPage = assertRequiredImage(manifest, "pricing-page");
const proofDashboard = assertRequiredImage(manifest, "redacted-proof-dashboard");
const callbackQueue = assertRequiredImage(manifest, "redacted-callback-task-queue");
const comparePage = assertRequiredImage(manifest, "compare-page");

const slides = [
  {
    slug: "missed-call-recovery",
    eyebrow: "Home-services wedge",
    title: "Missed-call recovery, not generic AI reception",
    body: "The launch story stays narrow: give missed callers a dedicated recovery number, alert the owner, and leave proof.",
    steps: ["Dedicated recovery number", "Owner-focused callback workflow", "No cold SMS in the launch motion"],
    guardrail: "Launch-safe visual built from current public and redacted production assets.",
    footerLeft: "Launch page",
    footerRight: "smirkcalls.com/launch",
    image: launchPage,
  },
  {
    slug: "call-summary-alert",
    eyebrow: "Proof loop",
    title: "Call record, summary, and owner alert",
    body: "The dashboard proof view shows that call records become summaries and owner alerts without exposing caller details.",
    steps: ["Call record present", "Generated summary counted", "Owner email alert counted"],
    guardrail: "Caller names, phone numbers, transcripts, recordings, emails, and task notes stay out of the clip.",
    footerLeft: "Redacted dashboard proof",
    footerRight: "Production counters",
    image: proofDashboard,
  },
  {
    slug: "callback-task",
    eyebrow: "Owner workflow",
    title: "Callback task created",
    body: "The owner-action queue turns missed opportunities into visible follow-up work instead of buried voicemail.",
    steps: ["Callback and handoff tasks", "Status visible to the owner", "Private task details removed"],
    guardrail: "This is a redacted workflow view for launch galleries and proof walkthroughs.",
    footerLeft: "Callback queue",
    footerRight: "Redacted rows",
    image: callbackQueue,
  },
  {
    slug: "clear-pricing",
    eyebrow: "First offer",
    title: "Simple Starter path",
    body: "Pricing stays clear for the first sprint while the self-serve activation proof remains the final claim gate.",
    steps: ["Starter starts at $197/month", "Start Starter or book a proof demo", "No unlimited voice or SMS promises"],
    guardrail: "Do not claim fully automated SaaS until a paid activation proves checkout, workspace access, dashboard, proof, alert, and task.",
    footerLeft: "Pricing page",
    footerRight: "Current public offer",
    image: pricingPage,
  },
  {
    slug: "guarded-launch",
    eyebrow: "Launch boundary",
    title: "Trust proof before scale",
    body: "The market sprint can use this walkthrough for feedback, but paid spend and bigger platform launches stay gated.",
    steps: ["Product Hunt assets prepared", "G2 and Capterra screenshots prepared", "Paid spend waits for approval plus activation proof"],
    guardrail: "No outreach, SMS, paid ads, Stripe smoke, or real calls are triggered by this capture.",
    footerLeft: "Comparison page",
    footerRight: "Narrow positioning",
    image: comparePage,
  },
];

const durations = [3, 4, 4, 4, 3];
const frames = await renderSlides(slides);
copyFileSync(frames[0], posterPath);
renderMp4(frames, durations);

if (!fileOk(clipPath, 50000)) fail("walkthrough MP4 was not created or is too small", { clipPath, sizeBytes: fileSize(clipPath) });
if (!fileOk(posterPath, 20000)) fail("walkthrough poster was not created or is too small", { posterPath, sizeBytes: fileSize(posterPath) });
const durationSeconds = probeVideoDurationSeconds(clipPath) || durations.reduce((total, value) => total + value, 0);
const capturedAt = new Date().toISOString();
const walkthroughProvenance = buildLaunchCaptureProvenance(liveDeployment, intended, capturedAt);

const demoAsset = {
  id: "short-proof-walkthrough",
  ok: true,
  file: clipFile,
  absolute_path: clipPath,
  poster_file: posterFile,
  poster_absolute_path: posterPath,
  source: "current_public_and_redacted_launch_assets",
  captured_at: capturedAt,
  source_branch: liveDeployment.branch,
  source_version: liveDeployment.version,
  sha256: sha256LaunchAssetFile(clipPath),
  poster_sha256: sha256LaunchAssetFile(posterPath),
  duration_seconds: durationSeconds,
  frame_count: frames.length,
  use: "Product Hunt demo video, paid creative review, and sales proof walkthroughs",
  redaction: "built only from public screenshots and protected redacted screenshots; no caller names, phone numbers, transcripts, recordings, emails, or task notes are rendered",
};

const updatedManifest = updateManifest(readManifest(), demoAsset, walkthroughProvenance);
writeFileSync(manifestPath, JSON.stringify(updatedManifest, null, 2) + "\n");
writeFileSync(markdownPath, renderMarkdown(updatedManifest));

console.log(JSON.stringify({
  ok: true,
  manifestPath,
  markdownPath,
  file: clipFile,
  absolutePath: clipPath,
  posterFile,
  posterPath,
  sizeBytes: fileSize(clipPath),
  durationSeconds,
  liveBranch: updatedManifest.live_branch,
  liveVersion: updatedManifest.live_version,
  capturedAt,
  productHuntSubmissionReady: updatedManifest.submission_readiness.product_hunt_submission_ready,
  blockers: updatedManifest.submission_readiness.blockers,
}, null, 2));
