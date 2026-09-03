#!/usr/bin/env node
import fs from "node:fs";

const routes = fs.readFileSync("src/routes/provisioning-routes.ts", "utf8");
const buyerRoutes = fs.readFileSync("src/routes/buyer-routes.ts", "utf8");
const app = fs.readFileSync("src/App.tsx", "utf8");
const failures = [];
const expect = (label, condition) => { if (!condition) failures.push(label); };

expect("the former SMIRK24 input is explicitly inert on the public provisioning route",
  routes.includes("const isSmirk24Promo = (_value: unknown) => false")
  && routes.includes("no public request can create a free or trial workspace"));
expect("the buyer UI does not collect or advertise a legacy promo code",
  !app.includes('placeholder="Promo code (optional)"')
  && !app.includes("SMIRK24 applied")
  && !app.includes("24-hour demo workspace"));
expect("the public buyer route exposes only the approved paid plan",
  buyerRoutes.includes('const FIRST_DOLLAR_SELF_SERVE_PLAN: StripeCheckoutPlan = "starter"')
  && /getPublicPricingPlans\(env\)\s*\.filter\(\(plan\) => plan\.id === FIRST_DOLLAR_SELF_SERVE_PLAN\)/s.test(buyerRoutes));

if (failures.length > 0) {
  console.error("FAIL retired public promo safety contract drift:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK retired SMIRK24 promo is inert; public activation requires the approved paid checkout path");
