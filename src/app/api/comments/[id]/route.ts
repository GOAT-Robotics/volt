import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { loadVersion } from "@/lib/versioning";
import { audit } from "@/lib/audit";
import { commentDto } from "@/lib/comments";
import { evaluateReview } from "@/lib/workflow";

export const runtime = "nodejs";

async function load(ctx: Awaited<ReturnType<typeof apiCtx>>, id: string) {
  const c = await db.comment.findUnique({ where: { id }, include: { author: { select: { id: true, name: true } } } });
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
    if (c.authorId !== ctx.user.id) throw new HttpError(403, "Only the author can edit a comment");
    if (!["DRAFT", "CHANGES_REQUESTED", "IN_REVIEW"].includes(a.version.status)) throw new HttpError(409, "Comments on a closed version are part of the record and cannot be edited");
    const u = await db.comment.update({ where: { id }, data: { body: b.body }, include: { author: { select: { id: true, name: true } } } });
    return { comment: commentDto(u) };
  }
  const root = c.parentId ? await db.comment.findUnique({ where: { id: c.parentId } }) : c;
  if (!root) throw new HttpError(404, "Thread not found");
  // commenters in the thread, the version author and project owners/managers may change status
  const participants = await db.comment.findMany({ where: { OR: [{ id: root.id }, { parentId: root.id }] }, select: { authorId: true } });
  const allowed = participants.some((p) => p.authorId === ctx.user.id) || a.version.createdById === ctx.user.id || a.can("project.manage");
  if (!allowed) throw new HttpError(403, "Only commenters, the version author or project owners can change a comment's status");
  if (["SUPERSEDED", "WITHDRAWN"].includes(a.version.status)) throw new HttpError(409, "This version is closed");
  const u = await db.comment.update({ where: { id: root.id }, data: { status: b.status }, include: { author: { select: { id: true, name: true } } } });
  await audit({ workspaceId: a.project.workspaceId, projectId: a.project.id, versionId: a.version.id, actorId: ctx.user.id, type: "comment.status", data: { commentId: root.id, from: root.status, to: b.status } });
  // resolving the last open comment may complete a pending review
  if (a.version.status === "IN_REVIEW" && (b.status === "RESOLVED" || b.status === "REJECTED")) {
    const r = await db.review.findFirst({ where: { versionId: a.version.id, status: "OPEN" }, orderBy: { createdAt: "desc" } });
    if (r) await evaluateReview(r.id, ctx.user.id);
  }
  return { comment: commentDto(u) };
});

export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const { c, a } = await load(ctx, id);
  if (c.authorId !== ctx.user.id && !a.can("project.manage")) throw new HttpError(403, "Only the author or a project owner can delete a comment");
  if (!["DRAFT", "CHANGES_REQUESTED"].includes(a.version.status)) throw new HttpError(409, "This version is frozen — its comments are part of the record and cannot be deleted");
  await db.$transaction([db.comment.deleteMany({ where: { parentId: id } }), db.comment.delete({ where: { id } })]);
  await audit({ workspaceId: a.project.workspaceId, projectId: a.project.id, versionId: a.version.id, actorId: ctx.user.id, type: "comment.status", data: { commentId: id, to: "DELETED" } });
  return { ok: true };
});
