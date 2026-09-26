import { route } from "@/lib/api";
import { apiCtx, HttpError, loadProject } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { readUpload, MAX_ATTACHMENT } from "@/lib/uploads";
import { guestMayComment } from "@/lib/comments";
import { isGuestCtx } from "@/lib/access";

export const runtime = "nodejs";

const OWNER_TYPES = ["COMMENT", "REVIEW", "PROJECT", "RELEASE"] as const;

export const GET = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const { can } = await loadProject(ctx, id);
  if (!can("project.view") && !can("review.comment")) throw new HttpError(403, "No access");
  const url = new URL(req.url);
  const ownerType = url.searchParams.get("ownerType");
  const ownerId = url.searchParams.get("ownerId");
  const rows = await db.attachment.findMany({
    where: { projectId: id, ...(ownerType ? { ownerType } : {}), ...(ownerId ? { ownerId } : {}) },
    omit: { data: true },
    orderBy: { createdAt: "desc" },
  });
  const users = new Map((await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return { attachments: rows.map((r) => ({ id: r.id, ownerType: r.ownerType, ownerId: r.ownerId, filename: r.filename, mime: r.mime, size: r.size, sha256: r.sha256, uploadedBy: users.get(r.userId) ?? "", createdAt: r.createdAt.toISOString() })) };
});

/** Resolve the owner and check that it belongs to the project. Returns the version id when relevant. */
async function checkOwner(projectId: string, ownerType: string, ownerId: string): Promise<string | null> {
  switch (ownerType) {
    case "PROJECT":
      if (ownerId !== projectId) throw new HttpError(400, "ownerId must be the project id");
      return null;
    case "REVIEW": {
      const r = await db.review.findUnique({ where: { id: ownerId }, include: { version: { select: { projectId: true, id: true } } } });
      if (!r || r.version.projectId !== projectId) throw new HttpError(404, "Review not found");
      return r.version.id;
    }
    case "COMMENT": {
      const c = await db.comment.findUnique({ where: { id: ownerId } });
      if (!c || c.projectId !== projectId) throw new HttpError(404, "Comment not found");
      return c.versionId;
    }
    case "RELEASE": {
      const v = await db.version.findUnique({ where: { id: ownerId }, select: { projectId: true, id: true } });
      if (!v || v.projectId !== projectId) throw new HttpError(404, "Version not found");
      return v.id;
    }
  }
  throw new HttpError(400, "Invalid ownerType");
}

export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const { project, can } = await loadProject(ctx, id);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_ATTACHMENT + 64 * 1024) throw new HttpError(413, "File exceeds the 25 MB limit");
  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    throw new HttpError(400, "Expected multipart form data");
  }
  const file = fd.get("file");
  const ownerType = String(fd.get("ownerType") ?? "PROJECT").toUpperCase();
  const ownerId = String(fd.get("ownerId") ?? id);
  if (!(OWNER_TYPES as readonly string[]).includes(ownerType)) throw new HttpError(400, "Invalid ownerType");
  if (!(file instanceof File)) throw new HttpError(400, "No file uploaded");
  const versionId = await checkOwner(id, ownerType, ownerId);
  // who may attach what
  if (ownerType === "COMMENT") {
    if (!can("review.comment")) throw new HttpError(403, "You cannot comment on this project");
    if (isGuestCtx(ctx) && (!versionId || !(await guestMayComment(ctx, versionId)))) throw new HttpError(403, "Not shared with you");
  } else if (ownerType === "REVIEW") {
    if (!can("project.edit") && !can("project.manage") && !can("review.decide")) throw new HttpError(403, "Not permitted");
  } else if (!can("project.edit") && !can("project.manage")) throw new HttpError(403, "Not permitted");
  const up = await readUpload(file);
  const row = await db.attachment.create({ data: { projectId: id, ownerType, ownerId, filename: up.filename, mime: up.mime, size: up.size, sha256: up.sha256, data: up.data, userId: ctx.user.id } });
  await audit({ workspaceId: project.workspaceId, projectId: id, versionId, actorId: ctx.user.id, type: "project.update", data: { attachment: up.filename, size: up.size, sha256: up.sha256, ownerType } });
  return { id: row.id, sha256: up.sha256, size: up.size };
});
