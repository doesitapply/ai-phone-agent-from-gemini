import { randomUUID } from "node:crypto";

export type TelephonyProvisioningStatus = "pending" | "running" | "failed" | "completed";

export type TelephonyProvisioningState = {
  workspaceId: number;
  status: TelephonyProvisioningStatus;
  leaseToken: string | null;
  leaseExpiresAt: Date | string | null;
  subaccountSid: string | null;
  encryptedAuthToken: string | null;
  phoneNumber: string | null;
  phoneNumberSid: string | null;
  areaCodeUsed: string | null;
  lastError?: string | null;
};

export type TelephonyProvisioningResult = {
  enabled: boolean;
  subaccountSid: string | null;
  encryptedAuthToken: string | null;
  phoneNumber: string | null;
  phoneNumberSid: string | null;
  areaCodeUsed: string | null;
};

export type TelephonyProvisioningStore = {
  seed(input: {
    workspaceId: number;
    subaccountSid?: string | null;
    encryptedAuthToken?: string | null;
    phoneNumber?: string | null;
    phoneNumberSid?: string | null;
  }): Promise<void>;
  read(workspaceId: number): Promise<TelephonyProvisioningState | null>;
  claim(workspaceId: number, leaseToken: string, leaseMs: number): Promise<{ claimed: boolean; state: TelephonyProvisioningState }>;
  checkpoint(
    workspaceId: number,
    leaseToken: string,
    patch: Partial<Pick<TelephonyProvisioningState,
      "subaccountSid" | "encryptedAuthToken" | "phoneNumber" | "phoneNumberSid" | "areaCodeUsed">>,
    leaseMs: number,
  ): Promise<TelephonyProvisioningState>;
  complete(workspaceId: number, leaseToken: string): Promise<TelephonyProvisioningState>;
  fail(workspaceId: number, leaseToken: string, error: string): Promise<void>;
};

export type ManagedTwilioProvider = {
  enabled: boolean;
  buildSubaccountFriendlyName(workspaceId: number, businessName: string): string;
  buildPhoneFriendlyName(workspaceId: number): string;
  reconcileSubaccount(friendlyName: string): Promise<{ sid: string; authToken: string; encryptedAuthToken: string } | null>;
  createSubaccount(friendlyName: string): Promise<{ sid: string; authToken: string; encryptedAuthToken: string }>;
  decryptAuthToken(encryptedAuthToken: string): string;
  reconcilePhone(input: {
    subaccountSid: string;
    authToken: string;
    friendlyName: string;
    voiceUrl: string;
  }): Promise<{ sid: string; phoneNumber: string } | null>;
  findAvailableLocalNumber(areaCode?: string | null): Promise<{ areaCodeUsed: string; phoneNumber: string }>;
  purchaseNumber(input: {
    subaccountSid: string;
    authToken: string;
    phoneNumber: string;
    voiceUrl: string;
    friendlyName: string;
  }): Promise<{ sid: string; phoneNumber: string }>;
};

const resultFromState = (state: TelephonyProvisioningState): TelephonyProvisioningResult => ({
  enabled: true,
  subaccountSid: state.subaccountSid,
  encryptedAuthToken: state.encryptedAuthToken,
  phoneNumber: state.phoneNumber,
  phoneNumberSid: state.phoneNumberSid,
  areaCodeUsed: state.areaCodeUsed,
});

type CompletedTelephonyProvisioningState = TelephonyProvisioningState & {
  status: "completed";
  subaccountSid: string;
  encryptedAuthToken: string;
  phoneNumber: string;
  phoneNumberSid: string;
};

const isComplete = (state: TelephonyProvisioningState | null): state is CompletedTelephonyProvisioningState => Boolean(
  state?.status === "completed"
  && state.subaccountSid
  && state.encryptedAuthToken
  && state.phoneNumber
  && state.phoneNumberSid,
);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one durable, provider-reconciling telephony provision for a workspace.
 *
 * The durable lease prevents normal concurrent callers from purchasing twice.
 * Provider reconciliation covers the harder crash window where Twilio accepted
 * a subaccount/number purchase but the following database checkpoint failed.
 */
