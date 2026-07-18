#!/usr/bin/env tsx
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buyerCallFlowDraft,
  setupCompletionIsReady,
  setupCompletionPrerequisites,
} from "../src/components/SetupWizard.js";
import { registerWorkspaceNotificationRoutes } from "../src/routes/workspace-notification-routes.js";
import { registerWorkspaceProfileRoutes } from "../src/routes/workspace-profile-routes.js";

const wizardSource = fs.readFileSync("src/components/SetupWizard.tsx", "utf8");
const notificationRouteSource = fs.readFileSync("src/routes/workspace-notification-routes.ts", "utf8");
const profileRouteSource = fs.readFileSync("src/routes/workspace-profile-routes.ts", "utf8");
const serverSource = fs.readFileSync("server.ts", "utf8");
const openApiSource = fs.readFileSync("openapi.yaml", "utf8");

for (const forbidden of [
  "SMIRK_SMART_BUSINESS_PROMPT",
  "Use SMIRK defaults",
  "settings/test/email",
  "setup_completed_at: new Date",
  "Activate Recovery",
  "Your agent is live",
  "existing-number forwarding",
  "TCPA compliance",
]) {
  assert.equal(wizardSource.includes(forbidden), false, `buyer wizard must not contain unsafe default or claim: ${forbidden}`);
}
for (const required of [
  'const [agentName, setAgentName] = useState("")',
  "const callFlowDraft = buyerCallFlowDraft(p)",
  'workspaceApi("/api/workspace/test-email"',
  'api<{ setup_readiness: SetupReadiness }>("/api/workspace/activation-status")',
  'workspaceApi<{ ok: boolean; setup_completed_at: string; ready_for_proof_call: boolean }>("/api/workspace/complete-setup"',
  'const PRE_COMPLETION_OUTCOME_KEYS = new Set(["setup_wizard", "fresh_proof_call"])',
  'disabled={completing || readinessBusy || !completionReady}',
]) {
  assert.equal(wizardSource.includes(required), true, `buyer wizard is missing fail-closed contract: ${required}`);
}

const freshBuyerDraft = buyerCallFlowDraft({
  agent_name: undefined,
  agent_persona: undefined,
  inbound_greeting: undefined,
  outbound_greeting: undefined,
});
assert.deepEqual(freshBuyerDraft, {
  agentName: "",
  agentPersona: "",
  inboundGreeting: "",
  outboundGreeting: "",
}, "a fresh Acme workspace must require tenant-specific call-flow input instead of inheriting SMIRK sales copy");
assert.equal(/SMIRK|197|smirkcalls\.com/i.test(JSON.stringify(freshBuyerDraft)), false, "fresh buyer draft must not contain SMIRK sales identity, price, or URL");

const authoritativeReadiness = {
  ready: false,
  completeCount: 2,
  totalCount: 4,
  nextAction: "Complete setup",
  items: [
    { key: "business_profile", label: "Business profile", complete: true, nextAction: "Save profile" },
    { key: "call_routing", label: "Call routing", complete: true, nextAction: "Connect routing" },
    { key: "setup_wizard", label: "Setup wizard", complete: false, nextAction: "Complete setup" },
    { key: "fresh_proof_call", label: "Fresh proof call", complete: false, nextAction: "Run proof" },
  ],
};
assert.deepEqual(
  setupCompletionPrerequisites(authoritativeReadiness).map((item) => item.key),
  ["business_profile", "call_routing"],
  "client completion gate must exclude only the completion marker and post-completion proof outcome",
);
assert.equal(setupCompletionIsReady(authoritativeReadiness), true, "all authoritative pre-completion items may enable the completion request");
assert.equal(
  setupCompletionIsReady({
    ...authoritativeReadiness,
    items: authoritativeReadiness.items.map((item) => item.key === "call_routing" ? { ...item, complete: false } : item),
  }),
  false,
  "one incomplete authoritative prerequisite must keep completion disabled",
);
assert.equal(setupCompletionIsReady({ ...authoritativeReadiness, items: [] }), false, "missing readiness evidence must fail closed");

const workspaceApiBlock = wizardSource.slice(
  wizardSource.indexOf("async function workspaceApi"),
  wizardSource.indexOf("// ── Step definitions"),
);
assert.equal(workspaceApiBlock.includes("X-Api-Key"), false, "buyer test-email helper must never send operator authentication");
assert.equal(workspaceApiBlock.includes("smirk_operator_session"), false, "buyer test-email helper must not read an operator session");

