import { route } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { db } from "@/lib/db";
import { projectScope } from "@/lib/access";
import { livePeople } from "@/lib/live/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who is working in which projects right now: ?projects=a,b,c (only projects the caller can see). */
export const GET = route(async (req) => {
  const ctx = await apiCtx();
  const ids = (new URL(req.url).searchParams.get("projects") ?? "").split(",").filter(Boolean).slice(0, 500);
  if (!ids.length || !ctx.settings.collaboration.live || !ctx.settings.collaboration.presence) return { projects: {} };
  const visible = await db.project.findMany({ where: { AND: [projectScope(ctx), { id: { in: ids } }] }, select: { id: true } });
  const all = livePeople(visible.map((p) => p.id));
  return { projects: all };
});
