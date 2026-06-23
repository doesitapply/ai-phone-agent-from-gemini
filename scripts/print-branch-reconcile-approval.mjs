#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const markdownPath = "output/branch-reconcile-approval.md";

function fail(message, detail = {}) {
  console.error(JSON.stringify({ ok: false, message, detail }, null, 2));
  process.exit(1);
}

if (!existsSync(markdownPath)) {
  fail("missing branch reconciliation approval packet", {
    markdownPath,
    nextAction:
      "Run npm run -s write:branch-reconcile-approval, then rerun npm run -s print:branch-reconcile-approval.",
  });
}

try {
  const raw = execFileSync("npm", ["run", "-s", "check:branch-reconcile-approval"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const check = JSON.parse(raw || "{}");
  if (check.ok !== true) {
    fail("branch reconciliation approval packet is stale or unsafe to print", {
      markdownPath,
      check,
    });
  }
} catch (error) {
  const raw = String(error?.stdout || error?.stderr || "").trim();
  let detail = raw;
  try {
    detail = raw ? JSON.parse(raw) : detail;
  } catch {
    // Keep the raw diagnostic when the checker did not return JSON.
  }
  fail("branch reconciliation approval packet is stale or unsafe to print", {
    markdownPath,
    detail,
    nextAction:
      "Run npm run -s write:branch-reconcile-approval, then rerun npm run -s print:branch-reconcile-approval.",
  });
}

const packet = readFileSync(markdownPath, "utf8");
process.stdout.write(packet.endsWith("\n") ? packet : `${packet}\n`);
