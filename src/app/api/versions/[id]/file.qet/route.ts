import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { loadVersion, parseDoc } from "@/lib/versioning";
import { audit } from "@/lib/audit";
import { fileResponse } from "@/lib/access";
import { exportQet } from "@/core/qet";

export const runtime = "nodejs";

/** QElectroTech project file of a released (or superseded) version. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const a = await loadVersion(ctx, id);
  if (!a.canExport) throw new HttpError(403, "Export is not permitted for your role");
  if (!["RELEASED", "SUPERSEDED"].includes(a.version.status)) throw new HttpError(409, "The .qet download is available for released versions (use the editor export for working versions)");
  const { xml } = exportQet(parseDoc(a.version.doc));
  await audit({ workspaceId: a.project.workspaceId, projectId: a.project.id, versionId: id, actorId: ctx.user.id, type: "project.export", data: { format: "qet", label: a.version.label } });
  const name = `${(a.project.number ? a.project.number + "_" : "") + a.project.name}`.replace(/[^\w.-]+/g, "_");
  return fileResponse(Buffer.from(xml, "utf8"), { filename: `${name}_v${a.version.label}.qet`, type: "application/xml" });
});
