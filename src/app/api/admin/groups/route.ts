import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertAdmin } from "@/lib/access";
import { ROLES, joinRoles, parseRoles } from "@/lib/roles";

export const runtime = "nodejs";

export const GET = route(async () => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const rows = await db.groupMapping.findMany({ where: { workspaceId: ctx.workspace.id }, orderBy: { displayName: "asc" } });
  return { groups: rows.map((g) => ({ id: g.id, entraGroupId: g.entraGroupId, displayName: g.displayName, roles: parseRoles(g.roles) })) };
});

const GroupBody = z.object({
  entraGroupId: z.string().trim().regex(/^[0-9a-fA-F-]{8,64}$/, "Enter the group's object id (GUID)"),
  displayName: z.string().trim().min(1).max(200),
  roles: z.array(z.enum(ROLES)).min(1),
});

export const POST = route(async (req) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const b = await body(req, GroupBody);
  const gid = b.entraGroupId.toLowerCase();
  if (await db.groupMapping.findUnique({ where: { workspaceId_entraGroupId: { workspaceId: ctx.workspace.id, entraGroupId: gid } } })) throw new HttpError(409, "This group is already mapped");
  const g = await db.groupMapping.create({ data: { workspaceId: ctx.workspace.id, entraGroupId: gid, displayName: b.displayName, roles: joinRoles(b.roles) } });
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "admin.group", data: { action: "add", group: b.displayName, entraGroupId: gid, roles: joinRoles(b.roles) } });
  return { id: g.id };
});
