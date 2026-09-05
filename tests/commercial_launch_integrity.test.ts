import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("public human-at-work story explains recovery without manufacturing customer or revenue proof", () => {
  const hero = readFileSync(new URL("../public/smirk-images/hero-van.webp", import.meta.url));
  const provenance = readFileSync(new URL("../public/smirk-images/PROVENANCE.md", import.meta.url), "utf8");
  const heroSha256 = createHash("sha256").update(hero).digest("hex");

  assert.match(app, /const SMIRK_FIELD_WORK_VISUAL = "\/smirk-images\/hero-van\.webp"/);
  assert.equal(heroSha256, "7b22530b9ad5feb2017c7197bf4d8678f266280a0ba050a6535a0c2e793762dc");
  assert.match(provenance, /user-supplied\s+`smirk-ui-pack\/photos` source set/);
  assert.match(provenance, new RegExp(heroSha256));
  assert.match(app, /Working the job/);
  assert.match(app, /Signal captured/);
  assert.match(app, /Context recorded/);
  assert.match(app, /You decide next/);
  assert.doesNotMatch(app, /recovered \$[0-9,]+/i);
  assert.doesNotMatch(app, /money caught/i);
});
