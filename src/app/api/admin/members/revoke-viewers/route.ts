import { route } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertAdmin } from "@/lib/access";
import { parseRoles } from "@/lib/roles";

export const runtime = "nodejs";

/** Members whose only workspace role is Viewer and that no Entra group mapping controls. */
async function viewerOnly(workspaceId: string) {
  const rows = await db.membership.findMany({ where: { workspaceId, source: { not: "GROUP" } }, include: { user: { select: { email: true } } } });
  return rows.filter((m) => {
    const r = parseRoles(m.roles);
    return r.length === 1 && r[0] === "VIEWER";
  });
}

export const GET = route(async () => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  return { count: (await viewerOnly(ctx.workspace.id)).length };
});

/**
 * Take away workspace-wide Viewer access from everyone who has only that (e.g. people who were
 * added automatically at sign-in). They can still sign in and keep the projects they were added to.
 */
export const POST = route(async () => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const rows = await viewerOnly(ctx.workspace.id);
  if (rows.length) await db.membership.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { roles: "", source: "MANUAL" } });
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "admin.member", data: { action: "revoke-viewers", count: rows.length, users: rows.map((r) => r.user.email).slice(0, 200) } });
  return { ok: true, count: rows.length };
});