export async function provisionManagedWorkspaceTelephony(input: {
  workspaceId: number;
  businessName: string;
  ownerPhone?: string | null;
  voiceUrl: string;
  store: TelephonyProvisioningStore;
  provider: ManagedTwilioProvider;
  leaseMs?: number;
  waitMs?: number;
  pollMs?: number;
}): Promise<TelephonyProvisioningResult> {
  if (!input.provider.enabled) {
    return {
      enabled: false,
      subaccountSid: null,
      encryptedAuthToken: null,
      phoneNumber: null,
      phoneNumberSid: null,
      areaCodeUsed: null,
    };
  }

  const leaseMs = Math.max(10_000, input.leaseMs ?? 5 * 60_000);
  const waitMs = Math.max(0, input.waitMs ?? 30_000);
  const pollMs = Math.max(10, input.pollMs ?? 200);
  const leaseToken = randomUUID();
  const claim = await input.store.claim(input.workspaceId, leaseToken, leaseMs);

  if (!claim.claimed) {
    if (isComplete(claim.state)) return resultFromState(claim.state);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const current = await input.store.read(input.workspaceId);
      if (isComplete(current)) return resultFromState(current);
      if (current?.status === "failed") {
        return provisionManagedWorkspaceTelephony({ ...input, waitMs: Math.max(0, deadline - Date.now()) });
      }
    }
    throw new Error("Workspace telephony provisioning is already in progress; retry shortly.");
  }

  let state = claim.state;
  try {
    const subaccountFriendlyName = input.provider.buildSubaccountFriendlyName(input.workspaceId, input.businessName);
    let subaccount: { sid: string; authToken: string; encryptedAuthToken: string };
    if (state.subaccountSid && state.encryptedAuthToken) {
      subaccount = {
        sid: state.subaccountSid,
        authToken: input.provider.decryptAuthToken(state.encryptedAuthToken),
        encryptedAuthToken: state.encryptedAuthToken,
      };
    } else {
      subaccount = await input.provider.reconcileSubaccount(subaccountFriendlyName)
        || await input.provider.createSubaccount(subaccountFriendlyName);
      state = await input.store.checkpoint(input.workspaceId, leaseToken, {
        subaccountSid: subaccount.sid,
        encryptedAuthToken: subaccount.encryptedAuthToken,
      }, leaseMs);
    }

    const phoneFriendlyName = input.provider.buildPhoneFriendlyName(input.workspaceId);
    let phone = state.phoneNumber && state.phoneNumberSid
        ? { sid: state.phoneNumberSid, phoneNumber: state.phoneNumber }
      : await input.provider.reconcilePhone({
          subaccountSid: subaccount.sid,
          authToken: subaccount.authToken,
          friendlyName: phoneFriendlyName,
          voiceUrl: input.voiceUrl,
        });

    let areaCodeUsed = state.areaCodeUsed;
    if (!phone) {
      const candidate = await input.provider.findAvailableLocalNumber(input.ownerPhone);
      areaCodeUsed = candidate.areaCodeUsed;
      phone = await input.provider.purchaseNumber({
        subaccountSid: subaccount.sid,
        authToken: subaccount.authToken,
        phoneNumber: candidate.phoneNumber,
        voiceUrl: input.voiceUrl,
        friendlyName: phoneFriendlyName,
      });
    }

    state = await input.store.checkpoint(input.workspaceId, leaseToken, {
      phoneNumber: phone.phoneNumber,
      phoneNumberSid: phone.sid,
      areaCodeUsed,
    }, leaseMs);
    state = await input.store.complete(input.workspaceId, leaseToken);
    if (!isComplete(state)) throw new Error("Durable telephony completion checkpoint is incomplete.");
    return resultFromState(state);
  } catch (error) {
    const message = String((error as Error)?.message || error || "Managed Twilio provisioning failed").slice(0, 2_000);
    await input.store.fail(input.workspaceId, leaseToken, message).catch(() => {});
    throw error;
  }
}

const mapState = (row: any): TelephonyProvisioningState => ({
  workspaceId: Number(row.workspace_id),
  status: row.status,
  leaseToken: row.lease_token || null,
  leaseExpiresAt: row.lease_expires_at || null,
  subaccountSid: row.subaccount_sid || null,
  encryptedAuthToken: row.encrypted_auth_token || null,
  phoneNumber: row.phone_number || null,
  phoneNumberSid: row.phone_number_sid || null,
  areaCodeUsed: row.area_code_used || null,
  lastError: row.last_error || null,
});