const markCompleteBlock = wizardSource.slice(
  wizardSource.indexOf("const markComplete = async"),
  wizardSource.indexOf("\n  if (!open)", wizardSource.indexOf("const markComplete = async")),
);
assert.equal(
  markCompleteBlock.includes('await workspaceApi<{ ok: boolean; setup_completed_at: string; ready_for_proof_call: boolean }>("/api/workspace/complete-setup"'),
  true,
  "setup completion must use the workspace-only client when operator and buyer sessions coexist",
);
assert.equal(
  markCompleteBlock.includes('await api<{ ok: boolean; setup_completed_at: string; ready_for_proof_call: boolean }>("/api/workspace/complete-setup"'),
  false,
  "setup completion must never use the mixed-session API helper",
);

for (const required of [
  'app.post("/api/workspace/test-email"',
  '(req as any).authMode !== "workspace"',
  'const recipient = String(workspace.notification_email || "").trim()',
  'to: [recipient]',
  'res.setHeader("Cache-Control", "no-store")',
]) {
  assert.equal(notificationRouteSource.includes(required), true, `workspace notification route is missing: ${required}`);
}
assert.equal(serverSource.includes("workspaceTestEmailRateLimit = rateLimit"), true, "workspace test email must be rate limited");
assert.equal(serverSource.includes("registerWorkspaceNotificationRoutes(app"), true, "workspace notification routes must be registered");
const completeSetupRouteBlock = profileRouteSource.slice(
  profileRouteSource.indexOf('app.post("/api/workspace/complete-setup"'),
  profileRouteSource.indexOf("\n  });", profileRouteSource.indexOf('app.post("/api/workspace/complete-setup"')) + 7,
);
assert.equal(completeSetupRouteBlock.includes('(req as any).authMode !== "workspace"'), true, "setup completion must reject operator auth");
assert.equal(completeSetupRouteBlock.includes('code: "WORKSPACE_AUTH_REQUIRED"'), true, "setup completion must expose the workspace-auth failure code");
const testEmailOpenApiBlock = openApiSource.slice(
  openApiSource.indexOf('  "/api/workspace/test-email":'),
  openApiSource.indexOf('  "/api/workspace/website-scan":'),
);
assert.equal(testEmailOpenApiBlock.includes("WorkspaceBearerAuth"), true, "test-email OpenAPI contract must require workspace auth");
assert.equal(testEmailOpenApiBlock.includes("ApiKeyAuth"), false, "test-email OpenAPI contract must not advertise operator auth");
const completeSetupOpenApiBlock = openApiSource.slice(
  openApiSource.indexOf('  "/api/workspace/complete-setup":'),
  openApiSource.indexOf('  "/api/workspace/generate-prompt":'),
);
assert.equal(completeSetupOpenApiBlock.includes("WorkspaceBearerAuth"), true, "setup-completion OpenAPI contract must require workspace auth");
assert.equal(completeSetupOpenApiBlock.includes("ApiKeyAuth"), false, "setup-completion OpenAPI contract must not advertise operator auth");

type CapturedResponse = { status: number; body: any; headers: Record<string, string> };

const originalFetch = globalThis.fetch;
let providerRequest: { url: string; body: any; authorization: string | null } | null = null;
let providerStatus = 200;

const registerFixture = (workspace: any, env: Record<string, string | undefined> = {}) => {
  let handler: ((req: any, res: any) => Promise<unknown>) | null = null;
  let middlewareCount = 0;
  const app = {
    post(path: string, ...handlers: any[]) {
      if (path === "/api/workspace/test-email") {
        middlewareCount = handlers.length;
        handler = handlers.at(-1);
      }
    },
  };
  const pass = (_req: any, _res: any, next: () => void) => next();
  registerWorkspaceNotificationRoutes(app as any, {
    dashboardAuth: pass,
    workspaceTestEmailRateLimit: pass,
    env,
    getWorkspaceById: async () => workspace,
    log: () => undefined,
  });
  assert.equal(middlewareCount, 3, "workspace test-email route must install auth and rate-limit middleware before its handler");
  assert.ok(handler, "workspace test-email route must register");
  return handler!;
};

const invoke = async (handler: (req: any, res: any) => Promise<unknown>, authMode: string, workspaceId = 41) => {
  const captured: CapturedResponse = { status: 200, body: null, headers: {} };
  const response = {
    setHeader(name: string, value: string) { captured.headers[name.toLowerCase()] = value; },
    status(status: number) { captured.status = status; return response; },
    json(body: any) { captured.body = body; return response; },
  };
  await handler({ authMode, workspaceAuth: authMode === "workspace" ? { id: workspaceId } : undefined, body: { email: "attacker@example.net" } }, response);
  return captured;
};

