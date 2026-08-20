import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  readVelvetRemoteConnectionProofConfig,
  verifyRemoteVelvetConnectionProof,
  verifyVelvetConnectionProofResponses,
  type VelvetConnectionProofResponse,
} from "../src/velvet-connection-proof.ts";

const signingSecret = `connection-proof-${"s".repeat(32)}`;
const challenge = "a".repeat(64);

function configuredEnv(): Record<string, string> {
  return {
    VELVET_LEAD_SOURCE_BASE_URL:
      "https://velvetalchemy.manus.space",
    VELVET_LEAD_SOURCE_API_KEY: `research-${"r".repeat(32)}`,
    VELVET_LEAD_SOURCE_WORKSPACE_ID: "7",
    VELVET_BASE_URL: "https://velvetalchemy.manus.space",
    VELVET_OUTCOME_API_KEY: `outcome-${"o".repeat(32)}`,
    VELVET_OUTCOME_SIGNING_SECRET: signingSecret,
    VELVET_OUTCOME_WORKSPACE_ID: "7",
  };
}

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

function response(input: {
  role: "research" | "outcome";
  ownerBinding?: string;
  credentialBinding?: string;
  workspaceId?: number;
  challenge?: string;
  secret?: string;
}): VelvetConnectionProofResponse {
  const unsigned = {
    contractVersion: "velvet-smirk.connection-proof.v1" as const,
    workspaceId: input.workspaceId ?? 7,
    challenge: input.challenge ?? challenge,
    credentialRole: input.role,
    ownerBinding: input.ownerBinding ?? "b".repeat(64),
    credentialBinding:
      input.credentialBinding ??
      (input.role === "research"
        ? "c".repeat(64)
        : "d".repeat(64)),
    checks: {
      exactDedicatedScope: true as const,
      privilegedOwner: true as const,
      workspaceBound: true as const,
      signingSecretConfigured: true as const,
    },
    guardrails: {
      contactAuthorized: false as const,
      spendAuthorized: false as const,
      providerRequestPerformed: false as const,
      databaseMutationPerformed: false as const,
    },
    externalAction: "none" as const,
  };
  return {
    ...unsigned,
    proof: createHmac("sha256", input.secret ?? signingSecret)
      .update(
        `velvet-smirk.connection-proof.response.v1\0${canonicalJson(
          unsigned
        )}`
      )
      .digest("hex"),
  };
}

