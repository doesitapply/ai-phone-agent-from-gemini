#!/usr/bin/env node
import fs from "node:fs";

const server = fs.readFileSync("server.ts", "utf8");
const route = fs.readFileSync("src/routes/owner-control-routes.ts", "utf8");
const operatorRoutes = fs.readFileSync("src/routes/operator-routes.ts", "utf8");
const app = fs.readFileSync("src/App.tsx", "utf8");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const failures = [];

const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

expect(
  server.includes('const requireFullOperator = (req: Request, res: Response, next: NextFunction) => {')
    && server.includes('(req as any).authMode === "operator"')
    && server.includes('code: "FULL_OPERATOR_REQUIRED"'),
  "server must define a full-operator-only authorization gate"
);
expect(
  server.includes('import { registerOwnerControlRoutes } from "./src/routes/owner-control-routes.js";')
    && server.includes('registerOwnerControlRoutes(app, {\n  dashboardAuth,\n  requireFullOperator,'),
  "server must register owner control with the strict authorization gate"
);
expect(
  route.includes('app.get("/api/owner-control/overview", dashboardAuth, requireFullOperator')
    && route.includes('res.setHeader("Cache-Control", "no-store")'),
  "owner control overview must require authenticated full operator access and disable caching"
);
expect(
  route.includes('const cleanConfigInventory = (config: any[]) => config.map((item) => ({')
    && route.includes('exposure: "write_only_secret"')
    && !route.includes('value: item?.value')
    && !route.includes('res.json({ env'),
  "owner control must expose configuration state without returning raw values or environment objects"
);
expect(
  route.includes('const estimateTrackedVariableCost')
    && route.includes('Provider invoices and current provider balances remain the source of truth.'),
  "cost view must distinguish local estimates from authoritative provider billing"
);
expect(
  route.includes('id: "telegram_approval_guard"')
    && route.includes('env.TELEGRAM_WEBHOOK_SECRET')
    && route.includes('env.TELEGRAM_ALLOWED_USER_IDS')
    && route.includes('env.TELEGRAM_ALLOWED_CHAT_IDS'),
  "owner control must report the Telegram approval guard configuration"
);
expect(
  operatorRoutes.includes('"owner_control"') && operatorRoutes.includes('"admin_api"'),
  "full operator session must advertise the owner control capability"
);
const demoPages = operatorRoutes.match(/const demoOperatorPages = \[[\s\S]*?\n  \];/)?.[0] || "";
expect(!demoPages.includes('"owner_control"'), "demo operator pages must not include owner control");
expect(
  app.includes('"owner_control"')
    && app.includes('owner-control": "owner_control"')
    && app.includes('activeTab === \'owner_control\' && visibleForSession(\'owner_control\')')
    && app.includes('api<OwnerControlOverview>("/api/owner-control/overview")'),
  "frontend must route owner control through the full operator dashboard surface"
);
expect(
  pkg.scripts?.["check:owner-control"] === "node scripts/check-owner-control-contract.mjs && node --import tsx --test tests/owner_control_prospect_acquisition.test.ts",
  "package must expose the owner control contract check"
);
expect(
  pkg.scripts?.["check:owner-control-ui"] === "npm run -s build:frontend && node scripts/check-owner-control-ui.mjs",
  "package must expose the synthetic desktop and mobile owner-control UI proof"
);
expect(
  route.includes("buildOwnerProspectAcquisitionOverview")
    && route.includes("buildProspectAcquisitionConnectionReadiness")
    && route.includes("contactAuthorized: false as const")
    && route.includes("spendAuthorized: false as const")
    && route.includes('externalAction: "none" as const'),
  "owner control must expose redacted prospect acquisition readiness without execution authority"
);
expect(
  app.includes("Prospect acquisition control plane")
    && app.includes("Revenue-loop connections")
    && app.includes("Execution switches")
    && app.includes("Credential separation")
    && app.includes("External evidence unproven"),
  "owner control must render the prospect acquisition connections, switches, caps, and evidence boundary"
);

if (failures.length > 0) {
  console.error("FAIL owner control contract");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("PASS owner control contract");
