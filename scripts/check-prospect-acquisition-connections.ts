#!/usr/bin/env node
import {
  buildProspectAcquisitionConnectionReadiness,
  type ProspectAcquisitionConnectionReadiness,
} from "../src/prospect-acquisition-connection-readiness.js";
import {
  readVelvetRemoteConnectionProofConfig,
  verifyRemoteVelvetConnectionProof,
} from "../src/velvet-connection-proof.js";
import { railwayVariables } from "./railway-json.mjs";

const processEnvironmentOnly = process.argv.includes("--process-env");
const verifyVelvet = process.argv.includes("--verify-velvet");
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
            "smirk.prospect-acquisition-connections.v2",
          ok: false,
          source,
          code: "RAILWAY_PRODUCTION_VARIABLES_UNAVAILABLE",
          blockers: ["RAILWAY_PRODUCTION_VARIABLES_UNAVAILABLE"],
          guardrails: {
            coldSmsAllowed: false,
            bulkEmailAllowed: false,
            automatedProspectDialingAllowed: false,
            qcMayAuthorizeContact: false,
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
  if (!verifyVelvet) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } else {
    const remoteVelvet = await verifyRemoteVelvetConnectionProof({
      config: readVelvetRemoteConnectionProofConfig(env),
      signal: AbortSignal.timeout(10_000),
    });
    const combined = {
      contractVersion:
        "smirk.prospect-acquisition-remote-readiness.v1",
      ok: report.ok && remoteVelvet.ok,
      source,
      local: report,
      remoteVelvet,
      blockers: [
        ...new Set([
          ...report.blockers,
          ...remoteVelvet.blockers,
        ]),
      ].sort(),
      guardrails: {
        coldSmsAllowed: false,
        bulkEmailAllowed: false,
        automatedProspectDialingAllowed: false,
        qcMayAuthorizeContact: false,
        providerMutationPerformed: false,
        contactAuthorized: false,
        spendAuthorized: false,
      },
      externalAction:
        remoteVelvet.requestsPerformed === 2
          ? "read-only-remote-connection-proof"
          : "none",
    };
    process.stdout.write(
      `${JSON.stringify(combined, null, 2)}\n`
    );
    if (!combined.ok) process.exitCode = 1;
  }
}
