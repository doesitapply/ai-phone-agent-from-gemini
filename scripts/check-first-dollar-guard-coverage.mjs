#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const read = (path) => readFileSync(path, 'utf8');

const checks = [
  {
    label: 'deploy preflight runs no-texting guard',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: "check:no-texting-copy",
  },
  {
    label: 'package exposes first-dollar offer scope guard',
    file: 'package.json',
    needle: 'check:first-dollar-offer-scope',
  },
  {
    label: 'deploy preflight runs first-dollar offer scope guard',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: "check:first-dollar-offer-scope",
  },
  {
    label: 'deploy preflight exposes firstDollarOfferScope result',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'firstDollarOfferScope',
  },
  {
    label: 'deploy preflight blocks on first-dollar offer scope drift',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'first-dollar-offer-scope-drift',
  },
  {
    label: 'live deploy readiness runs first-dollar offer scope guard',
    file: 'scripts/check-live-deploy-readiness.mjs',
    needle: "check:first-dollar-offer-scope",
  },
  {
    label: 'post-deploy live starts with first-dollar offer scope guard',
    file: 'package.json',
    needle: 'check:no-texting-copy && npm run check:first-dollar-offer-scope',
  },
  {
    label: 'launch blockers run first-dollar offer scope guard',
    file: 'scripts/check-launch-blockers.sh',
    needle: "check:first-dollar-offer-scope",
  },
  {
    label: 'deploy preflight runs SMIRK ops copy guard',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: "check:smirk-ops-copy",
  },
  {
    label: 'deploy preflight exposes noTextingCopy result',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'noTextingCopy',
  },
  {
    label: 'deploy preflight exposes smirkOpsCopy result',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'smirkOpsCopy',
  },
  {
    label: 'deploy preflight blocks on SMIRK ops copy drift',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'smirk-ops-copy-drift',
  },
  {
    label: 'deploy preflight runs call-flow contract guard',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: "check:call-flow",
  },
  {
    label: 'deploy preflight exposes callFlow result',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'callFlow',
  },
  {
    label: 'deploy preflight blocks on call-flow contract drift',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'call-flow-contract-drift',
  },
  {
    label: 'deploy preflight runs first-dollar guard coverage',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: "check:first-dollar-guard-coverage",
  },
  {
    label: 'deploy preflight exposes firstDollarGuardCoverage result',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'firstDollarGuardCoverage',
  },
  {
    label: 'deploy approval request emits structured required preflight passes',
    file: 'scripts/print-deploy-approval-request.mjs',
    needle: 'deployPreflightRequiredPasses',
  },
  {
    label: 'deploy approval request requires SMIRK ops copy pass',
    file: 'scripts/print-deploy-approval-request.mjs',
    needle: 'smirkOpsCopy',
  },
  {
    label: 'deploy approval request requires first-dollar offer scope pass',
    file: 'scripts/print-deploy-approval-request.mjs',
    needle: 'firstDollarOfferScope',
  },
  {
    label: 'deploy approval request requires customer dashboard pass',
    file: 'scripts/print-deploy-approval-request.mjs',
    needle: 'customerDashboard',
  },
  {
    label: 'deploy approval request requires billing lifecycle pass',
    file: 'scripts/print-deploy-approval-request.mjs',
    needle: 'billingLifecycle',
  },
  {
    label: 'deploy approval request emits structured expected deploy blocker',
    file: 'scripts/print-deploy-approval-request.mjs',
    needle: 'expectedDeployBlockerAfterRequiredPasses',
  },
  {
    label: 'deploy approval request emits structured proof readiness guards',
    file: 'scripts/print-deploy-approval-request.mjs',
    needle: 'postDeployProofReadinessGuards',
  },
  {
    label: 'deploy approval request preserves Stripe smoke approval phrase',
    file: 'scripts/print-deploy-approval-request.mjs',
    needle: 'postDeployStripeWebhookSmokeApprovalPhrase',
  },
  {
    label: 'deploy approval request preserves smoke cleanup approval phrase',
    file: 'scripts/print-deploy-approval-request.mjs',
    needle: 'postDeploySmokeCleanupApplyApprovalPhrase',
  },
  {
    label: 'post-call deploy handoff carries structured required preflight passes',
    file: 'scripts/print-post-call-fix-handoff.mjs',
    needle: 'deployPreflightRequiredPasses',
  },
  {
    label: 'post-call deploy handoff fallback requires SMIRK ops copy pass',
    file: 'scripts/print-post-call-fix-handoff.mjs',
    needle: 'smirkOpsCopy',
  },
  {
    label: 'post-call deploy handoff fallback requires customer dashboard pass',
    file: 'scripts/print-post-call-fix-handoff.mjs',
    needle: 'customerDashboard',
  },
  {
    label: 'post-call deploy handoff fallback requires billing lifecycle pass',
    file: 'scripts/print-post-call-fix-handoff.mjs',
    needle: 'billingLifecycle',
  },
  {
    label: 'post-call deploy handoff carries Stripe smoke approval phrase',
    file: 'scripts/print-post-call-fix-handoff.mjs',
    needle: 'postDeployStripeWebhookSmokeApprovalPhrase',
  },
  {
    label: 'post-call deploy handoff carries smoke cleanup approval phrase',
    file: 'scripts/print-post-call-fix-handoff.mjs',
    needle: 'postDeploySmokeCleanupApplyApprovalPhrase',
  },
  {
    label: 'deploy approval bundle carries structured required preflight passes',
    file: 'scripts/write-deploy-approval-bundle.mjs',
    needle: 'deployPreflightRequiredPasses',
  },
  {
    label: 'deploy approval bundle carries Stripe smoke approval phrase',
    file: 'scripts/write-deploy-approval-bundle.mjs',
    needle: 'postDeployStripeWebhookSmokeApprovalPhrase',
  },
  {
    label: 'deploy approval bundle carries smoke cleanup approval phrase',
    file: 'scripts/write-deploy-approval-bundle.mjs',
    needle: 'postDeploySmokeCleanupApplyApprovalPhrase',
  },
  {
    label: 'deploy approval handoff verifies structured required preflight passes',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'request.deployPreflightRequiredPasses',
  },
  {
    label: 'deploy approval handoff requires SMIRK ops copy pass',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'smirkOpsCopy',
  },
  {
    label: 'deploy approval handoff requires first-dollar offer scope pass',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'firstDollarOfferScope',
  },
  {
    label: 'deploy approval handoff requires customer dashboard pass',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'customerDashboard',
  },
  {
    label: 'deploy approval handoff requires billing lifecycle pass',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'billingLifecycle',
  },
  {
    label: 'deploy approval handoff verifies structured proof readiness guards',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'request.postDeployProofReadinessGuards',
  },
  {
    label: 'deploy approval handoff verifies structured expected deploy blocker',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'expectedDeployBlockerAfterRequiredPasses',
  },
  {
    label: 'deploy approval handoff verifies Stripe smoke approval phrase field',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'data.postDeployStripeWebhookSmokeApprovalPhrase',
  },
  {
    label: 'deploy approval handoff verifies smoke cleanup approval phrase field',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'data.postDeploySmokeCleanupApplyApprovalPhrase',
  },
  {
    label: 'deploy approval note carries Stripe smoke approval phrase',
    file: 'scripts/write-deploy-approval-note.mjs',
    needle: 'postDeployStripeWebhookSmokeApprovalPhrase',
  },
  {
    label: 'deploy approval note carries smoke cleanup approval phrase',
    file: 'scripts/write-deploy-approval-note.mjs',
    needle: 'postDeploySmokeCleanupApplyApprovalPhrase',
  },
  {
    label: 'deploy approval note states deploy does not authorize Stripe smoke',
    file: 'scripts/write-deploy-approval-note.mjs',
    needle: 'Deploy approval does not authorize the signed Stripe webhook smoke.',
  },
  {
    label: 'deploy approval handoff verifies approval note Stripe smoke boundary',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'Run the Stripe webhook smoke only after this exact approval phrase:',
  },
  {
    label: 'deploy preflight blocks on first-dollar guard coverage drift',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'first-dollar-guard-coverage-drift',
  },
  {
    label: 'package exposes billing lifecycle guard',
    file: 'package.json',
    needle: 'check:billing-lifecycle',
  },
  {
    label: 'deploy preflight runs billing lifecycle guard',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: "check:billing-lifecycle",
  },
  {
    label: 'deploy preflight exposes billing lifecycle result',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'billingLifecycle',
  },
  {
    label: 'deploy preflight blocks on billing lifecycle drift',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'billing-lifecycle-drift',
  },
  {
    label: 'no-texting guard rejects opt-in channel drift',
    file: 'scripts/check-no-texting-copy.mjs',
    needle: 'explicit\\s+opt-in',
  },
  {
    label: 'no-texting guard rejects appointment booking tool drift',
    file: 'scripts/check-no-texting-copy.mjs',
    needle: 'book\\s+a\\s+service',
  },
  {
    label: 'no-texting guard rejects appointment scheduling drift',
    file: 'scripts/check-no-texting-copy.mjs',
    needle: 'appointment\\s+scheduling',
  },
  {
    label: 'no-texting guard rejects zero missed calls overclaim drift',
    file: 'scripts/check-no-texting-copy.mjs',
    needle: 'Zero\\s+missed\\s+calls',
  },
  {
    label: 'no-texting guard rejects full autonomous dispatcher drift',
    file: 'scripts/check-no-texting-copy.mjs',
    needle: 'full\\s+autonomous\\s+dispatcher',
  },
  {
    label: 'no-texting guard rejects full autonomous customer support drift',
    file: 'scripts/check-no-texting-copy.mjs',
    needle: 'full\\s+autonomous\\s+customer\\s+support',
  },
  {
    label: 'post-call intelligence normalizes appointment-like summaries to callback workflow',
    file: 'src/intelligence.ts',
    needle: 'normalizeFirstDollarSummary',
  },
  {
    label: 'post-call intelligence keeps first-dollar appointment object null',
    file: 'src/intelligence.ts',
    needle: 'Always set appointment to null',
  },
  {
    label: 'post-call intelligence converts booked outcomes to callback-needed',
    file: 'src/intelligence.ts',
    needle: 'outcome: "callback_needed"',
  },
  {
    label: 'deploy preflight runs OpenAPI route inventory guard',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: "check:openapi",
  },
  {
    label: 'deploy preflight exposes OpenAPI route inventory result',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'openApi',
  },
  {
    label: 'OpenAPI generator classifies signed webhook paths explicitly',
    file: 'scripts/generate-openapi.mjs',
    needle: 'signedWebhookPaths',
  },
  {
    label: 'OpenAPI generator classifies operator-only paths explicitly',
    file: 'scripts/generate-openapi.mjs',
    needle: 'operatorOnlyPaths',
  },
  {
    label: 'OpenAPI generator protects Twilio test-call route inventory',
    file: 'scripts/generate-openapi.mjs',
    needle: '"POST /api/twilio/test-call"',
  },
  {
    label: 'OpenAPI generator protects Twilio test-webhook route inventory',
    file: 'scripts/generate-openapi.mjs',
    needle: '"POST /api/twilio/test-webhook"',
  },
  {
    label: 'OpenAPI generator validates security inventory before writing',
    file: 'scripts/generate-openapi.mjs',
    needle: 'validateSecurityInventory',
  },
  {
    label: 'OpenAPI generator excludes middleware pseudo-operations',
    file: 'scripts/generate-openapi.mjs',
    needle: 'x-express-use',
  },
  {
    label: 'OpenAPI generator documents middleware exclusion',
    file: 'scripts/generate-openapi.mjs',
    needle: 'Middleware app.use declarations are excluded',
  },
  {
    label: 'OpenAPI generator fails non-operator operator route inventory',
    file: 'scripts/generate-openapi.mjs',
    needle: 'must include requireOperator in openapi.yaml inventory',
  },
  {
    label: 'deploy preflight runs local auth regression guard',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: "check:auth",
  },
  {
    label: 'outbound call route explicitly requires dashboard auth',
    file: 'src/routes/outbound-call-routes.ts',
    needle: 'app.post("/api/calls", dashboardAuth, callRateLimit',
  },
  {
    label: 'team roster routes explicitly require dashboard auth',
    file: 'src/team-routes.ts',
    needle: 'app.get("/api/team", dashboardAuth',
  },
  {
    label: 'team roster writes require operator auth',
    file: 'src/team-routes.ts',
    needle: 'app.post("/api/team", dashboardAuth, requireOperator',
  },
  {
    label: 'team roster updates require operator auth',
    file: 'src/team-routes.ts',
    needle: 'app.patch("/api/team/:id", dashboardAuth, requireOperator',
  },
  {
    label: 'team roster on-call toggle requires operator auth',
    file: 'src/team-routes.ts',
    needle: 'app.patch("/api/team/:id/oncall", dashboardAuth, requireOperator',
  },
  {
    label: 'team roster delete requires operator auth',
    file: 'src/team-routes.ts',
    needle: 'app.delete("/api/team/:id", dashboardAuth, requireOperator',
  },
  {
    label: 'OpenClaw status route requires operator auth',
    file: 'src/routes/operator-routes.ts',
    needle: 'app.get("/api/openclaw/status", dashboardAuth, requireOperator',
  },
  {
    label: 'OpenClaw connection test route requires operator auth',
    file: 'src/routes/operator-routes.ts',
    needle: 'app.post("/api/openclaw/test", dashboardAuth, requireOperator',
  },
  {
    label: 'global settings schema route requires operator auth',
    file: 'src/routes/settings-routes.ts',
    needle: 'app.get("/api/settings/groups", dashboardAuth, requireOperator',
  },
  {
    label: 'global settings route requires operator auth',
    file: 'src/routes/settings-routes.ts',
    needle: 'app.get("/api/settings", dashboardAuth, requireOperator',
  },
  {
    label: 'global settings write route requires operator auth',
    file: 'src/routes/settings-routes.ts',
    needle: 'app.post("/api/settings", dashboardAuth, requireOperator',
  },
  {
    label: 'global settings test route requires operator auth',
    file: 'src/routes/settings-routes.ts',
    needle: 'app.post("/api/settings/test/:service", dashboardAuth, requireOperator',
  },
  {
    label: 'system health route requires operator auth',
    file: 'src/routes/system-health-routes.ts',
    needle: 'app.get("/api/system-health", dashboardAuth, requireOperator',
  },
  {
    label: 'debug TTS route requires operator auth',
    file: 'src/routes/debug-routes.ts',
    needle: 'app.post("/api/debug/tts", dashboardAuth, requireOperator',
  },
  {
    label: 'compliance DNC list requires operator auth',
    file: 'src/routes/compliance-routes.ts',
    needle: 'app.get("/api/compliance/dnc", dashboardAuth, requireOperator',
  },
  {
    label: 'compliance DNC mutation requires operator auth',
    file: 'src/routes/compliance-routes.ts',
    needle: 'app.post("/api/compliance/dnc", dashboardAuth, requireOperator',
  },
  {
    label: 'compliance audit requires operator auth',
    file: 'src/routes/compliance-routes.ts',
    needle: 'app.get("/api/compliance/audit", dashboardAuth, requireOperator',
  },
  {
    label: 'agent analytics requires operator auth',
    file: 'src/routes/compliance-routes.ts',
    needle: 'app.get("/api/analytics/agents", dashboardAuth, requireOperator',
  },
  {
    label: 'raw event log route requires operator auth',
    file: 'src/routes/proof-routes.ts',
    needle: 'app.get("/api/events", dashboardAuth, requireOperator',
  },
  {
    label: 'auth regression strips operator event feed joined rows',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'operator event feed route must not expose broad joined rows',
  },
  {
    label: 'legacy summary feed requires operator auth',
    file: 'src/routes/operations-routes.ts',
    needle: 'app.get("/api/summaries", dashboardAuth, requireOperator',
  },
  {
    label: 'auth regression strips operator summary feed joined rows',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'operator summary feed route must not expose broad joined rows',
  },
  {
    label: 'custom field definition list requires operator auth',
    file: 'src/routes/contact-routes.ts',
    needle: 'app.get("/api/field-definitions", dashboardAuth, requireOperator',
  },
  {
    label: 'custom field definition mutation requires operator auth',
    file: 'src/routes/contact-routes.ts',
    needle: 'app.post("/api/field-definitions", dashboardAuth, requireOperator',
  },
  {
    label: 'custom field definition delete requires operator auth',
    file: 'src/routes/contact-routes.ts',
    needle: 'app.delete("/api/field-definitions/:key", dashboardAuth, requireOperator',
  },
  {
    label: 'Boss Mode routes are registered with operator auth',
    file: 'server.ts',
    needle: 'registerBossModeRoutes(app, dashboardAuth, requireOperator, DB_ENABLED);',
  },
  {
    label: 'Boss Mode settings route requires operator auth',
    file: 'src/boss-mode.ts',
    needle: 'router.get("/settings", dashboardAuth, requireOperator',
  },
  {
    label: 'Boss Mode settings write route requires operator auth',
    file: 'src/boss-mode.ts',
    needle: 'router.post("/settings", dashboardAuth, requireOperator',
  },
  {
    label: 'Boss Mode context route requires operator auth',
    file: 'src/boss-mode.ts',
    needle: 'router.get("/context", dashboardAuth, requireOperator',
  },
  {
    label: 'Boss Mode context write route requires operator auth',
    file: 'src/boss-mode.ts',
    needle: 'router.post("/context", dashboardAuth, requireOperator',
  },
  {
    label: 'Boss Mode context delete route requires operator auth',
    file: 'src/boss-mode.ts',
    needle: 'router.delete("/context/:id", dashboardAuth, requireOperator',
  },
  {
    label: 'Boss Mode audit route requires operator auth',
    file: 'src/boss-mode.ts',
    needle: 'router.get("/audit", dashboardAuth, requireOperator',
  },
  {
    label: 'Boss Mode metrics route requires operator auth',
    file: 'src/boss-mode.ts',
    needle: 'router.get("/metrics", dashboardAuth, requireOperator',
  },
  {
    label: 'call maintenance stale fixer requires operator auth',
    file: 'src/routes/call-routes.ts',
    needle: 'app.patch("/api/calls/fix-stale", dashboardAuth, requireOperator',
  },
  {
    label: 'call reprocess route requires operator auth',
    file: 'src/routes/call-routes.ts',
    needle: 'app.post("/api/calls/:sid/reprocess", dashboardAuth, requireOperator',
  },
  {
    label: 'call delete route requires operator auth',
    file: 'src/routes/call-routes.ts',
    needle: 'app.delete("/api/calls/:sid", dashboardAuth, requireOperator',
  },
  {
    label: 'Twilio webhook self-test requires operator auth',
    file: 'src/routes/twilio-ops-routes.ts',
    needle: 'app.post("/api/twilio/test-webhook", dashboardAuth, requireOperator',
  },
  {
    label: 'Twilio outbound self-test requires operator auth',
    file: 'src/routes/twilio-ops-routes.ts',
    needle: 'app.post("/api/twilio/test-call", dashboardAuth, requireOperator',
  },
  {
    label: 'integration webhook self-test requires operator auth',
    file: 'src/routes/integrations-routes.ts',
    needle: 'app.post("/api/integrations/webhook/test", dashboardAuth, requireOperator',
  },
  {
    label: 'integration webhook config requires operator auth',
    file: 'src/routes/integrations-routes.ts',
    needle: 'app.get("/api/integrations/webhook", dashboardAuth, requireOperator',
  },
  {
    label: 'integration delivery log requires operator auth',
    file: 'src/routes/integrations-routes.ts',
    needle: 'app.get("/api/integrations/webhook/deliveries", dashboardAuth, requireOperator',
  },
  {
    label: 'integration CRM config requires operator auth',
    file: 'src/routes/integrations-routes.ts',
    needle: 'app.get("/api/integrations/crm", dashboardAuth, requireOperator',
  },
  {
    label: 'integration CRM self-test requires operator auth',
    file: 'src/routes/integrations-routes.ts',
    needle: 'app.post("/api/integrations/crm/test", dashboardAuth, requireOperator',
  },
  {
    label: 'plugin tool listing requires operator auth',
    file: 'src/routes/integrations-routes.ts',
    needle: 'app.get("/api/tools", dashboardAuth, requireOperator',
  },
  {
    label: 'plugin tool mutation requires operator auth',
    file: 'src/routes/integrations-routes.ts',
    needle: 'app.post("/api/tools", dashboardAuth, requireOperator',
  },
  {
    label: 'MCP server listing requires operator auth',
    file: 'src/routes/integrations-routes.ts',
    needle: 'app.get("/api/mcp", dashboardAuth, requireOperator',
  },
  {
    label: 'MCP server mutation requires operator auth',
    file: 'src/routes/integrations-routes.ts',
    needle: 'app.post("/api/mcp", dashboardAuth, requireOperator',
  },
  {
    label: 'MCP server test requires operator auth',
    file: 'src/routes/integrations-routes.ts',
    needle: 'app.post("/api/mcp/:id/test", dashboardAuth, requireOperator',
  },
  {
    label: 'prospecting campaign mutation requires operator auth',
    file: 'src/routes/prospecting-routes.ts',
    needle: 'app.post("/api/prospecting/campaigns", dashboardAuth, requireOperator',
  },
  {
    label: 'prospecting campaign listing requires operator auth',
    file: 'src/routes/prospecting-routes.ts',
    needle: 'app.get("/api/prospecting/campaigns", dashboardAuth, requireOperator',
  },
  {
    label: 'prospecting lead listing requires operator auth',
    file: 'src/routes/prospecting-routes.ts',
    needle: 'app.get("/api/prospecting/leads", dashboardAuth, requireOperator',
  },
  {
    label: 'prospecting outbound dial requires operator auth',
    file: 'src/routes/prospecting-routes.ts',
    needle: 'app.post("/api/prospecting/campaigns/:id/dial-next", dashboardAuth, requireOperator',
  },
  {
    label: 'prospecting auto-dial start requires operator auth',
    file: 'src/routes/prospecting-routes.ts',
    needle: 'app.post("/api/prospecting/campaigns/:id/auto-dial/start", dashboardAuth, requireOperator',
  },
  {
    label: 'prospecting auto-dial stop requires operator auth',
    file: 'src/routes/prospecting-routes.ts',
    needle: 'app.post("/api/prospecting/campaigns/:id/auto-dial/stop", dashboardAuth, requireOperator',
  },
  {
    label: 'prospecting auto-dial status requires operator auth',
    file: 'src/routes/prospecting-routes.ts',
    needle: 'app.get("/api/prospecting/campaigns/:id/auto-dial/status", dashboardAuth, requireOperator',
  },
  {
    label: 'prospecting sequence stats requires operator auth',
    file: 'src/routes/prospecting-routes.ts',
    needle: 'app.get("/api/prospecting/sequences/stats", dashboardAuth, requireOperator',
  },
  {
    label: 'recovery arbitrary direct dial requires operator auth',
    file: 'src/routes/recovery-routes.ts',
    needle: 'app.post("/api/recovery/direct-dial", dashboardAuth, requireOperator',
  },
  {
    label: 'legacy lead Apollo search requires operator auth',
    file: 'src/routes/lead-routes.ts',
    needle: 'app.post("/api/leads/search/apollo", dashboardAuth, requireOperator',
  },
  {
    label: 'legacy lead list requires operator auth',
    file: 'src/routes/lead-routes.ts',
    needle: 'app.get("/api/leads", dashboardAuth, requireOperator',
  },
  {
    label: 'legacy lead create requires operator auth',
    file: 'src/routes/lead-routes.ts',
    needle: 'app.post("/api/leads", dashboardAuth, requireOperator',
  },
  {
    label: 'legacy lead funnel requires operator auth',
    file: 'src/routes/lead-routes.ts',
    needle: 'app.get("/api/leads/funnel", dashboardAuth, requireOperator',
  },
  {
    label: 'legacy lead scoreboard requires operator auth',
    file: 'src/routes/lead-routes.ts',
    needle: 'app.get("/api/leads/scoreboard", dashboardAuth, requireOperator',
  },
  {
    label: 'legacy lead alerts require operator auth',
    file: 'src/routes/lead-routes.ts',
    needle: 'app.get("/api/leads/alerts", dashboardAuth, requireOperator',
  },
  {
    label: 'legacy lead maps search requires operator auth',
    file: 'src/routes/lead-routes.ts',
    needle: 'app.post("/api/leads/search/maps", dashboardAuth, requireOperator',
  },
  {
    label: 'legacy lead pitch personalization requires operator auth',
    file: 'src/routes/lead-routes.ts',
    needle: 'app.post("/api/leads/personalize", dashboardAuth, requireOperator',
  },
  {
    label: 'legacy campaign create requires operator auth',
    file: 'src/routes/lead-routes.ts',
    needle: 'app.post("/api/campaigns", dashboardAuth, requireOperator',
  },
  {
    label: 'legacy campaign listing requires operator auth',
    file: 'src/routes/lead-routes.ts',
    needle: 'app.get("/api/campaigns", dashboardAuth, requireOperator',
  },
  {
    label: 'legacy campaign launch requires operator auth',
    file: 'src/routes/lead-routes.ts',
    needle: 'app.post("/api/campaigns/:id/launch", dashboardAuth, requireOperator',
  },
  {
    label: 'SMIRK chat route requires dashboard auth',
    file: 'src/routes/lead-routes.ts',
    needle: 'app.post("/api/chat", dashboardAuth',
  },
  {
    label: 'SMIRK chat route classifies full, demo, or workspace auth',
    file: 'src/routes/lead-routes.ts',
    needle: '(req as any).authMode === "demo_operator"',
  },
  {
    label: 'SMIRK chat route passes access mode to backend',
    file: 'src/routes/lead-routes.ts',
    needle: 'handleSmirkChat(messages, wsId, { accessMode: authMode })',
  },
  {
    label: 'SMIRK chat debug context requires operator auth',
    file: 'src/routes/lead-routes.ts',
    needle: 'app.get("/api/chat/debug-context", dashboardAuth, requireOperator',
  },
  {
    label: 'SMIRK chat workspace tool allowlist exists',
    file: 'src/smirk-chat.ts',
    needle: 'const WORKSPACE_ALLOWED_TOOLS = new Set([',
  },
  {
    label: 'SMIRK chat demo tool allowlist exists',
    file: 'src/smirk-chat.ts',
    needle: 'const DEMO_OPERATOR_ALLOWED_TOOLS = new Set([',
  },
  {
    label: 'SMIRK chat blocks workspace and demo access to operator tools',
    file: 'src/smirk-chat.ts',
    needle: 'const allowedForMode = accessMode === "operator"',
  },
  {
    label: 'workspace and demo sessions render SMIRK chat without whisper access',
    file: 'src/App.tsx',
    needle: '<SmirkChatBubble activeCalls={activeCalls} canWhisper={!!operatorSession && !isDemoOperator} />',
  },
  {
    label: 'appointment create route requires operator auth',
    file: 'src/routes/calendar-routes.ts',
    needle: 'app.post("/api/appointments", dashboardAuth, requireOperator',
  },
  {
    label: 'appointment update route requires operator auth',
    file: 'src/routes/calendar-routes.ts',
    needle: 'app.patch("/api/appointments/:id", dashboardAuth, requireOperator',
  },
  {
    label: 'calendar live test-booking route requires operator auth',
    file: 'src/routes/calendar-routes.ts',
    needle: 'app.post("/api/calendar/test-booking", dashboardAuth, requireOperator',
  },
  {
    label: 'agent create route requires operator auth',
    file: 'src/routes/agent-routes.ts',
    needle: 'app.post("/api/agents", dashboardAuth, requireOperator',
  },
  {
    label: 'agent listing route requires operator auth',
    file: 'src/routes/agent-routes.ts',
    needle: 'app.get("/api/agents", dashboardAuth, requireOperator',
  },
  {
    label: 'active agent route requires operator auth',
    file: 'src/routes/agent-routes.ts',
    needle: 'app.get("/api/agents/active", dashboardAuth, requireOperator',
  },
  {
    label: 'agent detail route requires operator auth',
    file: 'src/routes/agent-routes.ts',
    needle: 'app.get("/api/agents/:id", dashboardAuth, requireOperator',
  },
  {
    label: 'agent activation route requires operator auth',
    file: 'src/routes/agent-routes.ts',
    needle: 'app.put("/api/agents/:id/activate", dashboardAuth, requireOperator',
  },
  {
    label: 'agent update route requires operator auth',
    file: 'src/routes/agent-routes.ts',
    needle: 'app.put("/api/agents/:id", dashboardAuth, requireOperator',
  },
  {
    label: 'agent patch route requires operator auth',
    file: 'src/routes/agent-routes.ts',
    needle: 'app.patch("/api/agents/:id", dashboardAuth, requireOperator',
  },
  {
    label: 'agent delete route requires operator auth',
    file: 'src/routes/agent-routes.ts',
    needle: 'app.delete("/api/agents/:id", dashboardAuth, requireOperator',
  },
  {
    label: 'auth regression guards OpenClaw operator-only routes',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/openclaw/status", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression guards global settings schema operator-only route',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/settings/groups", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression guards global settings operator-only routes',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/settings", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression guards diagnostic operator-only routes',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/system-health", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression guards compliance operator-only routes',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/compliance/dnc", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression guards raw event log operator-only route',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/events", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression classifies buyer-safe dashboard routes explicitly',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'workspaceDashboardRouteAllowlist',
  },
  {
    label: 'auth regression rejects unclassified dashboard routes',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'dashboard-authenticated non-operator route must be explicitly classified as buyer/workspace safe',
  },
  {
    label: 'auth regression blocks broad call rows in buyer call list route',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'buyer call list route must not expose broad call rows',
  },
  {
    label: 'auth regression blocks raw operational rows in buyer call detail route',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'buyer call detail messages route must not expose raw operational rows',
  },
  {
    label: 'auth regression keeps buyer active calls minimal',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'buyer active calls route must return minimal live-call status',
  },
  {
    label: 'auth regression tenant-scopes buyer transcript route',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'buyer transcript route must be valid-SID scoped and minimal',
  },
  {
    label: 'auth regression tenant-scopes buyer recording metadata route',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'buyer call recording metadata route must be callSid-bound and tenant-scoped',
  },
  {
    label: 'auth regression call-binds buyer recording audio proxy',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'buyer recording audio proxy must require a workspace-owned call SID',
  },
  {
    label: 'auth regression blocks broad contact rows in buyer contact list route',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'buyer contact list route must not expose broad contact rows',
  },
  {
    label: 'auth regression blocks broad operational rows in buyer contact detail route',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'buyer contact detail route must not expose broad operational rows',
  },
  {
    label: 'auth regression blocks broad task rows in buyer task list route',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'buyer task list route must not expose broad task rows',
  },
  {
    label: 'auth regression blocks broad handoff rows in buyer handoff list route',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'buyer handoff list route must not expose broad handoff rows',
  },
  {
    label: 'auth regression blocks broad appointment rows in buyer appointment list route',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'buyer appointment list route must not expose broad appointment rows',
  },
  {
    label: 'auth regression tenant-scopes buyer appointment detail route',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'buyer appointment detail route must use tenant-scoped explicit appointment payload',
  },
  {
    label: 'auth regression blocks raw metadata in buyer recovery queue route',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'buyer recovery queue route must not expose raw call metadata',
  },
  {
    label: 'auth regression strips buyer call intelligence route',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'buyer call intelligence route must not expose raw operational/customer rows',
  },
  {
    label: 'auth regression strips buyer triage route',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'buyer triage route must not expose extra operational/customer fields',
  },
  {
    label: 'dashboard route allowlist includes callback task queue',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/tasks", reason: "buyer callback task queue"',
  },
  {
    label: 'dashboard route allowlist includes buyer proof dashboard',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/workspace-overview", reason: "buyer proof dashboard"',
  },
  {
    label: 'auth regression guards legacy summary feed operator-only route',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/summaries", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression strips public checkout status setup fields',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'public checkout-status must not select raw workspace setup fields',
  },
  {
    label: 'auth regression guards custom field definition operator-only routes',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/field-definitions", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression guards call maintenance operator-only routes',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/calls/:sid/reprocess", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression guards Twilio operator-only test routes',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/twilio/test-call", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression guards integration operator-only routes',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/integrations/webhook/test", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression guards integration operator-only read routes',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/integrations/webhook", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression guards prospecting operator-only routes',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/prospecting/campaigns/:id/auto-dial/start", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression guards prospecting operator-only read routes',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/prospecting/campaigns", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression guards legacy lead database operator-only routes',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/leads", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression guards recovery arbitrary direct dial route',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/recovery/direct-dial", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression guards legacy outreach operator-only routes',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/campaigns/:id/launch", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression guards legacy campaign listing operator-only route',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/campaigns", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression guards SMIRK chat dashboard-auth route',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/chat", markers: ["dashboardAuth", "chatRateLimit"]',
  },
  {
    label: 'auth regression guards calendar operator-only routes',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/calendar/test-booking", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression guards agent mutation operator-only routes',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/agents/:id/activate", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression guards agent read operator-only routes',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/agents/active", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'auth regression guards team roster operator-only routes',
    file: 'scripts/check-auth-regression.mjs',
    needle: 'route: "/api/team/:id/oncall", markers: ["dashboardAuth", "requireOperator"]',
  },
  {
    label: 'deploy preflight exposes authRegression result',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'authRegression',
  },
  {
    label: 'deploy preflight runs paid handoff safety guard',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: "check:paid-handoff-safety",
  },
  {
    label: 'paid handoff live refusal separates cleanup approval',
    file: 'scripts/check-paid-activation-handoff-live.mjs',
    needle: 'Do not apply confirmed smoke cleanup without separate explicit cleanup approval after reviewing the dry-run.',
  },
  {
    label: 'paid handoff live retries transient live fetch failures',
    file: 'scripts/check-paid-activation-handoff-live.mjs',
    needle: 'fetchTextWithRetry',
  },
  {
    label: 'paid handoff live emits structured fetch failure JSON',
    file: 'scripts/check-paid-activation-handoff-live.mjs',
    needle: 'paid-handoff-fetch-failed',
  },
  {
    label: 'paid handoff live uses bounded fetch timeout',
    file: 'scripts/check-paid-activation-handoff-live.mjs',
    needle: 'SMIRK_PAID_HANDOFF_FETCH_TIMEOUT_MS',
  },
  {
    label: 'paid handoff safety guards cleanup approval separation',
    file: 'scripts/check-paid-handoff-safety.mjs',
    needle: 'cleanupApprovalRequired',
  },
  {
    label: 'paid handoff safety guards public activation cache control',
    file: 'scripts/check-paid-handoff-safety.mjs',
    needle: 'Cache-Control", "no-store"',
  },
  {
    label: 'paid handoff safety guards checkout cache control',
    file: 'scripts/check-paid-handoff-safety.mjs',
    needle: 'checkout create route',
  },
  {
    label: 'paid handoff safety guards checkout success redirect',
    file: 'scripts/check-paid-handoff-safety.mjs',
    needle: 'success_url: `${publicAppUrl}/success?session_id={CHECKOUT_SESSION_ID}`',
  },
  {
    label: 'paid handoff safety guards checkout cancel redirect',
    file: 'scripts/check-paid-handoff-safety.mjs',
    needle: 'cancel_url: `${publicAppUrl}/pricing`',
  },
  {
    label: 'paid handoff safety guards buyer success route',
    file: 'scripts/check-paid-handoff-safety.mjs',
    needle: 'buyer success page',
  },
  {
    label: 'paid handoff safety guards buyer cancel route',
    file: 'scripts/check-paid-handoff-safety.mjs',
    needle: 'buyer cancel page',
  },
  {
    label: 'paid handoff safety guards checkout-status lookup wiring',
    file: 'scripts/check-paid-handoff-safety.mjs',
    needle: '/api/provisioning/checkout-status',
  },
  {
    label: 'paid handoff safety guards backend checkout session normalization',
    file: 'scripts/check-paid-handoff-safety.mjs',
    needle: 'normalizeStripeCheckoutSessionId',
  },
  {
    label: 'paid handoff safety guards backend checkout reference boolean',
    file: 'scripts/check-paid-handoff-safety.mjs',
    needle: 'checkout_reference_received: checkoutReferenceReceived',
  },
  {
    label: 'paid handoff safety guards backend checkout session format',
    file: 'scripts/check-paid-handoff-safety.mjs',
    needle: '^cs_(test|live)_[A-Za-z0-9_]{8,240}$',
  },
  {
    label: 'paid handoff safety guards success session-id capture',
    file: 'scripts/check-paid-handoff-safety.mjs',
    needle: 'new URLSearchParams(window.location.search).get("session_id")',
  },
  {
    label: 'paid handoff safety guards success session-id lookup handoff',
    file: 'scripts/check-paid-handoff-safety.mjs',
    needle: 'checkout_session_id: sessionId',
  },
  {
    label: 'paid handoff safety guards public activation labels',
    file: 'scripts/check-paid-handoff-safety.mjs',
    needle: 'request_summary?.status_label',
  },
  {
    label: 'paid handoff live verifies public activation cache control',
    file: 'scripts/check-paid-activation-handoff-live.mjs',
    needle: 'cacheProtected',
  },
  {
    label: 'paid handoff live sends checkout session reference to status lookup',
    file: 'scripts/check-paid-activation-handoff-live.mjs',
    needle: 'checkout_session_id: smokeCheckoutSessionId',
  },
  {
    label: 'paid handoff live verifies checkout reference receipt',
    file: 'scripts/check-paid-activation-handoff-live.mjs',
    needle: 'checkout_reference_received === true',
  },
  {
    label: 'paid handoff live verifies checkout session id is not exposed',
    file: 'scripts/check-paid-activation-handoff-live.mjs',
    needle: 'checkout_session_id_exposed',
  },
  {
    label: 'deploy preflight exposes paidHandoffSafety result',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'paidHandoffSafety',
  },
  {
    label: 'deploy preflight runs self-serve activation contract guard',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: "check:self-serve-activation",
  },
  {
    label: 'deploy preflight exposes selfServeActivation result',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'selfServeActivation',
  },
  {
    label: 'deploy preflight runs client onboarding intake contract guard',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: "check:client-onboarding-intake",
  },
  {
    label: 'deploy preflight exposes clientOnboardingIntake result',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'clientOnboardingIntake',
  },
  {
    label: 'client onboarding contract preserves Call Flow setup label',
    file: 'scripts/check-client-onboarding-intake-contract.mjs',
    needle: 'label: \\"Call Flow\\"',
  },
  {
    label: 'client onboarding contract preserves Owner Alert setup label',
    file: 'scripts/check-client-onboarding-intake-contract.mjs',
    needle: 'label: \\"Owner Alert\\"',
  },
  {
    label: 'client onboarding contract preserves Proof setup label',
    file: 'scripts/check-client-onboarding-intake-contract.mjs',
    needle: 'label: \\"Proof\\"',
  },
  {
    label: 'client onboarding contract rejects generic agent setup drift',
    file: 'scripts/check-client-onboarding-intake-contract.mjs',
    needle: 'Agent Configuration',
  },
  {
    label: 'client onboarding contract rejects generic activation CTA drift',
    file: 'scripts/check-client-onboarding-intake-contract.mjs',
    needle: 'Activate Agent',
  },
  {
    label: 'client onboarding contract rejects broad AI answer activation drift',
    file: 'scripts/check-client-onboarding-intake-contract.mjs',
    needle: 'phone number will answer calls with AI',
  },
  {
    label: 'deploy preflight runs Stripe webhook handoff preflight',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: "check:stripe-webhook-handoff-live:preflight",
  },
  {
    label: 'deploy preflight exposes stripeWebhookPreflight result',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'stripeWebhookPreflight',
  },
  {
    label: 'deploy preflight runs Stripe smoke approval readiness',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: "check:stripe-webhook-smoke-approval-ready",
  },
  {
    label: 'deploy preflight exposes stripeWebhookApprovalReady result',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'stripeWebhookApprovalReady',
  },
  {
    label: 'deploy preflight exposes post-deploy Stripe smoke approval phrase',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'postDeployStripeWebhookSmokeApprovalPhrase',
  },
  {
    label: 'deploy preflight exposes post-deploy smoke cleanup approval phrase',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'postDeploySmokeCleanupApplyApprovalPhrase',
  },
  {
    label: 'deploy preflight ok includes Stripe smoke approval readiness',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'stripeWebhookApprovalReady.ok',
  },
  {
    label: 'package exposes Stripe webhook smoke approval readiness check',
    file: 'package.json',
    needle: 'check:stripe-webhook-smoke-approval-ready',
  },
  {
    label: 'package exposes read-only Stripe webhook smoke approval print command',
    file: 'package.json',
    needle: 'print:stripe-webhook-smoke-approval',
  },
  {
    label: 'package exposes first-dollar approval packet writer',
    file: 'package.json',
    needle: 'write:first-dollar-approval-packet',
  },
  {
    label: 'package exposes call-flow contract guard',
    file: 'package.json',
    needle: 'check:call-flow',
  },
  {
    label: 'call-flow guard requires lookup_contact at call start',
    file: 'scripts/check-call-flow-contract.mjs',
    needle: 'call lookup_contact immediately',
  },
  {
    label: 'call-flow guard requires list_open_tasks at call start',
    file: 'scripts/check-call-flow-contract.mjs',
    needle: 'call list_open_tasks',
  },
  {
    label: 'call-flow guard requires route_call follow-through',
    file: 'scripts/check-call-flow-contract.mjs',
    needle: 'Call route_call',
  },
  {
    label: 'call-flow guard requires clean end states',
    file: 'scripts/check-call-flow-contract.mjs',
    needle: 'verify the call ended in a clean state',
  },
  {
    label: 'call-flow guard requires callback task tool coverage',
    file: 'scripts/check-call-flow-contract.mjs',
    needle: 'schedule_callback_confirmation',
  },
  {
    label: 'package exposes read-only first-dollar approval packet print command',
    file: 'package.json',
    needle: 'print:first-dollar-approval-packet',
  },
  {
    label: 'post-deploy live proof gate runs first-dollar guard coverage',
    file: 'package.json',
    needle: 'check:first-dollar-guard-coverage && npm run check:openapi',
  },
  {
    label: 'real proof-call readiness runs first-dollar guard coverage',
    file: 'scripts/check-real-call-readiness.mjs',
    needle: "check:first-dollar-guard-coverage",
  },
  {
    label: 'real proof-call readiness exposes first-dollar guard result',
    file: 'scripts/check-real-call-readiness.mjs',
    needle: 'firstDollarGuardCoverage',
  },
  {
    label: 'real proof-call readiness blocks on first-dollar guard drift',
    file: 'scripts/check-real-call-readiness.mjs',
    needle: 'first-dollar-guard-coverage-drift',
  },
  {
    label: 'real proof-call readiness uses bounded fetch retry',
    file: 'scripts/check-real-call-readiness.mjs',
    needle: 'fetchJsonWithRetry',
  },
  {
    label: 'real proof-call readiness reports fetch failures structurally',
    file: 'scripts/check-real-call-readiness.mjs',
    needle: 'real-call-readiness-fetch-failed',
  },
  {
    label: 'real proof-call readiness exposes fetch timeout control',
    file: 'scripts/check-real-call-readiness.mjs',
    needle: 'SMIRK_REAL_CALL_READINESS_FETCH_TIMEOUT_MS',
  },
  {
    label: 'proof runner requires an exact machine confirmation after readiness',
    file: 'scripts/run-real-proof-call.mjs',
    needle: 'REAL_PROOF_CALL_CONFIRMATION_ENV',
  },
  {
    label: 'proof runner requires a separately confirmed matching E.164 target',
    file: 'scripts/run-real-proof-call.mjs',
    needle: 'REAL_PROOF_CALL_TARGET_CONFIRMATION_ENV',
  },
  {
    label: 'isolated dial helper rechecks proof-call approval',
    file: 'scripts/place-real-test-call.mjs',
    needle: 'proof-call-confirmation-missing-or-mismatched',
  },
  {
    label: 'first-dollar approval packet print command runs handoff safety check',
    file: 'scripts/print-first-dollar-approval-packet.mjs',
    needle: 'check:deploy-approval-handoff',
  },
  {
    label: 'first-dollar approval packet print command refuses stale packets',
    file: 'scripts/print-first-dollar-approval-packet.mjs',
    needle: 'first-dollar approval packet is stale or unsafe to print',
  },
  {
    label: 'first-dollar approval packet includes Stripe smoke command',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live',
  },
  {
    label: 'first-dollar approval packet documents the Starter-only cutover',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'one exact Starter URL + exact current `plink_` ID plus `STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS`',
  },
  {
    label: 'first-dollar approval packet preserves bounded inactive historical fulfillment IDs',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS',
  },
  {
    label: 'first-dollar approval packet printer validates forced Pro and Enterprise clearing',
    file: 'scripts/print-first-dollar-approval-packet.mjs',
    needle: 'always clears Pro and Enterprise URL + ID pairs',
  },
  {
    label: 'first-dollar approval packet preserves separate live env write confirmation',
    file: 'scripts/print-first-dollar-approval-packet.mjs',
    needle: 'CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE=apply-smirk-first-dollar-live-env',
  },
  {
    label: 'first-dollar approval packet preserves separate Starter checkout confirmation',
    file: 'scripts/print-first-dollar-approval-packet.mjs',
    needle: 'CONFIRM_SMIRK_REAL_STARTER_CHECKOUT=accept-buyer-initiated-starter-197-monthly',
  },
  {
    label: 'first-dollar approval packet keeps legacy Stripe link deactivation exact and separate',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'APPROVE_SMIRK_STRIPE_PAYMENT_LINK_DEACTIVATION: ids=<exact-read-only-scan-plink-ids>; action=set-active-false-only',
  },
  {
    label: 'first-dollar approval printer requires post-deactivation exclusivity proof',
    file: 'scripts/print-first-dollar-approval-packet.mjs',
    needle: 'check:first-dollar-payment-link-exclusivity',
  },
  {
    label: 'first-dollar approval packet explains digest-bound activation enforcement',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'existing deploy authority, exact commit, same digest, distinct activation-deploy authority, and real Starter checkout authority',
  },
  {
    label: 'first-dollar setter atomically clears Pro and Enterprise offers',
    file: 'scripts/set-first-dollar-live-env.sh',
    needle: '"STRIPE_PAYMENT_LINK_ENTERPRISE_ID="',
  },
  {
    label: 'first-dollar setter refuses to enable Pro or Enterprise',
    file: 'scripts/set-first-dollar-live-env.sh',
    needle: 'this Starter-only setter cannot enable ${plan}',
  },
  {
    label: 'first-dollar setter forces native Checkout off',
    file: 'scripts/set-first-dollar-live-env.sh',
    needle: 'SMIRK_NATIVE_CHECKOUT_ENABLED=false',
  },
  {
    label: 'first-dollar setter validates Payment Link URLs before Railway mutation',
    file: 'scripts/set-first-dollar-live-env.sh',
    needle: 'node ./scripts/check-payment-link-value.mjs url',
  },
  {
    label: 'first-dollar setter validates the exact current and historical fulfillment ID allowlist',
    file: 'scripts/set-first-dollar-live-env.sh',
    needle: 'check-payment-link-fulfillment-ids.mjs',
  },
  {
    label: 'first-dollar setter provider-verifies proposed links before Railway mutation',
    file: 'scripts/set-first-dollar-live-env.sh',
    needle: 'node ./scripts/check-proposed-payment-links.mjs',
  },
  {
    label: 'first-dollar setter rejects active legacy SMIRK links before Railway mutation',
    file: 'scripts/set-first-dollar-live-env.sh',
    needle: 'node ./scripts/check-exclusive-first-dollar-payment-links.mjs',
  },
  {
    label: 'live first-dollar gate proves Stripe Payment Link exclusivity',
    file: 'scripts/check-railway-first-dollar-env.mjs',
    needle: 'verifyExclusiveActiveFirstDollarPaymentLink',
  },
  {
    label: 'live first-dollar gate validates the shared fulfillment ID allowlist',
    file: 'scripts/check-railway-first-dollar-env.mjs',
    needle: 'evaluateStarterPaymentLinkFulfillmentIds',
  },
  {
    label: 'actual webhook fulfillment uses the validated current and historical bindings',
    file: 'src/saas.ts',
    needle: 'paymentLinkFulfillmentBindingsFromEnv(process.env)',
  },
  {
    label: 'historical Starter links must still be inactive at fulfillment time',
    file: 'src/routes/buyer-routes.ts',
    needle: 'historical-payment-link-reactivated',
  },
  {
    label: 'signed paid checkout verification failures are durably recorded',
    file: 'src/routes/buyer-routes.ts',
    needle: 'recordPaidCheckoutException(event',
  },
  {
    label: 'paid checkout rescue has a durable database table',
    file: 'src/saas.ts',
    needle: 'CREATE TABLE IF NOT EXISTS stripe_paid_checkout_exceptions',
  },
  {
    label: 'paid checkout rescue is surfaced in the operator queue',
    file: 'src/routes/provisioning-routes.ts',
    needle: "WHEN pr.source = 'stripe_checkout_exception'",
  },
  {
    label: 'first-dollar live env mutation has a dedicated explicit confirmation',
    file: 'scripts/set-first-dollar-live-env.sh',
    needle: 'CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE=apply-smirk-first-dollar-live-env',
  },
  {
    label: 'first-dollar live env staging requires the exact pending manifest digest',
    file: 'scripts/set-first-dollar-live-env.sh',
    needle: 'CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST',
  },
  {
    label: 'Starter checkout exposure has a separate exact machine confirmation on activation deploy',
    file: 'scripts/check-first-dollar-pending-env-activation.mjs',
    needle: 'FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.realStarterCheckout',
  },
  {
    label: 'pending Starter activation has a distinct deploy confirmation',
    file: 'scripts/lib/first-dollar-pending-env.mjs',
    needle: 'CONFIRM_SMIRK_FIRST_DOLLAR_ACTIVATION_DEPLOY',
  },
  {
    label: 'real revenue contract runs adversarial Starter-only setter fixtures',
    file: 'package.json',
    needle: 'check-first-dollar-live-env-setter-fixtures.mjs',
  },
  {
    label: 'real revenue contract runs exact fulfillment ID fixtures',
    file: 'package.json',
    needle: 'check-payment-link-fulfillment-ids-fixtures.mjs',
  },
  {
    label: 'first-dollar approval packet includes Stripe smoke approval phrase',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE',
  },
  {
    label: 'first-dollar approval packet includes separate cleanup approval phrase',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'APPROVE_SMIRK_SMOKE_CLEANUP_APPLY',
  },
  {
    label: 'first-dollar approval packet printer refuses missing Stripe smoke approval phrase',
    file: 'scripts/print-first-dollar-approval-packet.mjs',
    needle: 'stripeSmokeApprovalPhrase',
  },
  {
    label: 'first-dollar approval packet printer refuses missing cleanup approval phrase',
    file: 'scripts/print-first-dollar-approval-packet.mjs',
    needle: 'smokeCleanupApprovalPhrase',
  },
  {
    label: 'first-dollar approval packet recommends deploy before paid/proof checks when production is stale',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'Approve the production deploy first. The local proof-hardening bundle is ready, but production is stale; running paid-path or proof-call checks before deploy risks proving the wrong code.',
  },
  {
    label: 'first-dollar approval packet advances to Stripe smoke when live is already current',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'Production is already current and the deploy-relevant working tree is clean. The next approval-gated money-path proof is the signed Stripe webhook smoke after live and buffer checks pass.',
  },
  {
    label: 'first-dollar approval packet omits deploy command from live-current recommended action',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'Deploy command intentionally omitted from the recommended action because this packet is for the current live commit.',
  },
  {
    label: 'first-dollar approval packet includes checkout-status activation labels',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'checkout-status returns public activation labels: `request_summary.status_label` and `next_step_label`',
  },
  {
    label: 'first-dollar approval packet includes sanitized checkout reference proof',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'checkout-status acknowledges the checkout reference without exposing the raw Stripe checkout session ID',
  },
  {
    label: 'first-dollar approval packet requires separate scoped outreach authority',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'APPROVE_SMIRK_OUTREACH_BATCH: targets=<exact-list-or-ledger-ids>; channel=<exact-approved-channel>; copy=<exact-reviewed-template-or-hash>; batch=<exact-count>',
  },
  {
    label: 'first-dollar approval packet never treats proof as outreach authority',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'proof or manual-fallback disclosure is not outreach authority',
  },
  {
    label: 'first-dollar approval packet numbers inert environment staging separately',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: '## Approval 4: Stage Pending Live Railway Environment (No Deploy)',
  },
  {
    label: 'first-dollar approval packet numbers real Starter activation authority separately',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: '## Approval 5: Deploy and Activate Real Starter Checkout',
  },
  {
    label: 'first-dollar approval packet routes activation through exact pending manifest inspection',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'npm run -s print:first-dollar-pending-env-activation',
  },
  {
    label: 'first-dollar approval packet numbers target-specific proof-call authority',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: '## Approval 6: One Pinned Real Proof Call',
  },
  {
    label: 'first-dollar approval packet requires separate cleanup approval',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'Do not apply confirmed smoke cleanup without separate explicit cleanup approval.',
  },
  {
    label: 'first-dollar approval packet states deploy approval does not authorize Stripe smoke',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'Deploy approval does not authorize the signed Stripe webhook smoke.',
  },
  {
    label: 'first-dollar approval packet printer refuses missing deploy-to-Stripe-smoke boundary',
    file: 'scripts/print-first-dollar-approval-packet.mjs',
    needle: 'Deploy approval does not authorize the signed Stripe webhook smoke.',
  },
  {
    label: 'deploy approval bundle refreshes first-dollar approval packet',
    file: 'scripts/write-deploy-approval-bundle.mjs',
    needle: "write:first-dollar-approval-packet",
  },
  {
    label: 'deploy approval bundle refreshes Stripe smoke approval when live current',
    file: 'scripts/write-deploy-approval-bundle.mjs',
    needle: "write:stripe-webhook-smoke-approval",
  },
  {
    label: 'first-dollar packet refuses stale Stripe smoke approval when live current',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'stale-stripe-webhook-smoke-approval-artifact',
  },
  {
    label: 'first-dollar packet records Stripe approval artifact freshness',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'Stripe approval artifact current:',
  },
  {
    label: 'first-dollar packet printer validates Stripe approval artifact freshness',
    file: 'scripts/print-first-dollar-approval-packet.mjs',
    needle: 'Stripe approval artifact current: yes',
  },
  {
    label: 'deploy approval handoff requires first-dollar approval packet',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'output/first-dollar-approval-packet.md',
  },
  {
    label: 'deploy approval handoff requires Stripe smoke approval JSON',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'output/stripe-webhook-smoke-approval.json',
  },
  {
    label: 'deploy approval handoff requires Stripe smoke approval note',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'output/stripe-webhook-smoke-approval.md',
  },
  {
    label: 'deploy approval handoff validates packet deploy file count',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'first-dollar approval packet must include deploy-relevant file count',
  },
  {
    label: 'deploy approval handoff validates packet checkout-status activation labels',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'checkout-status returns public activation labels: `request_summary.status_label` and `next_step_label`',
  },
  {
    label: 'deploy approval handoff validates packet sanitized checkout reference proof',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'checkout-status acknowledges the checkout reference without exposing the raw Stripe checkout session ID',
  },
  {
    label: 'deploy approval handoff validates packet Stripe smoke approval phrase',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE: ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live',
  },
  {
    label: 'deploy approval handoff validates packet cleanup approval phrase',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'APPROVE_SMIRK_SMOKE_CLEANUP_APPLY: APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply',
  },
  {
    label: 'deploy approval handoff validates separate cleanup approval stop rule',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'Do not apply confirmed smoke cleanup without separate explicit cleanup approval.',
  },
  {
    label: 'Stripe smoke approval print command reads existing note',
    file: 'scripts/print-stripe-webhook-smoke-approval.mjs',
    needle: 'readFileSync(notePath',
  },
  {
    label: 'Stripe smoke approval print command does not regenerate artifacts',
    file: 'scripts/print-stripe-webhook-smoke-approval.mjs',
    needle: 'missing-stripe-webhook-smoke-approval-artifacts',
  },
  {
    label: 'Stripe smoke approval print command refuses stale approval phrases',
    file: 'scripts/print-stripe-webhook-smoke-approval.mjs',
    needle: 'stripe-webhook-smoke-approval-phrase-drift',
  },
  {
    label: 'Stripe smoke approval readiness stays non-mutating',
    file: 'scripts/check-stripe-webhook-smoke-approval-ready.mjs',
    needle: 'approval-ready check must be non-mutating',
  },
  {
    label: 'Stripe smoke approval readiness validates exact approval command',
    file: 'scripts/check-stripe-webhook-smoke-approval-ready.mjs',
    needle: 'approval JSON commandToApprove drifted',
  },
  {
    label: 'Stripe smoke approval note includes explicit approval phrase',
    file: 'scripts/write-stripe-webhook-smoke-approval.mjs',
    needle: 'APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE',
  },
  {
    label: 'Stripe smoke approval readiness validates explicit approval phrase',
    file: 'scripts/check-stripe-webhook-smoke-approval-ready.mjs',
    needle: 'approval note must include exact approval phrase',
  },
  {
    label: 'Stripe webhook handoff live sends checkout session reference',
    file: 'scripts/check-stripe-webhook-handoff-live.mjs',
    needle: 'checkout_session_id: sessionId',
  },
  {
    label: 'Stripe webhook handoff live verifies checkout reference receipt',
    file: 'scripts/check-stripe-webhook-handoff-live.mjs',
    needle: 'checkout_reference_received !== true',
  },
  {
    label: 'Stripe webhook handoff live verifies checkout session id is not exposed',
    file: 'scripts/check-stripe-webhook-handoff-live.mjs',
    needle: 'checkout_session_id_exposed',
  },
  {
    label: 'Stripe smoke approval readiness validates sanitized checkout reference proof',
    file: 'scripts/check-stripe-webhook-smoke-approval-ready.mjs',
    needle: 'approval note must require sanitized checkout reference proof after smoke',
  },
  {
    label: 'Stripe smoke cleanup apply uses separate approval phrase',
    file: 'scripts/write-stripe-webhook-smoke-approval.mjs',
    needle: 'APPROVE_SMIRK_SMOKE_CLEANUP_APPLY',
  },
  {
    label: 'Stripe smoke approval readiness validates separate cleanup approval phrase',
    file: 'scripts/check-stripe-webhook-smoke-approval-ready.mjs',
    needle: 'approval note must include separate cleanup approval phrase',
  },
  {
    label: 'Stripe smoke approval readiness validates cleanup baseline',
    file: 'scripts/check-stripe-webhook-smoke-approval-ready.mjs',
    needle: 'approval JSON must start with zero smoke provisioning rows',
  },
  {
    label: 'Stripe webhook smoke enforces cleanup dry-run visibility',
    file: 'scripts/check-stripe-webhook-handoff-live.mjs',
    needle: 'smoke cleanup dry-run did not see the signed webhook provisioning row',
  },
  {
    label: 'Stripe webhook smoke runs cleanup with same live app URL',
    file: 'scripts/check-stripe-webhook-handoff-live.mjs',
    needle: 'env: { ...process.env, APP_URL: appUrl }',
  },
  {
    label: 'Stripe webhook smoke reports cleanup visibility',
    file: 'scripts/check-stripe-webhook-handoff-live.mjs',
    needle: 'provisioning_request_visible',
  },
  {
    label: 'Stripe webhook handoff retries transient live fetch failures',
    file: 'scripts/check-stripe-webhook-handoff-live.mjs',
    needle: 'fetchTextWithRetry',
  },
  {
    label: 'Stripe webhook handoff emits structured fetch failure JSON',
    file: 'scripts/check-stripe-webhook-handoff-live.mjs',
    needle: 'stripe-webhook-fetch-failed',
  },
  {
    label: 'Stripe webhook handoff uses bounded fetch timeout',
    file: 'scripts/check-stripe-webhook-handoff-live.mjs',
    needle: 'SMIRK_STRIPE_WEBHOOK_FETCH_TIMEOUT_MS',
  },
  {
    label: 'Stripe webhook approval note documents cleanup visibility enforcement',
    file: 'scripts/write-stripe-webhook-smoke-approval.mjs',
    needle: 'The smoke checker must run cleanup dry-run and confirm the created provisioning row is visible before reporting success.',
  },
  {
    label: 'Stripe webhook approval note separates cleanup apply approval',
    file: 'scripts/write-stripe-webhook-smoke-approval.mjs',
    needle: 'Do not run confirmed cleanup apply without separate explicit cleanup approval after reviewing the dry-run.',
  },
  {
    label: 'Stripe webhook approval readiness enforces cleanup apply approval separation',
    file: 'scripts/check-stripe-webhook-smoke-approval-ready.mjs',
    needle: 'approval note must separate cleanup apply approval from smoke approval',
  },
  {
    label: 'Stripe webhook preflight can use recent cached approval on Railway rate limit',
    file: 'scripts/check-stripe-webhook-handoff-live.mjs',
    needle: 'cachedApprovalPreflightUsed',
  },
  {
    label: 'Stripe webhook preflight cache fallback only handles retryable Railway errors',
    file: 'scripts/check-stripe-webhook-handoff-live.mjs',
    needle: 'railwayErrorRetryable',
  },
  {
    label: 'Stripe webhook preflight cache fallback does not fabricate signed-run secret',
    file: 'scripts/check-stripe-webhook-handoff-live.mjs',
    needle: 'canRunSignatureOnly: Boolean(webhookSecret)',
  },
  {
    label: 'deploy preflight runs live operational auth guard',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: "check:operational-auth-live",
  },
  {
    label: 'deploy preflight exposes operationalAuthLive result',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'operationalAuthLive',
  },
  {
    label: 'operational auth live guard retries transient live fetch failures',
    file: 'scripts/check-operational-auth-live.mjs',
    needle: 'fetchTextWithRetry',
  },
  {
    label: 'operational auth live guard emits structured fetch failure JSON',
    file: 'scripts/check-operational-auth-live.mjs',
    needle: 'operational-auth-fetch-failed',
  },
  {
    label: 'operational auth live guard uses bounded fetch timeout',
    file: 'scripts/check-operational-auth-live.mjs',
    needle: 'SMIRK_OPERATIONAL_AUTH_FETCH_TIMEOUT_MS',
  },
  {
    label: 'deploy preflight runs correlated proof artifact guard',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: "check:proof-artifacts-live",
  },
  {
    label: 'proof artifact guard retries transient live fetch failures',
    file: 'scripts/check-proof-artifacts-live.mjs',
    needle: 'fetchTextWithRetry',
  },
  {
    label: 'proof artifact guard emits structured fetch failure JSON',
    file: 'scripts/check-proof-artifacts-live.mjs',
    needle: 'proof-artifact-fetch-failed',
  },
  {
    label: 'proof artifact guard uses bounded fetch timeout',
    file: 'scripts/check-proof-artifacts-live.mjs',
    needle: 'SMIRK_PROOF_ARTIFACT_FETCH_TIMEOUT_MS',
  },
  {
    label: 'proof artifact guard verifies proof artifact cache control',
    file: 'scripts/check-proof-artifacts-live.mjs',
    needle: 'cacheProtected',
  },
  {
    label: 'call artifact route disables response caching',
    file: 'src/routes/call-routes.ts',
    needle: 'Cache-Control", "no-store"',
  },
  {
    label: 'task artifact route disables response caching',
    file: 'src/routes/task-routes.ts',
    needle: 'Cache-Control", "no-store"',
  },
  {
    label: 'event artifact route disables response caching',
    file: 'src/routes/proof-routes.ts',
    needle: 'Cache-Control", "no-store"',
  },
  {
    label: 'deploy preflight exposes proofArtifactsLive result',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'proofArtifactsLive',
  },
  {
    label: 'deploy preflight runs post-call intelligence guard',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: "check:post-call-intelligence-live",
  },
  {
    label: 'post-call intelligence guard retries transient live fetch failures',
    file: 'scripts/check-post-call-intelligence-live.mjs',
    needle: 'fetchTextWithRetry',
  },
  {
    label: 'post-call intelligence guard emits structured fetch failure JSON',
    file: 'scripts/check-post-call-intelligence-live.mjs',
    needle: 'post-call-intelligence-fetch-failed',
  },
  {
    label: 'post-call intelligence guard uses bounded fetch timeout',
    file: 'scripts/check-post-call-intelligence-live.mjs',
    needle: 'SMIRK_POST_CALL_INTELLIGENCE_FETCH_TIMEOUT_MS',
  },
  {
    label: 'deploy preflight exposes postCallIntelligenceLive result',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: 'postCallIntelligenceLive',
  },
  {
    label: 'dashboard proof guard retries transient live fetch failures',
    file: 'scripts/check-dashboard-proof-live.mjs',
    needle: 'fetchTextWithRetry',
  },
  {
    label: 'dashboard proof guard emits structured fetch failure JSON',
    file: 'scripts/check-dashboard-proof-live.mjs',
    needle: 'dashboard-proof-fetch-failed',
  },
  {
    label: 'dashboard proof guard uses bounded fetch timeout',
    file: 'scripts/check-dashboard-proof-live.mjs',
    needle: 'SMIRK_DASHBOARD_PROOF_FETCH_TIMEOUT_MS',
  },
  {
    label: 'public proof route disables response caching',
    file: 'src/routes/proof-routes.ts',
    needle: 'Cache-Control", "no-store"',
  },
  {
    label: 'dashboard proof guard verifies public proof cache control',
    file: 'scripts/check-dashboard-proof-live.mjs',
    needle: 'publicCacheProtected',
  },
  {
    label: 'proof freshness guard retries transient live fetch failures',
    file: 'scripts/check-proof-freshness-live.mjs',
    needle: 'fetchTextWithRetry',
  },
  {
    label: 'proof freshness guard emits structured fetch failure JSON',
    file: 'scripts/check-proof-freshness-live.mjs',
    needle: 'proof-freshness-fetch-failed',
  },
  {
    label: 'proof freshness guard uses bounded fetch timeout',
    file: 'scripts/check-proof-freshness-live.mjs',
    needle: 'SMIRK_PROOF_FRESHNESS_FETCH_TIMEOUT_MS',
  },
  {
    label: 'proof freshness guard verifies public proof cache control',
    file: 'scripts/check-proof-freshness-live.mjs',
    needle: 'cacheProtected',
  },
  {
    label: 'proof loop guard retries transient live fetch failures',
    file: 'scripts/check-proof-loop-live.mjs',
    needle: 'fetchTextWithRetry',
  },
  {
    label: 'proof loop guard emits structured fetch failure JSON',
    file: 'scripts/check-proof-loop-live.mjs',
    needle: 'proof-loop-fetch-failed',
  },
  {
    label: 'proof loop guard uses bounded fetch timeout',
    file: 'scripts/check-proof-loop-live.mjs',
    needle: 'SMIRK_PROOF_LOOP_FETCH_TIMEOUT_MS',
  },
  {
    label: 'system health route disables response caching',
    file: 'src/routes/system-health-routes.ts',
    needle: 'Cache-Control", "no-store"',
  },
  {
    label: 'proof loop guard verifies system health cache control',
    file: 'scripts/check-proof-loop-live.mjs',
    needle: 'cacheProtected',
  },
  {
    label: 'buyer route live guard retries transient live fetch failures',
    file: 'scripts/check-live-buyer-routes.mjs',
    needle: 'fetchTextWithRetry',
  },
  {
    label: 'buyer route live guard emits structured fetch failure JSON',
    file: 'scripts/check-live-buyer-routes.mjs',
    needle: 'buyer-route-fetch-failed',
  },
  {
    label: 'buyer route live guard uses bounded fetch timeout',
    file: 'scripts/check-live-buyer-routes.mjs',
    needle: 'SMIRK_BUYER_ROUTES_FETCH_TIMEOUT_MS',
  },
  {
    label: 'buyer route live guard verifies activation cache control',
    file: 'scripts/check-live-buyer-routes.mjs',
    needle: 'function cacheProtected',
  },
  {
    label: 'buyer route live guard verifies pricing cache control',
    file: 'scripts/check-live-buyer-routes.mjs',
    needle: 'status !== 200 || !cacheProtected(headers)',
  },
  {
    label: 'pricing consistency guards checkout cache control',
    file: 'scripts/check-pricing-consistency.mjs',
    needle: 'checkout create route must disable response caching',
  },
  {
    label: 'pricing consistency guards pricing cache control',
    file: 'scripts/check-pricing-consistency.mjs',
    needle: 'pricing API route must disable response caching',
  },
  {
    label: 'pricing consistency guards first-dollar readiness cache control',
    file: 'scripts/check-pricing-consistency.mjs',
    needle: 'first-dollar readiness route must disable response caching',
  },
  {
    label: 'operator session live guard retries transient live fetch failures',
    file: 'scripts/check-operator-session-live.mjs',
    needle: 'fetchOperatorSessionWithRetry',
  },
  {
    label: 'operator session live guard emits structured fetch failure JSON',
    file: 'scripts/check-operator-session-live.mjs',
    needle: 'operator-session-fetch-failed',
  },
  {
    label: 'operator session live guard uses bounded fetch timeout',
    file: 'scripts/check-operator-session-live.mjs',
    needle: 'SMIRK_OPERATOR_SESSION_FETCH_TIMEOUT_MS',
  },
  {
    label: 'live app critical health guard retries transient live fetch failures',
    file: 'scripts/check-live-app-critical-health.mjs',
    needle: 'fetchTextWithRetry',
  },
  {
    label: 'live app critical health guard emits structured fetch failure JSON',
    file: 'scripts/check-live-app-critical-health.mjs',
    needle: 'live-app-health-fetch-failed',
  },
  {
    label: 'live app critical health guard uses bounded fetch timeout',
    file: 'scripts/check-live-app-critical-health.mjs',
    needle: 'SMIRK_LIVE_APP_HEALTH_FETCH_TIMEOUT_MS',
  },
  {
    label: 'live database health guard retries transient live fetch failures',
    file: 'scripts/check-live-db-health.mjs',
    needle: 'fetchHealthWithRetry',
  },
  {
    label: 'live database health guard emits structured fetch failure JSON',
    file: 'scripts/check-live-db-health.mjs',
    needle: 'live-db-health-fetch-failed',
  },
  {
    label: 'live database health guard uses bounded fetch timeout',
    file: 'scripts/check-live-db-health.mjs',
    needle: 'SMIRK_LIVE_DB_HEALTH_FETCH_TIMEOUT_MS',
  },
  {
    label: 'Railway DB wiring guard retries transient live fetch failures',
    file: 'scripts/check-railway-db-wiring.mjs',
    needle: 'fetchHealthWithRetry',
  },
  {
    label: 'Railway DB wiring guard emits structured fetch failure JSON',
    file: 'scripts/check-railway-db-wiring.mjs',
    needle: 'railway-db-wiring-fetch-failed',
  },
  {
    label: 'Railway DB wiring guard uses bounded fetch timeout',
    file: 'scripts/check-railway-db-wiring.mjs',
    needle: 'SMIRK_RAILWAY_DB_WIRING_FETCH_TIMEOUT_MS',
  },
  {
    label: 'google auth live guard retries transient live fetch failures',
    file: 'scripts/check-google-auth-live.mjs',
    needle: 'fetchConfigWithRetry',
  },
  {
    label: 'google auth live guard emits structured fetch failure JSON',
    file: 'scripts/check-google-auth-live.mjs',
    needle: 'google-auth-fetch-failed',
  },
  {
    label: 'google auth live guard uses bounded fetch timeout',
    file: 'scripts/check-google-auth-live.mjs',
    needle: 'SMIRK_GOOGLE_AUTH_FETCH_TIMEOUT_MS',
  },
  {
    label: 'google auth setup helper retries transient live fetch failures',
    file: 'scripts/print-google-auth-setup.mjs',
    needle: 'fetchConfigWithRetry',
  },
  {
    label: 'google auth setup helper emits bounded fetch failure detail',
    file: 'scripts/print-google-auth-setup.mjs',
    needle: 'google-auth-setup-fetch-failed',
  },
  {
    label: 'google auth setup helper uses bounded fetch timeout',
    file: 'scripts/print-google-auth-setup.mjs',
    needle: 'SMIRK_GOOGLE_AUTH_SETUP_FETCH_TIMEOUT_MS',
  },
  {
    label: 'local runtime smoke emits structured fetch failure JSON',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: 'local-runtime-fetch-failed',
  },
  {
    label: 'local runtime smoke emits structured startup timeout JSON',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: 'local-runtime-startup-timeout',
  },
  {
    label: 'local runtime smoke uses bounded fetch timeout',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: 'SMIRK_LOCAL_RUNTIME_FETCH_TIMEOUT_MS',
  },
  {
    label: 'local runtime smoke injects an isolated ephemeral operator key into its production child',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: 'DASHBOARD_API_KEY: smokeOperatorApiKey',
  },
  {
    label: 'local runtime smoke cannot inherit a production database connection',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: "DATABASE_URL: ''",
  },
  {
    label: 'local runtime smoke uses an explicit runtime-only environment allowlist',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: 'const runtimeEnvironmentKeys = [',
  },
  {
    label: 'local runtime smoke enumerates forbidden external provider environment keys',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: 'const externalProviderEnvKeys = Object.freeze([',
  },
  {
    label: 'local runtime smoke excludes Twilio credentials',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: "'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'",
  },
  {
    label: 'local runtime smoke excludes Stripe credentials',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: "'STRIPE_SECRET_KEY', 'STRIPE_REVENUE_READ_KEY', 'STRIPE_BILLING_PORTAL_KEY'",
  },
  {
    label: 'local runtime smoke excludes email credentials and recipients',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: "'RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'FROM_EMAIL', 'FROM_NAME', 'OWNER_EMAIL'",
  },
  {
    label: 'local runtime smoke excludes outbound webhook destinations',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: "'WEBHOOK_URL', 'OUTBOUND_WEBHOOK_URL'",
  },
  {
    label: 'local runtime smoke excludes external AI provider credentials',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: "'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY'",
  },
  {
    label: 'local runtime smoke explicitly disables OpenClaw HTTP integration',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: "OPENCLAW_ENABLED: 'false'",
  },
  {
    label: 'local runtime smoke explicitly disables the default-enabled OpenClaw bridge',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: "OPENCLAW_BRIDGE_ENABLED: 'false'",
  },
  {
    label: 'local runtime smoke asserts provider credentials cannot reach the child',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: 'local-runtime-child-env-not-isolated',
  },
  {
    label: 'local runtime smoke prevents production settings-file credential loading',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: 'SETTINGS_PATH: isolatedSettingsPath',
  },
  {
    label: 'local runtime smoke runs from the bundled no-env child directory',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: 'cwd: childCwd',
  },
  {
    label: 'local runtime smoke verifies disabled providers through child health',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: 'providerIsolationOk',
  },
  {
    label: 'local runtime smoke rejects unauthenticated task access',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: 'unauthenticatedTasks.status === 401',
  },
  {
    label: 'local runtime smoke authenticates task access with the same ephemeral key',
    file: 'scripts/check-local-runtime-smoke.mjs',
    needle: "{ 'X-Api-Key': smokeOperatorApiKey }",
  },
  {
    label: 'deploy fingerprint guard retries transient live fetch failures',
    file: 'scripts/check-deploy-fingerprint.mjs',
    needle: 'fetchHealthWithRetry',
  },
  {
    label: 'deploy fingerprint guard emits structured fetch failure JSON',
    file: 'scripts/check-deploy-fingerprint.mjs',
    needle: 'deploy-fingerprint-fetch-failed',
  },
  {
    label: 'deploy fingerprint guard uses bounded fetch timeout',
    file: 'scripts/check-deploy-fingerprint.mjs',
    needle: 'SMIRK_DEPLOY_FINGERPRINT_FETCH_TIMEOUT_MS',
  },
  {
    label: 'domain cutover guard retries transient Railway fetch failures',
    file: 'scripts/check-domain-cutover.mjs',
    needle: 'fetchRailwayGraphqlWithRetry',
  },
  {
    label: 'domain cutover guard emits structured Railway fetch failure JSON',
    file: 'scripts/check-domain-cutover.mjs',
    needle: 'domain-cutover-railway-fetch-failed',
  },
  {
    label: 'domain cutover guard uses bounded Railway fetch timeout',
    file: 'scripts/check-domain-cutover.mjs',
    needle: 'SMIRK_DOMAIN_CUTOVER_RAILWAY_FETCH_TIMEOUT_MS',
  },
  {
    label: 'landing readiness guard retries transient live fetch failures',
    file: 'scripts/check-landing-live-readiness.mjs',
    needle: 'fetchTextWithRetry',
  },
  {
    label: 'landing readiness guard emits structured fetch failure JSON',
    file: 'scripts/check-landing-live-readiness.mjs',
    needle: 'landing-readiness-fetch-failed',
  },
  {
    label: 'landing readiness guard uses bounded fetch timeout',
    file: 'scripts/check-landing-live-readiness.mjs',
    needle: 'SMIRK_LANDING_READINESS_FETCH_TIMEOUT_MS',
  },
  {
    label: 'Railway Resend domain guard retries transient live fetch failures',
    file: 'scripts/check-railway-resend-domain-readiness.mjs',
    needle: 'fetchResendTextWithRetry',
  },
  {
    label: 'Railway Resend domain guard emits structured fetch failure JSON',
    file: 'scripts/check-railway-resend-domain-readiness.mjs',
    needle: 'railway-resend-domain-fetch-failed',
  },
  {
    label: 'Railway Resend domain guard uses bounded fetch timeout',
    file: 'scripts/check-railway-resend-domain-readiness.mjs',
    needle: 'SMIRK_RAILWAY_RESEND_DOMAIN_FETCH_TIMEOUT_MS',
  },
  {
    label: 'local Resend domain guard retries transient live fetch failures',
    file: 'scripts/check-resend-domain-readiness.mjs',
    needle: 'fetchResendDomainsWithRetry',
  },
  {
    label: 'local Resend domain guard emits structured fetch failure JSON',
    file: 'scripts/check-resend-domain-readiness.mjs',
    needle: 'resend-domain-fetch-failed',
  },
  {
    label: 'local Resend domain guard uses bounded fetch timeout',
    file: 'scripts/check-resend-domain-readiness.mjs',
    needle: 'SMIRK_RESEND_DOMAIN_FETCH_TIMEOUT_MS',
  },
  {
    label: 'reprocess latest call live script reports bounded fetch failure',
    file: 'scripts/reprocess-latest-call-live.mjs',
    needle: 'reprocess-latest-call-fetch-failed',
  },
  {
    label: 'reprocess latest call live script uses bounded fetch timeout',
    file: 'scripts/reprocess-latest-call-live.mjs',
    needle: 'SMIRK_REPROCESS_FETCH_TIMEOUT_MS',
  },
  {
    label: 'live deploy readiness runs no-texting guard',
    file: 'scripts/check-live-deploy-readiness.mjs',
    needle: "check:no-texting-copy",
  },
  {
    label: 'live deploy readiness runs OpenAPI route inventory guard',
    file: 'scripts/check-live-deploy-readiness.mjs',
    needle: "check:openapi",
  },
  {
    label: 'live deploy readiness runs local auth regression guard',
    file: 'scripts/check-live-deploy-readiness.mjs',
    needle: "check:auth",
  },
  {
    label: 'live deploy readiness runs paid handoff safety guard',
    file: 'scripts/check-live-deploy-readiness.mjs',
    needle: "check:paid-handoff-safety",
  },
  {
    label: 'live deploy readiness runs self-serve activation contract guard',
    file: 'scripts/check-live-deploy-readiness.mjs',
    needle: "check:self-serve-activation",
  },
  {
    label: 'live deploy readiness runs client onboarding intake contract guard',
    file: 'scripts/check-live-deploy-readiness.mjs',
    needle: "check:client-onboarding-intake",
  },
  {
    label: 'live deploy readiness runs Stripe webhook handoff preflight',
    file: 'scripts/check-live-deploy-readiness.mjs',
    needle: "check:stripe-webhook-handoff-live:preflight",
  },
  {
    label: 'live deploy readiness runs Stripe smoke approval readiness',
    file: 'scripts/check-live-deploy-readiness.mjs',
    needle: "check:stripe-webhook-smoke-approval-ready",
  },
  {
    label: 'launch blockers run no-texting guard',
    file: 'scripts/check-launch-blockers.sh',
    needle: 'check:no-texting-copy',
  },
  {
    label: 'launch blockers run OpenAPI route inventory guard',
    file: 'scripts/check-launch-blockers.sh',
    needle: 'check:openapi',
  },
  {
    label: 'launch blockers run paid handoff safety guard',
    file: 'scripts/check-launch-blockers.sh',
    needle: 'check:paid-handoff-safety',
  },
  {
    label: 'launch blockers run self-serve activation contract guard',
    file: 'scripts/check-launch-blockers.sh',
    needle: 'check:self-serve-activation',
  },
  {
    label: 'launch blockers run client onboarding intake contract guard',
    file: 'scripts/check-launch-blockers.sh',
    needle: 'check:client-onboarding-intake',
  },
  {
    label: 'launch blockers run Stripe webhook handoff preflight',
    file: 'scripts/check-launch-blockers.sh',
    needle: 'check:stripe-webhook-handoff-live:preflight',
  },
  {
    label: 'launch blockers run Stripe smoke approval readiness',
    file: 'scripts/check-launch-blockers.sh',
    needle: 'check:stripe-webhook-smoke-approval-ready',
  },
  {
    label: 'launch blockers run live operational auth guard',
    file: 'scripts/check-launch-blockers.sh',
    needle: 'check:operational-auth-live',
  },
  {
    label: 'launch blockers run correlated proof artifact guard',
    file: 'scripts/check-launch-blockers.sh',
    needle: 'check:proof-artifacts-live',
  },
  {
    label: 'launch blockers run post-call intelligence guard',
    file: 'scripts/check-launch-blockers.sh',
    needle: 'check:post-call-intelligence-live',
  },
  {
    label: 'deploy script runs deploy preflight',
    file: 'deploy.sh',
    needle: 'check:deploy-post-call-fix-ready',
  },
  {
    label: 'deploy script verifies pending first-dollar activation authority before upload',
    file: 'deploy.sh',
    needle: 'check:first-dollar-pending-env-activation',
  },
  {
    label: 'pending first-dollar manifest uses SHA-256 over canonical unmasked assignments',
    file: 'scripts/lib/first-dollar-pending-env.mjs',
    needle: 'createHash("sha256")',
  },
  {
    label: 'pending first-dollar manifest pins the exact production Railway target',
    file: 'scripts/lib/first-dollar-pending-env.mjs',
    needle: '90599f03-6d6f-4044-8933-e0301be67a82',
  },
  {
    label: 'pending first-dollar activation recomputes the exact staged assignment values',
    file: 'scripts/lib/first-dollar-pending-env.mjs',
    needle: 'pending-env-digest-mismatch',
  },
  {
    label: 'deploy records pending first-dollar activation receipt only after live ship checks',
    file: 'deploy.sh',
    needle: 'record:first-dollar-activation-receipt',
  },
  {
    label: 'pending first-dollar activation receipt suppresses implicit deploys',
    file: 'scripts/record-first-dollar-activation-receipt.mjs',
    needle: 'skipDeploys: true',
  },
  {
    label: 'pending first-dollar activation receipt preserves manifest evidence',
    file: 'scripts/record-first-dollar-activation-receipt.mjs',
    needle: 'FIRST_DOLLAR_ACTIVATED_ENV_RECEIPT',
  },
  {
    label: 'pending first-dollar activation receipt independently verifies exact rollout success',
    file: 'scripts/record-first-dollar-activation-receipt.mjs',
    needle: 'deploymentMatchesPendingActivation',
  },
  {
    label: 'pending first-dollar activation receipt independently reruns full live ship proof',
    file: 'scripts/record-first-dollar-activation-receipt.mjs',
    needle: '["run", "-s", "check:ship-live"]',
  },
  {
    label: 'deploy passes the exact captured baseline into receipt verification',
    file: 'deploy.sh',
    needle: 'SMIRK_PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON="$PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON" npm run -s record:first-dollar-activation-receipt',
  },
  {
    label: 'pending first-dollar activation captures pre-upload exact-target deployment IDs and nonce',
    file: 'scripts/capture-first-dollar-pending-env-deployment-baseline.mjs',
    needle: 'pendingActivationUploadMessage',
  },
  {
    label: 'pending first-dollar activation waits for the exact nonce-bound reviewed upload before ship checks',
    file: 'scripts/wait-first-dollar-pending-env-deployment.mjs',
    needle: 'deploymentMatchesPendingActivation',
  },
  {
    label: 'deploy attaches exact pending activation binding to Railway upload',
    file: 'deploy.sh',
    needle: '--message "$PENDING_ACTIVATION_UPLOAD_MESSAGE"',
  },
  {
    label: 'guard coverage runs adversarial pending first-dollar env fixtures',
    file: 'package.json',
    needle: 'check-first-dollar-pending-env-fixtures.mjs',
  },
  {
    label: 'deploy script runs launch blockers',
    file: 'deploy.sh',
    needle: 'check:launch-blockers',
  },
  {
    label: 'bootstrap deploy mode uses a descriptive exact value',
    file: 'scripts/lib/first-dollar-bootstrap-deploy.mjs',
    needle: 'deploy-fail-closed-checkout',
  },
  {
    label: 'bootstrap deploy requires the existing deploy confirmation',
    file: 'scripts/lib/first-dollar-bootstrap-deploy.mjs',
    needle: 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY',
  },
  {
    label: 'bootstrap deploy requires exact branch confirmation',
    file: 'scripts/lib/first-dollar-bootstrap-deploy.mjs',
    needle: 'CONFIRM_SMIRK_DEPLOY_BRANCH',
  },
  {
    label: 'bootstrap deploy requires exact commit confirmation',
    file: 'scripts/lib/first-dollar-bootstrap-deploy.mjs',
    needle: 'CONFIRM_SMIRK_DEPLOY_COMMIT',
  },
  {
    label: 'bootstrap deploy proves healthy authoritative stale production',
    file: 'scripts/lib/first-dollar-bootstrap-deploy.mjs',
    needle: 'healthy authoritative live fingerprint mismatch',
  },
  {
    label: 'bootstrap deploy requires strict local revenue contract passes',
    file: 'scripts/lib/first-dollar-bootstrap-deploy.mjs',
    needle: 'REQUIRED_BOOTSTRAP_PREFLIGHT_PASSES',
  },
  {
    label: 'bootstrap deploy keeps proof artifacts explicitly blocked until deploy',
    file: 'scripts/lib/first-dollar-bootstrap-deploy.mjs',
    needle: "'proofArtifactsLive',",
  },
  {
    label: 'bootstrap deploy keeps post-call inspection explicitly blocked until deploy',
    file: 'scripts/lib/first-dollar-bootstrap-deploy.mjs',
    needle: "'postCallIntelligenceLive',",
  },
  {
    label: 'pre-deploy launch audit bypasses env only after stale preflight proof',
    file: 'scripts/check-launch-blockers.sh',
    needle: '[ "$predeploy_stale_expected" -eq 1 ]',
  },
  {
    label: 'pre-deploy launch audit validates the exact bootstrap authority',
    file: 'scripts/check-launch-blockers.sh',
    needle: 'node scripts/check-first-dollar-bootstrap-deploy.mjs',
  },
  {
    label: 'legacy landing readiness bootstrap is exact and authoritative',
    file: 'scripts/lib/legacy-landing-bootstrap-readiness.mjs',
    needle: "AUTHORITATIVE_LANDING_ORIGIN = 'https://smirkcalls.com'",
  },
  {
    label: 'pre-deploy launch audit retains strict landing readiness before legacy bootstrap',
    file: 'scripts/check-launch-blockers.sh',
    needle: 'landing_readiness_output="$(npm run -s check:landing-live 2>&1)"',
  },
  {
    label: 'pre-deploy launch audit permits only the exact legacy landing contract',
    file: 'scripts/check-launch-blockers.sh',
    needle: 'npm run -s check:landing-legacy-bootstrap',
  },
  {
    label: 'ordinary launch audit retains the strict live first-dollar env command',
    file: 'scripts/check-launch-blockers.sh',
    needle: 'npm run -s check:railway:first-dollar-env',
  },
  {
    label: 'deploy validates bootstrap authority against captured guarded preflight',
    file: 'deploy.sh',
    needle: "printf '%s' \"$DEPLOY_PREFLIGHT_JSON\" | node scripts/check-first-dollar-bootstrap-deploy.mjs",
  },
  {
    label: 'deploy clears bootstrap authority before strict post-deploy ship checks',
    file: 'deploy.sh',
    needle: 'env -u SMIRK_FIRST_DOLLAR_ENV_BOOTSTRAP_DEPLOY -u SMIRK_PRE_DEPLOY_LAUNCH_AUDIT npm run check:ship-live',
  },
  {
    label: 'fingerprint stamp validates bootstrap authority after live env failure',
    file: 'scripts/stamp-railway-deploy-fingerprint.mjs',
    needle: 'evaluateFirstDollarBootstrapDeploy',
  },
  {
    label: 'fingerprint stamp reruns the strict revenue contract at mutation boundary',
    file: 'scripts/stamp-railway-deploy-fingerprint.mjs',
    needle: 'check:real-revenue-contract',
  },
  {
    label: 'fingerprint stamp reruns paid handoff safety at mutation boundary',
    file: 'scripts/stamp-railway-deploy-fingerprint.mjs',
    needle: 'check:paid-handoff-safety',
  },
  {
    label: 'fingerprint stamp reruns first-dollar guard coverage at mutation boundary',
    file: 'scripts/stamp-railway-deploy-fingerprint.mjs',
    needle: 'check:first-dollar-guard-coverage',
  },
  {
    label: 'guard coverage runs adversarial bootstrap deploy fixtures',
    file: 'package.json',
    needle: 'check-first-dollar-bootstrap-deploy-fixtures.mjs',
  },
  {
    label: 'deploy approval request includes bootstrap mode only when live first-dollar env is incomplete',
    file: 'scripts/print-deploy-approval-request.mjs',
    needle: 'const firstDollarBootstrapDeployRequired = !liveFingerprintCurrent && !liveFirstDollarEnvReady',
  },
  {
    label: 'deploy approval request carries the narrowly scoped bootstrap meaning',
    file: 'scripts/print-deploy-approval-request.mjs',
    needle: 'It does not authorize opening checkout, changing live env, charging, proof calls, outreach, or treating post-deploy ship checks as passed.',
  },
  {
    label: 'deploy approval bundle carries bootstrap deploy authority explicitly',
    file: 'scripts/write-deploy-approval-bundle.mjs',
    needle: 'firstDollarBootstrapDeployRequired: handoffData?.firstDollarBootstrapDeployRequired === true',
  },
  {
    label: 'first-dollar approval packet prints bootstrap deploy scope when required',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'Bootstrap mode required by the reviewed command:',
  },
  {
    label: 'first-dollar packet writer refuses to drop required bootstrap deploy mode',
    file: 'scripts/write-first-dollar-approval-packet.mjs',
    needle: 'first-dollar-bootstrap-deploy-command-missing',
  },
  {
    label: 'first-dollar packet printer verifies exact bootstrap-mode deploy command',
    file: 'scripts/print-first-dollar-approval-packet.mjs',
    needle: 'first-dollar approval packet dropped the required bootstrap-mode deploy command',
  },
  {
    label: 'deploy approval handoff verifies packet preserves bootstrap-mode deploy command',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'first-dollar approval packet must expose the exact bootstrap-mode deploy command when required',
  },
  {
    label: 'deploy preflight reviews every Git-reported path and fails closed',
    file: 'scripts/check-deploy-post-call-fix-ready.mjs',
    needle: "status.ok ? dirtyFiles : ['<git-status-unavailable>']",
  },
  {
    label: 'deploy approval request uses shared deploy change set',
    file: 'scripts/print-deploy-approval-request.mjs',
    needle: 'collectDeployChangeSet',
  },
  {
    label: 'deploy approval bundle uses shared deploy change set',
    file: 'scripts/write-deploy-approval-bundle.mjs',
    needle: 'collectDeployChangeSet',
  },
  {
    label: 'deploy approval handoff uses shared deploy change set',
    file: 'scripts/check-deploy-approval-handoff.mjs',
    needle: 'collectDeployChangeSet',
  },
  {
    label: 'high-risk deploy review uses shared deploy change set',
    file: 'scripts/print-high-risk-deploy-review.mjs',
    needle: 'collectDeployChangeSet',
  },
  {
    label: 'shared deploy change set reviews every Git-reported path',
    file: 'scripts/lib/deploy-change-set.mjs',
    needle: 'Every path it reports',
  },
  {
    label: 'proof-call readiness fails closed when git status is unavailable',
    file: 'scripts/check-real-call-readiness.mjs',
    needle: "return ['<git-status-unavailable>']",
  },
  {
    label: 'git ignores generated outputs artifacts',
    file: '.gitignore',
    needle: 'outputs/',
  },
];

