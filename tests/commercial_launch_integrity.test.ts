import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const buyerRoutes = readFileSync(new URL("../src/routes/buyer-routes.ts", import.meta.url), "utf8");
const provisioningRoutes = readFileSync(new URL("../src/routes/provisioning-routes.ts", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

test("public pricing response exposes only the owner-approved first-dollar offer", () => {
  assert.match(
    buyerRoutes,
    /getPublicPricingPlans\(env\)\s*\.filter\(\(plan\) => plan\.id === FIRST_DOLLAR_SELF_SERVE_PLAN\)\s*\.map/s,
  );
  assert.match(buyerRoutes, /const FIRST_DOLLAR_SELF_SERVE_PLAN: StripeCheckoutPlan = "starter"/);
});

test("retired SMIRK24 code cannot create a public trial workspace or bypass checkout", () => {
  assert.match(provisioningRoutes, /const isSmirk24Promo = \(_value: unknown\) => false/);
  assert.match(provisioningRoutes, /no public request can create a free or trial workspace/i);
  assert.doesNotMatch(app, /placeholder="Promo code \(optional\)"/);
  assert.match(app, /if \(selected\) \{\s*try \{\s*await startCheckout\(selected, \{ businessName, ownerEmail, ownerPhone, termsAccepted \}\);/s);
  assert.doesNotMatch(app, /SMIRK24 applied: setup fee waived/i);
});

test("public recovery preview explains the workflow without fabricated customer data", () => {
  assert.match(app, /Workflow format only—not live customer data/);
  assert.match(app, /Name & number captured/);
  assert.match(app, /Issue summarized/);
  assert.doesNotMatch(app, /Maria Alvarez/);
  assert.doesNotMatch(app, /418 Maple St, Sparks/);
  assert.doesNotMatch(app, /elderly parent home/);
});
