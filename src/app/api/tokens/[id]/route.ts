import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isAdmin } from "@/lib/access";

export const runtime = "nodejs";

/** revoke a token (its owner, or a workspace admin) */
export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const t = await db.apiToken.findUnique({ where: { id } });
  if (!t || t.workspaceId !== ctx.workspace.id || (t.userId !== ctx.user.id && !isAdmin(ctx))) throw new HttpError(404, "Token not found");
  if (!t.revokedAt) await db.apiToken.update({ where: { id }, data: { revokedAt: new Date() } });
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "token.revoke", data: { name: t.name, prefix: t.prefix, owner: t.userId === ctx.user.id ? undefined : t.userId } });
  return { ok: true };
});
