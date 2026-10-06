import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { loadVersion } from "@/lib/versioning";
import { recallVersion } from "@/lib/release";

export const runtime = "nodejs";

const Body = z.object({ reason: z.string().trim().min(1, "A reason is required").max(2000) });

/**
 * Take a version back to draft from review or approval (never once signed).
 * In review: its author / submitter or project owners. Approved: project owners and approvers.
 */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Body);
  const a = await loadVersion(ctx, id, { withDoc: false });
  const manage = a.can("project.manage");
  if (a.version.status === "APPROVED") {
    if (!manage && !a.can("review.approve")) throw new HttpError(403, "Only project owners and approvers can take back an approval");
  } else if (!manage) {
    const submitter = await db.review.findFirst({ where: { versionId: id, status: "OPEN", submittedById: ctx.user.id } });
    if (!a.can("project.edit") || (a.version.createdById !== ctx.user.id && !submitter)) throw new HttpError(403, "Only the author, the submitter or project owners can recall a version from review");
  }
  return { ok: true, ...(await recallVersion(ctx, id, b.reason)) };
});