const scriptChecks = [
  {
    label: 'post-deploy live script starts with no-texting guard',
    script: 'check:post-deploy-live',
    needle: 'check:no-texting-copy',
  },
  {
    label: 'post-deploy live script runs SMIRK ops copy guard',
    script: 'check:post-deploy-live',
    needle: 'check:smirk-ops-copy',
  },
  {
    label: 'post-deploy live script runs OpenAPI route inventory guard',
    script: 'check:post-deploy-live',
    needle: 'check:openapi',
  },
  {
    label: 'post-deploy live script runs paid handoff safety guard',
    script: 'check:post-deploy-live',
    needle: 'check:paid-handoff-safety',
  },
  {
    label: 'post-deploy live script runs self-serve activation contract guard',
    script: 'check:post-deploy-live',
    needle: 'check:self-serve-activation',
  },
  {
    label: 'post-deploy live script runs billing lifecycle guard',
    script: 'check:post-deploy-live',
    needle: 'check:billing-lifecycle',
  },
  {
    label: 'post-deploy live script runs client onboarding intake contract guard',
    script: 'check:post-deploy-live',
    needle: 'check:client-onboarding-intake',
  },
  {
    label: 'post-deploy live script runs customer dashboard contract guard',
    script: 'check:post-deploy-live',
    needle: 'check:customer-dashboard',
  },
  {
    label: 'pre-proof live script runs customer dashboard contract guard',
    script: 'check:pre-proof-call-live',
    needle: 'check:customer-dashboard',
  },
  {
    label: 'pre-proof live script runs billing lifecycle guard',
    script: 'check:pre-proof-call-live',
    needle: 'check:billing-lifecycle',
  },
  {
    label: 'post-deploy live script runs Stripe webhook handoff preflight',
    script: 'check:post-deploy-live',
    needle: 'check:stripe-webhook-handoff-live:preflight',
  },
  {
    label: 'post-deploy live script runs Stripe smoke approval readiness',
    script: 'check:post-deploy-live',
    needle: 'check:stripe-webhook-smoke-approval-ready',
  },
  {
    label: 'post-deploy live script runs buyer auth smoke safety guard',
    script: 'check:post-deploy-live',
    needle: 'check:buyer-auth-smoke-safety',
  },
  {
    label: 'post-deploy live script runs live operational auth guard',
    script: 'check:post-deploy-live',
    needle: 'check:operational-auth-live',
  },
  {
    label: 'post-deploy live script runs correlated proof artifact guard',
    script: 'check:post-deploy-live',
    needle: 'check:proof-artifacts-live',
  },
  {
    label: 'post-deploy live script runs post-call intelligence guard',
    script: 'check:post-deploy-live',
    needle: 'check:post-call-intelligence-live',
  },
  {
    label: 'ship-live script runs live deploy readiness',
    script: 'check:ship-live',
    needle: 'check:live-deploy-readiness',
  },
  {
    label: 'ship-live script runs post-deploy live checks',
    script: 'check:ship-live',
    needle: 'check:post-deploy-live',
  },
];

