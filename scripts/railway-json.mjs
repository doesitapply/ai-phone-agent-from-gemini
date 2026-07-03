import { execFileSync, spawnSync } from "node:child_process";

const defaultAttempts = Number(process.env.SMIRK_RAILWAY_JSON_ATTEMPTS || 4);
const defaultDelayMs = Number(process.env.SMIRK_RAILWAY_JSON_RETRY_DELAY_MS || 3000);
const defaultRailwayProjectId = process.env.SMIRK_RAILWAY_PROJECT_ID || process.env.RAILWAY_PROJECT_ID || "90599f03-6d6f-4044-8933-e0301be67a82";
const defaultRailwayServiceId = process.env.SMIRK_RAILWAY_SERVICE_ID || process.env.RAILWAY_SERVICE_ID || "96bcd6e7-9487-4197-bcd1-a6bd0546e6b2";
const defaultRailwayEnvironmentId = process.env.SMIRK_RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_ENVIRONMENT_ID || "";
const railwayGraphqlEndpoint = process.env.SMIRK_RAILWAY_GRAPHQL_ENDPOINT || "https://backboard.railway.app/graphql/v2";

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function loadRailwayAuth() {
  try {
    execFileSync(
      "bash",
      ["-lc", 'source ./scripts/load-railway-auth.sh >/dev/null 2>&1 && env | grep -E "^(RAILWAY_API_TOKEN|RAILWAY_TOKEN)="'],
      { encoding: "utf8" },
    )
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => {
        const eq = line.indexOf("=");
        if (eq === -1) return;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key && value && !process.env[key]) process.env[key] = value;
      });
  } catch {
    // Let the Railway CLI surface auth issues normally.
  }
}

function isRetryableRailwayOutput(text) {
  return /rate\s*limit|ratelimit|ratelimited|too many requests|econnreset|etimedout|timeout/i.test(String(text || ""));
}

function normalizeCliFailure(result, label) {
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  return {
    ok: false,
    label,
    status: result.status,
    signal: result.signal || null,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

export function railwayJson(args, options = {}) {
  loadRailwayAuth();
  const attempts = Math.max(1, Number(options.attempts || defaultAttempts));
  const delayMs = Math.max(0, Number(options.delayMs || defaultDelayMs));
  const label = options.label || `railway ${args.join(" ")}`;
  let lastFailure = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync("railway", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: options.maxBuffer || 1024 * 1024 * 8,
    });

    if (result.status === 0) {
      try {
        return JSON.parse(String(result.stdout || ""));
      } catch (error) {
        lastFailure = {
          ok: false,
          label,
          status: 0,
          error: "invalid-json",
          message: String(error?.message || error),
          stdout: String(result.stdout || "").trim(),
          stderr: String(result.stderr || "").trim(),
        };
      }
    } else {
      lastFailure = normalizeCliFailure(result, label);
    }

    const combined = `${lastFailure?.stdout || ""}\n${lastFailure?.stderr || ""}\n${lastFailure?.message || ""}`;
    if (attempt < attempts && isRetryableRailwayOutput(combined)) {
      if (options.quiet !== true) {
        console.error(`WARN ${label} failed with retryable Railway CLI output; retrying in ${delayMs}ms (${attempt}/${attempts})`);
      }
      sleepSync(delayMs);
      continue;
    }
    break;
  }

  const error = new Error(`${label} failed after ${attempts} attempt${attempts === 1 ? "" : "s"}`);
  error.detail = lastFailure;
  throw error;
}

export function railwayAuthToken() {
  loadRailwayAuth();
  return String(process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN || "").trim();
}

export function railwayGraphql(query, variables = {}, options = {}) {
  const token = railwayAuthToken();
  if (!token) {
    const error = new Error("Railway GraphQL auth missing");
    error.detail = { ok: false, error: "railway-graphql-auth-missing" };
    throw error;
  }

  const result = spawnSync("curl", [
    "-sS",
    "-m",
    String(options.timeoutSeconds || process.env.SMIRK_RAILWAY_GRAPHQL_TIMEOUT_SECONDS || 20),
    "-X",
    "POST",
    railwayGraphqlEndpoint,
    "-H",
    `Authorization: Bearer ${token}`,
    "-H",
    "Content-Type: application/json",
    "--data",
    JSON.stringify({ query, variables }),
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: options.maxBuffer || 1024 * 1024 * 8,
  });

  if (result.status !== 0) {
    const error = new Error("Railway GraphQL request failed");
    error.detail = {
      ok: false,
      error: "railway-graphql-request-failed",
      status: result.status,
      signal: result.signal || null,
      stdout: String(result.stdout || "").trim(),
      stderr: String(result.stderr || "").trim(),
    };
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout || ""));
  } catch (parseError) {
    const error = new Error("Railway GraphQL returned invalid JSON");
    error.detail = {
      ok: false,
      error: "railway-graphql-invalid-json",
      message: String(parseError?.message || parseError),
      stdout: String(result.stdout || "").trim().slice(0, 1000),
      stderr: String(result.stderr || "").trim(),
    };
    throw error;
  }

  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    const error = new Error("Railway GraphQL returned errors");
    error.detail = {
      ok: false,
      error: "railway-graphql-errors",
      errors: parsed.errors.map((entry) => ({
        message: entry?.message || String(entry),
        path: entry?.path || null,
      })),
    };
    throw error;
  }

  return parsed.data;
}

