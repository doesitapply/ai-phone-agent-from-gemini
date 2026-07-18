#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { resolveChatWorkspace } from "../src/chat-route-security.js";

const fixtures = [
  {
    name: "workspace auth ignores a cross-tenant body workspace",
    input: { authMode: "workspace" as const, authenticatedWorkspaceId: 7, requestedWorkspaceId: 999 },
    expected: { ok: true, workspaceId: 7 },
  },
  {
    name: "workspace auth ignores an invalid body workspace",
    input: { authMode: "workspace" as const, authenticatedWorkspaceId: 7, requestedWorkspaceId: "999" },
    expected: { ok: true, workspaceId: 7 },
  },
  {
    name: "demo operator cannot select a body workspace",
    input: { authMode: "demo_operator" as const, authenticatedWorkspaceId: 11, requestedWorkspaceId: 999 },
    expected: { ok: true, workspaceId: 11 },
  },
  {
    name: "operator may select a validated body workspace",
    input: { authMode: "operator" as const, authenticatedWorkspaceId: 1, requestedWorkspaceId: 999 },
    expected: { ok: true, workspaceId: 999 },
  },
  {
    name: "operator defaults to authenticated request workspace",
    input: { authMode: "operator" as const, authenticatedWorkspaceId: 13, requestedWorkspaceId: undefined },
    expected: { ok: true, workspaceId: 13 },
  },
  {
    name: "operator string workspace is rejected",
    input: { authMode: "operator" as const, authenticatedWorkspaceId: 1, requestedWorkspaceId: "999" },
    expected: { ok: false, code: "INVALID_CHAT_WORKSPACE_ID" },
  },
  {
    name: "operator zero workspace is rejected",
    input: { authMode: "operator" as const, authenticatedWorkspaceId: 1, requestedWorkspaceId: 0 },
    expected: { ok: false, code: "INVALID_CHAT_WORKSPACE_ID" },
  },
  {
    name: "operator fractional workspace is rejected",
    input: { authMode: "operator" as const, authenticatedWorkspaceId: 1, requestedWorkspaceId: 4.2 },
    expected: { ok: false, code: "INVALID_CHAT_WORKSPACE_ID" },
  },
];

for (const fixture of fixtures) {
  assert.deepEqual(resolveChatWorkspace(fixture.input), fixture.expected, fixture.name);
}

console.log(`PASS chat route security fixtures (${fixtures.length})`);
