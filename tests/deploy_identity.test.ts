import assert from "node:assert/strict";
import test from "node:test";
import { resolveDeployIdentity } from "../src/deploy-identity.js";

test("Railway Git metadata overrides stale manual deploy stamps", () => {
  const identity = resolveDeployIdentity({
    RAILWAY_GIT_COMMIT_SHA: "56801936d737ed608a1e9012b4d1fc7d5d58d305",
    RAILWAY_GIT_BRANCH: "main",
    SMIRK_DEPLOY_VERSION: "68c0d086d4af604da6169446380dfa354c0a0eaf",
    SMIRK_DEPLOY_BRANCH: "codex/market-validation-launch",
  });

  assert.deepEqual(identity, {
    version: "56801936d737ed608a1e9012b4d1fc7d5d58d305",
    branch: "main",
  });
});

test("archive and CLI deployments retain the reviewed manual stamp fallback", () => {
  const identity = resolveDeployIdentity({
    SMIRK_DEPLOY_VERSION: "c4d1e5e5b0123456789012345678901234567890",
    SMIRK_DEPLOY_BRANCH: "codex/unified-interface-closeout-20260905",
    SOURCE_VERSION: "package-version",
    GITHUB_REF_NAME: "ambient-branch",
  });

  assert.deepEqual(identity, {
    version: "c4d1e5e5b0123456789012345678901234567890",
    branch: "codex/unified-interface-closeout-20260905",
  });
});

test("blank or partial Railway metadata falls through per field without discarding valid metadata", () => {
  assert.deepEqual(resolveDeployIdentity({
    RAILWAY_GIT_COMMIT_SHA: " current-commit ",
    RAILWAY_GIT_BRANCH: "   ",
    SMIRK_DEPLOY_VERSION: "stale-commit",
    SMIRK_DEPLOY_BRANCH: " reviewed-archive-branch ",
  }), {
    version: "current-commit",
    branch: "reviewed-archive-branch",
  });

  assert.deepEqual(resolveDeployIdentity({
    RAILWAY_GIT_COMMIT_SHA: " ",
    SMIRK_DEPLOY_VERSION: " ",
  }), {
    version: "dev",
    branch: "unknown",
  });
});
