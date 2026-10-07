import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertAdmin } from "@/lib/access";
import { loadCustomRoles } from "@/lib/customroles";
import { cleanActions } from "@/lib/external";
import { customRoleToken } from "@/lib/roles";

export const runtime = "nodejs";

const Body = z.object({ name: z.string().trim().min(1).max(60).optional(), description: z.string().trim().max(300).optional(), actions: z.array(z.string()).max(30).optional() });

async function own(workspaceId: string, id: string) {
  const r = await db.customRole.findFirst({ where: { id, workspaceId } });
  if (!r) throw new HttpError(404, "Role not found");
  return r;
}

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const { id } = await params;
  const r = await own(ctx.workspace.id, id);
  const b = await body(req, Body);
  const actions = b.actions ? cleanActions(b.actions) : undefined;
  if (actions && !actions.includes("project.view")) throw new HttpError(400, "A role must at least open its assigned projects");
  if (b.name && b.name !== r.name && (await db.customRole.findFirst({ where: { workspaceId: ctx.workspace.id, name: b.name } }))) throw new HttpError(409, `A role named “${b.name}” already exists`);
  const u = await db.customRole.update({ where: { id }, data: { name: b.name, description: b.description, actions: actions?.join(",") } });
  await loadCustomRoles(true);
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "admin.role", data: { action: "update", role: u.name, actions: u.actions } });
  return { ok: true };
});

export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const { id } = await params;
  const r = await own(ctx.workspace.id, id);
  const used = await db.membership.count({ where: { workspaceId: ctx.workspace.id, roles: { contains: customRoleToken(id) } } });
  if (used) throw new HttpError(409, `${used} external user${used === 1 ? " has" : "s have"} this role — give them another role first`);
  await db.customRole.delete({ where: { id } });
  await loadCustomRoles(true);
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "admin.role", data: { action: "delete", role: r.name } });
  return { ok: true };
});
