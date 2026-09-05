import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  buildQualificationInstruction,
  getSummaryMemoryPromotionReason,
  getToolMemoryPromotionReason,
  hasReusableCallerPhone,
  normalizeQualificationTrade,
  shouldBlockToolWithoutDurableContact,
} from "../src/caller-memory-policy.js";
import { isVoiceDashboardMutation } from "../src/live-call-safety.js";
import { TOOL_DECLARATIONS } from "../src/function-calling.js";

test("meaningful live actions promote caller memory while contact details alone do not", () => {
  assert.equal(getToolMemoryPromotionReason("create_lead"), "service_request");
  assert.equal(getToolMemoryPromotionReason("set_callback"), "callback_commitment");
  assert.equal(getToolMemoryPromotionReason("escalate_to_human"), "human_handoff");
  assert.equal(getToolMemoryPromotionReason("mark_do_not_call"), "compliance_request");
  assert.equal(getToolMemoryPromotionReason("qualify_lead", { qualified: true }), "service_request");
  assert.equal(getToolMemoryPromotionReason("qualify_lead", { qualified: false }), null);
  assert.equal(getToolMemoryPromotionReason("update_contact", { name: "Caller" }), null);
  assert.equal(shouldBlockToolWithoutDurableContact("update_contact"), true);
  assert.equal(shouldBlockToolWithoutDurableContact("add_note"), true);
});

test("post-call promotion requires a real business obligation rather than a name or generic inquiry", () => {
  assert.equal(getSummaryMemoryPromotionReason({
    intent: "general_inquiry",
    outcome: "resolved",
    extracted_entities: { caller_name: "Provided Name" },
    tasks: [],
  }), null);
  assert.equal(getSummaryMemoryPromotionReason({
    intent: "unknown",
    outcome: "spam",
    extracted_entities: { caller_name: "Provided Name" },
    tasks: [],
  }), null);
  assert.equal(getSummaryMemoryPromotionReason({
    intent: "lead_capture",
    outcome: "lead_captured",
    extracted_entities: { service_type: "water-heater repair" },
    tasks: [{ task_type: "callback" }],
  }), "callback_commitment");
  assert.equal(getSummaryMemoryPromotionReason({
    intent: "lead_capture",
    outcome: "lead_captured",
    extracted_entities: { service_type: "panel replacement" },
    tasks: [],
  }), "service_request");
});

test("caller memory requires a real reusable callback number", () => {
  assert.equal(hasReusableCallerPhone("+17753863205"), true);
  assert.equal(hasReusableCallerPhone("anonymous"), false);
  assert.equal(hasReusableCallerPhone("unknown"), false);
  assert.equal(hasReusableCallerPhone("0000000000"), false);
});

test("trade qualification asks one question at a time and preserves commitment boundaries", () => {
  assert.equal(normalizeQualificationTrade("residential electrician"), "electrical");
  assert.equal(normalizeQualificationTrade("heating and cooling contractor"), "hvac");
  const instruction = buildQualificationInstruction("residential electrician");
  assert.match(instruction, /ask one question at a time/i);
  assert.match(instruction, /device, circuit, or panel/i);
  assert.match(instruction, /visible smoke, sparking, or a burning smell/i);
  assert.match(instruction, /Do not diagnose/i);
  assert.match(instruction, /quote a price unless the active approved business knowledge explicitly authorizes it/i);
});

test("inbound voice cannot place a third-party outbound call", () => {
  assert.equal(isVoiceDashboardMutation("make_outbound_call"), true);
  assert.equal(TOOL_DECLARATIONS.some((tool) => tool.name === "make_outbound_call"), false);
});

test("server keeps unknown inbound callers unlinked and adds workspace qualification", () => {
  const serverSource = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  assert.match(serverSource, /Unknown inbound calls remain/);
  assert.match(serverSource, /findContactByPhone\(callerPhone, routedWsId\)/);
  assert.match(serverSource, /contact\?\.id \|\| null/);
  assert.match(serverSource, /contact \? buildCallerContext\(contact, false\) : ""/);
  assert.match(serverSource, /buildQualificationInstruction/);
});

test("post-call intelligence no longer creates a contact from a caller name alone", () => {
  const intelligenceSource = readFileSync(new URL("../src/intelligence.ts", import.meta.url), "utf8");
  assert.doesNotMatch(intelligenceSource, /CONTACT_AUTO_CREATED_FROM_SUMMARY/);
  assert.doesNotMatch(intelligenceSource, /if \(!autoName\)/);
  assert.match(intelligenceSource, /getSummaryMemoryPromotionReason/);
  assert.match(intelligenceSource, /CALLER_MEMORY_NOT_PROMOTED/);
});
