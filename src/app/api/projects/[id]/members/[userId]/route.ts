import { route } from "@/lib/api";
import { apiCtx, HttpError, loadProject } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { canShareProject, SHARE_DENIED } from "@/lib/access";

export const runtime = "nodejs";

export const DELETE = route<{ id: string; userId: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id, userId } = await params;
  const { project, can } = await loadProject(ctx, id);
  if (!canShareProject(ctx, can("project.manage"))) throw new HttpError(403, SHARE_DENIED);
  const m = await db.projectMember.findUnique({ where: { projectId_userId: { projectId: id, userId } }, include: { user: true } });
  if (!m) throw new HttpError(404, "Member not found");
  const [pendingReviews, pendingSignatures] = await Promise.all([
    db.reviewAssignment.count({ where: { userId, decision: "PENDING", review: { status: "OPEN", version: { projectId: id } } } }),
    db.signature.count({ where: { signatoryId: userId, status: "REQUESTED", version: { projectId: id } } }),
  ]);
  if (pendingReviews || pendingSignatures) throw new HttpError(409, "This member has a pending review or signature request; complete or cancel it before removing them");
  await db.projectMember.delete({ where: { id: m.id } });
  await audit({ workspaceId: project.workspaceId, projectId: id, actorId: ctx.user.id, type: "project.member", data: { user: m.user.email, action: "remove" } });
  return { ok: true };
});
