import assert from "node:assert/strict";
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
