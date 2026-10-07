import { route } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { db } from "@/lib/db";
import { isOutsider } from "@/lib/access";

export const runtime = "nodejs";

/** Entra groups known to the workspace (group mappings). */
export const GET = route(async (req) => {
  const ctx = await apiCtx();
  if (isOutsider(ctx)) return { groups: [] };
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  const rows = await db.groupMapping.findMany({
    where: { workspaceId: ctx.workspace.id, ...(q ? { OR: [{ displayName: { contains: q } }, { entraGroupId: { contains: q } }] } : {}) },
    orderBy: { displayName: "asc" },
    take: 20,
  });
  return { groups: rows.map((g) => ({ id: g.entraGroupId, name: g.displayName, roles: g.roles })) };
});
