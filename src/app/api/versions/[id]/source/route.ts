import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { loadVersion, parseDoc } from "@/lib/versioning";

export const runtime = "nodejs";

/** Original project file kept for lossless export (fetched by the editor only when exporting). */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const a = await loadVersion(ctx, id);
  if (!a.canExport) throw new HttpError(403, "Export is not permitted for your role");
  const src = parseDoc(a.version.doc).qet?.source;
  if (!src) throw new HttpError(404, "No original project file");
  return new Response(src, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "private, max-age=300" } });
});
