import { route } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { db } from "@/lib/db";
import { assertMember } from "@/lib/library/access";

export const runtime = "nodejs";

/** Workspace member lookup for the share dialog (fallback when /api/users is unavailable). */
export const GET = route(async (req) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  const mems = await db.membership.findMany({
    where: { workspaceId: ctx.workspace.id, user: { disabled: false, ...(q ? { OR: [{ name: { contains: q } }, { email: { contains: q } }] } : {}) } },
    include: { user: { select: { id: true, name: true, email: true } } },
    take: 20,
  });
  return { users: mems.map((m) => m.user) };
});
