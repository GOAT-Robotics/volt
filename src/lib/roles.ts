export const ROLES = ["ADMIN", "OWNER", "DESIGNER", "REVIEWER", "APPROVER", "SIGNATORY", "VIEWER", "GUEST"] as const;
export type BuiltinRole = (typeof ROLES)[number];
/** a built-in role, or an admin-defined custom role ("custom:<id>", see lib/customroles) */
export type Role = BuiltinRole | `custom:${string}`;
export const isCustomRole = (r: string): r is `custom:${string}` => /^custom:[a-z0-9]{6,40}$/.test(r);
export const customRoleToken = (id: string) => `custom:${id}` as const;
export const ROLE_LABEL: Record<BuiltinRole, string> = {
  ADMIN: "Workspace admin",
  OWNER: "Owner",
  DESIGNER: "Designer",
  REVIEWER: "Reviewer",
  APPROVER: "Approver",
  SIGNATORY: "Signatory",
  VIEWER: "Viewer",
  GUEST: "Guest reviewer",
};
export const ROLE_DESCRIPTION: Record<BuiltinRole, string> = {
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
  (s ?? "")
    .split(",")
    .map((r) => r.trim())
    .map((r) => (isCustomRole(r) ? r : r.toUpperCase()))
    .filter((r): r is Role => isCustomRole(r) || (ROLES as readonly string[]).includes(r));
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
  | "library.approve"
  /** browse and place components from the organization library (only checked for external users) */
  | "library.view";

/** Role → allowed actions. These roles are assigned once at workspace level. */
export const ROLE_ACTIONS: Record<BuiltinRole, Action[]> = {
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
  return roles.some((r) => (isCustomRole(r) ? customActions.get(r.slice(7)) : ROLE_ACTIONS[r])?.includes(a));
}

/* ------------------------------------------------------------------ */
/* Custom roles                                                        */
/* ------------------------------------------------------------------ */

/**
 * What a custom role may grant. Never: workspace administration, creating projects, publishing or
 * approving library content — custom roles are for people outside the organization, who work
 * only on the projects they are assigned to.
 */
export const CUSTOM_ROLE_ACTIONS: { id: Action; label: string; hint: string }[] = [
  { id: "project.view", label: "Open assigned projects", hint: "See drawings, versions and documents of the projects they are assigned to" },
  { id: "project.edit", label: "Edit drawings", hint: "Change working versions" },
  { id: "project.export", label: "Export", hint: "PDF, DXF, QElectroTech, wire lists, BOM" },
  { id: "review.comment", label: "Comment", hint: "Comment on drawings and reviews" },
  { id: "review.decide", label: "Review", hint: "Request changes or reject in reviews they are assigned to" },
  { id: "review.approve", label: "Approve", hint: "Give the formal approval" },
  { id: "project.manage", label: "Manage project", hint: "Start versions, submit for review, project settings" },
  { id: "signature.request", label: "Request signatures", hint: "" },
  { id: "sign", label: "Sign", hint: "Electronic signature on approved versions" },
  { id: "library.view", label: "Use the component library", hint: "Browse and place organization components (without: only what is already in their projects)" },
];
export const CUSTOM_ALLOWED = new Set<Action>(CUSTOM_ROLE_ACTIONS.map((a) => a.id));

/** custom role id → actions; filled by lib/customroles (server) on every request */
const customActions = new Map<string, Action[]>();
export function setCustomRoleActions(list: { id: string; actions: string }[]) {
  customActions.clear();
  for (const r of list) customActions.set(r.id, r.actions.split(",").map((a) => a.trim()).filter((a): a is Action => CUSTOM_ALLOWED.has(a as Action)));
}
