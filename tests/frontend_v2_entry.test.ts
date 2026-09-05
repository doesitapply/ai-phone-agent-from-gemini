import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const main = read("src/main.tsx");
const app = read("src/v2/AppV2.tsx");
const owner = read("src/v2/OwnerApp.tsx");
const publicApp = read("src/v2/PublicApp.tsx");
const api = read("src/v2/api.ts");

test("production frontend entry is the V2 router, not the legacy monolith", () => {
  assert.match(main, /import AppV2 from ['"]\.\/v2\/AppV2['"]/);
  assert.match(main, /<AppV2 \/>/);
  assert.doesNotMatch(main, /from ['"]\.\/App/);
  assert.match(app, /pathname\.startsWith\(["']\/dashboard["']\)/);
});

test("V2 owner surface keeps the daily hierarchy narrow and Settings reachable", () => {
  for (const label of ["Today", "Calls", "Tasks", "Settings", "Admin tools"]) {
    assert.match(owner, new RegExp(`label: ["']${label}["']`));
  }
  assert.doesNotMatch(owner, /Lead Hunter|Campaigns|Prospecting/);
  assert.match(owner, /confirmation gated/i);
  assert.match(owner, /No workspace selected/);
});

test("V2 owner authentication relies on the HTTP-only server session", () => {
  assert.match(owner, /\/api\/auth\/google\/exchange/);
  assert.match(owner, /body\?\.session\?\.serverSession/);
  assert.match(api, /\/api\/auth\/session/);
  assert.match(api, /credentials: ["']same-origin["']/);
  assert.doesNotMatch(`${owner}\n${api}`, /googleIdToken|X-SMIRK-Google-ID-Token/);
  assert.doesNotMatch(`${owner}\n${api}`, /DASHBOARD_API_KEY/);
});

test("V2 public proof illustration is disclosed and live pricing stays API-backed", () => {
  assert.match(publicApp, /WORKFLOW FORMAT — NOT LIVE DATA/);
  assert.match(publicApp, /fetch\(["']\/api\/pricing["']/);
  assert.match(publicApp, /fetch\(["']\/api\/checkout\/create["']/);
  assert.match(publicApp, /checkout-status/);
  assert.doesNotMatch(publicApp, /\$97|\$397|\$697/);
});
