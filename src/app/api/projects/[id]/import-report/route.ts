import { route } from "@/lib/api";
import { apiCtx, HttpError, loadProject } from "@/lib/session";
import { db, J } from "@/lib/db";
import type { CompatReport } from "@/core/model";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const { can } = await loadProject(ctx, id);
  if (!can("project.view") && !can("review.comment")) throw new HttpError(403, "No access");
  const rec = await db.importRecord.findFirst({ where: { projectId: id }, omit: { original: true }, orderBy: { createdAt: "desc" } });
  if (!rec) throw new HttpError(404, "This project was not imported");
  return { report: J.parse<CompatReport | null>(rec.report, null), importId: rec.id, filename: rec.filename, sha256: rec.sha256, createdAt: rec.createdAt.toISOString() };
});
