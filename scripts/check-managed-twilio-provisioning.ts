import assert from "node:assert/strict";
import {
  provisionManagedWorkspaceTelephony,
  type ManagedTwilioProvider,
  type TelephonyProvisioningState,
  type TelephonyProvisioningStore,
} from "../src/workspace-telephony-provisioning.js";

const clone = (state: TelephonyProvisioningState): TelephonyProvisioningState => ({ ...state });

class MemoryStore implements TelephonyProvisioningStore {
  readonly states = new Map<number, TelephonyProvisioningState>();
  failNextSubaccountCheckpoint = false;
  failNextPhoneCheckpoint = false;

  async seed(input: { workspaceId: number; subaccountSid?: string | null; encryptedAuthToken?: string | null; phoneNumber?: string | null; phoneNumberSid?: string | null }) {
    if (this.states.has(input.workspaceId)) return;
    const completed = Boolean(input.subaccountSid && input.encryptedAuthToken && input.phoneNumber && input.phoneNumberSid);
    this.states.set(input.workspaceId, {
      workspaceId: input.workspaceId,
      status: completed ? "completed" : "pending",
      leaseToken: null,
      leaseExpiresAt: null,
      subaccountSid: input.subaccountSid || null,
      encryptedAuthToken: input.encryptedAuthToken || null,
      phoneNumber: input.phoneNumber || null,
      phoneNumberSid: input.phoneNumberSid || null,
      areaCodeUsed: null,
      lastError: null,
    });
  }

  async read(workspaceId: number) {
    const state = this.states.get(workspaceId);
    return state ? clone(state) : null;
  }

  async claim(workspaceId: number, leaseToken: string, leaseMs: number) {
    if (!this.states.has(workspaceId)) await this.seed({ workspaceId });
    const state = this.states.get(workspaceId)!;
    const leaseExpired = !state.leaseExpiresAt || new Date(state.leaseExpiresAt).getTime() <= Date.now();
    if (state.status === "pending" || state.status === "failed" || (state.status === "running" && leaseExpired)) {
      state.status = "running";
      state.leaseToken = leaseToken;
      state.leaseExpiresAt = new Date(Date.now() + leaseMs);
      state.lastError = null;
      return { claimed: true, state: clone(state) };
    }
    return { claimed: false, state: clone(state) };
  }

  async checkpoint(workspaceId: number, leaseToken: string, patch: any, leaseMs: number) {
    const state = this.states.get(workspaceId)!;
    if (state.status !== "running" || state.leaseToken !== leaseToken) throw new Error("lost fixture lease");
    if (patch.subaccountSid && this.failNextSubaccountCheckpoint) {
      this.failNextSubaccountCheckpoint = false;
      throw new Error("simulated database loss after Twilio subaccount success");
    }
    if (patch.phoneNumberSid && this.failNextPhoneCheckpoint) {
      this.failNextPhoneCheckpoint = false;
      throw new Error("simulated database loss after Twilio number purchase success");
    }
    Object.assign(state, patch);
    state.leaseExpiresAt = new Date(Date.now() + leaseMs);
    return clone(state);
  }

  async complete(workspaceId: number, leaseToken: string) {
    const state = this.states.get(workspaceId)!;
    if (state.status !== "running" || state.leaseToken !== leaseToken) throw new Error("lost fixture completion lease");
    state.status = "completed";
    state.leaseToken = null;
    state.leaseExpiresAt = null;
    return clone(state);
  }

  async fail(workspaceId: number, leaseToken: string, error: string) {
    const state = this.states.get(workspaceId)!;
    if (state.leaseToken !== leaseToken) return;
    state.status = "failed";
    state.leaseToken = null;
    state.leaseExpiresAt = null;
    state.lastError = error;
  }
}

