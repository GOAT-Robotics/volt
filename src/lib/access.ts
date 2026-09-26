import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { HttpError, type Ctx } from "./session";
import { parseRoles, rolesAllow, type Action, type Role } from "./roles";

/** True when the user only has guest access (no real workspace role). */
export function isGuestCtx(ctx: Ctx): boolean {
  return ctx.user.isGuest || ctx.roles.length === 0 || (ctx.roles.length === 1 && ctx.roles[0] === "GUEST");
}

export function isAdmin(ctx: Ctx): boolean {
  return ctx.roles.includes("ADMIN");
}

export function assertAdmin(ctx: Ctx) {
  if (!isAdmin(ctx)) throw new HttpError(403, "Administrator access required");
}

/** Prisma filter: projects this user may see (workspace projects for members; only invited projects for guests). */
export function projectScope(ctx: Ctx): Prisma.ProjectWhereInput {
  if (isGuestCtx(ctx)) return { members: { some: { userId: ctx.user.id } } };
  return { workspaceId: ctx.workspace.id };
}

/** Effective roles of an arbitrary user for a project (workspace membership + project roles). */
export async function userRolesFor(userId: string, workspaceId: string, projectId?: string): Promise<Role[]> {
  const [mem, pm] = await Promise.all([
    db.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } }),
    projectId ? db.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } }) : null,
  ]);
  return [...parseRoles(mem?.roles), ...parseRoles(pm?.roles)];
}

export async function userCan(userId: string, workspaceId: string, projectId: string | undefined, a: Action) {
  return rolesAllow(await userRolesFor(userId, workspaceId, projectId), a);
}

/** Users that belong to an Entra group (as of their last sign-in). */
export async function usersInGroup(groupId: string): Promise<string[]> {
  const users = await db.user.findMany({ where: { disabled: false, groups: { contains: `"${groupId.replace(/"/g, "")}"` } }, select: { id: true } });
  return users.map((u) => u.id);
}

/** Request metadata for evidence / audit. */
export function reqMeta(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? null;
  return { ip, userAgent: req.headers.get("user-agent") ?? "" };
}

export function baseUrl(req?: Request): string {
  const env = process.env.APP_URL ?? process.env.AUTH_URL;
  if (env) return env.replace(/\/$/, "");
  if (req) {
    const u = new URL(req.url);
    return `${u.protocol}//${u.host}`;
  }
  return "";
}

/** Project managers (OWNER project role or workspace manage role) — used for notifications. */
export async function projectManagers(projectId: string, workspaceId: string): Promise<string[]> {
  const [pms, mems] = await Promise.all([
    db.projectMember.findMany({ where: { projectId } }),
    db.membership.findMany({ where: { workspaceId }, include: { user: { select: { disabled: true } } } }),
  ]);
  const ids = new Set<string>();
  for (const p of pms) if (rolesAllow(parseRoles(p.roles), "project.manage")) ids.add(p.userId);
  for (const m of mems) if (!m.user.disabled && parseRoles(m.roles).includes("OWNER")) ids.add(m.userId);
  return [...ids];
}

export function contentDisposition(filename: string, inline = false) {
  const safe = filename.replace(/[\r\n"]/g, "_");
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export function fileResponse(data: Uint8Array | Buffer, opts: { filename: string; type: string; inline?: boolean; cache?: string }) {
  return new Response(new Uint8Array(data), {
    headers: {
      "content-type": opts.type,
      "content-length": String(data.byteLength),
      "content-disposition": contentDisposition(opts.filename, opts.inline),
      "x-content-type-options": "nosniff",
      "cache-control": opts.cache ?? "private, no-store",
    },
  });
}
