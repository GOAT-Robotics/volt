import { rateLimit } from "@/lib/ratelimit";
import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { loadVersion } from "@/lib/versioning";
import { audit } from "@/lib/audit";
import { baseUrl, fileResponse } from "@/lib/access";
import { buildReleasePdf } from "@/lib/signing/release";
import { signedReleasePdf } from "@/lib/signing/release-signed";

export const runtime = "nodejs";

const OK = ["APPROVED", "SIGNED", "RELEASED", "SUPERSEDED"];

/**
 * Release PDF: canonical drawing + approval & signature record. Released versions get the stored,
 * digitally signed file (made at release); approved or signed versions of the earlier process a preview.
 */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  rateLimit(`pdf:${ctx.user.id}`, 30);
  const { id } = await params;
  const a = await loadVersion(ctx, id, { withDoc: false });
  if (!a.canExport) throw new HttpError(403, "Export is not permitted for your role");
  if (!OK.includes(a.version.status)) throw new HttpError(409, "A release PDF is available only for approved, signed, released or superseded versions");
  const signed = !!a.version.releasedAt;
  const { bytes, filename } = signed ? await signedReleasePdf(id) : await buildReleasePdf(id, baseUrl(req));
  await audit({ workspaceId: a.project.workspaceId, projectId: a.project.id, versionId: id, actorId: ctx.user.id, type: "project.export", data: { format: signed ? "release.pdf (signed)" : "release.pdf", label: a.version.label } });
  return fileResponse(bytes, { filename, type: "application/pdf", inline: new URL(req.url).searchParams.has("inline") });
});
