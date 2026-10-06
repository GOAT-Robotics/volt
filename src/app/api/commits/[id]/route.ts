import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db, J } from "@/lib/db";
import { loadVersion } from "@/lib/versioning";

export const runtime = "nodejs";

/** one commit with the list of its changes */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const c = await db.commit.findUnique({ where: { id }, omit: { data: true } });
  if (!c) throw new HttpError(404, "Commit not found");
  await loadVersion(ctx, c.versionId, { withDoc: false });
  const author = await db.user.findUnique({ where: { id: c.authorId }, select: { name: true } });
  return { id: c.id, seq: c.seq, kind: c.kind, message: c.message, versionId: c.versionId, parentId: c.parentId, author: author?.name ?? "", createdAt: c.createdAt.toISOString(), docHash: c.docHash, stats: J.parse(c.stats, {}) };
});