test("two read-only challenges prove exact keys, owner, workspace, and signing secret", async () => {
  const env = configuredEnv();
  const config = readVelvetRemoteConnectionProofConfig(env);
  assert.equal(config.configured, true);
  const requests: Array<{
    url: string;
    authorization: string;
    method: string;
    redirect: RequestRedirect | undefined;
    cache: RequestCache | undefined;
  }> = [];
  const report = await verifyRemoteVelvetConnectionProof({
    config,
    challenge,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const authorization = String(
        new Headers(init?.headers).get("authorization") || ""
      );
      requests.push({
        url: url.toString(),
        authorization,
        method: String(init?.method),
        redirect: init?.redirect,
        cache: init?.cache,
      });
      const role = authorization.includes(
        env.VELVET_LEAD_SOURCE_API_KEY
      )
        ? "research"
        : "outcome";
      return new Response(JSON.stringify(response({ role })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.requestsPerformed, 2);
  assert.deepEqual(report.checks, {
    sourceKeyAuthenticated: true,
    outcomeKeyAuthenticated: true,
    exactDedicatedScopes: true,
    sameAdminOwner: true,
    credentialsDistinct: true,
    signingSecretMatched: true,
    workspaceAligned: true,
    remoteNoMutationClaimed: true,
  });
  assert.equal(requests.length, 2);
  for (const request of requests) {
    const url = new URL(request.url);
    assert.equal(url.origin, "https://velvetalchemy.manus.space");
    assert.equal(url.pathname, "/api/v1/smirk/connection-proof");
    assert.equal(url.searchParams.get("workspaceId"), "7");
    assert.equal(url.searchParams.get("challenge"), challenge);
    assert.equal(request.method, "GET");
    assert.equal(request.redirect, "manual");
    assert.equal(request.cache, "no-store");
  }
  const serialized = JSON.stringify(report);
  for (const secret of [
    env.VELVET_LEAD_SOURCE_API_KEY,
    env.VELVET_OUTCOME_API_KEY,
    env.VELVET_OUTCOME_SIGNING_SECRET,
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("owner drift, credential reuse, signature mismatch, and workspace drift fail closed", () => {
  const config = readVelvetRemoteConnectionProofConfig(
    configuredEnv()
  );
  const source = response({ role: "research" });

  const ownerDrift = verifyVelvetConnectionProofResponses({
    sourceBody: source,
    outcomeBody: response({
      role: "outcome",
      ownerBinding: "e".repeat(64),
    }),
    config,
    challenge,
  });
  assert.equal(ownerDrift.ok, false);
  assert.ok(
    ownerDrift.blockers.includes(
      "VELVET_CONNECTION_PROOF_OWNER_ALIGNMENT"
    )
  );

  const credentialReuse =
    verifyVelvetConnectionProofResponses({
      sourceBody: source,
      outcomeBody: response({
        role: "outcome",
        credentialBinding: source.credentialBinding,
      }),
      config,
      challenge,
    });
  assert.equal(credentialReuse.ok, false);
  assert.ok(
    credentialReuse.blockers.includes(
      "VELVET_CONNECTION_PROOF_KEY_SEPARATION"
    )
  );

  const wrongSecret = verifyVelvetConnectionProofResponses({
    sourceBody: source,
    outcomeBody: response({
      role: "outcome",
      secret: `wrong-${"w".repeat(32)}`,
    }),
    config,
    challenge,
  });
  assert.equal(wrongSecret.ok, false);
  assert.ok(
    wrongSecret.blockers.includes(
      "VELVET_CONNECTION_PROOF_SIGNING_SECRET"
    )
  );

  const workspaceDrift =
    verifyVelvetConnectionProofResponses({
      sourceBody: source,
      outcomeBody: response({
        role: "outcome",
        workspaceId: 8,
      }),
      config,
      challenge,
    });
  assert.equal(workspaceDrift.ok, false);
  assert.ok(
    workspaceDrift.blockers.includes(
      "VELVET_CONNECTION_PROOF_WORKSPACE"
    )
  );
});

test("missing local authority performs no request and remote failure stays redacted", async () => {
  let requests = 0;
  const missing = await verifyRemoteVelvetConnectionProof({
    config: readVelvetRemoteConnectionProofConfig({}),
    fetchImpl: async () => {
      requests += 1;
      throw new Error("must not run");
    },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.requestsPerformed, 0);
  assert.equal(requests, 0);

  const configured = configuredEnv();
  const failed = await verifyRemoteVelvetConnectionProof({
    config: readVelvetRemoteConnectionProofConfig(configured),
    challenge,
    fetchImpl: async () => {
      requests += 1;
      return new Response("forged provider body", {
        status: 503,
      });
    },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.requestsPerformed, 2);
  assert.deepEqual(failed.blockers, [
    "VELVET_CONNECTION_PROOF_REMOTE_FAILED",
  ]);
  const serialized = JSON.stringify(failed);
  assert.equal(
    serialized.includes(configured.VELVET_LEAD_SOURCE_API_KEY),
    false
  );
  assert.equal(
    serialized.includes(configured.VELVET_OUTCOME_API_KEY),
    false
  );
});

test("non-canonical origin, reused credentials, and workspace drift stop before network", async () => {
  const invalidEnvironments = [
    {
      ...configuredEnv(),
      VELVET_BASE_URL: "http://velvetalchemy.manus.space",
    },
    {
      ...configuredEnv(),
      VELVET_LEAD_SOURCE_BASE_URL:
        "https://velvetalchemy.manus.space/api",
    },
    {
      ...configuredEnv(),
      VELVET_OUTCOME_API_KEY:
        configuredEnv().VELVET_LEAD_SOURCE_API_KEY,
    },
    {
      ...configuredEnv(),
      VELVET_OUTCOME_WORKSPACE_ID: "8",
    },
  ];
  let requests = 0;
  for (const env of invalidEnvironments) {
    const report = await verifyRemoteVelvetConnectionProof({
      config: readVelvetRemoteConnectionProofConfig(env),
      fetchImpl: async () => {
        requests += 1;
        throw new Error("must not run");
      },
    });
    assert.equal(report.ok, false);
    assert.equal(report.requestsPerformed, 0);
  }
  assert.equal(requests, 0);
});

test("oversized remote responses fail closed without returning body data", async () => {
  const marker = `sensitive-${"x".repeat(17_000)}`;
  const report = await verifyRemoteVelvetConnectionProof({
    config: readVelvetRemoteConnectionProofConfig(configuredEnv()),
    challenge,
    fetchImpl: async () =>
      new Response(marker, {
        status: 200,
        headers: {
          "content-length": String(Buffer.byteLength(marker)),
        },
      }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.requestsPerformed, 2);
  assert.deepEqual(report.blockers, [
    "VELVET_CONNECTION_PROOF_REMOTE_FAILED",
  ]);
  assert.equal(JSON.stringify(report).includes(marker), false);
});
