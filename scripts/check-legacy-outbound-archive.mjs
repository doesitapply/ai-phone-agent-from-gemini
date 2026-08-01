#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { auditLegacyOutboundArchive } from "./lib/legacy-outbound-archive.mjs";

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a file path.`);
  }
  return value;
}

try {
  const ledgerPath = path.resolve(
    argValue("--ledger", "outbound/campaign_ledger.csv"),
  );
  const suppressionPath = path.resolve(
    argValue("--suppression", "outbound/suppression.txt"),
  );
  const result = auditLegacyOutboundArchive({
    ledgerText: fs.readFileSync(ledgerPath, "utf8"),
    suppressionText: fs.readFileSync(suppressionPath, "utf8"),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    contractVersion: "smirk.legacy-outbound-archive-audit.v1",
    ok: false,
    blockers: ["LEGACY_OUTBOUND_ARCHIVE_UNREADABLE"],
    error: error instanceof Error ? error.message : String(error),
    externalAction: "none",
  }, null, 2));
  process.exitCode = 1;
}
