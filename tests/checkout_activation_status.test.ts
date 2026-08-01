import assert from "node:assert/strict";
import test from "node:test";
import { checkoutProvisioningStatusAfterInviteDelivery } from "../src/checkout-activation-status.js";

test("a delivered invite cannot erase required telephony setup", () => {
  assert.equal(
    checkoutProvisioningStatusAfterInviteDelivery({ delivered: true, twilioPhoneNumber: null }),
    "PENDING_MANUAL_TELEPHONY",
  );
  assert.equal(
    checkoutProvisioningStatusAfterInviteDelivery({ delivered: true, twilioPhoneNumber: " +17755550123 " }),
    "workspace_created",
  );
  assert.equal(
    checkoutProvisioningStatusAfterInviteDelivery({ delivered: false, twilioPhoneNumber: "+17755550123" }),
    "manual_fallback_required",
  );
});
