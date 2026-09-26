import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { db } from "./db";
import { parseRoles, rolesAllow, type Action, type Role } from "./roles";
import { parseSettings, type WorkspaceSettings } from "./settings";
import { ensureDefaultWorkspace } from "./membership";

export type Ctx = {
  user: { id: string; name: string; email: string; isGuest: boolean; groups: string[] };
  workspace: { id: string; name: string; slug: string };
  settings: WorkspaceSettings;
  roles: Role[];
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
  await ensureDefaultWorkspace();
  const mems = await db.membership.findMany({ where: { userId: user.id }, include: { workspace: true }, orderBy: { createdAt: "asc" } });
  const jar = await cookies();
  const wanted = jar.get("volt_ws")?.value;
  let mem = mems.find((m) => m.workspaceId === wanted) ?? mems[0];
  let workspace = mem?.workspace;
  if (!workspace) {
    // guest with project-level invites only
    const pm = await db.projectMember.findFirst({ where: { userId: user.id }, include: { project: { include: { workspace: true } } } });
    if (!pm) return null;
    workspace = pm.project.workspace;
  }
  return {
    user: { id: user.id, name: user.name, email: user.email, isGuest: user.isGuest, groups: JSON.parse(user.groups || "[]") },
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
    settings: parseSettings(workspace.settings),
    roles: mem ? parseRoles(mem.roles) : ["GUEST"],
    authTime: s.authTime,
    workspaces: mems.map((m) => ({ id: m.workspace.id, name: m.workspace.name, slug: m.workspace.slug })),
  };
});

export async function requireCtx(): Promise<Ctx> {
  const c = await getCtx();
  if (!c) redirect("/login");
  return c;
}

/** For route handlers: throws 401 instead of redirecting. */
export async function apiCtx(): Promise<Ctx> {
  const c = await getCtx();
  if (!c) throw new HttpError(401, "Not signed in");
  return c;
}

export function can(ctx: Ctx, a: Action, projectRoles: Role[] = []): boolean {
  return rolesAllow([...ctx.roles, ...projectRoles], a);
}

export function assertCan(ctx: Ctx, a: Action, projectRoles: Role[] = []) {
  if (!can(ctx, a, projectRoles)) throw new HttpError(403, `Not permitted: ${a}`);
}

/** Loads a project in the ctx workspace (or one the user is invited to) + effective project roles. */
export async function loadProject(ctx: Ctx, projectId: string) {
  const project = await db.project.findUnique({ where: { id: projectId }, include: { members: true } });
  if (!project) throw new HttpError(404, "Project not found");
  const pm = project.members.find((m) => m.userId === ctx.user.id);
  const projectRoles = pm ? parseRoles(pm.roles) : [];
  const inWorkspace = project.workspaceId === ctx.workspace.id && ctx.roles.length > 0 && !(ctx.roles.length === 1 && ctx.roles[0] === "GUEST");
  if (!inWorkspace && !pm) throw new HttpError(404, "Project not found");
  const roles = inWorkspace ? projectRoles : projectRoles;
  return { project, projectRoles: roles, can: (a: Action) => can(ctx, a, roles) || (!inWorkspace && rolesAllow(roles, a)) };
}
