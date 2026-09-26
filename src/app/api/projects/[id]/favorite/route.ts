import { route } from "@/lib/api";
import { apiCtx, HttpError, loadProject } from "@/lib/session";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/** Toggle favorite; returns the new state. */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const { can } = await loadProject(ctx, id);
  if (!can("project.view") && !can("review.comment")) throw new HttpError(403, "No access");
  const key = { userId_projectId: { userId: ctx.user.id, projectId: id } };
  const has = await db.favorite.findUnique({ where: key });
  if (has) await db.favorite.delete({ where: key });
  else await db.favorite.create({ data: { userId: ctx.user.id, projectId: id } });
  return { favorite: !has };
});
