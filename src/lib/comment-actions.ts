/**
 * Creating comments and changing a thread's status: shared by the REST routes and the MCP server,
 * so the same permission, notification and audit rules apply to both.
 */
import "server-only";
import { db } from "./db";
import { HttpError, type Ctx } from "./session";
import { loadVersion } from "./versioning";
import { audit } from "./audit";
import { notify } from "./notify";
import { commentDto, guestMayComment } from "./comments";
import { editorLink, evaluateReview } from "./workflow";

/** versions whose comment threads can still change (IMPORTED: a review copy from a .volt file) */
export const OPEN_FOR_COMMENTS = ["DRAFT", "CHANGES_REQUESTED", "IN_REVIEW", "IMPORTED"];

export type NewComment = {
  body: string;
  pageId?: string | null;
  anchor?: { type: "element" | "wire" | "text" | "region" | "point"; id?: string; x: number; y: number; w?: number; h?: number } | null;
  parentId?: string | null;
  mentions?: string[];
};

/** `via`: added to the audit entry (e.g. "mcp: <token name>") */
export async function addComment(ctx: Ctx, versionId: string, b: NewComment, opts: { via?: string } = {}) {
  const a = await loadVersion(ctx, versionId, { withDoc: false });
  if (!a.canComment) throw new HttpError(403, "You cannot comment on this project");
  if (!(await guestMayComment(ctx, versionId))) throw new HttpError(403, "Guests can comment only on versions shared with them for review");
  let pageId = b.pageId ?? null;
  let anchor = b.anchor ?? null;
  if (b.parentId) {
    const parent = await db.comment.findUnique({ where: { id: b.parentId } });
    if (!parent || parent.versionId !== versionId) throw new HttpError(400, "Parent comment not found in this version");
    if (parent.parentId) throw new HttpError(400, "Replies can only be added to a thread's first comment");
    pageId = parent.pageId;
    anchor = null;
  }
  // mentions: only users who can access the project
  let mentions: string[] = [];
  if (b.mentions?.length) {
    const ids = [...new Set(b.mentions)].filter((m) => m !== ctx.user.id);
    const ok = await db.user.findMany({ where: { id: { in: ids }, disabled: false, projectMembers: { some: { projectId: a.project.id } } }, select: { id: true } });
    mentions = ok.map((u) => u.id);
  }
  const c = await db.comment.create({
    data: { projectId: a.project.id, versionId, pageId, anchor: anchor ? JSON.stringify(anchor) : null, parentId: b.parentId ?? null, body: b.body, mentions: JSON.stringify(mentions), authorId: ctx.user.id },
    include: { author: { select: { id: true, name: true, isBot: true } } },
  });
  // a reply on a resolved thread reopens nothing automatically; status is explicit
  await audit({ workspaceId: a.project.workspaceId, projectId: a.project.id, versionId, actorId: ctx.user.id, type: "comment.create", data: { commentId: c.id, reply: !!b.parentId, label: a.version.label, ...(opts.via ? { via: opts.via } : {}) } });
  const link = editorLink(a.project.id, versionId, `?${pageId ? `page=${encodeURIComponent(pageId)}&` : ""}comment=${b.parentId ?? c.id}`);
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
  return commentDto(c);
}

/** Resolve, reject (won't fix), reopen a thread. */
export async function setCommentStatus(ctx: Ctx, commentId: string, status: "OPEN" | "RESOLVED" | "REJECTED" | "REOPENED", opts: { via?: string } = {}) {
  const c = await db.comment.findUnique({ where: { id: commentId }, include: { author: { select: { id: true, name: true, isBot: true } } } });
  if (!c || !c.versionId) throw new HttpError(404, "Comment not found");
  const a = await loadVersion(ctx, c.versionId, { withDoc: false });
  const root = c.parentId ? await db.comment.findUnique({ where: { id: c.parentId } }) : c;
  if (!root) throw new HttpError(404, "Thread not found");
  // commenters in the thread, the version author and project owners/managers may change status
  const participants = await db.comment.findMany({ where: { OR: [{ id: root.id }, { parentId: root.id }] }, select: { authorId: true } });
  // closing a thread (which can complete a review) is for its author, the version author or owners;
  // anyone in the thread may reopen it
  const closing = status === "RESOLVED" || status === "REJECTED";
  // findings of the AI reviewer are resolved by the people who work on the drawing
  const botRoot = root.authorId === c.authorId ? !!c.author.isBot : !!(await db.user.findUnique({ where: { id: root.authorId }, select: { isBot: true } }))?.isBot;
  const allowed = (botRoot && a.can("project.edit")) || root.authorId === ctx.user.id || a.version.createdById === ctx.user.id || a.can("project.manage") || (!closing && participants.some((p) => p.authorId === ctx.user.id));
  if (!allowed) throw new HttpError(403, closing ? "Only the comment's author, the version author or project owners can resolve it" : "Only people in this thread can reopen it");
  if (!OPEN_FOR_COMMENTS.includes(a.version.status)) throw new HttpError(409, "This version is closed — its comments are part of the record");
  const u = await db.comment.update({ where: { id: root.id }, data: { status }, include: { author: { select: { id: true, name: true, isBot: true } } } });
  await audit({ workspaceId: a.project.workspaceId, projectId: a.project.id, versionId: a.version.id, actorId: ctx.user.id, type: "comment.status", data: { commentId: root.id, from: root.status, to: status, ...(opts.via ? { via: opts.via } : {}) } });
  // resolving the last open comment may complete a pending review
  if (a.version.status === "IN_REVIEW" && closing) {
    const r = await db.review.findFirst({ where: { versionId: a.version.id, status: "OPEN" }, orderBy: { createdAt: "desc" } });
    if (r) await evaluateReview(r.id, ctx.user.id);
  }
  return commentDto(u);
}
