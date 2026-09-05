import assert from "node:assert/strict";
import test from "node:test";
import { isToolAllowed, toolDeclarationsForAccessMode } from "./smirk-chat.js";

test("a shared operator API-key session remains tool-free", () => {
  assert.deepEqual(toolDeclarationsForAccessMode("operator_readonly"), []);
  assert.equal(isToolAllowed("update_setting", "operator_readonly", null, "update_setting"), false);
  assert.equal(isToolAllowed("get_velvet_system_state", "operator_readonly", null, null), false);
});

test("workspace and demo sessions cannot use operator-only tools", () => {
  for (const accessMode of ["workspace", "demo_operator"] as const) {
    assert.equal(isToolAllowed("make_call", accessMode, "+15555550123", null), false);
    assert.equal(isToolAllowed("update_setting", accessMode, null, "update_setting"), false);
  }
});

test("an owner mutation requires an exact confirmation", () => {
  assert.equal(isToolAllowed("update_setting", "owner_operator", null, null), false);
  assert.equal(isToolAllowed("update_setting", "owner_operator", null, "update_setting"), true);
});

test("an outbound call requires a target-bound owner confirmation", () => {
  assert.equal(isToolAllowed("make_call", "owner_operator", null, null), false);
  assert.equal(isToolAllowed("make_call", "owner_operator", "+15555550123", null), true);
});
