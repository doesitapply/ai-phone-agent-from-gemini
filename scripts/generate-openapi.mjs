#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outputPath = path.join(root, "openapi.yaml");
const sourceFiles = [
  "server.ts",
  "src/team-routes.ts",
  ...fs.readdirSync(path.join(root, "src", "routes"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join("src", "routes", entry.name)),
];
const checkOnly = process.argv.includes("--check");

const methodRegex = /\bapp\.(get|post|patch|put|delete|use)\(\s*(?:"([^"]+)"|'([^']+)'|\[([^\]]+)\])/g;
const quotedPathRegex = /["']([^"']+)["']/g;

const manualDescriptions = new Map();
const signedWebhookPaths = new Set([
  "/api/calendly/webhook",
  "/api/stripe/webhook",
  "/api/twilio/amd",
  "/api/twilio/incoming",
  "/api/twilio/process",
  "/api/twilio/response",
  "/api/twilio/status",
  "/api/twilio/voicemail",
  "/api/sms/incoming",
  "/api/sms/status",
]);
const operatorOnlyPaths = new Set([
  "GET /api/analytics/agents",
  "GET /api/admin/webhook-buffer-lag",
  "GET /api/agents",
  "GET /api/agents/:id",
  "GET /api/agents/active",
  "GET /api/campaigns",
  "GET /api/chat/debug-context",
  "GET /api/compliance/audit",
  "GET /api/compliance/dnc",
  "POST /api/contacts/:id/dnc",
  "DELETE /api/contacts/:id/dnc",
  "GET /api/events",
  "GET /api/field-definitions",
  "GET /api/integrations/crm",
  "GET /api/integrations/webhook",
  "GET /api/integrations/webhook/deliveries",
  "GET /api/leads",
  "GET /api/leads/alerts",
  "GET /api/leads/funnel",
  "GET /api/leads/scoreboard",
  "GET /api/mcp",
  "GET /api/mcp-servers",
  "GET /api/plugin-tools",
  "GET /api/prospecting/campaigns",
  "GET /api/prospecting/campaigns/:id",
  "GET /api/prospecting/campaigns/:id/auto-dial/status",
  "GET /api/prospecting/leads",
  "GET /api/prospecting/leads/:id/sequence",
  "GET /api/prospecting/sequence-templates",
  "GET /api/prospecting/sequences/stats",
  "GET /api/settings/groups",
  "GET /api/summaries",
  "GET /api/sms/safety",
  "GET /api/tools",
  "DELETE /api/calls",
  "DELETE /api/calls/:sid",
  "DELETE /api/agents/:id",
  "DELETE /api/compliance/dnc/:phone",
  "DELETE /api/field-definitions/:key",
  "DELETE /api/team/:id",
  "PATCH /api/calls/fix-stale",
  "PATCH /api/appointments/:id",
  "PATCH /api/agents/:id",
  "PATCH /api/team/:id",
  "PATCH /api/team/:id/oncall",
  "POST /api/agents",
  "POST /api/admin/webhook-buffer-replay",
  "POST /api/team",
  "POST /api/calls/:sid/reprocess",
  "POST /api/calls/fix-stale",
  "POST /api/appointments",
  "POST /api/calendar/test-booking",
  "POST /api/compliance/check",
  "POST /api/compliance/dnc",
  "POST /api/field-definitions",
  "POST /api/leads",
  "POST /api/leads/upsert",
  "DELETE /api/mcp/:id",
  "DELETE /api/mcp-servers/:id",
  "DELETE /api/plugin-tools/:id",
  "DELETE /api/tools/:id",
  "POST /api/integrations/crm/test",
  "POST /api/integrations/webhook/test",
  "POST /api/mcp",
  "POST /api/mcp/:id/test",
  "POST /api/mcp-servers",
  "POST /api/plugin-tools",
  "POST /api/prospecting/campaigns",
  "POST /api/prospecting/campaigns/:id/auto-dial/start",
  "POST /api/prospecting/campaigns/:id/auto-dial/stop",
  "POST /api/prospecting/campaigns/:id/dial-next",
  "POST /api/prospecting/campaigns/:id/leads",
  "POST /api/prospecting/campaigns/:id/search",
  "POST /api/recovery/direct-dial",
  "POST /api/leads/search/apollo",
  "POST /api/leads/search/maps",
  "POST /api/leads/personalize",
  "POST /api/sms/test",
  "POST /api/campaigns",
  "POST /api/campaigns/:id/launch",
  "POST /api/tools",
  "POST /api/tools/:id/test",
  "POST /api/twilio/test-call",
  "POST /api/twilio/test-webhook",
  "PATCH /api/prospecting/campaigns/:id/status",
  "PATCH /api/prospecting/leads/:id",
  "DELETE /api/prospecting/leads/:id/sequence",
  "PUT /api/mcp/:id",
  "PUT /api/mcp-servers/:id",
  "PUT /api/plugin-tools/:id",
  "PUT /api/tools/:id",
  "PUT /api/agents/:id",
  "PUT /api/agents/:id/activate",
]);

const publicRateLimitedMarkers = new Set([
  "publicDemoRateLimit",
  "launchEventRateLimit",
]);

function readPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  return packageJson.version ?? "0.0.0";
}

