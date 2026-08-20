import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";

export const VELVET_REMOTE_CONNECTION_PROOF_CONTRACT =
  "smirk-velvet.remote-connection-proof.v1" as const;
export const VELVET_CONNECTION_PROOF_RESPONSE_CONTRACT =
  "velvet-smirk.connection-proof.v1" as const;

const VELVET_PRODUCTION_ORIGIN =
  "https://velvetalchemy.manus.space";
const MAX_RESPONSE_BYTES = 16 * 1024;
const hexDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const velvetConnectionProofUnsignedSchema = z
  .object({
    contractVersion: z.literal(
      VELVET_CONNECTION_PROOF_RESPONSE_CONTRACT
    ),
    workspaceId: z.number().int().positive(),
    challenge: hexDigestSchema,
    credentialRole: z.enum(["research", "outcome"]),
    ownerBinding: hexDigestSchema,
    credentialBinding: hexDigestSchema,
    checks: z
      .object({
        exactDedicatedScope: z.literal(true),
        privilegedOwner: z.literal(true),
        workspaceBound: z.literal(true),
        signingSecretConfigured: z.literal(true),
      })
      .strict(),
    guardrails: z
      .object({
        contactAuthorized: z.literal(false),
        spendAuthorized: z.literal(false),
        providerRequestPerformed: z.literal(false),
        databaseMutationPerformed: z.literal(false),
      })
      .strict(),
    externalAction: z.literal("none"),
  })
  .strict();

export const velvetConnectionProofResponseSchema =
  velvetConnectionProofUnsignedSchema
    .extend({
      proof: hexDigestSchema,
    })
    .strict();

export type VelvetConnectionProofResponse = z.infer<
  typeof velvetConnectionProofResponseSchema
>;

export type VelvetRemoteConnectionProofConfig = {
  baseUrl: string;
  researchApiKey: string;
  outcomeApiKey: string;
  signingSecret: string;
  workspaceId: number | null;
  configured: boolean;
  missing: string[];
};

