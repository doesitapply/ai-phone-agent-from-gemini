#!/usr/bin/env node
import { readFileSync } from "node:fs";

const surfaces = [
  "src/components/SetupWizard.tsx",
  "src/routes/workspace-profile-routes.ts",
  "src/db.ts",
  "scripts/build-smirk-collateral.mjs",
];

const bannedClaims = [
  ["demo as default intake path", /\bseeing a quick demo\b|\brequest a demo\b|\bdemo\/setup\b|\bplan selection\/demo\b/i],
  ["full-answer mode as first-dollar promise", /\bFull Answer\b|\bfull answering\b|\bFull Answer Mode\b/i],
  ["multi-plan ladder in default prompt", /\bStarter,\s*Pro,\s*Agency\b|\bPro is \$397\b|\bAgency is \$697\b/i],
  ["advanced integrations as first-dollar promise", /\bCRM\/webhook\b|\badvanced routing\b|\bmulti-agent\b|\bpriority deployment\b/i],
  ["smart voicemail positioning in default prompt", /\bSmart Voicemail\b|\bsmart voicemail\b/i],
  ["inactive founders pricing", /\bfounders? (?:deal|rate)\b|\$99(?:\/month|\/mo|\s+a month)?|locked for life/i],
  ["unsupported recovered-revenue claim", /one recovered job pays|typical missed call costs/i],
];

const requiredClaims = [
  ["missed-call recovery offer", /\bMissed-Call Recovery\b|\bmissed-call recovery\b/i],
  ["owner email alerts", /\bowner email alerts?\b|\bowner notifications?\b/i],
  ["callback task", /\bcallback tasks?\b/i],
  ["proof dashboard", /\bproof dashboard\b/i],
];

const failures = [];

for (const file of surfaces) {
  const text = readFileSync(file, "utf8");
  for (const [label, pattern] of bannedClaims) {
    if (pattern.test(text)) {
      failures.push(`${file}: ${label}`);
    }
  }
}

const combined = surfaces.map((file) => readFileSync(file, "utf8")).join("\n");
for (const [label, pattern] of requiredClaims) {
  if (!pattern.test(combined)) {
    failures.push(`prompt/onboarding surfaces missing ${label}`);
  }
}

const buyerRoutes = readFileSync("src/routes/buyer-routes.ts", "utf8");
const collateralSource = readFileSync("scripts/build-smirk-collateral.mjs", "utf8");
if (!collateralSource.includes('const demoPhone = "(775) 420-3005";')) {
  failures.push("collateral must identify (775) 420-3005 as the live SMIRK demo line");
}
if (!collateralSource.includes('const ownerPhone = "(775) 420-4485";')) {
  failures.push("collateral must identify (775) 420-4485 as Cameron's owner contact line");
}
if (!collateralSource.includes("Cameron / Google Voice: ${ownerPhone}")) {
  failures.push("collateral must label the personal Google Voice number separately from the SMIRK demo line");
}
if (!buyerRoutes.includes('const FIRST_DOLLAR_SELF_SERVE_PLAN: StripeCheckoutPlan = "starter";')) {
  failures.push("buyer checkout route missing server-owned Starter-only launch plan");
}
if (!buyerRoutes.includes('code: "FIRST_DOLLAR_STARTER_ONLY"')) {
  failures.push("buyer checkout route does not reject non-Starter first-dollar checkout");
}
if (!buyerRoutes.includes("restrictCheckoutReadinessToPlans(providerPlanReadiness, [FIRST_DOLLAR_SELF_SERVE_PLAN])")) {
  failures.push("public readiness can advertise plans outside the Starter-only launch scope");
}

if (failures.length) {
  console.error("FAIL first-dollar offer scope drift found:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`OK first-dollar offer scope is narrow across ${surfaces.length} prompt/onboarding files`);
