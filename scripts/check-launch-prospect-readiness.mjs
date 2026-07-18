#!/usr/bin/env node
import {
  loadLaunchProspectRows,
  summarizeLaunchProspectReadiness,
} from "./lib/launch-prospect-readiness.mjs";

const minimumArg = process.argv.find((arg) => arg.startsWith("--require-min="));
const requiredMinimum = Math.max(1, Number.parseInt(minimumArg?.slice("--require-min=".length) || "1", 10) || 1);
const { files, rows } = loadLaunchProspectRows();
const summary = summarizeLaunchProspectReadiness(rows);
const readyCompanies = summary.evaluations
  .filter(({ readiness }) => readiness.execution_ready)
  .map(({ row, readiness }) => ({
    company: row.company,
    region: row.region,
    research_verified_at: readiness.research_verified_at,
  }));
const ok = summary.execution_ready_prospects >= requiredMinimum;

console.log(JSON.stringify({
  ok,
  offline: true,
  no_send: true,
  input_files: files,
  required_minimum: requiredMinimum,
  rows_reviewed: summary.rows_reviewed,
  researched_prospects: summary.researched_prospects,
  candidate_prospects: summary.candidate_prospects,
  execution_ready_prospects: summary.execution_ready_prospects,
  researched_only_prospects: summary.researched_only_prospects,
  progressed_or_non_candidate_prospects: summary.progressed_or_non_candidate_prospects,
  by_blocker: summary.by_blocker,
  ready_by_region: summary.ready_by_region,
  ready_companies: readyCompanies,
  note: "Execution readiness is evidence-backed and separate from researched-row count. This check performs no network access, outreach, ledger writes, calls, payments, or spend.",
}, null, 2));

if (!ok) process.exit(1);
