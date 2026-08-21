import { describe, expect, it } from "vitest";
import { resolveOperatorAdminEmails } from "./operator-identity.js";

describe("resolveOperatorAdminEmails", () => {
  it("grants full operator eligibility to the verified owner identity across supported login contexts", () => {
    expect(resolveOperatorAdminEmails({
      googleAdminEmails: "ops@smirkcalls.com",
      extraOperatorEmails: "cam@smirkcalls.com, OPS@smirkcalls.com",
      ownerEmail: "cam@smirkcalls.com",
    })).toEqual(["ops@smirkcalls.com", "cam@smirkcalls.com"]);
  });

  it("does not promote placeholder owner values to operator access", () => {
    expect(resolveOperatorAdminEmails({
      googleAdminEmails: "owner@example.com",
      extraOperatorEmails: "admin@example.com",
      ownerEmail: "OWNER@example.com",
    })).toEqual([]);
  });
});
