import twilio from "twilio";
import { decryptWorkspaceSecret, encryptWorkspaceSecret } from "./workspace-secret-crypto.js";

export type TwilioProvisionResult = {
  enabled: boolean;
  subaccountSid: string | null;
  encryptedAuthToken: string | null;
  phoneNumber: string | null;
  phoneNumberSid: string | null;
  areaCodeUsed: string | null;
};

function normalizeAreaCode(raw?: string | null): string | null {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length >= 10) return digits.slice(-10, -7) || null;
  if (digits.length === 3) return digits;
  return null;
}

export class TwilioService {
  private readonly masterSid: string;
  private readonly masterToken: string;
  private readonly appUrl: string;
  private readonly enabled: boolean;
  private readonly defaultAreaCode: string;
  private readonly encryptionSecret: string;
  private readonly client: ReturnType<typeof twilio> | null;

  constructor(opts?: { appUrl?: string }) {
    this.masterSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
    this.masterToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
    this.appUrl = String(opts?.appUrl || process.env.APP_URL || "").replace(/\/$/, "");
    this.defaultAreaCode = normalizeAreaCode(process.env.TWILIO_DEFAULT_AREA_CODE || "775") || "775";
    this.encryptionSecret = String(process.env.WORKSPACE_SECRET_ENCRYPTION_KEY || process.env.PHONE_AGENT_PROVISIONING_SECRET || this.masterToken || "").trim();
    this.enabled = !!(this.masterSid && this.masterToken && this.appUrl);
    this.client = this.enabled ? twilio(this.masterSid, this.masterToken) : null;
  }

  isEnabled() {
    return this.enabled;
  }

  buildSubaccountFriendlyName(workspaceId: number): string {
    return `SMIRK managed workspace ${workspaceId}`;
  }

  buildPhoneFriendlyName(workspaceId: number): string {
    return `SMIRK line workspace ${workspaceId}`;
  }

  decryptAuthToken(encryptedAuthToken: string): string {
    return decryptWorkspaceSecret(encryptedAuthToken, this.encryptionSecret);
  }

  private requireClient() {
    if (!this.client) throw new Error("Managed Twilio provisioning not configured");
    return this.client;
  }

  async createSubaccount(businessName: string) {
    const client = this.requireClient();
    const account = await client.api.v2010.accounts.create({
      friendlyName: businessName.slice(0, 64) || "SMIRK Workspace",
    });
    if (!account.sid || !account.authToken) throw new Error("Twilio subaccount creation did not return credentials");
    return {
      sid: account.sid,
      authToken: account.authToken,
      encryptedAuthToken: encryptWorkspaceSecret(account.authToken, this.encryptionSecret),
    };
  }

  async reconcileSubaccount(friendlyName: string) {
    const client = this.requireClient();
    const accounts = await client.api.v2010.accounts.list({
      friendlyName,
      status: "active",
      limit: 2,
    });
    if (accounts.length > 1) {
      throw new Error(`Twilio provider reconciliation found duplicate managed subaccounts for ${friendlyName}`);
    }
    const account = accounts[0];
    if (!account) return null;
    if (!account.sid || !account.authToken) {
      throw new Error(`Twilio provider reconciliation could not recover credentials for ${friendlyName}`);
    }
    return {
      sid: account.sid,
      authToken: account.authToken,
      encryptedAuthToken: encryptWorkspaceSecret(account.authToken, this.encryptionSecret),
    };
  }

  async findAvailableLocalNumber(areaCode?: string | null) {
    const client = this.requireClient();
    const resolvedAreaCode = normalizeAreaCode(areaCode) || this.defaultAreaCode;
    let list = await client.availablePhoneNumbers("US").local.list({ areaCode: Number(resolvedAreaCode), limit: 1 });
    if (!list[0]) {
      list = await client.availablePhoneNumbers("US").local.list({ limit: 1 });
    }
    const candidate = list[0];
    if (!candidate?.phoneNumber) throw new Error("No available US local Twilio numbers found");
    return {
      areaCodeUsed: resolvedAreaCode,
      phoneNumber: candidate.phoneNumber,
    };
  }

  async reconcilePhone(subaccountSid: string, authToken: string, friendlyName: string, voiceUrl?: string) {
    const client = twilio(subaccountSid, authToken);
    const numbers = await client.incomingPhoneNumbers.list({ friendlyName, limit: 2 });
    if (numbers.length > 1) {
      throw new Error(`Twilio provider reconciliation found duplicate managed numbers for ${friendlyName}`);
    }
    const number = numbers[0];
    if (!number) return null;
    if (!number.sid || !number.phoneNumber) {
      throw new Error(`Twilio provider reconciliation found an incomplete managed number for ${friendlyName}`);
    }
    const expectedVoiceUrl = voiceUrl || `${this.appUrl}/api/twilio/incoming`;
    const expectedStatusCallback = `${this.appUrl}/api/twilio/status`;
    if (
      number.voiceUrl !== expectedVoiceUrl
      || number.voiceMethod !== "POST"
      || number.statusCallback !== expectedStatusCallback
      || number.statusCallbackMethod !== "POST"
    ) {
      const repaired = await client.incomingPhoneNumbers(number.sid).update({
        voiceUrl: expectedVoiceUrl,
        voiceMethod: "POST",
        statusCallback: expectedStatusCallback,
        statusCallbackMethod: "POST",
      });
      return { sid: repaired.sid, phoneNumber: repaired.phoneNumber };
    }
    return { sid: number.sid, phoneNumber: number.phoneNumber };
  }

  async purchaseNumber(subaccountSid: string, authToken: string, phoneNumber: string, voiceUrl?: string, friendlyName?: string) {
    const client = twilio(subaccountSid, authToken);
    const incoming = await client.incomingPhoneNumbers.create({
      phoneNumber,
      friendlyName,
      voiceUrl: voiceUrl || `${this.appUrl}/api/twilio/incoming`,
      voiceMethod: "POST",
      statusCallback: `${this.appUrl}/api/twilio/status`,
      statusCallbackMethod: "POST",
    });
    return {
      sid: incoming.sid,
      phoneNumber: incoming.phoneNumber,
    };
  }

  async provision(args: { businessName: string; ownerPhone?: string | null; voiceUrl?: string; }) : Promise<TwilioProvisionResult> {
    if (!this.enabled) {
      return {
        enabled: false,
        subaccountSid: null,
        encryptedAuthToken: null,
        phoneNumber: null,
        phoneNumberSid: null,
        areaCodeUsed: null,
      };
    }

    const subaccount = await this.createSubaccount(args.businessName);
    const candidate = await this.findAvailableLocalNumber(args.ownerPhone);
    const purchased = await this.purchaseNumber(subaccount.sid, subaccount.authToken, candidate.phoneNumber, args.voiceUrl);

    return {
      enabled: true,
      subaccountSid: subaccount.sid,
      encryptedAuthToken: subaccount.encryptedAuthToken,
      phoneNumber: purchased.phoneNumber || candidate.phoneNumber,
      phoneNumberSid: purchased.sid,
      areaCodeUsed: candidate.areaCodeUsed,
    };
  }
}
