import { route } from "@/lib/api";
import { apiCtx, HttpError, loadProject } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { fileResponse } from "@/lib/access";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const a = await db.attachment.findUnique({ where: { id } });
  if (!a) throw new HttpError(404, "Attachment not found");
  const { can } = await loadProject(ctx, a.projectId);
  if (!can("project.view") && !can("review.comment")) throw new HttpError(404, "Attachment not found");
  if (!can("project.view") && a.ownerType !== "COMMENT" && a.ownerType !== "REVIEW") throw new HttpError(404, "Attachment not found");
  return fileResponse(a.data, { filename: a.filename, type: a.mime === "image/svg+xml" ? "application/octet-stream" : a.mime });
});

export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const a = await db.attachment.findUnique({ where: { id }, omit: { data: true } });
  if (!a) throw new HttpError(404, "Attachment not found");
  const { project, can } = await loadProject(ctx, a.projectId);
  if (a.userId !== ctx.user.id && !can("project.manage")) throw new HttpError(403, "Only the uploader or a project owner can delete this file");
  if (a.ownerType === "RELEASE" || a.ownerType === "REVIEW" || a.ownerType === "COMMENT") {
    const v =
      a.ownerType === "RELEASE"
        ? await db.version.findUnique({ where: { id: a.ownerId }, select: { status: true } })
        : a.ownerType === "REVIEW"
          ? (await db.review.findUnique({ where: { id: a.ownerId }, include: { version: { select: { status: true } } } }))?.version
          : (await db.comment.findUnique({ where: { id: a.ownerId }, include: { version: { select: { status: true } } } }))?.version;
    if (v && !["DRAFT", "CHANGES_REQUESTED"].includes(v.status)) throw new HttpError(409, "Files attached to a submitted or released version are part of the record");
  }
  await db.attachment.delete({ where: { id } });
  await audit({ workspaceId: project.workspaceId, projectId: project.id, actorId: ctx.user.id, type: "project.update", data: { attachmentDeleted: a.filename, sha256: a.sha256 } });
  return { ok: true };
});
