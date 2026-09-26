import { route } from "@/lib/api";
import { apiCtx, HttpError, loadProject } from "@/lib/session";
import { db } from "@/lib/db";
import { fileResponse } from "@/lib/access";

export const runtime = "nodejs";

/** The preserved original .qet bytes exactly as uploaded. */
export const GET = route<{ id: string; importId: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id, importId } = await params;
  const { can } = await loadProject(ctx, id);
  if (!can("project.view")) throw new HttpError(403, "No access");
  const rec = await db.importRecord.findUnique({ where: { id: importId } });
  if (!rec || rec.projectId !== id) throw new HttpError(404, "Import not found");
  return fileResponse(rec.original, { filename: rec.filename, type: "application/xml" });
});