function expressPathToOpenApi(expressPath) {
  return expressPath
    .replace(/\/\*/g, "/{wildcard}")
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function routeTag(openApiPath) {
  const parts = openApiPath.split("/").filter(Boolean);
  if (parts[0] !== "api") return "app";
  if (!parts[1]) return "api";
  if (parts[1] === "workspace" && parts[2]) return `workspace-${parts[2]}`;
  return parts[1].replace(/[{}]/g, "");
}

function securityFor(method, expressPath, sourceLine) {
  if (expressPath.includes("/auth/google") || expressPath === "/api/version" || expressPath === "/api/pricing") return [];
  if (expressPath.includes("/provisioning/checkout-status") || expressPath.includes("/public-proof-snapshot") || expressPath.includes("/first-dollar-readiness")) return [];
  if ([...publicRateLimitedMarkers].some((marker) => sourceLine.includes(marker))) return [];
  if (sourceLine.includes("requireOperator") || expressPath.includes("/operator")) return [{ ApiKeyAuth: [] }];
  if (sourceLine.includes("provisioningBearerAuth")) return [{ ProvisioningBearerAuth: [] }];
  if (sourceLine.includes("dashboardAuth") || expressPath.includes("/workspace")) return [{ WorkspaceBearerAuth: [] }, { ApiKeyAuth: [] }];
  if (signedWebhookPaths.has(expressPath) || expressPath.includes("/webhooks/")) return [];
  if (method === "USE") return [];
  return [{ ApiKeyAuth: [] }];
}

function validateSecurityInventory(routes) {
  const failures = [];
  for (const route of routes) {
    const security = securityFor(route.method, route.expressPath, route.sourceLine);
    const securityLabel = security.length === 0 ? "public" : Object.keys(security[0] || {}).join(",");
    const routeKey = `${route.method} ${route.expressPath}`;
    if (operatorOnlyPaths.has(routeKey) && !route.sourceLine.includes("requireOperator")) {
      failures.push(`${routeKey} must include requireOperator in openapi.yaml inventory`);
    }
    if (signedWebhookPaths.has(route.expressPath) && security.length !== 0) {
      failures.push(`${route.expressPath} should be listed as a public signed webhook, got ${securityLabel}`);
    }
  }
  return failures;
}

function collectRoutes() {
  const routes = [];
  for (const sourceFile of sourceFiles) {
    const absolutePath = path.join(root, sourceFile);
    const text = fs.readFileSync(absolutePath, "utf8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      methodRegex.lastIndex = 0;
      let match;
      while ((match = methodRegex.exec(line)) !== null) {
        const method = match[1].toUpperCase();
        const directPath = match[2] ?? match[3];
        const arrayPaths = match[4];
        const paths = [];
        if (directPath) {
          paths.push(directPath);
        } else if (arrayPaths) {
          quotedPathRegex.lastIndex = 0;
          let pathMatch;
          while ((pathMatch = quotedPathRegex.exec(arrayPaths)) !== null) {
            paths.push(pathMatch[1]);
          }
        }
        for (const expressPath of paths) {
          if (!expressPath.startsWith("/api")) continue;
          routes.push({
            method,
            expressPath,
            openApiPath: expressPathToOpenApi(expressPath),
            sourceFile,
            lineNumber: i + 1,
            sourceLine: line.trim(),
          });
        }
      }
    }
  }
  return routes;
}

function yamlScalar(value) {
  return JSON.stringify(String(value));
}

function concreteEndpointRoutes(routes) {
  return routes.filter((route) => route.method !== "USE");
}

function renderOpenApi(routes) {
  const endpointRoutes = concreteEndpointRoutes(routes);
  const sortedRoutes = [...endpointRoutes].sort((a, b) => {
    const pathCompare = a.openApiPath.localeCompare(b.openApiPath);
    if (pathCompare !== 0) return pathCompare;
    return a.method.localeCompare(b.method);
  });
  const grouped = new Map();
  for (const route of sortedRoutes) {
    const method = route.method.toLowerCase();
    if (!grouped.has(route.openApiPath)) grouped.set(route.openApiPath, []);
    grouped.get(route.openApiPath).push({ ...route, openApiMethod: method });
  }

  const lines = [
    "# Generated by scripts/generate-openapi.mjs. Do not edit by hand.",
    "openapi: 3.1.0",
    "info:",
    "  title: SMIRK API",
    `  version: ${yamlScalar(readPackageVersion())}`,
    "  description: Route inventory generated from concrete Express route declarations in server.ts and src/team-routes.ts. Middleware app.use declarations are excluded from paths.",
    "servers:",
    "  - url: https://smirkcalls.com",
    "    description: Production",
    "  - url: http://localhost:3000",
    "    description: Local development",
    "components:",
    "  securitySchemes:",
    "    ApiKeyAuth:",
    "      type: apiKey",
    "      in: header",
    "      name: x-api-key",
    "    WorkspaceBearerAuth:",
    "      type: http",
    "      scheme: bearer",
    "      bearerFormat: Workspace session or invite token",
    "    ProvisioningBearerAuth:",
    "      type: http",
    "      scheme: bearer",
    "      bearerFormat: Provisioning token",
    "paths:",
  ];

  for (const [openApiPath, entries] of grouped.entries()) {
    lines.push(`  ${yamlScalar(openApiPath)}:`);
    for (const entry of entries) {
      lines.push(`    ${entry.openApiMethod}:`);
      lines.push(`      operationId: ${yamlScalar(`${entry.method}_${entry.expressPath}`.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, ""))}`);
      lines.push(`      tags:`);
      lines.push(`        - ${yamlScalar(routeTag(openApiPath))}`);
      lines.push(`      summary: ${yamlScalar(`${entry.method} ${entry.expressPath}`)}`);
      lines.push(`      x-source: ${yamlScalar(`${entry.sourceFile}:${entry.lineNumber}`)}`);
      lines.push(`      x-express-path: ${yamlScalar(entry.expressPath)}`);
      const security = securityFor(entry.method, entry.expressPath, entry.sourceLine);
      if (security.length === 0) {
        lines.push("      security: []");
      } else {
        lines.push("      security:");
        for (const requirement of security) {
          const [name] = Object.keys(requirement);
          lines.push(`        - ${name}: []`);
        }
      }
      lines.push("      responses:");
      lines.push("        \"200\":");
      lines.push("          description: Success response. Body shape is implemented in the route handler.");
      lines.push("        \"400\":");
      lines.push("          description: Bad request or validation failure.");
      lines.push("        \"401\":");
      lines.push("          description: Authentication required or invalid credentials.");
      lines.push("        \"500\":");
      lines.push("          description: Server error.");
    }
  }

  if (manualDescriptions.size > 0) {
    lines.push("x-api-gaps:");
    for (const [route, description] of manualDescriptions.entries()) {
      lines.push(`  - route: ${yamlScalar(route)}`);
      lines.push(`    description: ${yamlScalar(description)}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}`;
}

const routes = collectRoutes();
const endpointRoutes = concreteEndpointRoutes(routes);
const securityInventoryFailures = validateSecurityInventory(routes);
if (securityInventoryFailures.length > 0) {
  console.error("OpenAPI security inventory failed:");
  for (const failure of securityInventoryFailures) console.error(`- ${failure}`);
  process.exit(1);
}
const rendered = renderOpenApi(routes);
if (rendered.includes("x-express-use")) {
  console.error("OpenAPI output must not include Express middleware pseudo-operations.");
  process.exit(1);
}

if (checkOnly) {
  const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  if (existing !== rendered) {
    console.error("openapi.yaml is stale. Run npm run generate:openapi.");
    process.exit(1);
  }
  console.log(`OK openapi.yaml matches ${endpointRoutes.length} concrete API route declarations`);
} else {
  fs.writeFileSync(outputPath, rendered);
  console.log(`Wrote openapi.yaml with ${endpointRoutes.length} concrete API route declarations`);
}
