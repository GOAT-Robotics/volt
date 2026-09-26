import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export const GET = route(async () => {
  const ctx = await apiCtx();
  const [items, unread] = await Promise.all([
    db.notification.findMany({ where: { userId: ctx.user.id }, orderBy: { createdAt: "desc" }, take: 50 }),
    db.notification.count({ where: { userId: ctx.user.id, readAt: null } }),
  ]);
  return {
    items: items.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, readAt: n.readAt?.toISOString() ?? null, createdAt: n.createdAt.toISOString() })),
    unread,
  };
});

const Body = z.object({ ids: z.array(z.string()).max(500).optional(), all: z.boolean().optional() });

export const POST = route(async (req) => {
  const ctx = await apiCtx();
  const b = await body(req, Body);
  const now = new Date();
  if (b.all) await db.notification.updateMany({ where: { userId: ctx.user.id, readAt: null }, data: { readAt: now } });
  else if (b.ids?.length) await db.notification.updateMany({ where: { userId: ctx.user.id, id: { in: b.ids }, readAt: null }, data: { readAt: now } });
  return { ok: true };
});
