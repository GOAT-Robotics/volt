import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError, loadProject } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { joinRoles, parseRoles } from "@/lib/roles";
import { PROJECT_ROLES } from "@/lib/constants";
import { assertGrantable, canShareProject, SHARE_DENIED } from "@/lib/access";

export const runtime = "nodejs";

async function ownersLeft(projectId: string, exceptUserId: string) {
  const rows = await db.projectMember.findMany({ where: { projectId, userId: { not: exceptUserId } } });
  return rows.filter((r) => parseRoles(r.roles).includes("OWNER")).length;
}

export const PATCH = route<{ id: string; userId: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id, userId } = await params;
  const b = await body(req, z.object({ roles: z.array(z.enum(PROJECT_ROLES)).min(1) }));
  const { project, can } = await loadProject(ctx, id);
  if (!canShareProject(ctx, can("project.manage"))) throw new HttpError(403, SHARE_DENIED);
  const m = await db.projectMember.findUnique({ where: { projectId_userId: { projectId: id, userId } }, include: { user: true } });
  if (!m) throw new HttpError(404, "Member not found");
  if (parseRoles(m.roles).includes("OWNER") && !b.roles.includes("OWNER") && !(await ownersLeft(id, userId))) throw new HttpError(409, "A project needs at least one owner");
  assertGrantable(ctx, project, m.user, parseRoles(m.roles), b.roles);
  await db.projectMember.update({ where: { id: m.id }, data: { roles: joinRoles(b.roles) } });
  await audit({ workspaceId: project.workspaceId, projectId: id, actorId: ctx.user.id, type: "project.member", data: { user: m.user.email, roles: joinRoles(b.roles), action: "update" } });
  return { ok: true };
});

export const DELETE = route<{ id: string; userId: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id, userId } = await params;
  const { project, can } = await loadProject(ctx, id);
  if (!canShareProject(ctx, can("project.manage"))) throw new HttpError(403, SHARE_DENIED);
  const m = await db.projectMember.findUnique({ where: { projectId_userId: { projectId: id, userId } }, include: { user: true } });
  if (!m) throw new HttpError(404, "Member not found");
  if (parseRoles(m.roles).includes("OWNER") && !(await ownersLeft(id, userId))) throw new HttpError(409, "A project needs at least one owner");
  await db.projectMember.delete({ where: { id: m.id } });
  await audit({ workspaceId: project.workspaceId, projectId: id, actorId: ctx.user.id, type: "project.member", data: { user: m.user.email, action: "remove" } });
  return { ok: true };
});
