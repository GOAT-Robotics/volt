import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { loadVersion } from "@/lib/versioning";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/** Original project file kept for lossless export (fetched by the editor only when exporting). */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const a = await loadVersion(ctx, id, { withDoc: false });
  if (!a.canExport) throw new HttpError(403, "Export is not permitted for your role");
  const r = await db.$queryRaw<{ s: string | null }[]>`SELECT json_extract(doc, '$.qet.source') AS s FROM "Version" WHERE id = ${id}`;
  const src = r[0]?.s;
  if (!src) throw new HttpError(404, "No original project file");
  // never rendered by the browser: served as a download with a locked-down CSP
  return new Response(src, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="source.qet"',
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=300",
    },
  });
});
