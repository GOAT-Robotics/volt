import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { loadVersion } from "@/lib/versioning";
import { audit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { Anchor, commentDto, guestMayComment } from "@/lib/comments";
import { editorLink } from "@/lib/workflow";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  await loadVersion(ctx, id, { withDoc: false });
  const rows = await db.comment.findMany({ where: { versionId: id }, include: { author: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } });
  return { comments: rows.map(commentDto) };
});

const Body = z.object({
  body: z.string().trim().min(1, "Comment is empty").max(10_000),
  pageId: z.string().max(100).nullish(),
  anchor: Anchor.nullish(),
  parentId: z.string().max(40).nullish(),
  mentions: z.array(z.string().max(40)).max(50).optional(),
});

export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Body);
  const a = await loadVersion(ctx, id, { withDoc: false });
  if (!a.canComment) throw new HttpError(403, "You cannot comment on this project");
  if (!(await guestMayComment(ctx, id))) throw new HttpError(403, "Guests can comment only on versions shared with them for review");
  let pageId = b.pageId ?? null;
  let anchor = b.anchor ?? null;
  if (b.parentId) {
    const parent = await db.comment.findUnique({ where: { id: b.parentId } });
    if (!parent || parent.versionId !== id) throw new HttpError(400, "Parent comment not found in this version");
    if (parent.parentId) throw new HttpError(400, "Replies can only be added to a thread's first comment");
    pageId = parent.pageId;
    anchor = null;
  }
  // mentions: only users who can access the project
  let mentions: string[] = [];
  if (b.mentions?.length) {
    const ids = [...new Set(b.mentions)].filter((m) => m !== ctx.user.id);
    const ok = await db.user.findMany({
      where: {
        id: { in: ids },
        disabled: false,
        OR: [{ memberships: { some: { workspaceId: a.project.workspaceId } } }, { projectMembers: { some: { projectId: a.project.id } } }],
      },
      select: { id: true },
    });
    mentions = ok.map((u) => u.id);
  }
  const c = await db.comment.create({
    data: { projectId: a.project.id, versionId: id, pageId, anchor: anchor ? JSON.stringify(anchor) : null, parentId: b.parentId ?? null, body: b.body, mentions: JSON.stringify(mentions), authorId: ctx.user.id },
    include: { author: { select: { id: true, name: true } } },
  });
  // a reply on a resolved thread reopens nothing automatically; status is explicit
  await audit({ workspaceId: a.project.workspaceId, projectId: a.project.id, versionId: id, actorId: ctx.user.id, type: "comment.create", data: { commentId: c.id, reply: !!b.parentId, label: a.version.label } });
  const link = editorLink(a.project.id, id, `?${pageId ? `page=${encodeURIComponent(pageId)}&` : ""}comment=${b.parentId ?? c.id}`);
  const snippet = b.body.length > 160 ? b.body.slice(0, 157) + "…" : b.body;
  if (mentions.length) {
    await notify(mentions, { type: "comment.mention", title: `${ctx.user.name} mentioned you on ${a.project.name} v${a.version.label}`, body: snippet, link, workspaceId: a.project.workspaceId });
  }
  if (b.parentId) {
    // notify thread participants (excluding mentions already notified and self)
    const thread = await db.comment.findMany({ where: { OR: [{ id: b.parentId }, { parentId: b.parentId }] }, select: { authorId: true } });
    const others = [...new Set(thread.map((t) => t.authorId))].filter((u) => u !== ctx.user.id && !mentions.includes(u));
    await notify(others, { type: "comment.mention", title: `${ctx.user.name} replied on ${a.project.name} v${a.version.label}`, body: snippet, link, workspaceId: a.project.workspaceId });
  } else if (a.version.createdById !== ctx.user.id && !mentions.includes(a.version.createdById)) {
    await notify([a.version.createdById], { type: "comment.mention", title: `New comment on ${a.project.name} v${a.version.label}`, body: `${ctx.user.name}: ${snippet}`, link, workspaceId: a.project.workspaceId });
  }
  return { comment: commentDto(c) };
});
