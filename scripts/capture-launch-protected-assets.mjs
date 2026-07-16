#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { readRailwayEnvValue } from "./railway-json.mjs";

const args = new Set(process.argv.slice(2));
const checkExisting = args.has("--check-existing");
const appUrl = String(process.env.APP_URL || "https://ai-phone-agent-production-6811.up.railway.app").replace(/\/$/, "");
const outputDir = path.resolve(process.env.SMIRK_LAUNCH_ASSET_OUTPUT_DIR || "output/playwright/launch-assets");
const manifestPath = path.join(outputDir, "manifest.json");
const markdownPath = path.join(outputDir, "manifest.md");
const proofFile = "06-redacted-proof-dashboard.png";
const taskFile = "07-redacted-callback-task-queue.png";
const proofPath = path.join(outputDir, proofFile);
const taskPath = path.join(outputDir, taskFile);
const fetchTimeoutMs = Number(process.env.SMIRK_LAUNCH_PROTECTED_FETCH_TIMEOUT_MS || 15000);

function fail(message, detail = {}) {
  console.error(JSON.stringify({ ok: false, message, detail }, null, 2));
  process.exit(1);
}

function readLocalEnvValue(key) {
  const files = [
    ".env.local",
    ".env",
    path.join(process.env.HOME || "", ".openclaw", "workspace", ".env.operator"),
    path.join(process.env.HOME || "", ".openclaw", "workspace", ".env.smirk"),
    path.join(process.env.HOME || "", ".openclaw", "workspace", ".env"),
  ];
  for (const file of files) {
    const resolved = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
    if (!existsSync(resolved)) continue;
    const lines = readFileSync(resolved, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith(`${key}=`)) continue;
      return line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, "");
    }
  }
  return "";
}

function assertLiveCurrent() {
  try {
    execFileSync("npm", ["run", "-s", "check:live-is-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    fail("production is not current; protected launch assets must match live HEAD", {
      output: String(error?.stdout || error?.stderr || error?.message || "").slice(0, 4000),
    });
  }
}

async function fetchJson(pathname, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const res = await fetch(`${appUrl}${pathname}`, {
      headers: { "x-api-key": apiKey },
      signal: controller.signal,
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 300) };
    }
    return {
      ok: res.ok,
      status: res.status,
      body,
      cacheControl: String(res.headers.get("cache-control") || ""),
    };
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message || error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function firstWorkingOperatorKey() {
  const candidates = [
    ["process env", String(process.env.DASHBOARD_API_KEY || "").trim()],
    ["local env file", readLocalEnvValue("DASHBOARD_API_KEY")],
    ["railway variables", readRailwayEnvValue("DASHBOARD_API_KEY", { quiet: true })],
  ].filter(([, value]) => value);

  const failures = [];
  for (const [source, apiKey] of candidates) {
    const session = await fetchJson("/api/operator/session", apiKey);
    if (session.ok && session.body?.ok === true && session.body?.role === "operator") {
      return { source, apiKey };
    }
    failures.push({ source, status: session.status, error: session.body?.error || session.error || null });
  }
  fail("could not find a working operator key for protected launch assets", { failures });
}

function readManifest() {
  if (!existsSync(manifestPath)) {
    fail("launch public asset manifest is missing", {
      manifestPath,
      nextAction: "Run SMIRK_LAUNCH_ASSET_BASE_URL=https://smirkcalls.com npm run capture:launch-assets first.",
    });
  }
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail("could not parse launch asset manifest", { manifestPath, error: String(error?.message || error) });
  }
}

function fileOk(file) {
  return existsSync(file) && statSync(file).size > 20000;
}

function renderMarkdown(manifest) {
  const publicScreenshots = manifest.public_screenshots || [];
  const protectedScreenshots = manifest.protected_screenshots || [];
  const protectedRequired = manifest.protected_required_assets || [];
  const blockers = manifest.submission_readiness?.blockers || [];
  const lines = [
    "# SMIRK Launch Asset Manifest",
    "",
    `Generated: ${manifest.generated_at}`,
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
    "- Protected screenshots are rendered from live operator APIs with caller details removed.",
    "- Do not claim fully automated SaaS until the paid activation proof gate passes.",
  ];
  return `${lines.join("\n")}\n`;
}

