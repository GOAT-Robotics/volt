import { rateLimit } from "@/lib/ratelimit";
import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { loadVersion } from "@/lib/versioning";
import { audit } from "@/lib/audit";
import { baseUrl, fileResponse, reqMeta } from "@/lib/access";
import { buildReleasePdf } from "@/lib/signing/release";
import { releaseCopy } from "@/lib/signing/release-signed";

export const runtime = "nodejs";

const OK = ["APPROVED", "SIGNED", "RELEASED", "SUPERSEDED"];

/**
 * Release PDF: canonical drawing + approval & signature record. A released version gives a new
 * tracked copy on every download — stamped on every page with the copy code and who downloaded it,
 * digitally signed, recorded (lib/signing/release-signed). Approved or signed versions of the earlier
 * process get an unsigned preview.
 */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  rateLimit(`pdf:${ctx.user.id}`, 30);
  const { id } = await params;
  const a = await loadVersion(ctx, id, { withDoc: false });
  if (!a.canExport) throw new HttpError(403, "Export is not permitted for your role");
  if (!OK.includes(a.version.status)) throw new HttpError(409, "A release PDF is available only for approved, signed, released or superseded versions");
  if (a.version.releasedAt) {
    // the copy is recorded and audited (release.download) by releaseCopy
    const c = await releaseCopy(ctx, id, reqMeta(req));
    return fileResponse(c.bytes, { filename: c.filename, type: "application/pdf", inline: new URL(req.url).searchParams.has("inline") });
  }
  const { bytes, filename } = await buildReleasePdf(id, baseUrl(req));
  await audit({ workspaceId: a.project.workspaceId, projectId: a.project.id, versionId: id, actorId: ctx.user.id, type: "project.export", data: { format: "release.pdf", label: a.version.label } });
  return fileResponse(bytes, { filename, type: "application/pdf", inline: new URL(req.url).searchParams.has("inline") });
});
