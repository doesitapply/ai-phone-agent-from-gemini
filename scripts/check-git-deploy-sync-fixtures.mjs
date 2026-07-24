#!/usr/bin/env node
import assert from "node:assert/strict";
import { analyzeDeployRemoteSync, classifyGitRemoteSync } from "./lib/git-deploy-sync.mjs";

assert.equal(classifyGitRemoteSync({ localCommit: "a", remoteCommit: "a", mergeBase: "a" }), "current");
assert.equal(classifyGitRemoteSync({ localCommit: "b", remoteCommit: "a", mergeBase: "a" }), "ahead");
assert.equal(classifyGitRemoteSync({ localCommit: "a", remoteCommit: "b", mergeBase: "a" }), "behind");
assert.equal(classifyGitRemoteSync({ localCommit: "b", remoteCommit: "c", mergeBase: "a" }), "diverged");
assert.equal(classifyGitRemoteSync({ localCommit: "b", remoteCommit: null, mergeBase: null }), "unknown");

function analyze({ branch, head, commits, bases }) {
  return analyzeDeployRemoteSync({
    localBranch: branch,
    localCommit: head,
    resolveRemoteCommit: (remoteRef) => commits[remoteRef] || null,
    resolveMergeBase: (_localCommit, remoteRef) => bases[remoteRef] || null,
  });
}

const featureRace = analyze({
  branch: "codex/market-validation-launch",
  head: "local",
  commits: {
    "origin/main": "base",
    "origin/codex/market-validation-launch": "daily-ledger",
  },
  bases: {
    "origin/main": "base",
    "origin/codex/market-validation-launch": "base",
  },
});
assert.equal(featureRace.approvalRequired, true);
assert.equal(featureRace.gitRemoteSync, "diverged");
assert.equal(featureRace.remoteRef, "origin/codex/market-validation-launch");
assert.equal(featureRace.remoteName, "origin");
assert.equal(featureRace.remoteBranch, "codex/market-validation-launch");

const ordinaryAhead = analyze({
  branch: "codex/market-validation-launch",
  head: "local",
  commits: {
    "origin/main": "base",
    "origin/codex/market-validation-launch": "base",
  },
  bases: {
    "origin/main": "base",
    "origin/codex/market-validation-launch": "base",
  },
});
assert.equal(ordinaryAhead.approvalRequired, false);
assert.equal(ordinaryAhead.gitRemoteSync, "ahead");

const mainBehind = analyze({
  branch: "main",
  head: "local",
  commits: { "origin/main": "remote" },
  bases: { "origin/main": "local" },
});
assert.equal(mainBehind.approvalRequired, true);
assert.equal(mainBehind.remoteRef, "origin/main");
assert.equal(mainBehind.gitRemoteSync, "behind");

const missingFeatureRemote = analyze({
  branch: "codex/new-branch",
  head: "local",
  commits: { "origin/main": "base" },
  bases: { "origin/main": "base" },
});
assert.equal(missingFeatureRemote.approvalRequired, false);
assert.equal(missingFeatureRemote.gitRemoteSync, "ahead");
assert.deepEqual(missingFeatureRemote.remotes.map(({ remoteRef }) => remoteRef), ["origin/main"]);

console.log("OK deploy sync analysis fails closed on a divergent deploy-branch remote and preserves ordinary ahead states");
