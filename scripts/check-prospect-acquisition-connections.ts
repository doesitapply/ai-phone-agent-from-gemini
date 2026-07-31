#!/usr/bin/env node
import {
  buildProspectAcquisitionConnectionReadiness,
  type ProspectAcquisitionConnectionReadiness,
} from "../src/prospect-acquisition-connection-readiness.js";
import { railwayVariables } from "./railway-json.mjs";

const processEnvironmentOnly = process.argv.includes("--process-env");
let source: ProspectAcquisitionConnectionReadiness["source"] =
  "railway-production-variables";
let env: Record<string, string | undefined>;

if (processEnvironmentOnly) {
  source = "process-environment";
  env = process.env;
} else {
  try {
    env = railwayVariables({
      quiet: true,
      attempts: 2,
      delayMs: 1_000,
    });
  } catch {
    process.stdout.write(
      `${JSON.stringify(
        {
          contractVersion:
            "smirk.prospect-acquisition-connections.v1",
          ok: false,
          source,
          code: "RAILWAY_PRODUCTION_VARIABLES_UNAVAILABLE",
          blockers: ["RAILWAY_PRODUCTION_VARIABLES_UNAVAILABLE"],
          guardrails: {
            coldSmsAllowed: false,
            bulkEmailAllowed: false,
            automatedProspectDialingAllowed: false,
            providerMutationPerformed: false,
          },
          externalAction: "none",
        },
        null,
        2
      )}\n`
    );
    process.exitCode = 1;
    env = {};
  }
}

if (Object.keys(env).length > 0) {
  const report = buildProspectAcquisitionConnectionReadiness({
    env,
    source,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}
