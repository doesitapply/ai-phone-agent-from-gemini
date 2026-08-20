#!/usr/bin/env node
import {
  PROSPECT_ACQUISITION_CONFIGURATION_PHASES,
  PROSPECT_ACQUISITION_CONNECTION_READINESS_CONTRACT,
  buildProspectAcquisitionConnectionReadiness,
  type ProspectAcquisitionConfigurationPhaseId,
  type ProspectAcquisitionConnectionReadiness,
} from "../src/prospect-acquisition-connection-readiness.js";
import {
  readVelvetRemoteConnectionProofConfig,
  verifyRemoteVelvetConnectionProof,
} from "../src/velvet-connection-proof.js";
import { railwayVariables } from "./railway-json.mjs";

const processEnvironmentOnly = process.argv.includes("--process-env");
const verifyVelvet = process.argv.includes("--verify-velvet");
const configurationPhaseArgument = process.argv.find((argument) =>
  argument.startsWith("--configuration-phase=")
);
const rawConfigurationPhase = configurationPhaseArgument
  ?.slice("--configuration-phase=".length)
  .trim();
const requestedConfigurationPhase =
  rawConfigurationPhase &&
  PROSPECT_ACQUISITION_CONFIGURATION_PHASES.includes(
    rawConfigurationPhase as ProspectAcquisitionConfigurationPhaseId
  )
    ? (rawConfigurationPhase as ProspectAcquisitionConfigurationPhaseId)
    : null;

if (rawConfigurationPhase && !requestedConfigurationPhase) {
  process.stdout.write(
    `${JSON.stringify(
      {
        contractVersion:
          "smirk.prospect-acquisition-configuration-phase.v1",
        ok: false,
        code: "INVALID_CONFIGURATION_PHASE",
        requestedConfigurationPhase: rawConfigurationPhase,
        allowedConfigurationPhases:
          PROSPECT_ACQUISITION_CONFIGURATION_PHASES,
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
  process.exit(2);
}

if (
  verifyVelvet &&
  requestedConfigurationPhase &&
  requestedConfigurationPhase !== "velvet-authority"
) {
  process.stdout.write(
    `${JSON.stringify(
      {
        contractVersion:
          "smirk.prospect-acquisition-remote-readiness.v2",
        ok: false,
        code: "REMOTE_PROOF_PHASE_NOT_SUPPORTED",
        requestedConfigurationPhase,
        supportedConfigurationPhase: "velvet-authority",
        requestsPerformed: 0,
        guardrails: {
          coldSmsAllowed: false,
          bulkEmailAllowed: false,
          automatedProspectDialingAllowed: false,
          qcMayAuthorizeContact: false,
          providerMutationPerformed: false,
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
            PROSPECT_ACQUISITION_CONNECTION_READINESS_CONTRACT,
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
    if (!requestedConfigurationPhase) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.ok) process.exitCode = 1;
    } else {
      const selected =
        report.configurationPhases[requestedConfigurationPhase];
      const phaseReport = {
        contractVersion:
          "smirk.prospect-acquisition-configuration-phase.v1",
        ok: selected.configurationReady,
        source,
        requestedConfigurationPhase,
        phase: selected,
        overallConnectionConfigurationReady: report.ok,
        guardrails: report.guardrails,
        unproven: report.unproven,
        externalAction: "none",
      };
      process.stdout.write(
        `${JSON.stringify(phaseReport, null, 2)}\n`
      );
      if (!phaseReport.ok) process.exitCode = 1;
    }
  } else {
    const localPhase = requestedConfigurationPhase
      ? report.configurationPhases[requestedConfigurationPhase]
      : null;
    const localConfigurationReady = localPhase
      ? localPhase.configurationReady
      : report.ok;
    const localBlockers = localPhase
      ? localPhase.blockers
      : report.blockers;
    const remoteVelvet = await verifyRemoteVelvetConnectionProof({
      config: readVelvetRemoteConnectionProofConfig(env),
      signal: AbortSignal.timeout(10_000),
    });
    const combined = {
      contractVersion:
        "smirk.prospect-acquisition-remote-readiness.v2",
      ok: localConfigurationReady && remoteVelvet.ok,
      source,
      requestedConfigurationPhase,
      localConfigurationReady,
      localPhase,
      overallConnectionConfigurationReady: report.ok,
      local: report,
      remoteVelvet,
      blockers: [
        ...new Set([
          ...localBlockers,
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
