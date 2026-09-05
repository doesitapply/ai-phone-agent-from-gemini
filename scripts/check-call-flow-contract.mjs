#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
const failures = [];

const expectIncludes = (text, needle, label) => {
  if (!text.includes(needle)) {
    failures.push(`${label}: missing ${needle}`);
  }
};

const functionCalling = read("src/function-calling.ts");

for (const toolName of [
  "lookup_contact",
  "list_open_tasks",
  "set_callback",
  "schedule_callback_confirmation",
  "qualify_lead",
  "escalate_to_human",
  "route_call",
]) {
  expectIncludes(functionCalling, `name: "${toolName}"`, `tool declaration for ${toolName}`);
}

for (const toolName of [
  "lookup_contact",
  "list_open_tasks",
  "set_callback",
  "qualify_lead",
  "escalate_to_human",
  "route_call",
]) {
  expectIncludes(functionCalling, `case "${toolName}"`, `tool dispatch for ${toolName}`);
}

for (const snippet of [
  "CALL START: If the caller is recognized, call lookup_contact immediately. If they have open tasks, call list_open_tasks and acknowledge relevant ones.",
  "CALLER MEMORY: First establish the business purpose.",
  "ROUTING: Call route_call when the request is urgent, ambiguous, emotionally charged, or beyond your authority. Follow the result.",
  "END OF CALL: Before hanging up, verify the call ended in a clean state: transferred, a new callback request was captured, a callback window was recorded, or the issue was resolved. Do not alter existing tasks or handoffs to manufacture a clean state. If none of these are true, do not end the call yet.",
  "After an urgent handoff or owner callback task, confirm the owner has the details and name the callback next step.",
  "Never call the same tool twice in one turn.",
]) {
  expectIncludes(functionCalling, snippet, "call-flow prompt contract");
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  checked: {
    file: "src/function-calling.ts",
    requiredToolDeclarations: 7,
    requiredToolDispatches: 6,
    requiredPromptRules: 6,
  },
}, null, 2));