const failures = [];

for (const check of checks) {
  const text = read(check.file);
  if (!text.includes(check.needle)) {
    failures.push(`${check.label}: missing ${check.needle} in ${check.file}`);
  }
}

for (const check of scriptChecks) {
  const value = packageJson.scripts?.[check.script] || '';
  if (!value.includes(check.needle)) {
    failures.push(`${check.label}: missing ${check.needle} in package script ${check.script}`);
  }
}

const firstDollarPacketWriter = read('scripts/write-first-dollar-approval-packet.mjs');
for (const forbidden of [
  'Begin outreach only after proof passes, or after the remaining manual fallback is written plainly into the offer.',
]) {
  if (firstDollarPacketWriter.includes(forbidden)) {
    failures.push(`first-dollar approval packet writer contains automatic outreach authority: ${forbidden}`);
  }
}

const localRuntimeSmoke = read('scripts/check-local-runtime-smoke.mjs');
if (localRuntimeSmoke.includes('...process.env')) {
  failures.push('local runtime smoke must not copy the parent process environment into its child');
}

const dbText = read('src/db.ts');
const forbiddenSeedToolPermissionPattern = /tool_permissions:\s*\[[^\]]*"(?:book_appointment|reschedule_appointment|cancel_appointment)"/g;
const forbiddenSeedToolPermissions = [...dbText.matchAll(forbiddenSeedToolPermissionPattern)].map((match) => match[0]);
if (forbiddenSeedToolPermissions.length > 0) {
  failures.push(`agent seed tool permissions still include forbidden calendar-action permissions: ${forbiddenSeedToolPermissions.join('; ')}`);
}

const out = {
  ok: failures.length === 0,
  checkedFiles: checks.map((check) => check.file),
  checkedPackageScripts: scriptChecks.map((check) => check.script),
  failures,
};

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
