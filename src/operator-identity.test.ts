import assert from "node:assert/strict";
import test from "node:test";
import { resolveOperatorAdminEmails } from "./operator-identity.js";

test("grants full operator eligibility to the verified owner identity across supported login contexts", () => {
  assert.deepEqual(resolveOperatorAdminEmails({
    googleAdminEmails: "ops@smirkcalls.com",
    extraOperatorEmails: "cam@smirkcalls.com, OPS@smirkcalls.com",
    ownerEmail: "cam@smirkcalls.com",
  }), ["ops@smirkcalls.com", "cam@smirkcalls.com"]);
});

test("does not promote placeholder owner values to operator access", () => {
  assert.deepEqual(resolveOperatorAdminEmails({
    googleAdminEmails: "owner@example.com",
    extraOperatorEmails: "admin@example.com",
    ownerEmail: "OWNER@example.com",
  }), []);
});
