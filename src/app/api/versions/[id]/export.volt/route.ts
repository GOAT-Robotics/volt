import { rateLimit } from "@/lib/ratelimit";
import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { audit } from "@/lib/audit";
import { fileResponse } from "@/lib/access";
import { loadVersion, sha256 } from "@/lib/versioning";
import { exportOptions, exportVolt } from "@/lib/voltfile/export";
import { VOLT_MIME } from "@/lib/voltfile/format";

export const runtime = "nodejs";

/**
 * One version as a sealed .volt file — its drawing, comments, review rounds, signature records and
 * attachments — to send for review. The reviewed copy comes back through Import → "Merge reviews
 * back". ?reviews=0 and ?files=0 leave parts out.
 */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  rateLimit(`volt.export:${ctx.user.id}`, 20);
  const { id } = await params;
  const a = await loadVersion(ctx, id, { withDoc: false });
  if (!a.canExport) throw new HttpError(403, "Export is not permitted for your role");
  const options = exportOptions(new URL(req.url));
  const out = await exportVolt(ctx, { projectId: a.project.id, versionId: id, options, canManage: a.can("project.manage") });
  await audit({
    workspaceId: a.project.workspaceId,
    projectId: a.project.id,
    versionId: id,
    actorId: ctx.user.id,
    type: "project.export",
    data: { format: "volt", scope: "version", label: a.version.label, reviews: options.reviews, files: options.files, comments: out.manifest.counts.comments, size: out.bytes.byteLength, sha256: sha256(out.bytes) },
  });
  return fileResponse(out.bytes, { filename: out.filename, type: VOLT_MIME });
});
