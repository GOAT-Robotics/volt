import "server-only";
import { z } from "zod";
import { db, J } from "./db";
import type { Ctx } from "./session";
import { isGuestCtx } from "./access";

export const Anchor = z.object({
  type: z.enum(["element", "wire", "text", "region", "point"]),
  id: z.string().max(200).optional(),
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().optional(),
  h: z.number().finite().optional(),
});

type Row = Awaited<ReturnType<typeof db.comment.findFirstOrThrow>> & { author: { id: string; name: string; isBot?: boolean } };

export function commentDto(c: Row) {
  return {
    id: c.id,
    pageId: c.pageId,
    anchor: J.parse<z.infer<typeof Anchor> | null>(c.anchor, null),
    parentId: c.parentId,
    body: c.body,
    status: c.status,
    author: { id: c.author.id, name: c.author.name, bot: !!c.author.isBot },
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/** Guests may only comment on versions shared with them: they are assigned (directly or via group) to a review of it. */
export async function guestMayComment(ctx: Ctx, versionId: string): Promise<boolean> {
  if (!isGuestCtx(ctx)) return true;
  const n = await db.reviewAssignment.count({
    where: { review: { versionId }, OR: [{ userId: ctx.user.id }, ...(ctx.user.groups.length ? [{ groupId: { in: ctx.user.groups } }] : [])] },
  });
  return n > 0;
}
