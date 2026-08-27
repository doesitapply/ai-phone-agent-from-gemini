import assert from "node:assert/strict";
import { buildInboundDemoGreeting, buildInboundDemoSystemContext } from "../src/inbound-demo.ts";

const invite = {
  id: 1,
  workspace_id: 1,
  business_name: "Northstar Electric",
  contact_name: "Alex",
  industry: "electrician",
  public_source_url: "https://example.com/northstar",
  audit_hypothesis: "May miss after-hours panel-service inquiries.",
  status: "approved" as const,
};

const greeting = buildInboundDemoGreeting(invite);
assert.match(greeting, /SMIRK's private demonstration/);
assert.match(greeting, /not Northstar Electric's live line/);

const context = buildInboundDemoSystemContext(invite);
assert.match(context, /voluntarily called/);
assert.match(context, /not the named business's live phone line/);
assert.match(context, /Never imply that the named business bought SMIRK/);

console.log("Inbound demo disclosure checks passed.");
