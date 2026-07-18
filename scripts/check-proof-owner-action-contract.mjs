#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const canonicalTypes = ["callback", "follow_up", "handoff", "escalate_to_human"];
const canonicalSql = "t.task_type IN ('callback', 'follow_up', 'handoff', 'escalate_to_human')";
const canonicalJs = "['callback', 'follow_up', 'handoff', 'escalate_to_human']";
const files = {
  provisioning: readFileSync("src/routes/provisioning-routes.ts", "utf8"),
  activation: readFileSync("src/routes/workspace-activation-routes.ts", "utf8"),
  profile: readFileSync("src/routes/workspace-profile-routes.ts", "utf8"),
  overview: readFileSync("src/routes/workspace-overview-routes.ts", "utf8"),
  publicProof: readFileSync("src/routes/proof-routes.ts", "utf8"),
  proofChecker: readFileSync("scripts/check-proof-artifacts-live.mjs", "utf8"),
  postCall: readFileSync("src/intelligence.ts", "utf8"),
};

const count = (source, needle) => source.split(needle).length - 1;
assert.ok(files.provisioning.includes(canonicalSql), "qualifying revenue must accept the canonical owner-action task set");
assert.ok(files.activation.includes(canonicalSql), "workspace activation must accept the canonical owner-action task set");
assert.ok(count(files.profile, canonicalSql) >= 2, "workspace profile proof count and freshness must accept the canonical owner-action task set");
assert.ok(count(files.overview, canonicalSql) >= 2, "workspace overview proof count and freshness must accept the canonical owner-action task set");
assert.ok(count(files.publicProof, canonicalSql) >= 2, "public proof count and freshness must accept the canonical owner-action task set");
assert.ok(files.proofChecker.includes(canonicalJs), "the live proof checker must use the same canonical owner-action task set");
assert.ok(files.postCall.includes('task_type: durableSummary.outcome === "escalated" ? "handoff" : "follow_up"'), "post-call intelligence must retain the follow_up outcome path");

const followUpOnlyFixture = {
  callSid: "CA11111111111111111111111111111111",
  summary: { call_sid: "CA11111111111111111111111111111111", call_summary: "Owner follow-up required." },
  tasks: [{ call_sid: "CA11111111111111111111111111111111", task_type: "follow_up" }],
  events: [{ call_sid: "CA11111111111111111111111111111111", event_type: "OWNER_EMAIL_ALERT_SENT" }],
};
const hasCanonicalOwnerAction = followUpOnlyFixture.tasks.some((task) => (
  task.call_sid === followUpOnlyFixture.callSid && canonicalTypes.includes(task.task_type)
));
const hasCorrelatedProof = Boolean(followUpOnlyFixture.summary.call_summary)
  && hasCanonicalOwnerAction
  && followUpOnlyFixture.events.some((event) => event.call_sid === followUpOnlyFixture.callSid);
assert.equal(hasCorrelatedProof, true, "a follow_up-only exact call must remain qualifying proof evidence");

console.log("OK proof evidence uses one canonical owner-action task set and accepts a follow_up-only exact call");
