import { route } from "@/lib/api";
import { apiCtx, HttpError, loadProject } from "@/lib/session";
import { db } from "@/lib/db";
import { verifySignature } from "@/lib/signing/service";

export const runtime = "nodejs";

/** Verification of a stored signature: seal, hashes and version immutability. Requires access to the project. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const s = await db.signature.findUnique({ where: { id }, select: { version: { select: { projectId: true } } } });
  if (!s) throw new HttpError(404, "Signature not found");
  const { can } = await loadProject(ctx, s.version.projectId);
  if (!can("project.view") && !can("review.comment")) throw new HttpError(404, "Signature not found");
  return verifySignature(id);
});
