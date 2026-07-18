#!/usr/bin/env node
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const buyerRoutes = fs.readFileSync(new URL('../src/routes/buyer-routes.ts', import.meta.url), 'utf8');
const saas = fs.readFileSync(new URL('../src/saas.ts', import.meta.url), 'utf8');
const planLimits = fs.readFileSync(new URL('../src/plan-limits.js', import.meta.url), 'utf8');
const liveBuyerRoutes = fs.readFileSync(new URL('../scripts/check-live-buyer-routes.mjs', import.meta.url), 'utf8');

const expect = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL ${msg}`);
    process.exitCode = 1;
  }
};

const serverHas = (snippet) => server.includes(snippet);
const pricingApiHas = (snippet) => server.includes(snippet) || buyerRoutes.includes(snippet);
const appHas = (snippet) => app.includes(snippet);
const saasHas = (snippet) => saas.includes(snippet);
const limitsHave = (snippet) => planLimits.includes(snippet);
const componentBlock = (startMarker, endMarker) => {
  const start = app.indexOf(startMarker);
  const end = app.indexOf(endMarker);
  return start >= 0 && end > start ? app.slice(start, end) : '';
};
const buyerRouteBlock = (routeMarker) => {
  const start = buyerRoutes.indexOf(routeMarker);
  if (start < 0) return '';
  const nextRoute = buyerRoutes.indexOf('\n  app.', start + routeMarker.length);
  return nextRoute > start ? buyerRoutes.slice(start, nextRoute) : buyerRoutes.slice(start);
};

expect(pricingApiHas('app.get("/api/pricing"'), 'pricing API route is not mounted at /api/pricing');
expect(pricingApiHas('name: "SMIRK AI Starter"') || pricingApiHas("name: 'SMIRK AI Starter'"), 'server canonical starter plan name is not SMIRK AI Starter');
expect(pricingApiHas("price: 197"), 'server canonical starter price is not $197');
expect(pricingApiHas('name: "SMIRK AI Pro"') || pricingApiHas("name: 'SMIRK AI Pro'"), 'server canonical pro plan name is not SMIRK AI Pro');
expect(pricingApiHas("price: 397"), 'server canonical pro price is not $397');
expect(pricingApiHas('name: "SMIRK AI Agency"') || pricingApiHas("name: 'SMIRK AI Agency'"), 'server canonical agency plan name is not SMIRK AI Agency');
expect(pricingApiHas("price: 697"), 'server canonical agency price is not $697');
expect(pricingApiHas('cta: "Start Starter Plan"') || pricingApiHas("cta: 'Start Starter Plan'"), 'starter CTA is out of sync');
expect(pricingApiHas('cta: "Start Pro Plan"') || pricingApiHas("cta: 'Start Pro Plan'"), 'pro CTA is out of sync');
expect(pricingApiHas('cta: "Start Agency Plan"') || pricingApiHas("cta: 'Start Agency Plan'"), 'agency CTA is out of sync');
expect(pricingApiHas('features: ["Smart voicemail", "Existing-number forwarding", "Lead capture", "Owner email alerts", "Callback task queue", "Proof dashboard", "Up to 500 calls and 1,000 minutes each month"]'), 'starter features still imply texting or are out of sync');
expect(pricingApiHas('usage_summary: "500 calls and 1,000 minutes per month."'), 'starter public usage limits are missing or out of sync');
expect(pricingApiHas('usage_summary: "2,000 calls and 5,000 minutes per month."'), 'pro public usage limits are missing or out of sync');
expect(pricingApiHas('usage_summary: "Usage limits and any overage terms require an owner-approved Enterprise policy before checkout is available."'), 'agency public usage disclosure is missing or out of sync');
expect(appHas('Included usage: {plan.usage_summary}'), 'public pricing page does not render included usage');
const standalonePricingPage = componentBlock('function PublicPricingPage()', 'function PublicSuccessPage()');
expect(standalonePricingPage.includes('const buyerDetailsReady = Boolean(businessName.trim() && ownerEmail.trim() && ownerPhone.trim())'), 'standalone pricing must require buyer identity before checkout');
expect(standalonePricingPage.includes('startCheckout(plan, { businessName, ownerEmail, ownerPhone })'), 'standalone pricing must pass buyer identity into checkout metadata');
expect(!standalonePricingPage.includes('the setup request still gives the owner a next step'), 'standalone pricing must not claim it saved a setup request when checkout is unavailable');
expect(buyerRouteBlock('app.get("/api/pricing"').includes('res.setHeader("Cache-Control", "no-store")'), 'pricing API route must disable response caching');
expect(buyerRouteBlock('app.get("/api/pricing"').includes('checkout_url: _checkoutUrl') && buyerRouteBlock('app.get("/api/pricing"').includes('readiness.firstDollarReadyByPlan[plan.id as StripeCheckoutPlan]') && buyerRouteBlock('app.get("/api/pricing"').includes('checkout_available: checkoutAvailable'), 'pricing API must not expose raw Payment Links and must publish exact plan-gated checkout availability');
expect(buyerRouteBlock('app.get("/api/pricing"').includes('checkout_blocker: checkoutAvailable'), 'pricing API must expose the exact fail-closed plan checkout blocker');
expect(buyerRoutes.includes('getPublishedCustomerPolicyProof(customerPolicyVersion, "starter")') && buyerRoutes.includes('customerPolicyPublicationVerified: publishedPolicyProof?.ok === true') && buyerRoutes.includes('getPublishedCustomerPolicyProof(customerPolicyVersion, "enterprise")'), 'first-dollar readiness must verify core policy publication and separately verify Enterprise publication before its checkout');
expect(buyerRouteBlock('app.get("/api/first-dollar-readiness"').includes('res.setHeader("Cache-Control", "no-store")'), 'first-dollar readiness route must disable response caching');
expect(buyerRoutes.includes('const getPublicBuyerReadiness =') && buyerRoutes.includes('buildPlanCheckoutReadiness') && buyerRoutes.includes('activationPrerequisitesReady') && buyerRoutes.includes('firstDollarReadyByPlan') && buyerRoutes.includes('activationMode: activationReady ? "automatic" : "not_ready"'), 'first-dollar readiness must distinguish exact-plan checkout from durable automatic activation');
expect(liveBuyerRoutes.includes("'POST /api/checkout/create'"), 'live buyer route audit must probe checkout creation');
expect(liveBuyerRoutes.includes('/api/checkout/create'), 'live buyer route audit must call checkout creation endpoint');
expect(liveBuyerRoutes.includes('__invalid_smirk_audit_plan__'), 'live buyer route audit must use a non-mutating invalid checkout plan');
expect(liveBuyerRoutes.includes('/unknown plan/i'), 'live buyer route audit must expect the invalid-plan checkout response');
expect(liveBuyerRoutes.includes('cacheProtected(headers)') && liveBuyerRoutes.includes('unknown plan'), 'live buyer route audit must verify checkout-create cache control');
expect(liveBuyerRoutes.includes("'GET /api/pricing'") && liveBuyerRoutes.includes('status !== 200 || !cacheProtected(headers)'), 'live buyer route audit must verify pricing cache control');
expect(liveBuyerRoutes.includes("availability.enterprise !== false") && liveBuyerRoutes.includes("availability.starter !== true && availability.pro !== true"), 'live buyer route audit must accept either canonical core checkout while keeping Enterprise unavailable');
expect(liveBuyerRoutes.includes('planReadinessMatchesPricing') && liveBuyerRoutes.includes('firstDollarReadyByPlan[plan] === pricingCheckoutAvailability[plan]'), 'live buyer route audit must cross-check pricing availability against exact-plan readiness');
expect(!liveBuyerRoutes.includes("plan?.checkout_available === (plan?.id !== 'enterprise')"), 'live buyer route audit must not require both Starter and Pro checkout paths');
expect(liveBuyerRoutes.includes("'GET /api/first-dollar-readiness'") && liveBuyerRoutes.includes('!cacheProtected(headers)'), 'live buyer route audit must verify first-dollar readiness cache control');
expect(liveBuyerRoutes.includes("'POST /api/provisioning/checkout-status not-found'"), 'live buyer route audit must probe checkout-status not-found without writes');
expect(liveBuyerRoutes.includes('smirk-live-audit-not-found@example.invalid'), 'live buyer route audit must use a reserved not-found checkout-status email');
expect(liveBuyerRoutes.includes("body?.found === false"), 'live buyer route audit must expect checkout-status not-found response');
expect(liveBuyerRoutes.includes("body?.status_label === 'Secure checkout reference required'"), 'live buyer route audit must expect privacy-safe checkout-status label without a secure reference');
expect(liveBuyerRoutes.includes("!joined.includes('invite_link')") && liveBuyerRoutes.includes("!joined.includes('workspace_api_key')"), 'live buyer route audit must guard checkout-status against public secret leakage');
expect(liveBuyerRoutes.includes('function cacheProtected') && liveBuyerRoutes.includes('!cacheProtected(headers)'), 'live buyer route audit must verify public activation response cache control');
expect(buyerRoutes.includes('app.post("/api/checkout/create", publicCheckoutRateLimit') && buyerRoutes.includes('res.setHeader("Cache-Control", "no-store")'), 'checkout create route must disable response caching and use its dedicated limiter');
expect(buyerRoutes.includes('const selectedPlanReady = readiness.firstDollarReadyByPlan[selectedPlanId] === true') && buyerRoutes.includes('if (!selectedPlanReady)') && buyerRoutes.includes('without charging you'), 'checkout must fail closed before charge when the selected plan is not fully ready');

expect(appHas('if (pathname === "/pricing")'), 'public pricing page route is missing');
expect(appHas('if (pathname === "/success")'), 'public success page route is missing');
expect(appHas('if (pathname === "/cancel")'), 'public cancel page route is missing');
expect(appHas('function PublicSuccessPage()'), 'public success page component is missing');
expect(appHas('function PublicCancelPage()'), 'public cancel page component is missing');
const publicBuyerPages = [
  ['PublicBookPage', componentBlock('function PublicBookPage()', 'function PublicLandingPage()')],
  ['PublicLandingPage', componentBlock('function PublicLandingPage()', 'function PublicComparePage()')],
  ['PublicComparePage', componentBlock('function PublicComparePage()', 'function PublicIndustryPage(')],
  ['PublicIndustryPage', componentBlock('function PublicIndustryPage(', 'function PublicPricingPage()')],
  ['PublicPricingPage', componentBlock('function PublicPricingPage()', 'function PublicSuccessPage()')],
];
for (const [name, block] of publicBuyerPages) {
  expect(Boolean(block), `${name} block is missing from public buyer page guard`);
  expect(!block.includes('>Open app</a>') && !block.includes('>\n              Open app\n            </a>'), `${name} must not imply immediate app access from public buyer pages`);
}
expect(appHas("paymentConfirmed ? 'Payment confirmed' : accessPaused ? 'Workspace access paused' : 'Confirm payment and activation'"), 'public success page must gate its payment headline on verified active checkout evidence');
expect(appHas("paymentReceived && accessActive && body.payment_verified === true"), 'public success page must require matched payment and current billing entitlement');
expect(appHas("activationEmailDelivered ? 'Owner access email sent'"), 'public success page must gate owner-email delivery copy on a confirmed delivery state');
expect(appHas('Enter the owner email to securely match this Checkout Session before SMIRK reports payment or activation.'), 'public success page must explain its exact checkout verification step');
expect(appHas('<a href="/#activation-status" className="inline-flex items-center justify-center rounded-2xl bg-emerald-400 px-5 py-3 text-sm font-semibold text-black">Check activation status</a>'), 'public success page primary action must point to activation status');
const successPageStart = app.indexOf('function PublicSuccessPage()');
const successPageEnd = app.indexOf('function PublicCancelPage()');
const successPageBlock = successPageStart >= 0 && successPageEnd > successPageStart ? app.slice(successPageStart, successPageEnd) : '';
expect(successPageBlock.includes("paymentReceived ? 'Payment was received, but workspace access is not active.'"), 'public success page must distinguish historical payment from active access');
expect(!successPageBlock.includes('href="/dashboard"'), 'public success page must not route newly paid buyers straight to the dashboard');
expect(appHas('Checkout canceled'), 'public cancel page headline is out of sync');
expect(appHas('No charge was made'), 'public cancel page no-charge copy is out of sync');
const cancelPageStart = app.indexOf('function PublicCancelPage()');
const cancelPageEnd = app.indexOf('// ── Types');
const cancelPageBlock = cancelPageStart >= 0 && cancelPageEnd > cancelPageStart ? app.slice(cancelPageStart, cancelPageEnd) : '';
expect(cancelPageBlock.includes('Return to pricing') && cancelPageBlock.includes('Get setup help'), 'public cancel page must point buyers back to pricing or setup help');
expect(!cancelPageBlock.includes('href="/dashboard"'), 'public cancel page must not route unpaid buyers straight to the dashboard');
expect(appHas('Starter ($197/mo) · Pro ($397/mo) · Agency ($697/mo) — simple monthly plans, no trial maze'), 'dashboard upgrade CTA pricing copy is out of sync');
expect(appHas('starter: "Starter — $197/mo"'), 'workspace plan label for starter is out of sync');
expect(appHas('pro: "Pro — $397/mo"'), 'workspace plan label for pro is out of sync');
expect(appHas('enterprise: "Agency — $697/mo"'), 'workspace plan label for agency is out of sync');
expect(limitsHave('starter: Object.freeze({ calls: 500, minutes: 1000, agents: 3, enabled: true, label: "Starter — $197/mo" })'), 'workspace starter limits are out of sync');
expect(limitsHave('pro: Object.freeze({ calls: 2000, minutes: 5000, agents: 9, enabled: true, label: "Pro — $397/mo" })'), 'workspace pro limits are out of sync');
expect(appHas('pro:        { calls: 2000, minutes: 5000, agents: 9 }'), 'operator workspace Pro minute limit is out of sync');
expect(limitsHave('calls: 0') && limitsHave('enabled: false') && !limitsHave('calls: -1'), 'workspace Agency checkout must remain disabled without owner-approved hard caps');
expect(appHas('enterprise: { calls: 0,    minutes: 0,    agents: 0 }'), 'operator Agency limits must fail closed instead of implying unlimited usage');
expect(appHas('" (hard cap not approved)"') && !appHas('" (unlimited)"'), 'operator usage UI must not describe disabled Agency limits as unlimited');

if (process.exitCode) process.exit(process.exitCode);
console.log('OK pricing copy matches canonical live plan values');
