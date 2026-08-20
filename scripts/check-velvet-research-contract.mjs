#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const failures = [];
const expect = (label, condition) => {
  if (!condition) failures.push(label);
};

const route = read("src/routes/velvet-research-routes.ts");
const domain = read("src/velvet-research.ts");
const prospector = read("src/prospector.ts");
const server = read("server.ts");
const envExample = read(".env.example");
const openApiGenerator = read("scripts/generate-openapi.mjs");
const pkg = JSON.parse(read("package.json"));

expect("dedicated Velvet research token is required", domain.includes("VELVET_ALCHEMY_RESEARCH_API_KEY"));
expect("weak Velvet research tokens fail configuration", domain.includes("MINIMUM_API_KEY_LENGTH = 32"));
expect("configured research workspace is required", domain.includes("VELVET_ALCHEMY_RESEARCH_WORKSPACE_ID"));
expect("the research route does not reuse a dashboard key", !route.includes("DASHBOARD_API_KEY"));
expect("the research route does not reuse the callback handoff key", !domain.includes("VELVET_ALCHEMY_HANDOFF_API_KEY"));
expect("the research route validates a bearer token in constant time", route.includes("constantTimeSecretEquals(token, config.apiKey)"));
expect("the research route validates a strict payload", route.includes("velvetResearchPayloadSchema.safeParse(req.body)"));
expect("the research route rejects cross-workspace payloads", route.includes("VELVET_ALCHEMY_RESEARCH_WORKSPACE_MISMATCH"));
expect("the research route fails closed when unset", route.includes("VELVET_ALCHEMY_RESEARCH_NOT_CONFIGURED"));
expect("the research route requires durable storage", route.includes("VELVET_ALCHEMY_RESEARCH_STORAGE_REQUIRED"));
expect("the research route is rate limited", route.includes("velvetResearchRateLimit"));
expect("the receiver persists idempotency receipts", prospector.includes("velvet_alchemy_research_receipts"));
expect("receipt uniqueness binds source and workspace", prospector.includes("UNIQUE (workspace_id, source, external_id)"));
expect("the receiver records and compares a payload hash", domain.includes("buildVelvetResearchPayloadHash") && route.includes("existing.payload_hash !== input.payloadHash"));
expect("the receiver returns an explicit no-action result", route.includes('externalAction: "none"'));
expect("the receiver cannot create contacts", !route.includes("INSERT INTO contacts"));
expect("the receiver cannot create calls", !route.includes("INSERT INTO calls"));
expect("the receiver cannot create callback tasks", !route.includes("INSERT INTO tasks"));
expect("the receiver cannot create handoffs", !route.includes("INSERT INTO handoffs"));
expect("the receiver has no Twilio provider", !route.includes("twilio") && !route.includes("Twilio"));
expect("the receiver has no email or SMS provider", !route.includes("resend") && !route.includes("sendSms") && !route.includes("sendEmail"));
expect("the receiver registers with the app", server.includes("registerVelvetResearchRoutes(app"));
expect("the app validates the dedicated research env", server.includes("VELVET_ALCHEMY_RESEARCH_API_KEY: z.string().optional()"));
expect("the example env documents the dedicated research token", envExample.includes('VELVET_ALCHEMY_RESEARCH_API_KEY="generate-a-dedicated-research-token"'));
expect("OpenAPI identifies the dedicated research bearer scheme", openApiGenerator.includes("VelvetResearchBearerAuth"));
expect(
  "package exposes Velvet research verification",
  pkg.scripts?.["check:velvet-research"] === "node scripts/check-velvet-research-contract.mjs && node --import tsx --test tests/velvet_research_route.test.ts",
);

if (failures.length) {
  console.error("Velvet research contract failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK Velvet Alchemy research intake is fail-closed, workspace-bound, idempotent, and contact-free");
