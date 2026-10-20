import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { db } from "@/lib/db";
import { loadVersion } from "@/lib/versioning";
import { Anchor, commentDto } from "@/lib/comments";
import { addComment } from "@/lib/comment-actions";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  await loadVersion(ctx, id, { withDoc: false });
  const rows = await db.comment.findMany({ where: { versionId: id }, include: { author: { select: { id: true, name: true, isBot: true } } }, orderBy: { createdAt: "asc" } });
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
  return { comment: await addComment(ctx, id, b) };
});
