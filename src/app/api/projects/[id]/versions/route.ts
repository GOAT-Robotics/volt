import { route, body } from "@/lib/api";
import { apiCtx, HttpError, loadProject } from "@/lib/session";
import { db } from "@/lib/db";
import { applyProjectExpiry } from "@/lib/workflow";
import { startVersion, StartVersionBody } from "@/lib/versions";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const { can } = await loadProject(ctx, id);
  if (!can("project.view") && !can("review.comment")) throw new HttpError(403, "No access");
  await applyProjectExpiry(id);
  const fresh = await db.version.findMany({ where: { projectId: id }, omit: { doc: true }, orderBy: { seq: "desc" } });
  const users = new Map((await db.user.findMany({ where: { id: { in: [...new Set(fresh.map((r) => r.createdById))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const labels = new Map(fresh.map((r) => [r.id, r.label]));
  return {
    versions: fresh.map((r) => ({
      id: r.id,
      label: r.label,
      status: r.status,
      variantId: r.variantId,
      summary: r.summary,
      description: r.description,
      ticket: r.ticket,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      createdBy: users.get(r.createdById) ?? "",
      parentLabel: r.parentId ? labels.get(r.parentId) ?? null : null,
      releasedAt: r.releasedAt?.toISOString() ?? null,
    })),
  };
});

/** Start a new version from an existing one (lib/versions.ts). */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, StartVersionBody);
  return startVersion(ctx, id, b);
});
