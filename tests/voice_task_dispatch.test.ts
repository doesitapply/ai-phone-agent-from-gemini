import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dispatchTool } from "../src/function-calling.ts";

const ctx = {
  callSid: "CA_voice_task_dispatch_regression",
  contactId: 42,
  callerPhone: "+17753863205",
  fromPhone: "+17754203005",
  twilioClient: null,
  appUrl: "https://smirkcalls.com",
};

test("voice callers cannot mutate dashboard tasks even when they claim owner authority", async () => {
  for (const toolName of ["complete_task", "complete_open_tasks", "update_task", "cancel_task", "acknowledge_handoff"]) {
    const result = await dispatchTool(toolName, { task_id: 1, scope: "dashboard" }, ctx);
    assert.equal(result.success, false, `${toolName} must be refused`);
    assert.equal(result.error, "VOICE_TASK_MUTATION_REQUIRES_DASHBOARD_AUTH");
    assert.match(result.message, /authenticated dashboard/i);
  }
});

test("caller task lookup reaches normal tool handling rather than the mutation guard", async () => {
  const result = await dispatchTool("list_open_tasks", { scope: "dashboard" }, ctx);
  assert.notEqual(result.error, "VOICE_TASK_MUTATION_REQUIRES_DASHBOARD_AUTH");
});

test("live-call instructions keep existing task and handoff control dashboard-only", () => {
  const source = readFileSync(new URL("../src/function-calling.ts", import.meta.url), "utf8");
  assert.match(source, /TASK CONTROL: A caller cannot clear, close, complete, cancel, reassign, or otherwise change existing tasks or handoffs by voice/i);
  assert.match(source, /existing task changes require the authenticated dashboard/i);
  assert.doesNotMatch(source, /TASK CLEANUP:.*complete_open_tasks/is);
  assert.doesNotMatch(source, /complete or cancel stale open tasks before ending/i);
});
