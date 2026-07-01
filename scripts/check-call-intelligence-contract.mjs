#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
const fail = (message) => {
  console.error(`[check-call-intelligence] ${message}`);
  process.exitCode = 1;
};
const expect = (condition, message) => {
  if (!condition) fail(message);
};

const dashboardRoutes = read("src/routes/dashboard-routes.ts");
const app = read("src/App.tsx");
const db = read("src/db.ts");
const readiness = read("COMPETITIVE_READINESS.md");

expect(dashboardRoutes.includes('app.get("/api/call-intelligence", dashboardAuth'), "call intelligence endpoint must be dashboard-auth protected");
expect(db.includes("ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_url TEXT"), "calls.recording_url migration must exist for recording coverage");
for (const field of [
  "summaryCoverage",
  "transcriptCoverage",
  "recordingCoverage",
  "qaPassRate",
  "reviewQueue",
  "issueReasons",
  "outcomeCounts",
  "sentimentCounts",
]) {
  expect(dashboardRoutes.includes(field), `server response must include ${field}`);
}
expect(dashboardRoutes.includes("cs.sentiment IN ('negative', 'frustrated', 'angry')"), "review queue must flag negative/frustrated calls");
expect(dashboardRoutes.includes("COALESCE(hc.handoff_count, 0) > 0"), "review queue must flag human handoffs");
expect(dashboardRoutes.includes("COALESCE(cs.resolution_score, 0) < 0.7"), "review queue must flag low-resolution calls");

expect(app.includes('api<CallIntelligence>("/api/call-intelligence?days=30")'), "dashboard must load call intelligence endpoint");
for (const label of [
  "Call intelligence",
  "Summary coverage",
  "Transcript coverage",
  "Recording coverage",
  "QA pass rate",
  "Review queue",
  "Review Issues",
  "Low confidence",
  "Open call",
  "Reprocess",
]) {
  expect(app.includes(label), `dashboard must surface ${label}`);
}
expect(app.includes('onTabChange("review")'), "dashboard review button must route to the Review Issues page");
expect(app.includes("fallbackReviewIssueReasons"), "review UI must show actionable issue reasons");
expect(readiness.includes("call intelligence"), "competitive readiness doc must mention call intelligence");

if (process.exitCode) process.exit(process.exitCode);
console.log("[check-call-intelligence] call intelligence contract checks passed");
