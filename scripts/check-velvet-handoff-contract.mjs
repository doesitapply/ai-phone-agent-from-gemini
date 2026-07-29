#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const failures = [];
const expect = (label, condition) => {
  if (!condition) failures.push(label);
};

const route = read("src/routes/velvet-handoff-routes.ts");
const domain = read("src/velvet-handoff.ts");
const db = read("src/db.ts");
const server = read("server.ts");
const pkg = JSON.parse(read("package.json"));

expect("dedicated Velvet token is required", domain.includes("VELVET_ALCHEMY_HANDOFF_API_KEY"));
expect("configured workspace is required", domain.includes("VELVET_ALCHEMY_WORKSPACE_ID"));
expect("the route does not reuse a dashboard operator key", !route.includes("DASHBOARD_API_KEY"));
expect("the route validates a bearer token in constant time", route.includes("constantTimeSecretEquals(token, config.apiKey)"));
expect("the route validates a strict payload", route.includes("velvetHandoffPayloadSchema.safeParse(req.body)"));
expect("the route rejects cross-workspace payloads", route.includes("VELVET_ALCHEMY_WORKSPACE_MISMATCH"));
expect("the route returns a configuration error when unset", route.includes("VELVET_ALCHEMY_HANDOFF_NOT_CONFIGURED"));
expect("the route is rate limited", route.includes("velvetHandoffRateLimit"));
expect("the receiver persists idempotency receipts", db.includes("velvet_alchemy_handoff_receipts"));
expect("receipt uniqueness binds source and workspace", db.includes("UNIQUE (workspace_id, source, external_id)"));
expect("the receiver records a payload hash", domain.includes("buildVelvetHandoffPayloadHash"));
expect("reused external IDs cannot change payloads", route.includes("VELVET_ALCHEMY_IDEMPOTENCY_CONFLICT") && route.includes("existing.payload_hash !== input.payloadHash"));
expect("contact upserts use the live workspace-scoped unique key", route.includes("ON CONFLICT (workspace_id, phone_number) WHERE phone_number IS NOT NULL DO UPDATE"));
expect("the receiver registers with the app", server.includes("registerVelvetHandoffRoutes(app"));
expect("the app validates the dedicated env variables", server.includes("VELVET_ALCHEMY_HANDOFF_API_KEY: z.string().optional()"));
expect("package exposes Velvet handoff verification", pkg.scripts?.["check:velvet-handoff"] === "node scripts/check-velvet-handoff-contract.mjs && node --import tsx --test tests/velvet_handoff_route.test.ts");

if (failures.length) {
  console.error("Velvet handoff contract failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK Velvet Alchemy handoff contract is fail-closed, workspace-bound, and idempotent");
