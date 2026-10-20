import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { loadVersion } from "@/lib/versioning";
import { audit } from "@/lib/audit";
import { commentDto } from "@/lib/comments";
import { OPEN_FOR_COMMENTS, setCommentStatus } from "@/lib/comment-actions";

export const runtime = "nodejs";


async function load(ctx: Awaited<ReturnType<typeof apiCtx>>, id: string) {
  const c = await db.comment.findUnique({ where: { id }, include: { author: { select: { id: true, name: true, isBot: true } } } });
  if (!c || !c.versionId) throw new HttpError(404, "Comment not found");
  const a = await loadVersion(ctx, c.versionId, { withDoc: false });
  return { c, a };
}

const Patch = z.union([
  z.object({ status: z.enum(["OPEN", "RESOLVED", "REJECTED", "REOPENED"]) }),
  z.object({ body: z.string().trim().min(1).max(10_000) }),
]);

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Patch);
  const { c, a } = await load(ctx, id);
  if ("body" in b) {
    if (c.authorId !== ctx.user.id || c.externalAuthor) throw new HttpError(403, c.externalAuthor ? "Imported comments are a record of what their author wrote and cannot be edited" : "Only the author can edit a comment");
    if (!OPEN_FOR_COMMENTS.includes(a.version.status)) throw new HttpError(409, "Comments on a closed version are part of the record and cannot be edited");
    const u = await db.comment.update({ where: { id }, data: { body: b.body }, include: { author: { select: { id: true, name: true, isBot: true } } } });
    return { comment: commentDto(u) };
  }
  return { comment: await setCommentStatus(ctx, id, b.status) };
});

export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const { c, a } = await load(ctx, id);
  if ((c.authorId !== ctx.user.id || c.externalAuthor) && !a.can("project.manage")) throw new HttpError(403, "Only the author or a project owner can delete a comment");
  if (!["DRAFT", "CHANGES_REQUESTED", "IMPORTED"].includes(a.version.status)) throw new HttpError(409, "This version is frozen — its comments are part of the record and cannot be deleted");
  await db.$transaction([db.comment.deleteMany({ where: { parentId: id } }), db.comment.delete({ where: { id } })]);
  await audit({ workspaceId: a.project.workspaceId, projectId: a.project.id, versionId: a.version.id, actorId: ctx.user.id, type: "comment.status", data: { commentId: id, to: "DELETED" } });
  return { ok: true };
});