function makeProvider() {
  const subaccounts = new Map<string, { sid: string; authToken: string; encryptedAuthToken: string }>();
  const phones = new Map<string, { sid: string; phoneNumber: string }>();
  let subaccountCreates = 0;
  let phonePurchases = 0;

  const provider: ManagedTwilioProvider = {
    enabled: true,
    buildSubaccountFriendlyName: (workspaceId) => `SMIRK managed workspace ${workspaceId}`,
    buildPhoneFriendlyName: (workspaceId) => `SMIRK line workspace ${workspaceId}`,
    reconcileSubaccount: async (friendlyName) => subaccounts.get(friendlyName) || null,
    createSubaccount: async (friendlyName) => {
      subaccountCreates += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const created = {
        sid: `AC${String(subaccountCreates).padStart(32, "a")}`,
        authToken: `token-${friendlyName}`,
        encryptedAuthToken: `enc:${friendlyName}`,
      };
      subaccounts.set(friendlyName, created);
      return created;
    },
    decryptAuthToken: (encrypted) => `token-${encrypted.slice(4)}`,
    reconcilePhone: async ({ friendlyName }) => phones.get(friendlyName) || null,
    findAvailableLocalNumber: async () => ({ areaCodeUsed: "775", phoneNumber: `+1775555${String(phonePurchases + 1).padStart(4, "0")}` }),
    purchaseNumber: async ({ friendlyName, phoneNumber }) => {
      phonePurchases += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const purchased = { sid: `PN${String(phonePurchases).padStart(32, "b")}`, phoneNumber };
      phones.set(friendlyName, purchased);
      return purchased;
    },
  };
  return {
    provider,
    counts: () => ({ subaccountCreates, phonePurchases }),
  };
}

const voiceUrl = "https://smirkcalls.com/api/twilio/incoming";

const concurrentStore = new MemoryStore();
await concurrentStore.seed({ workspaceId: 41 });
const concurrentProvider = makeProvider();
const concurrent = await Promise.all([
  provisionManagedWorkspaceTelephony({ workspaceId: 41, businessName: "Concurrent Co", voiceUrl, store: concurrentStore, provider: concurrentProvider.provider, pollMs: 10, waitMs: 2_000 }),
  provisionManagedWorkspaceTelephony({ workspaceId: 41, businessName: "Concurrent Co", voiceUrl, store: concurrentStore, provider: concurrentProvider.provider, pollMs: 10, waitMs: 2_000 }),
]);
assert.equal(concurrentProvider.counts().subaccountCreates, 1, "concurrent requests must create one subaccount");
assert.equal(concurrentProvider.counts().phonePurchases, 1, "concurrent requests must purchase one number");
assert.equal(concurrent[0].phoneNumberSid, concurrent[1].phoneNumberSid, "concurrent callers must receive the same durable result");

const phoneRecoveryStore = new MemoryStore();
await phoneRecoveryStore.seed({ workspaceId: 42 });
phoneRecoveryStore.failNextPhoneCheckpoint = true;
const phoneRecoveryProvider = makeProvider();
await assert.rejects(
  provisionManagedWorkspaceTelephony({ workspaceId: 42, businessName: "Phone Recovery Co", voiceUrl, store: phoneRecoveryStore, provider: phoneRecoveryProvider.provider, pollMs: 10 }),
  /database loss after Twilio number purchase success/,
);
const recoveredPhone = await provisionManagedWorkspaceTelephony({ workspaceId: 42, businessName: "Phone Recovery Co", voiceUrl, store: phoneRecoveryStore, provider: phoneRecoveryProvider.provider, pollMs: 10 });
assert.ok(recoveredPhone.phoneNumber, "retry must recover the provider-owned phone");
assert.equal(phoneRecoveryProvider.counts().subaccountCreates, 1, "phone recovery must reuse the checkpointed subaccount");
assert.equal(phoneRecoveryProvider.counts().phonePurchases, 1, "phone recovery must reconcile provider success without buying again");

const subaccountRecoveryStore = new MemoryStore();
await subaccountRecoveryStore.seed({ workspaceId: 43 });
subaccountRecoveryStore.failNextSubaccountCheckpoint = true;
const subaccountRecoveryProvider = makeProvider();
await assert.rejects(
  provisionManagedWorkspaceTelephony({ workspaceId: 43, businessName: "Account Recovery Co", voiceUrl, store: subaccountRecoveryStore, provider: subaccountRecoveryProvider.provider, pollMs: 10 }),
  /database loss after Twilio subaccount success/,
);
await provisionManagedWorkspaceTelephony({ workspaceId: 43, businessName: "Account Recovery Co", voiceUrl, store: subaccountRecoveryStore, provider: subaccountRecoveryProvider.provider, pollMs: 10 });
assert.equal(subaccountRecoveryProvider.counts().subaccountCreates, 1, "subaccount recovery must reconcile provider success without creating again");
assert.equal(subaccountRecoveryProvider.counts().phonePurchases, 1, "recovered subaccount must receive exactly one number");

console.log("OK managed Twilio provisioning serializes concurrency and reconciles provider success after checkpoint loss");
