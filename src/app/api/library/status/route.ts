import { route } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { db } from "@/lib/db";
import { accessFor } from "@/lib/library/access";

export const runtime = "nodejs";

/** GET ?ids=a,b → { items: Record<id, { revision, status } | null> } (null = missing or not visible) */
export const GET = route(async (req) => {
  const ctx = await apiCtx();
  const ids = [...new Set((new URL(req.url).searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 1000);
  const rows = ids.length ? await db.libraryElement.findMany({ where: { id: { in: ids } }, include: { library: true, shares: { select: { userId: true, canEdit: true } } }, omit: { content: true } }) : [];
  const items: Record<string, { revision: number; status: string } | null> = {};
  for (const id of ids) items[id] = null;
  for (const r of rows) {
    const a = accessFor(ctx, { ...r, content: "" });
    if (!a.canView) continue;
    const pinned = a.viewerRevision !== r.revision;
    items[r.id] = { revision: a.viewerRevision, status: pinned ? "APPROVED" : r.status };
  }
  return { items };
});
