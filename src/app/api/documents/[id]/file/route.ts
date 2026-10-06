import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { fileResponse } from "@/lib/access";
import { docAccess } from "@/lib/documents";

export const runtime = "nodejs";

/** the stored file (PDFs and images open in the browser), or a redirect to the link */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const d = await db.partDocument.findUnique({ where: { id } });
  if (!d) throw new HttpError(404, "Document not found");
  await docAccess(ctx, d);
  if (!d.data) {
    if (d.url) return Response.redirect(d.url, 302);
    throw new HttpError(404, "Document has no file");
  }
  const inline = d.mime === "application/pdf" || (!!d.mime?.startsWith("image/") && d.mime !== "image/svg+xml");
  return fileResponse(d.data, { filename: d.filename ?? "document", type: d.mime === "image/svg+xml" ? "application/octet-stream" : d.mime ?? "application/octet-stream", inline, cache: "private, max-age=3600" });
});