try {
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    providerRequest = {
      url: String(input),
      body: JSON.parse(String(init?.body || "{}")),
      authorization: new Headers(init?.headers).get("authorization"),
    };
    return new Response(providerStatus === 200 ? JSON.stringify({ id: "email_fixture_1" }) : "provider detail must stay private", {
      status: providerStatus,
      headers: { "content-type": "application/json" },
    });
  };

  const workspace = { id: 41, notification_email: "owner@acme-plumbing.test" };
  const env = { RESEND_API_KEY: "re_fixture", FROM_EMAIL: "SMIRK <alerts@smirkcalls.com>" };
  const handler = registerFixture(workspace, env);

  const operatorRejected = await invoke(handler, "operator");
  assert.equal(operatorRejected.status, 403, "operator auth alone must not authorize a buyer test email");
  assert.equal(operatorRejected.body.code, "WORKSPACE_AUTH_REQUIRED");
  assert.equal(providerRequest, null, "rejected operator request must not reach the email provider");

  const missingSavedRecipient = await invoke(registerFixture({ id: 41, notification_email: "" }, env), "workspace");
  assert.equal(missingSavedRecipient.status, 409, "workspace must save its notification address before testing it");
  assert.equal(missingSavedRecipient.body.code, "WORKSPACE_NOTIFICATION_EMAIL_REQUIRED");

  const providerNotConfigured = await invoke(registerFixture(workspace), "workspace");
  assert.equal(providerNotConfigured.status, 503, "missing sender configuration must fail closed");
  assert.equal(providerNotConfigured.body.code, "OWNER_ALERT_EMAIL_NOT_READY");

  providerRequest = null;
  const sent = await invoke(handler, "workspace");
  assert.equal(sent.status, 200);
  assert.equal(sent.body.ok, true);
  assert.equal(sent.headers["cache-control"], "no-store");
  assert.ok(providerRequest);
  assert.equal(providerRequest!.url, "https://api.resend.com/emails");
  assert.deepEqual(providerRequest!.body.to, [workspace.notification_email], "request body must not override the saved workspace recipient");
  assert.equal(providerRequest!.body.to.includes("attacker@example.net"), false, "arbitrary body recipient must be ignored");
  assert.equal(providerRequest!.authorization, "Bearer re_fixture");

  providerStatus = 422;
  const providerRejected = await invoke(handler, "workspace");
  assert.equal(providerRejected.status, 502);
  assert.equal(providerRejected.body.code, "OWNER_ALERT_TEST_FAILED");
  assert.equal(JSON.stringify(providerRejected.body).includes("provider detail"), false, "provider diagnostics must not leak to the buyer");
} finally {
  globalThis.fetch = originalFetch;
}

const completeReadinessItems = [
  "business_profile",
  "callback_phone",
  "service_area",
  "operating_hours",
  "greeting",
  "escalation_preference",
  "proof_call_target",
  "call_routing",
  "owner_notifications",
  "workspace_knowledge",
].map((key) => ({ key, label: key, complete: true, nextAction: "Complete setup" }));

