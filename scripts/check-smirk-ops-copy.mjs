#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const opsRoot = path.resolve(repoRoot, "..", "ops");

const files = [
  "SMIRK_OUTREACH_BATCH_20.md",
  "SMIRK_GUMROAD_LISTING_DRAFT.md",
  "SMIRK_RUNBOOK.md",
  "SMIRK_48H_EXPERIMENT.md",
  "SMIRK_PRICING_AND_POSITIONING.md",
].map((file) => path.join(opsRoot, file));

const missing = files.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error("FAIL SMIRK ops copy files missing:");
  for (const file of missing) console.error(`- ${file}`);
  process.exit(1);
}

const output = execFileSync("node", ["scripts/check-no-texting-copy.mjs"], {
  cwd: repoRoot,
  encoding: "utf8",
  env: {
    ...process.env,
    NO_TEXTING_COPY_FILES: files.join(path.delimiter),
  },
});

process.stdout.write(output);
