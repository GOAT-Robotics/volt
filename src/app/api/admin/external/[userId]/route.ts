import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertAdmin } from "@/lib/access";
import { assertRole, roleTokenFor, setProjects } from "@/lib/external";

export const runtime = "nodejs";

async function externalMember(workspaceId: string, userId: string) {
  const m = await db.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, include: { user: true } });
  if (!m || !m.user.external) throw new HttpError(404, "External user not found");
  return m;
}

const Body = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  company: z.string().trim().max(120).optional(),
  roleId: z.string().min(1).optional(),
  projectIds: z.array(z.string()).max(200).optional(),
  accessUntil: z.string().datetime().nullable().optional(),
  disabled: z.boolean().optional(),
});

export const PATCH = route<{ userId: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const { userId } = await params;
  const m = await externalMember(ctx.workspace.id, userId);
  const b = await body(req, Body);
  const changes: Record<string, unknown> = {};
  if (b.roleId) {
    const role = await assertRole(ctx.workspace.id, b.roleId);
    await db.membership.update({ where: { id: m.id }, data: { roles: roleTokenFor(role.id) } });
    changes.role = role.name;
  }
  if (b.projectIds) {
    const pr = await setProjects(ctx.workspace.id, userId, b.projectIds);
    changes.projects = pr.names;
  }
  const until = b.accessUntil === undefined ? undefined : b.accessUntil ? new Date(b.accessUntil) : null;
  await db.user.update({ where: { id: userId }, data: { name: b.name, company: b.company, accessUntil: until, disabled: b.disabled } });
  // disabling ends the account's unused links at once
  if (b.disabled) await db.loginToken.deleteMany({ where: { userId, usedAt: null } });
  Object.assign(changes, { name: b.name, company: b.company, accessUntil: until === undefined ? undefined : until?.toISOString() ?? null, disabled: b.disabled });
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "admin.external", data: { action: "update", user: m.user.email, ...changes } });
  return { ok: true };
});

/** Removes the partner's access to this workspace (the account stays for the audit trail and their comments). */
export const DELETE = route<{ userId: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const { userId } = await params;
  const m = await externalMember(ctx.workspace.id, userId);
  await db.projectMember.deleteMany({ where: { userId, project: { workspaceId: ctx.workspace.id } } });
  await db.membership.delete({ where: { id: m.id } });
  if (!(await db.membership.count({ where: { userId } }))) await db.user.update({ where: { id: userId }, data: { disabled: true } });
  await db.loginToken.deleteMany({ where: { userId, usedAt: null } });
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "admin.external", data: { action: "remove", user: m.user.email } });
  return { ok: true };
});
