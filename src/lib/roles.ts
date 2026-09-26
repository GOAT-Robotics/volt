export const ROLES = ["ADMIN", "OWNER", "DESIGNER", "REVIEWER", "APPROVER", "SIGNATORY", "VIEWER", "GUEST"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Workspace admin",
  OWNER: "Project owner",
  DESIGNER: "Designer",
  REVIEWER: "Reviewer",
  APPROVER: "Approver",
  SIGNATORY: "Signatory",
  VIEWER: "Viewer",
  GUEST: "Guest reviewer",
};
export const parseRoles = (s: string | null | undefined): Role[] =>
  (s ?? "").split(",").map((r) => r.trim().toUpperCase()).filter((r): r is Role => (ROLES as readonly string[]).includes(r));
export const joinRoles = (r: Iterable<string>) => [...new Set(r)].join(",");

export type Action =
  | "workspace.admin"
  | "project.create"
  | "project.view"
  | "project.edit" // edit working versions
  | "project.manage" // members, settings, start version, submit
  | "project.export"
  | "review.comment"
  | "review.decide"
  | "review.approve"
  | "sign"
  | "library.publish"
  | "library.approve";

/** Role → allowed actions. Workspace roles apply to every project; project roles add on top. */
export const ROLE_ACTIONS: Record<Role, Action[]> = {
  ADMIN: ["workspace.admin", "project.create", "project.view", "project.edit", "project.manage", "project.export", "review.comment", "review.decide", "review.approve", "sign", "library.publish", "library.approve"],
  OWNER: ["project.create", "project.view", "project.edit", "project.manage", "project.export", "review.comment", "library.publish"],
  DESIGNER: ["project.create", "project.view", "project.edit", "project.export", "review.comment", "library.publish"],
  REVIEWER: ["project.view", "project.export", "review.comment", "review.decide"],
  APPROVER: ["project.view", "project.export", "review.comment", "review.decide", "review.approve"],
  SIGNATORY: ["project.view", "project.export", "review.comment", "sign"],
  VIEWER: ["project.view", "project.export"],
  GUEST: ["review.comment"],
};

export function rolesAllow(roles: Role[], a: Action): boolean {
  return roles.some((r) => ROLE_ACTIONS[r]?.includes(a));
}
