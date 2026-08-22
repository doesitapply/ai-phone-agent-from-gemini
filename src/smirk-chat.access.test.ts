import { describe, expect, it } from "vitest";
import { isToolAllowed, toolDeclarationsForAccessMode } from "./smirk-chat.js";

describe("SMIRK chat tool authorization", () => {
  it("keeps a shared operator API-key session tool-free", () => {
    expect(toolDeclarationsForAccessMode("operator_readonly")).toEqual([]);
    expect(isToolAllowed("update_setting", "operator_readonly", null, "update_setting")).toBe(false);
    expect(isToolAllowed("get_velvet_system_state", "operator_readonly", null, null)).toBe(false);
  });

  it("requires an exact owner confirmation for a mutation", () => {
    expect(isToolAllowed("update_setting", "owner_operator", null, null)).toBe(false);
    expect(isToolAllowed("update_setting", "owner_operator", null, "update_setting")).toBe(true);
  });

  it("requires a target-bound owner confirmation for an outbound call", () => {
    expect(isToolAllowed("make_call", "owner_operator", null, null)).toBe(false);
    expect(isToolAllowed("make_call", "owner_operator", "+15555550123", null)).toBe(true);
  });
});
