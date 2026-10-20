import { rateLimit } from "@/lib/ratelimit";
import { route } from "@/lib/api";
import { apiCtx, HttpError, loadProject } from "@/lib/session";
import { audit } from "@/lib/audit";
import { fileResponse, isGuestCtx } from "@/lib/access";
import { sha256 } from "@/lib/versioning";
import { exportOptions, exportVolt } from "@/lib/voltfile/export";
import { VOLT_MIME } from "@/lib/voltfile/format";

export const runtime = "nodejs";

/**
 * The whole project as a sealed .volt file: every version and variant, the drawings, commit
 * history, comments, review rounds, signature records and attachments. ?reviews=0, ?history=0 and
 * ?files=0 leave parts out.
 */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  rateLimit(`volt.export:${ctx.user.id}`, 20);
  const { id } = await params;
  const { project, can } = await loadProject(ctx, id);
  if (!can("project.view")) throw new HttpError(403, "No access to this project");
  const canExport = isGuestCtx(ctx) ? ctx.settings.exports.guestCanExport : can("project.export") && (can("project.edit") || ctx.settings.exports.viewerCanExport);
  if (!canExport) throw new HttpError(403, "Export is not permitted for your role");
  const options = exportOptions(new URL(req.url));
  const out = await exportVolt(ctx, { projectId: project.id, options, canManage: can("project.manage") });
  await audit({
    workspaceId: project.workspaceId,
    projectId: project.id,
    actorId: ctx.user.id,
    type: "project.export",
    data: { format: "volt", scope: "project", ...options, versions: out.manifest.counts.versions, comments: out.manifest.counts.comments, size: out.bytes.byteLength, sha256: sha256(out.bytes) },
  });
  return fileResponse(out.bytes, { filename: out.filename, type: VOLT_MIME });
});
