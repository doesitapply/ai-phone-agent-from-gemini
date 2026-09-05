import assert from "node:assert/strict";
import test from "node:test";
import { shouldTryOpenRouterFallback, toSafeChatProviderFailure } from "./chat-provider-error.js";

test("classifies denied Gemini project access as eligible for OpenRouter fallback", () => {
  const error = new Error('{"error":{"code":403,"message":"Your project has been denied access.","status":"PERMISSION_DENIED"}}');
  assert.equal(shouldTryOpenRouterFallback(error), true);
  assert.deepEqual(toSafeChatProviderFailure(error), {
    status: 503,
    body: {
      error: "SMIRK Agent is temporarily unavailable because its AI provider access needs repair. No action was taken.",
      code: "CHAT_PROVIDER_ACCESS_DENIED",
    },
  });
});

test("does not expose unrelated upstream provider failures", () => {
  assert.equal(shouldTryOpenRouterFallback(new Error("timeout")), false);
  assert.deepEqual(toSafeChatProviderFailure(new Error("timeout")), {
    status: 503,
    body: {
      error: "SMIRK Agent is temporarily unavailable. No action was taken.",
      code: "CHAT_PROVIDER_UNAVAILABLE",
    },
  });
});
