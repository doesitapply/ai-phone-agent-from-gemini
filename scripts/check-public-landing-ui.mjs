#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

const port = Number(process.env.SMIRK_LANDING_UI_PROOF_PORT || 4183);
const externalBaseUrl = String(process.env.SMIRK_LANDING_UI_PROOF_BASE_URL || "").trim();
const baseUrl = externalBaseUrl || `http://127.0.0.1:${port}`;
const outputDir = path.resolve(
  process.env.SMIRK_LANDING_UI_PROOF_OUTPUT_DIR || "output/ui-proof/public-landing"
);

const pricingFixture = {
  plans: [
    {
      id: "starter",
      name: "SMIRK AI Starter",
      price: 197,
      interval: "month",
      description: "Missed-call recovery for one home-service workspace.",
      features: ["Call record", "Owner summary", "Callback task"],
      usage_summary: "Starter usage limits apply.",
      best_for: "Independent home-service teams",
      cta: "Start recovery",
      checkout_available: true,
      checkout_blocker: null,
      fallback_url: "/book",
    },
  ],
  policy_links: [
    { key: "terms", label: "Terms", url: "https://smirkcalls.com/terms" },
    { key: "privacy", label: "Privacy", url: "https://smirkcalls.com/privacy" },
  ],
};

function respond(route, body) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function waitForServer(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function installSyntheticApi(context) {
  await context.route("**/api/**", async (route) => {
    const requestPath = new URL(route.request().url()).pathname;
    if (requestPath === "/api/pricing") return respond(route, pricingFixture);
    if (requestPath === "/api/launch/events") return respond(route, { ok: true });
    return respond(route, {});
  });
}

async function pageProof(browser, viewport, name) {
  const context = await browser.newContext({ viewport });
  await installSyntheticApi(context);
  const page = await context.newPage();
  const runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Catch the calls your crew cannot answer." }).waitFor();
  await page.getByRole("heading", { name: "What happens on the next missed call" }).waitFor();
  await page.getByRole("heading", { name: "Two modes. The same proof trail." }).waitFor();
  await page.getByRole("heading", { name: "Set up missed-call recovery" }).waitFor();
  await page.getByRole("heading", { name: "Common questions" }).waitFor();

  const layout = await page.evaluate(async () => {
    const hero = document.querySelector("main > section");
    const howItWorks = document.querySelector("#how-it-works");
    const backgroundImage = hero ? getComputedStyle(hero).backgroundImage : "";
    const match = backgroundImage.match(/url\(["']?(.*?)["']?\)/);
    let heroPixelVariance = 0;
    let heroAsset = { width: 0, height: 0 };
    if (match?.[1]) {
      const image = new Image();
      image.src = match[1];
      await image.decode();
      heroAsset = { width: image.naturalWidth, height: image.naturalHeight };
      const canvas = document.createElement("canvas");
      canvas.width = 24;
      canvas.height = 24;
      const context = canvas.getContext("2d");
      context?.drawImage(image, 0, 0, 24, 24);
      const data = context?.getImageData(0, 0, 24, 24).data || [];
      const values = [];
      for (let index = 0; index < data.length; index += 4) {
        values.push((data[index] + data[index + 1] + data[index + 2]) / 3);
      }
      const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
      heroPixelVariance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / Math.max(values.length, 1);
    }
    return {
      overflow: {
        body: document.body.scrollWidth - document.body.clientWidth,
        document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      },
      heroAsset,
      heroPixelVariance,
      nextSectionTop: howItWorks?.getBoundingClientRect().top ?? null,
      viewportHeight: window.innerHeight,
    };
  });

  if (layout.overflow.body > 1 || layout.overflow.document > 1) {
    throw new Error(`Horizontal overflow at ${viewport.width}px: ${JSON.stringify(layout.overflow)}`);
  }
  if (layout.heroAsset.width < 1000 || layout.heroAsset.height < 600 || layout.heroPixelVariance < 100) {
    throw new Error(`Hero asset is blank or undersized: ${JSON.stringify(layout)}`);
  }
  if (layout.nextSectionTop === null || layout.nextSectionTop >= layout.viewportHeight) {
    throw new Error(`Hero hides the next-section hint at ${viewport.width}px: ${JSON.stringify(layout)}`);
  }
  if (runtimeErrors.length > 0) {
    throw new Error(`Browser runtime errors: ${runtimeErrors.join(" | ")}`);
  }

  const viewportScreenshot = path.join(outputDir, name);
  const fullScreenshot = path.join(outputDir, name.replace(/\.png$/, "-full.png"));
  await page.screenshot({ path: viewportScreenshot });
  await page.screenshot({ path: fullScreenshot, fullPage: true });
  await context.close();
  return {
    screenshot: path.relative(process.cwd(), viewportScreenshot),
    fullScreenshot: path.relative(process.cwd(), fullScreenshot),
    viewport,
    ...layout,
  };
}

await fs.mkdir(outputDir, { recursive: true });
let preview;
let browser;
try {
  if (!externalBaseUrl) {
    preview = spawn(
      "npm",
      ["run", "-s", "preview", "--", "--host", "127.0.0.1", "--port", String(port)],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
  }
  await waitForServer(baseUrl);
  browser = await chromium.launch({ headless: true });
  const proofs = [
    await pageProof(browser, { width: 1440, height: 1000 }, "public-landing-desktop.png"),
    await pageProof(browser, { width: 390, height: 844 }, "public-landing-mobile.png"),
  ];
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    syntheticApiOnly: true,
    productionRequests: 0,
    externalActions: 0,
    proofs,
  };
  await fs.writeFile(
    path.join(outputDir, "public-landing-ui-proof.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  if (preview && !preview.killed) preview.kill("SIGTERM");
}