export function createSqlTelephonyProvisioningStore(sql: any): TelephonyProvisioningStore {
  const read = async (workspaceId: number): Promise<TelephonyProvisioningState | null> => {
    const rows = await sql`
      SELECT * FROM workspace_telephony_provisioning
      WHERE workspace_id = ${workspaceId}
      LIMIT 1
    `;
    return rows[0] ? mapState(rows[0]) : null;
  };

  return {
    async seed(input) {
      const completed = Boolean(
        input.subaccountSid && input.encryptedAuthToken && input.phoneNumber && input.phoneNumberSid,
      );
      await sql`
        INSERT INTO workspace_telephony_provisioning (
          workspace_id, status, subaccount_sid, encrypted_auth_token,
          phone_number, phone_number_sid, completed_at, updated_at
        ) VALUES (
          ${input.workspaceId}, ${completed ? "completed" : "pending"},
          ${input.subaccountSid || null}, ${input.encryptedAuthToken || null},
          ${input.phoneNumber || null}, ${input.phoneNumberSid || null},
          ${completed ? new Date().toISOString() : null}, NOW()
        )
        ON CONFLICT (workspace_id) DO NOTHING
      `;
    },
    read,
    async claim(workspaceId, leaseToken, leaseMs) {
      await sql`
        INSERT INTO workspace_telephony_provisioning (workspace_id, status, updated_at)
        VALUES (${workspaceId}, 'pending', NOW())
        ON CONFLICT (workspace_id) DO NOTHING
      `;
      const rows = await sql`
        UPDATE workspace_telephony_provisioning
        SET status = 'running',
            lease_token = ${leaseToken},
            lease_expires_at = NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
            last_error = NULL,
            updated_at = NOW()
        WHERE workspace_id = ${workspaceId}
          AND (
            status IN ('pending', 'failed')
            OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= NOW()))
          )
        RETURNING *
      `;
      if (rows[0]) return { claimed: true, state: mapState(rows[0]) };
      const current = await read(workspaceId);
      if (!current) throw new Error("Telephony provisioning claim disappeared.");
      return { claimed: false, state: current };
    },
    async checkpoint(workspaceId, leaseToken, patch, leaseMs) {
      const rows = await sql`
        UPDATE workspace_telephony_provisioning
        SET subaccount_sid = COALESCE(${patch.subaccountSid || null}, subaccount_sid),
            encrypted_auth_token = COALESCE(${patch.encryptedAuthToken || null}, encrypted_auth_token),
            phone_number = COALESCE(${patch.phoneNumber || null}, phone_number),
            phone_number_sid = COALESCE(${patch.phoneNumberSid || null}, phone_number_sid),
            area_code_used = COALESCE(${patch.areaCodeUsed || null}, area_code_used),
            lease_expires_at = NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
            updated_at = NOW()
        WHERE workspace_id = ${workspaceId}
          AND status = 'running'
          AND lease_token = ${leaseToken}
          AND lease_expires_at > NOW()
        RETURNING *
      `;
      if (!rows[0]) throw new Error("Lost durable telephony provisioning lease before checkpoint.");
      return mapState(rows[0]);
    },
    async complete(workspaceId, leaseToken) {
      const rows = await sql`
        UPDATE workspace_telephony_provisioning
        SET status = 'completed',
            lease_token = NULL,
            lease_expires_at = NULL,
            completed_at = NOW(),
            last_error = NULL,
            updated_at = NOW()
        WHERE workspace_id = ${workspaceId}
          AND status = 'running'
          AND lease_token = ${leaseToken}
          AND subaccount_sid IS NOT NULL
          AND encrypted_auth_token IS NOT NULL
          AND phone_number IS NOT NULL
          AND phone_number_sid IS NOT NULL
        RETURNING *
      `;
      if (!rows[0]) throw new Error("Could not atomically complete telephony provisioning.");
      return mapState(rows[0]);
    },
    async fail(workspaceId, leaseToken, error) {
      await sql`
        UPDATE workspace_telephony_provisioning
        SET status = 'failed',
            lease_token = NULL,
            lease_expires_at = NULL,
            last_error = ${error},
            updated_at = NOW()
        WHERE workspace_id = ${workspaceId}
          AND lease_token = ${leaseToken}
      `;
    },
  };
}
