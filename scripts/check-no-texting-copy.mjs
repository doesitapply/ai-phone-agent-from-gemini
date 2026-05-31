#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

const defaultFiles = [
  "README.md",
  "PRODUCT_PLAN.md",
  "SMIRK_DEMO_SOUL.md",
  "SOUL.md",
  "server.ts",
  "src/App.tsx",
  "src/components/SetupWizard.tsx",
  "src/db.ts",
  "src/function-calling.ts",
  "src/lead-hunter.ts",
  "src/settings.ts",
].map((filePath) => path.join(repoRoot, filePath));

const files = process.env.NO_TEXTING_COPY_FILES
  ? process.env.NO_TEXTING_COPY_FILES.split(path.delimiter)
      .filter(Boolean)
      .map((filePath) => path.resolve(filePath))
  : defaultFiles;

const bannedClaims = [
  ["call or text", /call\s+or\s+text/i],
  ["text back", /text\s*-?\s*back/i],
  ["text customers", /text\s+customers/i],
  ["automated text", /automated\s+text/i],
  ["send texts", /send\s+texts?/i],
  ["reply by text", /reply\s+by\s+text/i],
  ["reply here", /reply\s+here/i],
  ["Suggested reply", /Suggested\s+reply/i],
  ["SMS follow-up", /\bSMS\b.{0,24}follow-?up|follow-?up.{0,24}\bSMS\b/i],
  ["books appointments", /books\s+appointments/i],
  ["appointment booking", /appointment\s+booking/i],
  ["No-nonsense dispatch", /No-nonsense\s+dispatch/i],
  ["dispatch real workers", /dispatch\s+real\s+workers/i],
  ["owner or dispatcher", /owner\s+or\s+dispatcher/i],
  ["Owner / Dispatcher", /Owner\s*\/\s*Dispatcher/i],
];

const allowedNegativeContext =
  /\b(not|never|no|without|disabled|excluded|removed|replace|replaces|out of|does not include|do not promise|do not offer|deferred|unnecessary|not needed|irrelevant|optional only|no active product flow|intentionally narrow|must avoid|skipped)\b/i;

const failures = [];

for (const filePath of files) {
  if (!fs.existsSync(filePath)) continue;

  const relPath = path.relative(repoRoot, filePath);
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const [label, pattern] of bannedClaims) {
      if (pattern.test(line) && !allowedNegativeContext.test(line)) {
        failures.push(`${relPath}:${index + 1}: ${label}`);
      }
    }
  });
}

if (failures.length > 0) {
  console.error("FAIL excluded texting/dispatcher/scheduling promises found in SMIRK copy or prompts:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`OK no excluded texting/dispatcher/scheduling promises found in ${files.length} SMIRK copy/prompt files`);
