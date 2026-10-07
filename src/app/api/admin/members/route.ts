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
  const rows = await db.membership.findMany({ where: { workspaceId: ctx.workspace.id, user: { external: false } }, include: { user: true }, orderBy: { user: { name: "asc" } } });
  return { members: rows.map((m) => ({ userId: m.userId, name: m.user.name, email: m.user.email, roles: parseRoles(m.roles), source: m.source, disabled: m.user.disabled, isGuest: m.user.isGuest, lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null })) };
});

const Body = z.object({ email: z.string().trim().toLowerCase().email(), name: z.string().trim().max(120).optional(), roles: z.array(z.enum(ROLES)).min(1) });

/** Add a member by email (pre-creates the user record so they can sign in). */
export const POST = route(async (req) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const b = await body(req, Body);
  let user = await db.user.findUnique({ where: { email: b.email } });
  if (user?.external) throw new HttpError(409, `${b.email} is an external user — manage them under External users`);
  if (!user) user = await db.user.create({ data: { email: b.email, name: b.name || b.email.split("@")[0] } });
  const existing = await db.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ctx.workspace.id, userId: user.id } } });
  if (existing) throw new HttpError(409, `${user.email} is already a member — edit their roles instead`);
  await db.membership.create({ data: { workspaceId: ctx.workspace.id, userId: user.id, roles: joinRoles(b.roles), source: "MANUAL" } });
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "admin.member", data: { action: "add", user: user.email, roles: joinRoles(b.roles) } });
  return { ok: true, userId: user.id };
});
