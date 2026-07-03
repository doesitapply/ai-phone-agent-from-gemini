#!/usr/bin/env node
import { railwayProjectContext } from "./railway-json.mjs";

const expectedProject = process.env.EXPECTED_PROJECT || "ai-phone-agent";
const expectedEnvironment = process.env.EXPECTED_ENVIRONMENT || "production";
const expectedService = process.env.EXPECTED_SERVICE || "ai-phone-agent";

try {
  const context = railwayProjectContext();
  const projectName = String(context.project?.name || "");
  const environmentName = String(context.environment?.name || "");
  const serviceName = String(context.service?.name || "");

  console.log(`Project: ${projectName}`);
  console.log(`Environment: ${environmentName}`);
  console.log(`Service: ${serviceName}`);

  const ok =
    projectName === expectedProject &&
    environmentName === expectedEnvironment &&
    serviceName === expectedService;

  if (!ok) {
    console.error(JSON.stringify({
      ok: false,
      error: "railway-graphql-target-mismatch",
      expected: {
        project: expectedProject,
        environment: expectedEnvironment,
        service: expectedService,
      },
      actual: {
        project: projectName,
        environment: environmentName,
        service: serviceName,
      },
    }, null, 2));
    process.exit(1);
  }

  console.log("OK Railway GraphQL auth and target service access verified");
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: "railway-graphql-access-failed",
    detail: error?.detail || String(error?.message || error),
  }, null, 2));
  process.exit(1);
}
