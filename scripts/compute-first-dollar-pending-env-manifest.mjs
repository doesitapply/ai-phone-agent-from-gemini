#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  SMIRK_RAILWAY_PRODUCTION_TARGET,
  assignmentsFromNullDelimitedBuffer,
  computeFirstDollarPendingEnvManifest,
} from "./lib/first-dollar-pending-env.mjs";

try {
  const assignments = assignmentsFromNullDelimitedBuffer(readFileSync(0));
  const manifest = computeFirstDollarPendingEnvManifest({
    target: {
      projectId: String(process.env.SMIRK_PENDING_TARGET_PROJECT_ID || ""),
      projectName: SMIRK_RAILWAY_PRODUCTION_TARGET.projectName,
      serviceId: String(process.env.SMIRK_PENDING_TARGET_SERVICE_ID || ""),
      serviceName: SMIRK_RAILWAY_PRODUCTION_TARGET.serviceName,
      environmentId: String(process.env.SMIRK_PENDING_TARGET_ENVIRONMENT_ID || ""),
      environmentName: SMIRK_RAILWAY_PRODUCTION_TARGET.environmentName,
    },
    commit: process.env.SMIRK_PENDING_TARGET_COMMIT,
    assignments,
  });
  process.stdout.write([
    `digest=${manifest.digest}`,
    `key_list=${manifest.keyList}`,
    `commit=${manifest.commit}`,
    `assignment_count=${manifest.assignmentCount}`,
  ].join("\n") + "\n");
} catch (error) {
  console.error(`FAIL pending first-dollar env manifest: ${String(error?.message || error)}`);
  process.exit(1);
}
