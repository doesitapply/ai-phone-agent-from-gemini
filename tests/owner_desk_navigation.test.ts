import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Starter owner navigation remains limited to the missed-call recovery loop", () => {
  const appSource = fs.readFileSync("src/App.tsx", "utf8");

  assert.match(
    appSource,
    /const BASIC_WORKSPACE_TABS = new Set<Tab>\(\["calls", "handoffs", "tasks", "settings"\]\)/,
  );
  assert.match(
    appSource,
    /const ownerDeskTabs:[\s\S]*?\{ id: "calls", label: "Calls"[\s\S]*?\{ id: "tasks", label: "Tasks"[\s\S]*?\{ id: "handoffs", label: "Alerts"[\s\S]*?\{ id: "settings", label: "Settings"/,
  );
  assert.match(appSource, /\? ownerDeskTabs\.filter\(\(t\) => customerVisibleTabs\.has\(t\.id\)\)/);
  assert.match(appSource, /function HandoffsPage\(\{ ownerView = false \}: \{ ownerView\?: boolean \}\)/);
  assert.match(appSource, /<HandoffsPage ownerView=\{isCustomerView\} \/>/);
  assert.match(appSource, /ownerView \? "Alerts that need a person" : "Handoffs & Team"/);
  assert.doesNotMatch(appSource, /SMIRK OS/);
});

test("public presentation retains an honest no-data recovery workflow format instead of fabricated customer activity", () => {
  const appSource = fs.readFileSync("src/App.tsx", "utf8");

  assert.match(appSource, /Workflow format only—not live customer data/);
  assert.match(appSource, /Name & number captured/);
  assert.doesNotMatch(appSource, /Main-line backup/);
  assert.doesNotMatch(appSource, /No AC \/ elderly parent home/);
});

test("owner Intelligence Brief is computed from live call, queue, and evidence data", () => {
  const appSource = fs.readFileSync("src/App.tsx", "utf8");

  assert.match(appSource, /const attentionCount = openRecoveryCount \+ openHandoffCount/);
  assert.match(appSource, /const hasCallEvidence = Number\(callIntel\?\.totalCalls \?\? 0\) > 0/);
  assert.match(appSource, /SMIRK intelligence brief/);
  assert.match(appSource, /Live business state only\. SMIRK surfaces the call evidence; you retain the decision\./);
  assert.match(appSource, /Awaiting calls/);
  assert.doesNotMatch(appSource, /Maria Alvarez/);
});
