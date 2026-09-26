import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertAdmin } from "@/lib/access";
import { ROLES, joinRoles } from "@/lib/roles";

export const runtime = "nodejs";

async function load(workspaceId: string, id: string) {
  const g = await db.groupMapping.findFirst({ where: { id, workspaceId } });
  if (!g) throw new HttpError(404, "Group mapping not found");
  return g;
}

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const { id } = await params;
  const b = await body(req, z.object({ displayName: z.string().trim().min(1).max(200).optional(), roles: z.array(z.enum(ROLES)).min(1).optional() }));
  const g = await load(ctx.workspace.id, id);
  await db.groupMapping.update({ where: { id }, data: { ...(b.displayName && { displayName: b.displayName }), ...(b.roles && { roles: joinRoles(b.roles) }) } });
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "admin.group", data: { action: "update", group: g.displayName, from: g.roles, to: b.roles ? joinRoles(b.roles) : undefined } });
  return { ok: true };
});

export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const { id } = await params;
  const g = await load(ctx.workspace.id, id);
  await db.groupMapping.delete({ where: { id } });
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "admin.group", data: { action: "remove", group: g.displayName, entraGroupId: g.entraGroupId } });
  return { ok: true };
});
