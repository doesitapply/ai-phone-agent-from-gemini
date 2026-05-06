import crypto from "crypto";
import twilio from "twilio";

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

function buildEncryptionKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptSecret(value: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const key = buildEncryptionKey(secret);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
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
      encryptedAuthToken: this.encryptionSecret ? encryptSecret(account.authToken, this.encryptionSecret) : account.authToken,
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

  async purchaseNumber(subaccountSid: string, authToken: string, phoneNumber: string, voiceUrl?: string) {
    const client = twilio(subaccountSid, authToken);
    const incoming = await client.incomingPhoneNumbers.create({
      phoneNumber,
      voiceUrl: voiceUrl || `${this.appUrl}/api/twilio/incoming`,
      voiceMethod: "POST",
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
