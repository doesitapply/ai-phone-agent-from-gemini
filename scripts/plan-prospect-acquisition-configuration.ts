#!/usr/bin/env node
import {
  PROSPECT_ACQUISITION_CONFIGURATION_PLAN_CONTRACT,
  buildProspectAcquisitionConfigurationPlan,
  isProspectAcquisitionConfigurationPhase,
} from "../src/prospect-acquisition-configuration-plan.js";
import { PROSPECT_ACQUISITION_CONFIGURATION_PHASES } from "../src/prospect-acquisition-connection-readiness.js";
import { railwayVariables } from "./railway-json.mjs";

const processEnvironmentOnly = process.argv.includes("--process-env");
const phaseArgument = process.argv.find((argument) =>
  argument.startsWith("--phase=")
);
const rawPhase = phaseArgument?.slice("--phase=".length).trim() || "";

if (!isProspectAcquisitionConfigurationPhase(rawPhase)) {
  process.stdout.write(
    `${JSON.stringify(
      {
        contractVersion:
          PROSPECT_ACQUISITION_CONFIGURATION_PLAN_CONTRACT,
        ok: false,
        code: rawPhase ? "INVALID_PHASE" : "PHASE_REQUIRED",
        requestedPhase: rawPhase || null,
        allowedPhases: PROSPECT_ACQUISITION_CONFIGURATION_PHASES,
        guardrails: {
          providerMutationPerformed: false,
          deployPerformed: false,
          contactAuthorized: false,
          spendAuthorized: false,
        },
        externalAction: "none",
      },
      null,
      2
    )}\n`
  );
  process.exit(2);
}

let source: "railway-production-variables" | "process-environment" =
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
            PROSPECT_ACQUISITION_CONFIGURATION_PLAN_CONTRACT,
          ok: false,
          code: "RAILWAY_PRODUCTION_VARIABLES_UNAVAILABLE",
          phase: rawPhase,
          guardrails: {
            providerMutationPerformed: false,
            deployPerformed: false,
            contactAuthorized: false,
            spendAuthorized: false,
          },
          externalAction: "none",
        },
        null,
        2
      )}\n`
    );
    process.exit(1);
  }
}

const plan = buildProspectAcquisitionConfigurationPlan({
  phase: rawPhase,
  env,
  source,
});
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
if (!plan.safeStagingState) process.exitCode = 1;
