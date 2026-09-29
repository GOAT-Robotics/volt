import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertAdmin } from "@/lib/access";
import { ROLES, joinRoles, parseRoles } from "@/lib/roles";

export const runtime = "nodejs";

const Patch = z.object({ roles: z.array(z.enum(ROLES)).optional(), disabled: z.boolean().optional() });

async function adminsLeft(workspaceId: string, exceptUserId: string) {
  const rows = await db.membership.findMany({ where: { workspaceId, userId: { not: exceptUserId }, user: { disabled: false } } });
  return rows.filter((r) => parseRoles(r.roles).includes("ADMIN")).length;
}

export const PATCH = route<{ userId: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const { userId } = await params;
  const b = await body(req, Patch);
  const m = await db.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ctx.workspace.id, userId } }, include: { user: true } });
  if (!m) throw new HttpError(404, "Member not found");
  const wasAdmin = parseRoles(m.roles).includes("ADMIN");
  if (b.roles) {
    if (wasAdmin && !b.roles.includes("ADMIN") && !(await adminsLeft(ctx.workspace.id, userId))) throw new HttpError(409, "The workspace needs at least one active administrator");
    // manual edit makes the membership MANUAL so the next sign-in does not overwrite it
    await db.membership.update({ where: { id: m.id }, data: { roles: joinRoles(b.roles), source: "MANUAL" } });
    await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "admin.member", data: { action: b.roles.length ? "roles" : "revoke", user: m.user.email, from: m.roles, to: joinRoles(b.roles) } });
  }
  if (b.disabled !== undefined && b.disabled !== m.user.disabled) {
    if (userId === ctx.user.id) throw new HttpError(409, "You cannot disable your own account");
    if (b.disabled && wasAdmin && !(await adminsLeft(ctx.workspace.id, userId))) throw new HttpError(409, "The workspace needs at least one active administrator");
    // disabling is account-wide: only when this workspace is the only one the user belongs to
    if (b.disabled && (await db.membership.count({ where: { userId, workspaceId: { not: ctx.workspace.id } } })))
      throw new HttpError(409, "This user also belongs to other workspaces — remove their roles here instead of disabling the account");
    // disabling keeps the user and all history; sign-in and API access are refused
    await db.user.update({ where: { id: userId }, data: { disabled: b.disabled } });
    await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "admin.member", data: { action: b.disabled ? "disable" : "enable", user: m.user.email } });
  }
  return { ok: true };
});
