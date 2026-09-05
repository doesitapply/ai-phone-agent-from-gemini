#!/usr/bin/env node
import fs from "node:fs";

const app = fs.readFileSync("src/App.tsx", "utf8");
const componentNames = ["RevenueWorkspacePage", "VelvetAlchemyPage"];
const failures = [];

function extractFunctionBlock(source, name) {
  const signature = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(source);
  if (!signature) return null;

  const openingBrace = source.indexOf("{", signature.index + signature[0].length);
  if (openingBrace < 0) return null;

  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openingBrace; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(signature.index, index + 1);
    }
  }

  return null;
}

const componentName = componentNames.find((name) => (
  new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(app)
));
const pageBlock = componentName ? extractFunctionBlock(app, componentName) : null;

if (!componentName) {
  failures.push(`missing Revenue Workspace component (${componentNames.join(" or ")})`);
} else if (!pageBlock) {
  failures.push(`could not isolate the ${componentName} source block`);
}

if (pageBlock) {
  const hasAcquisitionList = /["'`]\/api\/acquisitions["'`]/.test(pageBlock);
  const hasAcquisitionDetail = pageBlock.includes("/api/acquisitions/:id")
    || /`\/api\/acquisitions\/\$\{/.test(pageBlock)
    || /["']\/api\/acquisitions\/["']\s*\+/.test(pageBlock);

  if (!hasAcquisitionList) failures.push(`${componentName} must read /api/acquisitions`);
  if (!hasAcquisitionDetail) failures.push(`${componentName} must read /api/acquisitions/:id`);
  if (!/\breceiverReady\b/.test(pageBlock)) failures.push(`${componentName} must render receiverReady`);

  const forbidden = [
    ["prospecting navigation", /\/dashboard\/prospecting/i, "/dashboard/prospecting"],
    ["auto-dial action", /\/auto-dial(?:\/|["'`])|autoDial|AutoDial|\bauto_dial\b/, "auto-dial"],
    ["call action", /\/api\/calls(?:\/|[?"'`])/i, "/api/calls"],
    ["checkout action", /\/api\/checkout\/create\b/i, "/api/checkout/create"],
    ["outreach approval action", /\/api\/launch\/approvals\/prepare\b/i, "/api/launch/approvals/prepare"],
  ];
  for (const [label, pattern, marker] of forbidden) {
    if (pattern.test(pageBlock)) {
      failures.push(`${componentName} contains forbidden ${label}: ${marker}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Velvet operator UI contract failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`OK ${componentName} is acquisition-read-only and exposes receiver readiness`);
