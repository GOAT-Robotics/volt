import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { loadVersion } from "@/lib/versioning";
import { audit } from "@/lib/audit";
import { baseUrl, fileResponse } from "@/lib/access";
import { buildReleasePdf } from "@/lib/signing/release";

export const runtime = "nodejs";

const OK = ["APPROVED", "SIGNED", "RELEASED", "SUPERSEDED"];

/** Signed release PDF: canonical drawing + approval & signature record. */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const a = await loadVersion(ctx, id, { withDoc: false });
  if (!a.canExport) throw new HttpError(403, "Export is not permitted for your role");
  if (!OK.includes(a.version.status)) throw new HttpError(409, "A release PDF is available only for approved, signed, released or superseded versions");
  const { bytes, filename } = await buildReleasePdf(id, baseUrl(req));
  await audit({ workspaceId: a.project.workspaceId, projectId: a.project.id, versionId: id, actorId: ctx.user.id, type: "project.export", data: { format: "release.pdf", label: a.version.label } });
  return fileResponse(bytes, { filename, type: "application/pdf", inline: new URL(req.url).searchParams.has("inline") });
});
