import assert from "node:assert/strict";
import test from "node:test";
import { SMIRK_IDENTITY, smirkIdentityInstruction } from "../src/live-call-safety.ts";

test("SMIRK identity response names its actual owner and builder rather than an upstream AI provider", () => {
  assert.deepEqual(SMIRK_IDENTITY, {
    product: "SMIRK AI",
    ownerAndBuilder: "Cameron Church",
    role: "missed-call recovery assistant for local businesses",
  });
  const instruction = smirkIdentityInstruction();
  assert.match(instruction, /Cameron Church/);
  assert.match(instruction, /Never say Google, Gemini, Twilio, OpenAI/);
});
