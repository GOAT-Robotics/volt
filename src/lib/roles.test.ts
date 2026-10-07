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

import { CUSTOM_ALLOWED, isCustomRole, parseRoles as parse2, rolesAllow as allow2, setCustomRoleActions } from "./roles";

describe("custom roles", () => {
  it("keeps custom role tokens when parsing, drops junk", () => {
    expect(parse2("custom:clx123abc, designer, custom:BAD!, nonsense")).toEqual(["custom:clx123abc", "DESIGNER"]);
    expect(isCustomRole("custom:clx123abc")).toBe(true);
  });
  it("grants exactly the role's actions, never admin / project creation / library publishing", () => {
    setCustomRoleActions([{ id: "clx123abc", actions: "project.view,project.edit,workspace.admin,project.create,library.publish,library.view" }]);
    expect(allow2(["custom:clx123abc"], "project.edit")).toBe(true);
    expect(allow2(["custom:clx123abc"], "library.view")).toBe(true);
    expect(allow2(["custom:clx123abc"], "review.approve")).toBe(false);
    expect(allow2(["custom:clx123abc"], "workspace.admin")).toBe(false);
    expect(allow2(["custom:clx123abc"], "project.create")).toBe(false);
    expect(allow2(["custom:clx123abc"], "library.publish")).toBe(false);
    expect([...CUSTOM_ALLOWED]).not.toContain("workspace.admin");
  });
  it("a deleted or unknown custom role grants nothing", () => {
    setCustomRoleActions([]);
    expect(allow2(["custom:clx123abc"], "project.view")).toBe(false);
  });
});
