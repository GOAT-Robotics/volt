import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { loadVersion, parseDoc } from "@/lib/versioning";
import { fileResponse } from "@/lib/access";
import { canonicalPdf } from "@/lib/signing/canonical";

export const runtime = "nodejs";

/** The deterministic drawing PDF whose SHA-256 is signed. Available once a version is frozen. */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const a = await loadVersion(ctx, id);
  const isSignatory = (await db.signature.count({ where: { versionId: id, signatoryId: ctx.user.id } })) > 0;
  if (!a.canExport && !isSignatory) throw new HttpError(403, "Export is not permitted for your role");
  if (["DRAFT", "CHANGES_REQUESTED"].includes(a.version.status)) throw new HttpError(409, "The canonical PDF exists only for frozen versions");
  const bytes = await canonicalPdf(parseDoc(a.version.doc), a.version.label);
  const name = `${a.project.name.replace(/[^\w.-]+/g, "_")}_v${a.version.label}.pdf`;
  return fileResponse(bytes, { filename: name, type: "application/pdf", inline: new URL(req.url).searchParams.has("inline") });
});
