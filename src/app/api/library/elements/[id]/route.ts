import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db, J } from "@/lib/db";
import { audit } from "@/lib/audit";
import { APPROVED_REV_KEY, REJECT_KEY, assertMember, loadElement, publicMeta } from "@/lib/library/access";
import { Patch, updateElement } from "@/lib/library/update";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const { id } = await params;
  const a = await loadElement(ctx, id);
  const el = a.el;
  const revParam = new URL(req.url).searchParams.get("rev");
  let content = el.content;
  let revision = el.revision;
  let meta = el.meta;
  const want = revParam ? Number(revParam) : a.viewerRevision;
  if (!Number.isInteger(want) || want < 1) throw new HttpError(400, "Invalid revision");
  if (want !== el.revision) {
    if (!a.full && want > a.viewerRevision) throw new HttpError(404, "Revision not available");
    const r = await db.libraryElementRevision.findUnique({ where: { elementId_revision: { elementId: id, revision: want } } });
    if (!r) throw new HttpError(404, "Revision not found");
    content = r.content;
    revision = r.revision;
    meta = r.meta || el.meta;
  }
  const users = await db.user.findMany({ where: { id: { in: [el.ownerId, el.approvedById ?? ""].filter(Boolean) } }, select: { id: true, name: true } });
  const uname = (u: string | null) => users.find((x) => x.id === u)?.name;
  const rawMeta = J.parse<Record<string, unknown>>(el.meta, {});
  const pinned = revision !== el.revision && !a.full;
  return {
    id: el.id,
    kind: el.kind,
    name: el.name,
    category: el.category,
    prefix: el.prefix,
    revision,
    latestRevision: a.full ? el.revision : a.viewerRevision,
    status: pinned ? "APPROVED" : el.status,
    visibility: el.visibility,
    content,
    meta: publicMeta(meta),
    description: el.description,
    tags: J.parse<string[]>(el.tags, []),
    uuid: el.uuid,
    license: el.license,
    attribution: el.attribution,
    source: el.source,
    ownerId: el.ownerId,
    ownerName: uname(el.ownerId),
    approvedByName: uname(el.approvedById),
    approvedAt: el.approvedAt,
    approvedRevision: Number(rawMeta[APPROVED_REV_KEY]) || null,
    rejectReason: a.full ? ((rawMeta[REJECT_KEY] as string | undefined) ?? null) : null,
    library: { id: el.library.id, name: el.library.name, scope: el.library.scope, license: el.library.license, attribution: el.library.attribution, source: el.library.source },
    createdAt: el.createdAt,
    updatedAt: el.updatedAt,
    access: { full: a.full, canEdit: a.canEdit, canManage: a.canManage, canApprove: a.canApprove, canDeprecate: a.canDeprecate, isOwner: a.isOwner },
  };
});

async function patch(req: Request, id: string) {
  const ctx = await apiCtx();
  assertMember(ctx);
  const a = await loadElement(ctx, id);
  const b = await body(req, Patch);
  return updateElement(ctx, a, b);
}

export const PATCH = route<{ id: string }>(async (req, { params }) => patch(req, (await params).id));
export const PUT = route<{ id: string }>(async (req, { params }) => patch(req, (await params).id));

export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const { id } = await params;
  const a = await loadElement(ctx, id);
  if (!a.canManage) throw new HttpError(403, "Only the owner or an administrator can delete this element");
  await db.libraryElement.delete({ where: { id } });
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "library.delete", data: { id, name: a.el.name, kind: a.el.kind, revision: a.el.revision } });
  return { ok: true };
});
