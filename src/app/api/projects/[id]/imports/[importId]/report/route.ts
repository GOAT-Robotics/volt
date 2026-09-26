import { route } from "@/lib/api";
import { apiCtx, HttpError, loadProject } from "@/lib/session";
import { db } from "@/lib/db";
import { fileResponse } from "@/lib/access";

export const runtime = "nodejs";

/** Compatibility report as a downloadable JSON file. */
export const GET = route<{ id: string; importId: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id, importId } = await params;
  const { can } = await loadProject(ctx, id);
  if (!can("project.view") && !can("review.comment")) throw new HttpError(403, "No access");
  const rec = await db.importRecord.findUnique({ where: { id: importId }, omit: { original: true } });
  if (!rec || rec.projectId !== id) throw new HttpError(404, "Import not found");
  const payload = { file: rec.filename, sha256: rec.sha256, importedAt: rec.createdAt.toISOString(), report: JSON.parse(rec.report) };
  return fileResponse(Buffer.from(JSON.stringify(payload, null, 2)), { filename: rec.filename.replace(/\.qet$/i, "") + "-compatibility.json", type: "application/json" });
});
