import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db, J } from "@/lib/db";
import { audit } from "@/lib/audit";
import { APPROVED_REV_KEY, assertMember, loadElement, publishToOrg } from "@/lib/library/access";

export const runtime = "nodejs";

async function current(id: string) {
  const el = await db.libraryElement.findUniqueOrThrow({ where: { id }, include: { shares: true } });
  const users = await db.user.findMany({ where: { id: { in: el.shares.map((s) => s.userId) } }, select: { id: true, name: true, email: true } });
  return {
    visibility: el.visibility,
    status: el.status,
    shares: el.shares
      .map((s) => {
        const u = users.find((x) => x.id === s.userId);
        return { userId: s.userId, name: u?.name ?? "Unknown user", email: u?.email ?? "", canEdit: s.canEdit };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const { id } = await params;
  const a = await loadElement(ctx, id);
  if (!a.full) throw new HttpError(403, "Only the owner and collaborators can see sharing");
  return { ...(await current(id)), canManage: a.canManage };
});

const Put = z.object({
  visibility: z.enum(["PRIVATE", "SHARED", "ORG"]).optional(),
  shares: z.array(z.object({ userId: z.string().optional(), email: z.string().email().optional(), canEdit: z.boolean().default(false) })).max(500).optional(),
});

export const PUT = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const { id } = await params;
  const a = await loadElement(ctx, id);
  if (!a.canManage) throw new HttpError(403, "Only the owner or an administrator can change sharing");
  const b = await body(req, Put);
  const el = a.el;
  const errors: string[] = [];

  if (b.shares) {
    // resolve users (by id or email) within the workspace
    const wanted = new Map<string, boolean>();
    for (const s of b.shares) {
      let uid = s.userId;
      if (!uid && s.email) {
        const u = await db.user.findUnique({ where: { email: s.email.toLowerCase() } });
        if (!u) {
          errors.push(`${s.email} has not signed in to Volt yet`);
          continue;
        }
        uid = u.id;
      }
      if (!uid || uid === el.ownerId) continue;
      const mem = await db.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ctx.workspace.id, userId: uid } } });
      if (!mem) {
        errors.push(`${s.email ?? uid} is not a member of this workspace`);
        continue;
      }
      wanted.set(uid, s.canEdit);
    }
    await db.$transaction([
      db.libraryShare.deleteMany({ where: { elementId: id, userId: { notIn: [...wanted.keys()] } } }),
      ...[...wanted].map(([userId, canEdit]) => db.libraryShare.upsert({ where: { elementId_userId: { elementId: id, userId } }, update: { canEdit }, create: { elementId: id, userId, canEdit } })),
    ]);
  }

  let status = el.status;
  if (b.visibility && b.visibility !== el.visibility) {
    if (b.visibility === "ORG") status = await publishToOrg(ctx, el);
    else {
      // leaving the organization: back to a personal draft
      const meta = J.parse<Record<string, unknown>>(el.meta, {});
      delete meta[APPROVED_REV_KEY];
      status = el.status === "DEPRECATED" ? "DEPRECATED" : "DRAFT";
      await db.libraryElement.update({ where: { id }, data: { visibility: b.visibility, status, approvedAt: null, approvedById: null, meta: JSON.stringify(meta) } });
    }
  } else if (!b.visibility && b.shares && b.shares.length && el.visibility === "PRIVATE") {
    await db.libraryElement.update({ where: { id }, data: { visibility: "SHARED" } });
  }
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "library.share", data: { id, name: el.name, visibility: b.visibility ?? el.visibility, shares: b.shares?.length ?? null, status } });
  return { ...(await current(id)), errors };
});