export type VelvetRemoteConnectionProofReport = {
  contractVersion:
    typeof VELVET_REMOTE_CONNECTION_PROOF_CONTRACT;
  ok: boolean;
  origin: string | null;
  workspaceId: number | null;
  requestsPerformed: 0 | 2;
  checks: {
    sourceKeyAuthenticated: boolean;
    outcomeKeyAuthenticated: boolean;
    exactDedicatedScopes: boolean;
    sameAdminOwner: boolean;
    credentialsDistinct: boolean;
    signingSecretMatched: boolean;
    workspaceAligned: boolean;
    remoteNoMutationClaimed: boolean;
  };
  blockers: string[];
  guardrails: {
    coldSmsAllowed: false;
    bulkEmailAllowed: false;
    automatedProspectDialingAllowed: false;
    contactAuthorized: false;
    spendAuthorized: false;
    providerRequestPerformed: false;
    remoteDatabaseMutationPerformed: false;
    localMutationPerformed: false;
  };
  unproven: string[];
  externalAction:
    | "none"
    | "read-only-remote-connection-proof";
};

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map(
      key =>
        `${JSON.stringify(key)}:${canonicalJson(object[key])}`
    )
    .join(",")}}`;
}

function connectionProofHmac(
  value: unknown,
  secret: string
): string {
  return createHmac("sha256", secret)
    .update(
      `velvet-smirk.connection-proof.response.v1\0${canonicalJson(
        value
      )}`
    )
    .digest("hex");
}

function proofSignatureMatches(
  response: VelvetConnectionProofResponse,
  secret: string
): boolean {
  if (secret.length < 32) return false;
  const { proof, ...unsigned } = response;
  const expected = Buffer.from(
    connectionProofHmac(unsigned, secret),
    "hex"
  );
  const actual = Buffer.from(proof, "hex");
  return (
    expected.length === actual.length &&
    timingSafeEqual(expected, actual)
  );
}

function exactProductionOrigin(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (
      parsed.origin !== VELVET_PRODUCTION_ORIGIN ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    ) {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

function positiveWorkspaceId(raw: string): number | null {
  const value = Number(raw);
  return /^\d+$/.test(raw) &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : null;
}

export function readVelvetRemoteConnectionProofConfig(
  env: Record<string, string | undefined> = process.env
): VelvetRemoteConnectionProofConfig {
  const sourceBaseUrl = exactProductionOrigin(
    String(env.VELVET_LEAD_SOURCE_BASE_URL || "").trim()
  );
  const outcomeBaseUrl = exactProductionOrigin(
    String(env.VELVET_BASE_URL || "").trim()
  );
  const researchApiKey = String(
    env.VELVET_LEAD_SOURCE_API_KEY || ""
  ).trim();
  const outcomeApiKey = String(
    env.VELVET_OUTCOME_API_KEY || ""
  ).trim();
  const signingSecret = String(
    env.VELVET_OUTCOME_SIGNING_SECRET || ""
  ).trim();
  const sourceWorkspaceId = positiveWorkspaceId(
    String(env.VELVET_LEAD_SOURCE_WORKSPACE_ID || "").trim()
  );
  const outcomeWorkspaceId = positiveWorkspaceId(
    String(env.VELVET_OUTCOME_WORKSPACE_ID || "").trim()
  );
  const missing = [
    ...(sourceBaseUrl ? [] : ["VELVET_LEAD_SOURCE_BASE_URL"]),
    ...(outcomeBaseUrl ? [] : ["VELVET_BASE_URL"]),
    ...(sourceBaseUrl &&
    outcomeBaseUrl &&
    sourceBaseUrl === outcomeBaseUrl
      ? []
      : ["VELVET_CONNECTION_PROOF_ORIGIN_ALIGNMENT"]),
    ...(researchApiKey.length >= 32
      ? []
      : ["VELVET_LEAD_SOURCE_API_KEY"]),
    ...(outcomeApiKey.length >= 32
      ? []
      : ["VELVET_OUTCOME_API_KEY"]),
    ...(researchApiKey &&
    outcomeApiKey &&
    researchApiKey !== outcomeApiKey
      ? []
      : ["VELVET_SOURCE_OUTCOME_KEY_SEPARATION"]),
    ...(signingSecret.length >= 32
      ? []
      : ["VELVET_OUTCOME_SIGNING_SECRET"]),
    ...(sourceWorkspaceId
      ? []
      : ["VELVET_LEAD_SOURCE_WORKSPACE_ID"]),
    ...(outcomeWorkspaceId
      ? []
      : ["VELVET_OUTCOME_WORKSPACE_ID"]),
    ...(sourceWorkspaceId &&
    outcomeWorkspaceId &&
    sourceWorkspaceId === outcomeWorkspaceId
      ? []
      : ["VELVET_CONNECTION_PROOF_WORKSPACE_ALIGNMENT"]),
  ];
  return {
    baseUrl:
      sourceBaseUrl === outcomeBaseUrl ? sourceBaseUrl : "",
    researchApiKey,
    outcomeApiKey,
    signingSecret,
    workspaceId:
      sourceWorkspaceId === outcomeWorkspaceId
        ? sourceWorkspaceId
        : null,
    configured: missing.length === 0,
    missing: [...new Set(missing)].sort(),
  };
}

function emptyReport(input: {
  config: VelvetRemoteConnectionProofConfig;
  blockers: string[];
  requestsPerformed?: 0 | 2;
}): VelvetRemoteConnectionProofReport {
  return {
    contractVersion: VELVET_REMOTE_CONNECTION_PROOF_CONTRACT,
    ok: false,
    origin: input.config.baseUrl || null,
    workspaceId: input.config.workspaceId,
    requestsPerformed: input.requestsPerformed || 0,
    checks: {
      sourceKeyAuthenticated: false,
      outcomeKeyAuthenticated: false,
      exactDedicatedScopes: false,
      sameAdminOwner: false,
      credentialsDistinct: false,
      signingSecretMatched: false,
      workspaceAligned: false,
      remoteNoMutationClaimed: false,
    },
    blockers: [...new Set(input.blockers)].sort(),
    guardrails: {
      coldSmsAllowed: false,
      bulkEmailAllowed: false,
      automatedProspectDialingAllowed: false,
      contactAuthorized: false,
      spendAuthorized: false,
      providerRequestPerformed: false,
      remoteDatabaseMutationPerformed: false,
      localMutationPerformed: false,
    },
    unproven: [
      "Velvet provider credentials are funded and accepted",
      "Resend DNS authentication and inbox placement",
      "deployed SMIRK parity and production migration state",
      "provider delivery, customer response, conversion, or revenue",
    ],
    externalAction:
      input.requestsPerformed === 2
        ? "read-only-remote-connection-proof"
        : "none",
  };
}

export function verifyVelvetConnectionProofResponses(input: {
  sourceBody: unknown;
  outcomeBody: unknown;
  config: VelvetRemoteConnectionProofConfig;
  challenge: string;
}): VelvetRemoteConnectionProofReport {
  const source =
    velvetConnectionProofResponseSchema.safeParse(
      input.sourceBody
    );
  const outcome =
    velvetConnectionProofResponseSchema.safeParse(
      input.outcomeBody
    );
  if (!source.success || !outcome.success) {
    return emptyReport({
      config: input.config,
      requestsPerformed: 2,
      blockers: ["VELVET_CONNECTION_PROOF_INVALID_RESPONSE"],
    });
  }

  const sourceKeyAuthenticated =
    source.data.credentialRole === "research";
  const outcomeKeyAuthenticated =
    outcome.data.credentialRole === "outcome";
  const exactDedicatedScopes =
    sourceKeyAuthenticated &&
    outcomeKeyAuthenticated &&
    source.data.checks.exactDedicatedScope &&
    outcome.data.checks.exactDedicatedScope;
  const sameAdminOwner =
    source.data.ownerBinding === outcome.data.ownerBinding;
  const credentialsDistinct =
    source.data.credentialBinding !==
    outcome.data.credentialBinding;
  const signingSecretMatched =
    proofSignatureMatches(
      source.data,
      input.config.signingSecret
    ) &&
    proofSignatureMatches(
      outcome.data,
      input.config.signingSecret
    );
  const workspaceAligned =
    input.config.workspaceId !== null &&
    source.data.workspaceId === input.config.workspaceId &&
    outcome.data.workspaceId === input.config.workspaceId &&
    source.data.challenge === input.challenge &&
    outcome.data.challenge === input.challenge;
  const remoteNoMutationClaimed =
    source.data.guardrails.databaseMutationPerformed === false &&
    outcome.data.guardrails.databaseMutationPerformed === false &&
    source.data.guardrails.contactAuthorized === false &&
    outcome.data.guardrails.contactAuthorized === false &&
    source.data.guardrails.spendAuthorized === false &&
    outcome.data.guardrails.spendAuthorized === false &&
    source.data.guardrails.providerRequestPerformed === false &&
    outcome.data.guardrails.providerRequestPerformed === false;
  const blockers = [
    ...(sourceKeyAuthenticated
      ? []
      : ["VELVET_CONNECTION_PROOF_SOURCE_KEY"]),
    ...(outcomeKeyAuthenticated
      ? []
      : ["VELVET_CONNECTION_PROOF_OUTCOME_KEY"]),
    ...(exactDedicatedScopes
      ? []
      : ["VELVET_CONNECTION_PROOF_DEDICATED_SCOPES"]),
    ...(sameAdminOwner
      ? []
      : ["VELVET_CONNECTION_PROOF_OWNER_ALIGNMENT"]),
    ...(credentialsDistinct
      ? []
      : ["VELVET_CONNECTION_PROOF_KEY_SEPARATION"]),
    ...(signingSecretMatched
      ? []
      : ["VELVET_CONNECTION_PROOF_SIGNING_SECRET"]),
    ...(workspaceAligned
      ? []
      : ["VELVET_CONNECTION_PROOF_WORKSPACE"]),
    ...(remoteNoMutationClaimed
      ? []
      : ["VELVET_CONNECTION_PROOF_GUARDRAILS"]),
  ];
  return {
    ...emptyReport({
      config: input.config,
      requestsPerformed: 2,
      blockers,
    }),
    ok: blockers.length === 0,
    checks: {
      sourceKeyAuthenticated,
      outcomeKeyAuthenticated,
      exactDedicatedScopes,
      sameAdminOwner,
      credentialsDistinct,
      signingSecretMatched,
      workspaceAligned,
      remoteNoMutationClaimed,
    },
    blockers,
  };
}

async function readBoundedJson(
  response: Response
): Promise<unknown> {
  const contentLength = Number(
    response.headers.get("content-length") || 0
  );
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_RESPONSE_BYTES
  ) {
    throw new Error("VELVET_CONNECTION_PROOF_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(
        "VELVET_CONNECTION_PROOF_RESPONSE_TOO_LARGE"
      );
    }
    output += decoder.decode(value, { stream: true });
  }
  output += decoder.decode();
  return output ? JSON.parse(output) : {};
}

async function requestConnectionProof(input: {
  config: VelvetRemoteConnectionProofConfig;
  apiKey: string;
  challenge: string;
  fetchImpl: FetchLike;
  signal?: AbortSignal;
}): Promise<unknown> {
  const url = new URL(
    "/api/v1/smirk/connection-proof",
    input.config.baseUrl
  );
  url.searchParams.set(
    "workspaceId",
    String(input.config.workspaceId)
  );
  url.searchParams.set("challenge", input.challenge);
  const response = await input.fetchImpl(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.apiKey}`,
    },
    redirect: "manual",
    cache: "no-store",
    signal: input.signal,
  });
  if (response.status !== 200) {
    throw new Error("VELVET_CONNECTION_PROOF_REMOTE_REJECTED");
  }
  return readBoundedJson(response);
}

