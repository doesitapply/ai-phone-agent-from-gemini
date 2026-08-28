import assert from "node:assert/strict";
import {
  SMIRK_IDENTITY,
  failedTransferRecovery,
  hasCallableVoiceNumber,
  isVoiceDashboardMutation,
  voiceDashboardMutationRefusal,
} from "../src/live-call-safety.ts";

assert.equal(SMIRK_IDENTITY.ownerAndBuilder, "Cameron Church");
assert.equal(isVoiceDashboardMutation("complete_open_tasks"), true);
assert.equal(isVoiceDashboardMutation("cancel_task"), true);
assert.equal(isVoiceDashboardMutation("list_open_tasks"), false);
assert.match(voiceDashboardMutationRefusal(), /authenticated dashboard/i);
assert.equal(hasCallableVoiceNumber("+17753863205"), true);
assert.equal(hasCallableVoiceNumber("Anonymous"), false);
assert.deepEqual(failedTransferRecovery("+17753863205"), {
  taskType: "callback",
  spokenText: "I couldn't connect you just now, but I have your number and have sent a callback request to the owner. You'll hear back as soon as they are available.",
});
assert.equal(failedTransferRecovery("Anonymous").taskType, "handoff");
assert.match(failedTransferRecovery("Anonymous").spokenText, /leave the best callback number/i);

console.log("Live-call behavioral check passed (10 assertions).");
