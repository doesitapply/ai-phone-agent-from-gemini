import assert from "node:assert/strict";
import test from "node:test";
import { getVelvetControlConfiguration } from "../src/velvet-control.ts";
import { extractApprovedActionTool, extractApprovedCallTarget } from "../src/smirk-chat.ts";

test("Velvet control is disabled without a dedicated read credential", () => {
  const result = getVelvetControlConfiguration({ VELVET_ALCHEMY_BASE_URL: "https://velvetalchemy.manus.space" });
  assert.equal(result.configured, false);
  assert.match(result.reason, /READ_KEY/);
});

test("Velvet control accepts only a complete HTTPS configuration", () => {
  const result = getVelvetControlConfiguration({
    VELVET_ALCHEMY_BASE_URL: "https://velvetalchemy.manus.space/",
    VELVET_ALCHEMY_READ_KEY: "va_test_read_only",
  });
  assert.equal(result.configured, true);
  if (result.configured) assert.equal(result.baseUrl, "https://velvetalchemy.manus.space");
});

test("Velvet control rejects an insecure remote base URL", () => {
  const result = getVelvetControlConfiguration({
    VELVET_ALCHEMY_BASE_URL: "http://velvetalchemy.manus.space",
    VELVET_ALCHEMY_READ_KEY: "va_test_read_only",
  });
  assert.equal(result.configured, false);
  assert.match(result.reason, /HTTPS/);
});

test("SMIRK chat call approval requires the latest exact confirmation and normalizes the target", () => {
  assert.equal(extractApprovedCallTarget([{ role: "user", content: "Call (775) 555-0100" }]), null);
  assert.equal(extractApprovedCallTarget([{ role: "user", content: "CONFIRM CALL (775) 555-0100" }]), "+17755550100");
  assert.equal(extractApprovedCallTarget([
    { role: "user", content: "CONFIRM CALL +17755550100" },
    { role: "assistant", content: "Understood." },
    { role: "user", content: "Actually, hold." },
  ]), null);
});

test("SMIRK chat CRUD approval enables only one exact mutation", () => {
  assert.equal(extractApprovedActionTool([{ role: "user", content: "Create a task" }]), null);
  assert.equal(extractApprovedActionTool([{ role: "user", content: "CONFIRM ACTION create_task" }]), "create_task");
  assert.equal(extractApprovedActionTool([{ role: "user", content: "CONFIRM ACTION make_call" }]), null);
  assert.equal(extractApprovedActionTool([
    { role: "user", content: "CONFIRM ACTION create_task" },
    { role: "user", content: "Actually do not." },
  ]), null);
});
