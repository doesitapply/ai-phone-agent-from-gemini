#!/usr/bin/env node
import { readFileSync } from "node:fs";

const server = readFileSync("server.ts", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

function expect(label, condition) {
  if (!condition) {
    console.error(`[cors-security-contract] FAIL ${label}`);
    process.exitCode = 1;
  }
}

expect("production CORS must not default to permissive cors()", server.includes("const shouldRestrictCors = IS_PROD || corsAllowedOrigins.length > 0"));
expect("production CORS must include canonical SMIRK origins", server.includes('"https://smirkcalls.com"') && server.includes('"https://www.smirkcalls.com"'));
expect("CORS must allow configured landing origin", server.includes("process.env.PAGES_ALLOWED_ORIGIN") && server.includes("process.env.LANDING_APP_URL"));
expect("CORS must allow workspace and operator auth headers", server.includes('"x-api-key"') && server.includes('"x-workspace-id"'));
expect("server-to-server requests without Origin remain allowed", server.includes("if (!origin) return cb(null, true);"));
expect("post-deploy live gate must include CORS security contract", String(pkg.scripts?.["check:post-deploy-live"] || "").includes("check:cors-security"));
expect("pre-proof-call live gate must include CORS security contract", String(pkg.scripts?.["check:pre-proof-call-live"] || "").includes("check:cors-security"));

if (!process.exitCode) {
  console.log("OK production CORS defaults to known SMIRK origins and preserves authenticated browser headers");
}
