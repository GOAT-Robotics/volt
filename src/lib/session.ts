import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { auth } from "@/auth";
import { db } from "./db";
import { parseRoles, rolesAllow, type Action, type Role } from "./roles";
import { parseSettings, type WorkspaceSettings } from "./settings";
import { ensureDefaultWorkspace } from "./membership";
import { loadCustomRoles } from "./customroles";
import { setBrand } from "@/core/brand";

export type Ctx = {
  user: { id: string; name: string; email: string; isGuest: boolean; groups: string[]; /** external partner (magic-link sign-in, assigned projects only) */ external: boolean };
  workspace: { id: string; name: string; slug: string };
  settings: WorkspaceSettings;
  roles: Role[];
  /** Member of at least one project. Project membership scopes access; it does not grant roles. */
  projectAccess: boolean;
  authTime: number;
  workspaces: { id: string; name: string; slug: string }[];
};

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

/** Current user context, or null. Cached per request. */
export const getCtx = cache(async (): Promise<Ctx | null> => {
  const s = await auth();
  if (!s?.uid) return null;
  const user = await db.user.findUnique({ where: { id: s.uid } });
  if (!user || user.disabled) return null;
  // external access ends at its end date, also for sessions that are still open
  if (user.external && user.accessUntil && user.accessUntil.getTime() < Date.now()) return null;
  await ensureDefaultWorkspace();
  await loadCustomRoles();
  const mems = await db.membership.findMany({ where: { userId: user.id }, include: { workspace: true }, orderBy: { createdAt: "asc" } });
  const jar = await cookies();
  const wanted = jar.get("volt_ws")?.value;
  let mem = mems.find((m) => m.workspaceId === wanted) ?? mems[0];
  const projectAccess = (await db.projectMember.count({ where: { userId: user.id } })) > 0;
  let workspace = mem?.workspace;
  if (!workspace) {
    // guest with project-level invites only
    const pm = await db.projectMember.findFirst({ where: { userId: user.id }, include: { project: { include: { workspace: true } } } });
    if (!pm) return null;
    workspace = pm.project.workspace;
  }
  const settings = parseSettings(workspace.settings);
  // server-side renders (canonical / release PDFs, previews) draw this workspace's logo
  setBrand(settings.branding);
  return {
    user: { id: user.id, name: user.name, email: user.email, isGuest: user.isGuest, groups: JSON.parse(user.groups || "[]"), external: user.external },
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
    settings,
    roles: mem ? parseRoles(mem.roles) : ["GUEST"],
    projectAccess,
    authTime: s.authTime,
    workspaces: mems.map((m) => ({ id: m.workspace.id, name: m.workspace.name, slug: m.workspace.slug })),
  };
});

export async function requireCtx(): Promise<Ctx> {
  const c = await getCtx();
  if (!c) {
    // back to the same page after sign-in (and link previews can describe it: see /login)
    const here = (await headers()).get("x-volt-path");
    redirect(here && here.startsWith("/") && !here.startsWith("//") && !here.startsWith("/login") ? `/login?callbackUrl=${encodeURIComponent(here)}` : "/login");
  }
  return c;
}

/** For route handlers: throws 401 instead of redirecting. */
export async function apiCtx(): Promise<Ctx> {
  const c = await getCtx();
  if (!c) throw new HttpError(401, "Not signed in");
  return c;
}

export function can(ctx: Ctx, a: Action): boolean {
  return rolesAllow(ctx.roles, a);
}

export function assertCan(ctx: Ctx, a: Action) {
  if (!can(ctx, a)) throw new HttpError(403, `Not permitted: ${a}`);
}

/**
 * Loads a project using project membership as the scope boundary and workspace roles as the
 * permission source. Workspace admins may access every project in their workspace.
 */
export async function loadProject(ctx: Ctx, projectId: string) {
  const project = await db.project.findUnique({ where: { id: projectId }, include: { members: true } });
  if (!project) throw new HttpError(404, "Project not found");
  const pm = project.members.find((m) => m.userId === ctx.user.id);
  const inWorkspace = project.workspaceId === ctx.workspace.id;
  const admin = inWorkspace && ctx.roles.includes("ADMIN");
  if (!inWorkspace || (!admin && !pm)) throw new HttpError(404, "Project not found");
  const roles: Role[] = ctx.roles;
  return { project, projectRoles: roles, inWorkspace, can: (a: Action) => rolesAllow(roles, a) };
}