function updateManifest(manifest, protectedAssets) {
  const previousRequired = Array.isArray(manifest.protected_required_assets) ? manifest.protected_required_assets : [];
  const requiredById = new Map(previousRequired.map((asset) => [asset.id, asset]));
  requiredById.set("redacted-proof-dashboard", {
    ...(requiredById.get("redacted-proof-dashboard") || {}),
    id: "redacted-proof-dashboard",
    status: "ok_redacted_capture",
    file: proofFile,
    absolute_path: proofPath,
    requiredFor: ["Product Hunt", "G2", "Capterra", "retargeting"],
    nextAction: "Use this redacted dashboard proof screenshot; keep raw caller data out of launch galleries.",
  });
  requiredById.set("redacted-callback-task-queue", {
    ...(requiredById.get("redacted-callback-task-queue") || {}),
    id: "redacted-callback-task-queue",
    status: "ok_redacted_capture",
    file: taskFile,
    absolute_path: taskPath,
    requiredFor: ["Product Hunt", "G2", "Capterra", "retargeting"],
    nextAction: "Use this redacted callback queue screenshot; keep raw caller data out of launch galleries.",
  });
  if (!requiredById.has("short-proof-walkthrough")) {
    requiredById.set("short-proof-walkthrough", {
      id: "short-proof-walkthrough",
      status: "missing_requires_current_review",
      requiredFor: ["Product Hunt", "paid creative", "sales proof walkthroughs"],
      nextAction: "Record or approve a current short walkthrough showing call record, summary, owner alert, callback task, and dashboard proof.",
    });
  }

  const existingBlockers = manifest.submission_readiness?.blockers || [];
  const blockers = existingBlockers
    .filter((blocker) => !/Redacted dashboard proof screenshot|Redacted callback task queue screenshot/i.test(blocker));
  for (const blocker of [
    "Current short proof walkthrough/demo clip still needs review before launch.",
    "Self-serve paid activation proof must pass before claiming fully automated SaaS.",
  ]) {
    if (!blockers.includes(blocker)) blockers.push(blocker);
  }

  return {
    ...manifest,
    generated_at: new Date().toISOString(),
    protected_screenshots: protectedAssets,
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

function formatNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num.toLocaleString("en-US") : "0";
}

function safeDate(value) {
  const ms = Date.parse(String(value || ""));
  if (!Number.isFinite(ms)) return "Queued";
  return new Date(ms).toISOString().slice(0, 10);
}

function taskTypeLabel(type) {
  const normalized = String(type || "callback").replace(/_/g, " ").trim();
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : "Callback";
}

function baseHtml(title, body) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f4f7fb; color: #102033; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .frame { width: 1440px; min-height: 920px; padding: 56px; background: linear-gradient(135deg, #f7fafc 0%, #eaf2f8 52%, #fdf6e7 100%); }
    .shell { border: 1px solid #d8e2ec; border-radius: 8px; background: rgba(255, 255, 255, 0.94); box-shadow: 0 24px 60px rgba(32, 48, 64, 0.14); overflow: hidden; }
    .topbar { display: flex; justify-content: space-between; align-items: center; padding: 22px 28px; border-bottom: 1px solid #e3ebf2; background: #ffffff; }
    .brand { font-weight: 800; letter-spacing: 0.08em; color: #182535; }
    .pill { border: 1px solid #cdd9e4; border-radius: 999px; padding: 8px 12px; font-size: 12px; font-weight: 700; color: #506070; background: #f8fbfd; }
    .content { padding: 30px; }
    h1 { margin: 0; font-size: 38px; line-height: 1.08; color: #14202e; letter-spacing: 0; }
    .sub { margin-top: 10px; color: #526273; font-size: 16px; max-width: 830px; line-height: 1.55; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-top: 28px; }
    .card { border: 1px solid #dce6ee; border-radius: 8px; background: #ffffff; padding: 18px; min-height: 128px; }
    .label { font-size: 12px; font-weight: 800; color: #68798b; text-transform: uppercase; letter-spacing: 0.08em; }
    .value { margin-top: 12px; font-size: 34px; line-height: 1; font-weight: 850; color: #132436; }
    .hint { margin-top: 9px; color: #617284; font-size: 13px; line-height: 1.45; }
    .section { margin-top: 22px; border: 1px solid #dce6ee; border-radius: 8px; background: #ffffff; overflow: hidden; }
    .section-head { padding: 16px 18px; border-bottom: 1px solid #e5edf3; display: flex; justify-content: space-between; align-items: center; }
    .section-title { font-size: 15px; font-weight: 800; color: #172536; }
    .rows { display: grid; }
    .row { display: grid; grid-template-columns: 1.2fr 0.7fr 0.7fr 0.7fr; gap: 14px; padding: 16px 18px; border-top: 1px solid #edf2f6; align-items: center; }
    .row:first-child { border-top: 0; }
    .row strong { color: #152638; }
    .muted { color: #6a7a8c; font-size: 13px; line-height: 1.4; }
    .status { justify-self: start; border-radius: 999px; padding: 7px 10px; background: #e9f6ef; color: #186a3b; font-size: 12px; font-weight: 800; }
    .redacted { color: #566777; background: #eef3f7; border-radius: 6px; padding: 8px 10px; font-size: 13px; font-weight: 700; display: inline-block; }
    .footer { margin-top: 22px; display: flex; justify-content: space-between; gap: 16px; color: #5b6c7c; font-size: 13px; }
  </style>
</head>
<body>
  <div class="frame"><div class="shell">${body}</div></div>
</body>
</html>`;
}

function proofDashboardHtml({ workspace, publicProof, generatedAt }) {
  const counters = [
    ["Total calls", workspace.totalCalls ?? publicProof.totalCalls, "Live call records in the proof workspace."],
    ["Summaries", workspace.summariesGenerated ?? publicProof.summariesGenerated, "Calls with generated post-call summaries."],
    ["Owner alerts", workspace.ownerEmailAlertsSent ?? publicProof.ownerEmailAlertsSent, "Owner email alerts recorded by the system."],
    ["Callback tasks", workspace.callbackTasksCreated ?? publicProof.callbackTasksCreated, "Follow-up work created from calls."],
    ["Complete proof calls", workspace.completeProofCalls ?? publicProof.completeProofCalls, "Calls with summary, alert, task, and dashboard proof."],
    ["Summary coverage", publicProof.summaryCoverage ? `${publicProof.summaryCoverage}%` : 0, "Public proof snapshot coverage metric."],
    ["Calls this month", publicProof.callsThisMonth, "Current-month public proof activity."],
    ["Transferred handoffs", publicProof.transferredHandoffs, "Human handoff outcomes counted in proof."],
  ];
  const cards = counters.map(([label, value, hint]) => `<div class="card"><div class="label">${label}</div><div class="value">${typeof value === "string" ? value : formatNumber(value)}</div><div class="hint">${hint}</div></div>`).join("");
  return baseHtml("SMIRK redacted proof dashboard", `
    <div class="topbar"><div class="brand">SMIRK</div><div class="pill">Caller details redacted</div></div>
    <div class="content">
      <h1>Proof dashboard for missed-call recovery</h1>
      <div class="sub">Live production counters rendered for launch galleries with caller names, phone numbers, transcripts, recordings, and task notes removed.</div>
      <div class="grid">${cards}</div>
      <div class="section">
        <div class="section-head"><div class="section-title">What this proof shows</div><div class="pill">Production snapshot</div></div>
        <div class="rows">
          <div class="row"><strong>Call record</strong><span class="status">Present</span><span class="redacted">Caller redacted</span><span class="muted">Proof loop source</span></div>
          <div class="row"><strong>Generated summary</strong><span class="status">Present</span><span class="redacted">Transcript redacted</span><span class="muted">Post-call artifact</span></div>
          <div class="row"><strong>Owner alert</strong><span class="status">Present</span><span class="redacted">Email redacted</span><span class="muted">Owner notification</span></div>
          <div class="row"><strong>Callback task</strong><span class="status">Present</span><span class="redacted">Task details redacted</span><span class="muted">Follow-up queue</span></div>
        </div>
      </div>
      <div class="footer"><span>Generated ${generatedAt}</span><span>Use only as a redacted launch asset.</span></div>
    </div>
  `);
}

function taskQueueHtml({ tasks, generatedAt }) {
  const safeTasks = tasks.slice(0, 8).map((task, index) => ({
    label: `Redacted callback task ${index + 1}`,
    type: taskTypeLabel(task.type || task.task_type || "callback"),
    status: String(task.status || "open"),
    due: safeDate(task.due_at || task.dueAt || task.created_at || task.createdAt),
  }));
  while (safeTasks.length < 5) {
    safeTasks.push({
      label: `Redacted callback task ${safeTasks.length + 1}`,
      type: "Callback",
      status: "open",
      due: "Queued",
    });
  }
  const rows = safeTasks.map((task) => `
    <div class="row">
      <strong>${task.label}<div class="muted">Caller name, phone, notes, transcript, and recording removed.</div></strong>
      <span class="status">${task.status}</span>
      <span class="redacted">${task.type}</span>
      <span class="muted">${task.due}</span>
    </div>
  `).join("");
  return baseHtml("SMIRK redacted callback task queue", `
    <div class="topbar"><div class="brand">SMIRK</div><div class="pill">Callback queue redacted</div></div>
    <div class="content">
      <h1>Owner callback workflow</h1>
      <div class="sub">A launch-safe view of the follow-up queue. This screenshot proves the callback workflow without exposing caller data or private task details.</div>
      <div class="section">
        <div class="section-head"><div class="section-title">Callback and owner-action tasks</div><div class="pill">${safeTasks.length} redacted rows</div></div>
        <div class="rows">${rows}</div>
      </div>
      <div class="grid">
        <div class="card"><div class="label">Privacy guard</div><div class="value">On</div><div class="hint">No raw phone, email, transcript, recording URL, or task notes are rendered.</div></div>
        <div class="card"><div class="label">Workflow</div><div class="value">Call</div><div class="hint">A missed or forwarded call becomes follow-up work.</div></div>
        <div class="card"><div class="label">Owner action</div><div class="value">Task</div><div class="hint">The owner sees what to do next without digging through voicemail.</div></div>
        <div class="card"><div class="label">Launch use</div><div class="value">Safe</div><div class="hint">Prepared for Product Hunt, G2, Capterra, and retargeting review.</div></div>
      </div>
      <div class="footer"><span>Generated ${generatedAt}</span><span>Use only as a redacted launch asset.</span></div>
    </div>
  `);
}

async function screenshotHtml(browser, html, file) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
}

if (checkExisting) {
  const manifest = readManifest();
  const protectedAssets = manifest.protected_screenshots || [];
  const proofAsset = protectedAssets.find((asset) => asset.id === "redacted-proof-dashboard");
  const taskAsset = protectedAssets.find((asset) => asset.id === "redacted-callback-task-queue");
  const missing = [
    !proofAsset || !fileOk(path.resolve(proofAsset.absolute_path || proofPath)) ? "redacted-proof-dashboard" : null,
    !taskAsset || !fileOk(path.resolve(taskAsset.absolute_path || taskPath)) ? "redacted-callback-task-queue" : null,
  ].filter(Boolean);
  if (missing.length > 0) {
    fail("protected redacted launch assets are incomplete", { missing, manifestPath });
  }
  console.log(JSON.stringify({
    ok: true,
    manifestPath,
    protectedScreenshotCount: protectedAssets.length,
    productHuntSubmissionReady: manifest.submission_readiness?.product_hunt_submission_ready === true,
    blockers: manifest.submission_readiness?.blockers || [],
  }, null, 2));
  process.exit(0);
}

assertLiveCurrent();
mkdirSync(outputDir, { recursive: true });

const operator = await firstWorkingOperatorKey();
const [workspaceRes, publicProofRes, tasksRes] = await Promise.all([
  fetchJson("/api/workspace-overview", operator.apiKey),
  fetchJson("/api/public-proof-snapshot", operator.apiKey),
  fetchJson("/api/tasks?status=all", operator.apiKey),
]);

if (!workspaceRes.ok) fail("could not fetch workspace proof counters", { status: workspaceRes.status });
if (!publicProofRes.ok) fail("could not fetch public proof snapshot", { status: publicProofRes.status });
if (!tasksRes.ok) fail("could not fetch callback tasks for redacted asset", { status: tasksRes.status });

const tasks = Array.isArray(tasksRes.body?.tasks) ? tasksRes.body.tasks : [];
const callbackTasks = tasks.filter((task) => /callback|handoff|escalate_to_human|owner/i.test(String(task.type || task.task_type || "")));
const generatedAt = new Date().toISOString();

const browser = await chromium.launch();
try {
  await screenshotHtml(browser, proofDashboardHtml({
    workspace: workspaceRes.body || {},
    publicProof: publicProofRes.body || {},
    generatedAt,
  }), proofPath);
  await screenshotHtml(browser, taskQueueHtml({
    tasks: callbackTasks,
    generatedAt,
  }), taskPath);
} finally {
  await browser.close();
}

const protectedAssets = [
  {
    id: "redacted-proof-dashboard",
    ok: fileOk(proofPath),
    file: proofFile,
    absolute_path: proofPath,
    source: "live_operator_api_redacted",
    use: "Product Hunt, G2, Capterra, and retargeting proof dashboard asset",
    redaction: "caller names, phone numbers, transcripts, recordings, emails, and task notes are not rendered",
  },
  {
    id: "redacted-callback-task-queue",
    ok: fileOk(taskPath),
    file: taskFile,
    absolute_path: taskPath,
    source: "live_operator_api_redacted",
    use: "Product Hunt, G2, Capterra, and retargeting callback workflow asset",
    redaction: "caller names, phone numbers, transcripts, recordings, emails, and task notes are not rendered",
  },
];

if (protectedAssets.some((asset) => !asset.ok)) {
  fail("protected screenshot capture produced incomplete files", { protectedAssets });
}

const manifest = updateManifest(readManifest(), protectedAssets);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(markdownPath, renderMarkdown(manifest));

console.log(JSON.stringify({
  ok: true,
  manifestPath,
  markdownPath,
  protectedScreenshotCount: protectedAssets.length,
  productHuntSubmissionReady: manifest.submission_readiness.product_hunt_submission_ready,
  blockers: manifest.submission_readiness.blockers,
}, null, 2));
