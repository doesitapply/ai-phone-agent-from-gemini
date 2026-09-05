import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Starter owner navigation remains limited to the missed-call recovery loop", () => {
  const appSource = fs.readFileSync("src/App.tsx", "utf8");

  assert.match(
    appSource,
    /const BASIC_WORKSPACE_TABS = new Set<Tab>\(\["calls", "handoffs", "tasks", "settings", "crm"\]\)/,
  );
  assert.match(
    appSource,
    /const ownerDeskTabs:[\s\S]*?\{ id: "calls", label: "Calls"[\s\S]*?\{ id: "tasks", label: "Tasks"[\s\S]*?\{ id: "handoffs", label: "Alerts"[\s\S]*?\{ id: "settings", label: "Settings"/,
  );
  assert.match(appSource, /\? ownerDeskTabs\.filter\(\(t\) => customerVisibleTabs\.has\(t\.id\)\)/);
  assert.match(appSource, /function HandoffsPage\(\{ ownerView = false \}: \{ ownerView\?: boolean \}\)/);
  assert.match(appSource, /<HandoffsPage ownerView=\{isCustomerView\} \/>/);
  assert.match(appSource, /ownerView \? "Alerts that need a person" : "Handoffs & Team"/);
  assert.match(appSource, /label: "Business setup"/);
  assert.match(appSource, /label: "How SMIRK speaks"/);
  assert.match(appSource, /label: "What SMIRK can say"/);
  assert.match(appSource, /Business knowledge/);
  assert.match(appSource, /Line &amp; setup/);
  assert.match(appSource, /activeTab === 'crm' && visibleForSession\('crm'\) && <BusinessDataPage \/>/);
  assert.match(appSource, /\$\{dark \? "smirk-ops-dark" : "smirk-ops-light"\}/);
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

test("verified owner identity is forwarded by the chat bubble before server-side call authority is evaluated", () => {
  const appSource = fs.readFileSync("src/App.tsx", "utf8");

  assert.match(appSource, /const _authHeaders: Record<string, string> = \{[\s\S]*?\.\.\.getWorkspaceAuthHeaders\(\)/);
  assert.match(appSource, /if \(_opSess\?\.googleIdToken\) \{[\s\S]*?_authHeaders\["X-SMIRK-Google-ID-Token"\] = _opSess\.googleIdToken/);
  assert.match(appSource, /const res = await fetch\("\/api\/chat", \{[\s\S]*?headers: _authHeaders/);
  assert.match(appSource, /hasVerifiedOwnerIdentity=\{!!operatorSession\?\.googleIdToken && !isDemoOperator\}/);
  assert.match(appSource, /Owner identity verified\./);
  assert.match(appSource, /owner verification is required before I can place a call/);
});
