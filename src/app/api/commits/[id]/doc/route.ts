import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { loadVersion } from "@/lib/versioning";
import { gunzipSync } from "node:zlib";

export const runtime = "nodejs";

/** the drawing as committed (immutable) */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const c = await db.commit.findUnique({ where: { id }, select: { versionId: true, seq: true, data: true } });
  if (!c) throw new HttpError(404, "Commit not found");
  const a = await loadVersion(ctx, c.versionId, { withDoc: false });
  const doc = gunzipSync(c.data).toString("utf8");
  return new Response(`{"seq":${c.seq},"label":${JSON.stringify(`#${c.seq} (v${a.version.label})`)},"doc":${doc}}`, { headers: { "content-type": "application/json", "cache-control": "private, max-age=31536000, immutable" } });
});
