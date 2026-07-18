#!/usr/bin/env node
import fs from "node:fs";

const files = {
  server: fs.readFileSync("server.ts", "utf8"),
  authRoutes: fs.readFileSync("src/routes/auth-routes.ts", "utf8"),
  operatorRoutes: fs.readFileSync("src/routes/operator-routes.ts", "utf8"),
  workspaceAdminRoutes: fs.readFileSync("src/routes/workspace-admin-routes.ts", "utf8"),
  chat: fs.readFileSync("src/smirk-chat.ts", "utf8"),
  app: fs.readFileSync("src/App.tsx", "utf8"),
  pkg: fs.readFileSync("package.json", "utf8"),
};

const failures = [];
const expect = (label, condition) => {
  if (!condition) failures.push(label);
};

expect("server env schema exposes DEMO_OPERATOR_API_KEY", files.server.includes("DEMO_OPERATOR_API_KEY: z.string().optional()"));
expect("server env schema exposes DEMO_OPERATOR_EMAILS", files.server.includes("DEMO_OPERATOR_EMAILS: z.string().optional()"));
expect("server parses demo operator Google allowlist", files.server.includes("const googleDemoOperatorEmails = () => splitCsv(env.DEMO_OPERATOR_EMAILS);"));
expect("dashboardAuth recognizes demo_operator", files.server.includes('(req as any).authMode = "demo_operator";'));
expect("dashboardAuth uses timing-safe comparison for demo key", files.server.includes("timingSafeSecretEquals(providedApiKey, demoOperatorApiKey)"));
expect("dashboardAuth denies non-allowlisted demo requests", files.server.includes("isDemoOperatorRequestAllowed(req)") && files.server.includes("DEMO_OPERATOR_READ_ONLY"));
expect("demo guard evaluates full original URL for mounted middleware", files.server.includes("const dashboardRequestPath = (req: Request): string") && files.server.includes("req.originalUrl"));
expect("requireOperator allows demo_operator only after dashboardAuth guard", files.server.includes('(req as any).authMode === "operator" || (req as any).authMode === "demo_operator"'));

for (const action of [
  "POST /api/calls",
  "POST /api/sms/test",
  "POST /api/twilio/test-call",
  "POST /api/prospecting/campaigns/:id/auto-dial/start",
  "POST /api/leads/search/maps",
  "POST /api/workspaces",
  "POST /api/workspaces/:id/invite",
  "POST /api/workspace/proof-call/request",
  "POST /api/settings",
  "POST /api/openclaw/inject",
  "POST /api/launch/ledger",
]) {
  expect(`demo blocked action is documented: ${action}`, files.server.includes(`"${action}"`));
}

const allowedRoutesBlock = files.server.match(/const DEMO_OPERATOR_ALLOWED_ROUTES[\s\S]*?\n\];/)?.[0] || "";
expect("demo allowlist is present", allowedRoutesBlock.length > 0);
expect("demo allowlist permits read-only calls list", allowedRoutesBlock.includes('/^\\/api\\/calls$/'));
expect("demo allowlist permits read-only recovery queue", allowedRoutesBlock.includes('/^\\/api\\/recovery\\/queue$/'));
expect("demo allowlist permits read-only launch ledger", allowedRoutesBlock.includes('/^\\/api\\/launch\\/ledger$/'));
expect("demo allowlist permits read-only chat", allowedRoutesBlock.includes('{ method: "POST", pattern: /^\\/api\\/chat$/ }'));
expect("demo allowlist does not expose workspace API keys", !allowedRoutesBlock.includes("apikey"));
expect("demo allowlist does not expose settings", !allowedRoutesBlock.includes("\\/api\\/settings"));
expect("demo allowlist does not expose SMS safety or SMS test", !allowedRoutesBlock.includes("\\/api\\/sms"));

expect("auth routes accept DEMO_OPERATOR_API_KEY", files.authRoutes.includes("DEMO_OPERATOR_API_KEY?: string;"));
expect("auth routes accept googleDemoOperatorEmails", files.authRoutes.includes("googleDemoOperatorEmails: () => string[];"));
expect("auth routes can return demo_operator session", files.authRoutes.includes('role: "demo_operator"') && files.authRoutes.includes("spendRestricted: true"));

expect("operator session returns demo_operator", files.operatorRoutes.includes('role: "demo_operator"'));
expect("operator session advertises read_only_demo", files.operatorRoutes.includes('access: "read_only_demo"'));
expect("operator session lists blocked spend actions", files.operatorRoutes.includes("outbound_calls") && files.operatorRoutes.includes("sms") && files.operatorRoutes.includes("prospecting"));
expect("workspace list treats demo as operator access", files.workspaceAdminRoutes.includes('(req as any).authMode === "operator" || (req as any).authMode === "demo_operator"'));

expect("chat supports demo_operator access mode", files.chat.includes('export type ChatAccessMode = "operator" | "workspace" | "demo_operator";'));
expect("chat defines demo operator allowed tools", files.chat.includes("const DEMO_OPERATOR_ALLOWED_TOOLS = new Set("));
const demoChatBlock = files.chat.match(/const DEMO_OPERATOR_ALLOWED_TOOLS[\s\S]*?\n\]\);/)?.[0] || "";
expect("demo chat does not include make_call", !demoChatBlock.includes("make_call"));
expect("demo chat does not include create_task", !demoChatBlock.includes("create_task"));
expect("demo chat does not include update_setting", !demoChatBlock.includes("update_setting"));
expect("demo chat policy is read-only", files.chat.includes("demo-operator mode") && files.chat.includes("read-only lookup tools only"));

expect("frontend persists demo_operator role", files.app.includes('role: "operator" | "demo_operator";'));
expect("frontend has demo default tabs", files.app.includes("const DEMO_OPERATOR_DEFAULT_TABS"));
expect("frontend gates paid controls", files.app.includes("const canUsePaidControls = !isCustomerView && !isDemoOperator;"));
expect("frontend disables whisper for demo operators", files.app.includes("canWhisper={!!operatorSession && !isDemoOperator}"));
expect("frontend stores returned operator role", files.app.includes("normalizeOperatorRole(body.role)") && files.app.includes("normalizeOperatorRole(body.session.role)"));
expect("package exposes demo operator check", files.pkg.includes('"check:demo-operator-access": "node scripts/check-demo-operator-access.mjs"'));

if (failures.length > 0) {
  console.error("FAIL demo operator access contract");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("PASS demo operator access contract");
