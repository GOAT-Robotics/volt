import { describe, expect, it } from "vitest";
import { rolesAllow } from "./roles";

describe("workspace role permissions", () => {
  it("lets Designers initiate review and signature workflows without Owner powers", () => {
    expect(rolesAllow(["DESIGNER"], "project.edit")).toBe(true);
    expect(rolesAllow(["DESIGNER"], "signature.request")).toBe(true);
    expect(rolesAllow(["DESIGNER"], "project.manage")).toBe(false);
    expect(rolesAllow(["DESIGNER"], "review.approve")).toBe(false);
    expect(rolesAllow(["DESIGNER"], "sign")).toBe(false);
  });

  it("keeps signature requests available to Owners and Admins", () => {
    expect(rolesAllow(["OWNER"], "signature.request")).toBe(true);
    expect(rolesAllow(["ADMIN"], "signature.request")).toBe(true);
    expect(rolesAllow(["REVIEWER"], "signature.request")).toBe(false);
  });
});
