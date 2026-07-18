#!/usr/bin/env node
import { railwayProjectContext } from "./railway-json.mjs";
import {
  SMIRK_RAILWAY_PRODUCTION_TARGET,
  exactRailwayProductionTargetMatches,
} from "./lib/first-dollar-pending-env.mjs";

try {
  const expected = SMIRK_RAILWAY_PRODUCTION_TARGET;
  const context = railwayProjectContext({
    projectId: expected.projectId,
    serviceId: expected.serviceId,
    environmentId: expected.environmentId,
  });
  const evaluation = exactRailwayProductionTargetMatches(context);
  if (!evaluation.ok) {
    console.error(JSON.stringify({
      ok: false,
      error: "railway-production-target-mismatch",
      expected: evaluation.expected,
      actual: evaluation.actual,
    }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, target: evaluation.actual }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: "railway-production-target-unavailable",
    detail: error?.detail || String(error?.message || error),
  }, null, 2));
  process.exit(1);
}
