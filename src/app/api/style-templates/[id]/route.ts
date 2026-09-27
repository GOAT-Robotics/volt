import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { approvedStyles } from "@/lib/styletemplates";

export const runtime = "nodejs";

/** Approved styles of one template (what a project adopts as its base). */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const t = await db.styleTemplate.findFirst({ where: { id, workspaceId: ctx.workspace.id, status: { not: "RETIRED" } } });
  const ok = t && approvedStyles(t);
  if (!t || !ok) throw new HttpError(404, "Style template not found or not approved");
  return { id: t.id, name: t.name, version: ok.version, styles: ok.styles };
});