export function railwayProjectContext(options = {}) {
  const projectId = options.projectId || defaultRailwayProjectId;
  const serviceId = options.serviceId || defaultRailwayServiceId;
  const query = `
    query RailwayProjectContext($projectId: String!, $serviceId: String!) {
      project(id: $projectId) {
        id
        name
        primaryEnvironmentId
        environments(first: 20) { edges { node { id name } } }
        services(first: 20) { edges { node { id name } } }
      }
      service(id: $serviceId) { id name projectId }
    }
  `;
  const data = railwayGraphql(query, { projectId, serviceId }, options);
  const project = data?.project;
  const service = data?.service;
  const environments = project?.environments?.edges?.map((edge) => edge?.node).filter(Boolean) || [];
  const services = project?.services?.edges?.map((edge) => edge?.node).filter(Boolean) || [];
  const environmentId = options.environmentId || defaultRailwayEnvironmentId || project?.primaryEnvironmentId || environments[0]?.id || "";
  const environment = environments.find((entry) => entry.id === environmentId) || environments[0] || null;
  return {
    projectId,
    serviceId,
    environmentId,
    project,
    service,
    environment,
    environments,
    services,
  };
}

export function railwayVariablesGraphql(options = {}) {
  const context = railwayProjectContext(options);
  const query = `
    query RailwayVariables($projectId: String!, $serviceId: String!, $environmentId: String!) {
      variables(projectId: $projectId, serviceId: $serviceId, environmentId: $environmentId)
    }
  `;
  const data = railwayGraphql(query, {
    projectId: context.projectId,
    serviceId: context.serviceId,
    environmentId: context.environmentId,
  }, options);
  return data?.variables || {};
}

export function railwayVariables(options = {}) {
  try {
    return railwayJson(["variable", "list", "--json"], { ...options, label: options.label || "railway variable list --json" });
  } catch (error) {
    if (options.graphqlFallback === false) throw error;
    if (options.quiet !== true) {
      const detail = error?.detail ? JSON.stringify(error.detail) : String(error?.message || error);
      console.error(`WARN railway variable list --json failed; falling back to Railway GraphQL variables: ${detail}`);
    }
    return railwayVariablesGraphql(options);
  }
}

export function readRailwayEnvValue(key, options = {}) {
  try {
    const vars = railwayVariables(options);
    return String(vars[key] || "").trim();
  } catch (error) {
    if (options.quiet !== true) {
      const detail = error?.detail ? JSON.stringify(error.detail) : String(error?.message || error);
      console.error(`WARN unable to read Railway variable ${key}: ${detail}`);
    }
    return "";
  }
}

export function railwaySetVariable(name, value, options = {}) {
  loadRailwayAuth();
  const assignment = `${name}=${value}`;
  const result = spawnSync("railway", ["variable", "set", assignment], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: options.maxBuffer || 1024 * 1024 * 8,
  });

  if (result.status === 0) return { ok: true, method: "cli" };

  if (options.graphqlFallback === false) {
    const error = new Error("railway variable set failed");
    error.detail = normalizeCliFailure(result, `railway variable set ${name}=...`);
    throw error;
  }

  const context = railwayProjectContext(options);
  const mutation = `
    mutation RailwayVariableUpsert($input: VariableUpsertInput!) {
      variableUpsert(input: $input)
    }
  `;
  railwayGraphql(mutation, {
    input: {
      projectId: context.projectId,
      serviceId: context.serviceId,
      environmentId: context.environmentId,
      name,
      value,
      skipDeploys: Boolean(options.skipDeploys),
    },
  }, options);
  return { ok: true, method: "graphql", cliFailure: normalizeCliFailure(result, `railway variable set ${name}=...`) };
}

export function railwayDeployments(options = {}) {
  const context = railwayProjectContext(options);
  const query = `
    query RailwayDeployments($projectId: String!, $serviceId: String!, $environmentId: String!, $first: Int!) {
      deployments(first: $first, input: { projectId: $projectId, serviceId: $serviceId, environmentId: $environmentId }) {
        edges {
          node {
            id
            status
            createdAt
            updatedAt
            statusUpdatedAt
            serviceId
            environmentId
            meta
          }
        }
      }
    }
  `;
  const data = railwayGraphql(query, {
    projectId: context.projectId,
    serviceId: context.serviceId,
    environmentId: context.environmentId,
    first: Number(options.first || 20),
  }, options);
  return data?.deployments?.edges?.map((edge) => edge?.node).filter(Boolean) || [];
}
