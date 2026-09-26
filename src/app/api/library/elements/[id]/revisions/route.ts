import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { assertMember, loadElement } from "@/lib/library/access";
import { updateElement } from "@/lib/library/update";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const { id } = await params;
  const a = await loadElement(ctx, id);
  const revs = await db.libraryElementRevision.findMany({
    where: { elementId: id, ...(a.full ? {} : { revision: { lte: a.viewerRevision } }) },
    orderBy: { revision: "desc" },
    select: { id: true, revision: true, note: true, userId: true, createdAt: true },
  });
  const users = await db.user.findMany({ where: { id: { in: [...new Set(revs.map((r) => r.userId))] } }, select: { id: true, name: true } });
  const n = new Map(users.map((u) => [u.id, u.name]));
  return { revisions: revs.map((r) => ({ revision: r.revision, note: r.note, userName: n.get(r.userId) ?? "Unknown", createdAt: r.createdAt })) };
});

/** Restore: copies an old revision's content into a new revision. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const { id } = await params;
  const a = await loadElement(ctx, id);
  const b = await body(req, z.object({ restore: z.number().int().min(1) }));
  const r = await db.libraryElementRevision.findUnique({ where: { elementId_revision: { elementId: id, revision: b.restore } } });
  if (!r) throw new HttpError(404, "Revision not found");
  if (r.content === a.el.content) throw new HttpError(409, "That revision is identical to the current one");
  return updateElement(ctx, a, { content: r.content, note: `Restored revision ${b.restore}` });
});
