export const ROLES = ["ADMIN", "OWNER", "DESIGNER", "REVIEWER", "APPROVER", "SIGNATORY", "VIEWER", "GUEST"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Workspace admin",
  OWNER: "Owner",
  DESIGNER: "Designer",
  REVIEWER: "Reviewer",
  APPROVER: "Approver",
  SIGNATORY: "Signatory",
  VIEWER: "Viewer",
  GUEST: "Guest reviewer",
};
export const ROLE_DESCRIPTION: Record<Role, string> = {
  ADMIN: "Full workspace administration, including members, settings, projects, reviews, approvals and signatures.",
  OWNER: "Creates and manages projects they belong to, including members, versions, submission and signature requests; cannot approve or sign without another role.",
  DESIGNER: "Creates and edits projects they belong to; can submit for review and approval, request signatures, comment, export and publish library content.",
  REVIEWER: "Reviews assigned work, comments, requests changes or rejects; cannot give the formal approval.",
  APPROVER: "Performs review decisions and gives the formal approval that counts toward the approval policy.",
  SIGNATORY: "Applies an attributable electronic signature to an approved version before release.",
  VIEWER: "Read-only project access with export permission; cannot comment, edit, review, approve or sign.",
  GUEST: "External or limited reviewer who can comment only on specifically shared work.",
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
  | "signature.request"
  | "sign"
  | "library.publish"
  | "library.approve";

/** Role → allowed actions. These roles are assigned once at workspace level. */
export const ROLE_ACTIONS: Record<Role, Action[]> = {
  ADMIN: ["workspace.admin", "project.create", "project.view", "project.edit", "project.manage", "project.export", "review.comment", "review.decide", "review.approve", "signature.request", "sign", "library.publish", "library.approve"],
  OWNER: ["project.create", "project.view", "project.edit", "project.manage", "project.export", "review.comment", "signature.request", "library.publish"],
  DESIGNER: ["project.create", "project.view", "project.edit", "project.export", "review.comment", "signature.request", "library.publish"],
  REVIEWER: ["project.view", "project.export", "review.comment", "review.decide"],
  APPROVER: ["project.view", "project.export", "review.comment", "review.decide", "review.approve"],
  SIGNATORY: ["project.view", "project.export", "review.comment", "sign"],
  VIEWER: ["project.view", "project.export"],
  GUEST: ["review.comment"],
};

export function rolesAllow(roles: Role[], a: Action): boolean {
  return roles.some((r) => ROLE_ACTIONS[r]?.includes(a));
}
