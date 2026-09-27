import { route } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { db } from "@/lib/db";
import { approvedStyles } from "@/lib/styletemplates";

export const runtime = "nodejs";

/** Style templates a project can use (approved, or with an approved version; not retired). */
export const GET = route(async () => {
  const ctx = await apiCtx();
  const rows = await db.styleTemplate.findMany({ where: { workspaceId: ctx.workspace.id, status: { not: "RETIRED" } }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
  return {
    templates: rows
      .map((t) => ({ t, ok: approvedStyles(t) }))
      .filter((x) => x.ok)
      .map(({ t, ok }) => ({ id: t.id, name: t.name, version: ok!.version, isDefault: t.isDefault })),
  };
});