export async function verifyRemoteVelvetConnectionProof(input: {
  config: VelvetRemoteConnectionProofConfig;
  fetchImpl?: FetchLike;
  challenge?: string;
  signal?: AbortSignal;
}): Promise<VelvetRemoteConnectionProofReport> {
  if (!input.config.configured) {
    return emptyReport({
      config: input.config,
      blockers: input.config.missing,
    });
  }
  const challenge =
    input.challenge || randomBytes(32).toString("hex");
  if (!/^[a-f0-9]{64}$/.test(challenge)) {
    return emptyReport({
      config: input.config,
      blockers: ["VELVET_CONNECTION_PROOF_CHALLENGE"],
    });
  }
  const fetchImpl = input.fetchImpl || fetch;
  try {
    const [sourceBody, outcomeBody] = await Promise.all([
      requestConnectionProof({
        config: input.config,
        apiKey: input.config.researchApiKey,
        challenge,
        fetchImpl,
        signal: input.signal,
      }),
      requestConnectionProof({
        config: input.config,
        apiKey: input.config.outcomeApiKey,
        challenge,
        fetchImpl,
        signal: input.signal,
      }),
    ]);
    return verifyVelvetConnectionProofResponses({
      sourceBody,
      outcomeBody,
      config: input.config,
      challenge,
    });
  } catch {
    return emptyReport({
      config: input.config,
      requestsPerformed: 2,
      blockers: ["VELVET_CONNECTION_PROOF_REMOTE_FAILED"],
    });
  }
}