const basePaidWorkspace = () => ({
  id: 41,
  slug: "acme-plumbing",
  name: "Acme Plumbing",
  owner_email: "owner@acme-plumbing.test",
  plan: "starter",
  stripe_customer_id: "cus_setup_fixture",
  stripe_subscription_id: "sub_setup_fixture",
  subscription_status: "active",
  monthly_call_limit: 100,
  monthly_minute_limit: 200,
  calls_this_month: 0,
  minutes_this_month: 0,
  api_key: "workspace_setup_fixture",
  timezone: "America/Los_Angeles",
  mode: "missed_call_recovery",
  business_name: "Acme Plumbing",
  business_phone: "+17754204485",
  business_website: "https://acme-plumbing.com/",
  business_address: "100 Main Street, Reno, NV",
  service_area: "Reno and Sparks, Nevada",
  business_hours: "Monday-Friday, 8 AM-5 PM",
  escalation_preference: "Call the owner immediately for urgent human requests.",
  proof_call_target: "+17754204485",
  agent_name: "Alex",
  agent_persona: "Calmly collect missed-call details and prepare an owner callback.",
  inbound_greeting: "Thanks for calling Acme Plumbing. How can I help today?",
  outbound_greeting: "Hi, this is Alex from Acme Plumbing following up on your request.",
  owner_phone: "+17754204485",
  notification_email: "owner@acme-plumbing.test",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

const registerProfileFixture = ({
  workspace,
  routingPhone = "+17754204486",
  readinessItems = completeReadinessItems,
}: {
  workspace: ReturnType<typeof basePaidWorkspace>;
  routingPhone?: string;
  readinessItems?: Array<{ key: string; label: string; complete: boolean; nextAction: string }>;
}) => {
  let completeHandler: ((req: any, res: any) => Promise<unknown>) | null = null;
  let patchHandler: ((req: any, res: any) => Promise<unknown>) | null = null;
  const updates: Array<Record<string, unknown>> = [];
  const app = {
    post(path: string, ...handlers: any[]) {
      if (path === "/api/workspace/complete-setup") completeHandler = handlers.at(-1);
    },
    patch(path: string, ...handlers: any[]) {
      if (path === "/api/workspace/profile") patchHandler = handlers.at(-1);
    },
    get() {},
  };
  const sql = (async (parts: TemplateStringsArray) => {
    const query = parts.join("?");
    if (query.includes("FROM workspace_phone_numbers")) return [{ phone_number: routingPhone }];
    if (query.includes("FROM workspace_knowledge_sources")) return [{ count: 1 }];
    if (query.includes("FROM provisioning_requests")) return [{ id: 7001 }];
    return [];
  }) as any;
  registerWorkspaceProfileRoutes(app as any, {
    dashboardAuth: (_req: any, _res: any, next: () => void) => next(),
    sql,
    dbEnabled: true,
    env: { TWILIO_PHONE_NUMBER: routingPhone },
    log: () => undefined,
    getWorkspaceId: () => workspace.id,
    getWorkspaceById: async () => workspace as any,
    updateWorkspace: async (_id, patch) => {
      updates.push(patch as Record<string, unknown>);
      Object.assign(workspace, patch);
    },
    createActivationEventIfChanged: async () => undefined,
    invalidateWorkspaceAiKeyCache: () => undefined,
    provisionWorkspaceTelephony: async () => ({ enabled: true, phoneNumber: routingPhone }),
    renderWorkspaceGreeting: () => "Fixture greeting",
    buildProofFreshness: () => ({}),
    buildSetupReadiness: () => ({
      ready: false,
      completeCount: readinessItems.filter((item) => item.complete).length,
      totalCount: readinessItems.length + 2,
      nextAction: "Complete setup",
      items: [
        ...readinessItems,
        { key: "setup_wizard", label: "Setup wizard", complete: false, nextAction: "Complete setup" },
        { key: "fresh_proof_call", label: "Fresh proof call", complete: false, nextAction: "Run proof" },
      ],
    }),
    buildActivationStatus: () => ({}),
    workspaceProfileCache: { delete: () => undefined },
  });
  assert.ok(completeHandler, "complete-setup route must register for behavior fixtures");
  assert.ok(patchHandler, "workspace profile patch route must register for behavior fixtures");
  return { completeHandler: completeHandler!, patchHandler: patchHandler!, updates };
};

const invokeProfileRoute = async (handler: (req: any, res: any) => Promise<unknown>, request: Record<string, unknown>) => {
  const captured: CapturedResponse = { status: 200, body: null, headers: {} };
  const response = {
    setHeader(name: string, value: string) { captured.headers[name.toLowerCase()] = value; return response; },
    status(status: number) { captured.status = status; return response; },
    json(body: any) { captured.body = body; return response; },
  };
  await handler(request, response);
  return captured;
};

const validCompletionFixture = registerProfileFixture({ workspace: basePaidWorkspace() });
const validCompletion = await invokeProfileRoute(validCompletionFixture.completeHandler, {
  authMode: "workspace",
  workspaceAuth: { id: 41 },
  body: {},
});
assert.equal(validCompletion.status, 200, "valid paid buyer setup must still complete");
assert.equal(validCompletion.body.ready_for_proof_call, true);
assert.equal(validCompletionFixture.updates.some((patch) => Boolean(patch.setup_completed_at)), true);

const malformedCompletionCases: Array<{
  label: string;
  patch: Record<string, unknown>;
  blocker: string;
  routingPhone?: string;
}> = [
  { label: "one-character business name", patch: { business_name: "x" }, blocker: "business_profile" },
  { label: "malformed owner email", patch: { owner_email: "x" }, blocker: "owner_notifications" },
  { label: "malformed notification email", patch: { notification_email: "x" }, blocker: "owner_notifications" },
  { label: "malformed owner phone", patch: { owner_phone: "x" }, blocker: "callback_phone" },
  { label: "malformed business phone", patch: { business_phone: "x" }, blocker: "callback_phone" },
  { label: "non-E.164 proof target", patch: { proof_call_target: "7754204485" }, blocker: "proof_call_target" },
  { label: "non-public business URL", patch: { business_website: "http://127.0.0.1/admin" }, blocker: "business_profile" },
  { label: "meaningless service area", patch: { service_area: "x" }, blocker: "service_area" },
  { label: "meaningless operating hours", patch: { business_hours: "x" }, blocker: "operating_hours" },
  { label: "meaningless inbound greeting", patch: { inbound_greeting: "x" }, blocker: "greeting" },
  { label: "meaningless outbound greeting", patch: { outbound_greeting: "x" }, blocker: "greeting" },
  { label: "meaningless escalation preference", patch: { escalation_preference: "x" }, blocker: "escalation_preference" },
  { label: "malformed Twilio routing number", patch: {}, blocker: "call_routing", routingPhone: "x" },
];

for (const testCase of malformedCompletionCases) {
  const workspace = Object.assign(basePaidWorkspace(), testCase.patch);
  const fixture = registerProfileFixture({ workspace, routingPhone: testCase.routingPhone });
  const result = await invokeProfileRoute(fixture.completeHandler, {
    authMode: "workspace",
    workspaceAuth: { id: workspace.id },
    body: {},
  });
  assert.equal(result.status, 409, `${testCase.label} must block complete-setup`);
  assert.equal(result.body.code, "SETUP_PREREQUISITES_INCOMPLETE");
  assert.equal(
    result.body.blockers.some((blocker: { key?: string }) => blocker.key === testCase.blocker),
    true,
    `${testCase.label} must expose the ${testCase.blocker} remediation key`,
  );
  assert.equal(fixture.updates.length, 0, `${testCase.label} must fail before setup_completed_at is written`);
}

const missingReadinessFixture = registerProfileFixture({ workspace: basePaidWorkspace(), readinessItems: [] });
const missingReadiness = await invokeProfileRoute(missingReadinessFixture.completeHandler, {
  authMode: "workspace",
  workspaceAuth: { id: 41 },
  body: {},
});
assert.equal(missingReadiness.status, 409, "missing authoritative readiness evidence must fail closed on the server");
assert.equal(missingReadiness.body.blockers.some((blocker: { key?: string }) => blocker.key === "setup_readiness"), true);

const buyerPatchFixture = registerProfileFixture({ workspace: basePaidWorkspace() });
const malformedBuyerPatch = await invokeProfileRoute(buyerPatchFixture.patchHandler, {
  authMode: "workspace",
  workspaceAuth: { id: 41 },
  body: { notification_email: "not-an-email", owner_phone: "call me" },
});
assert.equal(malformedBuyerPatch.status, 400, "workspace-auth profile writes must reject malformed setup values");
assert.equal(malformedBuyerPatch.body.code, "INVALID_BUYER_SETUP_FIELDS");
assert.deepEqual(
  malformedBuyerPatch.body.fields.map((issue: { field: string }) => issue.field).sort(),
  ["notification_email", "owner_phone"],
);
assert.equal(buyerPatchFixture.updates.length, 0, "malformed buyer fields must not reach persistence");

const normalizedBuyerPatchFixture = registerProfileFixture({ workspace: basePaidWorkspace() });
const normalizedBuyerPatch = await invokeProfileRoute(normalizedBuyerPatchFixture.patchHandler, {
  authMode: "workspace",
  workspaceAuth: { id: 41 },
  body: {
    owner_phone: "(775) 420-4485",
    proof_call_target: "1-775-420-4485",
    notification_email: " OWNER@ACME-PLUMBING.TEST ",
    business_website: "acme-plumbing.com",
  },
});
assert.equal(normalizedBuyerPatch.status, 200, "safe common buyer formats should normalize before persistence");
assert.deepEqual(normalizedBuyerPatchFixture.updates[0], {
  owner_phone: "+17754204485",
  proof_call_target: "+17754204485",
  notification_email: "owner@acme-plumbing.test",
  business_website: "https://acme-plumbing.com/",
});

const operatorPatchFixture = registerProfileFixture({ workspace: basePaidWorkspace() });
const operatorPatch = await invokeProfileRoute(operatorPatchFixture.patchHandler, {
  authMode: "operator",
  body: { business_name: "x" },
});
assert.equal(operatorPatch.status, 200, "operator profile repair behavior must remain unchanged");
assert.equal(operatorPatchFixture.updates[0]?.business_name, "x");

console.log("OK setup wizard uses tenant-specific inputs, validated buyer fields, workspace-auth email, and authoritative fail-closed readiness");
